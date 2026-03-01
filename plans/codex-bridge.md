# Plan: Codex App-Server Chat Bridge

## Context

Pair-review's chat feature currently supports two backends: PiBridge (Pi-RPC over JSONL/stdio) and AcpBridge (Agent Client Protocol over stdio). Codex has its own built-in chat protocol called "app-server" — a bidirectional JSON-RPC 2.0 protocol over stdio with a thread/turn model. This plan adds a third bridge implementation to support Codex as a chat provider.

**Key difference from existing bridges**: No external SDK dependency needed. JSON-RPC 2.0 is simple enough to implement directly with Node.js builtins (`readline`, `child_process`).

## Files to Create

### `src/chat/codex-bridge.js` — Primary deliverable

EventEmitter class implementing the standard bridge interface. Core design:

**Constructor options** (follows AcpBridge `_deps` pattern):
```
{ model, cwd, systemPrompt, codexCommand, env, resumeThreadId, _deps }
```
- Command resolution: `PAIR_REVIEW_CODEX_CMD` env → config → `'codex'`
- Default args: `['app-server']`
- DI via `_deps`: `{ spawn, createInterface }` with module-level `defaults` object

**JSON-RPC 2.0 transport layer**:
- `_sendRequest(method, params)` — sends request with auto-incrementing `id`, returns Promise resolved by matching response
- `_sendNotification(method, params)` — fire-and-forget (no `id`)
- `_handleLine(line)` — parses each JSONL line and dispatches:
  - Response (has `id`, matches pending request) → resolve/reject promise
  - Server notification (has `method`, no `id`) → `_handleNotification()`
  - Server request (has `method` AND `id`) → `_handleServerRequest()` (approval system)

**`start()` lifecycle**:
1. Spawn `codex app-server` with `stdio: ['pipe', 'pipe', 'pipe']`
2. Set up readline on stdout for JSONL parsing
3. Send `initialize` request with `{ clientInfo: { name: 'pair-review', version } }`
4. Send `initialized` notification
5. `thread/start` (new) or `thread/resume` (resuming) → store `threadId`
6. Emit `session` with `{ threadId }`, then `ready`

**`sendMessage(content)`** — fire-and-forget like AcpBridge:
- Prepend system prompt on first message only (`_firstMessage` flag)
- Send `turn/start` with `{ threadId, input, approvalPolicy: 'auto-edit' }`
- Completion driven by `turn/completed` notification (not request response)

**Notification → event mapping**:
| Codex notification | Bridge event |
|---|---|
| `item/agentMessage/delta` | `delta` (streaming text) |
| `turn/completed` (status=completed) | `complete` (full accumulated text) |
| `turn/completed` (status=failed) | `error` |
| `turn/started` | `status` (working) |
| `item/started` (command type) | `tool_use` (start) |
| `item/completed` (command type) | `tool_use` (end) |

**Approval handling**: `requestApproval` server requests auto-responded with `{ decision: 'accept' }`. Unknown server requests get JSON-RPC error response to avoid hangs.

**`abort()`**: Sends `turn/interrupt` with threadId + turnId. No-op if no active turn.

**`close()`**: Rejects all pending requests, attempts `turn/interrupt` if turn active, then SIGTERM → timeout → SIGKILL (same pattern as existing bridges).

### `tests/unit/chat/codex-bridge.test.js`

Follow AcpBridge test pattern with DI:
- `createMockDeps()` helper with fake process (EventEmitter + PassThrough streams)
- `setupHandshake()` helper that intercepts stdin and auto-responds to JSON-RPC requests
- `sendNotification()` / `sendResponse()` helpers for simulating server messages
- Test cases: constructor, start (new + resume), sendMessage (first message prompt prepend), notification handling (delta/complete/tool_use), approval auto-response, abort, close, error paths

## Files to Modify

### `src/chat/session-manager.js`
1. Import `CodexBridge` and add `CODEX_PROVIDERS = new Set(['codex'])`
2. `_createBridge()`: Add codex branch before PiBridge fallback
3. `resumeSession()`: Add `isCodex` check alongside `isAcp` — skip `fs.existsSync` validation, pass `resumeThreadId` option
4. `_wireBridgeEvents()` line 613: Add `event.threadId` to session ref fallback chain:
   ```js
   const sessionRef = event.sessionFile || event.sessionId || event.threadId;
   ```

### `src/config.js`
- Update `chat_provider` comment to mention `'codex'` as an option

### `tests/unit/chat/session-manager.test.js`
- Add `MockCodexBridge` (same pattern as `MockAcpBridge`)
- Test `_createBridge()` returns CodexBridge for `'codex'` provider
- Test session resume with codex (with/without stored threadId)
- Test session event with `threadId` stored in DB

## Design Decisions

1. **No external SDK**: JSON-RPC 2.0 over JSONL is simple enough to implement with readline + JSON.parse. Zero new dependencies.
2. **System prompt via first message prepend**: Consistent with AcpBridge. Codex has a `personality` turn-level param that could be used instead, but prepending is proven and gives us exact control. Can revisit later.
3. **Auto-approve everything**: Chat sessions need full tool access. Use `approvalPolicy: 'auto-edit'` as turn-level override, plus handle any remaining `requestApproval` requests with auto-accept.
4. **Thread ID as session reference**: Stored in same `agent_session_id` DB column as Pi session paths and ACP session IDs. No schema change needed.

## Verification

1. Run unit tests: `npm test -- tests/unit/chat/codex-bridge.test.js tests/unit/chat/session-manager.test.js`
2. Manual integration test: Set `"chat_provider": "codex"` in config, open a review, start a chat session, verify streaming responses
3. Test session resume: Close and re-open a chat session, verify thread continuity
4. Test abort: Send a message, abort mid-stream, verify clean state
