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
  const headRef = refs.find(r => r.name === 'HEAD');
  const headSymref = headRef ? `HEAD:${headRef.sha}` : `HEAD:refs/heads/${repo.defaultBranch}`;
  
  if (wantsV2 && service === 'git-upload-pack') {
    // Protocol v2 advertisement
    const caps = new Map([
      ['fetch', ''],
      ['ls-refs', ''],
      ['server-option', ''],
      ['object-format', 'sha1'],
      ['agent', 'makefun-git-server/1.0'],
    ]);
    
    const body = formatRefsAdvertisementV2(caps);
    // Smart HTTP preamble: the service line, then a flush-pkt, then the v2 advertisement.
    const pktLines = encodePktLines(['# service=git-upload-pack\n', 'flush', body, 'flush']);
    
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'cache-control': 'no-cache',
    });
    res.end(pktLines);
  } else {
    // Protocol v0 advertisement
    let body = '';
    for (const ref of refs) {
      if (ref.sha === ZERO_OID) continue; // Skip unborn refs in v0
      const line = `${ref.sha} ${ref.name}\n`;
      const len = (line.length + 4).toString(16).padStart(4, '0');
      body += `${len}${line}`;
    }
    
    // Add capabilities to first ref (if any refs)
    const caps = service === 'git-upload-pack' 
      ? 'multi_ack_detailed thin-pack side-band-64k ofs-delta agent=makefun-git-server/1.0'
      : 'report-status side-band-64k delete-refs agent=makefun-git-server/1.0';
    
    // Prepend service header
    const serviceHeader = `# service=${service}\n`;
    const servicePkt = encodePktLine(serviceHeader);
    
    // Add capabilities to first ref line if we have refs
    if (refs.length > 0 && refs[0].sha !== ZERO_OID) {
      // Re-encode with capabilities
      body = '';
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        if (ref.sha === ZERO_OID) continue;
        const line = i === 0 ? `${ref.sha} ${ref.name}\0${caps}\n` : `${ref.sha} ${ref.name}\n`;
        const len = (line.length + 4).toString(16).padStart(4, '0');
        body += `${len}${line}`;
      }
    }
    
    body += '0000';
    
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
      const eqIdx = line.indexOf('=');
      if (eqIdx >= 0) {
        command = line.slice(0, eqIdx);
        const rest = line.slice(eqIdx + 1);
        if (rest) args.push(rest);
      } else {
        command = line;
      }
    } else {
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
  // Parse args: peel, symrefs, ref-prefix
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter(a => a.startsWith('ref-prefix ')).map(a => a.slice('ref-prefix '.length));
  
  let output = '';
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some(p => ref.name.startsWith(p))) continue;
    
    let line = `${ref.sha} ${ref.name}`;
    if (peel) {
      // For annotated tags, we'd add peeled info
      line += ' peeled:<sha>';
    }
    if (symrefs && ref.name === 'HEAD') {
      const repo = storage.getRepo(owner, repoName);
      if (repo) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    }
    line += '\n';
    output += encodePktLine(line).toString('binary');
  }
  
  const pktOutput = Buffer.from(output, 'binary');
  const response = Buffer.concat([pktOutput, pktLineFlush(), pktLineDelim()]);
  
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'cache-control': 'no-cache',
  });
  res.end(response);
}

async function handleFetchV2(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, refs: Ref[], packets: GitPacket[], body: Buffer): Promise<void> {
  // This is a simplified fetch implementation
  // In a full implementation, we would:
  // 1. Parse wants/haves
  // 2. Negotiate common objects
  // 3. Generate packfile
  // 4. Stream packfile with sideband
  
  // For now, return empty pack
  const response = Buffer.concat([
    encodePktLines(['acknowledgments\n', 'NAK\n', 'flush', 'packfile\n']),
    pktLineFlush(),
  ]);
  
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'cache-control': 'no-cache',
  });
  res.end(response);
}

async function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): Promise<void> {
  // Parse v0 request (want/have lines)
  const packets = decodePktLines(body, { allowTrailing: true });
  
  // For now, return minimal response
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'cache-control': 'no-cache',
  });
  res.end(pktLineFlush());
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