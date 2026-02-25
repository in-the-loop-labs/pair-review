# Fix: Suggestion restore after adoption-dismiss cycle

## Context

When a user adopts an AI suggestion, then dismisses the resulting comment, and then tries to restore the suggestion, two bugs occur:

1. **Review panel shows dismissed styling** — The diff panel expands the suggestion correctly, but the AIPanel still shows 'dismissed' status with wrong styling/buttons
2. **Re-adoption fails** — Attempting to adopt the restored suggestion throws an application error because the DB status was never actually changed

### Root cause

When a suggestion is adopted, `dataset.hiddenForAdoption = 'true'` is set on its diff view DOM element (`pr.js:2486`). When the adopted comment is later dismissed via DELETE, this flag is **never cleared**.

So when `restoreSuggestion()` runs (`pr.js:2776`), it sees `hiddenForAdoption === 'true'` and takes the "toggle visibility" shortcut (returns early at line 2788) instead of calling the API. The suggestion's DB status remains 'dismissed', and `aiPanel.updateFindingStatus()` is never called.

## Changes

### 1. Clear `hiddenForAdoption` when adopted comment is dismissed

**File:** `public/js/pr.js` ~line 2217

After the existing `aiPanel.updateFindingStatus(dismissedSuggestionId, 'dismissed')` call, also clear the `hiddenForAdoption` dataset property on the suggestion div so that a subsequent restore takes the correct API code path.

```javascript
if (apiResult.dismissedSuggestionId) {
  if (window.aiPanel?.updateFindingStatus) {
    window.aiPanel.updateFindingStatus(apiResult.dismissedSuggestionId, 'dismissed');
  }
  // Clear hiddenForAdoption so restore takes the API path instead of toggle-only
  const suggestionDiv = document.querySelector(`[data-suggestion-id="${apiResult.dismissedSuggestionId}"]`);
  if (suggestionDiv) {
    delete suggestionDiv.dataset.hiddenForAdoption;
  }
}
```

### 2. Handle re-adoption in `adoptSuggestion()`

**File:** `src/database.js` ~line 1905

When re-adopting a suggestion that was previously adopted→dismissed→restored, there's an orphaned inactive user comment with the same `parent_id`. Instead of creating a duplicate, reactivate the existing inactive comment with the new body.

```javascript
// Before creating a new comment, check for an existing inactive one from a prior adoption
const existingComment = await queryOne(this.db, `
  SELECT id FROM comments
  WHERE parent_id = ? AND source = 'user' AND status = 'inactive'
`, [suggestionId]);

if (existingComment) {
  // Reactivate the existing comment with the new body
  await run(this.db, `
    UPDATE comments SET status = 'active', body = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [editedBody.trim(), existingComment.id]);
  return existingComment.id;
}

// Otherwise create new comment (existing INSERT logic)
```

### 3. Update tests

**File:** `tests/unit/suggestion-status.test.js`

- Update the test "should not call API or update status for adopted suggestions (hiddenForAdoption)" — after the comment is dismissed, `hiddenForAdoption` should be cleared, so the next restore SHOULD call the API
- Add test: "should clear hiddenForAdoption when adopted comment is dismissed"
- Add test: "should call API when restoring a suggestion that was previously adopted then had its comment dismissed"

**File:** `tests/unit/comment-repository.test.js`

- Update "should throw error if suggestion is not active" — this still applies (suggestion must be restored to 'active' first)
- Add test: "should reactivate existing inactive comment on re-adoption instead of creating a duplicate"

## Verification

1. Run unit tests: `npm test -- tests/unit/suggestion-status.test.js tests/unit/comment-repository.test.js`
2. Run full test suite: `npm test`
3. Manual E2E flow: adopt → dismiss comment → restore suggestion → verify AIPanel shows active → adopt again → verify no error
