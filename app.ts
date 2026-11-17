// The HTTP server for the forge

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { storage } from './storage.ts';
import type { Repository, Ref } from './storage.ts';
import {
  sendJson,
  sendError,
  handleApiRoot,
  handleMeta,
  handleUserRepos,
  handleRepo,
  handleContents,
  handleLabels,
  handleIssues,
  handlePulls,
  handleGitRefs,
  handleBranches,
  handleCommits,
} from './rest.ts';
import {
  encodePktLine,
  encodePktLines,
  pktLineFlush,
  decodePktLines,
  parseAdvertisement,
  formatRefsAdvertisementV2,
  handleReceivePack,
  parsePushCommands,
  formatPushReport,
  ZERO_OID,
  collectReachable,
  readPack,
  writePack,
} from './git.ts';
import type { GitPacket, AdvertisedRef, PushCommand, PushReport, GitObject } from './git.ts';
import { parseTree, formatRefsAdvertisementV0 } from './git.ts';

// Seed the store on startup
storage.seedStore();

const JSON_TYPE = 'application/json; charset=utf-8';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function getAuthUser(req: IncomingMessage): { login: string } | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  // The token IS the login (MAKEFUN_SHOP_TOKEN = viewer's login)
  const user = storage.getUserByToken(token);
  if (!user) return null;
  return { login: user.login };
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // GitHub API root
    if (handleApiRoot(req, res)) return;
    if (handleMeta(req, res)) return;

    // All other API routes require authentication
    const user = getAuthUser(req);
    if (!user && path.startsWith('/api/')) {
      sendError(res, 401, 'Bad credentials');
      return;
    }

    // Attach user to request for handlers
    (req as any).user = user;

    if (handleUserRepos(req, res)) return;
    if (handleRepo(req, res)) return;
    if (handleContents(req, res)) return;
    if (handleLabels(req, res)) return;
    if (handleIssues(req, res)) return;
    if (handlePulls(req, res)) return;
    if (handleGitRefs(req, res)) return;
    if (handleBranches(req, res)) return;
    if (handleCommits(req, res)) return;

    // Git smart HTTP
    if (path.match(/^\/[^/]+\/[^/]+\.git\//)) {
      await handleGitSmartHttp(req, res, path);
      return;
    }

    // GraphQL endpoint (stub)
    if (method === 'POST' && path === '/api/graphql') {
      sendJson(res, 200, { data: {} });
      return;
    }

    // MCP endpoint (stub)
    if (method === 'POST' && path === '/mcp') {
      sendJson(res, 200, { jsonrpc: '2.0', id: 1, result: {} });
      return;
    }

    // Everything else: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' });
  });
}

// Git Smart HTTP handler
async function handleGitSmartHttp(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  // Parse /{owner}/{repo}.git/{service}
  const match = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
  if (!match) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  
  const [, owner, repoName, servicePath] = match;
  const repo = storage.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  
  const url = new URL(req.url ?? '', 'http://entry');
  const service = url.searchParams.get('service');
  
  if (servicePath === 'info/refs') {
    await handleInfoRefs(req, res, owner, repoName, service);
  } else if (servicePath === 'git-upload-pack') {
    await handleUploadPack(req, res, owner, repoName);
  } else if (servicePath === 'git-receive-pack') {
    await handleReceivePackHandler(req, res, owner, repoName);
  } else {
    sendJson(res, 404, { message: 'Not Found' });
  }
}

async function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string | null): Promise<void> {
  if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    sendJson(res, 400, { message: 'Invalid service parameter' });
    return;
  }
  
  const repo = storage.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  
  const protocol = req.headers['git-protocol'];
  const wantsV2 = protocol && protocol.includes('version=2');
  
  const refs = storage.getRefs(owner, repoName);
  const headSymref = `refs/heads/${repo.defaultBranch}`;
  
  if (wantsV2 && service === 'git-upload-pack') {
    // Protocol v2 advertisement
    const caps = new Map([
      ['fetch', ''],
      ['ls-refs', ''],
      ['server-option', ''],
      ['object-format', 'sha1'],
      ['agent', 'makefun-git-server/1.0'],
    ]);
    
    // The v2 advertisement is one pkt-line per line: version line, then each capability.
    const v2Lines = ['version 2\n'];
    for (const [key, value] of caps) v2Lines.push(`${key}${value ? '=' + value : ''}\n`);
    // Smart HTTP preamble: the service line, then a flush-pkt, then the v2 advertisement.
    const pktLines = encodePktLines(['# service=git-upload-pack\n', 'flush', ...v2Lines, 'flush']);
    
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'cache-control': 'no-cache',
    });
    res.end(pktLines);
  } else {
    // Protocol v0 advertisement via the shared formatter (capabilities ride the first ref line).
    const capsMap = new Map<string, string>();
    if (service === 'git-upload-pack') {
      capsMap.set('multi_ack_detailed', '');
      capsMap.set('multi_ack', '');
      capsMap.set('thin-pack', '');
      capsMap.set('side-band-64k', '');
      capsMap.set('ofs-delta', '');
      capsMap.set('shallow', '');
      capsMap.set('agent', 'makefun-git-server/1.0');
    } else {
      capsMap.set('report-status', '');
      capsMap.set('report-status-v2', '');
      capsMap.set('side-band-64k', '');
      capsMap.set('delete-refs', '');
      capsMap.set('atomic', '');
      capsMap.set('object-format', 'sha1');
      capsMap.set('agent', 'makefun-git-server/1.0');
    }
    const body = formatRefsAdvertisementV0(refs, service, capsMap, headSymref);
    const serviceHeader = `# service=${service}\n`;
    const servicePkt = encodePktLine(serviceHeader);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
    });
    // v0 smart HTTP preamble: service line, flush-pkt, then the ref advertisement.
    res.end(Buffer.concat([servicePkt, Buffer.from('0000', 'ascii'), Buffer.from(body, 'ascii')]));
  }
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const protocol = req.headers['git-protocol'];
  const isV2 = protocol && protocol.includes('version=2');
  
  // Read request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  
  if (isV2) {
    await handleUploadPackV2(req, res, owner, repoName, body);
  } else {
    await handleUploadPackV0(req, res, owner, repoName, body);
  }
}

async function handleUploadPackV2(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): Promise<void> {
  // Parse pkt-line request
  const packets = decodePktLines(body, { allowTrailing: true });
  
  // Parse command
  let command = '';
  let args: string[] = [];
  let inArgs = false;
  
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (!command) {
      // v2 command sections open with "command=<name>".
      if (line.startsWith('command=')) {
        command = line.slice('command='.length);
      }
    } else if (line !== '') {
      args.push(line);
    }
  }
  
  const refs = storage.getRefs(owner, repoName);
  
  if (command === 'ls-refs') {
    await handleLsRefs(res, owner, repoName, refs, args);
  } else if (command === 'fetch') {
    await handleFetchV2(req, res, owner, repoName, refs, packets, body);
  } else {
    sendJson(res, 400, { message: 'Unknown command' });
  }
}

async function handleLsRefs(res: ServerResponse, owner: string, repoName: string, refs: Ref[], args: string[]): Promise<void> {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));

  const lines: string[] = [];
  const repo = storage.getRepo(owner, repoName);
  const headBranch = repo?.defaultBranch ?? DEFAULT_BRANCH;
  const branchRefs = new Map(refs.map((r) => [r.name, r]));
  const mainRef = branchRefs.get(`refs/heads/${headBranch}`);

  // HEAD comes first, symref-target reported when requested.
  if (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p) || p === '')) {
    if (mainRef) {
      lines.push(symrefs ? `${mainRef.sha} HEAD symref-target:refs/heads/${headBranch}\n` : `${mainRef.sha} HEAD\n`);
    } else {
      lines.push(`unborn HEAD symref-target:refs/heads/${headBranch}\n`);
    }
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (peel) {
      const peeled = peeledObject(ref.sha);
      if (peeled && peeled !== ref.sha) line += ` peeled:${peeled}`;
    }
    if (symrefs) {
      // Symref targets only apply to symbolic refs; HEAD is handled above.
    }
    line += '\n';
    lines.push(line);
  }

  const pktOutput = encodePktLines(lines);
  const response = Buffer.concat([pktOutput, pktLineFlush()]);
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'cache-control': 'no-cache',
  });
  res.end(response);
}

/** Resolve a (possibly tag) object to the non-tag object it peels to. */
function peeledObject(sha: string): string | null {
  const seen = new Set<string>();
  let current = sha;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = storage.getObject(current);
    if (!obj || obj.type !== 'tag') return current;
    const sigMatch = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (!sigMatch) return current;
    current = sigMatch[1];
  }
}

async function handleFetchV2(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, refs: Ref[], packets: GitPacket[], body: Buffer): Promise<void> {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5));
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8));
    else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7), 10);
    else if (line === 'done') done = true;
  }

  // Objects reachable from the wants, minus what the client already has.
  const plan = computePackPlan(wants, haves, deepen, shallowIn);

  const out: Buffer[] = [];
  if (haves.length > 0 && !done) {
    // Negotiation round without done: answer with acknowledgments only.
    const ackLines: string[] = ['acknowledgments\n'];
    if (plan.common.length === 0) ackLines.push('NAK\n');
    for (const oid of plan.common) ackLines.push(`ACK ${oid}\n`);
    if (plan.common.length > 0) ackLines.push('ready\n');
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    res.end(Buffer.concat([encodePktLines(ackLines), pktLineFlush()]));
    return;
  }

  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const si: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) si.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) si.push(`unshallow ${oid}\n`);
    out.push(encodePktLines(si));
  }

  out.push(encodePktLines(['packfile\n']));
  if (plan.pack.length > 0) {
    // Packfile section: sideband-64k framing (band 1) per protocol v2.
    const CHUNK = 65519;
    for (let off = 0; off < plan.pack.length; off += CHUNK) {
      const piece = plan.pack.subarray(off, Math.min(off + CHUNK, plan.pack.length));
      out.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
    }
  }
  out.push(pktLineFlush());

  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  res.end(Buffer.concat(out));
}

interface PackPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/**
 * Collect every object reachable from the wanted tips (respecting an optional depth), exclude the
 * ones the client reported having, and serialize the remainder as a packfile.
 */
function computePackPlan(wants: string[], haves: string[], deepen: number | null, shallowIn: string[]): PackPlan {
  const haveSet = new Set(haves);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const commits = new Set<string>();
  const objects = new Map<string, GitObject>();

  const collectTree = (sha: string): void => {
    if (objects.has(sha)) return;
    const obj = storage.getObject(sha);
    if (!obj) return;
    objects.set(sha, obj);
    if (obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      collectTree(entry.sha);
    }
  };

  const addCommit = (sha: string, remaining: number): void => {
    if (commits.has(sha) || haveSet.has(sha)) return;
    const obj = storage.getObject(sha);
    if (!obj || obj.type !== 'commit') return;
    commits.add(sha);
    objects.set(sha, obj);
    const text = obj.data.toString('utf8');
    const treeMatch = /^tree ([0-9a-f]{40})/m.exec(text);
    if (treeMatch) collectTree(treeMatch[1]);
    const parentLines = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map((m) => m[1]);
    if (remaining <= 1) {
      // Shallow boundary: parents are not included (unless already known to the client).
      for (const parent of parentLines) {
        if (!haveSet.has(parent) && !commits.has(parent)) shallow.push(parent);
      }
      return;
    }
    for (const parent of parentLines) {
      addCommit(parent, remaining - 1);
    }
    if (shallowIn.includes(sha) && parentLines.every((p) => haveSet.has(p) || commits.has(p))) {
      unshallow.push(sha);
    }
  };

  const collectFrom = (sha: string, depth: number): void => {
    const obj = storage.getObject(sha);
    if (!obj) return;
    if (obj.type === 'commit') {
      addCommit(sha, deepen === null ? Infinity : Math.max(1, deepen));
    } else if (obj.type === 'tag') {
      objects.set(sha, obj);
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m) collectFrom(m[1], depth);
    } else {
      collectTree(sha);
    }
  };

  for (const want of wants) {
    if (haveSet.has(want)) continue;
    collectFrom(want, 0);
  }

  // Exclude objects the client already has (only meaningful for incremental fetches).
  for (const sha of [...objects.keys()]) {
    if (haveSet.has(sha)) objects.delete(sha);
  }

  const pack = objects.size > 0 ? writePack([...objects.values()].map((o) => ({ type: o.type, data: o.data }))) : Buffer.alloc(0);
  // Every `have` the client reports is by definition an object we also hold; report them as common.
  return { pack, shallow: [...new Set(shallow)], unshallow: [...new Set(unshallow)], common: haves.slice() };
}

async function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): Promise<void> {
  const packets = decodePktLines(body, { allowTrailing: true });
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let done = false;
  let sideband = false;
  let featuresDone = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const parts = rest.split(' ');
      const sha = parts[0];
      wants.push(sha);
      if (!featuresDone) {
        const features = parts.slice(1);
        sideband = features.includes('side-band-64k');
        featuresDone = true;
      }
    } else if (line.startsWith('deepen ')) {
      deepen = parseInt(line.slice(7), 10);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5));
    } else if (line === 'done') {
      done = true;
    }
  }

  const wantsInStore = wants.filter((w) => storage.getObject(w) !== null);
  const plan = computePackPlan(wantsInStore, done ? haves : [], deepen, []);

  const out: Buffer[] = [];
  if (haves.length > 0 && !done) {
    // Negotiation round: acknowledge common tips (client will send another round or done).
    const ackLines: string[] = [];
    for (const oid of plan.common) ackLines.push(`ACK ${oid} common\n`);
    out.push(encodePktLines(ackLines.length ? ackLines : ['NAK\n']));
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    res.end(Buffer.concat(out));
    return;
  }

  // Final round: NAK (or ACK for the last common) + shallow boundaries + pack.
  const head: string[] = [];
  if (plan.common.length > 0 && done) head.push(`ACK ${plan.common[plan.common.length - 1]}\n`);
  else head.push('NAK\n');
  for (const oid of plan.shallow) head.push(`shallow ${oid}\n`);
  out.push(encodePktLines(head));

  if (plan.pack.length > 0) {
    if (sideband) {
      const CHUNK = 65519;
      for (let off = 0; off < plan.pack.length; off += CHUNK) {
        const piece = plan.pack.subarray(off, Math.min(off + CHUNK, plan.pack.length));
        out.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
      }
    } else {
      // Without sideband the packfile rides in raw pkt-line chunks.
      const CHUNK = 65519;
      for (let off = 0; off < plan.pack.length; off += CHUNK) {
        out.push(encodePktLine(plan.pack.subarray(off, Math.min(off + CHUNK, plan.pack.length))));
      }
    }
  }
  out.push(pktLineFlush());

  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  res.end(Buffer.concat(out));
}

async function handleReceivePackHandler(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  // Read request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  // Parse pkt-line commands over the RAW bytes: after the flush that ends the command
  // list, the rest of the body is raw pack data (never pkt-line framed).
  let commands: PushCommand[] = [];
  let packData: Buffer | null = null;
  let capabilities = new Map<string, string>();
  {
    let offset = 0;
    const pktBuffers: Buffer[] = [];
    let sawFlush = false;
    while (offset + 4 <= body.length) {
      const hex = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-f]{4}$/.test(hex)) break;
      const len = parseInt(hex, 16);
      if (len === 0) {
        // flush-pkt: end of the command list
        offset += 4;
        sawFlush = true;
        break;
      }
      if (len < 4 || offset + len > body.length) break;
      pktBuffers.push(body.subarray(offset + 4, offset + len));
      offset += len;
    }
    const commandPackets = pktBuffers.map((raw) => ({ kind: 'data' as const, raw, data: raw, payload: raw }));
    commands = parsePushCommands(commandPackets as any);
    // Capabilities ride on the first command line, after a NUL byte
    if (pktBuffers.length > 0) {
      const first = pktBuffers[0].toString('utf8');
      const nul = first.indexOf('\0');
      if (nul >= 0) {
        for (const cap of first.slice(nul + 1).trim().split(' ')) {
          if (cap) capabilities.set(cap, '');
        }
      }
    }
    if (sawFlush && offset < body.length) {
      packData = body.subarray(offset);
    }
  }

  // Get objects client already has (from advertisement)
  const haveObjects = new Map<string, GitObject>();

  const result = await handleReceivePack(owner, repoName, commands, packData, haveObjects);

  // Format report; when the client asked for side-band-64k, wrap the report in
  // side-band channel 1 chunks so the suite can frame it.
  const reportBody = formatPushReport(result.report!);
  const reportPkt = encodePktLines([reportBody, 'flush']);
  let responseBody: Buffer;
  if (capabilities.get('side-band-64k') !== undefined) {
    const CHUNK = 65515;
    const parts: Buffer[] = [];
    for (let i = 0; i < reportPkt.length; i += CHUNK) {
      const slice = reportPkt.subarray(i, Math.min(i + CHUNK, reportPkt.length));
      const header = Buffer.from(((slice.length + 1).toString(16)).padStart(4, '0'), 'ascii');
      parts.push(header, Buffer.from([1]), slice);
    }
    parts.push(Buffer.from('0000', 'ascii'));
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = reportPkt;
  }

  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'cache-control': 'no-cache',
  });
  res.end(responseBody);
}