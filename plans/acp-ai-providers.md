# Plan: Generic ACP Support for AI Review Providers

## Context

pair-review has two AI provider systems: **chat providers** (interactive sessions in `src/chat/`) and **review providers** (one-shot analysis in `src/ai/`). Chat providers already support ACP (Agent Client Protocol) via `AcpBridge` for agents like Copilot, Gemini, and Cursor. Review providers are CLI-only — each spawns a process, pipes a prompt to stdin, and parses stdout.

This change adds a generic ACP review provider so users can configure *any* ACP-compatible agent as a review provider via `config.json`. Configured ACP providers appear in the UI alongside built-in providers.

## Design

### Config Format

Users add entries with `"type": "acp"` to `config.providers`:

```json
{
  "providers": {
    "my-agent": {
      "type": "acp",
      "command": "my-agent",
      "args": ["--acp", "--stdio"],
      "name": "My Custom Agent",
      "env": {},
      "installInstructions": "npm install -g my-agent",
      "models": [
        { "id": "default", "name": "Default", "tier": "balanced", "default": true }
      ]
    }
  }
}
```

- `type: "acp"` — discriminator; triggers dynamic registration instead of config overrides
- `command` — required; the CLI binary to spawn
- `args` — optional; defaults to `["--acp", "--stdio"]`
- `models` — optional; at least one model recommended for the provider to appear usefully in UI

### Execution Flow (per analysis level)

1. Spawn ACP agent process with configured command/args/env
2. Create `ndJsonStream` + `ClientSideConnection` via ACP SDK (lazy-loaded, ESM)
3. `initialize()` handshake → `newSession({ cwd })` → optionally `unstable_setSessionModel()`
4. `prompt()` with the analysis text — blocks until agent completes
5. Accumulate text from `agent_message_chunk` session updates during execution
6. Map session update events to `onStreamEvent` callbacks for progress UI
7. Auto-approve permissions (prefer `allow_once` → `allow_always` → cancel)
8. Parse accumulated text for JSON via `extractJSON()`; fall back to `extractJSONWithLLM()`
9. Kill process in `finally` block (SIGTERM → 3s → SIGKILL)

### Class Factory Pattern

The provider registry uses static methods (`getModels()`, `getProviderName()`, etc.) called on the class itself. A generic `AcpProvider` can't serve multiple configs from one class. Solution: a factory that creates a unique subclass per config entry, with closures over the config values:

```javascript
function createAcpProviderClass(id, providerConfig) {
  const models = (providerConfig.models || []).map(inferModelDefaults);
  const name = providerConfig.name || prettifyModelId(id);
  // ...
  class DynamicAcpProvider extends AcpProvider {
    static getProviderId() { return id; }
    static getProviderName() { return name; }
    static getModels() { return models; }
    // ...
  }
  return DynamicAcpProvider;
}
```

### Streaming Progress

ACP consumes stdout for JSON-RPC, so `StreamParser` (line-based) can't be used. Instead, the `sessionUpdate` handler maps ACP events directly to the normalized `{ type, text, timestamp }` format that `onStreamEvent` expects. This reuses `truncateSnippet` from `stream-parser.js`.

## Files to Create/Modify

### 1. NEW: `src/ai/acp-provider.js`
- `AcpProvider` class extending `AIProvider`
- `createAcpProviderClass(id, config)` factory function
- Local `loadAcp()` lazy loader for ACP SDK (replicated from `acp-bridge.js`, not shared — keeps chat and AI subsystems decoupled)
- Constructor: stores command, args, env, useShell from config overrides
- `execute(prompt, options)`: full ACP lifecycle (spawn → handshake → session → prompt → parse → cleanup)
- `testAvailability()`: `command --version` with 10s timeout
- `getExtractionConfig()`: returns `null` (ACP lifecycle is too heavy for extraction; delegates to another provider)
- Dependency injection via `_deps` pattern (matches `acp-bridge.js`)

### 2. MODIFY: `src/ai/provider.js` — `applyConfigOverrides()`
- Import `createAcpProviderClass` from `./acp-provider`
- In the `for` loop over `config.providers`, detect `type: "acp"` entries
- For each: validate `command` is present, call `createAcpProviderClass()`, `registerProvider()` with the dynamic class
- Store config overrides (command, args, env, models, name) for `createProvider()` to use
- Non-ACP entries continue through existing override path unchanged

### 3. MODIFY: `src/ai/index.js`
- Add `require('./acp-provider')` alongside other provider requires
- Export `createAcpProviderClass` for test access

### 4. MODIFY: `config.example.json`
- Add an ACP provider example in the `providers` section with explanatory `_comment`

### 5. NEW: `tests/unit/acp-provider.test.js`
- Factory tests: static methods return correct values, model inference, missing name fallback
- Constructor tests: default args, custom args, shell mode for multi-word commands
- `testAvailability()`: success/failure/timeout
- `execute()` tests with mocked ACP SDK: happy path (JSON response), streaming events mapping, permission auto-approve, timeout enforcement, cancellation, process cleanup in finally
- Uses `_deps` injection to mock spawn and ACP SDK

### 6. NEW: `.changeset/acp-review-providers.md`
- `minor` bump for new feature

## Key Design Decisions

- **Duplicate, don't share** ACP utilities between `acp-bridge.js` and `acp-provider.js`. The shared code is ~25 lines (lazy loader + permission handler). Keeping them independent avoids coupling chat and review subsystems.
- **`getExtractionConfig()` returns `null`**. ACP's handshake-per-call overhead makes it impractical for the lightweight JSON extraction fallback. Other providers (Claude, Pi) handle extraction.
- **`--version` for availability check** rather than ACP handshake. Fast, consistent with all other providers, sufficient signal.
- **No changes to frontend**. ACP providers are registered dynamically and appear in the existing provider/model selection UI automatically via `getAllProvidersInfo()`.

## Verification

1. **Unit tests**: `npm test -- tests/unit/acp-provider.test.js`
2. **Integration**: Add a test ACP provider config, verify it appears in `GET /api/providers`
3. **Manual**: If an ACP agent is available (e.g., `copilot --acp --stdio`), configure it as a review provider and run an analysis
4. **E2E**: Existing E2E tests should continue passing (no changes to existing providers)
