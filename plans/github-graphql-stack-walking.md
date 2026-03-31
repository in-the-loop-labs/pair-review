# Replace Graphite-local stack resolution with GitHub GraphQL chain-walking

## Context

Stack detection currently relies on two local data sources: `gt state` (Graphite CLI) and `.graphite_pr_info` (a file in the git dir). Both only work on the PR author's machine. Reviewers who aren't the author see no stack at all.

Since Graphite stacks encode structure in GitHub's own PR metadata (each PR's `baseRefName` is the previous PR's `headRefName`), we can reconstruct any stack by walking the branch chain via GitHub's GraphQL API — no local Graphite data needed.

**Outcome**: Any reviewer can see the full PR stack, regardless of whether they use Graphite or authored the PRs.

## Approach

### New module: `src/github/stack-walker.js`

A `walkPRStack(client, owner, repo, prNumber)` function that:

1. Fetches the starting PR via GraphQL to get `baseRefName`, `headRefName`, `title`, `number`, `state`
2. **Walks UP** (toward trunk): queries `pullRequests(headRefName: <current.baseRefName>, states: [OPEN, MERGED], first: 5)` repeatedly until `baseRefName` is the default branch or no parent PR found
3. **Walks DOWN** (toward tip): queries `pullRequests(baseRefName: <current.headRefName>, states: [OPEN], first: 5)` repeatedly until no children found
4. Returns ordered array from trunk → tip:
   ```js
   [
     { branch: 'main', isTrunk: true },
     { branch: 'feat-base', isTrunk: false, prNumber: 101, title: '...', state: 'MERGED' },
     { branch: 'feat-child', isTrunk: false, prNumber: 102, title: '...', state: 'OPEN' },
   ]
   ```

GraphQL query per step (server-side filtered, O(1) per query):
```graphql
query($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $branch, states: [OPEN, MERGED], first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title baseRefName headRefName state url }
    }
  }
}
```

Edge cases:
- **Cycles**: track visited branches in a Set
- **Multiple PRs for same branch**: prefer OPEN over MERGED, then most recently updated
- **Max depth**: cap at 20 iterations
- **Errors mid-walk**: return partial stack with what we have

### PR mode routes: replace 3 code paths

**All** three PR mode stack resolution paths in `src/routes/pr.js` become:
```js
const ghClient = new GitHubClient(githubToken);
const stackData = await walkPRStack(ghClient, owner, repo, prNumber);
```

No `enable_graphite` gate needed — this uses GitHub API, works for any stacked-PR workflow.

| Code path | Lines | Current approach | New approach |
|-----------|-------|-----------------|-------------|
| GET `/api/pr/:owner/:repo/:number` Block 1 | 298-314 | tryGraphiteState → readGraphitePRInfo → enrichStackWithPRInfo → enrichStackWithTitles | Remove entirely (Block 2 overwrites it anyway) |
| GET `/api/pr/:owner/:repo/:number` Block 2 | 355-387 | getRawGraphiteState → buildStackWithPRNumbers → readGraphitePRInfo → enrichStackWithTitles | `walkPRStack(ghClient, owner, repo, prNumber)` |
| POST `.../refresh` | 543-558 | tryGraphiteState → readGraphitePRInfo → enrichStackWithPRInfo → enrichStackWithTitles | `walkPRStack(ghClient, owner, repo, prNumber)` |
| GET `.../stack-info` | 2334-2462 | getRawGraphiteState → buildStackWithPRNumbers → readGraphitePRInfo → per-entry title fetch | `walkPRStack(ghClient, owner, repo, prNumber)` + per-entry hasAnalysis/hasOwnWorktree enrichment (keep) |

The `stack-info` endpoint also:
- Removes `enable_graphite` guard (line 2347)
- Removes worktree requirement (lines 2362-2365) — GraphQL doesn't need a local checkout
- Removes per-entry title fetch (lines 2416-2433) — titles come from the walk
- Keeps hasAnalysis/hasOwnWorktree enrichment (lines 2435-2452)

### Delete `enrichStackWithTitles` (pr.js lines 168-209)

No longer needed — titles come from GraphQL walk.

### Local mode: swap `.graphite_pr_info` for DB lookup

`src/routes/local.js` line ~633: replace `readGraphitePRInfo` + `enrichStackWithPRInfo` with a DB query against `pr_metadata` to get PR numbers by branch name. Keep `tryGraphiteState` for branch ancestry.

### Clean up `src/git/base-branch.js`

Remove functions no longer called by any code path:
- `readGraphitePRInfo` — replaced by DB queries (local) and GraphQL (PR mode)
- `enrichStackWithPRInfo` — replaced by inline DB lookup (local)
- `getRawGraphiteState` — PR mode uses GraphQL; local mode uses `tryGraphiteState`
- `buildStackWithPRNumbers` — PR mode uses GraphQL walker

Keep: `detectBaseBranch`, `tryGraphiteState`, `buildStack`, `getDefaultBranch`

## Files to change

| File | Action | Summary |
|------|--------|---------|
| `src/github/stack-walker.js` | **NEW** | `walkPRStack` — GraphQL chain-walking algorithm |
| `src/routes/pr.js` | Modify | Replace 3 stack blocks + delete `enrichStackWithTitles` + remove `enable_graphite` gate from stack-info |
| `src/routes/local.js` | Modify | Swap `.graphite_pr_info` enrichment for DB-based PR number lookup |
| `src/git/base-branch.js` | Modify | Remove 4 dead functions, update exports |
| `tests/unit/stack-walker.test.js` | **NEW** | Tests for `walkPRStack` |
| `tests/unit/base-branch.test.js` | Modify | Remove `readGraphitePRInfo` / `enrichStackWithPRInfo` test suites |
| `tests/integration/stack-analysis.test.js` | Modify | Update stack-info tests, remove `enable_graphite` gate tests |
| `tests/integration/routes.test.js` | Modify | Update stack_data expectations |

## Implementation order

1. Create `src/github/stack-walker.js` + unit tests (purely additive)
2. Replace PR mode routes to use `walkPRStack`
3. Update local mode to use DB-based enrichment
4. Remove dead code from `base-branch.js`
5. Update all test files
6. Verify no remaining `.graphite_pr_info` references in PR mode

## Hazards

- **`enrichStackWithTitles` has 3 callers** (GET Block 1, Block 2, refresh). All must be removed together since the function is being deleted.
- **`readGraphitePRInfo` is imported in both `pr.js` AND `local.js`**. Must update both import statements.
- **`stack-info` endpoint currently requires `enable_graphite` + worktree**. Removing both gates means it becomes available to all users without a local checkout — verify the endpoint handles missing worktree gracefully for the `hasOwnWorktree` check.
- **Frontend `_getStackPRs(pr)` filters on `!entry.isTrunk && entry.prNumber`**. The new walker guarantees every non-trunk entry has a `prNumber` (since each entry IS a PR), so this filter remains correct.
- **The `stack-info` enrichment loop creates new `GitHubClient` instances per entry for title fetches (lines 2422-2433)**. This becomes unnecessary — remove it, since `walkPRStack` already provides titles.
- **`POST .../analyses/stack` endpoint** receives `prNumbers` from the frontend, doesn't resolve the stack itself — no changes needed.

## Verification

1. Run `npm test` — all unit/integration tests pass
2. Open a PR that's part of a Graphite stack → stack nav dropdown shows full stack with titles
3. Open the same PR from a repo clone with no Graphite installed → same result
4. Click "Analyze Stack" → dialog shows correct PR list from stack-info endpoint
5. Open a non-stacked PR → no stack nav appears (single-PR result filtered out)
6. Run `npm run test:e2e` — E2E tests pass
