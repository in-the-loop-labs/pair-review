# Plan: Add Chat Buttons in Multiple Locations

## Context

The chat feature (powered by Pi) currently only has a chat button on expanded AI suggestions (between Edit and Dismiss). We want to make chat more accessible by adding it in two new locations and also fixing the existing button's styling to be less prominent in its default state.

## Changes

### 1. Chat button on collapsed suggestions (to the left of "Show")

**Files**: `public/js/modules/suggestion-manager.js`, `public/css/pr.css`

In `suggestion-manager.js` (~line 530), inside the `.ai-suggestion-header-right` div within `.ai-suggestion-collapsed-content`, add a chat button **before** the existing `btn-restore` button:

```html
<button class="btn-collapsed-chat ai-action-chat" title="Chat about suggestion"
        data-suggestion-id="${suggestion.id}"
        data-file="${escapeHtml(suggestion.file || '')}"
        data-title="${escapeHtml(suggestion.title || '')}">
  <!-- discussion SVG icon (same one used elsewhere) -->
</button>
```

CSS: Style `.btn-collapsed-chat` similar to `btn-restore` (transparent bg, border, small size) but with the discussion icon. Blue color on hover. Same height/alignment as the Show button.

The existing click handler delegation in the constructor (line 29) already catches any `.ai-action-chat` click via `e.target.closest('.ai-action-chat')`, so no new JS handler is needed — the data attributes provide the context.

### 2. Chat button on Review panel finding items (upper-right, on hover)

**Files**: `public/js/components/AIPanel.js`, `public/css/pr.css`

In `AIPanel.js`, modify the `renderFindingItem` method (~line 1084) and `renderCommentItem` method (~line 1148). For active findings, add a chat button to the `finding-quick-actions` div. For comments, add it to their action div.

The new button goes **above** the existing dismiss button. Since quick-actions uses `flex` with `gap: 2px` and is positioned `bottom: 4px; right: 4px`, we'll change the positioning to use a **column** flex-direction so buttons stack vertically, with chat on top and dismiss/adopt below. Alternatively, use a separate absolute-positioned container for the chat button in the upper-right corner.

Better approach: Add a **separate** `finding-chat-action` container positioned at `top: 4px; right: 4px` (upper-right), while keeping existing quick-actions at `bottom: 4px; right: 4px`. This avoids disrupting the existing adopt/dismiss layout.

```html
<div class="finding-chat-action">
  <button class="quick-action-btn quick-action-chat"
          data-finding-id="${finding.id}"
          data-finding-file="${finding.file || ''}"
          data-finding-title="${finding.title || ''}"
          title="Chat" aria-label="Chat about suggestion">
    <!-- discussion SVG icon, 12x12 -->
  </button>
</div>
```

CSS: `.finding-chat-action` positioned absolute `top: 4px; right: 4px`, same opacity/hover-reveal pattern as `.finding-quick-actions`. Button styled like `.quick-action-btn` base with blue accent on hover.

JS: Bind click handler in `renderFindings` (after the existing quick-action bindings ~line 738). Handler calls `window.chatPanel.open()` with finding context extracted from data attributes + the `this.findings` array.

Same pattern for comment items — add chat button, wire handler to open chat with comment context.

Gate visibility: Wrap chat button rendering in a check for `document.documentElement.getAttribute('data-chat') === 'available'`. Also add `.finding-chat-action` to the CSS `[data-chat="disabled"]` and `[data-chat="unavailable"]` hide rules (~line 11596).

### 3. Restyle existing expanded suggestion chat button

**File**: `public/css/pr.css`

Change `.ai-action-chat` styling (line 2316) from blue-outlined to match `.ai-action-edit` (neutral gray):

```css
/* Before (blue outline) */
.ai-action-chat {
  background: var(--color-bg-elevated, #1e2329);
  color: var(--color-accent-primary, #58a6ff);
  border: 1px solid var(--color-accent-primary, #58a6ff);
}

/* After (neutral like Edit, blue on hover) */
.ai-action-chat {
  background: var(--color-bg-elevated, #1e2329);
  color: var(--color-text-secondary, #8b949e);
  border: 1px solid var(--color-border-default, rgba(255, 255, 255, 0.1));
}

.ai-action-chat:hover {
  background: var(--color-accent-light, rgba(56, 139, 253, 0.15));
  color: var(--color-accent-primary, #58a6ff);
  border-color: var(--color-accent-primary, #58a6ff);
}
```

## Files to Modify

1. **`public/js/modules/suggestion-manager.js`** — Add chat button HTML in collapsed content template
2. **`public/js/components/AIPanel.js`** — Add chat button to `renderFindingItem` and `renderCommentItem`, bind click handlers in `renderFindings`
3. **`public/css/pr.css`** — Restyle `.ai-action-chat`, add `.btn-collapsed-chat` styles, add `.finding-chat-action` and `.quick-action-chat` styles, update `[data-chat="disabled/unavailable"]` selectors

## Verification

1. Run `npm test` for unit tests
2. Run E2E tests to verify both Local and PR mode
3. Manual check: load a review with AI suggestions → verify:
   - Collapsed suggestions show chat icon to the left of Show
   - Expanded suggestion chat button matches Edit styling (gray), goes blue on hover
   - Review panel items show chat icon in upper-right on hover, blue on hover
   - Clicking any chat button opens the chat panel with correct context
   - When chat is disabled/unavailable, all new chat buttons are hidden
