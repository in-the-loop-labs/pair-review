# Plan: Add "Chat about lines" action to diff panel

## Context

Starting a chat about specific lines currently requires manually typing file/line references. This adds two one-click entry points: a gutter chat button (alongside the existing `+` comment button) and a "Chat" escape hatch in comment forms. Both pre-fill the chat input with a `[[file:path:lines]]` reference so the user can immediately start typing their question.

## Files to modify

| File | Change |
|------|--------|
| `public/js/components/ChatPanel.js` | Add `prefillText` option to `open()` |
| `public/js/modules/diff-renderer.js` | Create gutter chat button alongside `+` button |
| `public/js/pr.js` | Wire `onChatButtonClick` callback + drag routing in `renderDiffLine()`, add Chat button to `editUserComment()` form |
| `public/js/modules/comment-manager.js` | Add Chat button to `showCommentForm()` (new comment form) |
| `public/css/pr.css` | Gutter button styles, comment form Chat button positioning, `data-chat` gating |

## Step 1: ChatPanel.open() — `prefillText` support

**File:** `public/js/components/ChatPanel.js`, method `_openInner()` (line 347)

Add `prefillText` to the `hasExplicitContext` check (line 379) so it starts a new session:

```js
const hasExplicitContext = !!(options.suggestionContext || options.commentContext || options.fileContext || options.prefillText);
```

After the existing context injection block (after line 404), add prefill handling:

```js
if (options.prefillText) {
  this.inputEl.value = options.prefillText;
  this._autoResizeTextarea();
  this.sendBtn.disabled = !this.inputEl.value.trim() || this.isStreaming;
}
```

After the focus call (line 414), position cursor at end of prefilled text:

```js
if (!options.suppressFocus) {
  this.inputEl.focus();
  if (options.prefillText) {
    this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
  }
}
```

## Step 2: Gutter chat button

### 2a. Create button in diff-renderer.js

**File:** `public/js/modules/diff-renderer.js`, inside the `if (lineNumber && options.onCommentButtonClick)` block (line 256)

After creating `commentButton` and before `lineNumContent.appendChild(commentButton)` (line 296), add:

```js
if (options.onChatButtonClick) {
  const chatButton = document.createElement('button');
  chatButton.className = 'chat-line-btn ai-action-chat';
  chatButton.title = 'Chat about this line (drag to select range)';
  chatButton.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
    <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
  </svg>`;

  // Share drag machinery with comment button via potentialDragStart
  chatButton.onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const side = line.type === 'delete' ? 'LEFT' : 'RIGHT';
    if (options.lineTracker) {
      options.lineTracker.potentialDragStart = {
        row, lineNumber, fileName, button: chatButton,
        isDeletedLine: line.type === 'delete', side, isChat: true
      };
    }
  };

  chatButton.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    options.onChatButtonClick(e, row, lineNumber, fileName, line);
  };

  lineNumContent.insertBefore(chatButton, commentButton);
}
```

The `isChat: true` flag on `potentialDragStart` lets the mouse-up handler in pr.js route to chat vs comment.

### 2b. Wire callback + drag routing in pr.js

**File:** `public/js/pr.js`, `renderDiffLine()` method (line 1198)

Add `onChatButtonClick` to the options object passed to `DiffRenderer.renderDiffLine()`:

```js
onChatButtonClick: (_e, row, lineNumber, file, lineData) => {
  if (!window.chatPanel) return;
  let startLine = lineNumber;
  let endLine = null;

  if (this.lineTracker.hasActiveSelection() &&
      this.lineTracker.rangeSelectionStart.fileName === file) {
    const range = this.lineTracker.getSelectionRange();
    startLine = range.start;
    endLine = range.end;
    this.lineTracker.clearRangeSelection();
  }

  const lineRef = endLine && endLine !== startLine ? `${startLine}-${endLine}` : `${startLine}`;
  window.chatPanel.open({ prefillText: `[[file:${file}:${lineRef}]]\n\n` });
},
```

Update the existing `onMouseUp` handler (line 1226) to check `isChat` and auto-open chat after drag:

```js
onMouseUp: (_e, row, lineNumber, file) => {
  if (this.lineTracker.potentialDragStart) {
    const start = this.lineTracker.potentialDragStart;
    const isChat = start.isChat;
    this.lineTracker.potentialDragStart = null;

    if (start.lineNumber !== lineNumber || start.fileName !== file) {
      if (!this.lineTracker.isDraggingRange) {
        this.lineTracker.startDragSelection(start.row, start.lineNumber, start.fileName, start.side);
      }
      this.lineTracker.completeDragSelection(row, lineNumber, file);

      // For chat drags, immediately open chat with the selected range
      if (isChat && this.lineTracker.hasActiveSelection()) {
        const range = this.lineTracker.getSelectionRange();
        const lineRef = `${range.start}-${range.end}`;
        this.lineTracker.clearRangeSelection();
        if (window.chatPanel) {
          window.chatPanel.open({ prefillText: `[[file:${file}:${lineRef}]]\n\n` });
        }
      }
    }
  } else if (this.lineTracker.isDraggingRange) {
    this.lineTracker.completeDragSelection(row, lineNumber, file);
  }
},
```

## Step 3: Chat button in comment forms

### 3a. New comment form (showCommentForm)

**File:** `public/js/modules/comment-manager.js`, `showCommentForm()` method (line 123)

Add a Chat button **between Save and Cancel** in the `comment-form-actions` div. Use `ai-action ai-action-chat` classes to match AI suggestion Chat button styling. Order: Save / Chat / Cancel.

```html
<div class="comment-form-actions">
  <button class="btn btn-sm btn-primary save-comment-btn" disabled>Save</button>
  <button class="ai-action ai-action-chat btn-chat-from-comment" title="Chat about these lines">
    <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M1.75 1h8.5c.966 0 ..."/></svg>
    Chat
  </button>
  <button class="btn btn-sm btn-secondary cancel-comment-btn">Cancel</button>
</div>
```

Wire click handler (after the Cancel handler, around line 153):

```js
const chatFromCommentBtn = td.querySelector('.btn-chat-from-comment');
if (chatFromCommentBtn) {
  chatFromCommentBtn.addEventListener('click', () => {
    if (!window.chatPanel) return;
    const unsavedText = textarea.value.trim();
    const file = textarea.dataset.file;
    const lineStart = textarea.dataset.line;
    const lineEnd = textarea.dataset.lineEnd || lineStart;

    const lineRef = lineEnd && lineEnd !== lineStart ? `${lineStart}-${lineEnd}` : `${lineStart}`;
    let prefillText = `[[file:${file}:${lineRef}]]\n\n`;
    if (unsavedText) {
      prefillText += unsavedText.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    }

    this.hideCommentForm();
    if (lineTracker) lineTracker.clearRangeSelection();
    window.chatPanel.open({ prefillText });
  });
}
```

### 3b. Edit comment form (editUserComment)

**File:** `public/js/pr.js`, `editUserComment()` method (line 1997)

Same pattern — add Chat button **between Save and Cancel** in `comment-edit-actions`. Order: Save / Chat / Cancel.

```html
<div class="comment-edit-actions">
  <button class="btn btn-sm btn-primary save-edit-btn">Save</button>
  <button class="ai-action ai-action-chat btn-chat-from-comment" title="Chat about these lines">
    <svg ...></svg>
    Chat
  </button>
  <button class="btn btn-sm btn-secondary cancel-edit-btn">Cancel</button>
</div>
```

Wire click handler (after line 2026):

```js
const chatFromEditBtn = editForm.querySelector('.btn-chat-from-comment');
if (chatFromEditBtn) {
  chatFromEditBtn.addEventListener('click', () => {
    if (!window.chatPanel) return;
    const unsavedText = textarea.value.trim();
    const file = textarea.dataset.file;
    const lineStart = textarea.dataset.line;
    const lineEnd = textarea.dataset.lineEnd || lineStart;

    const lineRef = lineEnd && lineEnd !== lineStart ? `${lineStart}-${lineEnd}` : `${lineStart}`;
    let prefillText = `[[file:${file}:${lineRef}]]\n\n`;
    if (unsavedText) {
      prefillText += unsavedText.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    }

    this.cancelEditUserComment(commentId);
    window.chatPanel.open({ prefillText });
  });
}
```

## Step 4: CSS

**File:** `public/css/pr.css`

### 4a. Gutter chat button (after `.add-comment-btn` block, ~line 3690)

```css
.chat-line-btn {
  position: absolute;
  right: 12px;                /* Left of the + button at right: -12px */
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--color-border-default, rgba(255,255,255,0.1));
  background: var(--color-bg-elevated, #1e2329);
  color: var(--color-text-secondary, #8b949e);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.12s ease, box-shadow 0.12s ease;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  padding: 0;
}

.chat-line-btn svg {
  width: 12px;
  height: 12px;
}

.chat-line-btn:hover {
  background: var(--color-accent-light, rgba(56, 139, 253, 0.15));
  color: var(--color-accent-primary, #58a6ff);
  border-color: var(--color-accent-primary, #58a6ff);
  transform: translateY(-50%) scale(1.08);
  box-shadow: 0 2px 6px rgba(56, 139, 253, 0.25);
}

.chat-line-btn:active {
  transform: translateY(-50%) scale(0.96);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

tr:hover .chat-line-btn {
  opacity: 1;
}
```

Uses the same neutral-to-blue-accent pattern as `.ai-action-chat` (consistent with comment form Chat button).

### 4b. Comment form Chat button positioning

```css
.comment-form-actions .btn-chat-from-comment,
.comment-edit-actions .btn-chat-from-comment {
  margin-left: auto;     /* Push to right side of flex row */
}
```

The `.ai-action` + `.ai-action-chat` classes provide all the visual styling (neutral bg, blue hover, icon sizing). `margin-left: auto` separates it from Save/Cancel.

### 4c. data-chat gating (lines 11655-11677)

Add `.chat-line-btn` and `.btn-chat-from-comment` to both `disabled` and `unavailable` selector lists:

```css
[data-chat="disabled"] .chat-line-btn,
[data-chat="disabled"] .btn-chat-from-comment,
/* ... existing selectors ... */

[data-chat="unavailable"] .chat-line-btn,
[data-chat="unavailable"] .btn-chat-from-comment,
/* ... existing selectors ... */
```

## Step 5: Tests

### Unit tests

**`tests/unit/chat-panel.test.js`** — Add tests for `prefillText`:
- `open({ prefillText }) sets textarea value and enables send button`
- `open({ prefillText }) treats as explicit context (skips MRU load)`
- `open({ prefillText: '' }) is treated as no prefill`

**`tests/unit/diff-renderer.test.js`** — Add tests for chat button:
- `creates chat-line-btn when onChatButtonClick provided`
- `does NOT create chat-line-btn when onChatButtonClick missing`
- `chat-line-btn is before add-comment-btn in DOM`
- `mousedown sets potentialDragStart with isChat: true`

### E2E tests

**`tests/e2e/chat-lines.spec.js`** — New file:
- Gutter chat button visible on hover (when chat enabled)
- Gutter chat button hidden when `data-chat="disabled"`
- Click gutter chat button opens chat panel with `[[file:...]]` prefilled
- Comment form Chat button opens chat with file reference + quoted text
- Comment form Chat button is hidden when `data-chat="disabled"`

## Verification

1. `npm test` — unit tests pass
2. `npm run test:e2e` — E2E tests pass
3. Manual: hover over diff lines, verify both buttons appear. Click chat button, verify chat opens with `[[file:path:N]]` prefill. Drag across lines via chat button, verify range reference. Open comment form, type text, click Chat, verify dialog closes and chat opens with quoted text. Toggle `data-chat` to `disabled`, verify chat buttons hidden.
