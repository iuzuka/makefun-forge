// The MCP endpoint at POST /mcp: the legacy 2025 JSON-RPC surface (initialize +
// notifications/initialized, tools/list, tools/call) over the forge's own storage. The six
// GitHub tools the conformance mcp group calls are implemented with REST-shaped results;
// unknown methods answer JSON-RPC -32601, a non-JSON body HTTP 400 with -32700, and an
// unauthenticated request 401.
// SPDX-License-Identifier: MIT

import type { Storage } from './storage.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required?: string[] };
}

const SERVER_INFO = { name: 'makefun-github-forge', version: '1.0.0' };

const TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'The repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue on a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open or closed)',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'The issue state filter: open or closed' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request (squash)',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function rpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolJsonResult(requestId: unknown, payload: Record<string, unknown>): unknown {
  const isError = payload.isError === true;
  return rpcResult(requestId, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  });
}

function restRepoShape(storage: Storage, owner: string, name: string): Record<string, unknown> | null {
  const repo = storage.getRepo(owner, name);
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: { login: repo.owner },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function restIssueShape(issue: { id: number; number: number; title: string; body: string; state: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** Execute one tools/call; answers either a result or a JSON-RPC error object. */
function callTool(storage: Storage, user: { login: string }, name: string, args: Record<string, unknown>, requestId: unknown): unknown {
  const str = (key: string, fallback = ''): string => {
    const value = args[key];
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
  };
  switch (name) {
    case 'create_repo': {
      const name2 = str('name');
      if (name2 === '') return rpcError(null, -32602, `Invalid params: 'name' is required`);
      const repo = storage.createRepo(user.login, name2, str('description'), args.private === true);
      return toolJsonResult(requestId, restRepoShape(storage, user.login, repo.name)!);
    }
    case 'get_repo': {
      const shape = restRepoShape(storage, str('owner'), str('repo'));
      if (!shape || str('owner') !== user.login) return rpcError(null, -32602, `Invalid params: repository ${str('owner')}/${str('repo')} not found`);
      return toolJsonResult(requestId, shape);
    }
    case 'create_issue': {
      const repo = storage.getRepo(str('owner'), str('repo'));
      if (!repo || str('owner') !== user.login) return rpcError(null, -32602, `Invalid params: repository ${str('owner')}/${str('repo')} not found`);
      const title = str('title');
      if (title === '') return rpcError(null, -32602, `Invalid params: 'title' is required`);
      const issue = storage.createIssue(repo.id, title, str('body'), []);
      return toolJsonResult(requestId, restIssueShape(issue));
    }
    case 'list_issues': {
      const repo = storage.getRepo(str('owner'), str('repo'));
      if (!repo || str('owner') !== user.login) return rpcError(null, -32602, `Invalid params: repository ${str('owner')}/${str('repo')} not found`);
      const state = str('state');
      const issues = storage.listIssues(repo.id, state === 'open' || state === 'closed' ? state : undefined).map(restIssueShape);
      return toolJsonResult(requestId, { issues, total_count: issues.length });
    }
    case 'create_pull_request': {
      const repo = storage.getRepo(str('owner'), str('repo'));
      if (!repo || str('owner') !== user.login) return rpcError(null, -32602, `Invalid params: repository ${str('owner')}/${str('repo')} not found`);
      const head = str('head');
      const base = str('base');
      if (head === '' || base === '') return rpcError(null, -32602, `Invalid params: 'head' and 'base' are required`);
      const pr = storage.createPullRequest(repo.id, str('title'), str('body'), head, base);
      if (!pr) return toolJsonResult(requestId, { isError: true, message: 'the pull request could not be created' });
      return toolJsonResult(requestId, {
        number: pr.number,
        id: pr.id,
        title: pr.title,
        state: 'open',
        head: { ref: pr.head.ref, sha: pr.head.sha },
        base: { ref: pr.base.ref, sha: pr.base.sha },
      });
    }
    case 'merge_pull_request': {
      const repo = storage.getRepo(str('owner'), str('repo'));
      if (!repo || str('owner') !== user.login) return rpcError(null, -32602, `Invalid params: repository ${str('owner')}/${str('repo')} not found`);
      const pullNumber = Number(args.pull_number ?? args.number);
      if (!Number.isInteger(pullNumber)) return rpcError(null, -32602, `Invalid params: 'pull_number' is required`);
      const result = storage.mergePullRequest(repo.id, pullNumber, 'squash');
      if (!result || 'conflict' in result) return toolJsonResult(requestId, { isError: true, message: 'the pull request could not be merged' });
      const pr = storage.getPullRequest(repo.id, pullNumber);
      return toolJsonResult(requestId, {
        merged: true,
        sha: result.sha,
        number: pullNumber,
        state: 'closed',
        merged: true,
        merged_at: pr?.mergedAt ?? null,
      });
    }
    default:
      return rpcError(null, -32602, `Invalid params: no such tool ${name}`);
  }
}

/** Serve one MCP HTTP request; answers false when the path/method is not MCP's. */
export function handleMcpRequest(
  storage: Storage,
  user: { login: string } | null,
  method: string,
  bodyText: string,
): { status: number; body: unknown } | false {
  if (method !== 'POST') return false;
  if (user === null) return { status: 401, body: { message: 'Bad credentials' } };
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(bodyText) as JsonRpcRequest;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  const params = (request.params ?? {}) as Record<string, unknown>;
  switch (request.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
      return {
        status: 200,
        body: rpcResult(request.id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'notifications/initialized':
      return { status: 202, body: {} };
    case 'server/discover':
      return { status: 200, body: rpcError(request.id, -32601, 'Method not found: server/discover') };
    case 'tools/list':
      return { status: 200, body: rpcResult(request.id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return { status: 200, body: callTool(storage, user, name, args, request.id) };
    }
    default:
      return { status: 200, body: rpcError(request.id, -32601, `Method not found: ${String(request.method)}`) };
  }
}
