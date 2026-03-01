# Plan: Claude Code Chat Bridge (Direct Subprocess)

## Context

The chat panel now supports Pi RPC and ACP as backends. This plan adds Claude Code as a third chat provider using **direct subprocess management** — no SDK package, just `spawn()` + NDJSON over stdin/stdout. This is the same pattern PiBridge uses for the `pi` process: spawn, readline for parsing, `proc.stdin.write()` for sending. The `claude` CLI supports a long-running interactive mode via `--input-format stream-json` that keeps the process alive across multiple turns.

## Key Design Decisions

1. **Provider name: `'claude-code'`** — avoids collision with the existing `'claude'` analysis provider in `src/ai/claude-provider.js`.

2. **Direct subprocess, no SDK package** — spawn `claude` with the right flags, parse NDJSON via readline, write NDJSON to stdin. Zero new dependencies. Matches PiBridge's proven pattern.

3. **`--allowedTools` for permission scoping** — same approach as the analysis provider (`src/ai/claude-provider.js`). We define a chat-appropriate tool set and pass it via `--allowedTools`, which auto-approves those tools without any `control_request` round-trips. More secure than `--dangerously-skip-permissions` and consistent with the existing codebase pattern.

4. **System prompt prepended to first message** — same approach as AcpBridge. The `--append-system-prompt` flag could work but prepending gives us full control without relying on undocumented flag behavior.

5. **Session resumption via `--resume <session-id>`** — the `session_id` from the `system/init` message is stored in the DB and passed back on resume.

## Spawn Command

```bash
claude --print \
       --output-format stream-json \
       --input-format stream-json \
       --verbose \
       --include-partial-messages \
       --allowedTools "Read,Bash,Grep,Glob,Edit,Write" \
       -p ""
```

For resume, add: `--resume <session-id>`

The `-p ""` is required for headless mode. The empty prompt is ignored when `--input-format stream-json` is used — the process waits for `user` messages on stdin instead.

**Allowed tools** match the chat context (broader than analysis, which is read-only):
- `Read`, `Grep`, `Glob` — code exploration (mirrors PiBridge's `read,grep,find`)
- `Bash` — shell commands (mirrors PiBridge's `bash,ls`)
- `Edit`, `Write` — code modifications (chat assistant may help with code changes)

This follows the same `--allowedTools` pattern as `src/ai/claude-provider.js:157-175`.

## Files to Change

| File | Action | Purpose |
|------|--------|---------|
| `src/chat/claude-code-bridge.js` | **Create** | Core bridge implementation |
| `src/chat/session-manager.js` | Modify | Add `'claude-code'` to factory |
| `src/routes/config.js` | Modify | Expose `claude_code_available` |
| `public/js/index.js` | Modify | Availability check for `claude-code` |
| `tests/unit/chat/claude-code-bridge.test.js` | **Create** | Unit tests |
| `tests/unit/chat/session-manager.test.js` | Modify | Factory test for new provider |

No new npm dependencies.

## Implementation

### 1. Create `src/chat/claude-code-bridge.js`

Follows AcpBridge's structure: extends EventEmitter, `_deps` injection, same event interface.

**Constructor options:**
```js
{
  model,              // optional model ID
  cwd,                // working directory
  systemPrompt,       // system prompt text (prepended to first message)
  claudeCommand,      // override binary (default: env PAIR_REVIEW_CLAUDE_CMD or 'claude')
  env,                // extra env vars
  resumeSessionId,    // session ID for resumption
  _deps,              // { spawn, createInterface } for testing
}
```

**Dependency injection:**
```js
const defaults = {
  spawn: require('child_process').spawn,
  createInterface: require('readline').createInterface,
};
```

**`start()` lifecycle:**
1. Build args array: `['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--allowedTools', CLAUDE_CHAT_TOOLS, '-p', '']` where `CLAUDE_CHAT_TOOLS = 'Read,Bash,Grep,Glob,Edit,Write'`
2. If `resumeSessionId`, prepend `['--resume', resumeSessionId]`
3. If `model`, add `['--model', model]`
4. Spawn: `deps.spawn(claudeCommand, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })`
5. Set up readline on stdout for line-by-line NDJSON parsing
6. Wire `proc.on('error')`, `proc.on('close')`, `proc.stderr.on('data')`, `proc.stdin.on('error')`
7. Each stdout line → `JSON.parse()` → `_handleMessage(msg)`
8. On `system/init` message → capture `session_id`, emit `session`, emit `ready`, resolve `start()` promise
9. If process exits before ready → reject

**`_handleMessage(msg)` routing:**

| Message | Condition | Bridge Action |
|---|---|---|
| `type: 'system'`, `subtype: 'init'` | — | Capture `session_id`, emit `session: { sessionId }`, emit `ready` |
| `type: 'system'`, `subtype: 'status'` | — | Emit `status: { status: 'working' }` |
| `type: 'stream_event'` | `event.type === 'content_block_delta'` && `event.delta.type === 'text_delta'` | Accumulate `event.delta.text`, emit `delta: { text }` |
| `type: 'stream_event'` | `event.type === 'content_block_start'` && `event.content_block.type === 'tool_use'` | Emit `tool_use: { toolCallId, toolName, status: 'start' }` |
| `type: 'assistant'` | — | Emit `status: { status: 'working' }` (agent is processing) |
| `type: 'tool_progress'` | — | Emit `tool_use: { toolCallId: tool_use_id, toolName: tool_name, status: 'update' }` |
| `type: 'result'`, `subtype: 'success'` | — | Set `_inMessage = false`, emit `complete: { fullText: _accumulatedText }`, reset |
| `type: 'result'`, `subtype: 'error_*'` | — | Set `_inMessage = false`, emit `complete`, then `error: { error }` |
| `type: 'keep_alive'` | — | Ignore |

**`sendMessage(content)`:** Fire-and-forget.
1. Check `isReady()` and `!isBusy()`
2. Reset `_accumulatedText = ''`, set `_inMessage = true`
3. If `this._firstMessage && this.systemPrompt`, prepend system prompt to content, set `_firstMessage = false`
4. Write NDJSON to stdin:
   ```js
   this._write({
     type: 'user',
     message: { role: 'user', content: messageContent },
     session_id: this._sessionId || '',
     parent_tool_use_id: null,
   });
   ```
5. `_write(obj)` → `proc.stdin.write(JSON.stringify(obj) + '\n')`

**`abort()`:** Send interrupt via stdin (not SIGTERM — we want the process to stay alive):
```js
this._write({
  type: 'control_request',
  request: { subtype: 'interrupt' },
  request_id: randomUUID(),
});
```

**`close()`:** Same pattern as AcpBridge/PiBridge:
1. Set `_closing = true`, `removeAllListeners()`
2. Close stdin (`proc.stdin.end()`) to signal no more input
3. `proc.kill('SIGTERM')`
4. 3-second timeout → `proc.kill('SIGKILL')`
5. Resolve on `close` event

**`isReady()` / `isBusy()`:** Same semantics as AcpBridge.

### 2. Update `src/chat/session-manager.js`

Add import and provider set (follows existing pattern at lines 20-21):
```js
const ClaudeCodeBridge = require('./claude-code-bridge');
const CLAUDE_CODE_PROVIDERS = new Set(['claude-code']);
```

Update `_createBridge()` (~line 501):
```js
if (CLAUDE_CODE_PROVIDERS.has(provider)) {
  return new ClaudeCodeBridge(options);
}
```

Update `resumeSession()` (~line 388): Add `CLAUDE_CODE_PROVIDERS` alongside `ACP_PROVIDERS` for the session ID type check (opaque string, not file path). Pass `resumeSessionId` for bridge creation (same as ACP path).

### 3. Update `src/routes/config.js`

Add `claude_code_available` to the `/api/config` response. Reuse the existing `'claude'` provider availability check (same binary):
```js
claude_code_available: getCachedAvailability('claude')?.available || false,
```

### 4. Update `public/js/index.js`

Add `claude-code` to the provider availability logic (alongside existing `pi` and ACP checks):
```js
} else if (chatProvider === 'claude-code') {
  providerAvailable = config.claude_code_available;
}
```

### 5. Tests

**`tests/unit/chat/claude-code-bridge.test.js`** — Follow `acp-bridge.test.js` pattern with `_deps` injection:

`createMockDeps()` helper:
- Mock `spawn` returning a fake process (EventEmitter + PassThrough streams)
- Mock `createInterface` returning a controllable readline
- Helper to simulate NDJSON lines from stdout

Test cases:
- Constructor defaults and env var override for command
- `start()`: spawns with correct args, emits `ready` + `session` on system init
- `start()` with resume: includes `--resume <id>` in spawn args
- `start()` with model: includes `--model <id>` in spawn args
- `sendMessage()`: writes correct NDJSON to stdin, resets state
- System prompt: prepended to first message only
- `stream_event` with `text_delta` → emits `delta`
- `stream_event` with `content_block_start` tool_use → emits `tool_use` start
- `tool_progress` → emits `tool_use` update
- `result` success → emits `complete` with accumulated text
- `result` error → emits `complete` then `error`
- `abort()`: writes interrupt control_request to stdin
- `close()`: ends stdin, sends SIGTERM, force kills after timeout
- Unexpected process exit → emits `error` + `close`

**`tests/unit/chat/session-manager.test.js`** — Add:
- `_createBridge('claude-code', ...)` returns ClaudeCodeBridge instance
- Resume skips `fs.existsSync` for `claude-code` provider

## Implementation Order

1. Create `src/chat/claude-code-bridge.js`
2. Update `src/chat/session-manager.js` (factory + resume)
3. Update `src/routes/config.js` (availability)
4. Update `public/js/index.js` (frontend availability)
5. Write unit tests
6. Run existing tests for regression
7. Manual test with `chat_provider: "claude-code"` in config

## Verification

1. **Unit tests**: `npm test -- --grep "ClaudeCodeBridge"` — all pass
2. **Session manager tests**: `npm test -- --grep "session-manager"` — including new claude-code cases
3. **Manual test**: Set `chat_provider: "claude-code"` in `~/.pair-review/config.json`, open a review, send a chat message, verify streaming response
4. **Regression**: Existing chat with `provider: 'pi'` unchanged
5. **E2E**: `npm run test:e2e` — existing tests pass

## Out of Scope

- Claude Agent SDK package (unnecessary abstraction for our use case)
- Custom `allowedTools` per-user configuration (hardcoded for now, could be configurable later)
- MCP server pass-through
- Permission request UI (tools are pre-approved via `--allowedTools`)
- Changeset (create after implementation is verified)
