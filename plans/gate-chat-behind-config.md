# Plan: Gate Chat Feature Behind Config + Pi Availability

## Context

Chat functionality currently always renders in the UI, but Pi is the only chat provider implemented. We need to gate all chat UI behind two conditions: (1) `enable_chat` config flag is true, and (2) the Pi AI provider is available. The top-level toggle button gets special treatment — visible but disabled when Pi is missing, hidden entirely when the feature is off.

## Approach: CSS `data-chat` Attribute

Set a `data-chat` attribute on `<html>` with three states: `"disabled"`, `"unavailable"`, `"available"`. CSS rules hide/disable chat elements based on this attribute. This handles dynamically-rendered buttons (suggestions, comments, analysis history) automatically without touching each component.

## Changes

### 1. `src/config.js` — Add `enable_chat` default

Add `enable_chat: true` to `DEFAULT_CONFIG` (after `yolo`).

### 2. `src/routes/config.js` — Expose chat state in `/api/config`

Add `enable_chat` and `pi_available` to the GET `/api/config` response. `getCachedAvailability` is already imported.

```js
enable_chat: config.enable_chat !== false,
pi_available: getCachedAvailability('pi')?.available || false
```

### 3. `public/pr.html` and `public/local.html` — Default `data-chat="disabled"`

Change `<html lang="en" data-theme="light">` to `<html lang="en" data-theme="light" data-chat="disabled">`. This prevents flash of chat UI before JS resolves the real state.

### 4. `public/css/pr.css` — CSS gating rules

Add at the end of the file:

```css
/* Chat disabled: hide everything */
[data-chat="disabled"] #chat-toggle-btn,
[data-chat="disabled"] #panel-layout-toggle,
[data-chat="disabled"] #chat-panel-container,
[data-chat="disabled"] .file-header-chat-btn,
[data-chat="disabled"] .ai-action-chat,
[data-chat="disabled"] .btn-chat-comment,
[data-chat="disabled"] .analysis-history-chat-btn {
  display: none !important;
}

/* Chat enabled but Pi unavailable: hide all except toggle (which is disabled) */
[data-chat="unavailable"] #panel-layout-toggle,
[data-chat="unavailable"] #chat-panel-container,
[data-chat="unavailable"] .file-header-chat-btn,
[data-chat="unavailable"] .ai-action-chat,
[data-chat="unavailable"] .btn-chat-comment,
[data-chat="unavailable"] .analysis-history-chat-btn {
  display: none !important;
}

[data-chat="unavailable"] #chat-toggle-btn {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}
```

### 5. `public/js/components/PanelGroup.js` — Gate chat behavior

**Constructor changes (around line 80-95):**
- Before restoring chat visibility from localStorage, check `data-chat`. If not `"available"`, skip restoration and zero out `--chat-panel-width`.
- Listen for `chat-state-changed` custom event to handle late transitions (config fetch completes after constructor runs).

**`toggleChat()` (line 413) and `showChat()` (line 425):**
- Early return if `data-chat !== 'available'`.

**`_registerKeyboardShortcuts()` (line 332):**
- Wrap `['p', 'c']` callback with same `data-chat` check.

**Event listener for `chat-state-changed`:**
- When state becomes `"available"`, restore chat from localStorage if it was previously open.
- When state is `"unavailable"`, update toggle button title to `"Install and configure Pi to enable chat"`.

### 6. `public/js/index.js` — Set `data-chat` on config load

In `loadConfigAndUpdateUI()` (line 892), after fetching `/api/config`, compute and set the `data-chat` attribute and dispatch a `chat-state-changed` event:

```js
let chatState = 'disabled';
if (config.enable_chat) {
  chatState = config.pi_available ? 'available' : 'unavailable';
}
document.documentElement.setAttribute('data-chat', chatState);
window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: chatState } }));
```

## Files NOT Changed

These need zero modifications — CSS handles their dynamic buttons automatically:
- `public/js/modules/suggestion-manager.js`
- `public/js/modules/comment-manager.js`
- `public/js/modules/file-comment-manager.js`
- `public/js/modules/analysis-history.js`
- `public/js/components/ChatPanel.js`
- `public/js/pr.js`
- `public/js/local.js`

## Verification

1. **Unit tests**: Verify `/api/config` returns `enable_chat` and `pi_available` fields
2. **Manual test — disabled**: Set `enable_chat: false` in config → no chat toggle button visible, no chat buttons anywhere
3. **Manual test — unavailable**: Set `enable_chat: true`, ensure Pi is not installed → toggle button visible but grayed out with tooltip, no other chat buttons
4. **Manual test — available**: Set `enable_chat: true`, Pi available → all chat functionality works normally
5. **E2E tests**: Run existing E2E suite to verify no regressions
