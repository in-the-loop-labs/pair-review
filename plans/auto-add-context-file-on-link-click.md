# Plan: Auto-add context file on click when `[[file:]]` link targets a non-diff file

## Context

When an AI chat message references a file via `[[file:path:lines]]` that isn't part of the diff, clicking the link silently does nothing — `scrollToFile` finds no matching `[data-file-name]` wrapper in the DOM. The user must manually add context files to see non-diff files. This change makes those clicks "just work" by auto-adding the referenced file as a context file and scrolling to it.

## Changes

### 1. New method: `PRManager.ensureContextFile()` in `public/js/pr.js`

Insert after `scrollToContextFile()` (line 4375), before the class closing brace.

```js
async ensureContextFile(file, lineStart = null, lineEnd = null)
```

**Logic:**

1. **Guard:** Return `null` if no `this.currentPR?.id`
2. **Check diff files:** Scan `this.diffFiles` for `f.file === file`. If found → return `{ type: 'diff' }`
3. **Check existing context files:** Scan `this.contextFiles` for `cf.file === file`. If found → return `{ type: 'context', contextFile: cf }` (idempotent — no API call)
4. **Compute line range defaults:**
   - Both null → `line_start: 1, line_end: 100`
   - Only `lineStart` → `line_start: lineStart, line_end: lineStart + 49`
   - Both set → use as-is, clamping range to max 500 (`line_end = Math.min(lineEnd, lineStart + 499)`)
5. **POST** to `/api/reviews/${reviewId}/context-files` with `{ file, line_start, line_end }`
   - `X-Client-Id` header is injected automatically by the existing global fetch interceptor
6. **On 201:** Call `await this.loadContextFiles()` to render (SSE self-echo is suppressed, so explicit call needed — same pattern as `removeContextFile`)
7. **On 400 "already part of the diff":** Return `{ type: 'diff' }` (stale `diffFiles` race)
8. **On error:** Log and return `null`

### 2. Modify `ChatPanel._handleFileLinkClick()` in `public/js/components/ChatPanel.js`

Replace lines 2390-2415. Make the method `async`. New flow:

1. Parse `file`, `lineStart`, `lineEnd` from `linkEl.dataset`
2. Find file wrapper in DOM via `document.querySelector('[data-file-name="..."]')`
3. **If wrapper found:** existing scroll behavior (diff file → `_scrollToLine`/`scrollToFile`; context file → `scrollToContextFile`)
4. **If wrapper NOT found:**
   - Add `chat-file-link--loading` class to link (disables pointer-events + shows spinner)
   - Call `await window.prManager.ensureContextFile(file, lineStart, lineEnd)`
   - On `null` → show error toast
   - On `{ type: 'diff' }` → `scrollToFile(file)` (wrapper should now exist)
   - On `{ type: 'context' }` → brief delay (100ms for DOM settle) → `scrollToContextFile(file, lineStart, contextFile.id)`
   - Remove `chat-file-link--loading` class in `finally` block

### 3. CSS loading state in `public/css/pr.css`

Add near existing `.chat-file-link` styles (~line 11062):

```css
.chat-file-link--loading {
  opacity: 0.6;
  pointer-events: none;
}
.chat-file-link--loading::after {
  content: '';
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-left: 4px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: chat-file-link-spin 0.6s linear infinite;
}
@keyframes chat-file-link-spin {
  to { transform: rotate(360deg); }
}
```

### 4. Tests

Add unit tests for `ensureContextFile` covering:
- File already in diffFiles → returns `{ type: 'diff' }`, no fetch
- File already in contextFiles → returns `{ type: 'context' }`, no fetch
- New file → POST called with correct body, `loadContextFiles` invoked
- Default line ranges (no range, single line, clamping > 500)
- API error → returns `null`
- No reviewId → returns `null`

Add unit tests for modified `_handleFileLinkClick` covering:
- File in DOM → existing scroll (no `ensureContextFile` call)
- File not in DOM → `ensureContextFile` called, scroll on success
- Error path → toast shown
- Loading class toggled correctly

## Files to modify

| File | Action |
|------|--------|
| `public/js/pr.js` | Add `ensureContextFile()` method (~line 4375) |
| `public/js/components/ChatPanel.js` | Rewrite `_handleFileLinkClick()` (lines 2390-2415) |
| `public/css/pr.css` | Add `.chat-file-link--loading` styles |
| `tests/unit/chat-panel.test.js` | Add tests for new click handler behavior |

## No backend changes needed

The existing `POST /api/reviews/:reviewId/context-files` endpoint handles everything — validation, path traversal protection, diff-file conflict detection.

## Local mode parity

Works automatically — `ensureContextFile` uses `this.currentPR.id` (set in both modes), `this.contextFiles` and `this.diffFiles` (populated in both modes), and `local.js` does not override any context file methods.

## Verification

1. Run `npm test` — all existing tests pass
2. Run `npm run test:e2e` — E2E tests pass
3. Manual test in PR mode: open a review, send a chat message referencing a non-diff file, click the link → file appears as context file and view scrolls to it
4. Manual test in Local mode: same flow
5. Click a link for a file already in the diff → normal scroll behavior (no context file added)
6. Click same non-diff link twice → second click scrolls to existing context file (no duplicate)
