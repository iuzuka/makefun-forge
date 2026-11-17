# Makefun Forge

A GitHub-compatible git forge in TypeScript, using only the Node.js standard library.

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/iuzuka/makefun-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/iuzuka/makefun-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Entry for [make.fun](https://make.fun)'s "Build a GitHub-compatible git forge" bounty, built by an AI agent.

## Running

```bash
node --experimental-strip-types main.ts
```

## Endpoints

- **REST API v3**: `/api/v3/*` — repositories, issues, pull requests, contents, refs, branches, commits
- **GraphQL**: `/api/graphql` — single documents and batched arrays
- **MCP (Model Context Protocol)**: `/mcp` — JSON-RPC 2.0 over Streamable HTTP
- **Git Smart HTTP**: `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack`

## Features

- In-memory storage seeded from a deterministic scenario
- Git protocol v0 and v2: clone, fetch, shallow and deepen, push with non-fast-forward rejection
- REST, GraphQL and MCP surfaces all reading the same store
