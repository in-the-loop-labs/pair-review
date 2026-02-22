# Auto-Add Context File on Non-Diff Comment

## Context

When a comment is created on a file that isn't part of the current diff, the file is invisible in the diff panel. The user must manually add a context file via the API to see it. This should happen automatically — the comment creation endpoint already knows the file path and line range, so it can detect "not in diff" and create the context file entry server-side.

**Discovered via:** Chat-based review created a file-level comment on a file not in the PR diff. The comment existed in the DB but was invisible until a context file was manually added.

## Plan

### 1. Extract `getDiffFileList` to shared utility

**New file:** `src/utils/diff-file-list.js`

Move the `getDiffFileList` function (currently private in `src/routes/context-files.js:30-69`) to a shared utility so both context-files validation and auto-context logic can use it.

**Modify:** `src/routes/context-files.js`
- Remove `getDiffFileList` definition, `promisify`, `exec`, `execPromise` imports
- Import `getDiffFileList` from `../utils/diff-file-list`

### 2. Add repository methods to `ContextFileRepository`

**Modify:** `src/database.js` (class at line 3334)

Add two methods:

- `getByReviewIdAndFile(reviewId, file)` — returns context files for a specific file within a review (avoids fetching all context files). Query filtered by `review_id` and `file`, ordered by `line_start`.
- `updateRange(id, lineStart, lineEnd)` — updates an existing context file's range (for expansion). Returns `boolean` for success.

### 3. Create auto-context utility

**New file:** `src/utils/auto-context.js`

Single exported function: `ensureContextFileForComment(db, review, { file, line_start, line_end })`

Logic:
1. Call `getDiffFileList()` — if file is in the diff, return early (no-op)
2. Compute desired range:
   - **Line-level comment:** `[line_start - 10, line_end + 10]` (clamped to `min=1`, max range 500)
   - **File-level comment:** `[1, 50]`
3. Query existing context files for this file via `getByReviewIdAndFile()`
4. If an existing entry already covers the desired range → no-op
5. If an existing entry exists but doesn't cover → expand it via `updateRange()` (union of ranges, clamped to 500)
6. If no existing entry → create one via `contextFileRepo.add()` with a descriptive label

Returns `{ created: boolean, expanded: boolean, contextFileId?: number }`

### 4. Integrate into comment creation endpoint

**Modify:** `src/routes/reviews.js:139`

After the existing `broadcastReviewEvent` for `comments_changed`, add:

```js
try {
  const result = await ensureContextFileForComment(db, req.review, { file, line_start, line_end });
  if (result.created || result.expanded) {
    broadcastReviewEvent(req.reviewId, { type: 'review:context_files_changed' }, { sourceClientId: req.get('X-Client-Id') });
  }
} catch (err) {
  logger.warn('[AutoContext] Failed:', err.message);
}
```

This runs after `res.json()` has already sent the response, so failures never block comment creation.

### 5. Tests

**Modify:** `tests/unit/context-file-repository.test.js`
- Add tests for `getByReviewIdAndFile` and `updateRange`

**New file:** `tests/unit/auto-context.test.js`
- File in diff → no-op
- Line comment on non-diff file → creates context file with padded range
- File-level comment on non-diff file → creates context file [1, 50]
- Existing context file covers range → no-op
- Existing context file doesn't cover → expands range
- Range clamping to 500 max

**E2E:** Run existing E2E tests to confirm no regressions

## Constants

| Constant | Value | Rationale |
|----------|-------|-----------|
| `LINE_PADDING` | 10 | Enough surrounding context to see the function/block |
| `FILE_COMMENT_DEFAULT_LINES` | 50 | Shows imports + initial declarations |
| `MAX_RANGE` | 500 | Matches existing context-files endpoint validation |

## Files changed

| File | Action |
|------|--------|
| `src/utils/diff-file-list.js` | NEW — extracted `getDiffFileList` |
| `src/utils/auto-context.js` | NEW — `ensureContextFileForComment()` |
| `src/routes/context-files.js` | MODIFY — import `getDiffFileList` from shared util |
| `src/routes/reviews.js` | MODIFY — call `ensureContextFileForComment` after comment creation |
| `src/database.js` | MODIFY — add `getByReviewIdAndFile()`, `updateRange()` |
| `tests/unit/auto-context.test.js` | NEW — unit tests |
| `tests/unit/context-file-repository.test.js` | MODIFY — tests for new methods |

## Verification

1. `npm test` — all unit/integration tests pass
2. `npm run test:e2e` — E2E tests pass
3. Manual: create a comment on a non-diff file via chat → context file auto-created, file appears in diff panel
