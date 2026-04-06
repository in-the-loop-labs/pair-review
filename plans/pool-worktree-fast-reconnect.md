# Fast reconnect for pool worktrees still associated with the same PR

## Context

When a user navigates away from a PR page, the pool worktree's idle grace timer (30s) fires and marks it `available`. When the user returns to the same PR, the route handler in `setup.js` sees `status !== 'in_use'` and triggers a full re-setup — even though the worktree is still checked out to the right PR and hasn't been reassigned. This defeats the purpose of the pool.

## Root cause

`src/routes/setup.js` lines ~99-105: the check `if (poolEntry && poolEntry.status !== 'in_use')` falls through to full setup. It doesn't distinguish between "available but still on this PR" vs "reassigned to a different PR".

## Fix

**File: `src/routes/setup.js`** (~line 99)

When the pool entry is `available` and `current_pr_number` still matches the requested PR, reclaim it and return the fast path:

```js
if (poolEntry && poolEntry.status !== 'in_use') {
  if (poolEntry.current_pr_number === prNumber) {
    // Still associated with this PR — reclaim without re-setup
    await poolLifecycle.poolRepo.markInUse(poolEntry.id, prNumber);
    // Restore review linkage
    const reviewRepo = new ReviewRepository(db);
    const { review } = await reviewRepo.getOrCreate({ prNumber, repository });
    await poolLifecycle.poolRepo.setCurrentReviewId(poolEntry.id, review.id);
    return res.json({ existing: true, reviewUrl: `/pr/${owner}/${repo}/${prNumber}` });
  }
  // Different PR occupies this slot — fall through to full setup
}
```

**Hazards:**
- `markInUse` and `setCurrentReviewId` already exist on `WorktreePoolRepository` — verify their signatures
- The WebSocket connection that follows will register a session via the usage tracker, canceling any pending idle timer — no additional wiring needed
- `ReviewRepository.getOrCreate` is already imported and used elsewhere in this file

## Verification

- Unit test: add a test in `tests/integration/setup-routes.test.js` that verifies the fast reclaim path (pool entry `available` with matching PR returns `{ existing: true }` without calling `setupPRReview`)
- Manual: open a PR, wait >30s, reopen the same PR — should be instant
