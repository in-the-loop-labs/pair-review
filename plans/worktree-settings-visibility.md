# Worktrees Section on Repo Settings Page

## Context

Users have no visibility into worktree pool state. Pool configuration is in a config file, and the only way to see worktree status is the database. This change adds a "Worktrees" section to the Repo Settings page showing pool configuration, listing all worktrees (pool and non-pool), and providing delete actions for cleanup.

---

## Task 1: Database — Add `findAllByRepository` to `WorktreeRepository`

**File**: `src/database.js` (~line 2155, after `listRecent`)

Add method:
```js
async findAllByRepository(repository) {
  return await query(this.db, `
    SELECT id, pr_number, repository, branch, path, created_at, last_accessed_at
    FROM worktrees WHERE repository = ? COLLATE NOCASE
    ORDER BY last_accessed_at DESC
  `, [repository]);
}
```

---

## Task 2: Lifecycle — Add `destroyPoolWorktree` to `WorktreePoolLifecycle`

**File**: `src/git/worktree-pool-lifecycle.js` (after `releaseForDeletion` at line 429)

New method performs a hard destroy (disk + DB), unlike `releaseForDeletion` which merely marks available.

```js
async destroyPoolWorktree(worktreeId, { cancelAnalyses } = {}) {
  // 1. Cancel active analyses via caller-provided callback
  const activeIds = this._usageTracker.getActiveAnalyses(worktreeId);
  if (activeIds.size > 0 && cancelAnalyses) {
    await cancelAnalyses(worktreeId, activeIds);
  }
  // 2. Clear in-memory tracking
  this._usageTracker.clearWorktree(worktreeId);
  // 3. Remove from disk
  const record = await this._worktreeRepo.findById(worktreeId);
  if (record?.path) {
    try {
      const mgr = new this._GitWorktreeManager(this.db);
      await mgr.cleanupWorktree(record.path);
    } catch (err) {
      logger.warn(`Could not clean up pool worktree ${worktreeId}: ${err.message}`);
    }
  }
  // 4. Remove from DB (pool table first, then worktrees)
  await this._poolRepo.delete(worktreeId);
  await this._worktreeRepo.delete(worktreeId);
  logger.info(`Destroyed pool worktree ${worktreeId}`);
}
```

The `cancelAnalyses` callback avoids importing route-level shared state into the lifecycle class. The route handler constructs it using the same pattern as `deleteReviewById` (lines 290-311 of `src/routes/worktrees.js`).

---

## Task 3: API Endpoints

**File**: `src/routes/worktrees.js`

### 3a. `GET /api/repos/:owner/:repo/worktrees`

Aggregates pool config + merged worktree list. For each worktree in `WorktreeRepository.findAllByRepository()`, checks if it's a pool worktree via the pool entries from `findAllForRepo()`, and annotates with pool status/metadata. Checks `fs.access` for `disk_exists`.

Response:
```json
{
  "pool": { "configured": true, "size": 3, "fetch_interval_minutes": 10 },
  "worktrees": [
    {
      "id": "abc",
      "is_pool": true,
      "status": "in_use",
      "pr_number": 42,
      "branch": "feat",
      "path": "/path",
      "last_fetched_at": "...",
      "last_accessed_at": "...",
      "created_at": "...",
      "disk_exists": true
    }
  ]
}
```

### 3b. `DELETE /api/repos/:owner/:repo/worktrees/:worktreeId`

Single worktree delete. Pool worktrees: `destroyPoolWorktree()` with cancel callback. Non-pool: `cleanupWorktree()` + `WorktreeRepository.delete()`.

### 3c. `DELETE /api/repos/:owner/:repo/worktrees` (delete all)

Iterates all worktrees for the repo, deletes each. Returns `{ deleted, failed, errors }` following the `bulk-delete` pattern.

**Imports to add**: `WorktreeRepository`, `getRepoPoolSize`, `getRepoPoolFetchInterval` from `../config`.

---

## Task 4: Frontend HTML

**File**: `public/repo-settings.html` (between line 228 and line 230)

New section container:
```html
<section class="settings-section" id="worktrees-section" style="display: none;">
  <div class="section-header">
    <h2>Worktrees</h2>
    <p class="section-description">
      Manage worktree directories used for reviewing pull requests.
    </p>
  </div>
  <div id="worktrees-content"></div>
</section>
```

Hidden by default, shown by JS when data is loaded.

---

## Task 5: Frontend CSS

**File**: `public/css/repo-settings.css`

New styles for:
- `.worktree-pool-config` — info banner showing pool size/interval
- `.worktree-list` — vertical list container
- `.worktree-item` — row with flexbox: left (pool badge, PR/branch, path), right (status indicator, last-fetched, delete button)
- `.worktree-status-badge` — colored status pills (green=available, amber=in_use, blue=switching)
- `.worktree-pool-badge` / `.worktree-adhoc-badge` — pool vs one-off labels
- `.worktree-delete-btn` — small icon-only danger button
- `.worktree-delete-all-btn` — full-width outline danger button
- `.worktree-empty` — empty state message
- Dark mode overrides via `[data-theme="dark"]`
- Responsive stacking at `max-width: 768px`

---

## Task 6: Frontend JavaScript

**File**: `public/js/repo-settings.js`

### Methods to add:

1. **`loadWorktrees()`** — Fetch `GET /api/repos/${owner}/${repo}/worktrees`, store in `this.worktreeData`, call `renderWorktrees()`
2. **`renderWorktrees()`** — Build HTML for pool config banner + worktree list + delete-all button. Show/hide section based on data.
3. **`deleteWorktree(id)`** — Confirm dialog → `DELETE /api/repos/.../worktrees/:id` → toast → refresh
4. **`deleteAllWorktrees()`** — Confirm dialog with count → `DELETE /api/repos/.../worktrees` → toast → refresh
5. **`formatRelativeTime(iso)`** — Human-readable relative time for timestamps

### Wiring:
- Add `await this.loadWorktrees()` in `init()` after `loadSettings()`
- Add event delegation on `#worktrees-content` in `setupEventListeners()`

---

## Hazards

1. **Deleting in-use pool worktree during active analysis**: `destroyPoolWorktree` cancels analyses first via the callback. The route handler constructs this using the same `killProcesses` / `activeAnalyses` / `broadcastProgress` pattern from `deleteReviewById`. If the callback is omitted, analyses are NOT cancelled — ensure the route always provides it.

2. **Pool count drops below configured `pool_size`**: After deletion, pool has fewer entries than `pool_size`. This is intentional — the pool refills when `acquireForPR` triggers `reserveSlot`. Display a hint in the UI when current count < pool_size.

3. **Concurrent deletion of same worktree**: `WorktreeRepository.delete()` and `WorktreePoolRepository.delete()` are idempotent (DELETE WHERE id = ? is a no-op if row is gone). Second request gets 404 gracefully.

4. **`COLLATE NOCASE` consistency**: All new repository comparisons must use `COLLATE NOCASE`.

5. **Non-pool worktree with active review**: Deleting removes the worktree directory but the review/pr_metadata records remain. The review shows as "cached" in recent reviews. This is correct behavior.

---

## Tests

- **Unit**: `WorktreeRepository.findAllByRepository()`, `WorktreePoolLifecycle.destroyPoolWorktree()` (with mocked deps)
- **Integration**: GET/DELETE endpoints for pool and non-pool scenarios, 404 for unknown IDs
- **E2E**: Navigate to settings, verify worktree section renders, test delete interaction

---

## Verification

1. Configure a repo with `pool_size: 2`, open PRs to create pool worktrees, verify Settings page shows pool config + worktree list
2. Delete a single available pool worktree — verify removed from disk + DB, toast shown
3. Delete an in-use pool worktree — verify analysis cancelled, worktree removed
4. Delete a non-pool worktree — verify removed
5. Delete all — verify all removed, empty state shown
6. Dark mode + responsive layout
7. Run `npm test` and `npm run test:e2e`
