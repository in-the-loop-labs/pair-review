# Async Background Base Branch Detection

## Context

We just removed `checkBranchAvailable` from the local metadata endpoint critical path, dropping page load from 4.3s to 38ms. However, `detectBaseBranch` (which calls GitHub API) is still needed when the user switches scope to "branch" via the set-scope endpoint (`/api/local/:reviewId/set-scope`, line ~1694). Without pre-caching, that 4-second hit just moves to scope-switch time.

## Approach

After the metadata endpoint sends its response, fire off `detectBaseBranch` in the background using the existing fire-and-forget pattern. Store the result in `local_base_branch` in the database. When set-scope later needs the base branch, check the DB first — if already populated, skip detection entirely.

## Changes

### `src/routes/local.js`

**Metadata endpoint (GET `/api/local/:reviewId`):**
- After `res.json()`, add a fire-and-forget block (same pattern as the `review.loaded` hook at lines 637-650)
- Conditions: scope does NOT include branch, AND `review.local_base_branch` is not already set
- Call `detectBaseBranch(localPath, branchName, { repository, ... })`
- On success, update DB via `reviewRepo.updateLocalScope()` or a direct update with the detected `local_base_branch`
- Log result at info level for observability
- Catch + log errors silently — non-fatal

**Set-scope endpoint (`/api/local/:reviewId/set-scope`, line ~1688):**
- Before calling `detectBaseBranch`, check if `review.local_base_branch` is already populated
- If so, use the cached value instead of re-detecting
- Fall through to live detection only if not cached

### Files
- `src/routes/local.js` — both changes above
- `tests/integration/local-sessions.test.js` — test the set-scope fast path (cached base branch)

## Hazards
- `detectBaseBranch` in `src/git/base-branch.js` is called from: the set-scope handler (local.js ~1694), `detectAndBuildBranchInfo` (local-review.js ~1024), and formerly `checkBranchAvailable` (removed). The background call is a new fourth call site.
- `updateLocalScope` (database.js) is called from the set-scope handler. Verify it can safely update `local_base_branch` independently.
- Race: user could switch scope before background detection completes. The set-scope handler must still fall back to live detection if no cached value exists.

## Verification
1. Load a local review page — metadata should respond fast, logs should show background detection firing after response
2. Switch scope to "branch" — should use cached base branch (no GitHub API delay)
3. Load a review where base branch is already cached — background detection should skip
4. Run `npm test -- tests/integration/local-sessions.test.js`
