# Worktree Pool Lifecycle Consolidation

## Context

The worktree pool feature (just committed on the `worktree-pool` branch) spreads pool state transitions across 4 layers: WorktreePoolRepository (database.js), WorktreePoolManager (worktree-pool.js), WorktreePoolUsageTracker (worktree-pool-usage.js), and 7 route handler files. This distribution already produced 6 concurrency bugs caught in review. The root cause is that no single component owns the full lifecycle of a pool slot — each caller independently sequences DB transitions, in-memory tracking, and cleanup. This refactor consolidates all state transitions into a single `WorktreePoolLifecycle` class. Internal refactor only — no schema changes, no external API changes.

## Design Decisions

### Q1: Absorb WorktreePoolManager into lifecycle class?

**Yes.** The pool manager already does acquire/create/switch/refresh. The lifecycle class adds session/analysis tracking and release. Composing them would recreate the two-object coordination problem we're eliminating. Combined class is ~600-700 lines, well under 20K token budget.

### Q2: Singleton vs instance?

**Instance.** Instantiated once in `main.js`, stored on Express app via `app.set('poolLifecycle')`, retrieved in routes via `req.app.get('poolLifecycle')`. Headless CLI creates its own instance locally.

### Q3: Analysis tracking API?

**`startAnalysis(reviewId, analysisId)` / `endAnalysis(analysisId)`** encapsulate the findByReviewId-then-addAnalysis pattern that 3 route files currently duplicate.

### Q4: WebSocket session tracking API?

**`startSession(reviewId, sessionKey)` / `endSession(worktreeId, sessionKey)`** move the DB lookup into the lifecycle class. Returns `{ worktreeId }` for the WS server to store. The WS-specific race guard (checking socket state after async resolve) stays in ws/server.js.

### Q5: Read-only queries?

**Stay on WorktreePoolRepository directly.** The lifecycle class exposes `get poolRepo` for callers that need `getPoolEntry` or `isPoolWorktree`.

## Architecture

```
WorktreePoolLifecycle (src/git/worktree-pool-lifecycle.js)
├── constructor(db, config, _deps)     // DI pattern
│
│   // ─── Acquisition (absorbs WorktreePoolManager) ───
├── acquireForPR(prInfo, prData, repositoryPath, options)
├── _createPoolWorktree(...)           // internal
├── _switchPoolWorktree(...)           // internal
├── _refreshPoolWorktree(...)          // internal
│
│   // ─── Session tracking (absorbs WorktreePoolUsageTracker) ───
├── startSession(reviewId, sessionKey) → { worktreeId } | null
├── endSession(worktreeId, sessionKey)
│
│   // ─── Analysis tracking ───
├── startAnalysis(reviewId, analysisId) → worktreeId | null
├── endAnalysis(analysisId)
│
│   // ─── Release / cleanup ───
├── releaseForDeletion(worktreeId)     // clearWorktree + markAvailable
├── releaseAfterHeadless(worktreeId)   // markAvailable + clearWorktree
├── setReviewOwner(worktreeId, reviewId)
│
│   // ─── Startup ───
├── resetAndRehydrate()                // resetStaleAndPreserve + onIdle + rehydrate
│
│   // ─── Read access ───
├── get poolRepo                       // for pure reads
├── getActiveAnalyses(worktreeId)      // for review deletion cancel logic
│
│   // ─── Internal ───
├── _usageTracker (WorktreePoolUsageTracker instance)
└── _poolRepo (WorktreePoolRepository instance)
```

### What gets deleted
- `src/git/worktree-pool.js` — WorktreePoolManager absorbed
- `src/git/worktree-pool-usage.js` singleton export removed (class stays for internal composition)

### What stays unchanged
- `WorktreePoolRepository` in `src/database.js`
- `WorktreePoolUsageTracker` class definition (composed internally)
- All HTTP routes, WebSocket protocol, DB schema

## Tasks

### Task 1: Create WorktreePoolLifecycle class + tests [BLOCKING]

**Files:** `src/git/worktree-pool-lifecycle.js` (new), `tests/unit/worktree-pool-lifecycle.test.js` (new)

1. Constructor accepts `(db, config, _deps = {})` with DI pattern
2. Move all methods from WorktreePoolManager into the class
3. Add lifecycle methods: `startSession`, `endSession`, `startAnalysis`, `endAnalysis`, `releaseForDeletion`, `releaseAfterHeadless`, `setReviewOwner`, `resetAndRehydrate`, `getActiveAnalyses`
4. Expose `get poolRepo` for read-only access
5. Re-export `PoolExhaustedError`
6. Port existing worktree-pool.test.js tests + add tests for new lifecycle methods

### Task 2: Update main.js [depends on Task 1]

**File:** `src/main.js`

- Replace startup block (resetStaleAndPreserve + onIdle wiring + rehydration) with `poolLifecycle.resetAndRehydrate()`
- Store lifecycle on app: `app.set('poolLifecycle', poolLifecycle)`
- Pass to `attachWebSocket(httpServer, db, poolLifecycle)`
- Update headless review to use `poolLifecycle.acquireForPR`, `setReviewOwner`, `releaseAfterHeadless`
- `startPoolBackgroundFetches` stays as-is (pure read pattern, no state transitions)

### Task 3: Update pr-setup.js [parallelizable after Task 1]

**File:** `src/setup/pr-setup.js`

- Replace `WorktreePoolManager` + `WorktreePoolRepository` with `WorktreePoolLifecycle`
- Use `acquireForPR`, `setReviewOwner`, `releaseAfterHeadless`

### Task 4: Update routes/analyses.js [parallelizable]

**File:** `src/routes/analyses.js`

- Remove `WorktreePoolRepository`, `worktreePoolUsage` imports
- Accept `poolLifecycle` via `modeContext` parameter
- Replace findByReviewId + addAnalysis pattern with `poolLifecycle?.startAnalysis(reviewId, analysisId)`
- Replace removeAnalysis/removeAnalysisById with `poolLifecycle?.endAnalysis(analysisId)`

### Task 5: Update ws/server.js [parallelizable]

**File:** `src/ws/server.js`

- Remove `worktreePoolUsage`, `WorktreePoolRepository` imports
- Change signature to `attachWebSocket(httpServer, db, poolLifecycle)`
- Use `poolLifecycle.startSession` (async) then check socket state after resolve
- Use `poolLifecycle?.endSession` for unsubscribe/close/error cleanup

### Task 6: Update routes/worktrees.js [parallelizable]

**File:** `src/routes/worktrees.js`

- Remove `worktreePoolUsage` import
- In `deleteReviewById`: use `poolLifecycle.getActiveAnalyses` for cancel logic, then `poolLifecycle.releaseForDeletion` (analysis cancellation stays in route)
- Change signature to accept `poolLifecycle` parameter

### Task 7: Update routes/executable-analysis.js [parallelizable]

**File:** `src/routes/executable-analysis.js`

- Remove `WorktreePoolRepository`, `worktreePoolUsage` imports
- Accept `poolLifecycle` in params
- Replace pattern with `poolLifecycle?.startAnalysis` / `poolLifecycle?.endAnalysis`

### Task 8: Update routes/pr.js [parallelizable]

**File:** `src/routes/pr.js`

- Remove `WorktreePoolRepository`, `worktreePoolUsage` imports
- Single-provider analysis: use `poolLifecycle?.startAnalysis` / `endAnalysis`
- Council analysis: pass `poolLifecycle` in `modeContext` to `launchCouncilAnalysis`
- Executable analysis: pass `poolLifecycle` in params to `runExecutableAnalysis`

### Task 9: Update routes/setup.js [parallelizable]

**File:** `src/routes/setup.js`

- Replace direct `WorktreePoolRepository` usage with `poolLifecycle.poolRepo.getPoolEntry` for consistency
- Minor cleanup — this file only does reads

### Task 10: Delete old files [after Tasks 2-9]

- Delete `src/git/worktree-pool.js` entirely
- Remove singleton export from `src/git/worktree-pool-usage.js`
- Update `PoolExhaustedError` imports in `worktrees.js`, `setup.js` to point to lifecycle module
- Verify no file imports `worktree-pool-usage` except lifecycle class

### Task 11: Verification [final]

1. `npm test` — all tests pass
2. `npm run test:e2e` — E2E tests pass
3. Grep: no file directly calls `markAvailable`, `clearWorktree`, `addSession`, `addAnalysis`, `removeSession`, `removeAnalysis`, `removeAnalysisById`, or `setCurrentReviewId` except the lifecycle class
4. Grep: no file imports from `./git/worktree-pool` (deleted) or the singleton from `./git/worktree-pool-usage`

## Hazards

1. **Singleton vs instance divergence.** `_switchPoolWorktree` currently calls the singleton `worktreePoolUsage.clearWorktree()`. After refactor, must call `this._usageTracker.clearWorktree()`. Task 10 removes the singleton export as a guard.

2. **deleteReviewById ordering.** Analysis cancellation (kill processes) MUST happen BEFORE `releaseForDeletion` — otherwise the worktree could be claimed by another PR while a subprocess is still writing to it.

3. **performHeadlessReview finally block.** `releaseAfterHeadless` must be guarded with `if (poolWorktreeId && poolLifecycle)` since acquireForPR may not have run.

4. **WS subscribe async race.** The socket-state check (`ws.readyState !== ws.OPEN`) must stay AFTER the `startSession` await resolves, in ws/server.js, NOT inside the lifecycle class.

5. **Three independent analysis paths.** pr.js (single-provider), analyses.js (council), executable-analysis.js (executable) all must be updated. Missing one allows premature pool eviction.

6. **launchCouncilAnalysis callers.** Both pr.js and local.js call it — both must pass `poolLifecycle` in `modeContext`. local.js passes null.

7. **onIdle retry loop.** The 2-attempt retry with 1s delay in main.js must be preserved inside `resetAndRehydrate()`.

## Parallelization

```
Task 1 ──→ Tasks 2-9 (all parallel) ──→ Task 10 ──→ Task 11
```
