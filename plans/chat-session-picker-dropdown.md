# Chat Session Picker Dropdown

## Context

Currently, the chat panel loads the MRU session on open and supports creating new conversations, but there is no way to return to a previous session. Users need a dropdown in the header to switch between sessions for the current review.

## Files to Modify

| File | Change |
|------|--------|
| `src/chat/session-manager.js` | Add `first_message` subquery to `getSessionsWithMessageCount` |
| `public/js/components/ChatPanel.js` | Session picker UI, dropdown logic, session switching |
| `public/css/pr.css` | Styles for picker button, dropdown, session items |
| `tests/unit/chat/session-manager.test.js` | Tests for `first_message` field |
| `tests/unit/chat-panel.test.js` | Tests for dropdown rendering, time formatting, truncation, switching |

## Implementation

### 1. Backend: Add `first_message` to session listing

In `session-manager.js:466-474`, add a scalar subquery to `getSessionsWithMessageCount`:

```sql
SELECT s.*, COUNT(m.id) AS message_count,
  (SELECT content FROM chat_messages
   WHERE session_id = s.id AND role = 'user' AND type = 'message'
   ORDER BY id ASC LIMIT 1
  ) AS first_message
FROM chat_sessions s
LEFT JOIN chat_messages m ON m.session_id = s.id AND m.type = 'message'
WHERE s.review_id = ?
GROUP BY s.id
ORDER BY s.updated_at DESC
```

No route or schema changes needed — `first_message` flows through the existing `GET /api/review/:reviewId/chat/sessions` endpoint automatically.

### 2. Frontend: Header restructure

Replace the static `<span class="chat-panel__title">` with a clickable picker button + dropdown container:

```
.chat-panel__header
  ├── .chat-panel__session-picker (position: relative wrapper)
  │   ├── button.chat-panel__session-picker-btn (chat icon + title text + chevron)
  │   └── .chat-panel__session-dropdown (absolutely positioned flyout, hidden by default)
  └── .chat-panel__actions (unchanged: + New, × Close)
```

- Cache new refs: `sessionPickerBtn`, `sessionDropdown`, `titleTextEl`, `sessionPickerEl`
- Update `titleEl` → `titleTextEl` reference at line 130
- Adjust `_updateTitle()` to set `textContent` on `titleTextEl` (SVG icon now lives in the button, not the title text span)

### 3. Frontend: Dropdown behavior

**New methods:**

- `_fetchSessions()` — Extract the fetch from `_loadMRUSession()` into a reusable method. Also refactor `_loadMRUSession` to call it.
- `_toggleSessionDropdown()` — Toggle show/hide
- `_showSessionDropdown()` — Fetch fresh sessions, render dropdown, bind outside-click-to-close
- `_hideSessionDropdown()` — Hide dropdown, unbind outside-click listener
- `_renderSessionDropdown(sessions)` — Build dropdown items. Each item shows:
  - **Preview**: `first_message` truncated to ~60 chars, or "New conversation" if null
  - **Timestamp**: Relative time from `updated_at` (reuse `window.parseTimestamp` + same formatting pattern as `AnalysisHistoryManager.formatRelativeTime`)
  - Active session gets a highlight + left accent bar
- `_switchToSession(sessionId, sessionData)` — Full session switch:
  1. `_finalizeStreaming()` to stop any active stream
  2. Reset state: `currentSessionId`, `messages`, pending context, action context, analysis context tracking
  3. `_clearMessages()` and `_updateActionButtons()`
  4. Update title with session's provider/model
  5. Load message history if `message_count > 0`
  6. `_ensureAnalysisContext()` for the new session
- `_formatRelativeTime(timestamp)` — Same logic as `analysis-history.js:747-767`
- `_truncate(text, maxLen)` — Simple truncation with ellipsis

**Event binding:**
- Click on `sessionPickerBtn` → `_toggleSessionDropdown()`
- Escape key: close dropdown first if open, before existing Escape handling chain
- `_startNewConversation()` and `close()`: call `_hideSessionDropdown()`

### 4. CSS

Add to the chat panel section of `pr.css`:
- `.chat-panel__session-picker` — relative positioning wrapper, `flex: 1`, `min-width: 0`
- `.chat-panel__session-picker-btn` — flex layout, hover background, inherits font styling from existing `.chat-panel__title`
- `.chat-panel__chevron` — rotates 180deg when `--open` modifier present
- `.chat-panel__session-dropdown` — absolute positioned below button, `border-radius: 8px`, shadow, `max-height: 300px`, overflow-y auto
- `.chat-panel__session-item` — flex column (preview on top, meta below), hover/active states
- `.chat-panel__session-item--active` — background highlight + left accent bar via `::before`
- `.chat-panel__session-preview` — truncated text, `font-weight: 500`
- `.chat-panel__session-meta` — smaller, muted color for timestamp
- Dark theme overrides via `[data-theme="dark"]` selector

### 5. Edge cases

- **Switching while streaming**: `_finalizeStreaming()` handles cleanup; SSE events for the old session are ignored since `currentSessionId` changes
- **Empty sessions** (no messages yet): Show "New conversation" as preview
- **Context messages excluded**: The `role = 'user' AND type = 'message'` filter ensures context cards don't appear as previews
- **No sessions exist**: Dropdown shows empty state message
- **Dropdown dismissed by**: clicking outside, pressing Escape, clicking a session, clicking "+ New", closing the panel

## Verification

1. Run unit tests: `npm test -- --grep "session-manager"` and `npm test -- --grep "ChatPanel"`
2. Run E2E tests: `npm run test:e2e`
3. Manual: Open chat, send messages in two sessions, verify dropdown lists both in MRU order with correct previews and timestamps, switch between them
