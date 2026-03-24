# Fix: branchAvailable not updated after HEAD SHA change

## Context

When a local review session is open with a non-branch scope (e.g. `unstaged`–`untracked`) and the user commits changes (changing HEAD SHA), the session detects the change and updates the diff. However, the "Branch" stop in the scope selector remains disabled because `branchAvailable` is computed only once during the initial GET `/api/local/:reviewId` load and never recalculated after a HEAD change.

This means the user's committed changes disappear from the unstaged diff, and they cannot expand the scope to include branch changes — the control to do so is greyed out.

## Root Cause

- `branchAvailable` is computed in the GET endpoint (`src/routes/local.js:575-597`) and sent to the frontend once
- The DiffOptionsDropdown is initialized with this value in `public/js/local.js:944-956`
- After HEAD change, `resolve-head-change` endpoint (`src/routes/local.js:1478`) returns `{ success: true, action: 'updated' }` with no `branchAvailable` field
- Frontend's `_resolveHeadChange()` returns a boolean `true`, discarding the response data
- The dropdown's `branchAvailable` setter (line 134 in DiffOptionsDropdown.js) is never called

## Fix

### 1. Extract helper function in `src/routes/local.js`

Extract the `branchAvailable` computation (lines 575-597) into a reusable async helper:

```js
async function checkBranchAvailable(localPath, branchName, scopeStart, config, repositoryName) {
  if (includesBranch(scopeStart)) return true;
  if (!branchName || branchName === 'HEAD' || branchName === 'unknown' || !localPath) return false;
  try {
    const { getBranchCommitCount } = require('../local-review');
    const { detectBaseBranch } = require('../git/base-branch');
    const depsOverride = getGitHubToken(config) ? { getGitHubToken: () => getGitHubToken(config) } : undefined;
    const detection = await detectBaseBranch(localPath, branchName, {
      repository: repositoryName,
      enableGraphite: config.enable_graphite === true,
      _deps: depsOverride
    });
    if (detection) {
      const commitCount = await getBranchCommitCount(localPath, detection.baseBranch);
      return commitCount > 0;
    }
  } catch {
    // Non-fatal
  }
  return false;
}
```

Replace the inline code in the GET endpoint (lines 578-597) with:
```js
let branchAvailable = Boolean(branchInfo) || await checkBranchAvailable(review.local_path, branchName, scopeStart, req.app.get('config') || {}, repositoryName);
```

### 2. Return `branchAvailable` from `resolve-head-change` endpoint

In `src/routes/local.js`, resolve-head-change `action: 'update'` path (~line 1455-1478):
- After updating SHA and recomputing diff, compute `branchAvailable`
- Need `branchName` from `review.local_head_branch` (or `getCurrentBranch(localPath)`)
- Need `repositoryName` from `review.repository`
- Return it in the response: `{ success: true, action: 'updated', branchAvailable }`

### 3. Return `branchAvailable` from `refresh` endpoint

In `src/routes/local.js`, refresh endpoint (~line 1396):
- After diff computation, compute and return `branchAvailable`
- Also add it to the early-return path for HEAD change (line 1372-1380) — the frontend will use it after resolve-head-change, but having it on the initial response is useful too
- Need `branchName` from `review.local_head_branch` or `getCurrentBranch(localPath)`
- Need `repositoryName` from `review.repository`

### 4. Update frontend `_resolveHeadChange()` in `public/js/local.js`

Change `_resolveHeadChange()` (~line 774) to return the response data object instead of just `true`:
```js
// Before: return true;
// After:
return data;  // { success: true, action: 'updated', branchAvailable }
```

### 5. Update frontend `refreshDiff()` in `public/js/local.js`

After `_resolveHeadChange` and `_applyRefreshedDiff`, update the dropdown:
```js
const resolved = await this._resolveHeadChange(result, opts);
if (!resolved) return;
// resolved is now the response object, merge branchAvailable into result
if (resolved.branchAvailable !== undefined) {
  result.branchAvailable = resolved.branchAvailable;
}
```

### 6. Update frontend `_applyRefreshedDiff()` in `public/js/local.js`

At the end of `_applyRefreshedDiff` (~line 818), add dropdown update:
```js
// Update branchAvailable on the dropdown if the backend sent an updated value
if (result.branchAvailable !== undefined && manager.diffOptionsDropdown) {
  manager.diffOptionsDropdown.branchAvailable = result.branchAvailable;
}
```

## Hazards

- `checkBranchAvailable` calls `detectBaseBranch` which may hit GitHub API — keep it non-fatal (try/catch) to avoid blocking the refresh
- `_resolveHeadChange` return type changes from `boolean` to `object|false`. Callers: only `refreshDiff()` at line 672. The truthiness check `if (!resolved)` still works since an object is truthy. But the comparison `resolved === true` would break — verify no such checks exist.
- `_applyRefreshedDiff` is called from `refreshDiff()` and `_handleScopeChange` (via `_applyScopeResult`). The `_applyScopeResult` path calls `loadLocalReview()` which reinitializes the dropdown, so `branchAvailable` gets fresh data there. No issue.

## Files to modify

- `src/routes/local.js` — add helper, update 3 endpoints (GET, refresh, resolve-head-change)
- `public/js/local.js` — update `_resolveHeadChange`, `refreshDiff`, `_applyRefreshedDiff`

## Verification

1. Unit tests for `checkBranchAvailable` helper
2. Integration tests for refresh and resolve-head-change endpoints returning `branchAvailable`
3. Manual or E2E test:
   - Start local review session with default scope (unstaged–untracked)
   - Commit changes
   - Refresh — verify Branch stop becomes available in scope selector
4. Run existing test suites: `npm test`, `npm run test:e2e`
