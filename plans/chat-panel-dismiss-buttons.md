# Add Dismiss Buttons to Chat Panel Action Bar

## Context

When the chat panel is opened with context (an AI suggestion or a user comment), an action bar appears with shortcut buttons ("Adopt with AI edits" for suggestions, "Update comment" for comments). These buttons populate the chat input with a predefined message and send it immediately.

We want to add **dismiss** buttons alongside the existing action buttons so users can quickly dismiss suggestions or comments directly from the chat panel. These buttons should be styled in red (danger color) to visually distinguish them from the positive actions.

## Changes

### 1. HTML — Add dismiss buttons (`public/js/components/ChatPanel.js`)

Add two new buttons to the `.chat-panel__action-bar` div (after the existing buttons, lines ~77 and ~83):

- **"Dismiss suggestion"** button — class `chat-panel__action-btn--dismiss-suggestion`, displayed when context is a suggestion
- **"Dismiss comment"** button — class `chat-panel__action-btn--dismiss-comment`, displayed when context is a comment

Use an X icon SVG (matching the existing dismiss icon pattern in the codebase).

### 2. JS — Wire up the new buttons (`public/js/components/ChatPanel.js`)

- Query the new button elements in the constructor (alongside `this.adoptBtn` and `this.updateBtn` at ~line 115-116)
- Bind click event listeners (alongside existing ones at ~line 139-140)
- Add handler methods following the same pattern as `_handleAdoptClick` and `_handleUpdateClick`:
  - `_handleDismissSuggestionClick()` — populates input with a message like: `"Please dismiss this AI suggestion using the pair-review API. The suggestion ID is {id}."` and calls `sendMessage()`
  - `_handleDismissCommentClick()` — populates input with a message like: `"Please dismiss this comment using the pair-review API. The comment ID is {id}."` and calls `sendMessage()`
- Update `_updateActionButtons()` to show/hide and disable the new buttons using the same logic as the existing ones (suggestion → show dismiss-suggestion; comment → show dismiss-comment)

### 3. CSS — Red styling (`public/css/pr.css`)

Add styles for both dismiss button variants after the existing `--update` styles (~line 11238):

```css
.chat-panel__action-btn--dismiss-suggestion,
.chat-panel__action-btn--dismiss-comment {
  background: var(--color-danger, #d1242f);
  border-color: var(--color-danger, #d1242f);
  color: #ffffff;
}

.chat-panel__action-btn--dismiss-suggestion:hover:not(:disabled),
.chat-panel__action-btn--dismiss-comment:hover:not(:disabled) {
  background: var(--color-danger-hover, #b91c1c);
  border-color: var(--color-danger-hover, #b91c1c);
  color: #ffffff;
}
```

## Files to modify

1. `public/js/components/ChatPanel.js` — HTML, element refs, event listeners, handlers, visibility logic
2. `public/css/pr.css` — Red button styles

## Verification

- Run E2E tests: `npm run test:e2e`
- Manual: Open chat panel from an AI suggestion → should see "Adopt with AI edits" (blue) + "Dismiss suggestion" (red)
- Manual: Open chat panel from a user comment → should see "Update comment" (blue) + "Dismiss comment" (red)
- Clicking either dismiss button should populate and send a dismiss message in the chat
