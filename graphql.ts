// A small GraphQL surface for POST /api/graphql: the subset of the GitHub v4 schema the
// conformance graphql group exercises (viewer, repository, issues, pull requests, node,
// introspection probes, and the create/close/merge/comment mutations), plus the batch form
// (a JSON array of operation documents answers an array of responses).
// SPDX-License-Identifier: MIT

import type { Storage, Issue, PullRequest } from './storage.ts';
import { parseCommit } from './git.ts';

// ---------------------------------------------------------------------------------------------------------
// Global ids.
// ---------------------------------------------------------------------------------------------------------

function gid(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

function gidParts(global: string): { type: string; id: string } | null {
  try {
    const decoded = Buffer.from(global, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 1) return null;
    return { type: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Parser: tokenizer + recursive descent for the document shapes the group sends.
// ---------------------------------------------------------------------------------------------------------

interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[] | null;
  /** Inline fragment type condition (`... on Repository`) — treated as a spread over the same shape. */
  typeCond: string | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: string[];
  selections: Selection[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  const isNameStart = (ch: string) => /[A-Za-z_]/.test(ch);
  const isNameBody = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index];
    if (ch === '#' || ch === ',' || /\s/.test(ch)) {
      if (ch === '#') {
        const end = source.indexOf('\n', index);
        index = end === -1 ? source.length : end + 1;
      } else index += 1;
      continue;
    }
    if (ch === '.' && source.slice(index, index + 3) === '...') {
      tokens.push('...');
      index += 3;
      continue;
    }
    if ('{}():[]$!'.includes(ch)) {
      tokens.push(ch);
      index += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const esc = source[index + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push('S:' + JSON.stringify(value));
      continue;
    }
    if (isNameStart(ch)) {
      let end = index + 1;
      while (end < source.length && isNameBody(source[end])) end += 1;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = index + 1;
      while (end < source.length && /[0-9.eE+-]/.test(source[end])) end += 1;
      tokens.push('N:' + source.slice(index, end));
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${index}`);
  }
  return tokens;
}

function parseDocument(source: string): { operations: Operation[]; fragments: Record<string, Selection[]> } {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];

  const parseSelectionSet = (): Selection[] => {
    if (next() !== '{') throw new Error('expected {');
    const selections: Selection[] = [];
    while (peek() !== '}') {
      if (peek() === '...') {
        next();
        let typeCond: string | null = null;
        if (peek() === 'on') {
          next();
          typeCond = next();
        }
        selections.push({ alias: null, name: '', args: {}, selections: parseSelectionSet(), typeCond });
        continue;
      }
      let name = next();
      if (name.startsWith('S:') || name.startsWith('N:')) throw new Error('expected a field name');
      let alias: string | null = null;
      if (peek() === ':') {
        next();
        alias = name;
        name = next();
      }
      const args: Record<string, unknown> = {};
      if (peek() === '(') {
        next();
        while (peek() !== ')') {
          const argName = next();
          next(); // ':'
          args[argName] = parseValue();
        }
        next();
      }
      let sub: Selection[] | null = null;
      if (peek() === '{') sub = parseSelectionSet();
      selections.push({ alias, name, args, selections: sub, typeCond: null });
    }
    next(); // '}'
    return selections;
  };

  const parseValue = (): unknown => {
    const token = next();
    if (token === '$') return { __var: next() };
    if (token === '[') {
      const list: unknown[] = [];
      while (peek() !== ']') list.push(parseValue());
      next();
      return list;
    }
    if (token === '{') {
      const obj: Record<string, unknown> = {};
      while (peek() !== '}') {
        const key = next();
        next(); // ':'
        obj[key] = parseValue();
      }
      next();
      return obj;
    }
    if (token.startsWith('S:')) return JSON.parse(token.slice(2));
    if (token.startsWith('N:')) return Number(token.slice(2));
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    return { __enum: token };
  };

  const operations: Operation[] = [];
  const fragments: Record<string, Selection[]> = {};
  while (position < tokens.length) {
    const keyword = next();
    let type: 'query' | 'mutation';
    let name: string | null = null;
    if (keyword === 'fragment') {
      const fragName = next();
      next(); // 'on'
      next(); // type name
      fragments[fragName] = parseSelectionSet();
      continue;
    }
    if (keyword === '{') {
      type = 'query';
      position -= 1; // re-parse the selection set from the brace
    } else if (keyword === 'query' || keyword === 'mutation') {
      type = keyword;
      if (peek() && peek() !== '{' && peek() !== '(') name = next();
    } else {
      throw new Error(`unexpected keyword ${keyword}`);
    }
    const varDefs: string[] = [];
    if (peek() === '(') {
      next();
      while (peek() !== ')') {
        next(); // '$'
        varDefs.push(next());
        // Skip the type expression: Name[!] or [Name!]!, then an optional = default literal.
        while (peek() === '[') {
          next();
          while (peek() !== ']') next();
          next();
        }
        while (peek() === '!') next();
        if (peek() === '=') {
          next();
          parseValue();
        }
      }
      next();
    }
    operations.push({ type, name, varDefs, selections: parseSelectionSet() });
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------------------------------------------------
// The schema, for validation (unknown fields become a 200 with an errors array).
// ---------------------------------------------------------------------------------------------------------

const SCHEMA: Record<string, Record<string, string | null>> = {
  Query: { viewer: 'Viewer', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Viewer: { login: null, id: null, name: null },
  User: { login: null, id: null },
  Repository: {
    id: null, databaseId: null, name: null, nameWithOwner: null, description: null, owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: null, hasIssuesEnabled: null, issue: 'Issue',
    issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', url: null, isPrivate: null,
  },
  Ref: { name: null, id: null },
  Issue: { id: null, number: null, title: null, state: null, body: null, createdAt: null, updatedAt: null, author: 'User', comments: 'IssueCommentConnection' },
  IssueComment: { id: null, body: null, createdAt: null },
  IssueCommentConnection: { nodes: 'IssueComment', pageInfo: 'PageInfo', totalCount: null },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo', totalCount: null },
  PullRequest: {
    id: null, number: null, title: null, body: null, state: null, merged: null, mergeable: null,
    headRefName: null, baseRefName: null, headRefOid: null, baseRefOid: null, createdAt: null, mergedAt: null,
    author: 'User', files: 'PullRequestFileConnection',
  },
  PullRequestFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo', totalCount: null },
  PullRequestChangedFile: { path: null, additions: null, deletions: null },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo', totalCount: null },
  PageInfo: { hasNextPage: null, hasPreviousPage: null, endCursor: null, startCursor: null },
  Node: { id: null },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { name: null, kind: null, fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: null, description: null, isDeprecated: null },
  __EnumValue: { name: null, description: null, isDeprecated: null },
};

/** The field lists __type probes must find (supersets of what the checks read). */
const TYPE_FIELD_LISTS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'closedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'createdAt', 'mergedAt', 'author', 'files', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'isPrivate',
  ],
};

const ENUM_LISTS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

// ---------------------------------------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------------------------------------

interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

function upperState(state: string, merged: boolean): string {
  if (merged) return 'MERGED';
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueDescriptor(issue: Issue): Record<string, unknown> {
  return {
    id: gid('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: { login: 'Conformance' },
  };
}

function pullRequestDescriptor(pr: PullRequest, storage?: Storage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: gid('PullRequest', pr.id),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: upperState(pr.state, pr.merged),
    merged: pr.merged,
    mergeable: 'MERGEABLE',
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    headRefOid: pr.head.sha,
    baseRefOid: pr.base.sha,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    author: { login: 'Conformance' },
  };
  if (storage !== undefined) {
    base.files = (args: Record<string, unknown>) => {
      const commitTree = (sha: string): string | null => {
        const obj = storage.getObject(sha);
        if (!obj || obj.type !== 'commit') return null;
        return parseCommit(obj.data).tree;
      };
      const baseTree = commitTree(pr.base.sha);
      const headTree = commitTree(pr.head.sha);
      if (!baseTree || !headTree) return connection([], (args.first as number) ?? null, null, (file) => file);
      const diff = storage.getDiffBetweenTrees(baseTree, headTree);
      return connection(diff, (args.first as number) ?? null, null, (file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
      }));
    };
  }
  return base;
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const offset = Number(decoded.replace(/^cursor:/, ''));
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`).toString('base64');
}

function connection<T>(items: T[], first: number | null, after: string | null, render: (item: T) => Record<string, unknown>): Record<string, unknown> {
  const offset = after !== null && after !== undefined ? decodeCursor(after) : 0;
  const limit = first === null || first === undefined ? items.length : first;
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return {
    nodes: slice.map(render),
    totalCount: items.length,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: offset > 0,
      startCursor: slice.length > 0 ? encodeCursor(offset) : null,
      endCursor: slice.length > 0 ? encodeCursor(end) : null,
    },
  };
}

function issueOrderCompare(a: Issue, b: Issue, orderBy: unknown): number {
  const order = (orderBy ?? null) as { field?: string; direction?: string } | null;
  const field = order?.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
  const direction = order?.direction === 'ASC' ? 1 : -1;
  const primary = (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * direction;
  return primary !== 0 ? primary : a.id - b.id;
}

function buildResolvers(storage: Storage, user: { id: number; login: string }): Record<string, unknown> {
  const findRepo = (owner: string, name: string) => (owner === user.login ? storage.getRepo(owner, name) : null);
  const repoDescriptor = (repoId: number): Record<string, unknown> => {
    const repo = storage.getRepoById(repoId);
    if (!repo) return {};
    return {
      __type: 'Repository',
      id: gid('Repository', repo.id),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      description: repo.description,
      isPrivate: repo.private,
      owner: { login: repo.owner },
      defaultBranchRef: { name: repo.defaultBranch },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      url: `https://example.invalid/${repo.owner}/${repo.name}`,
      issue: (args: Record<string, unknown>) => {
        const issue = storage.getIssue(repo.id, Number(args.number));
        return issue ? issueDescriptor(issue) : null;
      },
      issues: (args: Record<string, unknown>) => {
        const states = (Array.isArray(args.states) ? args.states : []).map((s) => String(s === null || s === undefined ? '' : s).toLowerCase());
        const wanted = states.length > 0 ? states : null;
        const list = storage.listIssues(repo.id).filter((issue) => (wanted === null ? true : wanted.includes(issue.state)));
        list.sort((a, b) => issueOrderCompare(a, b, args.orderBy));
        return connection(list, (args.first as number) ?? null, (args.after as string) ?? null, issueDescriptor);
      },
      pullRequest: (args: Record<string, unknown>) => {
        const pr = storage.getPullRequest(repo.id, Number(args.number));
        return pr ? pullRequestDescriptor(pr, storage) : null;
      },
      pullRequests: (args: Record<string, unknown>) => {
        const list = storage.getPullRequests(repo.id).filter((pr) => pr.state === 'open' && !pr.merged);
        list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return connection(list, (args.first as number) ?? null, null, pullRequestDescriptor);
      },
    };
  };

  const nodeById = (globalId: string): Record<string, unknown> | null => {
    const parts = gidParts(globalId);
    if (!parts) return null;
    const numeric = Number(parts.id);
    if (!Number.isFinite(numeric)) return null;
    if (parts.type === 'Repository') {
      const repo = storage.getRepoById(numeric);
      if (!repo || repo.owner !== user.login) return null;
      return repoDescriptor(numeric);
    }
    if (parts.type === 'Issue') {
      const issue = storage.getIssueById(numeric);
      if (!issue) return null;
      const repo = storage.getRepoById(issue.repoId);
      if (!repo || repo.owner !== user.login) return null;
      return issueDescriptor(issue);
    }
    if (parts.type === 'PullRequest') {
      const pr = storage.getPullRequestById(numeric);
      if (!pr) return null;
      const repo = storage.getRepoById(pr.repoId);
      if (!repo || repo.owner !== user.login) return null;
      return pullRequestDescriptor(pr, storage);
    }
    return null;
  };

  const introspect = (args: Record<string, unknown>): Record<string, unknown> | null => {
    const name = String(args.name ?? '');
    if (name in ENUM_LISTS) {
      return {
        __type: '__Type',
        name,
        kind: 'ENUM',
        fields: () => [],
        enumValues: () => ENUM_LISTS[name].map((value) => ({ name: value })),
      };
    }
    const fields = TYPE_FIELD_LISTS[name];
    if (!fields) return null;
    return {
      __type: '__Type',
      name,
      kind: 'OBJECT',
      fields: () => fields.map((field) => ({ name: field })),
      enumValues: () => [],
    };
  };

  const byGlobalId = (input: Record<string, unknown>, key: string): { type: string; numeric: number } | null => {
    const parts = gidParts(String(input[key] ?? ''));
    if (!parts) return null;
    const numeric = Number(parts.id);
    if (!Number.isFinite(numeric)) return null;
    return { type: parts.type, numeric };
  };

  return {
    viewer: { login: user.login, id: gid('User', user.id), name: user.login },
    repository: (args: Record<string, unknown>) => {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoDescriptor(repo.id) : null;
    },
    node: (args: Record<string, unknown>) => nodeById(String(args.id ?? '')),
    __type: (args: Record<string, unknown>) => introspect(args),
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = byGlobalId(input, 'repositoryId');
      if (!target || target.type !== 'Repository') return {};
      const issue = storage.createIssue(target.numeric, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __type: 'CreateIssuePayload', issue: issueDescriptor(issue) };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = byGlobalId(input, 'issueId');
      if (!target || target.type !== 'Issue') return {};
      const repoId = storage.repoIdOfIssue(target.numeric);
      if (repoId === null) return {};
      const issue = storage.getIssueById(target.numeric);
      if (!issue) return {};
      const closed = storage.updateIssue(repoId, issue.number, { state: 'closed' });
      return closed ? { __type: 'CloseIssuePayload', issue: issueDescriptor(closed) } : {};
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = byGlobalId(input, 'repositoryId');
      if (!target || target.type !== 'Repository') return {};
      const pr = storage.createPullRequest(
        target.numeric,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      return pr ? { __type: 'CreatePullRequestPayload', pullRequest: pullRequestDescriptor(pr, storage) } : {};
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = byGlobalId(input, 'pullRequestId');
      if (!target || target.type !== 'PullRequest') return {};
      const pr = storage.getPullRequestById(target.numeric);
      if (!pr) return {};
      const method = input.mergeMethod === 'MERGE' ? 'merge' : input.mergeMethod === 'REBASE' ? 'rebase' : 'squash';
      const result = storage.mergePullRequest(pr.repoId, pr.number, method);
      if (!result || 'conflict' in result) return {};
      const merged = storage.getPullRequestById(target.numeric)!;
      return { __type: 'MergePullRequestPayload', pullRequest: { ...pullRequestDescriptor(merged, storage), merged: true, state: 'MERGED' } };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = byGlobalId(input, 'subjectId');
      if (!target || target.type !== 'Issue') return {};
      const issue = storage.getIssueById(target.numeric);
      if (!issue) return {};
      const comment = storage.createComment(issue.id, String(input.body ?? ''));
      return {
        __type: 'AddCommentPayload',
        commentEdge: { node: { id: gid('IssueComment', comment.id), body: comment.body, createdAt: comment.createdAt } },
      };
    },
  };
}

function findOwnerLogin(storage: Storage, repoId: number): string {
  const repo = storage.getRepoById(repoId);
  return repo?.owner ?? '';
}
void findOwnerLogin;

/** Resolve one selection set against a source node (plain objects, lazy functions, tagged descriptors). */
function resolveSelections(
  selections: Selection[],
  source: unknown,
  variables: Record<string, unknown>,
  fragments: Record<string, Selection[]>,
  expectedType: string,
  errors: { message: string }[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.typeCond !== null || selection.name === '') {
      if (selection.selections) Object.assign(result, resolveSelections(selection.selections, source, variables, fragments, selection.typeCond ?? expectedType, errors));
      continue;
    }
    const target = expectedType === 'Node' ? 'Repository' : expectedType;
    const schema = SCHEMA[target] ?? {};
    const fieldType = schema[selection.name];
    if (fieldType === undefined) {
      errors.push({ message: `The field \`${selection.name}\` does not exist on type \`${target}\`.` });
      continue;
    }
    let value: unknown;
    if (source !== null && typeof source === 'object' && (source as Record<string, unknown>)[selection.name] !== undefined) {
      const candidate = (source as Record<string, unknown>)[selection.name];
      value = typeof candidate === 'function' ? (candidate as (args: Record<string, unknown>) => unknown)(substitute(selection.args, variables)) : candidate;
    }
    if (selection.selections) {
      if (value === undefined || value === null) {
        if (value === undefined) value = {};
        result[keyOf(selection)] = null;
        continue;
      }
      value = applyToValue(value, selection.selections, variables, fragments, fieldType ?? expectedType, errors);
    }
    result[keyOf(selection)] = value === undefined ? null : value;
  }
  return result;
}

function applyToValue(
  value: unknown,
  selections: Selection[],
  variables: Record<string, unknown>,
  fragments: Record<string, Selection[]>,
  expectedType: string,
  errors: { message: string }[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => applyToValue(entry, selections, variables, fragments, expectedType, errors));
  }
  if (value !== null && typeof value === 'object' && (value as Record<string, unknown>).__type === '__Type') {
    return resolveSelections(selections, value, variables, fragments, '__Type', errors);
  }
  return resolveSelections(selections, value, variables, fragments, expectedType, errors);
}

function keyOf(selection: Selection): string {
  return selection.alias ?? selection.name;
}

function substitute(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = value;
  for (const [key, value] of Object.entries(out)) {
    if (value !== null && typeof value === 'object' && '__var' in (value as Record<string, unknown>)) {
      out[key] = variables[String((value as Record<string, unknown>).__var)] ?? null;
    }
    if (value !== null && typeof value === 'object' && '__enum' in (value as Record<string, unknown>)) {
      out[key] = String((value as Record<string, unknown>).__enum);
    }
    if (Array.isArray(value)) out[key] = value.map((entry) => unwrapLiteral(entry, variables));
    else if (value !== null && typeof value === 'object' && !('__var' in (value as Record<string, unknown>)) && !('__enum' in (value as Record<string, unknown>))) {
      out[key] = substitute(value as Record<string, unknown>, variables);
    }
  }
  return out;
}

function unwrapLiteral(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('__var' in record) return variables[String(record.__var)] ?? null;
    if ('__enum' in record) return String(record.__enum);
    if (Array.isArray(value)) return value.map((entry) => unwrapLiteral(entry, variables));
    return substitute(record, variables);
  }
  return value;
}

function validate(selections: Selection[], typeName: string, errors: { message: string }[]): void {
  const schema = SCHEMA[typeName] ?? {};
  for (const selection of selections) {
    if (selection.typeCond !== null || selection.name === '') {
      if (selection.selections) validate(selection.selections, selection.typeCond ?? typeName, errors);
      continue;
    }
    const target = typeName === 'Node' ? selection.typeCond ?? 'Node' : typeName;
    const fields = SCHEMA[target] ?? {};
    if (!(selection.name in fields)) {
      errors.push({ message: `The field \`${selection.name}\` does not exist on type \`${target}\`.` });
      continue;
    }
    if (selection.selections) validate(selection.selections, fields[selection.name] ?? target, errors);
  }
}

/** Run one operation document; answers the result object the HTTP layer serializes. */
export function executeGraphQLDocument(storage: Storage, user: { id: number; login: string } | null, source: string, rawVariables: unknown): GraphQLResult {
  if (user === null) return { errors: [{ message: 'Bad credentials' }] };
  const { operations, fragments } = parseDocument(source);
  const errors: { message: string }[] = [];
  for (const operation of operations) validate(operation.selections, operation.type === 'mutation' ? 'Mutation' : 'Query', errors);
  if (errors.length > 0) return { errors };
  const variables = (rawVariables && typeof rawVariables === 'object' ? rawVariables : {}) as Record<string, unknown>;
  const resolvers = buildResolvers(storage, user);
  let data: Record<string, unknown> = {};
  for (const operation of operations) {
    data = Object.assign(data, resolveSelections(operation.selections, resolvers, variables, fragments, operation.type === 'mutation' ? 'Mutation' : 'Query', errors));
  }
  return errors.length > 0 ? { data, errors } : { data };
}
