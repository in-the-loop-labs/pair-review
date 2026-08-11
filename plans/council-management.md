# Council Management Outside Reviews

Implementation spec. Written to be executable by an agent without further design
decisions — every choice is pinned. Line numbers are anchors as of 2026-08-10;
if they have drifted, search for the named function/id instead.

## Motivation

Councils (and "advanced" configurations — same `councils` table, distinguished
by the `type` column) can only be created, edited, and deleted from inside the
analysis-start modal during a review. A user requested management outside a
review: from the settings page, from files on disk, and from the command line.

The existing "export" copies the bare `config` JSON to the clipboard with no
name, type, or version — it cannot round-trip, which is why import was never
built.

## Design summary

- One canonical **council document format** used by export, files on disk, and
  the CLI.
- Councils in `~/.pair-review/councils/*.json` (later also
  `./.pair-review/councils/`) are a **read-only overlay** merged over DB
  councils. The file is the single owner; the UI's existing **Save As** path
  acts as "duplicate to my councils".
- **No import feature** (decision, 2026-08-10): dropping a document into the
  councils directory is import for file-owned councils; Save As/Duplicate
  converts a file council into an editable DB council. No import endpoint, no
  paste dialog, no CLI `import` verb.
- Settings page gets a full CRUD **Councils** section reusing the existing tab
  editors; the CLI gets its first subcommand, `pair-review council <verb>`.

Phases = PRs, shipped independently, in order: 1 → 2 → 3 → 4 → 5.
Suggested implementer: Phase 2 needs the strongest model (cross-cutting
wiring); 1, 3, 4, 5 are safe for a weaker model following this spec.

---

## Council document format (used by all phases)

```json
{
  "pair_review_council": 1,
  "name": "Dream Team",
  "type": "council",
  "description": "Optional free text",
  "config": { "voices": [...], "levels": {...}, "consolidation": {...} }
}
```

- `pair_review_council` — integer format version, exactly `1`. Required. Any
  other value → error "unsupported council document version".
- `name` — required non-empty string. (Identity lives in the document; today
  the name exists only in the `councils.name` column.)
- `type` — required, `"council"` (voice-centric) or `"advanced"`
  (level-centric).
- `description` — optional string. Not persisted to the DB (no schema change);
  preserved on file councils and shown as row tooltip/subtitle where cheap.
- `config` — exactly the shape stored in `councils.config` today. Legacy
  advanced configs using `orchestration` instead of `consolidation` must be
  accepted (existing consumers read `consolidation || orchestration`).

---

## Phase 1 — Document format + real export (PR 1)

### 1a. New file: `public/js/utils/council-document.js`

Dual-export module (browser global `window.CouncilDocument` + CommonJS), same
pattern as `public/js/utils/analyze-params.js:62-69`. Pure logic — **no DOM
access at load time** — because server code will `require()` it (precedent:
unit tests already require public/js files, e.g.
`tests/unit/analyze-params.test.js:14`; this is the first server-side
consumer, which is acceptable — the alternative is duplicating the format
logic).

Exports:
- `COUNCIL_DOCUMENT_VERSION = 1`
- `buildCouncilDocument({ name, type, config, description })` → document
  object. Throws on empty/missing name, invalid type, non-object config.
  Include `description` key only when non-empty.
- `parseCouncilDocument(input, { validateConfig } = {})` — `input` is a JSON
  string or already-parsed object. Throws `Error` with a human-readable
  message on: unparseable JSON, non-object, wrong/missing
  `pair_review_council`, missing/empty `name`, invalid `type`, non-object
  `config`. If `validateConfig(config, type)` is provided and returns a
  string, throw it. Returns `{ name, type, config, description }`.
- `councilFilenameStem(name)` → slug: lowercase, non-alphanumeric runs → `-`,
  trim leading/trailing `-`, fallback `'council'` for empty results.
- `exportCouncilToFile({ name, type, config })` — **browser-only, guard with
  `typeof document === 'undefined'`** (throw if called server-side). Builds
  the document, then: (1) triggers a download via
  `Blob` + `URL.createObjectURL` + a temporary `<a download="<stem>.council.json">`,
  (2) copies `JSON.stringify(doc, null, 2)` to `navigator.clipboard`
  (best-effort — swallow clipboard errors). Returns the document.

### 1b. New file: `src/councils/council-validation.js`

Move `normalizeCouncilConfig`, `validateCouncilConfig`,
`validateCouncilFormat`, `validateAdvancedFormat` verbatim out of
`src/routes/councils.js` (currently at :32, :94, :113, :164) into this module.
`src/routes/councils.js` requires them from here and **keeps re-exporting
them** (its exports at :359-360) so existing callers (`src/main.js`,
`src/routes/pr.js`, `src/routes/local.js`, `src/routes/stack-analysis.js`,
`src/review-config.js`, tests) keep working unchanged. New code imports from
`src/councils/council-validation.js`.

### 1c. Rewire both export buttons

Replace the byte-identical `_exportCouncil()` bodies
(`public/js/components/VoiceCentricConfigTab.js:1471-1480`,
`public/js/components/AdvancedConfigTab.js:1422-1431`) with:

```js
async _exportCouncil() {
  const config = this._readConfigFromUI();
  const selected = this.councils.find(c => c.id === this.selectedCouncilId);
  const name = selected?.name || 'Untitled Council';
  try {
    window.CouncilDocument.exportCouncilToFile({ name, type: TYPE, config });
    if (window.toast) window.toast.showSuccess('Council exported');
  } catch (error) {
    console.error('Failed to export council:', error);
    if (window.toast) window.toast.showError('Failed to export council');
  }
}
```

where `TYPE` is `'council'` in VoiceCentricConfigTab and `'advanced'` in
AdvancedConfigTab. (The config comes from the live UI, matching current
behavior; the name comes from the selected council or the fallback.)

### 1d. Script tags

Add `<script src="/js/utils/council-document.js"></script>` **before** the tab
scripts on the three pages that load them: `public/pr.html` (~415),
`public/local.html` (~610), `public/index.html` (~1569).

### 1e. Tests (Phase 1)

- New `tests/unit/council-document.test.js` — plain `require()` of the public
  module: build happy path both types; description included/omitted; build
  rejects empty name / bad type; parse happy path from string and object;
  parse rejects bad JSON, wrong version, missing name, bad type, missing
  config; `validateConfig` hook invoked and its string surfaced; stem slugging
  (spaces, punctuation, unicode → fallback).
- `tests/unit/council-config-validation.test.js` — update imports to the new
  module path; add one assertion that `src/routes/councils.js` still
  re-exports `validateCouncilConfig` and `normalizeCouncilConfig`.
- Tab export: extend existing tab unit tests (or add
  `tests/unit/config-tab-export.test.js`) asserting `_exportCouncil` calls
  `window.CouncilDocument.exportCouncilToFile` with `{name, type, config}` —
  stub the global on the sandbox/window.
- Frontend touched → run the analysis-modal E2E suites
  (`ai-analysis.spec.js`, `council-save-button.spec.js`) to confirm no
  regression; no new E2E needed (download itself isn't E2E-testable headless).

### 1f. Checklist

Changeset (minor: "Council export now produces a versioned, named document and
downloads a file"). Copyright header on both new files. No README change yet
(document format documented in Phase 2's README section).

---

## Phase 2 — `~/.pair-review/councils/` read-only overlay (PR 2)

No DB migration. Loaded **once per process at first use** (no hot reload —
project policy; restart to pick up file changes).

### 2a. New file: `src/councils/file-councils.js`

```js
async function loadFileCouncils({ dirs = [defaultCouncilsDir()], _deps } = {})
```
- `defaultCouncilsDir()` = `path.join(getConfigDir(), 'councils')`
  (`getConfigDir` from `src/config.js:459`).
- For each dir: `fs.readdir`; `ENOENT` → skip silently; other errors →
  `logger.warn`, skip dir. Take entries ending `.json`, sorted alphabetically.
- Per file: read UTF-8, `parseCouncilDocument(text, { validateConfig })` where
  `validateConfig = (config, type) => validateCouncilConfig(normalizeCouncilConfig(config, type), type)`
  (imports from `src/councils/council-validation.js`; match the exact
  signatures used by the fail-fast blocks at `src/main.js:1326-1335`). Any
  throw → `logger.warn(\`Skipping invalid council file ${path}: ${message}\`)`
  and continue. **Never crash startup.**
- Stem = filename minus `.council.json`, else minus `.json`.
- Returns array of rows shaped like `CouncilRepository` rows plus overlay
  fields:
  `{ id: 'file:' + stem, name, type, config, description, last_used_at: null,
  created_at: null, updated_at: null, source: 'file', readOnly: true,
  filePath }` — `config` is the **original parsed config** (not normalized;
  downstream routes already normalize).
- Use the `defaults`/`_deps` DI pattern (`src/protocol-handler.js`) for
  `fs`/`logger`.

### 2b. New file: `src/councils/council-store.js`

```js
const FILE_ID_PREFIX = 'file:';
function isFileCouncilId(id) { return typeof id === 'string' && id.startsWith(FILE_ID_PREFIX); }

class CouncilStore {
  constructor(db, fileCouncils) { ... }        // holds new CouncilRepository(db) + array
  async list()      // [...dbRows.map(r => ({...r, source: 'db'})), ...fileCouncils]
                    // DB rows keep repo MRU order first; file councils appended, sorted by name (localeCompare)
  async getById(id) // file id → find in fileCouncils (null if absent); else repo.getById, +source:'db', null passthrough
}

let _cache = null;
function getFileCouncils() { if (!_cache) _cache = loadFileCouncils(); return _cache; }  // once per process
function _resetForTests() { _cache = null; }
async function createCouncilStore(db) { return new CouncilStore(db, await getFileCouncils()); }
```

Exports: `CouncilStore`, `createCouncilStore`, `isFileCouncilId`,
`FILE_ID_PREFIX`, `_resetForTests`.

File councils have **no MRU** (nothing persists `last_used_at` for them);
that's why they sort by name after DB rows. `printCouncilList`'s "LAST USED"
still works for them via `getCouncilLastUsedRepos` (`analysis_runs` rows keyed
by council id include `file:` ids).

### 2c. Read-path call sites (complete list — do not skip any)

There are five `getById` sites and two `list` sites. Backend recon confirmed
these are ALL of them:

1. `src/routes/councils.js` GET `/api/councils` (:215, db at :217) and GET
   `/api/councils/:id` (:231) → `const store = await createCouncilStore(req.app.get('db'))`.
   Response shapes unchanged except every row now carries `source`
   (`'db'`/`'file'`), and file rows carry `readOnly`, `filePath`,
   `description`.
2. `src/councils/resolve-council.js:67` — replace
   `new CouncilRepository(db).list()` with
   `(await createCouncilStore(db)).list()`. **Signature `(db, handle)` stays;
   all 7 call sites untouched** (resolution is a pure filter over the list;
   file councils become matchable by id, `file:`-prefix, name, slug,
   fragment; a DB/file name tie hits the existing ambiguity error — correct).
3. `src/review-config.js` tiers 3 and 4 (:166, :192) — replace
   `new CouncilRepository(db).getById(...)` with store `getById`. Stale-id
   warn/fall-through behavior unchanged.
4. `src/routes/pr.js:2617`, `src/routes/local.js:2372`,
   `src/routes/stack-analysis.js:654` — same getById swap. 404/throw behavior
   for missing ids unchanged.
5. `src/main.js:307` (`printCouncilList`) — store list. Add a `SOURCE` column
   (`db`/`file`) to the table (extend the headers/width logic at :333-356).

### 2d. Write-path guards (complete list)

1. `src/routes/councils.js` PUT (:285) and DELETE (:340): first line —
   `if (isFileCouncilId(req.params.id)) return res.status(400).json({ error:
   'This council is defined in a file and cannot be modified through the API.
   Edit the file instead.' });`
2. `src/routes/analyses.js:558-562` (`touchLastUsedAt` in
   `launchCouncilAnalysis`): condition becomes
   `if (councilId && !isFileCouncilId(councilId))`.
3. `src/councils/headless-council.js:93` (fire-and-forget touch): same guard.
   Keep parity with `launchCouncilAnalysis` (header comment :18-27 demands
   it).

`analysis_runs.model` stores `file:` ids as-is (TEXT), so history,
`getCouncilLastUsedRepos` (groups on `ar.model`), and the frontend name lookup
(`analysis-history.js` fetching `/api/councils/:id`, which the store now
serves) all work.

### 2e. Frontend (both tabs — apply identically to VC and Advanced)

- Add helper `_isFileCouncil(council)` → `council?.source === 'file'` (the
  API now provides it).
- `_renderCouncilSelector` (VC:1263, Adv equivalent): option text
  `${c.name} (file)` for file councils.
- `_updateSaveButtonStates` (VC:1308, Adv:1053): when the selected council is
  a file council → `saveBtn.disabled = true`, `deleteBtn.disabled = true`
  (Save As stays enabled — it POSTs a copy, which is the duplicate flow).
- `_saveCouncil` (VC:1378, Adv:1313): if selected is a file council, fall
  through to `_saveCouncilAs()` instead of PUT (mirrors the existing
  no-selection branch).
- `autoSaveIfDirty` needs **no change** — a dirty file council takes the
  existing fork-with-timestamped-name POST path, which is correct.
- `public/js/components/CouncilDropdown.js`: add
  `static sourceBadge(council)` → `{label: 'File', cssClass: 'badge-file'}`
  when `source === 'file'`, rendered next to the existing `typeBadge`
  (:68); add `.badge-file` styling in `public/css/council-dropdown.css`
  matching the existing badge look.
- `CouncilCard` needs no change (renders config only).

### 2f. Tests (Phase 2)

- `tests/unit/file-councils.test.js` — per-file `fs.mkdtemp` fixture dir (per
  `tests/CONVENTIONS.md`): valid council doc, valid advanced doc (incl. legacy
  `orchestration` key), invalid JSON, wrong version, missing name, non-json
  files ignored, missing dir → `[]`, stem derivation for `.council.json` vs
  `.json`.
- `tests/unit/council-store.test.js` — merge order (DB MRU first, files
  name-sorted after), `source` stamping, `getById` for both kinds + null for
  unknown, `isFileCouncilId`, `_resetForTests`.
- `tests/unit/resolve-council.test.js` — extend: resolve file council by
  name/id/fragment; DB-vs-file same-name ambiguity error.
- `tests/unit/review-config.test.js` (or equivalent) — repo/global default
  pointing at a `file:` id resolves; stale `file:` id warns and falls through.
- Route tests (loopback server per conventions): GET list includes `source`;
  GET by `file:` id 200s; PUT/DELETE `file:` id → 400; POST unchanged.
- `tests/unit/print-council-list.test.js` — SOURCE column; file council with
  and without `analysis_runs` history.
- Touch guards: extend `tests/unit/headless-council.test.js` + analyses launch
  tests — `file:` id does not call `touchLastUsedAt`.
- E2E (frontend touched): extend an analysis-modal spec or add
  `council-file-overlay.spec.js` — before server start, write a valid
  `.council.json` into the E2E config dir's `councils/` subdir (locate how
  `tests/e2e/global-setup.js` / `test-server.js` establish the config
  dir/HOME and seed there); assert the selector shows the `(file)` option,
  Save disabled / Save As enabled when it's selected.

### 2g. README + docs

New README section "Council files": directory location, document format (the
JSON block above), name/type semantics, read-only behavior, "restart
pair-review to pick up file changes", and the known limitation that a
delegated headless run (`--headless` against an already-running server) can
404 on a council file added after that server started.

### 2h. Checklist

Changeset (minor). Copyright headers. No migration → **no test-schema updates
needed** (`tests/e2e/global-setup.js`, `tests/integration/routes.test.js`
untouched).

---

## Phase 3 — Settings-page council manager (PR 3)

Key recon facts this design leans on: the tabs query ids only inside the root
element passed to their constructor, and the settings page never loads
`AnalysisConfigModal` — so with **at most one instance of each tab per page**
the hardcoded ids are safe as-is. No id-scoping refactor. The modal's use of
private tab members (`_saveCouncil`, `_councilsLoaded`,
`_updateAllVoiceDropdowns`, `_isDirty`) is untouched.

### 3a-pre. Prerequisite: extract the duplicated council CRUD block (own commit)

Deferred here from the Phase 1 review (2026-08-11). `VoiceCentricConfigTab` and
`AdvancedConfigTab` carry six line-for-line identical methods — `_saveCouncil`,
`_saveCouncilAs`, `_putCouncil`, `_postCouncil`, `_deleteCouncil` (and, before
Phase 1, `_exportCouncil`) — differing only in the type literal
(`'council'`/`'advanced'`) and the selector id
(`#vc-council-selector`/`#council-selector`). ~150 duplicated lines including the
retry-on-duplicate-name loop, the confirm-dialog copy, and every toast string.
Phase 1 extracted only the export body (`public/js/utils/council-export.js`,
delegated to at call time); the remaining five are worth extracting **before**
3b/3c, which edit both copies again.

Shape: `public/js/components/council-crud.js` exporting
`applyCouncilCrud(TabClass, { councilType, selectorId })`, called once per tab.
The tabs already agree on every collaborator it needs (`this.councils`,
`this.selectedCouncilId`, `this.modal`, `_readConfigFromUI`, `_validateConfig`,
`_markClean`, `loadCouncils`, `_applyConfigToUI`, `_defaultConfig`,
`_updateSaveButtonStates`), so it needs no new plumbing. Traps:
1. The install runs at **module-evaluation** time, unlike the call-time
   `window.*` lookups used everywhere else — so the dual browser/CommonJS tab
   files need a guarded `require`-vs-`window` resolution, and a script-tag
   ordering rule on all four pages (pr, local, index, settings).
2. `AdvancedConfigTab.loadCouncils` filters `!c.type || c.type === 'advanced'`
   while the voice tab filters `c.type === 'council'` — legacy no-type councils
   are advanced-only, so that filter stays a **parameter**, never a symmetric
   hardcoded rule.
3. The modal→tab private contract (`_saveCouncil` at `AnalysisConfigModal.js`
   :460-462) must keep resolving on the prototype.

### 3a. Prerequisite CSS fix (own commit)

`public/css/analysis-config.css` has unscoped `.header-icon` /
`.header-subtitle` rules that collide with the settings header, and the
ConfirmDialog shell CSS lives only in that file (this is why the settings page
currently falls back to native `confirm`). Fix at source:
1. Scope the colliding selectors under the modal root class.
2. Extract the ConfirmDialog shell CSS into `public/css/confirm-dialog.css`
   and link it from every page that uses ConfirmDialog (grep for the script
   tag; at minimum pr.html, local.html, index.html, settings.html).
3. Verify `/settings` and `/settings/:owner/:repo` headers render unchanged,
   and the settings page can now use `window.confirmDialog`.

### 3b. Null-guard audit in both tabs (small, mechanical)

On the settings page these modal-only elements don't exist; every access must
tolerate `null`:
- `#council-footer-left` — `_updateDirtyHint` (VC:1331, Adv:1084).
- `[data-action="submit"]` — char-limit disable (VC:1347, 1368-1373;
  Adv:1100).
- Repo-instructions banner elements (VC:200-201/602-608, Adv:144-145/699-706)
  — `setRepoInstructions` simply won't be called; verify render/reset paths
  don't assume the banner nodes exist.
Add a regression unit test that injects a tab into a bare container (no modal
chrome) and exercises `inject` → `_applyConfigToUI` → `_markDirty` →
`_readConfigFromUI` without throwing.

### 3c. Fix the isDirty asymmetry

Add the missing `get isDirty()` getter to `AdvancedConfigTab` (VC already has
one at :274-276). Leave the modal's private reads (`AnalysisConfigModal.js:1166`,
1285-1290) untouched — behavior identical.

### 3d. New file: `public/js/utils/provider-map.js`

Extract the array→object conversion from `AnalysisConfigModal.loadProviders`
(:89-96): `buildProviderMap(providerList)` — keys by `id`, **drops providers
with empty `models`**. Dual export. Refactor the modal to use it (behavior
identical, including the hardcoded fallback on fetch failure staying in the
modal). CouncilManager uses it too.

### 3e. New component: `public/js/components/CouncilManager.js`

Modeled directly on `public/js/components/SnippetManager.js` (463 lines —
read it first): `constructor(container, { onChange } = {})`, all elements via
`createElement` with BEM classes `council-manager__*`, tracked listeners +
`destroy()`, dual export. New CSS `public/css/council-manager.css` modeled on
`snippet-manager.css`.

**List mode**: `GET /api/councils` → rows showing name, type badge
(Standard/Advanced — reuse `CouncilDropdown.typeBadge`), `File` badge +
`filePath` tooltip for file councils, `description` as subtitle when present.
Row click toggles an inline `CouncilCard` preview (component already loaded on
settings page; pass `resolveModelDisplay` derived from the provider map).
Row actions — DB councils: Edit, Duplicate, Export, Delete; file councils:
Duplicate, Export only.
- Export: `window.CouncilDocument.exportCouncilToFile({name, type, config})`
  straight from the row data.
- Duplicate: `window.textInputDialog.show` prefilled `"<name> (copy)"`,
  loop on case-insensitive name collision (mirror `_saveCouncilAs`,
  VC:1397-1431), then `POST /api/councils {name, config, type}`.
- Delete: `window.confirmDialog.show` (result must equal `'confirm'`), then
  `DELETE /api/councils/:id`.

**Editor mode** (replaces list in the container): for Add, first a two-button
type chooser (Council / Advanced). Then host one tab instance:
1. Create `<div id="tab-panel-council">` (or `-advanced`) inside a wrapper
   div; pass the **wrapper** as the tab's constructor argument (it plays the
   modal's role as query root).
2. Call in this order (mirrors the load-bearing modal sequence at
   `AnalysisConfigModal.js:916-943`): `inject(panel)`,
   `setProviders(providerMap)`, `reset()`, then for Edit:
   `setDefaultCouncilId(id)` followed by `await loadCouncils()` (the pending
   default id is applied when the selector renders).
3. Footer buttons owned by CouncilManager: **Save** →
   `tab._saveCouncil()` (same private call the modal makes at :460-462);
   **Back** → if `tab.isDirty`, confirmDialog "Discard unsaved changes?",
   then destroy the tab DOM and re-render list mode (re-fetch).
Constraint (document in a file-top comment): never instantiate CouncilManager
twice on one page, and never on a page that also loads AnalysisConfigModal —
the tab element ids must stay unique per page.

### 3f. Settings page wiring

Follow the SnippetManager pattern exactly (static section, not
registry-driven):
- `public/settings.html`: new section **before** the Chat Snippets section
  (`:100-109`), same markup shape, `id="councils-section"`, mount div
  `id="councils-manager"`, title "Councils", description "Reusable analysis
  councils available from any review."
- Script tags (`settings.html:132-136` region), before `settings.js`:
  `TimeoutSelect.js`, `VoiceCentricConfigTab.js`, `AdvancedConfigTab.js`,
  `CouncilManager.js`, `/js/utils/council-document.js`,
  `/js/utils/council-export.js` (the tabs' `_exportCouncil` calls
  `window.CouncilExport` unguarded — omit it and the settings-page Export button
  throws), `/js/utils/provider-map.js`, plus whichever scripts provide `window.toast`
  and `window.textInputDialog` (grep pr.html for their script tags and mirror
  them). Stylesheets: `council-manager.css`, `analysis-config.css` (safe
  after 3a), `confirm-dialog.css`.
- `public/js/settings.js`: constants `COUNCILS_SECTION_ID = 'councils-section'`,
  nav title "Councils" (:77-82 region); `mountCouncils()` modeled on
  `mountSnippets()` (:242-260) incl. the `typeof CouncilManager ===
  'undefined'` hide-on-load-failure guard; call from `init()` (:132 region);
  `this.councilsVisible` flag; `navItems(...)` (:750-767) gains the Councils
  item **before** Chat Snippets (Repositories must stay terminal — scrollspy
  bottom guard, comment at :758-759). Update `buildNavigation()` call
  accordingly.

### 3g. Tests (Phase 3)

- `tests/unit/council-manager.test.js` — jsdom + plain `require`, modeled on
  the existing SnippetManager tests: list render (db + file rows, badges,
  action visibility), duplicate name-collision loop, delete confirm flow,
  editor mount order (spy that `setProviders` precedes `reset`), Back-dirty
  confirm.
- `tests/unit/settings-page.test.js` — `navItems` ordering with councils
  visible/hidden.
- Bare-container tab injection regression test (3b) and AdvancedConfigTab
  `isDirty` getter test (3c).
- New E2E `tests/e2e/council-settings.spec.js` (test server already serves
  `/settings` and mounts `/api/councils` — `tests/e2e/test-server.js:327`,
  :920): create council → appears in list → edit → duplicate → delete; file
  council (seeded like Phase 2) shows File badge and no Edit/Delete. Also
  re-run `global-settings.spec.js` (nav/scrollspy assertions may need the new
  section) and `council-save-button.spec.js` (modal footer contract
  untouched).

### 3h. Checklist

Changeset (minor). Copyright headers. README: short "Managing councils"
section pointing at `/settings`.

---

## Phase 4 — CLI `pair-review council <verb>` (PR 4, later)

### 4a. Dispatch

In `main()` (`src/main.js:603+`), immediately **after** the `--mcp` block
(:610-614) and before the `-h/--help` handling, add:

```js
if (args[0] === 'council') {
  process.exit(await runCouncilCommand(args.slice(1)));
}
```

with a top-level `const { runCouncilCommand } = require('./councils/cli');`
(top-level imports per convention). Placing it before the global help check
makes `pair-review council --help` print council usage, and it keeps
`parseArgs` (which throws on unknown flags) out of the picture — the
subcommand parses its own argv. `parseArgs`, `KNOWN_FLAGS` (dead code — do
not touch), and all existing flag behavior are unchanged. `--list-councils`
remains as an alias; update its help text (:246-248) to mention
`pair-review council list`, and add a `Commands:` block to `printHelp()`.

### 4b. New file: `src/councils/cli.js`

`async function runCouncilCommand(argv, _deps = {})` → exit code. DI
`defaults` object (protocol-handler pattern): `{ spawnSync, env: process.env,
stdout/stderr writers or console, prompt }` — the editor spawn and the
confirm/re-edit prompts must be injectable for tests.

Setup mirrors the `--list-councils` block verbatim (`src/main.js:839-847`):
`loadConfig()` → `initializeDatabase(resolveDbName(config))` → work →
`db.close()` in `finally`. Pre-overlay file config is fine (councils are DB
rows + files; no config-driven behavior). Migrations run on open — expected.
Output via `console.log`/`console.error` (matches `printCouncilList`, which
deliberately doesn't use `logger`). Unknown verb or missing args → print
council usage to stderr, exit 1.

Handles resolve via `resolveCouncilHandle(db, handle)` — its not-found error
already suggests `--list-councils`; append a hint mentioning
`pair-review council new <name>` for `edit`'s not-found case.

### 4c. Verbs

- `list` — call the existing `printCouncilList(db)` (store-backed after
  Phase 2). Exit 0.
- `show <handle>` — resolve; print
  `JSON.stringify(buildCouncilDocument({name, type: type || 'advanced', config}), null, 2)`
  to stdout. Exit 0 / 1 on resolve error.
- `export <handle> [file]` — same document; no file arg or `-` → stdout;
  else write file (overwrite allowed) and print the path.
- `delete <handle> [--yes]` — resolve; `file:` council → error
  `Council "<name>" is defined in <filePath>; delete the file instead.`,
  exit 1. Otherwise confirm `Delete council "<name>"? [y/N]` via injected
  prompt unless `--yes`; delete via `CouncilRepository`.
- `rename <handle> <new-name>` — resolve; `file:` → same error shape;
  case-insensitive uniqueness check against store `list()` → error if taken;
  `repo.update(id, { name })`.
- `duplicate <handle> <new-name>` — resolve (file councils allowed);
  uniqueness check; `repo.create({ id: crypto.randomUUID(), name, config,
  type })`.
- `new <name> [--type council|advanced]` (default `council`) — uniqueness
  check first; write a template document to
  `await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-council-'))` +
  `/<stem>.council.json` (mkdtemp per test conventions — never a fixed /tmp
  path); run the editor loop; on success `repo.create` and print
  `Created council "<name>" (<8-char handle>)`.
- `edit <handle>` — resolve. DB council: dump its document to a temp file,
  editor loop, then `repo.update(id, { name, config, type })`; if the name
  changed, uniqueness-check first. `file:` council: open `filePath` itself in
  the editor; after exit, parse+validate and print either
  `Valid. Changes take effect the next time pair-review starts.` or the
  validation error (exit 1); never touches the DB.

**Editor loop**: editor = `env.VISUAL || env.EDITOR || 'vi'`, run
`spawnSync(editor, [tmpfile], { stdio: 'inherit' })`. Then parse with
`parseCouncilDocument` + the normalize/validate hook (as in Phase 2a). On
error: print it, prompt `Press Enter to edit again, or "q" to abort:`; loop or
exit 1.

**Templates** (exact starter content for `new`):

```json
{
  "pair_review_council": 1,
  "name": "<name>",
  "type": "council",
  "config": {
    "voices": [
      { "provider": "claude", "model": "sonnet", "tier": "balanced", "timeout": 600000 }
    ],
    "levels": { "1": true, "2": true, "3": true },
    "consolidation": { "provider": "claude", "model": "opus", "tier": "thorough", "timeout": 1800000 }
  }
}
```

Advanced template: same voice/consolidation objects, but
`config = { levels: { "1": {enabled: true, voices: [<voice>]}, "2": {enabled:
true, voices: []}, "3": {enabled: false, voices: []} }, consolidation: {...} }`
(matches `AdvancedConfigTab._defaultConfig`, :322).

### 4d. Tests (Phase 4)

- `tests/unit/council-cli.test.js` — mock deps: fake `spawnSync` that mutates
  the temp file (valid doc / invalid doc / unchanged), scripted `prompt`.
  Cover every verb: happy path, resolve failure, file-council refusals
  (delete/rename), file-council `edit` validate-only, `new` template +
  `--type advanced`, uniqueness collisions, `--yes`, editor-loop retry and
  abort. In-memory/mkdtemp DB via existing repository test helpers
  (`tests/unit/council-repository.test.js` shows the pattern).
- Integration: extend the `tests/integration/cli-council-flags.test.js`
  pattern (child process, seeded temp `HOME` — required because `CONFIG_DIR`
  is fixed at module load; env must include `PAIR_REVIEW_NO_OPEN: '1'`):
  `council list` and `council show` end-to-end.
- Help-text tests if `printHelp` is snapshot-tested anywhere.

### 4e. Checklist

Changeset (minor). Copyright header. README: "Managing councils from the CLI"
with the verb table.

---

## Phase 5 — Project-local `./.pair-review/councils/` (PR 5, later)

- `loadFileCouncils` default becomes
  `[path.join(getConfigDir(), 'councils'), path.join(process.cwd(), '.pair-review', 'councils')]`
  with `process.cwd()` evaluated **at call time** (mirrors `loadConfig()`'s
  `localDir` at `src/config.js:335`).
- Dedupe by filename stem across dirs; **later dir (project) wins**;
  `logger.info` when a project file shadows a global one. Ids stay
  `file:<stem>` — a shadowed global council keeps the same id, so defaults
  and history keep pointing at "the" council of that stem.
- UI: no new work (source badge already covers it); optionally include the
  winning `filePath` in tooltips (already present from Phase 2).
- Document the caveat: the same `file:<stem>` id can mean different configs in
  different repos; `analysis_runs` history joins on the id only.
- Tests: loader precedence + shadow logging; README update ("share councils
  with your team by committing `.pair-review/councils/` to the repo").
- Changeset (minor).

---

## Hazards

- **Five getById sites, two list sites** (Phase 2c is the complete inventory).
  An overlay applied only at `list()` silently misses the repo-default tier,
  global-default tier, and all three analyze routes. Verify each.
- **Headless twin parity**: `launchCouncilAnalysis` (`src/routes/analyses.js:505`)
  and `runHeadlessCouncilAnalysis` (`src/councils/headless-council.js:51`)
  must both get the touch guard. The header comment in headless-council.js is
  the contract.
- **Delegated headless** (`src/headless/delegate.js:412`) ships only the
  council id to a separately-started server; a council file created after
  that server started → 404 on launch. Known limitation, documented — do not
  "fix" with hot reload.
- **`analysis_runs.model` is the join key** for history, MRU repos, and
  frontend name resolution. `file:` ids flow through it; `GET
  /api/councils/:id` must resolve them or `analysis-history.js`
  permanently caches "Unknown Council" for the page lifetime (negative cache
  at `analysis-history.js:178-181`).
- **Modal→tab private contract** (do not break in Phase 3):
  `_saveCouncil()` (modal :460-462), `_councilsLoaded` (:1127, :1142),
  `_updateAllVoiceDropdowns()` (:1131, :1146), `_isDirty` read (:1166) and
  write (:1285-1290), `.councils` array read (:780, :806), and the
  inject-order dependency documented at :916-922.
- **One tab instance per page**: tab element ids are page-global. Settings
  page must never also load AnalysisConfigModal. Documented constraint, not a
  refactor.
- **`#council-footer-left` / `[data-action="submit"]`** are modal-owned nodes
  the tabs write via their root — the Phase 3b null-guards are what make the
  settings host safe. `tests/e2e/council-save-button.spec.js` is the
  regression test for the shared footer button.
- **analysis-config.css collisions**: unscoped `.header-icon` /
  `.header-subtitle` + ConfirmDialog shell CSS location (Phase 3a must land
  before the settings page loads that stylesheet).
- **`CouncilRepository._parseRow` silently returns `config: {}`** on corrupt
  JSON (`src/database.js:5946-5955`) — file-council parsing must NOT copy
  this; loader warns and skips instead.
- **Legacy `orchestration` key** on old advanced rows; consumers read
  `consolidation || orchestration`. The parse/validate hook normalizes before
  validating.
- **`CONFIG_DIR` is fixed at module load** (`src/config.js:55`) — any test
  needing a different config dir must spawn a child process with `HOME` set
  (see `tests/integration/cli-council-flags.test.js`).
- **Three analyzer paths** (`analyzeAllLevels`, `runReviewerCentricCouncil`,
  `runCouncilAnalysis`) build instructions independently. This plan doesn't
  touch prompts, but any config-shape drift must be checked in all three.
- **Config loaded once at startup** — no hot reload anywhere in this plan; do
  not flag missing cleanup on reapply.
- Test conventions: loopback server for supertest, no fixed sleeps, mkdtemp
  paths, `PAIR_REVIEW_NO_OPEN: '1'` on any CLI spawn
  (`tests/CONVENTIONS.md`).

## Decisions log

- Skip a standalone import feature — councils directory + Save As/Duplicate
  covers both import flows; no CLI `import` verb either (2026-08-10).
- File councils are a read-only overlay, not synced into the DB (2026-08-10).
- File council identity = `file:<filename stem>`; display name from the
  document (2026-08-10).
- Settings-page editor supports both council types, hosted via the existing
  tab classes (no id-scoping rewrite — one instance per page) (2026-08-10).
- Document module lives in `public/js/utils/` (dual export) and is required
  by server code — single source over duplication (2026-08-10).
- Validators move to `src/councils/council-validation.js`; routes re-export
  (2026-08-10).
- CLI: explicit `council new <name>`; `edit` never implicitly creates;
  editor = `VISUAL || EDITOR || vi` (2026-08-10).
- CLI subcommand dispatch before `parseArgs`; subcommand parses its own argv
  (2026-08-10).
- CLI (Phase 4) and project-local councils (Phase 5) sequenced last as
  separate PRs (2026-08-10).
