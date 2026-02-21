# Plan: Expand Hidden Hunks for Comments on Changed Files

## Context

When an AI agent creates a comment (via API) on a line in a changed file that's inside a collapsed gap in the diff panel, the comment silently disappears. `loadUserComments()` searches the DOM for the matching line row, and if the line is hidden in a collapsed gap, there's no DOM row — so the comment is never rendered.

Additionally, agents have no way to explicitly ask the UI to reveal a specific line range in a changed file's diff. Context-file APIs exist for files *outside* the diff, but nothing exists for expanding visibility within already-loaded changed files.

The goal: (1) auto-expand gaps when comments target hidden lines, and (2) provide an API/MCP tool for agents to explicitly expand hunks in changed files.

## Changes

### 1. Pass full SSE payload through to CustomEvents
**File:** `public/js/components/ChatPanel.js` (~line 1627)

The SSE dispatcher currently only passes `{ reviewId, sourceClientId }` to CustomEvents. Change to spread the full `data` object so new event types (like `review:expand_hunk`) can carry additional fields (`file`, `line_start`, etc.).

```js
// Before:
detail: { reviewId: data.reviewId, sourceClientId: data.sourceClientId }
// After:
detail: { ...data }
```

Backward-compatible — existing handlers destructure only `reviewId`/`sourceClientId` and ignore extra fields.

### 2. Add `ensureLinesVisible()` method to PRManager
**File:** `public/js/pr.js`

New async method that takes an array of `{ file, line_start, line_end, side }` items, checks which lines are NOT in the DOM, and calls the existing `expandForSuggestion()` for each hidden one. This reuses the full gap-finding and expansion machinery already built for AI suggestions.

### 3. Call `ensureLinesVisible()` in `loadUserComments()` before rendering
**File:** `public/js/pr.js` (~line 2313)

Before the `lineLevelComments.forEach(...)` rendering loop, await `ensureLinesVisible()` with the comment locations. This ensures gaps are expanded before the code tries to find line rows in the DOM.

### 4. Add `review:expand_hunk` event listener
**File:** `public/js/pr.js`, in `_initReviewEventListeners()` (~line 539)

Listen for `review:expand_hunk` CustomEvent, extract `{ file, line_start, line_end, side }` from detail, and call `expandForSuggestion()`. This is the frontend handler for the server-side API.

### 5. Add `POST /api/reviews/:reviewId/expand-hunk` REST endpoint
**File:** `src/routes/reviews.js`

Accepts `{ file, line_start, line_end, side }`. Validates inputs, then broadcasts `review:expand_hunk` via `broadcastReviewEvent()`. No DB writes — this is a transient UI command. Returns `{ success: true }`.

## What This Does NOT Do

- Does **not** add expanded hunks to context-files (context-files are for files outside the diff)
- Does **not** persist expansions (lost on reload — this is acceptable per requirements)
- Does **not** need separate local.js changes (`loadUserComments` and `expandForSuggestion` are shared by both modes)

## Verification

1. **Unit tests** for `ensureLinesVisible()` and the new REST endpoint
2. **E2E test**: Create a comment on a line in a collapsed gap, verify it appears after `loadUserComments` completes
3. **Manual test**: Use MCP tool `expand_diff_hunk` to reveal a hidden line range, confirm it expands in the UI
