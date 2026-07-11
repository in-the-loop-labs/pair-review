# Global Settings Page — Design & Implementation Plan

## Goal
A `/settings` page for global (non-repo) settings. Today these live only in
`~/.pair-review/config.json` / `config.local.json` (+ managed + project-local
layers) and env vars, and most are frozen at startup. Requirements:

- In-app edits persist to the **app SQLite DB** (`global_settings` table), never
  to the config files.
- The page shows the **effective value** of every setting plus its **source**,
  making "not explicitly set" (source = default) obvious.
- Precedence: **in-app (DB) > env/CLI > project config.local.json > project
  config.json > ~/.pair-review/config.local.json > ~/.pair-review/config.json >
  managed config > built-in default**.
- In-app changes to dynamic settings take effect immediately without restart;
  startup-captured settings are editable but flagged **restart required**;
  bootstrap settings are **read-only**.
- Navigation: gear on landing page header -> `/settings`; global page lists
  configured repos -> per-repo settings; repo settings page links back up.

## Recon anchors (verified)
- Config loader: `src/config.js` — `loadConfig()` at :331-426 merges layers
  low->high: DEFAULT_CONFIG (:63-103) -> `config.managed.json` -> global
  `~/.pair-review/config.json` -> global `config.local.json` -> project
  `<cwd>/.pair-review/config.json` -> project `config.local.json`, via
  `deepMerge` (:122-142). `PORT` env applied at :396-403.
- Server loads config independently at `src/server.js:171`, stores via
  `app.set('config', config)` at :395. Routes read `req.app.get('config')`
  per request (e.g. `src/routes/config.js:130`) — object frozen for process
  lifetime today.
- CLI entry loads config at `src/main.js:647`; retention GC uses it at
  `src/main.js:338,355`.
- Migrations: `src/database.js` — `CURRENT_SCHEMA_VERSION = 51` (:24), MIGRATIONS
  object (:461..~2241), SCHEMA_SQL (:29), INDEX_SQL (:370), helpers
  `tableExists` (:454) / `columnExists` (:442). New table => SCHEMA_SQL entry +
  MIGRATIONS[53] + bump to 53. Repository-class pattern:
  `RepoSettingsRepository` (:3159); export at :6009+.
- Test schema single source of truth: `tests/utils/schema.js` (SCHEMA_SQL :18,
  INDEX_SQL :339, `createTestDatabase()` :394). (CLAUDE.md's "update
  global-setup + routes.test.js schemas" is stale — both consume this file.)
- Route mounting: `src/server.js:410-455`; mount new router before `prRoutes`.
  Route file conventions: see `src/routes/context-files.js` (copyright header,
  `logger` not console, top-level requires, `req.app.get('db')`).
- Page routes: `src/server.js:286-380`; add `GET /settings` BEFORE the existing
  `GET /settings/:owner/:repo` (:365).
- Provider/model precedence ladder: `src/review-config.js`
  `_buildSingleSelection` (:76-91) and `resolveReviewConfig` (:123-162).
- Repo settings feature (model to copy): routes `src/routes/config.js:248-405`,
  table `src/database.js:144-164`, frontend `public/repo-settings.html`,
  `public/js/repo-settings.js`, `public/css/repo-settings.css`.
- Landing header: `public/index.html:1374-1395` (logo, theme toggle, help btn).
- Repo enumeration: no endpoint exists. `repo_settings` rows are ALSO created by
  local_path auto-register and pool-fetch leases, so a row alone != "user
  configured". `config.repos` (file) entries count as configured too.

## Architecture

### 1. DB (migration 53)
```sql
CREATE TABLE IF NOT EXISTS global_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,            -- JSON-encoded
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_global_settings_key ON global_settings(key);
```
Add to SCHEMA_SQL + MIGRATIONS[53] (idempotent, `tableExists` guard, console.log
style per existing migrations) + INDEX_SQL, bump CURRENT_SCHEMA_VERSION to 53.
Mirror byte-identically in `tests/utils/schema.js`.

`GlobalSettingsRepository` class in `src/database.js` (follow
RepoSettingsRepository style): `getAll()` -> `{key: parsedValue}`,
`get(key)`, `set(key, value)` (upsert, JSON.stringify), `delete(key)`,
`deleteAll()`. Export it.

### 2. Settings registry — `src/settings/registry.js` (new)
Single catalog driving validation, source attribution, and the UI. Each entry:
```js
{
  key: 'summaries.enabled',        // dot-path into config object
  label: 'Enable summaries',
  description: '...',
  group: 'summaries',              // general | ai | summaries | tours | chat | advanced | readonly
  type: 'boolean',                 // boolean | string | integer | enum
  values: [...],                   // enum only
  default: <value>,                // must match DEFAULT_CONFIG / inline default
  editable: true,
  restartRequired: false,
  envVar: 'PAIR_REVIEW_...',       // optional, for source attribution
  sensitive: false,                // mask value in API/UI
}
```

Entries (verify each default against `src/config.js` DEFAULT_CONFIG :63-103 and
inline defaults in `src/routes/config.js:160-200` before finalizing):

**Editable, immediate effect** (consumed per-request from `app.get('config')`):
- `theme` (enum light|dark, default light)
- `default_provider` (string, default claude; envVar PAIR_REVIEW_PROVIDER)
- `default_model` (string, default opus; envVar PAIR_REVIEW_MODEL)
- `tours.enabled` (bool false), `tours.auto_generate` (bool true),
  `tours.provider` (string ''), `tours.model` (string '')
- `summaries.enabled` (bool false), `summaries.auto_generate` (bool true),
  `summaries.provider` (string ''), `summaries.model` (string ''),
  `summaries.max_files` (int 50), `summaries.max_lines_added` (int 3000)
- `enable_chat` (bool true), `chat_provider` (string pi),
  `chat.enable_shortcuts` (bool true), `chat.enter_to_send` (bool true),
  `chat_spinner` (string, inline default 'dots')
- `comment_format` (enum, default legacy — check allowed values in
  reviews.js/chat.js), `comment_button_action` (inline default 'submit' —
  check allowed values in routes/config.js:167 consumers)
- `enable_graphite` (bool false), `external_comments` (bool false),
- `assisted_by_url` (string, default is the GitHub project URL)

**Editable, restart required** (captured at startup):
- `worktree_retention_days` (int 7), `review_retention_days` (int 21)
- `dev_mode` (bool false), `debug_stream` (bool false)
- `skip_update_notifier` (bool false)
- `yolo` (bool false; envVar PAIR_REVIEW_YOLO)

**Read-only** (bootstrap/sensitive/complex — displayed with value + source, no
edit control):
- `port` (envVar PORT), `single_port` (envVar PAIR_REVIEW_SINGLE_PORT),
  `db_name` (envVar PAIR_REVIEW_DB_NAME — circular: it selects the DB that
  would hold overrides)
- `github_token` (sensitive: true — never return the value; return whether set
  + source; envVar GITHUB_TOKEN), `github_token_command` (string)
- `providers`, `chat_providers`, `repos`, `hooks` (objects — return entry
  count only, e.g. `{configured: true, count: 3}`)

### 3. Source attribution + effective config —
`src/settings/global-settings-service.js` (new)

`loadConfig()` must additionally expose the individual merged layers. Add to
`src/config.js` a function `loadConfigLayers()` (or have `loadConfig` return
`layers` alongside `config`) returning ordered
`[{name: 'default'|'managed'|'config'|'config.local'|'project'|'project.local', data}]`
WITHOUT changing existing `loadConfig` behavior/return contract for existing
callers (add a field, don't restructure).

`GlobalSettingsService`:
- ctor `({ db, baseConfig, layers })` — `baseConfig` = deep clone of the fully
  merged file config (post `loadConfig`, i.e. env PORT already applied — note
  PORT attribution handled via envVar check, see below).
- `getOverrides()` — from `GlobalSettingsRepository.getAll()`, filtered to
  registry keys, values validated by type (ignore + log invalid rows).
- `buildEffectiveConfig()` — deep clone `baseConfig`, dot-path-set each
  override, return it. This object is what gets `app.set('config', ...)`.
- `resolve(key)` -> `{ value, source }` where source is first match in order:
  `app` (DB override) > `env` (registry envVar set in process.env) >
  `project.local` > `project` > `config.local` > `config` > `managed` >
  `default`. File-layer attribution = highest layer whose data has the dot-path
  defined (use a hasPath walk, NOT truthiness).
- `describe()` -> array for the API: registry metadata + `value` (masked if
  sensitive) + `source` + `overrideValue` (the raw DB value if any).
- `setOverride(key, value)` / `clearOverride(key)` — validate against registry
  (editable, type, enum membership, integer bounds >= 0), write DB, then return
  fresh `buildEffectiveConfig()` so the caller can re-`app.set`.

Precedence note (deliberate, approved direction): in-app DB overrides beat env
vars. For `default_provider`/`default_model` this means updating the ladder in
`src/review-config.js` — insert "global in-app override" ABOVE
`PAIR_REVIEW_PROVIDER`/`PAIR_REVIEW_MODEL` env but BELOW repo-scoped settings
and explicit per-run flags. New ladder for `_buildSingleSelection`:
explicit flag > repo default > global in-app override > env > global config
file > legacy provider/model keys > hardcoded claude/opus. `resolveReviewConfig`
council tiers unchanged otherwise. Update the doc comment at
`src/review-config.js:93-122`. NOTE: this demotes env below repo defaults
(previously env deliberately beat repo defaults) — this is the coherent
"specificity first, then in-app > env > files" model. Keep explicit per-run
CLI flags supreme (they are per-invocation intent, not settings).

### 4. Wiring (both entry points — CLAUDE.md parity rule)
- `src/server.js` startServer: after `loadConfig()` + existing override
  application, construct service (db is already initialized there — verify
  order; if config loads before DB init, move overlay application to just
  after DB init), `app.set('config', service.buildEffectiveConfig())`,
  `app.set('globalSettings', service)`. All existing per-request readers pick
  up overrides automatically.
- `src/main.js` CLI entry: after `loadConfig()` (:647) and DB init, overlay DB
  overrides onto the config object the CLI uses (retention GC, provider
  registration) so restart-required settings honor DB values on next start.
  Guard: if DB open fails, proceed with file config (log warning).
- On PUT/DELETE (routes below): service writes DB, rebuilds effective config,
  route does `req.app.set('config', effective)`.

### 5. API — `src/routes/settings.js` (new), mounted in server.js
- `GET /api/settings` ->
  ```json
  { "settings": [ { "key", "label", "description", "group", "type",
      "values", "default", "editable", "restartRequired", "sensitive",
      "value", "source", "overrideValue" } ] }
  ```
  For sensitive entries `value` is `null` and an extra `configured: true|false`
  is included. For object read-onlys `value` is `{count: N}`.
- `PUT /api/settings/:key` body `{ "value": <typed> }` -> 400 on unknown key,
  non-editable key, or type/enum validation failure; else save + re-set live
  config; respond `{ "setting": <same descriptor shape> }`.
- `DELETE /api/settings/:key` -> clears override (204-style `{setting}`
  response with recomputed source); unknown key -> 400; no override present ->
  still 200 (idempotent).
- `GET /api/settings/repos` -> repos configured in either store:
  ```json
  { "repos": [ { "repository": "owner/repo",
      "hasDbSettings": true,      // any user-facing repo_settings field non-null:
                                  // default_instructions, default_provider,
                                  // default_model, default_council_id,
                                  // default_tab, default_chat_instructions,
                                  // pool_size, pool_fetch_interval_minutes,
                                  // load_skills
      "hasFileConfig": false,     // key present in config.repos
      "localPath": "...|null", "updatedAt": "...|null" } ] }
  ```
  Union of both sources, sorted by repository. Rows with ONLY local_path /
  pool-lease timestamps => hasDbSettings false; include them anyway with both
  flags false ONLY if local_path is set (they're "known" repos) — UI shows a
  "known" vs "configured" badge.
- Page route in server.js: `app.get('/settings', ...)` -> sendFile
  `public/settings.html`, placed BEFORE `/settings/:owner/:repo`.

### 6. Frontend — `public/settings.html`, `public/js/settings.js`,
`public/css/settings.css` (all new)
Model structure/styling on the repo-settings page (`public/repo-settings.html`,
`public/js/repo-settings.js`, `public/css/repo-settings.css`) — same header,
theme handling, toast pattern (local showToast), card/section layout.

- Sections by `group`: General, AI Defaults, Summaries, Tours, Chat, Advanced
  (restart-required), Read-only ("From config files / environment").
- Each editable row: label + description, control by type (checkbox toggle /
  text input / number input / select for enums; provider selects populated from
  `/api/providers` like repo-settings does), a **source badge**
  (`default` | `managed` | `config.json` | `config.local.json` |
  `project config` | `project config.local` | `env` | `in-app`), and a
  **Reset** button visible only when source is `in-app`.
- Save model: per-setting immediate PUT on change (debounce text inputs on
  blur/Enter), toast on success, badge updates from response. Reset button ->
  DELETE, control re-renders with recomputed value+source. No global save bar.
- `source: default` renders the badge in muted style — this is the "not
  explicitly set" signal. `restartRequired` entries show a persistent inline
  note once modified ("takes effect after restart").
- Read-only rows: value (masked "configured"/"not configured" for
  github_token; "N entries" for objects) + source badge, no control.
- **Repositories section**: from `GET /api/settings/repos` — list each repo,
  badge "configured" (hasDbSettings/hasFileConfig, show which) or "known",
  link to `/settings/:owner/:repo`. Empty state text if none.
- Theme note: header theme toggle continues to work as-is (client-side); the
  `theme` setting is the default/initial theme. Do not couple them beyond
  what the existing pages do.

Navigation changes:
- `public/index.html` header (:1374-1395): add a gear icon button (match
  existing header button styling, e.g. help button) linking to `/settings`,
  with tooltip "Global settings". Wire in `public/js/index.js` if the header
  buttons are JS-wired.
- `public/repo-settings.html` / `public/js/repo-settings.js`: add a "Global
  settings" link in the header/breadcrumb area (near the existing back-to-PR
  link logic at repo-settings.js:57-83) pointing to `/settings`.
- Global settings page header: link back to `/` (home).

### 7. Tests
- Unit (`tests/unit/`): registry integrity (every entry has valid
  type/default/group; defaults match DEFAULT_CONFIG where applicable);
  GlobalSettingsService — source attribution across all layers (build layers
  fixtures), override precedence incl. env, dot-path set/get incl. nested keys
  and falsy values (false, 0, ''), validation rejections, sensitive masking.
- Integration (`tests/integration/global-settings-routes.test.js`): follow
  `tests/CONVENTIONS.md` + `tests/utils/loopback-server.js` (`request(server)`
  never `request(app)`); createTestDatabase from tests/utils/schema.js; cover
  GET list shape, PUT happy/invalid/unknown/non-editable, DELETE idempotent,
  live config re-set (app.get('config') reflects change after PUT), repos
  endpoint union/filter logic.
- review-config unit tests: extend existing tests for the new ladder position
  (in-app above env; env below repo defaults) — find existing
  review-config tests and update deliberately, do not just make them pass.
- E2E (`tests/e2e/global-settings.spec.js`): page loads at /settings, shows a
  known setting with `default` badge; toggling a boolean persists (reload ->
  in-app badge); reset returns badge to prior source; repos section lists a
  seeded repo_settings row and navigates to repo settings page; gear on
  landing page navigates to /settings. Headless, follow existing
  fixtures/helpers patterns (tests/e2e/analysis-history.spec.js).

### 8. Docs & release
- README: new "Global settings" section — how to open, precedence order,
  what restart-required means, that files are never written.
- Changeset `.changeset/global-settings-page.md`, `minor`,
  package `@in-the-loop-labs/pair-review`.

## File ownership (parallel agents — do not cross)
- **Backend agent**: src/database.js, src/settings/* (new), src/routes/settings.js
  (new), src/server.js, src/main.js, src/review-config.js, src/config.js,
  tests/utils/schema.js, tests/unit/*, tests/integration/*.
- **Frontend agent**: public/settings.html|css|js (new), public/index.html,
  public/js/index.js, public/repo-settings.html, public/js/repo-settings.js,
  tests/e2e/global-settings.spec.js.
- Contract between them = the API shapes above; do not change them
  unilaterally.

## Phase 2 — sections metadata, hidden, final (approved 2026-07-06)

Three additive capabilities on top of the shipped page. All build on the
existing registry/service/API; the sidebar nav (already implemented) derives
from `computeSections()` in public/js/settings.js.

### A. Sections as first-class registry data (+ badges)
- `src/settings/registry.js`: add ordered `SECTIONS` array:
  `{id, title, description?, badge: 'new'|'beta'|null}` for ids
  general, ai, summaries, tours, chat, advanced, readonly. Titles must match
  what the frontend renders today (lift them out of settings.js). Ship with
  `badge: 'beta'` on the tours section (feature-gated, off by default) and
  null elsewhere — product call, easy to change later.
- Optional per-setting `badge` field on registry entries (same values), null
  default.
- Registry test: every entry.group is a SECTIONS id; SECTIONS ids unique.
- API: `GET /api/settings` becomes
  `{ sections: [{id,title,description,badge}], settings: [...] }` (additive);
  each settings descriptor gains `badge` (string|null) and `final` (bool).
  Sections with zero visible settings are omitted from `sections`.
- Frontend: `computeSections()` consumes the `sections` payload (order,
  titles, badges) instead of deriving titles locally; Repositories stays a
  frontend-appended nav item. Badge pills render in section headers, sidebar
  nav items, and per-setting rows.

### B. Config-driven hiding — `settings_ui.hidden`
- New config key (file layers only, NOT a registry entry, not editable
  in-app): `settings_ui: { hidden: ["summaries", "tours.model", ...] }` —
  array mixing section ids and setting keys.
- Semantics: personal/org preference. Resolved from the MERGED effective
  config (normal deepMerge, arrays replace wholesale) so a higher layer can
  un-hide with `"hidden": []`.
- Service: `describe()` omits hidden entries (key listed, or its group
  listed). Routes: PUT and DELETE on a hidden key both 400
  ("hidden by configuration").
- Hiding a section does NOT disable the feature (hiding summaries config does
  not turn summaries off). Document this in README.
- Validate shape at service construction: must be array of strings; log and
  ignore otherwise. Unknown keys/ids: log debug, ignore.

### C. Final config — `"final": [...]`
- New top-level config key in any file layer: array of setting keys and/or
  section ids. Semantics: a LOCK, so computed as the UNION across all raw
  layers (deliberately NOT the deepMerged array — a higher layer cannot
  un-final; remove the declaration where it lives). Contrast with hidden
  (preference, merged) — document the difference.
- Effect on a finalized key:
  1. `resolve()` skips the app AND env tiers — value comes from the highest
     file layer that defines it, else default. Descriptor gets `final: true`;
     source shows the file layer (or default).
  2. `buildEffectiveConfig()` does not apply a DB override for it, and
     excludes it from `_globalOverrides`. Existing DB rows are ignored and
     logged, NOT deleted (un-finalizing restores them).
  3. Effective config carries `_finalKeys` (array of finalized registry
     keys) for consumers that consult env directly.
  4. `setOverride` -> 400 ("locked as final by configuration").
     `clearOverride` on a final key is ALLOWED (removes the ignored row; no
     effective-value change). Hidden blocks both; final blocks PUT only.
- Env-defeat at point of use (the only editable keys with env vars are
  default_provider/default_model):
  - `src/review-config.js` `resolveSingleProviderModel`/`_buildSingleSelection`:
    when `config._finalKeys` contains default_provider/default_model, skip the
    env tier (and the `_globalOverrides` tier is already empty for them).
  - `src/routes/shared.js` `getModel` (or its two callers in pr.js/local.js
    model else-branches): finalized default_model must resolve from config,
    not `PAIR_REVIEW_MODEL`. Grep all getModel callers first (Shared Function
    Safety).
  - `PAIR_REVIEW_YOLO` bridge is per-run CLI intent (--yolo); final does not
    intercept it — document as out of scope.
- UI: final rows render with control disabled + a lock/"final" badge next to
  the source badge, tooltip "Locked by configuration", no Reset button.

### Phase 2 API contract summary (frontend builds against this)
- GET /api/settings -> `{ sections, settings }`; descriptor adds
  `badge: string|null`, `final: boolean`; hidden entries absent.
- PUT /api/settings/:key -> 400 for hidden ("hidden by configuration") and
  final ("locked as final by configuration") keys.
- DELETE /api/settings/:key -> 400 for hidden; 200 for final (row removed,
  descriptor returned with final:true and file/default source).
- GET /api/settings/repos unchanged.

### Phase 2 file ownership
- Backend: src/settings/registry.js, src/settings/global-settings-service.js,
  src/routes/settings.js, src/review-config.js, src/routes/shared.js,
  src/routes/pr.js, src/routes/local.js (only if getModel change requires),
  tests/unit/settings-registry.test.js,
  tests/unit/global-settings-service.test.js,
  tests/unit/review-config.test.js,
  tests/integration/global-settings-routes.test.js.
- Frontend: public/settings.html, public/css/settings.css,
  public/js/settings.js, tests/unit/settings-page.test.js,
  tests/e2e/global-settings.spec.js.
- Main session: README, changeset update.
- Hidden/final behaviors are covered by unit+integration tests (crafted
  layers/config); E2E covers the tours Beta badge in section header + nav,
  and may cover final/hidden only if achievable without perturbing the shared
  E2E server config for other specs.

## Hazards
- `app.set('config', ...)` replacement: any module that captures
  `app.get('config')` in a closure at mount time (rather than per request)
  will hold a stale object. Backend agent MUST grep `app.get('config')` /
  `get('config')` and verify every capture site is per-request; list findings.
- `src/review-config.js:76-91` env-above-repo ordering was deliberate; we are
  reversing it by design — update tests + doc comments, don't leave both.
- Three analysis paths in `src/ai/analyzer.js` (analyzeAllLevels,
  runReviewerCentricCouncil, runCouncilAnalysis) read provider/model/config
  independently — verify each sees effective config, not a startup capture.
- Startup token caches in config.js (`_cachedCommandToken`) and provider
  registry (`applyConfigOverrides`) capture config at boot — that is why
  tokens/providers are read-only in the registry. Do not make them editable.
- `repo_settings` rows created by local_path auto-register
  (`local-review.js:731`) and pool leases (`database.js:3318`) must not appear
  as "configured" in the repos endpoint.
- Migration idempotency: DROP-guard/tableExists per SQLite migration safety
  rules in CLAUDE.md; single CREATE TABLE needs no transaction.
- Both CLI (`src/main.js`) and server (`src/server.js`) entry points load
  config independently — overlay must be applied in BOTH.

## Phase 3 — env var removal (shipped 2026-07-07)

Completes the TRANSITIONAL notes from the origin/main merge (1d8d807e). The
`PAIR_REVIEW_PROVIDER` / `PAIR_REVIEW_MODEL` env vars are hard-removed (major
breaking change). The `--provider` / `--model` CLI flags stay; their env-var
transport is gone. Per-run overrides are now threaded explicitly:
`startServer(db, poolLifecycle, { cliOverrides })` → `app.set('cliOverrides')`,
read per request by the analyze routes. `main.js` / `local-review.js` drop the
`process.env.PAIR_REVIEW_* = flags.*` bridges and the env→flags fold
(`normalizeProviderModelFlags`, deleted). The `default_provider` /
`default_model` registry entries drop their `envVar` attribution.

Final ladders (no env tier anywhere):

- `resolveProviderModel` (web analyze, `src/routes/shared.js`): request body >
  `cliOverrides` (per-run flags) > repo settings > config defaults (effective
  config already folds the in-app /settings override; final keys locked to file
  value) > legacy keys > `claude`/`opus`. The request/flag tiers deliberately
  beat repo settings AND `final` — they are per-invocation intent.
- `_buildSingleSelection` (headless/MCP, `src/review-config.js`): explicit
  (flags) > repo default > `config._globalOverrides` (in-app) > config files >
  legacy > hardcoded. Final keys need no special-casing: the effective config
  excludes them from `_globalOverrides` and folds the file value into
  `cfg.default_*`, so removing the env tier lets the file value win naturally.
- `_resolveStackProviderModel` (stack, `src/routes/stack-analysis.js`): request
  > `cliOverrides` > repo > config > legacy > hardcoded.

`getModel` / `getProvider` and both resolvers drop their `_finalKeys` env-defeat
guards (dead once env is gone). The headless CLI paths already pass
`flags.provider` / `flags.model` as `explicit`, and delegation forwards the real
flags on the auto-analyze URL, so no headless/delegation path depended on env.
