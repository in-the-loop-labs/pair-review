# Index Page Analysis Spinners

## Context

Users want to see when an AI analysis is running in the background for a review, directly from the index page. Currently, analysis status is only visible on the individual review page. This adds a pulsing indicator dot to entries on the Pull Requests and Local Reviews tabs when analysis is active.

## Approach

**Visual**: A small pulsing 8px amber dot (matching the existing `pulse-dot` animation style) prepended inside the title/name cell of each row. No extra table column.

**Data flow**: New REST endpoint returns currently-active analyses from the in-memory `activeAnalyses` map. A new `index:analyses` WebSocket topic pushes start/end events for real-time updates. The frontend fetches on page load, subscribes to WS, and decorates matching rows.

**Matching**: Use `reviewId` (from the `reviews` table) universally for both modes. For local rows, `data-session-id` already equals `reviews.id`. For PR rows, add a LEFT JOIN to the recent reviews query to include `reviews.id`, and expose it as a new `data-analysis-review-id` attribute. The active analyses endpoint returns `reviewId` which is `reviews.id` — one lookup works for both.

---

## Changes

### 1. Backend: New `GET /api/analyses/active` endpoint

**File**: `src/routes/analyses.js` (add before the parameterized `:id` routes at line ~305)

Iterate `activeAnalyses` values, filter to `status === 'running'`, return lightweight projections:

```json
{
  "active": [
    { "analysisId": "uuid", "reviewId": 42, "reviewType": "pr", "repository": "owner/repo", "prNumber": 123 },
    { "analysisId": "uuid2", "reviewId": 55, "reviewType": "local", "repository": "my-project" }
  ]
}
```

No DB access — purely from in-memory maps. Only include entries with `status === 'running'`.

### 2. Backend: Broadcast on `index:analyses` topic

**File**: `src/routes/shared.js`

Add a `broadcastIndexAnalysisEvent(data)` helper that calls `ws.broadcast('index:analyses', data)`.

**Where to call it** — centralize in `broadcastProgress`:
- When broadcasting a status with `status === 'running'` for the first time for an analysisId, also emit `{ type: 'analysis_started', analysisId, reviewId, reviewType, repository, prNumber }` on the index topic. Track which analysisIds have been announced with a module-level Set.
- When broadcasting a terminal status (`completed`/`failed`/`cancelled`), emit `{ type: 'analysis_ended', analysisId, reviewId, reviewType, repository, prNumber }` and remove from the tracking Set.

This covers all analysis paths (single-model PR/local, council, executable, MCP) without modifying each individually.

Export `broadcastIndexAnalysisEvent` from `shared.js`.

### 3. Frontend: Load `ws-client.js` on index page

**File**: `public/index.html` (before existing scripts at line 1433)

Add: `<script src="/js/ws-client.js"></script>`

### 4. Frontend: Spinner CSS

**File**: `public/index.html` (inside existing `<style>` block)

```css
.index-analysis-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--ai-primary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: index-spin 0.8s linear infinite;
  margin-right: 6px;
  vertical-align: middle;
}
@keyframes index-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
```

Matches the `.council-spinner` pattern from `pr.css` (rotating circle with amber border, transparent top). Uses existing `--ai-primary` CSS variable (already defined for both light/dark themes on index page). 12px size fits cleanly inline with row text.

### 5. Backend: Add `reviews.id` to PR recent reviews query

**File**: `src/routes/worktrees.js` — `GET /api/worktrees/recent` (line ~144)

Add a LEFT JOIN to the `reviews` table to include the `reviews.id` for each PR entry:
```sql
LEFT JOIN reviews r ON r.pr_number = pm.pr_number
  AND r.repository = pm.repository COLLATE NOCASE
```
Add `r.id as review_id` to the SELECT. Include `review_id` in the response objects (nullable — PR rows without a review record will have `null`).

### 6. Frontend: Add `data-analysis-review-id` to PR rows

**File**: `public/js/index.js` — `renderRecentReviewRow()` (line ~768)

Add `data-analysis-review-id` to the `<tr>` tag using the new `review_id` field:
```html
<tr data-review-id="..." data-analysis-review-id="42">
```
Only render the attribute when `review.review_id` is non-null.

### 7. Frontend: Analysis spinner logic

**File**: `public/js/index.js` — new section at end of IIFE

**7a.** `fetchAndApplyActiveAnalyses()`:
- `GET /api/analyses/active`
- For each active entry, find the matching row and add spinner
- Remove spinners from rows no longer in the active set

**7b.** Row finder — unified by `reviewId`:
- Find `tr[data-analysis-review-id="${reviewId}"]` (PR rows)
- OR `tr[data-session-id="${reviewId}"]` (local rows)
- One selector covers both: `tr[data-analysis-review-id="${reviewId}"], tr[data-session-id="${reviewId}"]`

**7c.** `addSpinnerToRow(row)` / `removeSpinnerFromRow(row)`:
- Prepend/remove a `<span class="index-analysis-spinner">` in the title/name cell (`.col-title` for PR, `.col-local-name a` for local)
- No-op if already present/absent

**7d.** WebSocket subscription:
- `window.wsClient.connect()` + `subscribe('index:analyses', handler)`
- On `analysis_started`: find row, add spinner
- On `analysis_ended`: find row, remove spinner

**7e.** Hook into existing load functions:
- Call `fetchAndApplyActiveAnalyses()` after `loadRecentReviews()` and `loadLocalReviews()` complete (and after pagination loads), since those rebuild the DOM
- Also on `wsReconnected` event

---

## Hazards

- **`broadcastProgress` has many callers**: All analysis paths call it. Centralizing the index broadcast inside it covers all paths, but verify each path calls `broadcastProgress` at least once with the initial `running` status and once with a terminal status. Confirmed: executable-analysis.js:195, pr.js:1700, local.js (equivalent), analyses.js:543 all call `broadcastProgress` on start, and their `.then()`/`.catch()` handlers all call it on completion.
- **Row rebuilds destroy spinners**: `loadRecentReviews()` replaces container innerHTML. The re-fetch after each load handles this. WS events during the brief rebuild window gracefully no-op (row not found).
- **`activeAnalyses` entries linger after completion**: Completed entries stay in the map with terminal status. The endpoint and WS logic must filter to `status === 'running'` only.
- **PR row matching**: Uses `reviews.id` via LEFT JOIN in the worktrees query. If a PR has no `reviews` record, `review_id` is NULL and no spinner can appear — which is correct, since no analysis can run without a review record.
- **Multiple reviews per PR**: The LEFT JOIN could match multiple `reviews` records if the same pr_number+repository combination exists in `reviews` more than once. Use a correlated subquery or `MAX(r.id)` to ensure at most one result row per `pr_metadata` entry.

## Files Changed

| File | Change |
|------|--------|
| `src/routes/analyses.js` | New `GET /api/analyses/active` endpoint |
| `src/routes/shared.js` | `broadcastIndexAnalysisEvent()` + hook in `broadcastProgress()` |
| `src/routes/worktrees.js` | LEFT JOIN `reviews` to include `review_id` in recent reviews response |
| `public/index.html` | Add `ws-client.js` script tag + spinner CSS |
| `public/js/index.js` | `data-analysis-review-id` on PR rows + spinner fetch/subscribe/decorate logic |

## Testing

- **Unit tests**: New `/api/analyses/active` endpoint with mocked `activeAnalyses` map (mixed running/completed statuses). Index broadcast emission from `broadcastProgress`.
- **E2E test**: Start analysis, navigate to index, verify spinner appears; wait for completion, verify spinner disappears.
- **Manual**: Open index page, trigger analysis from another tab, confirm spinner appears in real-time.
