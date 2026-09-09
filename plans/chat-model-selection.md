# Chat Model Selection

## Context

Chat sessions run on whatever model the provider CLI defaults to. The only knob today is the
static config key `chat_providers.<id>.model`, which is undocumented and applied to every
session. Analysis already has a per-provider model catalog (`static getModels()` on each
provider in `src/ai/*-provider.js`, merged with user config by `applyModelOverrides` in
`src/ai/provider.js`). This feature exposes that same catalog in the chat panel so the user
can pick a model for a conversation from the UI.

Scope rules:

- The model is chosen **before the first message is sent**. Once a tab has messages the model
  is fixed for that session. Changing it opens a new tab, after a one-time explanatory dialog
  with a "Don't ask again" checkbox (see §5a). The provider picker already opens a new tab
  silently; that stays as is, because a different provider being a different chat is obvious.
  A different model being a different chat is not.
- Catalog is the review catalog. No second model list to maintain. The
  `update-provider-models` skill keeps chat current for free.
- "Provider default" stays the default. Existing behaviour (CLI default, or the configured
  `chat_providers.<id>.model`) is unchanged for anyone who never touches the picker.
- Works identically in Local mode and PR mode (chat is already mode-agnostic: one `ChatPanel`,
  one set of `/api/chat/*` routes keyed by `reviewId`).

## Design

### 1. Chat provider → review catalog mapping

Chat providers and review providers are separate registries with overlapping but not
identical ids. Add a `models_from` field to each built-in chat provider definition in
`src/chat/chat-providers.js`:

| Chat id        | `models_from` (review provider id) |
|----------------|-------------------------------------|
| `pi`           | `pi`                                |
| `omp`          | `omp`                               |
| `claude`       | `claude`                            |
| `codex`        | `codex`                             |
| `copilot-acp`  | `copilot`                           |
| `opencode-acp` | `opencode`                          |
| `cursor-acp`   | `cursor-agent`                      |

`getChatProvider` merges `models_from` from config like any other key, so a user can point a
config-defined chat provider at any registered review provider's catalog. Resolution for a
provider with no `models_from`: use `type` if it names a registered review provider (covers
config-defined `type: 'claude'` / `type: 'codex'` providers), else no catalog. A provider with
no catalog still works. Its picker shows only the "Provider default" row.

### 2. New module: `src/chat/chat-models.js`

Two pure functions, no I/O, both fed by the already-merged review catalog:

```js
// Catalog for the picker. Strips CLI-facing fields (cli_model, extra_args, env, cliName).
getChatModelCatalog(chatProviderId) -> {
  models: [{ id, name, tier, tagline, badge, badgeClass, description }],
  configuredModel: string | null,   // chat_providers.<id>.model resolved to a canonical id,
                                    // or the raw string if it is not in the catalog
}

// Spawn-time resolution. Canonical id or alias -> what the bridge needs.
resolveChatModel(chatProviderId, selector) -> {
  id: string,               // canonical catalog id, or the selector verbatim when unknown
  cliModel: string | null,  // cli_model ?? cliName ?? id; null suppresses the model flag
  extraArgs: string[],      // catalog extra_args (effort flags for codex/muse-style entries)
  env: Object,              // catalog env (CLAUDE_CODE_EFFORT_LEVEL for Claude effort entries)
  known: boolean,           // false = passthrough of an id not in the catalog
}
```

Catalog lookup: `getProviderClass(reviewId).getModels()` + `getProviderConfigOverrides(reviewId)`
through `applyModelOverrides`, matched with `modelMatches` (id or alias). All four helpers are
already exported from `src/ai/provider.js`. `getChatModelCatalog` must not call
`getAllProvidersInfo` per request (it walks every provider); look up the one class directly.

Passthrough is required for backward compatibility: today's `chat_providers.<id>.model`
values are raw CLI strings (README documents `chat_providers.omp.model`). Unknown selectors
resolve to `{ id: selector, cliModel: selector, extraArgs: [], env: {}, known: false }`.

### 3. Session creation and resume

`ChatSessionManager.createSession` keeps storing the selector in `chat_sessions.model`
(canonical catalog id, or raw string). No migration. Precedence is unchanged:
`request model || chat_providers.<id>.model || null`. `null` means provider default, which is
"no model flag" for every bridge.

`_createBridge` is the single choke point for both `createSession` and `resumeSession`. It
calls `resolveChatModel(provider, options.model || def?.model)` once and passes the resolved
pieces to the bridge instead of the raw string:

| Bridge             | Model transport                                   | Effort transport                                    |
|--------------------|---------------------------------------------------|-----------------------------------------------------|
| `ClaudeCodeBridge` | `--model <cliModel>` (existing)                   | **new** `extraArgs` option appended to argv; `env` merged over `def.env` |
| `CodexBridge`      | JSON-RPC `model: <cliModel>` (existing)           | **new** `extraArgs` appended to the `app-server` argv (`-c model_reasoning_effort=…` is a global flag, same mechanism as the existing `-c allow_login_shell=false`) |
| `PiBridge`/`OmpBridge` | `--model <cliModel>`; **new** `provider/model` split into `--provider`/`--model` (mirrors `_resolveCliModelArgs` in `src/ai/pi-provider.js`); explicit `def.provider` still wins | `extraArgs` already supported; catalog args are appended after `def.args` |
| `AcpBridge`        | `unstable_setSessionModel({ modelId: cliModel })` (existing) | `env` merged; `extraArgs` ignored with a debug log (ACP has no argv model surface) |

Env merge order: `def.env` (provider-level) then catalog `env` (model-level). Same order the
review providers use.

Resume must go through the same resolver so a session created on `opus-5-high` gets its
effort env back after a server restart. Today `resumeSession` passes `row.model` raw.

### 4. API

New endpoint in `src/routes/chat.js`:

```
GET /api/chat/providers
-> { data: { providers: [
     { id, name, type, available, models: [...], configuredModel, hasCatalog }
   ] } }
```

Built from `getAllChatProviders()` + `getAllCachedChatAvailability()` + `getChatModelCatalog`.
`GET /api/config` is untouched (it is fetched inline in the page head and should stay light).

`POST /api/chat/session` already accepts `model`. Add validation: reject non-string,
non-null `model` with 400. Unknown ids are allowed (passthrough), so power users can type
a model the catalog does not list via config.

`chat.started` / `chat.resumed` hook payloads already carry `model`. They now carry the
canonical id. Add `cli_model` alongside it so hooks see what was actually spawned.

### 5. Frontend: `public/js/components/ChatPanel.js`

**Catalog load.** `_ensureChatCatalog()` fetches `/api/chat/providers` once per panel open and
caches the promise on the instance. Called from `open()` (so titles can render names) and from
the model dropdown. Failure degrades to the raw-id title and a picker with only the default row.

**Header.** Split the current single title into two pickers:

```
.chat-panel__header
  ├── .chat-panel__provider-picker      (existing)  "Chat · Claude ▾"
  ├── .chat-panel__model-picker         (new)       "Opus 5 High ▾"
  │   ├── button.chat-panel__model-picker-btn
  │   └── .chat-panel__model-dropdown
  ├── .chat-panel__session-picker       (existing)
  └── .chat-panel__actions              (existing)
```

`_updateTitle(providerId, model)` stops appending the model to the provider text and instead
sets the model button label: catalog `name` when known, `prettifyModelId`-style fallback
otherwise, "Default" when `model` is null.

**Dropdown.** `_showModelDropdown` / `_hideModelDropdown` / `_renderModelDropdown` mirror the
provider trio. Rows:

1. "Provider default" with a subtitle: the configured model name if `configuredModel` is set,
   else "CLI default". Selecting it sets `tab.model = null`.
2. One row per catalog model: name, tagline, tier badge (reuse `.model-card` badge classes
   from `analysis-config.css` only if they are scoped; otherwise add minimal `.chat-panel__model-item`
   styles in `pr.css`, light + dark).

Active row gets the checkmark. Unavailable providers never reach this dropdown (the provider
picker already disables them).

**Selection gate.** Extract the freshness check now inlined in `_selectProvider`
(`messages.length === 0 && !isStreaming && !streamingContent && !titleFromUser`) into
`_isTabFresh(tab)` and use it from both pickers. `_selectModel(modelId)`:

- fresh tab → set `tab.model`, DELETE any already-created empty session (same as
  `_selectProvider`), re-render title.
- non-fresh tab → `_confirmModelSwitch(tab, modelId)` (§5a), then
  `_openNewTab({ provider: tab.provider, model: modelId })` on confirm.

`_selectProvider` resets `tab.model` to `null` when the provider changes, because the catalog
changes with it.

### 5a. Model-change dialog

**Product decision:** a conversation keeps one model. Mid-session switching is not supported,
and the dialog says so. Chats in pair-review are lightweight: they discuss a change, they do
not build the product. Starting a fresh one is cheap. (Most bridges could switch mid-session:
Codex sends `model` on every `turn/start`, ACP has a session-level `unstable_setSessionModel`,
Claude and Pi/OMP could respawn with `--resume` plus a new `--model`. Not doing it is a
choice, not a limitation. The dialog exists to teach the rule, once.)

Flow in `_confirmModelSwitch(tab, modelId)`:

1. If `localStorage['pair-review:chat-model-switch-ack'] === '1'` → resolve `true` immediately.
   Read inside `try/catch`; a throwing storage means "not acknowledged".
2. Else `await window.confirmDialog.show({...})`:
   - title: `Start a new conversation?`
   - message, two short paragraphs (the second is the explanatory text):
     `Choosing <Model> opens a new tab with <Provider> · <Model>. This conversation stays open.`
     `pair-review does not switch models mid-conversation. Each chat keeps the model it started
     with. Chats are meant to be lightweight, so starting a new one is the intended way to try a
     different model.`
     `ConfirmDialog` sets `message` via `textContent`; pass `\n\n` and style the message
     element with `white-space: pre-line` (scoped to the dialog) so the break renders.
   - confirmText: `New conversation`, confirmClass: `btn-primary` (not the `btn-danger`
     default; nothing is destroyed)
   - cancelText: `Keep <CurrentModel>`
   - checkboxLabel: `Don't ask again`
3. On confirm with the checkbox checked → write the ack key (`try/catch`). On cancel → nothing.
4. Resolve with the choice. Caller opens the new tab only on confirm.

If `window.confirmDialog` is absent (unit sandbox, or a page that did not load it) fall through
as if acknowledged. Both `pr.html` and `local.html` load `ConfirmDialog.js` and
`analysis-config.css`, which holds the dialog shell CSS, so the dialog renders in both modes.

**ConfirmDialog change.** `show()` gains one opt-in option, `checkboxLabel`. When present, a
`<label><input type="checkbox"> …</label>` renders between the message and the buttons, and
`onConfirm` is called with `{ checkboxChecked }`. The promise still resolves to the same
string it does today. Every existing caller passes no `checkboxLabel`, so nothing they see
changes. The checkbox must be removed and reset on every `show()` and `hide()` so a previous
caller's state never leaks into the next dialog. `ConfirmDialog.js` has no module export; add
the `if (typeof module !== 'undefined')` pattern so the checkbox can be unit-tested against
the real component.

Ack scope is per browser via `localStorage` (a per-viewer convenience, the documented use for
it). A "Reset dismissed dialogs" control on the settings page is a follow-up; until then the
user clears it by clearing site data.

**Request body.** `_createSessionForTab` sends `{ provider, reviewId, model: tab.model }`.
Capture `tab.model` alongside `capturedProvider` and extend the post-await guard: if either
changed while the request was in flight, DELETE the created session and return null. The
legacy `createSession(contextCommentId)` path sends the same `model` field. Both bodies are
built by one new helper `_sessionRequestBody(tab)` to stop the two paths drifting.

**Restore paths** (`_restoreTabs`, `_loadMRUSession`, `_activateSessionFromHistory`) already
hydrate `tab.model` from the sessions list. Those tabs have messages, so the picker opens a new
tab. No change beyond the title rendering.

### 6. Docs and config

- `README.md`: chat section gains a "Choosing a model" paragraph and documents
  `chat_providers.<id>.model` and `models_from`.
- `config.example.json`: `chat_providers._comment` lists `model` and `models_from`.
- Changeset: `minor`, "Select the chat model from the chat panel".

## Files to Modify

| File | Change |
|------|--------|
| `src/chat/chat-providers.js` | `models_from` on built-ins; merge key in `getChatProvider` |
| `src/chat/chat-models.js` | **new** `getChatModelCatalog`, `resolveChatModel` |
| `src/chat/session-manager.js` | `_createBridge` resolves via `resolveChatModel`, passes `extraArgs`/`env`; `resumeSession` unchanged but now resolved |
| `src/chat/claude-code-bridge.js` | `extraArgs` option, appended in `_buildArgs` |
| `src/chat/codex-bridge.js` | `extraArgs` option, appended to `codexArgs` |
| `src/chat/pi-bridge.js` | `provider/model` split in `_buildArgs` |
| `src/chat/acp-bridge.js` | accept and ignore `extraArgs` with a log line |
| `src/routes/chat.js` | `GET /api/chat/providers`; `model` validation; hook payload `cli_model` |
| `src/hooks/payloads.js` | `cli_model` in chat payloads |
| `public/js/components/ChatPanel.js` | model picker, `_isTabFresh`, `_selectModel`, `_confirmModelSwitch`, `_sessionRequestBody`, title split, catalog cache |
| `public/js/components/ConfirmDialog.js` | opt-in `checkboxLabel`; `onConfirm({ checkboxChecked })`; module export |
| `public/css/pr.css` | `.chat-panel__model-picker*` light + dark |
| `README.md`, `config.example.json`, `.changeset/chat-model-selection.md` | docs |

## Hazards

**`_createBridge` has two callers**: `createSession` (fresh session, `options.model` from the
request) and `resumeSession` (`row.model` from the DB). Both must go through the resolver.
`resumeSession` today forwards the raw stored string; a session created on a canonical id
would otherwise resume with `--model opus-5-high`, which the CLI rejects.

**`getChatProvider` is called from** `createSession`, `resumeSession`, `_createBridge`,
`checkChatProviderAvailability`, `getAllChatProviders`, and `GET /api/config`. Adding
`models_from` to the merge is additive; none of those callers enumerate keys.

**`PiBridge._buildArgs` is inherited by `OmpBridge`**. The `provider/model` split lands in one
place and affects both. OMP has no `--provider` flag semantics in its review provider
(`omp-provider.js` never splits), so the split must be gated on `this.provider == null`
and only applied when the chat provider type is `pi`. Verify OMP tests still emit
`--model <raw>`.

**Two frontend paths build the session request body**: `_createSessionForTab` and the legacy
public `createSession(contextCommentId)`. Existing duplication. Route both through
`_sessionRequestBody(tab)` so `model` cannot be added to one and forgotten in the other.

**Freshness gate duplicated**: `_selectProvider` inlines the gate; `_selectModel` needs the same
one. Extract `_isTabFresh` first, then use it in both. `tests/unit/chat-panel.test.js` asserts
the provider-swap-on-fresh-tab behaviour; keep those green.

**Async race: in-flight session create.** `sendMessage` → `_createSessionForTab` awaits the
POST. Between scheduling and response the user can (a) close the tab, (b) switch provider,
(c) switch model. Cases a and b are already guarded (DELETE + return null). Add c with the
same shape. The DB row is created with the captured model, so a late DELETE is the only
correct cleanup.

**Async race: provider switch resets model.** `_selectProvider` on a fresh tab sets
`tab.model = null` and DELETEs an existing empty session. If the model dropdown is open at that
moment it is rendering the old catalog. Hide the model dropdown from `_selectProvider`.

**`window.confirmDialog` is a shared singleton** with nine callers (`local.js:331,846`,
`pr.js:6471,8252`, `VoiceCentricConfigTab.js:1488`, `AdvancedConfigTab.js:1439`,
`SnippetManager.js:315`, `cancel-background-job.js:81`, and `TextInputDialog.js:82` which
only reads `isVisible`). All rely on the string resolution and on `btn-danger` being the
default confirm class. The checkbox is opt-in and reset per `show()`; the resolution type
and defaults do not change. `TextInputDialog` and `SnippetManager` refuse to open while
`confirmDialog.isVisible`; the model dialog inherits that mutual exclusion for free.

**Async race: dialog open while the tab moves on.** Between `show()` and the user's click the
stream can finish, the tab can be closed, the provider can be switched, or another tab can be
activated. Capture the tab object and the target model before awaiting. On confirm, re-check
that the tab still exists in `this._tabs`; if not, do nothing. Open the new tab with the
captured provider, not `this._activeProvider`. `_selectProvider` hides the model dropdown but
must not hide the confirm dialog (the user is mid-decision); it can only be reached by
keyboard while the dialog's backdrop is up, which the dialog already blocks.

**Passthrough compatibility.** `chat_providers.<id>.model` may hold a raw CLI string
(`claude-sonnet-4-6`, `anthropic/claude-…`). The resolver must return it verbatim when not in
the catalog. Session-manager tests at `tests/unit/chat/session-manager.test.js:1083-1100`
and `:1176-1191` assert the current raw forwarding; they should keep passing unchanged.

**Catalog entries with `cli_model: null`** (all three Pi modes, some config entries) mean
"no model flag". `resolveChatModel` must return `cliModel: null`, and every bridge must treat
null as "omit", which they already do for a missing model. Pi's `multi-model` and
`review-roulette` entries carry review-only `--skill` args; they are still selectable for
chat because the catalog is shared. Flag in the picker via their existing badges; do not
filter them out (that is a catalog concern, handled by `disabled_models` config).

**`chat.started` hook consumers** may compare `model` to a CLI string. Changing the value to a
canonical id is a behaviour change for hook scripts; `cli_model` is added so both are
available. Note it in the changeset.

**E2E stubs.** `tests/e2e/chat-tabs.spec.js:29-30` stubs a single available provider by
patching `/api/config`. The new `/api/chat/providers` endpoint needs its own stub in the same
specs or the picker will render the real catalog. Never run two E2E suites concurrently.

## Tests

- `tests/unit/chat/chat-models.test.js` (new): catalog shape strips CLI fields; alias resolves
  to canonical; `cli_model: null` → `cliModel: null`; unknown selector passthrough;
  `models_from` fallback to `type`; provider with no catalog; `configuredModel` resolution
  (canonical, alias, raw).
- `tests/unit/chat/session-manager.test.js`: `_createBridge` passes `cliModel`/`extraArgs`/`env`
  for a Claude effort entry and a Codex effort entry; resume re-resolves; raw config model
  still forwarded verbatim; env merge order.
- `tests/unit/chat/claude-code-bridge.test.js`, `codex-bridge.test.js`: `extraArgs` placement in
  argv (Codex: after `app-server` config flags; Claude: after `--model`).
- `tests/unit/chat/pi-bridge.test.js`, `omp-bridge.test.js`: `provider/model` split for Pi only.
- `tests/integration/chat-routes.test.js`: `GET /api/chat/providers` shape and CLI-field
  stripping; `POST /api/chat/session` rejects a non-string model; hook payload has `cli_model`.
- `tests/unit/confirm-dialog.test.js` (new, imports the real component): no checkbox without
  `checkboxLabel`; renders with it; `onConfirm` receives `checkboxChecked`; state reset between
  two consecutive `show()` calls; string resolution unchanged.
- `tests/unit/chat-panel.test.js`: dropdown renders default row + catalog; `_isTabFresh`;
  `_selectModel` on fresh tab mutates in place and DELETEs an empty session; on non-fresh tab
  shows the dialog and opens a new tab only on confirm; cancel leaves the tab untouched; ack
  key set only when the box was checked; ack key short-circuits the dialog; throwing
  `localStorage` is treated as not acknowledged; tab closed while the dialog is open → no new
  tab; `_selectProvider` resets model; request body carries `model` on both create
  paths; in-flight model change triggers DELETE; title uses catalog name and falls back.
- `tests/e2e/chat-model-picker.spec.js` (new): pick a model on a fresh tab, send, assert the
  session row's model via `GET /api/review/:id/chat/sessions`; picker on a tab with messages
  shows the dialog, confirm opens a new tab; check "Don't ask again", confirm, switch again →
  no dialog. Run against both `/local/:id` and `/pr/...` pages.

## Follow-ups (out of scope)

- Sticky last-used model per provider in `localStorage`.
- "Reset dismissed dialogs" on the settings page (clears the model-switch ack).
- A global `chat_model` setting on the settings page (would need a per-provider shape;
  `chat_providers` is read-only there today).
- Mid-conversation model switching (Codex sends `model` on every `turn/start`, so it is
  technically possible there; Claude `--resume` would need a respawn).

## Implementation notes (2026-09-08, after two review rounds)

Deviations from the design above, all deliberate:

- **Runtime fields resolve field-level, not off the merged entry.** `mergeModels` replaces a
  built-in wholesale, so a partial config override (`{ id, tier, name }`) would have erased
  `cli_model`/`env`. `resolveChatModel` now resolves against the separate built-in and config
  override through the shared `resolveCliModelConfig` helper in `src/ai/provider.js`, which also
  replaced five identical ladders in the review providers. The `cliName` rung is gone (dead for chat).
- **`supports_chat: false`** marks analysis-only catalog entries (Pi `multi-model`,
  `review-roulette`). Filtered at the chat choke point only. A configured selector naming one
  resolves to provider default with a warn.
- **Provider-default catalog rows are suppressed** in the picker (resolved `cliModel === null`
  with no args/env). Pi's and OMP's `default` entries no longer duplicate the "Provider default" row.
- **Responses carry `model`** (canonical id or null) on create, resume, and every sessions-list
  row. The frontend adopts it after the in-flight guards.
- **`default_model` does not feed chat.** Docs corrected. Chat's starting selection comes from
  `chat_providers.<id>.model` only.
- **Claude bridge now honours `chat_providers.claude.args`** (append semantics, same as Pi/OMP).
- **Escape guard.** `_onKeydown` yields to `window.confirmDialog.isVisible` before its ladder.
- **Zero-tab model pick** opens a new tab, mirroring the provider picker.
