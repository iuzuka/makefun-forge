// In-memory storage for the forge

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const DEFAULT_BRANCH = 'main';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Repository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Label {
  id: number;
  repoId: number;
  name: string;
  color: string;
}

export interface PullRequest {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  issueId: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Ref {
  name: string;
  sha: string;
}

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
  sha: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface BranchInfo {
  name: string;
  commit: { sha: string };
}

export interface ContentEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size?: number;
  content?: string;
  encoding?: string;
}

class Storage {
  private users = new Map<string, User>();
  private repos = new Map<string, Repository>(); // key: owner/repo
  private issues = new Map<number, Issue[]>(); // key: repoId
  private labels = new Map<number, Label[]>(); // key: repoId
  private pullRequests = new Map<number, PullRequest[]>(); // key: repoId
  private comments = new Map<number, Comment[]>(); // key: issueId
  private refs = new Map<string, Ref[]>(); // key: owner/repo
  private gitObjects = new Map<string, GitObject>(); // key: sha
  private nextUserId = 1000;
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextLabelId = 1;
  private nextPrId = 1;
  private nextCommentId = 1;
  private issueCounters = new Map<number, number>(); // key: repoId
  private prCounters = new Map<number, number>(); // key: repoId

  // User management
  getUserByToken(token: string): User | null {
    // In a real implementation, this would validate the token
    // For now, we use the token as the login
    return this.users.get(token) || null;
  }

  setUser(token: string, user: User): void {
    this.users.set(token, user);
  }

  // Repository management
  createRepo(owner: string, name: string, description: string, privateRepo: boolean): Repository {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) {
      throw new Error('Repository already exists');
    }
    const now = new Date().toISOString();
    const repo: Repository = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: key,
      description,
      private: privateRepo,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(key, repo);
    this.refs.set(key, [{ name: `refs/heads/${DEFAULT_BRANCH}`, sha: '0'.repeat(40) }]);
    this.issues.set(repo.id, []);
    this.labels.set(repo.id, []);
    this.pullRequests.set(repo.id, []);
    this.issueCounters.set(repo.id, 0);
    this.prCounters.set(repo.id, 0);
    return repo;
  }

  getRepo(owner: string, name: string): Repository | null {
    return this.repos.get(`${owner}/${name}`) || null;
  }

  getRepoById(id: number): Repository | null {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return null;
  }

  updateRepo(owner: string, name: string, updates: Partial<Pick<Repository, 'description'>>): Repository | null {
    const key = `${owner}/${name}`;
    const repo = this.repos.get(key);
    if (!repo) return null;
    const updated = { ...repo, ...updates, updatedAt: new Date().toISOString() };
    this.repos.set(key, updated);
    return updated;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    const repo = this.repos.get(key);
    if (!repo) return false;
    this.repos.delete(key);
    this.refs.delete(key);
    this.issues.delete(repo.id);
    this.labels.delete(repo.id);
    this.pullRequests.delete(repo.id);
    this.issueCounters.delete(repo.id);
    this.prCounters.delete(repo.id);
    return true;
  }

  listUserRepos(owner: string, page: number, perPage: number): { repos: Repository[]; hasNext: boolean } {
    const userRepos = Array.from(this.repos.values())
      .filter(r => r.owner === owner)
      .sort((a, b) => a.id - b.id);
    const start = (page - 1) * perPage;
    const end = start + perPage;
    return {
      repos: userRepos.slice(start, end),
      hasNext: end < userRepos.length,
    };
  }

  // Ref management
  getRefs(owner: string, repo: string): Ref[] {
    return this.refs.get(`${owner}/${repo}`) || [];
  }

  getRef(owner: string, repo: string, name: string): Ref | null {
    const refs = this.getRefs(owner, repo);
    return refs.find(r => r.name === name) || null;
  }

  setRef(owner: string, repo: string, name: string, sha: string): void {
    const key = `${owner}/${repo}`;
    const refs = this.refs.get(key) || [];
    const idx = refs.findIndex(r => r.name === name);
    if (idx >= 0) {
      refs[idx] = { name, sha };
    } else {
      refs.push({ name, sha });
    }
    this.refs.set(key, refs);
  }

  deleteRef(owner: string, repo: string, name: string): boolean {
    const key = `${owner}/${repo}`;
    const refs = this.refs.get(key) || [];
    const idx = refs.findIndex(r => r.name === name);
    if (idx >= 0) {
      refs.splice(idx, 1);
      this.refs.set(key, refs);
      return true;
    }
    return false;
  }

  // Git object storage
  storeObject(type: GitObject['type'], data: Buffer): string {
    const header = `${type} ${data.length}\0`;
    const hash = createHash('sha1');
    hash.update(header);
    hash.update(data);
    const sha = hash.digest('hex');
    if (!this.gitObjects.has(sha)) {
      this.gitObjects.set(sha, { type, data, sha });
    }
    return sha;
  }

  getObject(sha: string): GitObject | null {
    return this.gitObjects.get(sha) || null;
  }

  hasObject(sha: string): boolean {
    return this.gitObjects.has(sha);
  }

  // Blob operations
  createBlob(content: Buffer): string {
    return this.storeObject('blob', content);
  }

  // Tree operations
  createTree(entries: TreeEntry[]): string {
    // Sort entries like git does
    const sorted = [...entries].sort((a, b) => {
      const aKey = a.mode === '40000' ? a.name + '/' : a.name;
      const bKey = b.mode === '40000' ? b.name + '/' : b.name;
      return aKey.localeCompare(bKey);
    });
    let data = Buffer.alloc(0);
    for (const entry of sorted) {
      const modeBuf = Buffer.from(entry.mode + ' ', 'utf8');
      const nameBuf = Buffer.from(entry.name + '\0', 'utf8');
      const shaBuf = Buffer.from(entry.sha, 'hex');
      data = Buffer.concat([data, modeBuf, nameBuf, shaBuf]);
    }
    return this.storeObject('tree', data);
  }

  parseTree(data: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let offset = 0;
    while (offset < data.length) {
      const spaceIdx = data.indexOf(0x20, offset);
      if (spaceIdx === -1) break;
      const mode = data.subarray(offset, spaceIdx).toString('ascii');
      const nullIdx = data.indexOf(0x00, spaceIdx + 1);
      if (nullIdx === -1) break;
      const name = data.subarray(spaceIdx + 1, nullIdx).toString('utf8');
      const sha = data.subarray(nullIdx + 1, nullIdx + 21).toString('hex');
      entries.push({ mode, name, sha });
      offset = nullIdx + 21;
    }
    return entries;
  }

  // Commit operations
  createCommit(commit: CommitData): string {
    let data = `tree ${commit.tree}\n`;
    for (const parent of commit.parents) {
      data += `parent ${parent}\n`;
    }
    data += `author ${commit.author}\n`;
    data += `committer ${commit.committer}\n`;
    data += `\n${commit.message}`;
    if (!data.endsWith('\n')) data += '\n';
    return this.storeObject('commit', Buffer.from(data, 'utf8'));
  }

  parseCommit(data: Buffer): CommitData {
    const text = data.toString('utf8');
    const lines = text.split('\n');
    const commit: CommitData = { tree: '', parents: [], author: '', committer: '', message: '' };
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line === '') break;
      if (line.startsWith('tree ')) commit.tree = line.slice(5);
      else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
      else if (line.startsWith('author ')) commit.author = line.slice(7);
      else if (line.startsWith('committer ')) commit.committer = line.slice(10);
    }
    commit.message = lines.slice(i + 1).join('\n');
    return commit;
  }

  // Tag operations
  createTag(object: string, type: string, tag: string, tagger: string, message: string): string {
    let data = `object ${object}\n`;
    data += `type ${type}\n`;
    data += `tag ${tag}\n`;
    data += `tagger ${tagger}\n`;
    data += `\n${message}`;
    if (!data.endsWith('\n')) data += '\n';
    return this.storeObject('tag', Buffer.from(data, 'utf8'));
  }

  // Branch operations
  getBranches(owner: string, repo: string): BranchInfo[] {
    const refs = this.getRefs(owner, repo);
    return refs
      .filter(r => r.name.startsWith('refs/heads/'))
      .map(r => ({ name: r.name.slice('refs/heads/'.length), commit: { sha: r.sha } }));
  }

  createBranch(owner: string, repo: string, branchName: string, sha: string): void {
    this.setRef(owner, repo, `refs/heads/${branchName}`, sha);
  }

  // Issue operations
  getIssues(repoId: number): Issue[] {
    return this.issues.get(repoId) || [];
  }

  createIssue(repoId: number, title: string, body: string, labelNames: string[]): Issue {
    const repoIssues = this.issues.get(repoId) || [];
    const counter = (this.issueCounters.get(repoId) || 0) + 1;
    this.issueCounters.set(repoId, counter);
    const labels = this.getLabels(repoId).filter(l => labelNames.includes(l.name));
    const now = new Date().toISOString();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: counter,
      repoId,
      title,
      body,
      state: 'open',
      labels,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repoIssues.push(issue);
    this.issues.set(repoId, repoIssues);
    return issue;
  }

  getIssue(repoId: number, number: number): Issue | null {
    const repoIssues = this.issues.get(repoId) || [];
    return repoIssues.find(i => i.number === number) || null;
  }

  updateIssue(repoId: number, number: number, updates: Partial<Pick<Issue, 'state' | 'title' | 'body'>>): Issue | null {
    const repoIssues = this.issues.get(repoId) || [];
    const idx = repoIssues.findIndex(i => i.number === number);
    if (idx === -1) return null;
    const issue = repoIssues[idx];
    const updated = { ...issue, ...updates, updatedAt: new Date().toISOString() };
    if (updates.state === 'closed' && issue.state !== 'closed') {
      updated.closedAt = updated.updatedAt;
    }
    repoIssues[idx] = updated;
    this.issues.set(repoId, repoIssues);
    return updated;
  }

  listIssues(repoId: number, state?: string, sort?: string, direction?: string): Issue[] {
    let issues = this.getIssues(repoId);
    if (state && state !== 'all') {
      issues = issues.filter(i => i.state === state);
    }
    if (sort === 'created') {
      issues = [...issues].sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt);
        return direction === 'desc' ? -cmp : cmp;
      });
    }
    return issues;
  }

  // Label operations
  getLabels(repoId: number): Label[] {
    return this.labels.get(repoId) || [];
  }

  createLabel(repoId: number, name: string, color: string): Label {
    const repoLabels = this.labels.get(repoId) || [];
    if (repoLabels.some(l => l.name === name)) {
      throw new Error('Label already exists');
    }
    const label: Label = {
      id: this.nextLabelId++,
      repoId,
      name,
      color,
    };
    repoLabels.push(label);
    this.labels.set(repoId, repoLabels);
    return label;
  }

  // Pull Request operations
  getPullRequests(repoId: number): PullRequest[] {
    return this.pullRequests.get(repoId) || [];
  }

  createPullRequest(repoId: number, title: string, body: string, head: string, base: string): PullRequest {
    const repoPrs = this.pullRequests.get(repoId) || [];
    const counter = (this.prCounters.get(repoId) || 0) + 1;
    this.prCounters.set(repoId, counter);
    const repo = this.getRepoById(repoId);
    if (!repo) throw new Error('Repository not found');
    
    // Get head and base commit SHAs
    const headRef = this.getRef(repo.owner, repo.name, `refs/heads/${head}`);
    const baseRef = this.getRef(repo.owner, repo.name, `refs/heads/${base}`);
    if (!headRef || !baseRef) {
      throw new Error('Branch not found');
    }
    
    const now = new Date().toISOString();
    const pr: PullRequest = {
      id: this.nextPrId++,
      number: counter,
      repoId,
      title,
      body,
      state: 'open',
      head: { ref: head, sha: headRef.sha },
      base: { ref: base, sha: baseRef.sha },
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    repoPrs.push(pr);
    this.pullRequests.set(repoId, repoPrs);
    return pr;
  }

  getPullRequest(repoId: number, number: number): PullRequest | null {
    const repoPrs = this.pullRequests.get(repoId) || [];
    return repoPrs.find(p => p.number === number) || null;
  }

  mergePullRequest(repoId: number, number: number, mergeMethod: 'squash' | 'merge' | 'rebase' = 'squash'): { sha: string; message: string } | null {
    const pr = this.getPullRequest(repoId, number);
    if (!pr) return null;
    if (pr.state !== 'open') return null; // 405 conflict
    
    const repo = this.getRepoById(repoId);
    if (!repo) return null;
    
    // For squash merge, create a new commit on the base branch
    const baseRef = this.getRef(repo.owner, repo.name, `refs/heads/${pr.base.ref}`);
    if (!baseRef) return null;
    
    // Create a commit with the PR title as message
    const commitData: CommitData = {
      tree: '', // Would need to compute tree from PR changes
      parents: [baseRef.sha],
      author: `Conformance <conformance@make.fun> ${Math.floor(Date.now() / 1000)} +0000`,
      committer: `Conformance <conformance@make.fun> ${Math.floor(Date.now() / 1000)} +0000`,
      message: pr.title + '\n',
    };
    
    // For now, we'll create a simple commit. In a real implementation,
    // we'd need to compute the actual tree from the PR's changes.
    const treeEntries: TreeEntry[] = [];
    const treeSha = this.createTree(treeEntries);
    commitData.tree = treeSha;
    
    const mergeSha = this.createCommit(commitData);
    
    // Update the base branch to point to the new commit
    this.setRef(repo.owner, repo.name, `refs/heads/${pr.base.ref}`, mergeSha);
    
    // Update PR
    pr.state = 'merged';
    pr.merged = true;
    pr.mergeCommitSha = mergeSha;
    pr.mergedAt = new Date().toISOString();
    pr.updatedAt = pr.mergedAt;
    
    return { sha: mergeSha, message: 'Pull request merged' };
  }

  // Comment operations
  getComments(issueId: number): Comment[] {
    return this.comments.get(issueId) || [];
  }

  createComment(issueId: number, body: string): Comment {
    const issueComments = this.comments.get(issueId) || [];
    const now = new Date().toISOString();
    const comment: Comment = {
      id: this.nextCommentId++,
      issueId,
      body,
      createdAt: now,
      updatedAt: now,
    };
    issueComments.push(comment);
    this.comments.set(issueId, issueComments);
    return comment;
  }

  // Contents API
  getFileContent(repoId: number, path: string, ref?: string): { content: string; sha: string; size: number } | null {
    // This is a simplified implementation - in reality we'd need to traverse the git tree
    // For the conformance tests, we need to return the file that was PUT
    // This will be implemented when we integrate with git object storage
    return null;
  }

  putFileContent(repoId: number, path: string, content: string, message: string, branch?: string, sha?: string): { contentSha: string; commitSha: string } | null {
    // This will be implemented with git object storage
    return null;
  }

  deleteFileContent(repoId: number, path: string, message: string, sha: string, branch?: string): string | null {
    // This will be implemented with git object storage
    return null;
  }
}

export const storage = new Storage();