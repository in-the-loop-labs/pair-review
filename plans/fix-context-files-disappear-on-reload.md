# Fix: Context files disappear from diff panel on reload

## Context

When a review is reloaded (e.g., local diff changes due to staging), context files persist in the File Navigator sidebar but vanish from the diff panel. They should remain visible in both places until explicitly removed.

**Root cause**: `renderDiff()` (pr.js:855) clears the entire diff container with `innerHTML = ''`, destroying context file DOM elements. But `this.contextFiles` in memory still holds the old records. When `loadContextFiles()` runs next, it compares old IDs vs new IDs and finds them identical — so it renders nothing, since it only renders "new" context files (those not in `oldIds`). The sidebar survives because `rebuildFileListWithContext()` is data-driven, not DOM-dependent.

## Fix

**In `renderDiff()` (public/js/pr.js:889)**: Reset `this.contextFiles = []` before calling `this.loadContextFiles()`. After the DOM is cleared, the in-memory state should match (empty). This makes `loadContextFiles()` treat all DB-persisted context files as "new" and re-render them.

```js
// Line ~889 in renderDiff()
this.contextFiles = [];       // <-- add this line
this.loadContextFiles();
```

**Files to modify**: `public/js/pr.js` (1 line addition)

## Verification

1. Run unit tests: `npm test`
2. Manual test: Add a context file to a local review, then trigger a reload (stage/unstage files to change the diff). Confirm context file remains visible in both File Navigator and diff panel.
3. Run E2E tests: `npm run test:e2e`
