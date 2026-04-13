# Enable Hunk Expansion in @pierre/diffs

## Context

@pierre/diffs hunk separators currently show "X unmodified lines" text but no expand buttons. This is because we only pass parsed patch metadata (`fileDiff`) to `FileDiff.render()`, which sets `isPartial: true`. The library gates expand buttons on `!fileDiff.isPartial` — it needs full file contents (`oldFile`/`newFile`) to have content to expand into.

The fix: pass full file contents to `render()`. The library supports re-rendering — calling `render()` again with `oldFile`/`newFile` after an initial patch-only render works cleanly (detects changes via `areFilesEqual()`, re-renders with full content). This enables a progressive loading strategy: immediate first paint with patches, then upgrade files with contents as fetches complete.

## Implementation

### 1. Config Changes — `pierre-bridge.js`

Add to FileDiff constructor options (line ~195, alongside existing `diffIndicators`, `lineHoverHighlight`, etc.):

```js
expansionLineCount: 20,
collapsedContextThreshold: 5,
```

### 2. Backend Endpoint — `src/routes/reviews.js`

**Route:** `GET /api/reviews/:reviewId/file-contents/:fileName(*)`

Note plural `file-contents` to avoid collision with existing singular `file-content` endpoint.

**Query params:**
- `status` — `added` | `deleted` | `modified` | `renamed` (from `getFileStatus`)
- `oldPath` — for renamed files, the previous filename

**Response:**
```json
{ "fileName": "...", "oldContents": "..." | null, "newContents": "..." | null }
```

Returns string contents (not lines array) since `FileContents.contents` is a string. Either field is `null` when file doesn't exist on that side.

**Status optimization:**
- `added`: skip old file fetch → `oldContents: null`
- `deleted`: skip new file fetch → `newContents: null`
- `modified` / `renamed`: fetch both

**Old file resolution by mode/scope** (key logic):

| Mode | Scope | Old file ref | Git command |
|---|---|---|---|
| PR | — | `base_sha` from `pr_metadata` | `git show <base_sha>:<path>` |
| Local | includes branch | merge-base SHA | `git show <mergeBase>:<path>` |
| Local | staged (no branch) | HEAD | `git show HEAD:<path>` |
| Local | unstaged only | index | `git show :<path>` |

For local mode, use `reviewScope(review)` + `includesBranch()`/`scopeIncludes()` from `src/local-scope.js` to determine which ref to use. Compute merge-base via `findMergeBase(localPath, baseBranch)` from `src/local-review.js` when branch is in scope.

**New file resolution:**
- Local mode: read from filesystem `path.join(localPath, fileName)`
- PR mode: `git show HEAD:<path>` in the worktree (PR branch HEAD)

**Renamed files:** When `oldPath` is provided, use it for the old-side `git show` and `fileName` for the new side.

**Security:** Same `realpath` traversal check as existing `file-content` endpoint. For git show, validate no null bytes in path.

**Error handling:** If git show fails (file didn't exist at that ref), set that side to `null`. If file exceeds 2MB, return `{ tooLarge: true }`.

**Imports needed** (most already available in reviews.js):
- `reviewScope`, `scopeIncludes`, `includesBranch` from `../local-scope`
- `findMergeBase` from `../local-review`

Place after existing `file-content` endpoint (~line 1067).

### 3. PierreBridge Upgrade Method — `pierre-bridge.js`

Add `upgradeFileContents(fileName, oldFile, newFile)` after `renderFile`:

```js
upgradeFileContents(fileName, oldFile, newFile) {
  const fileState = this.files.get(fileName);
  if (!fileState || !fileState.instance) return false;
  return fileState.instance.render({
    oldFile,
    newFile,
    lineAnnotations: fileState.annotations,
    containerWrapper: fileState.container,
  });
}
```

Does NOT recreate the instance — just calls `render()` again. The library detects new content, recomputes the diff via `parseDiffFromFile(oldFile, newFile)`, and re-renders with `isPartial: false`, enabling expand buttons. Existing annotations are preserved by passing `lineAnnotations`.

### 4. Progressive Loading — `pr.js`

Add `_upgradeFilesWithContents(files)` method on PRManager:

1. After `renderDiff()` in both `loadAndDisplayFiles` (pr.js:871) and `loadLocalDiff` (local.js:1518), schedule the upgrade if PierreBridge is active.
2. Use an `AbortController` stored as `this._fileContentsAbort` — abort on re-render (`renderDiff` calls abort before destroying).
3. Split files into two batches:
   - **Visible batch** (first 8 files) — fetch in parallel
   - **Remaining batch** — fetch in parallel after visible batch completes
4. For each file:
   - Skip if `file.binary` or no patch
   - Compute status via `this.getFileStatus(file)`
   - Build URL: `/api/reviews/${reviewId}/file-contents/${encodeURIComponent(file.file)}?status=${status}` + `&oldPath=${encodeURIComponent(file.renamedFrom)}` if renamed
   - On response, call `this.pierreBridge.upgradeFileContents(file.file, oldFile, newFile)` where `oldFile`/`newFile` are `{ name, contents }` objects or `null`
5. For renamed files with `getFileStatus` returning `'modified'`, still send `oldPath=file.renamedFrom` — the backend needs the old path regardless of computed status.

**Abort on re-render:** Add at top of `renderDiff()` (line ~1639):
```js
this._fileContentsAbort?.abort();
this._fileContentsAbort = null;
```

### 5. Local Mode Wiring — `local.js`

After `manager.renderDiff()` at line 1518, call the same method:
```js
if (manager.pierreBridge && !manager.pierreBridge._disabled) {
  manager._upgradeFilesWithContents(sortedFiles);
}
```

## Hazards

- **Unstaged scope gotcha:** For `unstaged..untracked`, old file is the INDEX version (`git show :<path>`), NOT HEAD. Using HEAD would give wrong base when there are staged changes.
- **`renderDiff` destroys all instances** via `pierreBridge.destroyAll()` — must abort in-flight content fetches before this happens, otherwise upgrade callbacks reference dead instances.
- **Renamed files + getFileStatus:** `getFileStatus` returns `'modified'` for renames with content changes, losing the rename info. Send `oldPath` whenever `file.renamedFrom` is truthy, independent of computed status.
- **Existing `file-content` endpoint** (singular) used by legacy context expansion must remain untouched. New endpoint uses plural `file-contents`.

## Files to Modify

- `src/routes/reviews.js` — new endpoint
- `public/js/modules/pierre-bridge.js` — config + `upgradeFileContents`
- `public/js/pr.js` — `_upgradeFilesWithContents`, abort wiring, call site
- `public/js/local.js` — call site after `renderDiff`

## Verification

1. `npm test` — existing tests still pass
2. Unit tests for the new endpoint (scope variants, status optimization, renames, path traversal)
3. Manual: open a local review → verify expand buttons appear on modified files → click expand → verify content is correct
4. Manual: open a PR review → same check
5. Manual: change diff scope in local mode while files are loading → verify no errors
6. E2E: `npm run test:e2e` for regression
