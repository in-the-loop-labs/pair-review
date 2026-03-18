# Stale PR Badge in Header

## Context

When a PR page loads, there's no indication that the local data is outdated vs GitHub. The staleness check only runs when the user clicks "Analyze." This means a user can be reviewing stale data without knowing it.

**Goal**: Show a visible "STALE" badge in the header on page load. Auto-refresh silently when there's no user work to protect (no analysis results, no user comments). Otherwise show the badge and let the user decide.

## Plan

### 1. HTML — Add badge element (`public/pr.html:93`)

Add a hidden `<span id="stale-badge">` inside `.header-left`, after the breadcrumb div (line 93). Starts hidden via `style="display: none"`. Contains a warning triangle SVG + "STALE" text. Clicking it triggers `refreshPR()`.

### 2. CSS — Badge styles (`public/css/pr.css`)

Style `.stale-badge` following the existing `local-mode-badge` pattern:
- Amber/warning gradient background, white text, pill shape
- `cursor: pointer`, hover effect
- Dark theme variant
- Additional `.pr-closed` (red) and `.pr-merged` (purple) variant classes for state badges

### 3. Frontend JS — Core logic (`public/js/pr.js`)

**3a. `_checkStalenessOnLoad(owner, repo, number)`** — Fire-and-forget from end of `loadPR()` (after line 512, before the `finally` block). Calls the existing `/api/pr/:owner/:repo/:number/check-stale` endpoint. On `isStale === true`:

1. Check `_hasActiveSessionData()` — if false, silently call `refreshPR()` and return (no badge).
2. If true, call `_showStaleBadge('stale')` — user has work to protect.

Also show badge for closed/merged PRs (different color variants).

**3b. `_hasActiveSessionData()`** — Parallel-fetch both:
- `GET /api/reviews/:reviewId/suggestions/check` → `analysisHasRun`
- `GET /api/reviews/:reviewId/comments` → filter for `source === 'user'` and `status !== 'inactive'`

Returns `true` if either has data. Fails safe (returns `true` — don't auto-refresh when uncertain).

Note: If `currentPR.id` is null (no review record created yet), return `false` — there can't be any session data without a review record.

**3c. `_showStaleBadge(type)` / `_hideStaleBadge()`** — Show/hide the badge element, apply variant CSS class for closed/merged.

**3d. Badge click handler** — Wire up in `loadPR()` after `renderPRHeader()`. Clicking calls `refreshPR()`.

**3e. Clear badge on refresh** — Add `_hideStaleBadge()` in `refreshPR()` success path (after line 4400).

**3f. Cache for pre-analysis check** — Store the staleness result + timestamp in `_stalenessResult` / `_stalenessCheckedAt`. The existing pre-analysis check in `triggerAIAnalysis()` (line 4083) can reuse this if < 30s old, avoiding a redundant GitHub API call.

### 4. No backend changes

The existing `check-stale` endpoint returns everything needed.

### 5. Local mode

Not applicable — local mode staleness is a different concept (working tree changes continuously). The pre-analysis check already covers local mode. Header badge is PR-mode only.

### 6. Testing

**Integration tests** (`tests/integration/routes.test.js`): Add tests for `GET /api/pr/:owner/:repo/:number/check-stale` if not already covered.

**E2E tests** (new `tests/e2e/stale-badge.spec.js`):
- Badge hidden when not stale (default mock returns `isStale: false`)
- Badge visible when stale + session has data (override via `page.route()`)
- Badge click triggers refresh and hides badge
- Auto-refresh when stale + no session data (badge never appears)
- Badge shows MERGED/CLOSED variants

## Files to modify

| File | Change |
|------|--------|
| `public/pr.html` | Add `#stale-badge` span in header-left after breadcrumb |
| `public/css/pr.css` | Add `.stale-badge` styles + variants |
| `public/js/pr.js` | Add `_checkStalenessOnLoad`, `_hasActiveSessionData`, `_showStaleBadge`, `_hideStaleBadge`, click handler, clear on refresh, cache optimization |
| `tests/e2e/stale-badge.spec.js` | New — E2E tests for badge behavior |
| `tests/integration/routes.test.js` | Add PR check-stale endpoint tests (if missing) |

## Verification

1. Run `npm test` for unit/integration tests
2. Run `npm run test:e2e` for E2E tests
3. Manual: open a PR page, verify badge appears/doesn't appear based on staleness
4. Manual: verify auto-refresh fires when no session data exists
5. Manual: verify clicking badge triggers refresh and badge disappears
