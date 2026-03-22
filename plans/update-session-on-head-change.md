# Plan: Allow updating existing review session when HEAD SHA changes (#380)

## Context

For **non-branch-scoped** local reviews, when HEAD SHA changes (user makes a commit), the refresh endpoint creates a new session and the dialog offers only "Switch to New Session" or "Stay on Current Session" (stale diff). There's no way to keep the existing session (comments, suggestions, chat history) and update the diff.

Branch-scoped reviews already handle this correctly — they silently update the SHA and continue. No changes needed for branch scope.

## Changes

### 1. Backend: Modify refresh endpoint for non-branch scope

**File:** `src/routes/local.js` — `POST /api/local/:reviewId/refresh` (lines 1308–1430)

**Remove** the non-branch-scope block (lines 1361–1384) that auto-creates a new session. Keep the branch-scope block (lines 1356–1360) as-is.

When HEAD changed on non-branch scope:
- Do NOT create a new session
- Do NOT persist the new diff (preserve old diff for cancel option)
- Return `headShaChanged: true` without `sessionChanged` or `newSessionId`

Specifically:
- Remove `sessionChanged` variable and `newSessionId` variable
- Remove the entire `else` block that calls `upsertLocalReview`
- Keep `if (hasBranch) { updateLocalHeadSha... }` as-is
- Conditional diff persistence: only call `setLocalReviewDiff()` and `saveLocalDiff()` when `!headShaChanged || hasBranch`
- Response: remove `sessionChanged` and `newSessionId` fields

### 2. Backend: New endpoint `POST /api/local/:reviewId/resolve-head-change`

**File:** `src/routes/local.js` (add after the refresh endpoint, ~line 1431)

Request body: `{ action: 'update' | 'new-session', newHeadSha: string }`

**`action: 'update'`:**
1. Fetch review, validate
2. Check for UNIQUE conflict: `getLocalReview(path, newHeadSha, headBranch)` — if a different session exists at that tuple, return `{ success: true, action: 'redirect', sessionId }` so frontend can redirect
3. Call `updateLocalHeadSha(reviewId, newHeadSha)`
4. Re-compute diff via `generateScopedDiff()` + `computeScopedDigest()`, persist via `setLocalReviewDiff()` + `saveLocalDiff()`
5. Return `{ success: true, action: 'updated' }`

**`action: 'new-session'`:**
1. Read current review's scope, path, baseBranch
2. Get current branch + repository name from git
3. Create new session via `upsertLocalReview()` with new SHA (old session keeps its old SHA — no index conflict since SHAs differ)
4. Return `{ success: true, action: 'new-session', newSessionId }`

All imports (`generateScopedDiff`, `computeScopedDigest`, `setLocalReviewDiff`, `getHeadSha`, `getCurrentBranch`, `getRepositoryName`, `getShaAbbrevLength`, `includesBranch`, `DEFAULT_SCOPE`) are already available in the file.

### 3. Frontend: Rewrite non-branch HEAD-change dialog in `refreshDiff()`

**File:** `public/js/local.js` — `refreshDiff()` (lines 639–762)

Add optional `opts = {}` parameter: `async refreshDiff(opts = {})`.

Replace the current `if (result.sessionChanged && result.newSessionId)` block (lines 664–706) with:

```javascript
if (result.headShaChanged) {
  const LS = window.LocalScope;
  const hasBranch = LS ? LS.scopeIncludes(this.scopeStart, this.scopeEnd, 'branch') : false;

  if (!hasBranch && !opts.silent) {
    // Non-branch scope: show 3-option dialog
    const dialogResult = await window.confirmDialog.show({
      title: 'HEAD Has Changed',
      message: `A new commit was detected (${origSha} → ${newSha}). ...`,
      confirmText: 'Update This Session',
      confirmClass: 'btn-primary',
      secondaryText: 'Start New Session',
      cancelText: 'Keep Current Diff'
    });

    if (dialogResult === 'confirm') {
      // Call resolve-head-change with action='update'
      // Then continue to loadLocalDiff() etc.
    } else if (dialogResult === 'secondary') {
      // Call resolve-head-change with action='new-session'
      // Redirect to new session
      return;
    } else {
      // Cancel: keep old diff, show info toast, early return
      return;
    }
  } else if (!hasBranch && opts.silent) {
    // Auto-update (no user data to protect)
    // Call resolve-head-change with action='update'
  }
  // Branch scope: backend already updated — fall through to loadLocalDiff()
}
```

Move `_hideStaleBadge()`, success toast, `loadLocalDiff()`, and comment re-anchoring into the successful update/normal-refresh paths (not unconditionally at end).

Chat notifications: only fire when the user picks "Update" or on normal (non-HEAD-change) refresh. Not on cancel or new-session redirect.

### 4. Frontend: Silent auto-refresh on page load

**File:** `public/js/local.js` — `_checkLocalStalenessOnLoad()` (line 807)

Change `await this.refreshDiff()` to `await this.refreshDiff({ silent: true })`. When there's no user data to protect, auto-update without showing a dialog.

### 5. ConfirmDialog: Add `cancelText` support

**File:** `public/js/components/ConfirmDialog.js` — `show()` method (~line 159)

Add after secondary button setup:
```javascript
const cancelBtn = this.modal.querySelector('.modal-footer [data-action="cancel"]');
if (cancelBtn) {
  cancelBtn.textContent = options.cancelText || 'Cancel';
}
```

### 6. Tests

**File:** `tests/integration/local-sessions.test.js`

Add tests for `POST /api/local/:reviewId/resolve-head-change`:
- `action: 'update'` — updates SHA, returns `{ action: 'updated' }`
- `action: 'update'` with UNIQUE conflict — returns `{ action: 'redirect', sessionId }`
- `action: 'new-session'` — creates new session, returns ID
- Invalid/missing reviewId → 400/404
- Missing/invalid action → 400
- Verify modified refresh endpoint returns `headShaChanged` without `sessionChanged`

### 7. Changeset

`.changeset/<name>.md` — minor bump.

## Hazards

1. **`POST /api/local/start`** (lines 326–475) also manages sessions on app startup. Not changed — continues to work as-is.

2. **UNIQUE index** `(local_path, local_head_sha, local_head_branch)`: `resolve-head-change` `action: 'update'` MUST check for conflicts before calling `updateLocalHeadSha()`.

3. **Diff not persisted on cancel**: Refresh skips `setLocalReviewDiff` for non-branch HEAD changes. If user cancels and refreshes again, HEAD is still different → dialog re-appears. Correct behavior.

4. **`_checkLocalStalenessOnLoad` auto-refresh** (line 807): `{ silent: true }` prevents dialog when there's no user data. Without this, a dialog would show on page load with nothing to protect.

5. **Other `setLocalReviewDiff` callers** (lines 447, 743, 868, 1519, 1770): In other endpoints — not affected.

## Verification

1. `npm test` — existing tests pass
2. New integration tests for `resolve-head-change` endpoint pass
3. Manual: non-branch review → commit → Refresh → 3-button dialog → test all 3 options
4. Manual: branch-scoped review → commit → Refresh → silently updates (no dialog)
5. Manual: page load with stale HEAD and no session data → auto-updates (no dialog)
6. `npm run test:e2e`
