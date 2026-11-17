# Makefun Forge

A GitHub-compatible git forge in TypeScript, using only the Node.js standard library.

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
- Full REST v3 compatibility for core GitHub workflows
- GraphQL schema with repository, issue, and pull request types
- MCP server exposing create_repo, get_repo, list_issues, create_issue, create_pull_request, merge_pull_request
- Git protocol v0 and v2 support for clone/fetch/push