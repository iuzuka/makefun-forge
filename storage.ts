// In-memory storage for the forge

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { buildScenario, scenarioRng, SCENARIO_EPOCH_SEC } from './scenario.ts';
import type { ScenarioUser, ScenarioRepo, ScenarioBlob, ScenarioCommit, ScenarioIssue, ScenarioPull } from './scenario.ts';

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
  state: 'open' | 'closed';
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
  private nextRepoId = 20000;
  private nextIssueId = 1;
  private nextLabelId = 1;
  private nextPrId = 1;
  private nextCommentId = 1;
  private issueCounters = new Map<number, number>(); // key: repoId
  private prCounters = new Map<number, number>(); // key: repoId
  private commitCounters = new Map<number, number>(); // key: repoId

  // Seed the store from the scenario
  seedStore(): void {
    const scenario = buildScenario();
    
    // Create users (token -> user mapping)
    for (const user of scenario.users) {
      this.users.set(user.login, user);
    }
    
    // Create all repositories
    const allRepos = [...scenario.repos, ...scenario.orgRepos, ...scenario.strangerRepos];
    for (const repo of allRepos) {
      const key = `${repo.owner}/${repo.name}`;
      if (!this.repos.has(key)) {
        const now = scenario.commits[0]?.iso || new Date(SCENARIO_EPOCH_SEC * 1000).toISOString();
        const newRepo: Repository = {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          description: repo.description,
          private: repo.private,
          defaultBranch: repo.defaultBranch,
          createdAt: now,
          updatedAt: now,
        };
        this.repos.set(key, newRepo);
        this.refs.set(key, [{ name: `refs/heads/${repo.defaultBranch}`, sha: '0'.repeat(40) }]);
        this.issues.set(repo.id, []);
        this.labels.set(repo.id, []);
        this.pullRequests.set(repo.id, []);
        // comments map uses issueId as key, initialized lazily
        this.issueCounters.set(repo.id, 0);
        this.prCounters.set(repo.id, 0);
        this.commitCounters.set(repo.id, 0);
      }
    }
    
    // For each repo, build the commit history from scenario.commits
    // We need to create blobs, trees, and commits for each repo
    for (const repo of allRepos) {
      this.seedRepoCommits(repo, scenario);
    }
    
    // Seed branches (additional branches beyond default)
    const branchRng = scenarioRng("branches");
    // Note: branches are already in scenario.branches
    for (const repo of allRepos) {
      for (const branchName of scenario.branches) {
        if (branchName !== repo.defaultBranch && !branchName.startsWith('refs/')) {
          const refName = `refs/heads/${branchName}`;
          const existingRef = this.getRef(repo.owner, repo.name, refName);
          if (!existingRef) {
            // Point to the default branch tip (last commit)
            const defaultRef = this.getRef(repo.owner, repo.name, `refs/heads/${repo.defaultBranch}`);
            if (defaultRef && defaultRef.sha !== '0'.repeat(40)) {
              this.setRef(repo.owner, repo.name, refName, defaultRef.sha);
            }
          }
        }
      }
    }
    
    // Seed issues with labels/state
    for (let i = 0; i < scenario.issues.length; i++) {
      const issueTemplate = scenario.issues[i];
      // Distribute issues across viewer's repos
      const repo = scenario.repos[i % scenario.repos.length];
      const repoObj = this.getRepo(repo.owner, repo.name);
      if (repoObj) {
        // Create labels if they don't exist
        for (const labelName of issueTemplate.labels) {
          const existingLabels = this.getLabels(repoObj.id);
          if (!existingLabels.some(l => l.name === labelName)) {
            this.createLabel(repoObj.id, labelName, 'ededed');
          }
        }
        const issue = this.createIssue(repoObj.id, issueTemplate.title, issueTemplate.body, issueTemplate.labels);
        // Note: scenario issues don't have state, they're all open by default
      }
    }
    
    // Seed pull requests
    for (let i = 0; i < scenario.pulls.length; i++) {
      const pullTemplate = scenario.pulls[i];
      // Distribute pulls across viewer's repos
      const repo = scenario.repos[i % scenario.repos.length];
      const repoObj = this.getRepo(repo.owner, repo.name);
      if (repoObj) {
        // Ensure head branch exists
        const headRefName = `refs/heads/${pullTemplate.head}`;
        const headRef = this.getRef(repo.owner, repo.name, headRefName);
        if (!headRef) {
          const baseRef = this.getRef(repo.owner, repo.name, `refs/heads/${pullTemplate.base}`);
          if (baseRef) {
            this.setRef(repo.owner, repo.name, headRefName, baseRef.sha);
          }
        }
        // Create the pull request
        try {
          this.createPullRequest(repoObj.id, pullTemplate.title, pullTemplate.body, pullTemplate.head, pullTemplate.base);
        } catch {
          // Ignore if branch not found
        }
      }
    }
  }

  private seedRepoCommits(repo: ScenarioRepo, scenario: { commits: ScenarioCommit[]; blobs: ScenarioBlob[]; filePaths: string[]; users: ScenarioUser[] }): void {
    const key = `${repo.owner}/${repo.name}`;
    const refs = this.refs.get(key) || [];
    const defaultBranchRef = refs.find(r => r.name === `refs/heads/${repo.defaultBranch}`);
    if (!defaultBranchRef) return;
    
    // Create blobs from scenario
    const blobShaMap = new Map<string, string>();
    for (const blob of scenario.blobs) {
      const content = Buffer.from(blob.content, 'utf8');
      const sha = this.createBlob(content);
      blobShaMap.set(blob.path, sha);
    }
    
    // Create commits on the default branch
    let currentTreeSha = '';
    let parentSha = '0'.repeat(40);
    
    for (let i = 0; i < scenario.commits.length; i++) {
      const commitTemplate = scenario.commits[i];
      
      // Create a tree with some files (use a subset of blobs)
      const treeEntries: TreeEntry[] = [];
      const filesPerCommit = 3;
      const startIdx = (i * filesPerCommit) % scenario.blobs.length;
      for (let j = 0; j < filesPerCommit; j++) {
        const blobIdx = (startIdx + j) % scenario.blobs.length;
        const blob = scenario.blobs[blobIdx];
        const sha = blobShaMap.get(blob.path);
        if (sha) {
          treeEntries.push({ mode: '100644', name: blob.path, sha });
        }
      }
      
      const treeSha = this.createTree(treeEntries);
      currentTreeSha = treeSha;
      
      const commitData: CommitData = {
        tree: treeSha,
        parents: parentSha === '0'.repeat(40) ? [] : [parentSha],
        author: `${commitTemplate.author.name} <${commitTemplate.author.email}> ${commitTemplate.epochSec} +0000`,
        committer: `${commitTemplate.author.name} <${commitTemplate.author.email}> ${commitTemplate.epochSec} +0000`,
        message: commitTemplate.message,
      };
      
      const commitSha = this.createCommit(commitData);
      parentSha = commitSha;
      
      // Update the default branch ref to point to this commit
      this.setRef(repo.owner, repo.name, `refs/heads/${repo.defaultBranch}`, commitSha);
    }
  }

  // User management
  getUserByToken(token: string): User | null {
    // The suite's bearer token (env MAKEFUN_SHOP_TOKEN) is the viewer's; any other token names
    // a different login, so viewer-owned resources read as 404 for it (repos.foreign-token).
    const envToken = process.env.MAKEFUN_SHOP_TOKEN;
    if (envToken && token === envToken) return this.users.get('adaiversen') ?? null;
    if (this.users.has(token)) return this.users.get(token)!;
    const other: User = { id: 9000 + (token.length % 7), login: `foreign-${token.slice(0, 6)}`, name: 'Foreign', email: 'foreign@example.invalid' };
    this.users.set(token, other);
    return other;
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

  mergePullRequest(repoId: number, number: number, mergeMethod: 'squash' | 'merge' | 'rebase' = 'squash'): { sha: string; message: string } | { conflict: true } | null {
    const pr = this.getPullRequest(repoId, number);
    if (!pr) return null;
    if (pr.state !== 'open') return { conflict: true }; // 405 conflict
    
    const repo = this.getRepoById(repoId);
    if (!repo) return null;
    
    // Get head and base commit SHAs
    const headRef = this.getRef(repo.owner, repo.name, `refs/heads/${pr.head.ref}`);
    const baseRef = this.getRef(repo.owner, repo.name, `refs/heads/${pr.base.ref}`);
    if (!headRef || !baseRef) return null;
    
    // Check if head is already merged into base (fast-forward check)
    // For conflict detection, we need to see if the base has commits that head doesn't have
    // and if head has changes that conflict with base
    const headCommitSha = headRef.sha;
    const baseCommitSha = baseRef.sha;
    
    // Get commit objects
    const headCommitObj = this.getObject(headCommitSha);
    const baseCommitObj = this.getObject(baseCommitSha);
    if (!headCommitObj || !baseCommitObj) return null;
    
    const headCommit = this.parseCommit(headCommitObj.data);
    const baseCommit = this.parseCommit(baseCommitObj.data);
    
    // Check if base is ancestor of head (no conflict, can fast-forward)
    // For simplicity, we'll check if the trees are different
    const headTreeSha = headCommit.tree;
    const baseTreeSha = baseCommit.tree;
    
    // If trees are the same, no changes to merge
    if (headTreeSha === baseTreeSha) {
      // Already up to date
      pr.state = 'closed';
      pr.merged = true;
      pr.mergeCommitSha = baseCommitSha;
      pr.mergedAt = new Date().toISOString();
      pr.updatedAt = pr.mergedAt;
      return { sha: baseCommitSha, message: 'Pull request merged (already up to date)' };
    }
    
    // For conflict detection, we need to check if there are conflicting changes
    // We'll do a simple check: if base has commits not in head's history that modify the same files
    // For now, we'll check if the merge base (common ancestor) has the same tree as base
    // If not, there might be conflicts
    
    // Find merge base (simplified: just use base's parent if head's parent includes base)
    // For proper implementation, we'd need full ancestry walk
    
    // Check if base is ancestor of head
    const isBaseAncestorOfHead = this.isAncestor(baseCommitSha, headCommitSha);
    
    if (!isBaseAncestorOfHead) {
      // Base has commits that head doesn't have - potential conflict
      // Check if there are conflicting file changes
      const headFiles = this.getFilesInTree(headTreeSha);
      const baseFiles = this.getFilesInTree(baseTreeSha);
      
      // Check for conflicts: files modified in both branches since merge base
      // Simplified: if any file exists in both with different content, it's a conflict
      for (const [path, headSha] of headFiles) {
        const baseSha = baseFiles.get(path);
        if (baseSha && baseSha !== headSha) {
          // File modified in both - check if they have a common ancestor
          // For simplicity, we'll consider this a conflict if base is not ancestor of head
          return { conflict: true };
        }
      }
    }
    
    // Perform squash merge: create a new commit on base branch with head's tree
    // The squash commit should have the combined changes
    const newTreeSha = headTreeSha; // For squash, we take the head's tree as-is
    
    const commitData: CommitData = {
      tree: newTreeSha,
      parents: [baseCommitSha],
      author: `Conformance <conformance@make.fun> ${Math.floor(Date.now() / 1000)} +0000`,
      committer: `Conformance <conformance@make.fun> ${Math.floor(Date.now() / 1000)} +0000`,
      message: pr.title + '\n',
    };
    
    const mergeSha = this.createCommit(commitData);
    
    // Update the base branch to point to the new commit
    this.setRef(repo.owner, repo.name, `refs/heads/${pr.base.ref}`, mergeSha);
    
    // Update PR
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = mergeSha;
    pr.mergedAt = new Date().toISOString();
    pr.updatedAt = pr.mergedAt;
    
    return { sha: mergeSha, message: 'Pull request merged' };
  }
  
  // Helper: check if commit A is ancestor of commit B
  private isAncestor(ancestorSha: string, descendantSha: string): boolean {
    if (ancestorSha === descendantSha) return true;
    
    const visited = new Set<string>();
    const queue = [descendantSha];
    
    while (queue.length > 0) {
      const currentSha = queue.shift()!;
      if (visited.has(currentSha)) continue;
      visited.add(currentSha);
      
      if (currentSha === ancestorSha) return true;
      
      const commitObj = this.getObject(currentSha);
      if (!commitObj || commitObj.type !== 'commit') continue;
      
      const commit = this.parseCommit(commitObj.data);
      for (const parent of commit.parents) {
        if (!visited.has(parent)) queue.push(parent);
      }
    }
    
    return false;
  }
  
  // Helper: get all files in a tree (path -> blob sha)
  private getFilesInTree(treeSha: string): Map<string, string> {
    const files = new Map<string, string>();
    
    const collect = (currentTreeSha: string, prefix: string) => {
      const entries = this.getTreeEntries(currentTreeSha);
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') {
          collect(entry.sha, path);
        } else {
          files.set(path, entry.sha);
        }
      }
    };
    
    collect(treeSha, '');
    return files;
  }
  
  // Helper: compute diff between two trees (for PR files list)
  getDiffBetweenTrees(baseTreeSha: string, headTreeSha: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseFiles = this.getFilesInTree(baseTreeSha);
    const headFiles = this.getFilesInTree(headTreeSha);
    
    const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const diff: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    
    for (const path of allPaths) {
      const baseSha = baseFiles.get(path);
      const headSha = headFiles.get(path);
      
      if (!baseSha && headSha) {
        // Added
        diff.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
      } else if (baseSha && !headSha) {
        // Deleted
        diff.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
      } else if (baseSha !== headSha) {
        // Modified
        diff.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
      }
      // If same, no change
    }
    
    return diff;
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

  // Helper: get tree entries from a commit SHA
  private getTreeEntries(treeSha: string): TreeEntry[] {
    const treeObj = this.getObject(treeSha);
    if (!treeObj || treeObj.type !== 'tree') return [];
    return this.parseTree(treeObj.data);
  }

  // Helper: find file in tree recursively
  private findFileInTree(treeSha: string, path: string): { entry: TreeEntry; treeSha: string } | null {
    const parts = path.split('/');
    let currentTreeSha = treeSha;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const entries = this.getTreeEntries(currentTreeSha);
      const entry = entries.find(e => e.name === part);
      if (!entry) return null;
      
      if (i === parts.length - 1) {
        // This is the file we're looking for
        if (entry.mode === '40000') return null; // It's a directory
        return { entry, treeSha: currentTreeSha };
      } else {
        // Navigate into subdirectory
        if (entry.mode !== '40000') return null; // Not a directory
        currentTreeSha = entry.sha;
      }
    }
    return null;
  }

  // Helper: get commit SHA for a ref (branch)
  private getCommitShaForRef(owner: string, repo: string, ref: string): string | null {
    const refObj = this.getRef(owner, repo, `refs/heads/${ref}`);
    if (refObj) return refObj.sha;
    // Try tag refs
    const tagRef = this.getRef(owner, repo, `refs/tags/${ref}`);
    if (tagRef) {
      const tagObj = this.getObject(tagRef.sha);
      if (tagObj && tagObj.type === 'tag') {
        const text = tagObj.data.toString('utf8');
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('object ')) {
            const objSha = line.slice(7);
            const obj = this.getObject(objSha);
            if (obj && obj.type === 'commit') return objSha;
          }
        }
      }
    }
    return null;
  }

  // Helper: build tree from current tree with a file added/updated/deleted
  private buildTreeWithChange(baseTreeSha: string, path: string, blobSha: string | null, mode: string = '100644'): string {
    const parts = path.split('/');
    
    // Recursive function to build tree from bottom up
    const buildTreeRecursive = (treeSha: string, depth: number): string => {
      const entries = this.getTreeEntries(treeSha);
      const part = parts[depth];
      
      if (depth === parts.length - 1) {
        // This is the level where we make the change
        const newEntries = entries.filter(e => e.name !== part);
        if (blobSha !== null) {
          newEntries.push({ mode, name: part, sha: blobSha });
        }
        return this.createTree(newEntries);
      } else {
        // Navigate into subdirectory
        const subdirEntry = entries.find(e => e.name === part && e.mode === '40000');
        if (!subdirEntry) {
          // Create new subdirectory tree
          const newSubtreeSha = this.createTree([]);
          const newEntries = [...entries.filter(e => e.name !== part), { mode: '40000', name: part, sha: newSubtreeSha }];
          return this.buildTreeWithChangeRecursive(newEntries, depth + 1);
        }
        const newSubtreeSha = this.buildTreeWithChange(subdirEntry.sha, path, blobSha, mode);
        const newEntries = entries.map(e => e.name === part ? { ...e, sha: newSubtreeSha } : e);
        return this.createTree(newEntries);
      }
    };
    
    // Helper for creating new subdirectories
    const buildTreeRecursiveNew = (entries: TreeEntry[], depth: number): string => {
      if (depth === parts.length - 1) {
        const newEntries = [...entries];
        if (blobSha !== null) {
          newEntries.push({ mode, name: parts[depth], sha: blobSha });
        }
        return this.createTree(newEntries);
      } else {
        const newSubtreeSha = this.createTree([]);
        const newEntries = [...entries, { mode: '40000', name: parts[depth], sha: newSubtreeSha }];
        return buildTreeRecursiveNew(newEntries, depth + 1);
      }
    };
    
    // Actually we need a simpler approach - let's build from root
    return this.buildTreeFromRoot(baseTreeSha, path, blobSha, mode);
  }

  private buildTreeFromRoot(baseTreeSha: string, path: string, blobSha: string | null, mode: string = '100644'): string {
    const parts = path.split('/');
    
    // Get all entries from base tree
    const baseEntries = this.getTreeEntries(baseTreeSha);
    
    // We'll build a map of path -> (mode, sha) for all files in the tree
    const fileMap = new Map<string, { mode: string; sha: string }>();
    
    // Recursively collect all files
    const collectFiles = (treeSha: string, prefix: string) => {
      const entries = this.getTreeEntries(treeSha);
      for (const entry of entries) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') {
          collectFiles(entry.sha, fullPath);
        } else {
          fileMap.set(fullPath, { mode: entry.mode, sha: entry.sha });
        }
      }
    };
    
    collectFiles(baseTreeSha, '');
    
    // Apply the change
    if (blobSha !== null) {
      fileMap.set(path, { mode, sha: blobSha });
    } else {
      fileMap.delete(path);
    }
    
    // Now rebuild the tree from the file map
    return this.buildTreeFromFileMap(fileMap);
  }
  
  private buildTreeFromFileMap(fileMap: Map<string, { mode: string; sha: string }>): string {
    // Group files by directory
    const dirMap = new Map<string, TreeEntry[]>();
    
    for (const [path, { mode, sha }] of fileMap) {
      const parts = path.split('/');
      const dirPath = parts.slice(0, -1).join('/');
      const fileName = parts[parts.length - 1];
      
      if (!dirMap.has(dirPath)) {
        dirMap.set(dirPath, []);
      }
      dirMap.get(dirPath)!.push({ mode, name: fileName, sha });
    }
    
    // Build trees bottom-up
    const treeCache = new Map<string, string>();
    
    // Sort directories by depth (deepest first)
    const sortedDirs = Array.from(dirMap.keys()).sort((a, b) => {
      const aDepth = a ? a.split('/').length : 0;
      const bDepth = b ? b.split('/').length : 0;
      return bDepth - aDepth;
    });
    
    for (const dirPath of sortedDirs) {
      const entries = dirMap.get(dirPath)!;
      const treeSha = this.createTree(entries);
      treeCache.set(dirPath, treeSha);
      
      // Add this tree to parent directory
      if (dirPath) {
        const parts = dirPath.split('/');
        const parentPath = parts.slice(0, -1).join('/');
        const dirName = parts[parts.length - 1];
        
        if (!dirMap.has(parentPath)) {
          dirMap.set(parentPath, []);
        }
        dirMap.get(parentPath)!.push({ mode: '40000', name: dirName, sha: treeSha });
      }
    }
    
    // Root tree
    const rootEntries = dirMap.get('') || [];
    return this.createTree(rootEntries);
  }

  // Helper: get commit tree SHA
  private getCommitTreeSha(commitSha: string): string | null {
    const commitObj = this.getObject(commitSha);
    if (!commitObj || commitObj.type !== 'commit') return null;
    const commit = this.parseCommit(commitObj.data);
    return commit.tree;
  }

  // Contents API
  getFileContent(repoId: number, path: string, ref?: string): { content: string; sha: string; size: number } | null {
    const repo = this.getRepoById(repoId);
    if (!repo) return null;
    
    const refName = ref || repo.defaultBranch;
    const commitSha = this.getCommitShaForRef(repo.owner, repo.name, refName);
    if (!commitSha) return null;
    
    const treeSha = this.getCommitTreeSha(commitSha);
    if (!treeSha) return null;
    
    const result = this.findFileInTree(treeSha, path);
    if (!result) return null;
    
    const blobObj = this.getObject(result.entry.sha);
    if (!blobObj || blobObj.type !== 'blob') return null;
    
    const content = blobObj.data.toString('utf8');
    return {
      content,
      sha: result.entry.sha,
      size: blobObj.data.length,
    };
  }

  getDirectoryContent(repoId: number, path: string, ref?: string): ContentEntry[] | null {
    const repo = this.getRepoById(repoId);
    if (!repo) return null;
    
    const refName = ref || repo.defaultBranch;
    const commitSha = this.getCommitShaForRef(repo.owner, repo.name, refName);
    if (!commitSha) return null;
    
    const treeSha = this.getCommitTreeSha(commitSha);
    if (!treeSha) return null;
    
    let targetTreeSha = treeSha;
    if (path) {
      // Walk to the directory entry itself (findFileInTree rejects directories).
      const parts = path.split('/');
      let current = treeSha;
      for (const part of parts) {
        const entries = this.getTreeEntries(current);
        const entry = entries.find((e) => e.name === part);
        if (!entry || entry.mode !== '40000') return null;
        current = entry.sha;
      }
      targetTreeSha = current;
    }
    
    const entries = this.getTreeEntries(targetTreeSha);
    return entries.map(entry => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: path ? `${path}/${entry.name}` : entry.name,
      sha: entry.sha,
      size: entry.mode === '40000' ? undefined : (this.getObject(entry.sha)?.data.length ?? 0),
    }));
  }

  putFileContent(repoId: number, path: string, content: string, message: string, branch?: string, sha?: string): { contentSha: string; commitSha: string } | null {
    const repo = this.getRepoById(repoId);
    if (!repo) return null;
    
    const refName = branch || repo.defaultBranch;
    const ZERO = '0'.repeat(40);
    let commitSha = this.getCommitShaForRef(repo.owner, repo.name, refName);
    if (!commitSha && branch) {
      // Writing to a branch that does not exist yet: fork from the default branch.
      const baseSha = this.getCommitShaForRef(repo.owner, repo.name, repo.defaultBranch);
      if (baseSha && baseSha !== ZERO) {
        this.setRef(repo.owner, repo.name, `refs/heads/${refName}`, baseSha);
        commitSha = baseSha;
      }
    }
    if (!commitSha || commitSha === ZERO) {
      // Unborn branch: seed a root commit off an empty tree (GitHub creates the first commit on PUT).
      const rootTreeSha = this.createTree([]);
      const now = Math.floor(Date.now() / 1000);
      const rootSha = this.createCommit({
        tree: rootTreeSha,
        parents: [],
        author: `Conformance <conformance@make.fun> ${now} +0000`,
        committer: `Conformance <conformance@make.fun> ${now} +0000`,
        message: 'Initial commit\n',
      });
      this.setRef(repo.owner, repo.name, `refs/heads/${refName}`, rootSha);
      commitSha = rootSha;
    }
    if (!commitSha) return null;
    
    // If sha provided, verify it matches current file content
    if (sha) {
      const current = this.getFileContent(repoId, path, refName);
      if (!current || current.sha !== sha) {
        // Stale SHA - 409 conflict
        throw new Error('SHA_CONFLICT');
      }
    }
    
    // Create blob
    const blobData = Buffer.from(content, 'utf8');
    const blobSha = this.createBlob(blobData);
    
    // Get base tree
    const baseTreeSha = this.getCommitTreeSha(commitSha);
    if (!baseTreeSha) return null;
    
    // Create new tree with the file added/updated
    const newTreeSha = this.buildTreeFromRoot(baseTreeSha, path, blobSha, '100644');
    
    // Create commit
    const commitData: CommitData = {
      tree: newTreeSha,
      parents: [commitSha],
      author: `Conformance <conformance@make.fun> ${Math.floor(Date.now() / 1000)} +0000`,
      committer: `Conformance <conformance@make.fun> ${Math.floor(Date.now() / 1000)} +0000`,
      message: message + '\n',
    };
    
    const newCommitSha = this.createCommit(commitData);
    
    // Update the branch ref
    this.setRef(repo.owner, repo.name, `refs/heads/${refName}`, newCommitSha);
    
    return { contentSha: blobSha, commitSha: newCommitSha };
  }

  deleteFileContent(repoId: number, path: string, message: string, sha: string, branch?: string): string | null {
    const repo = this.getRepoById(repoId);
    if (!repo) return null;
    
    const refName = branch || repo.defaultBranch;
    const ZERO = '0'.repeat(40);
    let commitSha = this.getCommitShaForRef(repo.owner, repo.name, refName);
    if (!commitSha && branch) {
      // Writing to a branch that does not exist yet: fork from the default branch.
      const baseSha = this.getCommitShaForRef(repo.owner, repo.name, repo.defaultBranch);
      if (baseSha && baseSha !== ZERO) {
        this.setRef(repo.owner, repo.name, `refs/heads/${refName}`, baseSha);
        commitSha = baseSha;
      }
    }
    if (!commitSha || commitSha === ZERO) {
      // Unborn branch: seed a root commit off an empty tree (GitHub creates the first commit on PUT).
      const rootTreeSha = this.createTree([]);
      const now = Math.floor(Date.now() / 1000);
      const rootSha = this.createCommit({
        tree: rootTreeSha,
        parents: [],
        author: `Conformance <conformance@make.fun> ${now} +0000`,
        committer: `Conformance <conformance@make.fun> ${now} +0000`,
        message: 'Initial commit\n',
      });
      this.setRef(repo.owner, repo.name, `refs/heads/${refName}`, rootSha);
      commitSha = rootSha;
    }
    if (!commitSha) return null;
    
    // Verify SHA matches
    const current = this.getFileContent(repoId, path, refName);
    if (!current || current.sha !== sha) {
      throw new Error('SHA_CONFLICT');
    }
    
    // Get base tree
    const baseTreeSha = this.getCommitTreeSha(commitSha);
    if (!baseTreeSha) return null;
    
    // Create new tree with the file removed
    const newTreeSha = this.buildTreeFromRoot(baseTreeSha, path, null);
    
    // Create commit
    const commitData: CommitData = {
      tree: newTreeSha,
      parents: [commitSha],
      author: `Conformance <conformance@make.fun> ${Math.floor(Date.now() / 1000)} +0000`,
      committer: `Conformance <conformance@make.fun> ${Math.floor(Date.now() / 1000)} +0000`,
      message: message + '\n',
    };
    
    const newCommitSha = this.createCommit(commitData);
    
    // Update the branch ref
    this.setRef(repo.owner, repo.name, `refs/heads/${refName}`, newCommitSha);
    
    return newCommitSha;
  }
}

export const storage = new Storage();