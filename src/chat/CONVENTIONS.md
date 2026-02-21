# Chat Module Conventions

## Action handler pattern (ChatPanel.js)

All action handlers (adopt, update, dismiss) follow identical structure:
1. Guard: if streaming or no `_contextItemId`, return early
2. Set `_pendingActionContext` with `{ type, itemId }`
3. Set `inputEl.value` to clean, human-readable text (NO item IDs)
4. Call `sendMessage()`

See `_handleAdoptClick` as the canonical example. New action handlers must follow this pattern.

## Action metadata separation

Item IDs never appear in user-visible message text. They flow through:
`_pendingActionContext` (frontend) → `actionContext` (API payload) → `[Action: ...]` hint (agent-facing message in session-manager.js)

This keeps the chat transcript clean while giving the agent structured metadata it can parse reliably.
