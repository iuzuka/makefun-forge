import { storage } from './storage.ts';
import type { Repository, Issue, PullRequest, User } from './storage.ts';

export interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: McpServerInfo;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface AuthUser {
  login: string;
}

type McpHandler = (user: AuthUser | null, request: McpRequest) => Promise<McpResponse>;

const PROTOCOL_VERSION = '2025-11-25';
const SERVER_INFO: McpServerInfo = { name: 'makefun-forge', version: '1.0.0' };
const CAPABILITIES: McpCapabilities = { tools: {} };

const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function createErrorResponse(id: string | number | null, code: number, message: string, data?: unknown): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function createSuccessResponse(id: string | number | null, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

function createToolResult(text: string, structuredContent?: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError,
  };
}

async function handleInitialize(user: AuthUser | null, request: McpRequest): Promise<McpResponse> {
  const params = request.params ?? {};
  const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;

  const result: McpInitializeResult = {
    protocolVersion,
    capabilities: CAPABILITIES,
    serverInfo: SERVER_INFO,
  };

  return createSuccessResponse(request.id ?? null, result);
}

async function handleToolsList(user: AuthUser | null, request: McpRequest): Promise<McpResponse> {
  if (!user) {
    return createErrorResponse(request.id ?? null, -32600, 'Unauthorized');
  }
  return createSuccessResponse(request.id ?? null, { tools: TOOLS });
}

async function handleToolCall(user: AuthUser | null, request: McpRequest): Promise<McpResponse> {
  if (!user) {
    return createErrorResponse(request.id ?? null, -32600, 'Unauthorized');
  }

  const params = request.params ?? {};
  const toolName = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  const tool = TOOLS.find(t => t.name === toolName);
  if (!tool) {
    return createErrorResponse(request.id ?? null, -32601, `Method not found: ${toolName}`);
  }

  const required = tool.inputSchema.required ?? [];
  for (const req of required) {
    if (!(req in args)) {
      return createErrorResponse(request.id ?? null, -32602, `Missing required argument: ${req}`);
    }
  }

  try {
    let result: McpToolResult;

    switch (toolName) {
      case 'create_repo': {
        const name = String(args.name);
        const description = typeof args.description === 'string' ? args.description : '';
        const privateRepo = typeof args.private === 'boolean' ? args.private : true;
        const repo = storage.createRepo(user.login, name, description, privateRepo);
        result = createToolResult(
          `Created repository ${repo.fullName}`,
          { id: repo.id, name: repo.name, full_name: repo.fullName, private: repo.private, owner: { login: repo.owner }, html_url: `https://github.com/${repo.fullName}`, description: repo.description, default_branch: repo.defaultBranch, created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.updatedAt },
        );
        break;
      }

      case 'get_repo': {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const repo = storage.getRepo(owner, repoName);
        if (!repo || repo.owner !== user.login) {
          result = createToolResult('Repository not found', null, true);
        } else {
          result = createToolResult(
            `Repository ${repo.fullName}`,
            { id: repo.id, name: repo.name, full_name: repo.fullName, private: repo.private, owner: { login: repo.owner }, html_url: `https://github.com/${repo.fullName}`, description: repo.description, default_branch: repo.defaultBranch, created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.updatedAt },
          );
        }
        break;
      }

      case 'create_issue': {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const title = String(args.title);
        const body = typeof args.body === 'string' ? args.body : '';
        const repo = storage.getRepo(owner, repoName);
        if (!repo || repo.owner !== user.login) {
          result = createToolResult('Repository not found', null, true);
        } else {
          const issue = storage.createIssue(repo.id, title, body, []);
          result = createToolResult(
            `Created issue #${issue.number}: ${issue.title}`,
            { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: [], created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.closedAt, user: { login: user.login, id: user.id } },
          );
        }
        break;
      }

      case 'list_issues': {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const repo = storage.getRepo(owner, repoName);
        if (!repo || repo.owner !== user.login) {
          result = createToolResult('Repository not found', null, true);
        } else {
          const issues = storage.listIssues(repo.id, state);
          const issueList = issues.map(i => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map(l => ({ name: l.name, color: l.color })), created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt, user: { login: user.login, id: user.id } }));
          result = createToolResult(
            `Found ${issueList.length} issues`,
            { issues: issueList },
          );
        }
        break;
      }

      case 'create_pull_request': {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const title = String(args.title);
        const body = typeof args.body === 'string' ? args.body : '';
        const head = String(args.head);
        const base = String(args.base);
        const repo = storage.getRepo(owner, repoName);
        if (!repo || repo.owner !== user.login) {
          result = createToolResult('Repository not found', null, true);
        } else {
          try {
            const pr = storage.createPullRequest(repo.id, title, body, head, base);
            result = createToolResult(
              `Created pull request #${pr.number}: ${pr.title}`,
              { id: pr.id, number: pr.number, title: pr.title, body: pr.body, state: pr.state, head: pr.head, base: pr.base, merged: pr.merged, merge_commit_sha: pr.mergeCommitSha, merged_at: pr.mergedAt, created_at: pr.createdAt, updated_at: pr.updatedAt, user: { login: user.login, id: user.id } },
            );
          } catch (error) {
            result = createToolResult(`Failed to create pull request: ${error instanceof Error ? error.message : String(error)}`, null, true);
          }
        }
        break;
      }

      case 'merge_pull_request': {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
        const repo = storage.getRepo(owner, repoName);
        if (!repo || repo.owner !== user.login) {
          result = createToolResult('Repository not found', null, true);
        } else {
          const mergeResult = storage.mergePullRequest(repo.id, pullNumber);
          if (!mergeResult) {
            const pr = storage.getPullRequest(repo.id, pullNumber);
            if (!pr) {
              result = createToolResult('Pull request not found', null, true);
            } else {
              result = createToolResult('Pull request is not mergeable', null, true);
            }
          } else if ('conflict' in mergeResult) {
            result = createToolResult('Pull request has conflicts', null, true);
          } else {
            result = createToolResult(
              `Merged pull request #${pullNumber}`,
              { sha: mergeResult.sha, merged: true, message: mergeResult.message },
            );
          }
        }
        break;
      }

      default: {
        result = createToolResult(`Unknown tool: ${toolName}`, null, true);
      }
    }

    return createSuccessResponse(request.id ?? null, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createErrorResponse(request.id ?? null, -32603, `Internal error: ${message}`);
  }
}

const HANDLERS: Record<string, McpHandler> = {
  initialize: handleInitialize,
  'notifications/initialized': async (_user, request) => createSuccessResponse(request.id ?? null, {}),
  'tools/list': handleToolsList,
  'tools/call': handleToolCall,
};

export async function handleMcpRequest(
  store: typeof storage,
  user: { login: string } | null,
  method: string,
  bodyText: string
): Promise<{ status: number; body: McpResponse } | false> {
  if (method !== 'POST') {
    return false;
  }

  let request: McpRequest;
  try {
    request = JSON.parse(bodyText) as McpRequest;
  } catch {
    return { status: 400, body: createErrorResponse(null, -32700, 'Parse error') };
  }

  if (request.jsonrpc !== '2.0') {
    return { status: 400, body: createErrorResponse(request.id ?? null, -32600, 'Invalid Request') };
  }

  const handler = HANDLERS[request.method];
  if (!handler) {
    return { status: 400, body: createErrorResponse(request.id ?? null, -32601, `Method not found: ${request.method}`) };
  }

  const authUser = user ? { login: user.login } : null;

  if (request.method !== 'initialize' && request.method !== 'notifications/initialized' && !authUser) {
    return { status: 401, body: createErrorResponse(request.id ?? null, -32600, 'Unauthorized') };
  }

  const response = await handler(authUser, request);
  return { status: 200, body: response };
}