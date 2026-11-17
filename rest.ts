// REST v3 API handlers

import { IncomingMessage, ServerResponse } from 'node:http';
import { storage } from './storage.ts';
import type { User, Repository, Issue, Label, PullRequest } from './storage.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = generateRequestId();
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId, ...headers });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function generateRequestId(): string {
  // Generate a simple request ID
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        if (data === '') resolve({});
        else resolve(JSON.parse(data));
      } catch {
        reject(new Error('Malformed JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** The request origin, honoring the Host header (Link headers must stay on the entry's origin). */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host || 'localhost';
  return `http://${host}`;
}

function getPathParts(path: string): string[] {
  // Strip the query string (and any fragment): route parts are path segments only.
  const clean = path.split('?')[0].split('#')[0];
  return clean.split('/').filter((p) => p !== '');
}

export function getAuthUser(req: IncomingMessage): User | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  // The token IS the login (MAKEFUN_SHOP_TOKEN = viewer's login)
  return storage.getUserByToken(token);
}

function requireAuth(req: IncomingMessage, res: ServerResponse): User | null {
  const user = getAuthUser(req);
  if (!user) {
    sendError(res, 401, 'Bad credentials');
    return null;
  }
  return user;
}

export function handleApiRoot(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET' && (req.url === '/api/v3' || req.url === '/api/v3/')) {
    sendJson(res, 200, { 
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit'
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  return false;
}

export function handleMeta(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET' && req.url === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  return false;
}

export function handleUserRepos(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const url = new URL(req.url ?? '', originOf(req));
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const perPage = Math.min(parseInt(url.searchParams.get('per_page') || '30', 10), 100);
  
  if (req.method === 'GET' && req.url?.startsWith('/api/v3/user/repos')) {
    const { repos, hasNext } = storage.listUserRepos(user.login, page, perPage);
    const headers: Record<string, string> = {};
    if (hasNext) {
      const nextPage = page + 1;
      const nextUrl = `${url.origin}/api/v3/user/repos?page=${nextPage}&per_page=${perPage}`;
      headers['link'] = `<${nextUrl}>; rel="next"`;
    }
    sendJson(res, 200, repos.map(r => ({
      id: r.id,
      name: r.name,
      full_name: r.fullName,
      private: r.private,
      owner: { login: r.owner, id: 1000 },
      html_url: `https://github.com/${r.fullName}`,
      description: r.description,
      default_branch: r.defaultBranch,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      pushed_at: r.updatedAt,
    })), headers);
    return true;
  }
  
  if (req.method === 'POST' && req.url === '/api/v3/user/repos') {
    parseBody(req).then(body => {
      const { name, private: privateRepo = true, description = '' } = body as { name: string; private?: boolean; description?: string };
      if (!name) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      try {
        const repo = storage.createRepo(user.login, name, description, privateRepo);
        sendJson(res, 201, {
          id: repo.id,
          name: repo.name,
          full_name: repo.fullName,
          private: repo.private,
          owner: { login: repo.owner, id: 1000 },
          html_url: `https://github.com/${repo.fullName}`,
          description: repo.description,
          default_branch: repo.defaultBranch,
          created_at: repo.createdAt,
          updated_at: repo.updatedAt,
          pushed_at: repo.updatedAt,
        });
      } catch {
        sendError(res, 422, 'Repository already exists');
      }
    }).catch(() => sendError(res, 400, 'Malformed JSON'));
    return true;
  }
  
  return false;
}

function getRepo(req: IncomingMessage, res: ServerResponse, user: User): Repository | null {
  const parts = getPathParts(req.url || '');
  // /api/v3/repos/{owner}/{repo}
  if (parts.length >= 4 && parts[0] === 'api' && parts[1] === 'v3' && parts[2] === 'repos') {
    const owner = parts[3];
    const repoName = parts[4];
    const repo = storage.getRepo(owner, repoName);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    // Check ownership - repo must belong to the authenticated user
    if (repo.owner !== user.login) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    return repo;
  }
  return null;
}

export function handleRepo(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const parts = getPathParts(req.url || '');
  if (parts.length < 5 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos') return false;
  
  const owner = parts[3];
  const repoName = parts[4];
  const repo = storage.getRepo(owner, repoName);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  // Check ownership
  if (repo.owner !== user.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  const subPath = parts.slice(5).join('/');
  
  if (req.method === 'GET' && subPath === '') {
    // GET /repos/{owner}/{repo}
    sendJson(res, 200, {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      private: repo.private,
      owner: { login: repo.owner, id: 1000 },
      html_url: `https://github.com/${repo.fullName}`,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.updatedAt,
    });
    return true;
  }
  
  if (req.method === 'PATCH' && subPath === '') {
    // PATCH /repos/{owner}/{repo}
    parseBody(req).then(body => {
      const { description } = body as { description?: string };
      const updated = storage.updateRepo(owner, repoName, { description });
      if (updated) {
        sendJson(res, 200, {
          id: updated.id,
          name: updated.name,
          full_name: updated.fullName,
          private: updated.private,
          owner: { login: updated.owner, id: 1000 },
          html_url: `https://github.com/${updated.fullName}`,
          description: updated.description,
          default_branch: updated.defaultBranch,
          created_at: updated.createdAt,
          updated_at: updated.updatedAt,
          pushed_at: updated.updatedAt,
        });
      } else {
        sendError(res, 404, 'Not Found');
      }
    }).catch(() => sendError(res, 400, 'Malformed JSON'));
    return true;
  }
  
  if (req.method === 'DELETE' && subPath === '') {
    // DELETE /repos/{owner}/{repo}
    storage.deleteRepo(owner, repoName);
    res.writeHead(204, { 'x-github-request-id': generateRequestId() });
    res.end();
    return true;
  }
  
  return false;
}

export function handleContents(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const parts = getPathParts(req.url || '');
  // /api/v3/repos/{owner}/{repo}/contents/{path}
  if (parts.length < 7 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || parts[5] !== 'contents') return false;
  
  const owner = parts[3];
  const repoName = parts[4];
  const filePath = parts.slice(6).join('/');
  const repo = storage.getRepo(owner, repoName);
  if (!repo || repo.owner !== user.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  if (req.method === 'PUT') {
    // PUT /repos/{owner}/{repo}/contents/{path}
    parseBody(req).then(async body => {
      // branch and sha may arrive as query parameters (GitHub accepts both).
      const q = new URL(req.url ?? '', originOf(req)).searchParams;
      const { message, content } = body as { message: string; content: string };
      const branch = (body as any).branch ?? q.get('branch') ?? undefined;
      const sha = (body as any).sha ?? q.get('sha') ?? undefined;
      if (!message || !content) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      // Decode base64 content
      let decodedContent: string;
      try {
        decodedContent = Buffer.from(content, 'base64').toString('utf8');
      } catch {
        sendError(res, 422, 'Invalid base64 content');
        return;
      }
      
      try {
        const result = storage.putFileContent(repo.id, filePath, decodedContent, message, branch, sha);
        if (!result) {
          sendError(res, 404, 'Not Found');
          return;
        }
        
        const isUpdate = sha !== undefined;
        sendJson(res, isUpdate ? 200 : 201, {
          content: {
            sha: result.contentSha,
            encoding: 'base64',
            size: Buffer.byteLength(decodedContent, 'utf8'),
          },
          commit: {
            sha: result.commitSha,
          },
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'SHA_CONFLICT') {
          sendJson(res, 409, {
            message: 'sha does not match',
            documentation_url: 'https://docs.github.com/rest/repos/contents#create-or-update-file-contents',
          });
        } else {
          sendError(res, 500, 'Internal Server Error');
        }
      }
    }).catch(() => sendError(res, 400, 'Malformed JSON'));
    return true;
  }
  
  if (req.method === 'GET') {
    // GET /repos/{owner}/{repo}/contents/{path}
    const url = new URL(req.url ?? '', originOf(req));
    const ref = url.searchParams.get('ref') || repo.defaultBranch;
    
    // Try to get as file first
    const fileResult = storage.getFileContent(repo.id, filePath, ref);
    if (fileResult) {
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: fileResult.size,
        name: filePath.split('/').pop() || filePath,
        path: filePath,
        content: Buffer.from(fileResult.content).toString('base64'),
        sha: fileResult.sha,
      });
      return true;
    }
    
    // Try as directory
    const dirResult = storage.getDirectoryContent(repo.id, filePath, ref);
    if (dirResult !== null) {
      sendJson(res, 200, dirResult);
      return true;
    }
    
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  if (req.method === 'DELETE') {
    // DELETE /repos/{owner}/{repo}/contents/{path}
    parseBody(req).then(body => {
      const { message, sha, branch } = body as { message: string; sha: string; branch?: string };
      if (!message || !sha) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      
      try {
        const commitSha = storage.deleteFileContent(repo.id, filePath, message, sha, branch);
        if (!commitSha) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { commit: { sha: commitSha } });
      } catch (err) {
        if (err instanceof Error && err.message === 'SHA_CONFLICT') {
          sendJson(res, 409, {
            message: 'sha does not match',
            documentation_url: 'https://docs.github.com/rest/repos/contents#delete-file-contents',
          });
        } else {
          sendError(res, 500, 'Internal Server Error');
        }
      }
    }).catch(() => sendError(res, 400, 'Malformed JSON'));
    return true;
  }
  
  return false;
}

export function handleLabels(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const parts = getPathParts(req.url || '');
  // /api/v3/repos/{owner}/{repo}/labels
  if (parts.length !== 6 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || parts[5] !== 'labels') return false;
  
  const owner = parts[3];
  const repoName = parts[4];
  const repo = storage.getRepo(owner, repoName);
  if (!repo || repo.owner !== user.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  if (req.method === 'POST') {
    parseBody(req).then(body => {
      const { name, color = 'ededed' } = body as { name: string; color?: string };
      if (!name) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      try {
        const label = storage.createLabel(repo.id, name, color);
        sendJson(res, 201, { name: label.name, color: label.color });
      } catch {
        sendError(res, 422, 'Label already exists');
      }
    }).catch(() => sendError(res, 400, 'Malformed JSON'));
    return true;
  }
  
  return false;
}

export function handleIssues(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const parts = getPathParts(req.url || '');
  // /api/v3/repos/{owner}/{repo}/issues
  if (parts.length < 6 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || parts[5] !== 'issues') return false;
  
  const owner = parts[3];
  const repoName = parts[4];
  const repo = storage.getRepo(owner, repoName);
  if (!repo || repo.owner !== user.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  const subPath = parts.slice(6).join('/');
  
  if (req.method === 'POST' && subPath === '') {
    // POST /repos/{owner}/{repo}/issues
    parseBody(req).then(body => {
      const { title, body: issueBody = '', labels = [] } = body as { title: string; body?: string; labels?: string[] };
      if (!title) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      // Check if labels exist
      const repoLabels = storage.getLabels(repo.id);
      const labelNames = repoLabels.map(l => l.name);
      for (const label of labels) {
        if (!labelNames.includes(label)) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
      }
      const issue = storage.createIssue(repo.id, title, issueBody, labels);
      sendJson(res, 201, {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map(l => ({ name: l.name, color: l.color })),
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        closed_at: issue.closedAt,
        user: { login: user.login, id: user.id },
      });
    }).catch(() => sendError(res, 400, 'Malformed JSON'));
    return true;
  }
  
  if (req.method === 'GET' && subPath === '') {
    // GET /repos/{owner}/{repo}/issues
    const url = new URL(req.url ?? '', originOf(req));
    const state = url.searchParams.get('state') || 'open';
    const sort = url.searchParams.get('sort') || 'created';
    const direction = url.searchParams.get('direction') || 'desc';
    const perPage = Math.min(parseInt(url.searchParams.get('per_page') || '30', 10), 100);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    
    const allIssues = storage.listIssues(repo.id, state, sort, direction);
    const startIdx = (page - 1) * perPage;
    const issues = allIssues.slice(startIdx, startIdx + perPage);
    
    const headers: Record<string, string> = {};
    if (startIdx + perPage < allIssues.length) {
      const nextPage = page + 1;
      const nextUrl = `${url.origin}/api/v3/repos/${owner}/${repoName}/issues?state=${state}&sort=${sort}&direction=${direction}&page=${nextPage}&per_page=${perPage}`;
      headers['link'] = `<${nextUrl}>; rel="next"`;
    }
    
    sendJson(res, 200, issues.map(issue => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map(l => ({ name: l.name, color: l.color })),
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      user: { login: user.login, id: user.id },
    })), headers);
    return true;
  }
  
  // GET/PATCH /repos/{owner}/{repo}/issues/{number}
  if (parts.length === 7 && !isNaN(parseInt(parts[6], 10))) {
    const issueNumber = parseInt(parts[6], 10);
    if (req.method === 'GET') {
      const issue = storage.getIssue(repo.id, issueNumber);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map(l => ({ name: l.name, color: l.color })),
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        closed_at: issue.closedAt,
        user: { login: user.login, id: user.id },
      });
      return true;
    }
    if (req.method === 'PATCH') {
      parseBody(req).then(body => {
        const { state, title, body: issueBody } = body as { state?: 'open' | 'closed'; title?: string; body?: string };
        const updates: { state?: 'open' | 'closed'; title?: string; body?: string } = {};
        if (state !== undefined) updates.state = state;
        if (title !== undefined) updates.title = title;
        if (issueBody !== undefined) updates.body = issueBody;
        const updated = storage.updateIssue(repo.id, issueNumber, updates);
        if (!updated) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, {
          id: updated.id,
          number: updated.number,
          title: updated.title,
          body: updated.body,
          state: updated.state,
          labels: updated.labels.map(l => ({ name: l.name, color: l.color })),
          created_at: updated.createdAt,
          updated_at: updated.updatedAt,
          closed_at: updated.closedAt,
          user: { login: user.login, id: user.id },
        });
      }).catch(() => sendError(res, 400, 'Malformed JSON'));
      return true;
    }
  }
  
  // Comments: /repos/{owner}/{repo}/issues/{number}/comments
  if (parts.length === 8 && parts[5] === 'issues' && parts[7] === 'comments' && !isNaN(parseInt(parts[6], 10))) {
    const issueNumber = parseInt(parts[6], 10);
    const issue = storage.getIssue(repo.id, issueNumber);
    if (!issue) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (req.method === 'POST') {
      parseBody(req).then(body => {
        const { body: commentBody } = body as { body: string };
        if (!commentBody) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        const comment = storage.createComment(issue.id, commentBody);
        sendJson(res, 201, {
          id: comment.id,
          body: comment.body,
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
          user: { login: user.login, id: user.id },
        });
      }).catch(() => sendError(res, 400, 'Malformed JSON'));
      return true;
    }
    if (req.method === 'GET') {
      const comments = storage.getComments(issue.id);
      sendJson(res, 200, comments.map(c => ({
        id: c.id,
        body: c.body,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        user: { login: user.login, id: user.id },
      })));
      return true;
    }
  }
  
  return false;
}

export function handlePulls(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const parts = getPathParts(req.url || '');
  // /api/v3/repos/{owner}/{repo}/pulls
  if (parts.length < 6 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || parts[5] !== 'pulls') return false;
  
  const owner = parts[3];
  const repoName = parts[4];
  const repo = storage.getRepo(owner, repoName);
  if (!repo || repo.owner !== user.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  const subPath = parts.slice(6).join('/');
  
  if (req.method === 'POST' && subPath === '') {
    // POST /repos/{owner}/{repo}/pulls
    parseBody(req).then(body => {
      const { title, body: prBody = '', head, base } = body as { title: string; body?: string; head: string; base: string };
      if (!title || !head || !base) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      try {
        const pr = storage.createPullRequest(repo.id, title, prBody, head, base);
        sendJson(res, 201, {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          head: pr.head,
          base: pr.base,
          merged: pr.merged,
          merge_commit_sha: pr.mergeCommitSha,
          merged_at: pr.mergedAt,
          created_at: pr.createdAt,
          updated_at: pr.updatedAt,
          user: { login: user.login, id: user.id },
        });
      } catch {
        sendError(res, 422, 'Branch not found');
      }
    }).catch(() => sendError(res, 400, 'Malformed JSON'));
    return true;
  }
  
  if (req.method === 'GET' && subPath === '') {
    // GET /repos/{owner}/{repo}/pulls
    const url = new URL(req.url ?? '', originOf(req));
    const state = url.searchParams.get('state') || 'open';
    const perPage = Math.min(parseInt(url.searchParams.get('per_page') || '30', 10), 100);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    
    const allPrs = storage.getPullRequests(repo.id).filter(pr => state === 'all' || pr.state === state);
    const startIdx = (page - 1) * perPage;
    const prs = allPrs.slice(startIdx, startIdx + perPage);
    
    const headers: Record<string, string> = {};
    if (startIdx + perPage < allPrs.length) {
      const nextPage = page + 1;
      const nextUrl = `${url.origin}/api/v3/repos/${owner}/${repoName}/pulls?state=${state}&page=${nextPage}&per_page=${perPage}`;
      headers['link'] = `<${nextUrl}>; rel="next"`;
    }
    
    sendJson(res, 200, prs.map(pr => ({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      head: pr.head,
      base: pr.base,
      merged: pr.merged,
      merge_commit_sha: pr.mergeCommitSha,
      merged_at: pr.mergedAt,
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      user: { login: user.login, id: user.id },
    })), headers);
    return true;
  }
  
  // GET/PUT /repos/{owner}/{repo}/pulls/{number}
  if (parts.length === 7 && !isNaN(parseInt(parts[6], 10))) {
    const prNumber = parseInt(parts[6], 10);
    if (req.method === 'GET') {
      const pr = storage.getPullRequest(repo.id, prNumber);
      if (!pr) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        head: pr.head,
        base: pr.base,
        merged: pr.merged,
        merge_commit_sha: pr.mergeCommitSha,
        merged_at: pr.mergedAt,
        created_at: pr.createdAt,
        updated_at: pr.updatedAt,
        user: { login: user.login, id: user.id },
      });
      return true;
    }
  }
  
  // PUT /repos/{owner}/{repo}/pulls/{number}/merge
  if (parts.length === 8 && parts[6] !== 'merge' && parts[7] === 'merge' && !isNaN(parseInt(parts[6], 10))) {
    const prNumber = parseInt(parts[6], 10);
    if (req.method === 'PUT') {
      parseBody(req).then(body => {
        const { merge_method = 'squash' } = body as { merge_method?: 'squash' | 'merge' | 'rebase' };
        const result = storage.mergePullRequest(repo.id, prNumber, merge_method);
        if (!result) {
          const pr = storage.getPullRequest(repo.id, prNumber);
          if (!pr) {
            sendError(res, 404, 'Not Found');
          } else {
            sendError(res, 405, 'Pull request is not mergeable');
          }
          return;
        }
        if ('conflict' in result && result.conflict) {
          sendError(res, 405, 'Pull request is not mergeable');
          return;
        }
        sendJson(res, 200, {
          sha: result.sha,
          merged: true,
          message: result.message,
        });
      }).catch(() => sendError(res, 400, 'Malformed JSON'));
      return true;
    }
  }
  
  // GET /repos/{owner}/{repo}/pulls/{number}/files
  if (parts.length === 8 && parts[7] === 'files' && !isNaN(parseInt(parts[6], 10))) {
    const prNumber = parseInt(parts[6], 10);
    if (req.method === 'GET') {
      const pr = storage.getPullRequest(repo.id, prNumber);
      if (!pr) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      
      // Get base and head commit trees
      const headRef = storage.getRef(repo.owner, repo.name, `refs/heads/${pr.head.ref}`);
      const baseRef = storage.getRef(repo.owner, repo.name, `refs/heads/${pr.base.ref}`);
      if (!headRef || !baseRef) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      
      const headCommitObj = storage.getObject(headRef.sha);
      const baseCommitObj = storage.getObject(baseRef.sha);
      if (!headCommitObj || !baseCommitObj) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      
      const headCommit = storage.parseCommit(headCommitObj.data);
      const baseCommit = storage.parseCommit(baseCommitObj.data);
      
      // Get diff between base and head
      const diff = storage.getDiffBetweenTrees(baseCommit.tree, headCommit.tree);
      
      const files = diff.map(d => ({
        filename: d.filename,
        status: d.status,
        additions: d.additions,
        deletions: d.deletions,
        changes: d.changes,
        blob_url: `https://github.com/${owner}/${repoName}/blob/${pr.head.sha}/${d.filename}`,
        raw_url: `https://github.com/${owner}/${repoName}/raw/${pr.head.sha}/${d.filename}`,
        contents_url: `https://api.github.com/repos/${owner}/${repoName}/contents/${d.filename}?ref=${pr.head.ref}`,
        patch: `@@ -1 +1 @@\n-old\n+new`, // Simplified patch
      }));
      
      sendJson(res, 200, files);
      return true;
    }
  }
  
  return false;
}

export function handleGitRefs(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const parts = getPathParts(req.url || '');
  // /api/v3/repos/{owner}/{repo}/git/refs
  if (parts.length !== 7 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || parts[5] !== 'git' || parts[6] !== 'refs') return false;
  
  const owner = parts[3];
  const repoName = parts[4];
  const repo = storage.getRepo(owner, repoName);
  if (!repo || repo.owner !== user.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  if (req.method === 'POST') {
    parseBody(req).then(body => {
      const { ref, sha } = body as { ref: string; sha: string };
      if (!ref || !sha) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      storage.setRef(owner, repoName, ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
    }).catch(() => sendError(res, 400, 'Malformed JSON'));
    return true;
  }
  
  return false;
}

export function handleBranches(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const parts = getPathParts(req.url || '');
  // /api/v3/repos/{owner}/{repo}/branches
  if (parts.length !== 6 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || parts[5] !== 'branches') return false;
  
  const owner = parts[3];
  const repoName = parts[4];
  const repo = storage.getRepo(owner, repoName);
  if (!repo || repo.owner !== user.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  if (req.method === 'GET') {
    const branches = storage.getBranches(owner, repoName);
    sendJson(res, 200, branches);
    return true;
  }
  
  return false;
}

export function handleCommits(req: IncomingMessage, res: ServerResponse): boolean {
  const user = requireAuth(req, res);
  if (!user) return true;
  
  const parts = getPathParts(req.url || '');
  // /api/v3/repos/{owner}/{repo}/commits
  if (parts.length !== 6 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos' || parts[5] !== 'commits') return false;
  
  const owner = parts[3];
  const repoName = parts[4];
  const repo = storage.getRepo(owner, repoName);
  if (!repo || repo.owner !== user.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  
  if (req.method === 'GET') {
    const url = new URL(req.url ?? '', originOf(req));
    const sha = url.searchParams.get('sha') || repo.defaultBranch;
    const perPage = Math.min(parseInt(url.searchParams.get('per_page') || '30', 10), 100);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    
    // Get commit SHA for the ref
    const refObj = storage.getRef(owner, repoName, `refs/heads/${sha}`);
    const commitSha = refObj?.sha || sha;
    
    if (commitSha === '0'.repeat(40) || !storage.getObject(commitSha)) {
      sendJson(res, 200, []);
      return true;
    }
    
    // Walk commit history
    const commits = [];
    let currentSha = commitSha;
    let count = 0;
    const maxCommits = page * perPage;
    const startIdx = (page - 1) * perPage;
    
    while (currentSha && currentSha !== '0'.repeat(40) && count < maxCommits) {
      const commitObj = storage.getObject(currentSha);
      if (!commitObj || commitObj.type !== 'commit') break;
      
      const commit = storage.parseCommit(commitObj.data);
      
      if (count >= startIdx) {
        commits.push({
          sha: currentSha,
          commit: {
            message: commit.message.replace(/\n+$/, ''),
            author: {
              name: commit.author.split(' <')[0],
              email: commit.author.match(/<(.+)>/)?.[1] || '',
              date: commit.author.match(/> (.+) \+/)?.[1] || '',
            },
            committer: {
              name: commit.committer.split(' <')[0],
              email: commit.committer.match(/<(.+)>/)?.[1] || '',
              date: commit.committer.match(/> (.+) \+/)?.[1] || '',
            },
          },
          author: { login: user.login, id: user.id },
          parents: commit.parents.map(p => ({ sha: p })),
        });
      }
      
      count++;
      if (commit.parents.length > 0) {
        currentSha = commit.parents[0];
      } else {
        break;
      }
    }
    
    // Pagination headers
    const headers: Record<string, string> = {};
    if (count > startIdx + perPage) {
      const nextPage = page + 1;
      const nextUrl = `${url.origin}/api/v3/repos/${owner}/${repoName}/commits?sha=${sha}&page=${nextPage}&per_page=${perPage}`;
      headers['link'] = `<${nextUrl}>; rel="next"`;
    }
    
    sendJson(res, 200, commits, headers);
    return true;
  }
  
  return false;
}