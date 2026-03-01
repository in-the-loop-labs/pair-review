# Plan: Named ACP Chat Providers with UI Selector

## Context

The ACP chat integration currently uses a single `chat_provider: "acp"` config value with `PAIR_REVIEW_ACP_CMD` env var to select the agent binary. This is too coarse — we need named providers (`copilot-acp`, `gemini-acp`, `opencode-acp`) with per-provider defaults, availability checks, and a UI dropdown to switch between them. The chat panel header also needs restructuring: the provider name becomes a dropdown selector, and session history moves to the clock icon only.

## Provider Defaults

| Provider | Display Name | Command | Args | Version Check |
|----------|-------------|---------|------|--------------|
| `pi` | Pi | `pi` | _(PiBridge)_ | Uses existing `pi` availability cache |
| `copilot-acp` | Copilot | `copilot` | `['--acp', '--stdio']` | `copilot --version` |
| `gemini-acp` | Gemini | `gemini` | `['--experimental-acp', '--stdio']` | `gemini --version` |
| `opencode-acp` | OpenCode | `opencode` | `['--acp', '--stdio']` | `opencode --version` |

Config overrides via `config.providers['copilot-acp'].command`, `config.providers['copilot-acp'].extra_args`, etc.

Version check: spawns `<command> --version` (using the potentially overridden command from config).

## Implementation

### 1. Create `src/chat/chat-providers.js` — Chat provider registry

New module defining named chat providers, their defaults, and availability checks.

```js
const CHAT_PROVIDERS = {
  pi:             { id: 'pi',           name: 'Pi',      type: 'pi'  },
  'copilot-acp':  { id: 'copilot-acp',  name: 'Copilot', type: 'acp', command: 'copilot', args: ['--acp', '--stdio'], env: {} },
  'gemini-acp':   { id: 'gemini-acp',   name: 'Gemini',  type: 'acp', command: 'gemini',  args: ['--experimental-acp', '--stdio'], env: {} },
  'opencode-acp': { id: 'opencode-acp', name: 'OpenCode', type: 'acp', command: 'opencode', args: ['--acp', '--stdio'], env: {} },
};
```

Exports:
- `getChatProvider(id)` — returns provider definition (with config overrides merged from `config.providers[id]`)
- `getAllChatProviders()` — returns array of all provider definitions
- `isAcpProvider(id)` — returns `true` if `type === 'acp'`
- `checkChatProviderAvailability(id, _deps)` — spawns `<resolved command> --version`, resolves `{ available, error? }`. For `pi`, delegates to existing `getCachedAvailability('pi')`.
- `checkAllChatProviders(_deps)` — checks all in parallel, populates cache
- `getCachedChatAvailability(id)` / `getAllCachedChatAvailability()` — cache getters
- `applyConfigOverrides(providersConfig)` — stores config overrides for command/args/env

Follows the `_deps` dependency injection pattern (inject `spawn`) for testability.

### 2. Update `src/chat/session-manager.js`

- Import from `./chat-providers` instead of maintaining `ACP_PROVIDERS` set
- Add `configOverrides` to constructor: `constructor(db, configOverrides = {})`
- Call `applyConfigOverrides(configOverrides)` to pass through provider config
- `_createBridge(provider, options)`: use `getChatProvider(provider)` to resolve `command`/`args`/`env`, pass them to `AcpBridge`
- `resumeSession()`: replace `ACP_PROVIDERS.has(row.provider)` with `isAcpProvider(row.provider)`
- Remove `ACP_PROVIDERS` constant

### 3. Update `src/chat/acp-bridge.js`

- Remove `process.env.PAIR_REVIEW_ACP_CMD` fallback from constructor (command now comes from registry via session-manager)
- Keep the `options.acpCommand || 'copilot'` default as a safety fallback

### 4. Update `src/server.js`

- Import `checkAllChatProviders` from `./chat/chat-providers`
- Call `await checkAllChatProviders()` alongside existing `checkAllProviders()` before server listens
- Pass `config.providers || {}` to `ChatSessionManager` constructor

### 5. Update `src/routes/config.js` — `/api/config` endpoint

- Import `getAllChatProviders`, `getAllCachedChatAvailability` from `../chat/chat-providers`
- Add `chat_providers` array to response:
  ```js
  chat_providers: getAllChatProviders().map(p => ({
    id: p.id, name: p.name, available: cachedAvailability[p.id]?.available || false
  }))
  ```
- Keep `pi_available` for backwards compat

### 6. Update `src/config.js`

- Update `chat_provider` comment to list valid values: `'pi'`, `'copilot-acp'`, `'gemini-acp'`, `'opencode-acp'`

### 7. Update frontend — `public/js/components/ChatPanel.js`

**Header restructure:**
- Provider name area becomes `chat-panel__provider-picker` with its own dropdown
- Session history button (clock icon) becomes a standalone button in `chat-panel__actions`
- Layout: `[chat-icon] [Provider Name ▾]  ...  [clock] [+] [×]`

**New state & methods:**
- `this._activeProvider` — currently selected provider ID (from config)
- `this._chatProviders` — array from `/api/config` response
- `_toggleProviderDropdown()` / `_showProviderDropdown()` / `_hideProviderDropdown()`
- `_renderProviderDropdown()` — shows provider list with availability indicators
- `_selectProvider(id)` — sets active provider for new sessions, updates title

**Provider dropdown items:**
- Show provider name + availability checkmark
- Unavailable providers are dimmed/disabled
- Active provider highlighted

**Session creation:** use `this._activeProvider` instead of `window.__pairReview?.chatProvider`

**Title update:** show provider display name (from `_chatProviders` array), not the raw ID

### 8. Update frontend init — `public/js/index.js`

- Read `config.chat_providers` array from `/api/config`
- Store as `window.__pairReview.chatProviders`
- Chat availability: `anyAvailable = chatProviders.some(p => p.available)` instead of just checking pi

### 9. Update CSS — `public/css/pr.css`

- New `.chat-panel__provider-picker` styles (similar to existing session-picker)
- `.chat-panel__provider-dropdown` (similar to session-dropdown)
- `.chat-panel__provider-item`, `--active`, `--unavailable` variants
- Session picker button moves into actions, becomes icon-only

### 10. Tests

**New: `tests/unit/chat/chat-providers.test.js`**
- All providers registered with correct defaults
- `isAcpProvider()` returns correct values
- `getChatProvider()` returns defaults, merges config overrides
- Availability check with mocked spawn (using `_deps`)
- Cache get/set/clear

**Update: `tests/unit/chat/session-manager.test.js`**
- Replace `provider: 'acp'` with `provider: 'copilot-acp'` in ACP tests
- Add tests for `gemini-acp` and `opencode-acp`
- Test that bridge receives correct `acpCommand`/`acpArgs` from registry
- Test constructor accepts `configOverrides`

**Update: `tests/unit/chat/acp-bridge.test.js`**
- Remove `PAIR_REVIEW_ACP_CMD` env var test
- Verify `acpCommand` defaults to `'copilot'` when not provided

## Key Files

| File | Change |
|------|--------|
| `src/chat/chat-providers.js` | **NEW** — provider registry, availability, config |
| `src/chat/session-manager.js` | Bridge factory uses registry |
| `src/chat/acp-bridge.js` | Remove env var fallback |
| `src/server.js` | Check chat provider availability at startup |
| `src/routes/config.js` | Expose `chat_providers` array |
| `src/config.js` | Update `chat_provider` docs |
| `public/js/components/ChatPanel.js` | Provider dropdown, header restructure |
| `public/js/index.js` | Multi-provider availability logic |
| `public/css/pr.css` | Provider dropdown styles |
| `tests/unit/chat/chat-providers.test.js` | **NEW** — registry tests |
| `tests/unit/chat/session-manager.test.js` | Update for named providers |
| `tests/unit/chat/acp-bridge.test.js` | Remove env var test |

## Verification

1. `npm test -- --grep "chat-providers"` — new registry tests pass
2. `npm test -- --grep "session-manager"` — updated tests pass
3. `npm test -- --grep "AcpBridge"` — updated tests pass
4. Manual: start server, open chat panel, verify provider dropdown shows all providers with availability status
5. Manual: select a different provider, start a new session, verify correct bridge is spawned
6. Manual: switch sessions — title reflects each session's provider
7. Regression: existing `pi` chat sessions work unchanged
8. E2E: `npm run test:e2e` passes
