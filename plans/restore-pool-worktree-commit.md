# Restore pool worktrees to previously-reviewed commit

## Context

When a pool worktree is recycled and later needs to serve a previously-reviewed PR again, the current code fetches the latest PR state from GitHub and checks out the branch tip. This invalidates any existing analysis results. We want to restore the worktree to the exact commit the user last reviewed, preserving analysis validity. The existing STALE indicator will show when the branch has new commits.

Three scenarios:
1. **Fast-reconnect** (pool worktree still on same PR, status=available): Already skips git ops. No changes needed.
2. **Restore** (pr_metadata exists with a stored head_sha): Checkout the stored SHA, skip GitHub refresh, reuse stored diff/metadata.
3. **Fresh** (no pr_metadata or fallback): Full setup as today.

## Hazards

- `setupPRReview` is called from `setup.js` route and indirectly from CLI startup (`main.js`). Both paths must support `restoreMetadata`.
- `storePRData` creates worktree records, review records, AND pr_metadata in one transaction. In restore mode we skip it entirely and handle review creation separately — must not miss the review record.
- `_switchPoolWorktree` rolls back pool entry to `available` on failure. If restore SHA checkout fails and we retry fresh, the pool entry is available for re-acquisition, but there's a race window where another request could grab it. Acceptable — retry would get a different slot.
- `_refreshPoolWorktree` calls `worktreeManager.refreshWorktree` which fetches latest. Must short-circuit when worktree HEAD already matches target SHA.
- `createWorktreeForPR` in `worktree.js` also checks out the ref tip (not SHA). Same change needed for non-pool path.

## Changes

### 1. `src/routes/setup.js` — Pass stored metadata to setupPRReview

Expand the `existingPR` query (line 82-86) to also fetch `pr_data`:

```js
const existingPR = await queryOne(
  db,
  'SELECT id, pr_data FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
  [prNumber, repository]
);
```

Before the async setup block (line 120), parse and pass through:

```js
let restoreMetadata = null;
if (existingPR && existingPR.pr_data) {
  try {
    const parsed = JSON.parse(existingPR.pr_data);
    if (parsed.head_sha) {
      restoreMetadata = parsed;
    }
  } catch (e) {
    logger.warn(`Could not parse stored pr_data for ${repository} #${prNumber}`);
  }
}
```

Pass `restoreMetadata` to `setupPRReview` call (line 125).

### 2. `src/setup/pr-setup.js` — Restore mode in orchestrator

Accept `restoreMetadata` in `setupPRReview` signature (line 390).

**When `restoreMetadata` is present:**
- Skip GitHub API verify + fetch steps (use `restoreMetadata` as `prData`)
- Still run `findRepositoryPath` (need the local repo to create/switch worktrees)
- Still run worktree acquisition (`acquireForPR`) — prData.head_sha is now the stored SHA
- Skip sparse-checkout expansion (stored diff already reflects the old checkout)
- Skip diff generation (already in stored pr_data)
- Skip `storePRData` (metadata is already correct for this commit)
- Create review record separately via `ReviewRepository.getOrCreate`
- Set pool review owner via `poolLifecycle.setReviewOwner`

**Fallback:** Wrap the worktree acquisition in a try/catch. If it fails with a SHA-not-found error, retry `setupPRReview` without `restoreMetadata` (fresh mode). Helper function `isShaNotFoundError(err)` checks for git error messages like "did not match any", "reference is not a tree", "bad object".

Rough structure:
```js
const isRestore = !!(restoreMetadata && restoreMetadata.head_sha);
let prData;

if (isRestore) {
  prData = restoreMetadata;
  progress({ step: 'verify', status: 'completed', message: 'Restoring previous review state.' });
  progress({ step: 'fetch', status: 'completed', message: 'Using stored PR data.' });
} else {
  // existing GitHub verify + fetch
}

// findRepositoryPath (unchanged)
// worktree acquisition (unchanged — prData.head_sha drives the checkout)

if (isRestore) {
  // Skip sparse, diff, storePRData
  // Create review record, set pool review owner, register repo path
  progress({ step: 'store', status: 'completed', message: 'Restored to previous review state.' });
  return { reviewUrl, title: prData.title };
} else {
  // existing sparse, diff, storePRData flow
}
```

### 3. `src/git/worktree-pool-lifecycle.js` — SHA-targeted checkout

**`_switchPoolWorktree` (line 252-253):** Replace ref-based checkout with SHA-based:

```js
// Checkout specific head SHA (stored SHA in restore mode, latest in fresh mode)
const targetSha = prData.head?.sha || prData.head_sha;
if (targetSha) {
  await git.checkout([targetSha]);
} else {
  await git.checkout([`refs/remotes/${remoteName}/pr-${prInfo.prNumber}`]);
}
```

The fetch on line 242 still runs (needed to ensure the SHA's objects are in the local repo). If the SHA doesn't exist, `git checkout` throws, the catch block rolls back the pool entry to available, and the error propagates to the fallback handler in `setupPRReview`.

**`_refreshPoolWorktree` (line 327-350):** Add early return when worktree HEAD already matches target:

```js
async _refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData) {
  const targetSha = prData.head?.sha || prData.head_sha;
  if (targetSha) {
    try {
      const git = this._simpleGit(poolEntry.path);
      const currentHead = (await git.revparse(['HEAD'])).trim();
      if (currentHead === targetSha) {
        logger.info(`Pool worktree ${poolEntry.id} already at target SHA ${targetSha.slice(0, 8)}, skipping refresh`);
        await this._poolRepo.markInUse(poolEntry.id, prInfo.prNumber);
        return { worktreePath: poolEntry.path, worktreeId: poolEntry.id };
      }
    } catch (err) {
      logger.warn(`Could not check HEAD of pool worktree ${poolEntry.id}: ${err.message}`);
    }
  }
  // ... existing refresh logic
}
```

### 4. `src/git/worktree.js` — SHA-targeted checkout for non-pool path

In `createWorktreeForPR` (around line 463-465), change:
```js
await worktreeGit.checkout([`${remote}/pr-${prInfo.number}`]);
```
to:
```js
const targetSha = prData.head_sha;
if (targetSha) {
  await worktreeGit.checkout([targetSha]);
} else {
  await worktreeGit.checkout([`${remote}/pr-${prInfo.number}`]);
}
```

This is a correctness improvement for all paths — the worktree is now guaranteed to be at exactly the commit described by prData, not whatever the ref happens to point to after fetch.

### 5. Tests

**`tests/unit/worktree-pool-lifecycle.test.js`:**
- `_switchPoolWorktree` checks out prData.head_sha instead of ref
- `_switchPoolWorktree` falls back to ref when no head_sha in prData
- `_switchPoolWorktree` propagates error when SHA doesn't exist (for fallback)
- `_refreshPoolWorktree` skips refresh when worktree HEAD matches target SHA
- `_refreshPoolWorktree` proceeds with refresh when HEAD differs from target

**`tests/unit/pr-setup.test.js`** (or integration):
- `setupPRReview` with `restoreMetadata` skips GitHub API calls
- `setupPRReview` with `restoreMetadata` skips storePRData
- `setupPRReview` falls back to fresh when SHA checkout fails

## Verification

1. Run `npm test` — all existing tests pass
2. Run `npm run test:e2e` — E2E tests pass
3. Manual test: review a PR, navigate away (worktree becomes available/recycled), return — verify analysis results preserved and STALE indicator works
