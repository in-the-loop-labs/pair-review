# Plan: ACP (Agent Client Protocol) Chat Backend

## Context

The chat panel currently only supports Pi RPC as its backend. ACP is an open protocol ("the LSP for AI agents") standardizing communication between clients and AI coding agents. Adding ACP support lets pair-review work with any ACP-compatible agent: GitHub Copilot (`copilot --acp --stdio`), Claude Code, OpenCode, Gemini CLI, and others — all through a single integration.

The goal is to create an `AcpBridge` that matches PiBridge's EventEmitter interface, then update the session manager to select the right bridge based on provider. The initial target agent is **GitHub Copilot** (`copilot --acp --stdio`).

## Key Files

| File | Role |
|------|------|
| `src/chat/pi-bridge.js` | Reference: bridge interface to match |
| `src/chat/session-manager.js` | Needs factory method for bridge selection |
| `src/routes/chat.js` | No changes needed (already accepts `provider`) |
| `public/js/components/ChatPanel.js:929` | Hardcodes `provider: 'pi'` — needs to be configurable |

## Implementation

### 1. Install `@agentclientprotocol/sdk`

```bash
npm install @agentclientprotocol/sdk
```

Zero-dependency package. Provides `ClientSideConnection`, `ndJsonStream`, and all TypeScript types.

### 2. Create `src/chat/acp-bridge.js`

New file mirroring PiBridge's interface. Core design:

**Constructor options:**
```js
{
  model,          // optional model ID
  cwd,            // working directory
  systemPrompt,   // system prompt text
  acpCommand,     // agent binary (default: env PAIR_REVIEW_ACP_CMD or 'copilot')
  acpArgs,        // extra CLI args for the agent (default: ['--acp', '--stdio'])
  env,            // extra env vars for the subprocess
}
```

**Lifecycle (`start()`):**
1. Spawn agent subprocess: `spawn(acpCommand, acpArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })`
2. Create ACP stream: `ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout))`
3. Create `ClientSideConnection` with our `Client` handler
4. `connection.initialize(...)` — handshake
5. `connection.newSession({ cwd })` — get `sessionId`
6. Emit `ready`

**Client handler** (passed to `ClientSideConnection`):
- `sessionUpdate(notification)` — the core streaming handler, maps ACP update types to bridge events:
  - `AgentMessageChunk` (text content) → emit `delta` + accumulate
  - `ToolCall` → emit `tool_use` with `status: 'start'`
  - `ToolCallUpdate` → emit `tool_use` with `status: 'update'` or `'end'`
  - `AgentPlan` → emit `status: 'working'`
- `requestPermission(request)` → auto-approve all requests (matches Pi RPC behavior where the agent runs freely; tool restrictions are the agent's own responsibility via its CLI config).

**`sendMessage(content)`:**
- Must return immediately (fire-and-forget) to match PiBridge behavior
- Fire `connection.prompt(...)` in background (`.then()` / `.catch()`)
- On resolution → emit `complete` with accumulated text
- On error → emit `error`
- System prompt: prepend to first message if set (ACP has no system prompt API)

**`abort()`:** Call `connection.cancel({ sessionId })`

**`close()`:** SIGTERM → timeout → SIGKILL (same pattern as PiBridge)

**`isReady()` / `isBusy()`:** Same semantics as PiBridge

### 3. Update `src/chat/session-manager.js`

**Add bridge factory method:**
```js
const AcpBridge = require('./acp-bridge');
const ACP_PROVIDERS = new Set(['acp']);

_createBridge(provider, options) {
  if (ACP_PROVIDERS.has(provider)) {
    return new AcpBridge(options);
  }
  return new PiBridge({
    ...options,
    tools: CHAT_TOOLS,
    skills: [pairReviewSkillPath],
    extensions: [taskExtensionDir]
  });
}
```

**Update `createSession()`:** Replace `new PiBridge(...)` with `this._createBridge(provider, ...)`.

**Update `resumeSession()`:** Replace `new PiBridge(...)` with factory. For ACP providers, skip the `fs.existsSync()` check on `agent_session_id` (ACP session IDs are opaque strings, not file paths). ACP session resumption via `loadSession` is a future enhancement — for now, resume creates a fresh session.

**Update `_wireBridgeEvents()`:** The `session` event handler currently reads `event.sessionFile`. Adjust to also accept `event.sessionId` so ACP bridges can store their session reference.

### 4. Update frontend provider selection

**`public/js/components/ChatPanel.js`:** Replace hardcoded `provider: 'pi'` with a configurable value:
```js
provider: window.__pairReview?.chatProvider || 'pi'
```

**Server-side:** Inject the configured chat provider into the page context via the existing review page data. Read from config (e.g., `config.chat_provider` defaulting to `'pi'`).

### 5. Configuration

No changes to `src/config.js` needed — the existing `providers` object already supports arbitrary keys. Users configure ACP via:

```json
{
  "chat_provider": "acp",
  "providers": {
    "acp": {
      "command": "copilot",
      "extra_args": ["--acp", "--stdio"]
    }
  }
}
```

Add `chat_provider` to `DEFAULT_CONFIG` (defaulting to `'pi'`). The default ACP command is `copilot` with args `['--acp', '--stdio']`. Users can override for other agents (e.g., `claude` for Claude Code, `opencode` for OpenCode).

### 6. Tests

**Unit: `tests/unit/chat/acp-bridge.test.js`**
Follow `tests/unit/chat/pi-bridge.test.js` pattern with dependency injection:
- Mock `child_process.spawn`
- Mock `@agentclientprotocol/sdk` (`ClientSideConnection`, `ndJsonStream`)
- Test cases: start lifecycle, delta mapping, tool_use mapping, sendMessage fire-and-forget, abort, close, error handling, system prompt injection on first message

**Update: `tests/unit/chat/session-manager.test.js`**
- Test `_createBridge()` returns AcpBridge for `provider: 'acp'` and PiBridge for `provider: 'pi'`
- Test session creation with ACP provider

## Implementation Order

1. Install SDK dependency
2. Create `acp-bridge.js` with core lifecycle (start, sendMessage, close) and text streaming (delta → complete)
3. Add tool_use mapping, abort, error handling
4. Update session-manager.js with factory method
5. Add `chat_provider` to config and frontend
6. Write unit tests
7. Manual integration test with `claude-agent-acp`

## Out of Scope (Future Work)

- ACP session resumption via `loadSession()`
- MCP server pass-through to ACP agents
- Individual agent-specific configurations (Copilot, OpenCode, etc.)
- Permission request UI (auto-approve for now)
- `setSessionMode()` support (e.g., plan mode)

## Verification

1. **Unit tests:** `npm test -- --grep "AcpBridge"` — all pass
2. **Manual test:** With Copilot CLI installed and authenticated, set config `chat_provider: "acp"`, open a review, open chat panel, send a message, verify streaming response appears
3. **Regression:** Existing chat with `provider: 'pi'` still works unchanged
4. **E2E:** Chat E2E tests continue to pass (they use mocked sessions)
