# Chat Action Bar Dismiss Button & Shortcut Toggle Config

## Context

When a user opens a chat conversation with a suggestion or comment as context, an action bar appears below the message area with shortcut buttons like "Adopt with AI edits", "Update comment", "Dismiss suggestion", etc. As the conversation progresses, these shortcuts become stale but persist. The user wants:

1. A small **dismiss (×) button** on the action bar to hide it when no longer needed
2. A **config option** to disable these shortcuts entirely, since all functionality is available via chat messages

## Changes

### 1. Add dismiss button to action bar (`ChatPanel.js`)

**File**: `public/js/components/ChatPanel.js`

- Add a `×` button to the `chat-panel__action-bar` div (line ~87), positioned right-aligned
- On click: hide the action bar and clear `_contextSource`/`_contextItemId` so it stays hidden
- Cache the button ref alongside existing action bar refs (line ~138)

### 2. Style the dismiss button (`pr.css`)

**File**: `public/css/pr.css`

- Minimal styling: small `×` button, right-aligned within the action bar using `margin-left: auto`
- Subtle color (tertiary text), no background, slight hover highlight
- Consistent with existing UI patterns (similar to `chat-panel__context-remove`)

### 3. Add `chat.enable_shortcuts` config option

**File**: `src/config.js`
- Add `chat: { enable_shortcuts: true }` to `DEFAULT_CONFIG` (line ~12)

**File**: `src/routes/config.js`
- Expose `chat_enable_shortcuts` in `GET /api/config` response (line ~36), reading from `config.chat?.enable_shortcuts !== false`
- Accept `chat_enable_shortcuts` in `PATCH /api/config` to persist the setting

**File**: `public/js/index.js`
- Read `chat_enable_shortcuts` from config response and set `data-chat-shortcuts` attribute on `<html>` (near line ~901 where `data-chat` is set)

**File**: `public/js/components/ChatPanel.js`
- In `_updateActionButtons()` (line ~2730): check `document.documentElement.getAttribute('data-chat-shortcuts')` — if `'disabled'`, keep action bar hidden regardless of context

### 4. Config example file

**File**: `config.example.json`
- Add the `chat` object with `enable_shortcuts` documented

## Verification

- Run unit tests: `npm test`
- Run E2E tests: `npm run test:e2e`
- Manual: open a review, click chat on a suggestion, verify action bar shows with × button, click × to dismiss
- Manual: set `chat: { enable_shortcuts: false }` in config, verify action bar never appears
