# Programmatic Context Ranges in @pierre/diffs

## Context

After the hunk expansion work, @pierre/diffs files support expanding collapsed gaps when full file contents are loaded (`isPartial: false`). But the expansion model only reveals lines contiguously from a hunk boundary — you can't show lines 150–155 without also revealing everything between the nearest hunk and line 150.

The pair-review app needs to programmatically expose arbitrary non-contiguous line ranges in diff files. Use cases:
- AI suggestions targeting lines deep inside a collapsed gap
- Auto-context when a user comments on a line outside the visible diff
- Chat-referenced lines that need to be visible for navigation

Currently `expandForSuggestion` (pr.js:2730) short-circuits for pierre/diffs files — it assumes annotations in collapsed regions are "always visible," which is wrong. The library can't render annotation DOM for lines that don't exist in the rendered output.

## How @pierre/diffs Internals Work (Relevant Subset)

**FileDiffMetadata** is the data structure that drives rendering. It contains:
- `hunks[]` — array of hunk objects, sorted by line number
- `additionLines[]` / `deletionLines[]` — full file content as line arrays (populated when `isPartial: false`)
- `isPartial` — `false` means full file content is available, enabling expansion

Each hunk has:
- `additionStart`, `deletionStart` — 1-indexed line numbers in new/old file
- `additionCount`, `deletionCount` — total lines covered (context + changes)
- `additionLines`, `deletionLines` — count of actual `+`/`-` lines (0 for context-only)
- `additionLineIndex`, `deletionLineIndex` — 0-indexed pointer into the full file arrays
- `collapsedBefore` — count of lines hidden in the gap above this hunk
- `hunkContent[]` — array of `ContextContent` and `ChangeContent` blocks
- `splitLineStart`, `splitLineCount`, `unifiedLineStart`, `unifiedLineCount` — rendering position accumulators
- `hunkSpecs`, `hunkContext` — hunk header text

**render()** accepts `fileDiff` directly (line 294 of FileDiff.js): `if (fileDiff != null) this.fileDiff = fileDiff;`. This bypasses `parseDiffFromFile` — the library uses whatever metadata you give it. When `fileDiff` is a new object, `diffDidChange` triggers a full re-render.

**A context-only hunk is valid.** The parser naturally produces them for unified diff lines prefixed with ` ` (space). A hunk with `additionLines: 0, deletionLines: 0` and only `ContextContent` blocks renders correctly — it just shows unchanged lines.

**parseDiffFromFile throws for identical files.** So we can't use the `oldFile`/`newFile` path for context-only files. But we can construct `FileDiffMetadata` manually and pass it via `fileDiff`.

## Approach

Build a utility that merges context-only hunks into an existing `FileDiffMetadata`. The merged metadata is passed directly to `render({ fileDiff })`, bypassing `parseDiffFromFile`. Store the original (unmerged) metadata and context ranges in `fileState` so the merge can be recomputed when ranges change or file contents upgrade.

## Implementation

### 1. Store File Contents in fileState — `pierre-bridge.js`

`upgradeFileContents` currently passes `oldFile`/`newFile` to `instance.render()` but doesn't store them. After upgrade, the instance holds them as `instance.deletionFile` and `instance.additionFile`, but these are the library's internal state, not ours.

**In `upgradeFileContents`** (line ~290), after the `render()` call succeeds, store the file contents and the upgraded metadata on `fileState`:

```js
upgradeFileContents(fileName, oldFile, newFile) {
  const fileState = this.files.get(fileName);
  if (!fileState || !fileState.instance) return false;
  const rendered = fileState.instance.render({
    oldFile,
    newFile,
    lineAnnotations: fileState.annotations,
    containerWrapper: fileState.container,
  });
  if (rendered) {
    fileState.oldFile = oldFile;
    fileState.newFile = newFile;
    // Snapshot the upgraded metadata (before any context ranges are merged)
    fileState.baseMetadata = fileState.instance.fileDiff;
    // Re-apply context ranges if any were queued before upgrade
    if (fileState.contextRanges?.length) {
      this._applyContextRanges(fileName);
    }
  }
  return rendered;
}
```

Also initialize `contextRanges` and `baseMetadata` in `renderFile` (line ~266, in the fileState object):

```js
const fileState = {
  instance, metadata, container, patch, annotations,
  diffPositions, formElements, shadowHost: null,
  // Context range support
  oldFile: null,
  newFile: null,
  baseMetadata: null,   // metadata before context range merging
  contextRanges: [],     // [{startLine, endLine}] in NEW file coords
};
```

### 2. Context Metadata Builder — `pierre-context.js` (new module)

New file: `public/js/modules/pierre-context.js`

Exports a single function:

```js
/**
 * Merge context-only hunks into existing FileDiffMetadata.
 * @param {FileDiffMetadata} baseMetadata - Original metadata (with real diff hunks)
 * @param {Array<{startLine: number, endLine: number}>} ranges - Line ranges in NEW file coords
 * @returns {FileDiffMetadata} New metadata object with original + context hunks
 */
function mergeContextRanges(baseMetadata, ranges)
```

**Algorithm:**

1. **Normalize ranges**: Sort by `startLine`, merge overlapping/adjacent ranges.

2. **Compute the old↔new offset map** from existing hunks. Between consecutive hunks, the offset changes by `(hunk.additionLines - hunk.deletionLines)` (count of `+` lines minus `-` lines). For a new-file line `N` in a gap between hunks, `oldLine = N - cumulativeOffset`.

3. **Clip ranges**: Remove any range portions that overlap with existing hunk spans (already visible). Split ranges that span across multiple gaps. Clamp to file length (`baseMetadata.additionLines.length`).

4. **Build context-only hunks**: For each clipped range `[newStart, newEnd]`:
   ```js
   {
     collapsedBefore: 0,  // computed later
     deletionStart: oldStart,
     deletionCount: rangeLen,
     deletionLines: 0,
     deletionLineIndex: oldStart - 1,
     additionStart: newStart,
     additionCount: rangeLen,
     additionLines: 0,
     additionLineIndex: newStart - 1,
     hunkContent: [{
       type: 'context',
       lines: rangeLen,
       deletionLineIndex: oldStart - 1,
       additionLineIndex: newStart - 1,
     }],
     hunkSpecs: `@@ -${oldStart},${rangeLen} +${newStart},${rangeLen} @@`,
     hunkContext: '',
     splitLineCount: rangeLen,
     splitLineStart: 0,   // computed later
     unifiedLineCount: rangeLen,
     unifiedLineStart: 0, // computed later
     noEOFCRAdditions: false,
     noEOFCRDeletions: false,
   }
   ```

5. **Merge and sort** all hunks (original + context-only) by `additionStart`.

6. **Recompute derived fields** for the merged hunk list:
   - `collapsedBefore` for each hunk: `hunk.additionStart - 1 - previousHunkEnd` where `previousHunkEnd` is the previous hunk's `additionStart + additionCount - 1` (or 0 for the first hunk).
   - Cumulative `splitLineStart`, `unifiedLineStart`, `splitLineCount`, `unifiedLineCount` — walk the hunk list, accumulating `collapsedBefore + hunkLineCount` for each.
   - File-level `splitLineCount`, `unifiedLineCount` — sum of all hunk contributions + trailing collapsed lines.

7. **Return new `FileDiffMetadata` object** (shallow copy of baseMetadata with replaced `hunks`, `splitLineCount`, `unifiedLineCount`). Preserve `additionLines`, `deletionLines`, `isPartial`, `name`, `type`, `cacheKey`.

**Edge cases:**
- Range entirely within an existing hunk → skip (already visible)
- Range partially overlapping a hunk → clip to the non-overlapping portion
- Range beyond EOF → clamp `endLine` to `baseMetadata.additionLines.length`
- Empty ranges after clipping → skip
- No ranges at all → return baseMetadata unchanged

### 3. PierreBridge Method — `addContextRanges` / `_applyContextRanges`

**`addContextRanges(fileName, ranges)`** — public API:

```js
addContextRanges(fileName, ranges) {
  const fileState = this.files.get(fileName);
  if (!fileState || !fileState.instance) return false;

  // Merge with existing context ranges (deduplicate)
  const existing = fileState.contextRanges || [];
  fileState.contextRanges = mergeOverlapping([...existing, ...ranges]);

  // If file contents aren't loaded yet, ranges will be applied in upgradeFileContents
  if (!fileState.baseMetadata) return false;

  return this._applyContextRanges(fileName);
}
```

**`_applyContextRanges(fileName)`** — internal, applies stored ranges:

```js
_applyContextRanges(fileName) {
  const fileState = this.files.get(fileName);
  if (!fileState?.baseMetadata || !fileState.contextRanges?.length) return false;

  const merged = mergeContextRanges(fileState.baseMetadata, fileState.contextRanges);

  // Clear stale expansion state — hunk indices have shifted
  fileState.instance.hunksRenderer.expandedHunks.clear();

  return fileState.instance.render({
    fileDiff: merged,
    lineAnnotations: fileState.annotations,
    containerWrapper: fileState.container,
  });
}
```

**`removeContextRanges(fileName, ranges)`** — remove specific ranges:

```js
removeContextRanges(fileName, ranges) {
  const fileState = this.files.get(fileName);
  if (!fileState) return false;

  // Remove matching ranges from fileState.contextRanges
  fileState.contextRanges = subtractRanges(fileState.contextRanges, ranges);

  if (!fileState.baseMetadata) return false;
  if (fileState.contextRanges.length === 0) {
    // Restore original metadata
    fileState.instance.hunksRenderer.expandedHunks.clear();
    return fileState.instance.render({
      fileDiff: fileState.baseMetadata,
      lineAnnotations: fileState.annotations,
      containerWrapper: fileState.container,
    });
  }
  return this._applyContextRanges(fileName);
}
```

**`clearContextRanges(fileName)`** — remove all context ranges for a file.

### 4. Integration — `expandForSuggestion` / `ensureLinesVisible`

**`expandForSuggestion`** (pr.js:2730): Replace the short-circuit that assumes pierre/diffs annotations are "always visible":

```js
// Before (wrong — collapsed lines have no DOM):
if (this.pierreBridge && this.pierreBridge.files.has(file)) {
  return true;
}

// After:
if (this.pierreBridge && this.pierreBridge.files.has(file)) {
  const padding = 3;
  const range = {
    startLine: Math.max(1, lineStart - padding),
    endLine: lineEnd + padding,
  };
  this.pierreBridge.addContextRanges(file, [range]);
  return true;
}
```

**`ensureLinesVisible`** (pr.js:2813): Update the pierre/diffs branch similarly:

```js
if (this.pierreBridge && this.pierreBridge.files.has(file)) {
  if (!this.pierreBridge.isLineVisible(file, line_start, resolvedSide)) {
    this.pierreBridge.addContextRanges(file, [{
      startLine: line_start,
      endLine: line_end || line_start,
    }]);
  }
  continue;
}
```

**`findHiddenSuggestions`** (suggestion-manager.js:178): Replace the skip that assumes visibility:

```js
// Before:
if (this.prManager.pierreBridge?.files.has(file)) {
  continue; // Skip - pierre/diffs handles visibility
}

// After:
if (this.prManager.pierreBridge?.files.has(file)) {
  // Check if line is actually visible via isLineVisible
  if (!this.prManager.pierreBridge.isLineVisible(file, line, side)) {
    hiddenItems.push({ file, line, lineEnd, side });
  }
  continue;
}
```

### 5. Protect Against Upgrade Overwriting Ranges

When `upgradeFileContents` is called, it triggers `parseDiffFromFile` inside the library, which replaces `instance.fileDiff` with fresh metadata that doesn't include context hunks. The stored `baseMetadata` and `contextRanges` handle this — `upgradeFileContents` (step 1) snapshots the new base and re-applies ranges.

If `addContextRanges` is called *before* file contents are loaded (`baseMetadata` is null), the ranges are stored in `fileState.contextRanges` and applied later when `upgradeFileContents` runs. This handles the race where suggestions arrive before file content fetches complete.

## Hazards

- **Hunk index shift**: Inserting context-only hunks changes the indices of all subsequent hunks. The `expandedHunks` Map in `DiffHunksRenderer` keys by hunk index. Must clear the Map before re-rendering with merged metadata, otherwise expansions apply to wrong hunks.

- **`hunksRenderer.expandedHunks` is a private property.** Accessing it from PierreBridge crosses the library boundary. This is fine in practice (JS has no access control), but if the library updates and renames the field, it breaks. Document this coupling.

- **Old↔new coordinate offset**: For files with insertions/deletions, old and new line numbers diverge. The offset computation in `mergeContextRanges` must account for the cumulative `additionLines - deletionLines` of all preceding hunks. A bug here renders context from wrong lines.

- **`expandForSuggestion` has two callers**: called directly from `displayAISuggestions` (via `findHiddenSuggestions` loop, suggestion-manager.js:300) and from `ensureLinesVisible` (pr.js:2838). Both paths need updating.

- **`findHiddenSuggestions` changes behavior**: Currently returns empty for pierre/diffs files. After the change, it may return items, which triggers `expandForSuggestion`. Verify the downstream path handles `addContextRanges` correctly and doesn't loop.

- **`upgradeFileContents` timing**: `_upgradeFilesWithContents` runs asynchronously after initial render. `displayAISuggestions` also runs asynchronously after analysis completes. If suggestions arrive before file contents, `addContextRanges` stores ranges but can't apply them yet. The deferred application in `upgradeFileContents` handles this, but verify the render order is correct (suggestions should still be re-rendered after content upgrade).

- **Annotation re-rendering**: When `_applyContextRanges` calls `render({ fileDiff: merged })`, annotations are passed via `lineAnnotations`. The library re-renders them. Verify annotations on context-range lines render correctly (they're context lines, not change lines — `side` mapping must be correct).

- **`baseMetadata` must be the post-upgrade metadata**, not the initial patch-only metadata. The patch-only metadata has `isPartial: true` and no full line arrays. Context ranges need `isPartial: false` with populated `additionLines`/`deletionLines`. The snapshotting in `upgradeFileContents` handles this.

## Files to Modify

- `public/js/modules/pierre-context.js` — **new**: `mergeContextRanges`, range normalization utilities
- `public/js/modules/pierre-bridge.js` — `addContextRanges`, `_applyContextRanges`, `removeContextRanges`, `clearContextRanges`; update `upgradeFileContents` to store file contents and baseMetadata; update `renderFile` fileState shape
- `public/js/pr.js` — update `expandForSuggestion` and `ensureLinesVisible` pierre/diffs branches
- `public/js/modules/suggestion-manager.js` — update `findHiddenSuggestions` pierre/diffs branch

## Verification

1. `npm test` — existing tests still pass
2. Unit tests for `mergeContextRanges`:
   - Single range in a gap between hunks
   - Multiple non-contiguous ranges
   - Range overlapping an existing hunk (clips correctly)
   - Range at start of file (before first hunk)
   - Range at end of file (after last hunk)
   - Range in file with offset (insertions/deletions shift old↔new coords)
   - Empty/invalid ranges
   - Ranges that merge when overlapping
3. Unit tests for `addContextRanges` / `removeContextRanges`:
   - Ranges applied after upgrade
   - Ranges queued before upgrade, applied on upgrade
   - Ranges removed correctly
4. Manual: open PR with modified file → trigger analysis → verify suggestion on collapsed line is visible
5. Manual: verify hunk expansion buttons still work after context ranges are added
6. Manual: verify expanding a gap adjacent to a context range works correctly
7. E2E: `npm run test:e2e` for regression
