# Support tilde (`~`) in local review path input

## Context

When a user enters a path like `~/my-project` in the local review index page, the path is passed through to `path.resolve()` on the backend, which does **not** expand `~` (that's a shell feature). The path fails validation because no literal `~` directory exists. The CLI entry point doesn't have this problem because the shell expands `~` before it reaches the process arguments.

## Approach

Expand tilde at the earliest backend entry point — the setup route handler — using the existing `expandPath()` utility from `src/config.js`. Also update `expandPath` itself to handle bare `~` (currently it only handles `~/...`).

### Changes

1. **`src/config.js` — `expandPath()`** (line 386-392)
   - Add handling for bare `~` (return `os.homedir()`)
   - Current behavior: `expandPath('~')` returns `'~'` — update to return home directory

2. **`src/routes/setup.js` — `POST /api/setup/local`** (line 146)
   - Import `expandPath` from `../config`
   - Apply `expandPath(targetPath)` before passing to `setupLocalReview()` and the concurrency guard key

3. **`tests/unit/config.test.js`** — Update the existing `expandPath('~')` test (line 277-280) to expect `os.homedir()` instead of `'~'`

4. **`tests/unit/setup-route-tilde.test.js`** (or add to existing test file) — Test that tilde paths are expanded in the setup route

## Hazards

- `expandPath` is used in two other call sites within `src/config.js`: `getMonorepoPath()` (line 403) and `getMonorepoWorktreeDirectory()` (line 428). Both pass config values that are documented as `~/path/to/clone` format — they won't pass bare `~`, so the change is safe.
- The concurrency guard key in setup.js uses `targetPath` raw — must use expanded path for correct deduplication (e.g., `~/foo` and `/Users/x/foo` should be the same key).

## Verification

1. `npm test -- tests/unit/config.test.js` — expandPath tests pass
2. `npm test` — full test suite passes
3. Manual: start pair-review, enter `~/some-repo` in the local path input, confirm it resolves correctly
