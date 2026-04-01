# Plan: Parallel Per-PR Worktree Stack Analysis

## Context

The current stack analysis uses a single shared worktree, checking out each PR's branch serially. This creates a cascade of complexity: worktree locking, HEAD snapshot/restore, DB record snapshot/restore, TOCTOU races, and O(n × analysis_time) wall clock. A 5-PR stack takes ~2.5 hours serially.

The redesign creates a per-PR worktree for each stack member and runs all analyses in parallel, reducing wall time to O(analysis_time) and eliminating the entire class of shared-worktree bugs.

## Implementation

### Task 1: Rewrite `executeStackAnalysis` in `src/routes/stack-analysis.js`

**Delete:**
- Worktree lock acquire/release (`worktreeLock.acquire`, `worktreeLock.release`)
- `originalHead` / `originalBranch` snapshot (lines 201-229)
- `originalWorktreeRecords` snapshot + restore (lines 204-237, 389-400)
- Entire finally block restore logic (lines 372-404) — replace with simple completion broadcast
- `checkoutBranch` call (line 277)
- `import` of `worktreeLock` from `../git/worktree-lock`
- `state.currentPRNumber` and `state.currentPRIndex` mutations

**New flow (replacing lines 189-409):**

1. Resolve state, merge `_deps`
2. Resolve `repositoryPath` from `triggerWorktreePath` via `worktreeManager.resolveOwningRepo()`
3. Bulk fetch all PR refs (keep existing logic, runs against trigger worktree)
4. **Fetch all PR data from GitHub in parallel** — `Promise.all` over `githubClient.fetchPullRequest()`. Store in `Map<prNum, prData>`. This is needed before worktree creation because `createWorktreeForPR` requires `prData` (for SHAs).
5. **Create per-PR worktrees serially** — `createWorktreeForPR(prInfo, prData, repositoryPath)` for each PR. Serial because `git worktree add` locks `.git/worktrees`. Track in `Map<prNum, worktreePath>`. On failure: mark PR failed, skip it.
6. **Extract a helper `analyzeStackPR()`** containing the per-PR logic currently at lines 280-350 (setup, metadata fetch, config resolution, launcher dispatch). Each call receives its own `worktreePath`.
7. **Launch all analyses in parallel** — `Promise.allSettled` over `analyzeStackPR()` for each PR with a worktree. Update `state.prStatuses` and broadcast on each completion/failure.
8. Set final status, broadcast completion. No restore needed.

**New `defaults` additions:**
- No new deps needed. `GitWorktreeManager` already has `createWorktreeForPR` and `resolveOwningRepo`.

**Rename in params:** `worktreePath` → `triggerWorktreePath` (clarity — it's the trigger PR's worktree, not the shared analysis worktree).

### Task 2: Extract `analyzeStackPR` helper

New async function in `stack-analysis.js`:

```js
async function analyzeStackPR(deps, db, config, {
  owner, repo, repository, prNum, worktreePath,
  analysisConfig, stackAnalysisId, state, githubToken
})
```

Contains the per-PR body: `setupStackPR` → fetch metadata from DB → resolve config → dispatch to launcher. Returns `{ status, analysisId, suggestionsCount, error }`.

The three launcher functions (`launchStackSingleAnalysis`, `launchStackCouncilAnalysis`, `launchStackExecutableAnalysis`) remain unchanged — they already receive `worktreePath` as a parameter.

### Task 3: Update `broadcastStackProgress` (same file)

Remove `currentPRNumber` and `currentPRIndex` from payload. Add derived `runningCount` and `completedCount`. Keep deprecated fields as `null` for frontend compat during transition.

### Task 4: Update POST endpoint (same file, line 731)

- Remove worktree lock check (lines 770-776)
- Remove `currentPRNumber`, `currentPRIndex`, `originalBranch` from initial state
- Rename `worktreePath` → `triggerWorktreePath` in state
- Pass `triggerWorktreePath` to `executeStackAnalysis`

### Task 5: Update GET endpoint (same file, line 827)

- Set `currentPRNumber` and `currentPRIndex` to `null` in response (deprecated)

### Task 6: Update cancel endpoint (same file, line 856)

Replace single-PR kill with loop over all running PRs:

```js
for (const [prNum, prStatus] of state.prStatuses) {
  if (prStatus.status === 'running' && prStatus.analysisId) {
    killProcesses(prStatus.analysisId);
  }
}
```

### Task 7: Update `setupStackPR` in `src/setup/stack-setup.js`

Add optional `prData` parameter. When provided, skip the GitHub fetch (lines 37-38). When absent, fetch as before (backward compat). Update JSDoc to reflect per-PR worktree and optional pre-fetched data.

```js
async function setupStackPR({ db, owner, repo, prNumber, githubToken, worktreePath, worktreeManager, prData: prefetchedPRData }) {
  // Use pre-fetched data or fetch from GitHub
  const prData = prefetchedPRData || await new GitHubClient(githubToken).fetchPullRequest(owner, repo, prNumber);
  // ... rest unchanged
}
```

The `analyzeStackPR` helper passes the pre-fetched `prData` through, avoiding a redundant GitHub API call per PR.

### Task 8: Update `StackProgressModal` in `public/js/components/StackProgressModal.js`

- Replace `_subscribeToCurrentPR(currentPRNumber)` with `_subscribeToRunningPRs(prStatuses)` that tracks multiple WS subscriptions in a `Map<analysisId, unsubFn>`
- `_handleStackProgress` calls `_subscribeToRunningPRs(msg.prStatuses)` instead
- `_stopMonitoring` unsubscribes all entries in the map
- Replace `this._wsAnalysisUnsub` (single) with `this._wsAnalysisUnsubs = new Map()`

### Task 9: Rewrite tests in `tests/unit/stack-orchestrator.test.js`

**Remove tests for deleted behavior:**
- Lock acquisition/release
- Branch restore (named branch / detached HEAD)
- Worktree record restore (Hazard #1)
- Sequential ordering assertions

**Add tests for new behavior:**
- Creates per-PR worktrees (serial, via `createWorktreeForPR`)
- Resolves `repositoryPath` from trigger worktree
- Runs analyses in parallel (`Promise.allSettled` — verify all start without awaiting prior)
- Handles partial worktree creation failure (others still proceed)
- Handles partial analysis failure (others still succeed)
- Cancellation kills all running analyses
- Broadcasts progress on each PR start/completion
- Fetches PR data from GitHub before worktree creation

**Keep (adapted):**
- Returns immediately if state missing
- Sets final status on success/failure
- `estimateCouncilTimeout` tests (unchanged)

### Task 10: Run tests + E2E

- `npm test` for unit/integration
- E2E tests for frontend changes to StackProgressModal

## Hazards

1. **`createWorktreeForPR` needs `prData`** — it requires `head_sha`, `head_branch`, `base_sha` etc. Solution: pre-fetch all PR data from GitHub in parallel, then pass to both `createWorktreeForPR` and `setupStackPR` (via new optional `prData` parameter). This avoids redundant API calls and ensures data is available before worktree creation.

2. **Double DB writes to worktrees table** — `createWorktreeForPR` calls `worktreeRepo.getOrCreate()` (line 452), and then `setupStackPR` → `storePRData` also writes the worktree record. Both use the same per-PR worktree path, so the second write is an idempotent update. Safe but redundant.

3. **`git worktree add` contention** — parallel `git worktree add` calls fail with `fatal: 'worktrees' is already locked`. Worktree creation MUST be serial. Only the analysis phase runs in parallel.

4. **GitHub rate limiting** — parallel PR data fetches and `setupStackPR` calls each create a `GitHubClient`. For a 5-PR stack, this is ~10 API calls total. Well within rate limits.

5. **`broadcastStackProgress` called from parallel Promises** — `ws.broadcast` and Map mutations are synchronous in single-threaded Node.js. No data race, but rapid broadcasts could cause frontend flicker. Acceptable for now.

6. **`StackProgressModal._subscribeToCurrentPR` → `_subscribeToRunningPRs`** — If frontend is deployed before backend, it still works (single `currentPRNumber` still valid). If backend is deployed first, `currentPRNumber` is `null` and old frontend silently skips subscription. Backward-compatible either way.

7. **Three launcher functions all receive `worktreePath`** — `launchStackSingleAnalysis`, `launchStackCouncilAnalysis`, `launchStackExecutableAnalysis` pass `worktreePath` through unchanged. Each now receives per-PR path. No changes needed.

8. **Existing worktree lock checks in `src/routes/pr.js`** (lines 390, 1664) — check `worktreeLock.isLocked(worktreePath)`. Since stack analysis no longer locks any worktree, these always pass. Correct behavior — per-PR worktrees are independent. A user refreshing during analysis is unlikely and the refresh path has its own safety checks.

## Files to modify
- `src/routes/stack-analysis.js` — core rewrite (Tasks 1-6)
- `src/setup/stack-setup.js` — JSDoc update (Task 7)
- `public/js/components/StackProgressModal.js` — multi-subscription (Task 8)
- `tests/unit/stack-orchestrator.test.js` — rewrite tests (Task 9)

## Verification
1. `npm test` — all unit/integration tests pass
2. `npm run test:e2e` — E2E tests pass (frontend changes)
3. Manual: trigger a stack analysis on a multi-PR stack, verify PRs analyze in parallel, progress modal shows multiple running, cancellation kills all
