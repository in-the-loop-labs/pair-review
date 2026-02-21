# Enrich comment/suggestion context sent to chat agent

## Context

When the chat agent receives comments/suggestions via "Ask about this", it only gets metadata (file, line range, title, body) — not the actual diff code. This forces the agent to read files before reasoning about a suggestion, even though the diff is already loaded in the browser. Pre-loading relevant diff context into the chat message eliminates these redundant reads.

**Scope**: Per-message context only (when user clicks "Ask about this"). Initial session context (all suggestions at session start) stays unchanged. No enrichment for analysis runs.

## Approach: Frontend enrichment

The frontend already has the raw per-file patch text after parsing the unified diff. It just doesn't persist it. We store it, add a hunk extraction utility, and enrich the context strings in `ChatPanel`.

No backend changes needed.

## Step 1: Persist `filePatchMap` on PRManager

Both modes parse the diff into a `Map<filename, patchText>` but discard it after rendering.

**`public/js/pr.js` — `loadAndDisplayFiles()` (line ~589)**
After `const filePatchMap = this.parseUnifiedDiff(fullDiff)`, add:
```js
this.filePatches = filePatchMap;
```

**`public/js/local.js` — `loadLocalDiff()` (line ~1081)**
After `const filePatchMap = manager.parseUnifiedDiff(diffContent)`, add:
```js
manager.filePatches = filePatchMap;
```

Initialize `filePatches` as empty Map in PRManager constructor.

## Step 2: New frontend utility — `public/js/modules/diff-context.js`

Small module with two exported functions. Uses a simple inline hunk header regex (same pattern as backend's `parseHunkHeader` — just `/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/`).

### `extractHunkForLines(patchText, lineStart, lineEnd, side)` → `string|null`
1. Split patch into hunks by `@@` headers
2. Parse each hunk header to get NEW-side range `[newStart, newStart+newCount-1]` (or OLD-side if `side === 'LEFT'`)
3. If the requested `[lineStart, lineEnd]` overlaps, include that hunk (header + content lines)
4. If hunk exceeds 100 lines, truncate to ±20 lines around the referenced range with `...` marker
5. Return concatenated matching hunks as raw unified diff text, or `null` if none match

### `extractHunkRangesForFile(patchText)` → `Array<{start, end}>`
1. Find all hunk headers in patch
2. Parse each, return `[{start: newStart, end: newStart + newCount - 1}, ...]`

## Step 3: Enrich context in ChatPanel

**`public/js/components/ChatPanel.js`**

### `_sendContextMessage(ctx)` (line ~818) — suggestions
After building the plain-text context lines, before `this._pendingContext.push(...)`:
- Get patch: `window.prManager?.filePatches?.get(ctx.file)`
- If line-level (`ctx.line_start` and not file-level):
  - Call `extractHunkForLines(patch, ctx.line_start, ctx.line_end || ctx.line_start, ctx.side)`
  - If result, append `\n- Diff hunk:\n\`\`\`\n${hunk}\n\`\`\`` to the context lines
- If file-level (no `line_start` or `ctx.is_file_level`):
  - Call `extractHunkRangesForFile(patch)`
  - If result, append `\n- Diff hunk ranges: ${JSON.stringify(ranges)}`

### `_sendCommentContextMessage(ctx)` (line ~862) — comments
Same enrichment pattern as above.

### `_sendFileContextMessage(fileContext)` (line ~907) — file-level chat
Append hunk ranges for the file.

## Edge cases
- **`filePatches` not populated yet**: guard with `?.get()` — skip enrichment silently
- **File not in patch map** (renamed?): skip enrichment
- **Binary files**: no hunk headers → extraction returns null → skip
- **Large hunks (>100 lines)**: truncate around referenced lines
- **LEFT-side comments**: pass side to `extractHunkForLines`, match against oldStart/oldCount

## Files to modify

| File | Change |
|------|--------|
| `public/js/modules/diff-context.js` | **New** — `extractHunkForLines`, `extractHunkRangesForFile` |
| `public/js/pr.js` | Store `filePatches` in constructor + `loadAndDisplayFiles()` |
| `public/js/local.js` | Store `filePatches` in `loadLocalDiff()` |
| `public/js/components/ChatPanel.js` | Enrich `_sendContextMessage`, `_sendCommentContextMessage`, `_sendFileContextMessage` |
| `review.html` / `local-review.html` | Add `<script>` tag for `diff-context.js` (if not auto-loaded) |

## Tests

| File | Coverage |
|------|----------|
| `tests/unit/modules/diff-context.test.js` | **New** — unit tests for both extraction functions |
| E2E | Run existing suite to verify chat flow in both PR and local mode |

## Verification
1. `npm test` — all unit tests pass
2. `npm run test:e2e` — chat flow works in both modes
3. Manual: open a review, click "Ask about this" on a line-level suggestion, verify context sent to agent includes the diff hunk
