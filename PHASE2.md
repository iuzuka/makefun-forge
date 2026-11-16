# Phase 2 integration brief (github-core-clone-01)

The repository already contains `scenario.ts`: an exact deterministic port of the grader suite's
seeded scenario (source of truth: /workspace/makefun/github-core-clone-01-kit/program/env/server.mjs,
lines 305-930). `buildScenario()` returns { seed, viewer, teammate, stranger, users, org, repos,
orgRepos, strangerRepos, labels, branches, filePaths, blobs, commits, issues, pulls }.

Verified values: viewer.login = adaiversen, stranger.login = olgabauer, org = faint-meadow-org,
repos[0] = amber-thistle (id 5000), 30 viewer repos, 24 blobs, 60 commits, 60 issues, 30 pulls.

Tasks for the agent sessions (grow app.ts / rest.ts / git.ts / storage.ts, add modules freely):

1. **Seed the store from the scenario.** On startup, populate the in-memory store with the
   scenario's repos (viewer/org/stranger), each seeded with its blobs, a commit history of the
   scenario's 60 commits on the default branch, branches from scenario.branches, issues with
   labels/body/state from scenario.issues, pulls from scenario.pulls (head/base branches, body).
   Repos must belong to the login the bearer token names: the suite's token (env
   MAKEFUN_SHOP_TOKEN) IS the viewer's token (adaiversen); treat that token as authenticated.
   A request with no token or a different token: 401 on API routes; the suite's `foreign-token`
   check uses another token naming a different login — repositories of other logins are 404
   for it (stranger repos belong to olgabauer).
2. **REST v3 correctness.** All checks in /workspace/makefun/github-core-clone-01-kit/RULES.txt
   wire contract + the suite sources copied to ./spec/conformance/. Implement what the failing
   checks need: issues list/sort/patch/comments, labels, pulls create/get/list/merge (squash
   onto default branch, conflict = 405, files list from the head-vs-base diff using the git
   store), contents create/update/delete with sha conflicts, repo patch/delete, pagination with
   Link rel="next" headers, repos.branches / repos.commits endpoints.
3. **GraphQL /api/graphql** per rules: introspection (__type Issue/PullRequest/Repository,
   SearchType enumValues ISSUE), repository.issues orderBy CREATED_AT DESC, states:[OPEN] filter,
   createPullRequest, two operations per body answered in order, unknown field => 200 + errors,
   unknown repository => data.repository null with no errors, viewer login = adaiversen.
4. **MCP /mcp** per rules: JSON-RPC 2.0 streamable HTTP, revision 2026-07-28, server/discover,
   initialize + notifications/initialized, tools/list (≥6 tools: create_repo, get_repo,
   create_issue, list_issues, create_pull_request, merge_pull_request; same store as REST),
   tools/call argument mapping (full_name property filled with owner/repo), concurrent ids,
   -32602/-32601 unknown/missing, 401 without Authorization, 400 + -32700 for non-JSON.
5. **Git smart HTTP correctness.** The suite's git-client.ts shows the exact client behavior:
   v2 ls-refs/fetch (with want/have, shallow depth-1, deepen), v0 advertisement with
   side-band-64k + report-status + delete-refs on receive-pack, fast-forward refusal lines
   "ng <ref> non-fast-forward", mixed push partial application, packfile generation
   (undeltified is fine) and pack reading. All git.* checks must pass.

Verify with: cd /workspace/makefun/github-core-clone-01-kit && node cli/makefun.mjs grade-local
--kit . --bot /workspace/makefun/forge --driver process (commit first: git add -A && git commit).
Current score: 48 (feature 35/600, agent 13/200, perf 0). Target: >700.

Rules for the sessions: stdlib only, no npm installs, no git binary, node --experimental-strip-types.
Files must stay authored by the sessions (edit in place, do not rewrite wholesale).
