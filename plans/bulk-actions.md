# Bulk Actions (Selection Mode) on Index Page

## Context

The index page has four tabs (Pull Requests, My Review Requests, My PRs, Local Reviews) each listing items with only single-item actions. Users with many reviews accumulate stale entries with no efficient way to clean up. The Review Requests and My PRs tabs also lack a way to batch-open or batch-analyze multiple PRs. This plan adds a generic selection mode system that supports per-tab bulk actions.

## Tab-Action Matrix

| Tab                  | Bulk Actions       |
|----------------------|--------------------|
| Pull Requests        | Delete             |
| Local Reviews        | Delete             |
| My Review Requests   | Open, Analyze      |
| My PRs               | Open, Analyze      |

## UX Design

### Entering Selection Mode
- Each tab gets a small **"Select"** button in the header area:
  - PR tab & Local tab: between the input form and the table container
  - Collection tabs: in the existing `.tab-pane-header` alongside the refresh button
- Clicking "Select" enters selection mode for that tab; button text changes to **"Cancel"**
- Switching tabs or pressing Escape exits selection mode

### Selection Mode Active
- A checkbox column appears as the first column in the table (header + all rows)
- Select All checkbox in the table header
- Individual row checkboxes toggle selection
- Selected rows get a subtle highlight
- Per-row delete buttons are hidden (replaced by bulk delete)
- Collection row click-to-open behavior is suppressed (clicks toggle checkbox instead)

### Bulk Action Bar
- Sticky bar at the bottom of the tab pane container
- Shows: `"N selected"` + action buttons + Cancel
- Appears when 1+ items are selected
- For Delete: clicking triggers inline confirmation in the bar itself ("Delete N items? [Confirm] [Cancel]") — no modal, consistent with existing inline-confirm pattern

### Exiting Selection Mode
- Cancel button (in action bar or the Select toggle)
- Escape key
- Tab switch
- After completing a bulk action (delete reloads table, open/analyze finishes)

## Implementation

### Phase 1: Selection Infrastructure + Bulk Delete

#### 1. Backend — Bulk Delete Endpoints

**`src/routes/worktrees.js`** — `POST /api/worktrees/bulk-delete`

- Extract core delete logic from existing `DELETE /api/worktrees/:id` into a reusable `deleteReviewById(db, metadataId)` helper
- Existing single-delete endpoint calls this helper (no behavior change)
- New endpoint validates `{ ids: number[] }` (non-empty, max 50, positive integers)
- Loops calling `deleteReviewById` for each ID, collecting results
- Response: `{ success: true, deleted: N, failed: N, errors: [{ id, error }] }`

**`src/routes/local.js`** — `POST /api/local/sessions/bulk-delete`

- Register BEFORE `/:reviewId` param routes
- Validates `{ ids: number[] }` same as above
- Loops calling `reviewRepo.deleteLocalSession(id)` + `deleteLocalReviewDiff(id)` for each
- Same response shape

#### 2. Frontend — `SelectionMode` Class

**`public/js/index.js`** — New class inside the IIFE:

```js
SelectionMode({
  tabId,          // e.g. 'pr-tab'
  containerId,    // e.g. 'recent-reviews-container'
  tbodyId,        // e.g. 'recent-reviews-tbody'
  getRowId(tr),   // extracts unique ID from a row element
  actions: [{ label, className, handler(selectedIds) }]
})
```

Key methods:
- `enter()` — inject checkbox column into thead + all tbody rows, show action bar, add `.selection-mode` class
- `exit()` — remove checkboxes, hide action bar, clear selection, remove class
- `onRowsAdded(rows)` — inject unchecked checkboxes into newly-paginated rows
- `_updateActionBar()` — update count, toggle visibility

Checkbox injection is done via DOM manipulation (prepend `<th>`/`<td>` cells), NOT by modifying the HTML-string render functions. This keeps the render functions clean and handles pagination naturally.

#### 3. Row Data Attributes

- `renderRecentReviewRow`: add `data-review-id="${review.id}"` to the `<tr>`
- `renderCollectionPrRow` (Phase 2): add `data-owner`, `data-repo`, `data-number` to the `<tr>`

#### 4. Pagination Integration

After `insertAdjacentHTML` in `loadMoreReviews` / `loadMoreLocalReviews`, if the corresponding SelectionMode is active, call `onRowsAdded()` for the newly added rows. New rows are NOT pre-selected.

#### 5. Full Table Reload

`loadRecentReviews` and `loadLocalReviews` call `selectionInstance.exit()` at the top if active. Since `exit()` is a no-op when not active, this is safe for all existing callers.

#### 6. Event Delegation

- Action bar buttons use direct `addEventListener` (scoped to the SelectionMode instance), not global delegation
- Global click handler: add early check — if selection mode is active for the current tab and click is on a row, toggle checkbox instead of existing row behavior
- Suppress `.btn-delete-review` / `.btn-delete-session` clicks while in selection mode (or hide via CSS)

#### 7. Module-Level State

Track the currently active SelectionMode instance:
```js
var activeSelection = null;
```
Tab switch callback calls `activeSelection.exit()` before switching. Escape handler checks `activeSelection`.

### Phase 2: Bulk Open / Analyze (Collection Tabs)

#### 1. Open Action

Handler reads `data-pr-url` from selected rows, calls `window.open(url, '_blank')` for each, exits selection mode.

Note: browsers may block multiple `window.open` calls as popups. Mitigation: the first `window.open` is in direct response to user click (allowed); subsequent ones may be blocked. Alternative: open first tab directly, use `fetch` to pre-create worktrees for others, then open. Simplest first approach: try `window.open` and let the browser's popup blocker handle it — users can allow popups for localhost.

#### 2. Analyze Action

Same as Open but appends `?analyze=true` to each URL. Leverages existing auto-analyze support in `pr.js` (line 412) and `local.js` (line 73).

```js
var url = '/pr/' + owner + '/' + repo + '/' + number + '?analyze=true';
window.open(url, '_blank');
```

### CSS

All new styles added to the inline `<style>` in `public/index.html`:

- `.selection-mode .col-select` — narrow checkbox column (32px)
- `.selection-mode tbody tr.selected` — subtle highlight using existing CSS vars
- `.btn-select-toggle` — styled like `.btn-refresh` (small, bordered, icon+text)
- `.btn-select-toggle.active` — highlighted state
- `.bulk-action-bar` — sticky bottom, flex layout, border + shadow
- `.bulk-action-bar.confirming` — toggles between action buttons and confirm buttons
- `.selection-mode .btn-delete-review, .selection-mode .btn-delete-session` — `display: none`
- Dark theme variants via `[data-theme="dark"]` selectors where needed

## Hazards

- **`loadRecentReviews` / `loadLocalReviews` called from multiple sites**: initial load, after single delete, after bfcache restore. Adding `exit()` at the top is safe — it's a no-op when selection mode is not active.

- **`renderRecentReviewRow` callers**: `loadRecentReviews` (initial) and `loadMoreReviews` (pagination). Both use the return value as HTML string. Adding `data-review-id` to `<tr>` is safe for both.

- **`renderCollectionPrRow` callers**: only `renderCollectionTable`. Adding data attributes is safe.

- **Per-row delete vs selection mode**: Inline single-delete replaces row innerHTML (removing checkbox). Rather than managing re-injection, hide per-row delete buttons via CSS while in selection mode.

- **Collection row click-to-open**: Existing delegation handler catches `.collection-pr-row` clicks and navigates. Must suppress this when selection mode is active — check `activeSelection?.active` before navigating, toggle checkbox instead.

- **Popup blocker (Phase 2)**: Multiple `window.open` calls may be blocked. Accept this limitation initially; users can whitelist localhost.

## Files to Modify

| File | Changes |
|------|---------|
| `public/js/index.js` | SelectionMode class, 4 instances, event wiring, pagination hooks, row data attributes |
| `public/index.html` | CSS for selection mode, action bar, checkbox column |
| `src/routes/worktrees.js` | Extract `deleteReviewById` helper, add `POST /api/worktrees/bulk-delete` |
| `src/routes/local.js` | Add `POST /api/local/sessions/bulk-delete` |
| `tests/integration/routes.test.js` | Integration tests for both bulk endpoints |
| `tests/e2e/bulk-actions.spec.js` | E2E tests for selection mode UI |

## Verification

1. **Unit/Integration tests**: `npm test` — new bulk delete endpoint tests pass
2. **Manual testing**:
   - PR tab: enter select mode, select items, bulk delete with confirmation, verify table reloads
   - Local tab: same flow
   - Pagination: enter select mode, load more, verify new rows get unchecked checkboxes
   - Tab switch: verify selection mode exits
   - Escape: verify selection mode exits
   - Select All: verify toggles all rows
3. **E2E tests**: `npm run test:e2e` — new bulk-actions spec passes
4. **Phase 2**: Open/Analyze on collection tabs — verify tabs open with correct URLs, `?analyze=true` triggers auto-analysis
