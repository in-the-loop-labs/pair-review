# Migration 42: Auto-merge duplicate repo_settings instead of throwing

## Context

Migration 42 (`src/database.js:1769-1833`) adds `COLLATE NOCASE` to the `repo_settings.repository` column via a table rebuild. Currently, if case-duplicate rows exist (e.g., `Owner/Repo` and `owner/repo`), the migration **throws an error and blocks startup entirely**. This migration has never been released, so we can modify it in place.

Users shouldn't be blocked from running pair-review over stale preference data they probably don't care about. Instead, we'll auto-merge duplicates by keeping the most recently updated row, log what was dropped, and write a backup file to `~/.pair-review/` so no data is truly lost.

## Files to modify

- `src/database.js` — Migration 42 (lines 1769-1833)
- `tests/integration/database.test.js` — Add test coverage for migration 42

## Implementation

### 1. Modify migration 42 duplicate handling (`src/database.js`)

Replace the current "detect dupes → throw" block (lines 1803-1807) with:

1. **Detect duplicates** (same query as now)
2. **If duplicates exist:**
   a. For each duplicate group, query all rows, sort by `updated_at DESC`
   b. Keep the first (newest) row, collect the rest as "to delete"
   c. **Write backup file** to `~/.pair-review/migration-42-backup-<ISO-timestamp>.json` containing all deleted rows (use `getConfigDir()` — already imported)
   d. **Log a warning** via `console.log` (matching existing migration logging convention — migrations do NOT use the logger utility) listing: which repos had duplicates, which rows were kept vs removed, and the backup file path
   e. **Delete the duplicate rows** from the original table (before the INSERT...SELECT into the rebuild table)
3. Proceed with the existing rebuild logic

### 2. Add tests (`tests/integration/database.test.js`)

Add a `describe('Migration 42')` block covering:

- **Happy path**: No duplicates — migration completes, table has COLLATE NOCASE
- **Duplicate resolution**: Insert case-duplicate rows, run migration, verify only the newest survives
- **Backup file written**: Verify the backup JSON file is created in the config dir with correct contents
- **Idempotency**: Migration doesn't fail if `repo_settings_rebuild` table already exists from a prior crash

### Notes

- Use `fs.writeFileSync` (not async) since migrations run synchronously in better-sqlite3
- The `fs` import in database.js is currently `require('fs').promises` — will need to also get the sync API (or use `require('fs')` directly for `writeFileSync`)
- Backup filename includes ISO timestamp to avoid collisions if somehow run multiple times
- The `getConfigDir()` function is already imported in database.js line 5

## Verification

1. `npm test` — all existing tests pass
2. New migration 42 tests pass with duplicate auto-merge behavior
3. Manual sanity check: insert case-dupes into a test DB, run migration, verify backup file and merged result
