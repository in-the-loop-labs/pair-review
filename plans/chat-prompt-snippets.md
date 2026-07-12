# Chat Prompt Snippets Library

## Context

The user reuses the same prompts in chat constantly. This adds a global (user-level, not repo-specific) library of prompt snippets, insertable from a new button in the chat input area. Decisions made with the user:

- **Button** sits to the LEFT of the send button in `.chat-panel__input-actions`.
- **Popup** lists snippets in MRU order, with a small "Snippets" header + gear icon.
- **Click inserts** the snippet into the input; **Cmd/Ctrl+click inserts AND sends**.
- **Body-only snippets** (no titles); popup shows a ~60-char single-line truncated preview.
- **Management** = shared editor component, reachable from the popup gear (as a modal) AND as a "Chat Snippets" section on the global settings page.
- **Global storage** now; schema must not preclude future repo-level snippets.
- Works in both PR and local mode (automatic — ChatPanel is one shared component via `PanelGroup.js:60`).

## Design decisions

- **Dedicated `chat_snippets` table (migration 54)**, not a JSON blob in `global_settings`: `GlobalSettingsService` validates keys against the settings registry (would need special-casing), and MRU touch would rewrite the whole array (racy with concurrent edits). `CouncilRepository` (`src/database.js:5699`) is the exact template — it already has `touchLastUsedAt()` (line 5767) and MRU ordering `ORDER BY last_used_at DESC NULLS LAST, updated_at DESC` (line 5756).
- **New `src/routes/snippets.js`** (pattern: `src/routes/councils.js`), not folded into settings routes.
- **`public/js/components/SnippetManager.js`**: one class, two entry points — inline mount for settings page, static `SnippetManager.openModal()` wrapper (modal shell pattern from `ReviewModal.js`, but `addEventListener` not inline `onclick`).
- **MRU touch on every insert** (plain and cmd-click), fire-and-forget: `fetch(...).catch(() => {})`, never awaited, never blocks insert.

## Step 1 — Database (`src/database.js`)

- Line 24: `CURRENT_SCHEMA_VERSION` 53 → 54.
- `SCHEMA_SQL` (after `global_settings`, ~line 374):
  ```sql
  CREATE TABLE IF NOT EXISTS chat_snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    last_used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
  ```
  No `repository` column now; repo-scoping later = `ALTER TABLE ADD COLUMN` + a `WHERE` filter. Nothing precluded.
- `INDEX_SQL`: `CREATE INDEX IF NOT EXISTS idx_chat_snippets_last_used ON chat_snippets(last_used_at DESC)`.
- `MIGRATIONS[54]`: copy migration 53's idempotent shape (`tableExists` guard + `IF NOT EXISTS` index). Fresh installs get the table from `setupSchema()`'s `SCHEMA_SQL` loop, so the guard is mandatory.
- New `ChatSnippetRepository` class next to `CouncilRepository`, modeled on it:
  - `create({ body })` (validate non-empty string), `getById(id)`, `list()` (MRU order, same SQL as councils), `update(id, { body })` (bumps `updated_at`), `touchLastUsedAt(id)`, `delete(id)`. All boolean-returning mutators return false for unknown id.
- Export `ChatSnippetRepository` from `module.exports` (~line 6153).

## Step 2 — API routes (new `src/routes/snippets.js`)

Copyright header; `logger` (never console); top-level requires. Handlers build `new ChatSnippetRepository(req.app.get('db'))`; try/catch → `logger.error` + 500.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/snippets` | — | `200 { snippets: [...] }` MRU order |
| POST | `/api/snippets` | `{ body }` | `201 { snippet }`; `400` missing/empty/non-string/>10000 chars |
| PUT | `/api/snippets/:id` | `{ body }` | `200 { snippet }`; `400` / `404` |
| DELETE | `/api/snippets/:id` | — | `200 { success: true }`; `404` |
| POST | `/api/snippets/:id/touch` | — | `200 { success: true }`; `404` |

`:id` via `Number.parseInt`, NaN → 400.

**Mount in BOTH servers**: `src/server.js` (~line 489, next to `settingsRoutes`) AND `tests/e2e/global-setup.js` (~line 698). Missing the second makes every snippet E2E test 404.

## Step 3 — Shared editor (new `public/js/components/SnippetManager.js`)

- `new SnippetManager(container, { onChange })`: list of snippet rows (truncated preview + Edit/Delete sibling buttons — rows are divs, NOT buttons, per no-nested-interactive rule in `public/js/CONVENTIONS.md`), "Add snippet" button, textarea add/edit form. All data via Step-2 API; re-fetch after each mutation; `onChange()` after success. `destroy()` removes document listeners + clears container.
- Static `SnippetManager.openModal({ onClose })`: `.modal-overlay`/`.modal-backdrop`/`.modal-container` shell, header "Manage snippets", mounts an instance; teardown destroys instance, removes overlay, `onClose(changed)`.
- Escape all snippet text (`textContent` or escapeHtml helper).
- Export: `window.SnippetManager = ...` + `if (typeof module !== 'undefined')` CommonJS export (pattern: bottom of `ChatPanel.js`).
- Script tags before ChatPanel.js/settings.js in: `public/pr.html` (~line 435), `public/local.html` (~line 632), `public/settings.html` (~line 126).

## Step 4 — ChatPanel wiring (`public/js/components/ChatPanel.js`)

**Naming hazard**: "snippet" already means *code-snippet enrichment* in this file (lines 2812–2876, `_enrich...snippet`). Use distinct names for the new UI: `_promptSnippet*` methods / `chat-panel__snippet-picker` CSS is fine (no CSS collision), but method names must not collide or confuse — prefix with `_snippetDropdown`/`_insertSnippet` is acceptable if grep-distinct; prefer `_promptSnippet` prefix for clarity.

- **Markup** in `_render()`, inside `.chat-panel__input-actions` (line 867), BEFORE send button (868): picker wrapper div (`position: relative`) with button + hidden dropdown div.
- **Refs** cached near lines 890–892; **event** bound in `_bindEvents()` near line 933.
- **New methods** (copy provider-dropdown lifecycle, lines 1692–1778):
  - `_toggleSnippetDropdown()` / `async _showSnippetDropdown()` / `_hideSnippetDropdown()` / `_renderSnippetDropdown(snippets)`.
  - `_showSnippetDropdown()`: hide provider + session dropdowns first; `await` GET `/api/snippets` (`[]` on failure); **after the await, bail if panel closed or dropdown toggled meanwhile**; track an in-flight flag so double-click doesn't double-fetch. Outside-click one-shot document handler via `setTimeout(..., 0)` — guard the timeout callback so a fast hide doesn't leak the listener.
  - Render: header row (div) with "Snippets" span + gear button; empty state ("No snippets yet" + Manage button); items as buttons with escaped 60-char first-line previews. Full bodies in a `Map` (`this._snippetsById`), not data-attributes.
  - Item click: `_insertSnippet(id, { send: e.metaKey || e.ctrlKey })`, then hide dropdown. Gear/Manage: hide dropdown, `SnippetManager.openModal()` (guard `typeof`).
- **`_insertSnippet(id, { send })`**:
  - Insert at cursor (`selectionStart/End`); prefix `\n` if preceding char exists and isn't whitespace; caret to end of insertion; focus input.
  - Programmatic value change bypasses the `input` listener (952–955) — replicate: `_autoResizeTextarea()` + recompute `sendBtn.disabled` (the adopt/update handlers are the precedent).
  - Fire-and-forget touch POST (both click variants).
  - If `send`: call `this.sendMessage()` — its own guards handle empty (2227) and streaming (2235, returns BEFORE input is cleared at 2244, so cmd-click-while-streaming degrades to insert-only). Do NOT duplicate those guards.
- **Mutual-exclusion sites** (all must be touched — pairwise hand-maintained):
  - `close()` (~1388) and `_startNewConversation()` (~1434): add `_hideSnippetDropdown()`.
  - `_showProviderDropdown()` (1704) and `_showSessionDropdown()` (1838): each also hides snippet dropdown; snippet show hides the other two.
  - `destroy()` (~4996): call `_hideSnippetDropdown()` before clearing container (prevents document-listener leak).
- **CSS** in `public/css/pr.css` (loaded by pr.html, local.html AND settings.html — one stylesheet serves all): picker `position: relative`; dropdown `position: absolute; bottom: calc(100% + 6px); right: 0` (opens **upward** — input is at panel bottom, unlike header dropdowns); `min-width: 260px; max-height: 320px; overflow-y: auto`; ellipsis previews; SnippetManager list/form styles; dark-theme overrides near line 10771.

## Step 5 — Settings page

- `public/settings.html`: after repos section (~line 114), static `<section id="snippets-section">` with header "Chat Snippets" + `<div id="snippets-manager">` mount point. Visible by default (component renders own empty/error states).
- `public/js/settings.js`:
  - `init()` (~113): after `loadRepos()`, mount `new SnippetManager(...)` (guard `typeof`), set `this.snippetsVisible`.
  - `navItems(sections, includeRepos)` (line 721): **add a third boolean param** `includeSnippets` (additive — keeps existing unit-test call sites at `tests/unit/settings-page.test.js:639–655` working). Update caller `buildNavigation()` (757).
- `src/settings/registry.js` untouched (list editor doesn't fit scalar registry rows).

## Step 6 — Tests

- **Schema**: add `chat_snippets` DDL + index to `tests/utils/schema.js` (next to `global_settings`, line 336) — index name must match production exactly. This single file feeds both integration and E2E DBs (CLAUDE.md's older pointers to global-setup.js/routes.test.js both delegate here now).
- `tests/unit/chat-snippet-repository.test.js` (model: `council-repository.test.js`): create/reject-empty, getById miss, MRU ordering (unused rows after used; ties by `updated_at DESC`), update bumps `updated_at` (backdate via SQL then assert strictly-greater — NO sleeps per `tests/CONVENTIONS.md`), touch, delete, unknown-id falses.
- `tests/integration/snippets-routes.test.js` (model: `council-routes.test.js`): **`listenOnLoopback` + `request(server)`, never `request(app)`**. All 5 endpoints: happy, 400s, 404s, GET order changes after touch.
- `tests/unit/snippet-manager.test.js` (jsdom, mocked fetch): inline mount render/empty state, CRUD calls + re-render, onChange, openModal mount + backdrop teardown removes overlay and listeners.
- `tests/unit/chat-panel-snippets.test.js` (scaffold from `chat-panel.test.js`; don't `vi.clearAllMocks()`): `_insertSnippet` empty/mid-text/newline-prefix/disabled-recompute/touch-fired/send:true invokes sendMessage/send-while-streaming leaves text; dropdown mutual exclusion; `close()` hides.
- `tests/e2e/chat-snippets.spec.js` (model: `chat-tabs.spec.js`): button visible; empty state → manage; gear → modal → add; insert fills textarea + enables send; MRU re-order after insert (seed via `page.request.post`); exercise BOTH PR and local mode; settings page shows section + CRUD round-trip.
- Extend `tests/unit/settings-page.test.js` navItems describe for the new flag.

## Step 7 — Changeset + polish

- `.changeset/chat-prompt-snippets.md`, bump **minor**, describing the feature.
- Copyright header on every new file.
- README: short mention under chat features.

## Sequencing

1. DB + test schema + repo unit tests
2. Routes + both mounts + integration tests
3. SnippetManager + unit tests + script tags
4. ChatPanel wiring + CSS + unit tests
5. Settings section + nav + tests
6. E2E spec; run `pnpm test` and `pnpm run test:e2e`
7. Changeset

## Verification

- `pnpm test` (unit + integration), `pnpm run test:e2e`.
- Manual: start a local review AND a PR review; verify button, popup MRU, insert-at-cursor, cmd-click send, gear modal, settings section, dark theme.

## Hazards

- **`_render()`/`_bindEvents()` shared by both modes** — a markup error breaks chat everywhere; ref-caching (890–911) has no null guards, so template elements must exist before refs are cached.
- **`sendMessage()` callers** (2225): send click (933), Enter keydown (969/976), adopt/update handlers, and now snippet cmd-click. Guards: empty → return 2227; streaming → return 2235 BEFORE input clear 2244. Don't duplicate guards divergently.
- **Programmatic input mutation bypasses `input` listener (952–955)** — must replicate disabled-recompute + autosize or send stays disabled.
- **Dropdown exclusion is pairwise/hand-maintained** — third dropdown touches SIX sites: two show methods, `close()`, `_startNewConversation()`, plus new show hiding both, plus `destroy()`.
- **Outside-click `setTimeout(...,0)` leak** — fast toggle can attach the document listener after hide nulled the ref; guard the timeout callback. `destroy()` currently doesn't remove dropdown listeners; ours must.
- **Async race in `_showSnippetDropdown`** — panel can close / another dropdown open during the fetch await; bail after await. Don't blindly copy `_showSessionDropdown` (1838) — it lacks this guard. Two rapid clicks = two in-flight fetches; use an in-flight flag.
- **Touch vs list refresh race** — reopening popup right after insert may show pre-touch order. Accepted; never await touch.
- **Two servers mount routes** — `src/server.js` AND `tests/e2e/global-setup.js`; prior art: `settingsRoutes` mounted in both.
- **`navItems` arity** — two call sites (`buildNavigation()` at settings.js:757, unit tests at settings-page.test.js:639–655); additive third param keeps both working.
- **Migration idempotency** — fresh installs create the table via `SCHEMA_SQL` before migrations; `tableExists` guard + `IF NOT EXISTS` index mandatory; index name identical in `INDEX_SQL`, migration, and `tests/utils/schema.js`.
- **"snippet" naming collision** — ChatPanel already uses "snippet" for code-snippet enrichment (2812–2876). Choose grep-distinct method names (e.g. `_promptSnippet*` or `*SnippetDropdown`), never reuse existing names.
- **No nested interactive elements** (`public/js/CONVENTIONS.md`) — popup header is a div with a gear button; manager rows are divs with sibling Edit/Delete buttons.
