# Fix: Chat agent comments submitted as file-level instead of line-level

## Problem

`src/routes/pr.js:1019` uses `diff_position === null` to decide if a comment is on expanded context. The chat agent never provides `diff_position`, so its comments are always demoted to file-level. GitHub requires lines to actually be in the diff — but `diff_position` is the wrong way to check that.

## Fix

### 1. Add `buildDiffLineSet()` in `src/utils/diff-annotator.js`

Parse a raw unified diff into a `Set` of `"file:SIDE:line"` strings. Return an object with `isLineInDiff(file, line, side)`. Reuse existing `parseHunkHeader` and `parseFileHeader`.

### 2. Use it in `src/routes/pr.js` at line ~1019

Replace:
```js
const isExpandedContext = comment.diff_position === null || comment.diff_position === undefined;
```

With: build a `diffLineSet` from `diffContent` (already available), then check if the comment's line is in the diff. Fall back to file-level only when the line genuinely isn't in a hunk.

### 3. Tests

- Unit tests for `buildDiffLineSet` in `tests/unit/diff-line-set.test.js`
- Regression integration test in `tests/integration/routes.test.js`

## Files

- `src/utils/diff-annotator.js` — add + export `buildDiffLineSet`
- `src/routes/pr.js` (~line 1000–1035) — use it
- `tests/unit/diff-line-set.test.js` (new)
- `tests/integration/routes.test.js` — add regression test
