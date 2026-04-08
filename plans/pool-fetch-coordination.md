# Pool Fetch Coordination Across Server Instances

## Context
Multiple pair-review server instances share the same SQLite database and manage the same worktree pools. Pool worktrees for the same repo share a single `.git` object store, so concurrent `git fetch` operations contend on the same lock files and one will fail. The current per-worktree `last_fetched_at` check doesn't prevent two servers from fetching the same repo simultaneously.

## Approach
Add `pool_fetch_started_at` and `pool_fetch_finished_at` columns to `repo_settings`. Before fetching for a repo, a server checks whether another fetch is in progress (started but not finished). If so, it skips that repo. A stale guard (10 minutes) handles crashed servers that never wrote `finished_at`.

The coordination is per-repo, not per-worktree, because worktrees share the same git object store.

## Hazards
- `startPoolBackgroundFetches` in `src/main.js` is the only caller of the background fetch loop. No other code paths to update.
- `RepoSettingsRepository` has a `getRepoSettings` / `saveRepoSettings` upsert pattern, but we should add focused methods rather than overloading `saveRepoSettings` with fetch timestamps.
- Repos discovered only via config (not in DB) won't have a `repo_settings` row yet — need to upsert on first fetch attempt.
- The `allRepoSettings` query at line 1161 of `main.js` selects specific columns — needs to include the new columns.

## Changes

### 1. Migration (version 41) — `src/database.js`
- Bump `CURRENT_SCHEMA_VERSION` to 41
- Add migration 41: `ALTER TABLE repo_settings ADD COLUMN pool_fetch_started_at TEXT` and `pool_fetch_finished_at TEXT`

### 2. Schema — `src/database.js`
- Add `pool_fetch_started_at TEXT` and `pool_fetch_finished_at TEXT` to the `CREATE TABLE repo_settings` statement

### 3. RepoSettingsRepository — `src/database.js`
Add two new focused methods (following the `setLocalPath` pattern):

- `markFetchStarted(repository)` — upserts `pool_fetch_started_at = now`. Creates the row if it doesn't exist.
- `markFetchFinished(repository)` — updates `pool_fetch_finished_at = now`.
- `isFetchInProgress(repository, staleGuardMs = 600000)` — returns true if `started_at > finished_at` (or `finished_at` is null) AND `started_at` is within the stale guard window.

### 4. Background fetch loop — `src/main.js`
- Update the `allRepoSettings` query to also select `pool_fetch_started_at, pool_fetch_finished_at`
- Create a `RepoSettingsRepository` instance at the start of the tick
- Before the worktree loop for each repo: call `isFetchInProgress(repoName)` — if true, skip with a log message
- Before the first worktree fetch: call `markFetchStarted(repoName)`
- After all worktrees for that repo are fetched (or on error): call `markFetchFinished(repoName)` in a finally block

### 5. Test schema — `tests/utils/schema.js`
- Add `pool_fetch_started_at TEXT` and `pool_fetch_finished_at TEXT` to the `repo_settings` table

### 6. Tests — `tests/unit/` or `tests/integration/`
- Unit test for `isFetchInProgress`: in-progress, finished, stale, no row
- Unit test for `markFetchStarted` creating a row when none exists
- Integration or unit test verifying the background fetch loop skips a repo when fetch is in progress

## Verification
- `npm test` — all existing tests pass
- `npx vitest run tests/unit/worktree-pool-lifecycle.test.js` — pool lifecycle tests pass
- `npx vitest run tests/integration/database.test.js` — database tests pass
- Manual: start two servers, observe that only one fetches per repo per tick
