# Plan: Broadcast `review:analysis_started` SSE event

## Context

When a user asks the chat agent to start an analysis run, the browser UI doesn't update to show analysis is running — the user must refresh the page. The chat agent uses `curl` via the bash tool to hit the HTTP API endpoints directly (`POST /api/pr/.../analyses` or `POST /api/local/.../analyses`). The analysis launches correctly, but no event is broadcast on the multiplexed SSE channel (`/api/chat/stream`) to notify the browser client. Only `review:analysis_completed` is broadcast when analysis finishes.

When the user clicks the Analyze button directly, the UI updates fine because the browser client made the request itself and handles the response synchronously. But when the chat agent makes the same API call server-side, the browser client has no way to know analysis started.

`broadcastProgress()` IS called at start time, but it targets per-analysis SSE listeners (`progressClients`) that no browser client has opened yet (clients only open those after they know an analysis exists). The fix: broadcast a `review:analysis_started` event via `broadcastReviewEvent()` (which reaches all connected browser clients), and handle it client-side by calling the existing `checkRunningAnalysis()` method.

## Server-side: add `broadcastReviewEvent` at analysis start

Each addition is one line, immediately after the existing `broadcastProgress(analysisId, initialStatus)` call:

**Primary (chat agent hits these HTTP endpoints via curl):**

| # | File | Line | reviewId var | Code to add |
|---|------|------|-------------|-------------|
| 1 | `src/routes/pr.js` | after 1496 | `review.id` | `broadcastReviewEvent(review.id, { type: 'review:analysis_started', analysisId });` |
| 2 | `src/routes/local.js` | after 749 | `reviewId` | `broadcastReviewEvent(reviewId, { type: 'review:analysis_started', analysisId });` |
| 3 | `src/routes/analyses.js` | after 615 | `reviewId` | `broadcastReviewEvent(reviewId, { type: 'review:analysis_started', analysisId });` |

**Secondary (MCP `start_analysis` tool — same fix for consistency):**

| # | File | Line | reviewId var | Code to add |
|---|------|------|-------------|-------------|
| 4 | `src/routes/mcp.js` | after 579 | `reviewId` | `broadcastReviewEvent(reviewId, { type: 'review:analysis_started', analysisId });` |
| 5 | `src/routes/mcp.js` | after 730 | `review.id` | `broadcastReviewEvent(review.id, { type: 'review:analysis_started', analysisId });` |

`broadcastReviewEvent` is already imported in all 4 files. Location 3 covers both PR and Local council analysis (they both delegate to `launchCouncilAnalysis` in `analyses.js`).

## Client-side: event listener + dirty-flag plumbing in `public/js/pr.js`

### 1. Add dirty flag init (~line 494)
```js
this._dirtyAnalysisStarted = false;
```

### 2. Add event listener (after `review:suggestions_changed` block, before `review:analysis_completed` — between lines 520-522)
```js
document.addEventListener('review:analysis_started', (e) => {
  if (e.detail?.reviewId !== reviewId()) return;
  if (document.hidden) { this._dirtyAnalysisStarted = true; return; }
  debounced('analysisStarted', () => this.checkRunningAnalysis());
});
```

`checkRunningAnalysis()` already does everything needed: calls `GET /api/reviews/:reviewId/analyses/status`, sets button to analyzing state, shows progress modal, sets AI panel to loading. No logic duplication needed.

### 3. Add visibility recovery (inside `visibilitychange` handler, before the `_dirtyAnalysis` check at line 551)
```js
if (this._dirtyAnalysisStarted) {
  this._dirtyAnalysisStarted = false;
  if (!this._dirtyAnalysis) {
    this.checkRunningAnalysis();
  }
}
```

The `!this._dirtyAnalysis` guard skips `checkRunningAnalysis()` when analysis already completed while the tab was hidden — the `_dirtyAnalysis` handler fires next and does the right thing (reloads suggestions).

### No `local.js` changes needed
- `local.js` calls `_initReviewEventListeners()` from `pr.js` (line 803), so the listener registers automatically.
- `local.js` overrides `checkRunningAnalysis()` (line 368) with a local-mode variant. The listener calls `this.checkRunningAnalysis()` on the patched manager instance, so the override fires correctly.

## Verification

1. `npm test` — unit tests pass
2. `npm run test:e2e` — E2E tests pass (required for frontend changes per CLAUDE.md)
3. Manual: open browser to a review → start analysis via chat agent → UI should immediately show analyzing state with progress modal
