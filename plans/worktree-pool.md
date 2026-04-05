# Worktree Pool

Configurable pool of reusable git worktrees per repository. Instead of creating and destroying worktrees per PR review, pool worktrees persist and are switched between PRs. Background fetches keep them warm.

## Motivation

For monorepos and large repositories, worktree creation is expensive because:
- `git fetch` against a remote with thousands of daily PRs is slow (ref negotiation on a massive object store)
- A `checkout_script` runs to set up sparse-checkout
- These costs are paid on every new PR review

The pool amortizes these costs: once a pool worktree exists with sparse-checkout configured, switching to a new PR is just an incremental fetch + checkout + reset_script.

---

## 1. Config Rename: `monorepos` to `repos`

### What Changes

Rename the top-level config key `monorepos` to `repos`. Support both keys (fall back to `monorepos` silently).

### Implementation

**File: `src/config.js`**

1. Change `DEFAULT_CONFIG.monorepos` (line 37) to `DEFAULT_CONFIG.repos: {}`. Keep `monorepos` removed from defaults.

2. Add a new helper function `getRepoConfig(config, repository)` that reads from `config.repos?.[repository]` first, falling back to `config.monorepos?.[repository]`:

```js
function getRepoConfig(config, repository) {
  const reposSection = config.repos || {};
  const entry = reposSection[repository];
  if (entry) return entry;

  const legacySection = config.monorepos || {};
  return legacySection[repository] || null;
}
```

3. Refactor every `getMonorepo*` function to use `getRepoConfig` internally instead of `config.monorepos?.[repository]`. Rename the functions:
   - `getMonorepoPath` -> `getRepoPath` (keep `getMonorepoPath` as re-export alias)
   - `getMonorepoCheckoutScript` -> `getRepoCheckoutScript` (keep alias)
   - `getMonorepoWorktreeDirectory` -> `getRepoWorktreeDirectory` (keep alias)
   - `getMonorepoWorktreeNameTemplate` -> `getRepoWorktreeNameTemplate` (keep alias)
   - `getMonorepoCheckoutTimeout` -> `getRepoCheckoutTimeout` (keep alias)
   - `resolveMonorepoOptions` -> `resolveRepoOptions` (keep alias)

4. Export both old and new names from `module.exports` (lines 550-561). The old names delegate to the new ones.

**File: `src/setup/pr-setup.js`** (line 19)
- Update imports: `getMonorepoPath` -> `getRepoPath`, `resolveMonorepoOptions` -> `resolveRepoOptions`
- Update call sites: line 238 (`getMonorepoPath`), line 290 (`resolveMonorepoOptions`)

**File: `src/main.js`** (line 3)
- Update import: `resolveMonorepoOptions` -> `resolveRepoOptions`
- Update call site: line 756

**File: `config.example.json`** (lines 247-257)
- Rename `"monorepos"` key to `"repos"`
- Update the `_comment` to note the rename

**File: `examples/shopify.config.json`** (line 8)
- Rename `"monorepos"` key to `"repos"`

### New Config Getters

Add these new getters to `src/config.js`:

```js
function getRepoResetScript(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  return repoConfig?.reset_script || null;
}

function getRepoPoolSize(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  const size = repoConfig?.pool_size;
  return (typeof size === 'number' && size > 0) ? size : 0;
}

function getRepoPoolFetchInterval(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  const minutes = repoConfig?.pool_fetch_interval_minutes;
  return (typeof minutes === 'number' && minutes > 0) ? minutes : null;
}
```

Add a composite `resolveRepoOptions` that also returns `resetScript`, `poolSize`, and `poolFetchIntervalMinutes` alongside the existing fields.

### Tests

**File: `tests/unit/config.test.js`**

- Add test: `repos` key is read correctly
- Add test: `monorepos` key is read as silent fallback
- Add test: `repos` takes precedence when both keys exist
- Add tests for `getRepoResetScript`, `getRepoPoolSize`, `getRepoPoolFetchInterval`
- Existing `getMonorepo*` tests continue to pass (aliases work)

---

## 2. New Config Keys

Under `repos.<owner/repo>`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `reset_script` | string | null | Command to run when switching a pool worktree to a new PR |
| `pool_size` | number | 0 | Max pool worktrees for this repo (0 = no pool, current behavior) |
| `pool_fetch_interval_minutes` | number | null | Background fetch interval for idle pool worktrees |

The `reset_script` receives the same env vars as `checkout_script`: `BASE_BRANCH`, `HEAD_BRANCH`, `BASE_SHA`, `HEAD_SHA`, `PR_NUMBER`, `WORKTREE_PATH`.

Example config:
```json
{
  "repos": {
    "owner/repo": {
      "path": "~/path/to/clone",
      "worktree_directory": "~/custom/worktrees",
      "worktree_name_template": "{id}/src",
      "checkout_script": "git sparse-checkout set --cone .base && git checkout && my-checkout-tool --add-only --base \"$BASE_SHA\" -- \"$HEAD_BRANCH\"",
      "reset_script": "my-checkout-tool --base \"$BASE_SHA\" -- \"$HEAD_BRANCH\"",
      "checkout_timeout_seconds": 300,
      "pool_size": 3,
      "pool_fetch_interval_minutes": 30
    }
  }
}
```

---

## 3. Database Schema

### New Table: `worktree_pool`

**File: `src/database.js`**

Add to `SCHEMA_SQL`:
```sql
CREATE TABLE IF NOT EXISTS worktree_pool (
  id TEXT PRIMARY KEY,              -- Same ID as worktrees.id (e.g. 'pool-abc')
  repository TEXT NOT NULL,         -- owner/repo
  path TEXT NOT NULL UNIQUE,        -- Absolute filesystem path (canonical reference)
  status TEXT NOT NULL DEFAULT 'available'
    CHECK(status IN ('available', 'in_use', 'switching')),
  current_pr_number INTEGER,        -- PR currently checked out (NULL if never assigned)
  last_switched_at TEXT,            -- When last switched to a different PR
  last_fetched_at TEXT,             -- When background fetch last ran
  created_at TEXT NOT NULL
  -- No FK to worktrees: the pool entry owns the lifecycle,
  -- and the worktrees entry is updated/recreated on each PR switch.
)
```

Add to `INDEX_SQL`:
```sql
CREATE INDEX IF NOT EXISTS idx_worktree_pool_repo ON worktree_pool(repository)
CREATE INDEX IF NOT EXISTS idx_worktree_pool_status ON worktree_pool(repository, status)
CREATE INDEX IF NOT EXISTS idx_worktree_pool_lru ON worktree_pool(repository, status, last_switched_at)
```

### Migration 37

```js
37: (db) => {
  console.log('Running migration to schema version 37...');

  if (!tableExists(db, 'worktree_pool')) {
    db.exec(SCHEMA_SQL.worktree_pool);
    console.log('  Created worktree_pool table');
  }

  // Create indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_worktree_pool_repo ON worktree_pool(repository)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_worktree_pool_status ON worktree_pool(repository, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_worktree_pool_lru ON worktree_pool(repository, status, last_switched_at)');

  console.log('Migration to schema version 37 complete');
}
```

Update `CURRENT_SCHEMA_VERSION` from 36 to 37.

### New Class: `WorktreePoolRepository`

**File: `src/database.js`**

```js
class WorktreePoolRepository {
  constructor(db) { this.db = db; }

  /**
   * Create a pool entry for a worktree.
   * The worktrees table entry must already exist.
   */
  async create({ id, repository }) { ... }

  /**
   * Find an available (evictable) pool worktree for a repository,
   * ordered by LRU (oldest last_switched_at first).
   */
  async findAvailable(repository) { ... }

  /**
   * Find a pool worktree currently assigned to a PR.
   */
  async findByPR(prNumber, repository) { ... }

  /**
   * Count pool worktrees for a repository.
   */
  async countForRepo(repository) { ... }

  /**
   * Mark a pool worktree as in_use.
   */
  async markInUse(id, prNumber) { ... }

  /**
   * Mark a pool worktree as available (evictable).
   */
  async markAvailable(id) { ... }

  /**
   * Mark a pool worktree as switching (transitional state during PR switch).
   */
  async markSwitching(id) { ... }

  /**
   * Update last_fetched_at timestamp.
   */
  async updateLastFetched(id) { ... }

  /**
   * Find idle pool worktrees for background fetch.
   * Returns worktrees with status='available' for the given repository.
   */
  async findIdleForRepo(repository) { ... }

  /**
   * Find all pool worktrees for a repository.
   */
  async findAllForRepo(repository) { ... }

  /**
   * Check if a worktree ID belongs to the pool.
   */
  async isPoolWorktree(id) { ... }

  /**
   * Delete a pool entry.
   */
  async delete(id) { ... }
}
```

Export from `module.exports` alongside existing repository classes.

### Test Schema Updates

**File: `tests/utils/schema.js`**
- Add `worktree_pool` to `SCHEMA_SQL`
- Add pool indexes to `INDEX_SQL`

**File: `tests/integration/routes.test.js`**
- If it has its own schema setup, add `worktree_pool` table there too

---

## 4. Pool Worktree Lifecycle

### New Module: `src/git/worktree-pool.js`

This is the core orchestrator for pool worktree allocation, creation, and switching.

```js
class WorktreePoolManager {
  constructor(db, config, _deps = {}) {
    this.db = db;
    this.config = config;
    this.poolRepo = new WorktreePoolRepository(db);
    this.worktreeRepo = new WorktreeRepository(db);
    this.usageTracker = _deps.usageTracker || worktreePoolUsage; // singleton
  }

  /**
   * Resolve a worktree for a PR review.
   * This is the main entry point, called from setupPRReview.
   *
   * Decision tree:
   * 1. Pool worktree already assigned to this PR -> refresh
   * 2. Available (not in use) pool worktree exists -> switch (LRU eviction)
   * 3. Pool not full -> create new pool worktree
   * 4. Pool full, all in use -> throw PoolExhaustedError
   *
   * @returns {Promise<string>} worktree path
   */
  async acquireForPR(prInfo, prData, repositoryPath, options) { ... }

  /**
   * Create a new pool worktree from scratch.
   * Uses GitWorktreeManager.createWorktreeForPR internally,
   * then registers it in the worktree_pool table.
   */
  async _createPoolWorktree(prInfo, prData, repositoryPath, options) { ... }

  /**
   * Switch an existing pool worktree to a different PR.
   * Sequence:
   * 1. Mark pool entry as 'switching'
   * 2. Fetch new PR refs (incremental)
   * 3. git checkout new PR head
   * 4. Run reset_script with new PR env vars
   * 5. Update worktrees table (pr_number, branch)
   * 6. Update worktree_pool table (current_pr_number, last_switched_at)
   * 7. Mark pool entry as 'in_use'
   */
  async _switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options) { ... }

  /**
   * Refresh an existing pool worktree that's already on the right PR.
   * Same as GitWorktreeManager.refreshWorktree.
   */
  async _refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData) { ... }

  /**
   * Release a pool worktree (mark available) when no longer in use.
   * Called by the usage tracker when all sessions/analyses end.
   */
  async release(worktreeId) { ... }
}
```

### Custom Error Class

```js
class PoolExhaustedError extends Error {
  constructor(repository, poolSize) {
    super(`All ${poolSize} worktree pool slots for ${repository} are occupied. Close an existing review or wait for an analysis to complete.`);
    this.name = 'PoolExhaustedError';
    this.repository = repository;
    this.poolSize = poolSize;
  }
}
```

### Pool Worktree ID Generation

Pool worktrees use a distinct ID prefix: `pool-xyz` (vs `pair-review--xyz` for regular worktrees). Add a `generatePoolWorktreeId()` function in `src/database.js`:

```js
function generatePoolWorktreeId(length = 3) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let randomPart = '';
  for (let i = 0; i < length; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `pool-${randomPart}`;
}
```

### Integration Point: `src/setup/pr-setup.js`

**Function: `setupPRReview`** (line 388)

After `findRepositoryPath` resolves the repository path (line 414), check if `poolSize > 0` for this repository:

```js
const poolSize = getRepoPoolSize(config, repository);

if (poolSize > 0) {
  // Pool mode: use WorktreePoolManager
  progress({ step: 'worktree', status: 'running', message: 'Acquiring pool worktree...' });
  const poolManager = new WorktreePoolManager(db, config);
  const resetScript = getRepoResetScript(config, repository);
  const worktreePath = await poolManager.acquireForPR(
    prInfo, prData, repositoryPath,
    { worktreeSourcePath, checkoutScript, checkoutTimeout, resetScript }
  );
  progress({ step: 'worktree', status: 'completed', message: `Pool worktree acquired at ${worktreePath}` });
  // ... continue with diff generation, storage etc.
} else {
  // Non-pool mode: existing behavior
  const worktreeManager = new GitWorktreeManager(db, worktreeConfig || {});
  const worktreePath = await worktreeManager.createWorktreeForPR(...);
  // ...
}
```

### Integration Point: `src/main.js`

The CLI entry point (around line 785) also calls `createWorktreeForPR`. Apply the same pool check here. However, since the CLI path already redirects to the web UI for setup (via `cli-pr-setup-defer-to-web-ui.md`), the main integration point is `setupPRReview`.

### Integration Point: `src/routes/setup.js`

The setup route calls `setupPRReview` (line 104), which is where the pool logic will trigger. The `PoolExhaustedError` will propagate up and be caught by the error handler at line 117, which sends `sendSetupEvent(setupId, 'error', { message: err.message })`. The frontend setup.html already handles error events. Add a `code: 'POOL_EXHAUSTED'` field to the error payload so the frontend can show a specific dialog.

### Integration Point: `src/routes/worktrees.js`

The `POST /api/worktrees/create` route (line 25) calls `setupPRReview` (line 60). The `PoolExhaustedError` will propagate and be caught at line 82. Add a specific handler:

```js
if (error instanceof PoolExhaustedError) {
  return res.status(409).json({
    success: false,
    error: error.message,
    code: 'POOL_EXHAUSTED'
  });
}
```

### Switching Sequence Detail

The `_switchPoolWorktree` method implements:

1. **Mark switching**: `poolRepo.markSwitching(poolEntry.id)` — prevents concurrent operations
2. **Fetch new PR refs**: `git.fetch([remote, '+refs/pull/${prNumber}/head:refs/remotes/${remote}/pr-${prNumber}'])` — incremental, cheap on warm worktree
3. **Checkout new PR head**: `git.checkout(['refs/remotes/${remote}/pr-${prNumber}'])` — updates working tree within existing sparse-checkout cone
4. **Run reset_script**: `executeCheckoutScript(resetScript, worktreePath, scriptEnv, checkoutTimeout)` — adjusts sparse-checkout cone to match new PR's file scope. Reuse the existing `GitWorktreeManager.executeCheckoutScript` method.
5. **Update worktrees table**: `worktreeRepo.getOrCreate({ prNumber, repository, branch, path })` — updates pr_number and branch for the existing worktree record
6. **Update worktree_pool**: `poolRepo.markInUse(poolEntry.id, prNumber)` and update `last_switched_at`

### Script Env Vars

Both `checkout_script` and `reset_script` receive:
- `BASE_BRANCH`, `HEAD_BRANCH`, `BASE_SHA`, `HEAD_SHA`, `PR_NUMBER`, `WORKTREE_PATH`

---

## 5. Usage Tracking

### New Module: `src/git/worktree-pool-usage.js`

An in-memory tracker that determines whether a pool worktree is "in use".

```js
const GRACE_PERIOD_MS = 30_000; // 30 seconds after last WS disconnect

class WorktreePoolUsageTracker {
  constructor() {
    /** @type {Map<string, Set<string>>} worktreeId -> Set of active session keys */
    this._sessions = new Map();
    /** @type {Map<string, string>} worktreeId -> analysisId (if analysis running) */
    this._analyses = new Map();
    /** @type {Map<string, NodeJS.Timeout>} worktreeId -> grace period timer */
    this._graceTimers = new Map();
    /** @type {Function|null} Callback when a worktree becomes idle */
    this.onIdle = null;
  }

  /**
   * Register an active WebSocket session for a worktree.
   * @param {string} worktreeId - Pool worktree ID
   * @param {string} sessionKey - Unique key for this WS connection (e.g., ws client ID + topic)
   */
  addSession(worktreeId, sessionKey) { ... }

  /**
   * Remove a WebSocket session. Starts grace period if no sessions remain.
   */
  removeSession(worktreeId, sessionKey) { ... }

  /**
   * Register an active analysis for a worktree.
   */
  addAnalysis(worktreeId, analysisId) { ... }

  /**
   * Remove an active analysis hold.
   */
  removeAnalysis(worktreeId, analysisId) { ... }

  /**
   * Check if a worktree is currently in use.
   */
  isInUse(worktreeId) { ... }

  /**
   * Get all worktree IDs that are currently idle (not in use).
   */
  getIdleWorktrees() { ... }
}

// Singleton
const worktreePoolUsage = new WorktreePoolUsageTracker();
module.exports = { worktreePoolUsage, WorktreePoolUsageTracker };
```

### Integration: WebSocket Sessions

**File: `src/ws/server.js`**

The WebSocket server currently tracks topic subscriptions on `ws._topics`. To track pool worktree usage, add hooks when clients subscribe/unsubscribe to `review:{reviewId}` topics.

However, the WS server does not know the mapping from reviewId to worktreeId. Two options:

**Option A (recommended)**: Maintain a `reviewIdToPoolWorktreeId` map in `src/git/worktree-pool-usage.js`. Populated when a pool worktree is acquired (in `acquireForPR`). The WS server calls `worktreePoolUsage.addSession(worktreeId, sessionKey)` when a client subscribes to `review:{reviewId}` and the reviewId maps to a pool worktree.

**Implementation**: 
- In `src/ws/server.js`, on subscribe to `review:*` topics, look up `worktreePoolUsage.reviewToWorktree(reviewId)`. If found, call `addSession`.
- On unsubscribe or disconnect, call `removeSession` for all mapped worktrees.
- The usage tracker exposes `registerReview(reviewId, worktreeId)` and `unregisterReview(reviewId)`.

### Integration: Analysis Holds

**File: `src/routes/pr.js`** — analysis start (around line 1786)

When an analysis starts for a PR that uses a pool worktree:
1. Look up worktree in `worktree_pool` table by matching the worktree path
2. If pool worktree: `worktreePoolUsage.addAnalysis(worktreeId, analysisId)`
3. On analysis completion/failure/cancellation: `worktreePoolUsage.removeAnalysis(worktreeId, analysisId)`

The analysis completion is handled in the `.then()` callback at line 1787 and the `.catch()` at line ~1847. Add `removeAnalysis` calls in both paths.

**File: `src/routes/shared.js`**

Add a helper `removePoolAnalysisHold(analysisId)` that checks if this analysis maps to a pool worktree and removes the hold. Call from the analysis completion path.

### Idle Callback

When a worktree becomes idle (no sessions, no analyses, grace period expired), the usage tracker calls `onIdle(worktreeId)`. The pool manager listens and calls `poolRepo.markAvailable(worktreeId)`.

Wire this up in `src/main.js` at startup:

```js
const { worktreePoolUsage } = require('./git/worktree-pool-usage');
worktreePoolUsage.onIdle = async (worktreeId) => {
  const poolRepo = new WorktreePoolRepository(db);
  await poolRepo.markAvailable(worktreeId);
  logger.info(`Pool worktree ${worktreeId} is now available`);
};
```

---

## 6. Cleanup Protection

Pool worktrees must be exempt from all cleanup paths.

### Path 1: Stale Worktree Cleanup on Startup

**File: `src/git/worktree.js`** — `cleanupStaleWorktrees` (line 974)

After `findStale(cutoffDate)` returns stale worktrees (line 992), filter out any whose ID exists in `worktree_pool`:

```js
const poolRepo = new WorktreePoolRepository(this.db);
const filteredStale = [];
for (const wt of staleWorktrees) {
  const isPool = await poolRepo.isPoolWorktree(wt.id);
  if (!isPool) {
    filteredStale.push(wt);
  } else {
    logger.debug(`Skipping pool worktree ${wt.id} from stale cleanup`);
  }
}
```

Alternatively, modify the SQL query in `WorktreeRepository.findStale` to LEFT JOIN against `worktree_pool` and exclude matches. This is more efficient:

```sql
SELECT w.id, w.pr_number, w.repository, w.branch, w.path, w.created_at, w.last_accessed_at
FROM worktrees w
LEFT JOIN worktree_pool wp ON w.id = wp.id
WHERE w.last_accessed_at < ? AND wp.id IS NULL
ORDER BY w.last_accessed_at ASC
```

This is the cleaner approach since it avoids N+1 queries.

### Path 2: Manual Delete via `DELETE /api/worktrees/:id`

**File: `src/routes/worktrees.js`** — `deleteReviewById` (line 232)

Before deleting, check if the worktree belongs to the pool:

```js
if (worktree) {
  const poolRepo = new WorktreePoolRepository(db);
  const isPool = await poolRepo.isPoolWorktree(worktree.id);
  if (isPool) {
    // For pool worktrees: delete review data but keep the worktree itself.
    // The pool worktree becomes available for the next PR.
    // Delete DB records (reviews, comments, pr_metadata) but NOT the worktree record or pool entry.
    // ... (modified transaction that skips `DELETE FROM worktrees` and filesystem cleanup)
  }
}
```

When a user deletes a review that uses a pool worktree:
- Delete pr_metadata, reviews, comments, chat_sessions, github_pr_cache (same as now)
- Do NOT delete the worktrees row or worktree_pool row
- Do NOT clean up the filesystem
- Mark the pool worktree as `available`

### Path 3: Bulk Delete via `POST /api/worktrees/bulk-delete`

Same protection as Path 2 — `deleteReviewById` is called per ID, so the pool check in `deleteReviewById` covers this.

### Path 4: Stale Record on Index Load

**File: `src/routes/worktrees.js`** — `GET /api/worktrees/recent` (line 178)

The existing code deletes worktree records when the directory is missing. For pool worktrees, the directory should always exist. But add a guard:

```js
// Only clean up stale record if it's not a pool worktree
const poolCheck = await queryOne(db, 'SELECT id FROM worktree_pool WHERE id = ?', [row.worktree_id]);
if (!poolCheck) {
  // existing cleanup logic
}
```

### Path 5: Review Retention Cleanup

**File: `src/main.js`** — `cleanupStaleReviewsAsync` (line 192)

This cleans up old reviews. When a review's associated worktree is a pool worktree, delete the review data but do not delete the worktree record or filesystem.

---

## 7. Background Fetch

### Implementation

**File: `src/main.js`**

After server startup (after `startServer` returns), set up a periodic background fetch for each repo that has `pool_fetch_interval_minutes` configured.

### Fetch Strategy: All Worktrees Serially, Coldest First

Background fetches are expensive but safe — `git fetch` only updates remote-tracking refs and does not touch the working tree or HEAD. Fetching an active worktree is harmless and means subsequent PR-specific fetches are cheaper.

Strategy:
- **Fetch all pool worktrees serially** on each tick — one after another, never concurrent (avoids hammering the remote)
- **Coldest first** — order by `last_fetched_at ASC NULLS FIRST` so never-fetched and most-stale worktrees are warmed first
- **All statuses** — fetch `available`, `in_use`, and `switching` worktrees alike (fetch is read-only, safe during active use)
- **Skip worktrees mid-switch** — the `switching` status means a PR switch is in progress with its own fetch; skip to avoid contention on the same worktree's git lock

The `WorktreePoolRepository.findAllForFetch(repository)` query:
```sql
SELECT wp.id, wp.path, wp.last_fetched_at, wp.status
FROM worktree_pool wp
WHERE wp.repository = ? AND wp.status != 'switching'
ORDER BY wp.last_fetched_at ASC NULLS FIRST
```

```js
function startPoolBackgroundFetches(db, config) {
  const repos = config.repos || config.monorepos || {};
  for (const [repository, repoConfig] of Object.entries(repos)) {
    const intervalMinutes = repoConfig.pool_fetch_interval_minutes;
    if (!intervalMinutes || intervalMinutes <= 0) continue;

    const intervalMs = intervalMinutes * 60 * 1000;
    logger.info(`Scheduling background fetch for ${repository} pool every ${intervalMinutes}m`);

    let fetchInProgress = false;
    setInterval(async () => {
      if (fetchInProgress) {
        logger.debug(`Skipping background fetch for ${repository} — previous tick still running`);
        return;
      }
      fetchInProgress = true;
      try {
        const poolRepo = new WorktreePoolRepository(db);
        const worktrees = await poolRepo.findAllForFetch(repository);

        for (const entry of worktrees) {
          logger.debug(`Background fetch for pool worktree ${entry.id} at ${entry.path}`);
          try {
            const git = simpleGit(entry.path);
            // Fetch primary remote only (not --all; fork remotes are PR-specific)
            const remotes = await git.getRemotes();
            const remote = remotes.find(r => r.name === 'origin') || remotes[0];
            if (remote) await git.fetch([remote.name]);
            await poolRepo.updateLastFetched(entry.id);
          } catch (fetchErr) {
            logger.warn(`Background fetch failed for ${entry.id}: ${fetchErr.message}`);
          }
        }
      } catch (err) {
        logger.warn(`Background pool fetch error for ${repository}: ${err.message}`);
      } finally {
        fetchInProgress = false;
      }
    }, intervalMs);
  }
}
```

Call `startPoolBackgroundFetches(db, config)` after the server starts.

### Fetch Details

- Run `git fetch <remote>` against the worktree's primary remote (not `--all` — fork remotes are PR-specific and not worth warming)
- Fetch all pool worktrees regardless of usage status (fetch is safe during active use)
- Skip worktrees in `switching` status to avoid contention with the PR switch's own fetch
- Update `last_fetched_at` timestamp on success
- Errors are logged but do not crash the process

### Startup Recovery

On server startup, reset all pool worktree statuses to `available`. The in-memory usage tracker is empty on startup (no sessions, no analyses), so any `in_use` or `switching` state in the DB is stale from a previous process.

```js
// In main.js after database initialization
const poolRepo = new WorktreePoolRepository(db);
await poolRepo.resetAllStatuses(); // UPDATE worktree_pool SET status = 'available'
```

---

## 8. Error UI: Pool Exhausted Dialog

### Backend

When `acquireForPR` throws `PoolExhaustedError`:

**In `src/routes/setup.js`** — The error propagates through `setupPRReview` and is caught at line 117:
```js
sendSetupEvent(setupId, 'error', {
  message: err.message,
  code: err.name === 'PoolExhaustedError' ? 'POOL_EXHAUSTED' : undefined
});
```

**In `src/routes/worktrees.js`** — Add specific handling before the generic 500:
```js
const { PoolExhaustedError } = require('../git/worktree-pool');
if (error instanceof PoolExhaustedError) {
  return res.status(409).json({
    success: false,
    error: error.message,
    code: 'POOL_EXHAUSTED'
  });
}
```

### Frontend

**File: `public/setup.html`** (or its associated JS)

On receiving an error event with `code: 'POOL_EXHAUSTED'`, show a specific dialog instead of the generic error message:

```
All worktree pool slots are occupied.
Close an existing review or wait for an analysis to complete.
```

Use the existing `ConfirmDialog` component with a single "OK" button (no confirm/cancel). The dialog title should be "Worktree Pool Full".

**File: `public/js/index.js`**

If the `POST /api/worktrees/create` response returns `code: 'POOL_EXHAUSTED'`, show the same dialog. The index page already has `showError('pr', ...)` (line 1095) — use `ConfirmDialog` for a more prominent notification.

---

## 9. Hazards

### Shared Functions Modified with All Callers

- **`resolveMonorepoOptions` (renamed to `resolveRepoOptions`)**: Called from:
  - `src/setup/pr-setup.js` line 290 (inside `findRepositoryPath`)
  - `src/main.js` line 756 (CLI path)
  - Both callers must be updated to use the new name (or the alias).

- **`getMonorepoPath` (renamed to `getRepoPath`)**: Called from:
  - `src/setup/pr-setup.js` line 238 (inside `findRepositoryPath`)
  - Must be updated.

- **`WorktreeRepository.findStale`**: Currently returns all stale worktrees. After modification to exclude pool worktrees, verify that:
  - `cleanupStaleWorktrees` in `src/git/worktree.js` line 974 still works correctly
  - `cleanupStaleWorktreesAsync` in `src/main.js` line 173 still works correctly

- **`deleteReviewById`** in `src/routes/worktrees.js` line 232: Called from:
  - `DELETE /api/worktrees/:id` (line 293)
  - `POST /api/worktrees/bulk-delete` (line 363)
  - Both paths must handle pool worktrees correctly.

- **`setupPRReview`** in `src/setup/pr-setup.js` line 388: Called from:
  - `POST /api/setup/pr/:owner/:repo/:number` in `src/routes/setup.js` line 104
  - `POST /api/worktrees/create` in `src/routes/worktrees.js` line 60
  - CLI path in `src/main.js` (via inline code around line 785)
  - All three callers must handle `PoolExhaustedError`.

- **`GitWorktreeManager.executeCheckoutScript`**: Currently only called during `createWorktreeForPR`. The pool switching code will also call it for `reset_script`. Verify the function's error handling is appropriate for both contexts (fresh create vs. switch).

### Async Race Conditions

- **Concurrent setup requests for different PRs on the same repo**: Two requests could both see an available pool worktree and try to claim it. Mitigate by using a per-repository mutex/lock in `acquireForPR`. The `activeSetups` map in `src/routes/shared.js` prevents duplicate setups for the *same* PR, but not different PRs competing for the same pool slot.

  Solution: Add a per-repo in-memory lock to `WorktreePoolManager`:
  ```js
  this._repoLocks = new Map(); // repository -> Promise
  ```
  Each `acquireForPR` call chains on the previous promise for the same repository.

- **Grace period race**: A pool worktree's last session disconnects, starting the 30s grace timer. Before it fires, a new session connects. The `addSession` call must clear the grace timer.

- **Background fetch vs. switching**: A background fetch could be running when `acquireForPR` tries to switch the same worktree. The `isInUse` check in the fetch loop prevents starting a fetch on an in-use worktree, but a switch could start after the fetch begins. Mitigate by having `_switchPoolWorktree` check for ongoing fetches (or rely on git's own locking — concurrent git operations on the same repo fail safely).

- **Analysis completion after worktree switch**: An analysis starts on pool worktree X for PR #1. Before it completes, the worktree is switched to PR #2 (because the analysis was cancelled/failed). The analysis completion handler must not assume the worktree is still on PR #1. The analysis stores its own `head_sha` in the analysis_runs table, so results are tied to the SHA, not the worktree state.

### UNIQUE Constraint on worktrees Table

The `worktrees` table has `UNIQUE(pr_number, repository)`. When a pool worktree switches from PR #1 to PR #2:
- The UPDATE changes `pr_number` from 1 to 2
- If another (non-pool) worktree already exists for PR #2, this will violate the unique constraint
- This is safe because when `pool_size > 0`, ALL worktrees for that repo are pool worktrees — no mix of pool and non-pool

But verify: what if someone sets `pool_size > 0` after already having non-pool worktrees? The migration should not retroactively convert existing worktrees to pool worktrees. Handle by:
1. Pool worktrees are only created via `acquireForPR`, never by converting existing ones
2. If a non-pool worktree exists for a PR in a pool-enabled repo, `setupPRReview` should still use the pool path (creating new pool worktrees as needed), and the old non-pool worktree will eventually be cleaned up by stale retention

### worktrees.getOrCreate Behavior

`WorktreeRepository.getOrCreate` (line 2081) does a `findByPR` and then either updates or creates. When switching a pool worktree:
- We UPDATE the existing worktree record's `pr_number` and `branch`
- But `getOrCreate` creates a NEW record if `findByPR` doesn't find one for the new PR number
- We need to use a direct UPDATE instead: `UPDATE worktrees SET pr_number = ?, branch = ?, last_accessed_at = ? WHERE id = ?`
- Add a new method `WorktreeRepository.switchPR(id, prNumber, branch)` for this purpose

### WebSocket topic → reviewId Mapping

The WS server subscribes to `review:{reviewId}` but the usage tracker needs `worktreeId`. The mapping must be populated before the WS subscription happens. Since `setupPRReview` runs before the client opens the PR page and subscribes, this ordering is correct. But verify the mapping is in place before any subscribe events arrive.

---

## 10. Testing Strategy

### Unit Tests

**File: `tests/unit/worktree-pool.test.js`** (new)
- `WorktreePoolManager.acquireForPR`:
  - Returns existing pool worktree for same PR (refresh path)
  - Evicts LRU available worktree when pool has space
  - Creates new pool worktree when pool not full
  - Throws `PoolExhaustedError` when pool full and all in use
  - Handles concurrent requests with per-repo locking
- `WorktreePoolManager._switchPoolWorktree`:
  - Runs fetch, checkout, reset_script in correct order
  - Updates DB records correctly
  - Handles reset_script failure (rolls back status)
- `WorktreePoolManager._createPoolWorktree`:
  - Creates entries in both `worktrees` and `worktree_pool` tables
  - Uses pool-specific ID prefix

**File: `tests/unit/worktree-pool-usage.test.js`** (new)
- Session tracking: add/remove sessions, grace period behavior
- Analysis tracking: add/remove analysis holds
- `isInUse` returns correct state for all combinations
- Grace period: fires idle callback after timeout
- Grace period: cancelled when new session added
- `onIdle` callback fires when last hold released

**File: `tests/unit/config.test.js`** (extend)
- `getRepoConfig` reads from `repos` key
- `getRepoConfig` falls back to `monorepos` key
- `getRepoResetScript` returns script or null
- `getRepoPoolSize` returns number or 0
- `getRepoPoolFetchInterval` returns number or null
- Alias tests: old function names delegate to new ones

**File: `tests/unit/worktree-pool-repository.test.js`** (new)
- CRUD operations on `worktree_pool` table
- `findAvailable` returns LRU ordering
- `findByPR` finds correct entry
- `countForRepo` is accurate
- `isPoolWorktree` returns true/false correctly
- `findIdleForRepo` excludes in_use entries

### Integration Tests

**File: `tests/integration/worktree-pool.test.js`** (new)
- Full lifecycle: create pool worktree, switch to new PR, release
- Cleanup protection: pool worktrees survive stale cleanup
- Delete review: pool worktree preserved when review deleted
- Background fetch: mock git fetch, verify timestamps updated
- `findStale` excludes pool worktrees

**File: `tests/integration/pr-setup.test.js`** (extend)
- Pool-enabled repo: `setupPRReview` creates pool worktree
- Pool-enabled repo: second PR reuses pool worktree via switch
- Pool exhausted: returns appropriate error

### E2E Tests

**File: `tests/e2e/worktree-pool.spec.js`** (new, if time permits)
- Start review for pool-enabled repo: verify setup completes
- Pool exhausted: verify error dialog shown
- These require mocking git operations, so may be deferred

---

## 11. Files to Modify (Complete List)

### New Files
| File | Purpose |
|------|---------|
| `src/git/worktree-pool.js` | `WorktreePoolManager` class, `PoolExhaustedError` |
| `src/git/worktree-pool-usage.js` | `WorktreePoolUsageTracker` singleton |
| `tests/unit/worktree-pool.test.js` | Unit tests for pool manager |
| `tests/unit/worktree-pool-usage.test.js` | Unit tests for usage tracker |
| `tests/unit/worktree-pool-repository.test.js` | Unit tests for DB repository |
| `tests/integration/worktree-pool.test.js` | Integration tests for pool lifecycle |

### Modified Files
| File | Changes |
|------|---------|
| `src/config.js` | Rename `monorepos` to `repos` in defaults, add `getRepoConfig`, rename getter functions with aliases, add `getRepoResetScript`, `getRepoPoolSize`, `getRepoPoolFetchInterval`, update `resolveRepoOptions` |
| `src/database.js` | Add `worktree_pool` schema, migration 37, bump `CURRENT_SCHEMA_VERSION` to 37, add `WorktreePoolRepository` class, `generatePoolWorktreeId`, add `WorktreeRepository.switchPR` method, modify `WorktreeRepository.findStale` to exclude pool worktrees |
| `src/setup/pr-setup.js` | Update imports (rename functions), add pool mode branch in `setupPRReview` |
| `src/main.js` | Update imports (rename functions), add `startPoolBackgroundFetches`, wire up `worktreePoolUsage.onIdle` callback |
| `src/git/worktree.js` | Modify `cleanupStaleWorktrees` to skip pool worktrees (or rely on modified `findStale` query) |
| `src/routes/worktrees.js` | Add pool protection in `deleteReviewById`, add `PoolExhaustedError` handling in create route, add pool check in stale record cleanup |
| `src/routes/setup.js` | Add `code: 'POOL_EXHAUSTED'` to error event payload |
| `src/routes/pr.js` | Add analysis hold tracking for pool worktrees (addAnalysis/removeAnalysis) |
| `src/routes/shared.js` | Add helper for removing pool analysis holds |
| `src/ws/server.js` | Add hooks for pool usage tracking on subscribe/unsubscribe to review topics |
| `public/js/index.js` | Handle `POOL_EXHAUSTED` error code with specific dialog |
| `public/setup.html` (or its JS) | Handle `POOL_EXHAUSTED` error code with specific dialog |
| `config.example.json` | Rename `monorepos` to `repos`, add `reset_script`, `pool_size`, `pool_fetch_interval_minutes` examples |
| `examples/shopify.config.json` | Rename `monorepos` to `repos`, add new config keys |
| `tests/utils/schema.js` | Add `worktree_pool` table and indexes |
| `tests/unit/config.test.js` | Add tests for renamed functions, new getters, aliases |
| `tests/integration/pr-setup.test.js` | Add pool mode tests |
| `tests/integration/routes.test.js` | Add `worktree_pool` to schema if inline |

---

## 12. Implementation Phases

This feature is large. Suggested implementation order, where each phase is independently shippable:

**Phase A: Config rename (`monorepos` → `repos`)** — Sections 1
- Purely mechanical rename with backward-compatible alias
- No behavior change, just naming
- Can be merged and released independently

**Phase B: Database + pool core** — Sections 2, 3, 4
- New config keys, new table, `WorktreePoolManager`
- The core creation/switching logic
- Requires pool to be functional end-to-end (create + switch + acquireForPR)
- Integration into `setupPRReview`

**Phase C: Usage tracking + cleanup protection** — Sections 5, 6
- `WorktreePoolUsageTracker`, WS integration, analysis holds
- Cleanup exemptions across all 5 paths
- Without this, pool worktrees could be evicted while in use or cleaned up on restart

**Phase D: Background fetch + error UI** — Sections 7, 8
- Periodic fetch interval
- Pool exhausted dialog
- Startup recovery

Phases B and C are tightly coupled (you need usage tracking to safely evict pool worktrees). Phases A and D are independent.

---

### Files NOT Modified
- `src/git/worktree-lock.js` — The existing lock manager is for stack analysis. Pool usage tracking is a separate concern handled by the new `worktree-pool-usage.js`. The two systems do not interact: `worktree-lock.js` guards against concurrent stack analysis operations, while pool usage tracks review sessions and PR analysis. No changes needed.
- `src/setup/stack-setup.js` — Stack analysis does NOT use pool worktrees (design decision). No changes needed.
- `src/routes/stack-analysis.js` — Same as above.
- `src/local-review.js` — Local reviews do not use pool worktrees. No changes needed.
