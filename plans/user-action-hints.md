# User Action Hints for Chat Agent

## Context

When a user takes actions directly in the review UI (adopting/dismissing suggestions, creating/dismissing comments), the chat agent has no visibility into these actions. The user currently has to tell the agent what they did. This change queues invisible "user action hint" messages that are delivered as context with the next chat message, following the existing `_pendingDiffStateNotifications` pattern.

## Hint Messages

- `[User Action: adopted suggestion <id>]`
- `[User Action: dismissed suggestion <id>]`
- `[User Action: dismissed comment <id>]`
- `[User Action: created comment <id>]`

## Filtering: Not Needed

Chat-mediated actions (`_handleAdoptClick`, etc.) instruct the agent to make API calls via curl. Those API calls never invoke the client-side action methods. WebSocket event handlers (`review:suggestions_changed`, `review:comments_changed`) only reload data — they don't call action methods. Every call site for the action methods originates from user-initiated click handlers. No filtering logic is required.

## Changes

### 1. ChatPanel.js (`public/js/components/ChatPanel.js`)

**a. Constructor** — Add `this._pendingUserActionHints = [];` after `_pendingDiffStateNotifications` init (line ~34).

**b. New method** — Add `queueUserActionHint(message)` after `queueDiffStateNotification()` (line ~1372). Pushes onto the array. Same JSDoc style as `queueDiffStateNotification`.

**c. sendMessage() drain** — After the existing diff-state drain (lines ~1264-1269), drain user action hints into a separate prefix string. Combine both invisible prefixes before merging with `_pendingContext`:

```
diffStatePrefix + userActionPrefix → invisiblePrefix
```

Replace all references to `diffStatePrefix` in the context-merge block (lines ~1274-1292) with `invisiblePrefix`.

**d. sendMessage() error recovery** — After the diff-state restore (line ~1355), add:
```js
this._pendingUserActionHints = [...savedUserActionHints, ...this._pendingUserActionHints];
```

**e. `_startNewConversation()`** — Clear `this._pendingUserActionHints = [];` after the `_pendingDiffStateNotifications` clear (line ~669).

**f. `_switchToSession()`** — Clear `this._pendingUserActionHints = [];` after the `_pendingDiffStateNotifications` clear (line ~1032).

**g. `close()`** — Do NOT clear (matches diff-state pattern; hints survive panel close).

### 2. pr.js (`public/js/pr.js`)

**a. `adoptSuggestion()`** (line 3471) — Add hint after the non-file-level success path (after `_notifyAdoption`, line ~3496). Do NOT add in the file-level branch (it delegates to `fileCommentManager.adoptAISuggestion` which gets its own hint).
```js
window.chatPanel?.queueUserActionHint(`[User Action: adopted suggestion ${suggestionId}]`);
```

**b. `editAndAdoptSuggestion()`** (line 3386) — Add hint inside the save callback (after `_notifyAdoption`, line ~3451). Same message format. File-level branch delegates to `fileCommentManager.editAndAdoptAISuggestion` → `adoptWithEdit`, which gets its own hint.

**c. `dismissSuggestion()`** (line 3508) — Add hint after `commentMinimizer.refreshIndicators()` (line ~3559), inside the try block but after the early return for `hiddenForAdoption`.
```js
window.chatPanel?.queueUserActionHint(`[User Action: dismissed suggestion ${suggestionId}]`);
```

**d. `deleteUserComment()`** (line 2881) — Add hint after the success toast (line ~2943).
```js
window.chatPanel?.queueUserActionHint(`[User Action: dismissed comment ${commentId}]`);
```

### 3. comment-manager.js (`public/js/modules/comment-manager.js`)

**a. `saveUserComment()`** (line 424) — Add hint after `commentMinimizer.refreshIndicators()` (line ~506).
```js
window.chatPanel?.queueUserActionHint(`[User Action: created comment ${result.commentId}]`);
```

### 4. file-comment-manager.js (`public/js/modules/file-comment-manager.js`)

**a. `adoptAISuggestion()`** (line 561) — Add hint after `updateFindingStatus` (line ~620).
```js
window.chatPanel?.queueUserActionHint(`[User Action: adopted suggestion ${suggestion.id}]`);
```

**b. `adoptWithEdit()`** (line 802) — Add hint after `updateFindingStatus` (line ~864).
```js
window.chatPanel?.queueUserActionHint(`[User Action: adopted suggestion ${suggestion.id}]`);
```

**c. `dismissAISuggestion()`** (line 635) — Add hint after `updateFindingStatus` (line ~663).
```js
window.chatPanel?.queueUserActionHint(`[User Action: dismissed suggestion ${suggestionId}]`);
```

**d. `saveFileComment()`** (line 266) — Add hint after `prManager.updateCommentCount()` (line ~323).
```js
window.chatPanel?.queueUserActionHint(`[User Action: created comment ${result.commentId}]`);
```

**e. `deleteFileComment()`** (line 993) — Add hint after `updateFindingStatus` (line ~1030).
```js
window.chatPanel?.queueUserActionHint(`[User Action: dismissed comment ${commentId}]`);
```

### 5. Tests (`tests/unit/chat-panel.test.js`)

Add a `describe('queueUserActionHint', ...)` block with:

1. `queueUserActionHint pushes onto the array`
2. `multiple hints accumulate in order`
3. `queue survives close()` — queue a hint, call `close()`, assert still present
4. `queue cleared on _startNewConversation()` — queue, call method, assert empty
5. `constructor initializes empty array`

## Hazards

- `adoptSuggestion` delegates to `fileCommentManager.adoptAISuggestion` for file-level suggestions. Hint goes in `adoptAISuggestion` (not in the file-level branch of `adoptSuggestion`) to avoid double-hinting while covering both entry points (pr.js delegation + file-comment-zone click handler).
- `editAndAdoptSuggestion` similarly delegates to `fileCommentManager.editAndAdoptAISuggestion` → `adoptWithEdit`. Hint goes in `adoptWithEdit` for file-level, in the save callback for non-file-level.
- `sendMessage()` error recovery must merge restored + newly-queued hints (same pattern as diff-state recovery at line 1355).

## Verification

1. Run `npm test -- tests/unit/chat-panel.test.js`
2. Run E2E tests: `npm run test:e2e`
3. Manual: adopt a suggestion from the diff view, send a chat message, verify hint appears in context
4. Manual: close chat panel, dismiss a suggestion, reopen, send message — verify hint is delivered
