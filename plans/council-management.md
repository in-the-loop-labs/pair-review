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

**Shipped** — commit `21c6b23e`.

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

**Shipped** — commit `a40125df`. It also carried Phase 3's 3a-pre extraction
(see below), pulled forward so Phase 3 would not edit both tab copies again.

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

**Shipped** — 3a-pre landed early with Phase 2 (`a40125df`); 3a–3d in commit
`99c76287` ("refactor: prep config tabs and CSS for settings-page hosting");
3e–3g in the settings-page commit. Where the implementation diverged from this
spec, the divergence is recorded inline below as **As shipped**.

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

Shape — **as shipped**: `public/js/utils/council-crud.js` (utils, *not*
components), publishing `window.CouncilCrud` as free functions
`saveCouncil(tab, spec)` / `saveCouncilAs` / `putCouncil` / `postCouncil` /
`deleteCouncil`, where `spec = { type, selectorId }` is a static on each tab
(`VoiceCentricConfigTab.COUNCIL_CRUD_SPEC`). NOT the planned
`applyCouncilCrud(TabClass, …)` prototype install: each tab keeps its own
`_saveCouncil`/`_saveCouncilAs`/… and delegates from inside the method body,
matching how `council-export.js` already worked. The tabs already agree on
every collaborator it needs (`this.councils`, `this.selectedCouncilId`,
`this.modal`, `_readConfigFromUI`, `_validateConfig`, `_markClean`,
`loadCouncils`, `_applyConfigToUI`, `_defaultConfig`,
`_updateSaveButtonStates`), so it needs no new plumbing. Traps:
1. ~~The install runs at module-evaluation time … so the tab files need a
   guarded `require`-vs-`window` resolution and a script-tag ordering rule on
   all four pages.~~ **Wrong, and moot as shipped.** Delegation happens at CALL
   time (`window.CouncilCrud.saveCouncil(this, SPEC)` from inside the tab's own
   method), so nothing is resolved at load time, there is no script-ordering
   constraint on any page, and the tab methods stay on the prototype for free —
   which is what trap 3 asks for.
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

**As shipped, a second reason `analysis-config.css` is load-bearing on the
settings page** (not in this spec): the `#text-input-dialog` /
`.text-input-dialog-field` rules live ONLY in that file, and the extraction
deliberately left those grouped halves behind. So the settings page must load
`analysis-config.css` for the Duplicate / Save As name prompt to be styled at
all — independently of the hosted config-tab markup it also supplies. It is
linked before `settings.css` so the page-header rules there still win.
(Side effect, intentional: with `ConfirmDialog.js` now on the page,
`SnippetManager` takes its preferred styled-dialog path instead of the native
`confirm` fallback — `tests/e2e/chat-snippets.spec.js` was updated to match.)

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

**As shipped**: the audit found both tabs were *already* null-tolerant at every
one of these sites, so no guards were added — only the regression suite
(`tests/unit/config-tab-bare-container.test.js`, mutation-verified) that pins
the tolerance in place.

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
(**Correction**: `typeBadge(type)` takes a **type string**, not a council
object — only `sourceBadge(council)` takes the council. Both return
`{ label, cssClass }`, so the row builds its own `<span>`. CouncilManager feeds
`typeBadge` the *effective* type, so a legacy untyped row badges "Advanced",
matching the editor its Edit button opens.)
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

   **Revised (2026-08-17 review round)**: the constructor takes a second
   argument, `new TabClass(wrapper, { hosted: true })`. A hosted tab renders
   neither its own Save / Save As / Export / Delete row — so the host footer in
   step 3 is the single write surface instead of a second one competing with
   the tab's — nor the per-review "This Review" instructions block, which has
   no review to attach to and whose textarea `_readConfigFromUI` never reads
   (anything typed there was silently discarded). The spec assumed the tab's
   in-panel row would simply be present alongside the host footer; it must not
   be.
2. Call in this order (mirrors the load-bearing modal sequence at
   `AnalysisConfigModal.js:916-943`) — **corrected, as shipped**:
   `inject(panel)` → `setProviders(providerMap)` →
   `setDefaultOrchestration(provider, model)` → `reset()` → for Edit
   `setDefaultCouncilId(id)` → `await loadCouncils()` (the pending default id is
   applied when the selector renders).

   The spec's omission of **`setDefaultOrchestration()`** was a real bug, not a
   detail: `reset()` repaints from `_defaultConfig()`, whose fallback pair is
   `claude`/`sonnet`, and `sonnet` is an *alias* — not a model `<option>` value.
   Assigning it selects nothing, `_readConfigFromUI` then drops the reviewer row
   (it keeps only rows with BOTH provider and model), the new council POSTs
   `voices: []`, and the API 400s. `AnalysisConfigModal` calls
   `setDefaultOrchestration` before `reset()` for exactly this reason
   (`AnalysisConfigModal.js:928`). CouncilManager resolves the pair with the
   shared `resolveProviderModelPair` / `buildProviderModelScopes` over
   `/api/config` + `/api/providers` (hence the extra `provider-model.js` script
   tag in 3f), and canonicalises any alias to the model id the `<select>`
   actually carries before handing it over.
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
  **As shipped** the script list also carries `/js/utils/council-crud.js` (from
  3a-pre) and `/js/utils/provider-model.js` (for the `setDefaultOrchestration`
  fix above), and the `window.toast` / `window.confirmDialog` /
  `window.textInputDialog` providers turned out to be `Toast.js`,
  `ConfirmDialog.js` and `TextInputDialog.js`. Order is cosmetic — every one of
  these is resolved on `window` at call time — but pr.html's order is mirrored
  anyway.
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

**Done**: `.changeset/settings-council-manager.md` (minor); copyright headers
audited across every file new in Phase 3 (all present); README gained a
"Managing Councils" section immediately before "Council Files", plus its Table
of Contents entry. No migration → no test-schema updates.

---

## Phase 3 review round (2026-08-17) — decisions, deferrals, and one ordered work item

Recorded so they are not re-litigated, and so nothing here is later mistaken for
drift and "fixed".

### Decision A — auto-save name prefixes

An analysis started with unsaved editor changes auto-saves a council with a
generated name. Those prefixes become:

| Tab | Prefix | Was |
| --- | --- | --- |
| `VoiceCentricConfigTab` | `Council <timestamp>` | `Council <timestamp>` (unchanged) |
| `AdvancedConfigTab` | `Advanced <timestamp>` | `Config <timestamp>` |

Rationale: the words now map onto the persisted `type` column literals
(`'council'` / `'advanced'`), so the generated name survives any future badge
rename, and a level-keyed pipeline is not conceptually a council — the
distinction is real and worth keeping rather than unifying away.

**Name and badge deliberately use different words for the voice half.**
`CouncilDropdown.typeBadge` maps type `'council'` to the label **Standard**, so
an auto-saved `Council 2026-08-17 14:02` row sits under a "Standard" badge.
That is by design; it is not a bug to fix by renaming either side.

Changeset: `.changeset/advanced-autosave-council-name.md` (patch) — the
`Config` → `Advanced` half is a user-visible generated name.

### Decision B — extract the remaining tab duplication, in this order, before Phase 4

3a-pre moved five CRUD methods out and the two remaining copies have **not**
diverged since. But ~346 lines across 13 methods are still duplicated between
the two tabs (≈187 in `VoiceCentricConfigTab`, ≈159 in `AdvancedConfigTab`),
and most of them differ only in values that `COUNCIL_CRUD_SPEC` almost already
carries:

- **Identical** (measured 2026-08-17): `_isFileCouncil`, `_markDirty`,
  `_markClean`, `_formatTimestamp`, `_syncTierToModel`, `setDefaultCouncilId`
  (comment included). `_updateDirtyHint` is identical apart from one stale
  comment line in the voice copy.
- **Differ only in the class name reaching the same constant**:
  `_getProviderDefaultTimeout`.
- **Differ only in a selector or panel id**: `_renderCouncilSelector`,
  `_updateSaveButtonStates`, `_updateCharCount`.
- **Differ in a behaviour-carrying value**: `loadCouncils` (the filter
  predicate) and `autoSaveIfDirty` (the name prefix — Decision A).

**Ordered work item. The order is the safety property.**

1. **Land the missing `loadCouncils` filter tests first.** ~~No test called
   either tab's real `loadCouncils`~~, yet the filter asymmetry
   (`c.type === 'council'` vs `!c.type || c.type === 'advanced'`) is the stated
   premise for four other assertions added this round. Extracting an unpinned
   method is how a regression ships green.

   **DONE** — landed in the 2026-08-17 review round as
   `tests/unit/config-tab-load-councils.test.js` (17 tests): both tab classes
   run through a shared spec whose `expectedCouncilIds` pins exactly which
   council shapes each tab shows, plus a `loadCouncils type-filter asymmetry`
   suite asserting every shape routes to exactly one tab. Mutation-verified:
   tightening Advanced's predicate to `c.type === 'advanced'` — the precise
   Decision B regression — reddens two of them.

   **Check before starting step 2** (filename-agnostic on purpose — the tests
   did not land in the file this plan first guessed at): run
   `grep -rl "loadCouncils" tests/unit/` and confirm at least one hit is a test
   that calls a real tab's `loadCouncils`, not a `loadCouncils: vi.fn(...)`
   collaborator mock. Better still, just run the suite — the file above is the
   current answer, but do not let a rename turn a passing gate into a
   permanent "not landed".
2. **Then the extraction, as its own commit, before Phase 4 begins.** This is
   the precedent the branch already set with `99c76287 refactor: prep config
   tabs and CSS for settings-page hosting` — a prep refactor landed ahead of
   the feature, not folded into it.
   Grow `COUNCIL_CRUD_SPEC` to carry: panel id, char-count id, timeout
   constant, auto-save prefix, and the filter predicate.

   **DONE** (2026-08-18, uncommitted at time of writing). Three follow-ups
   were deliberately left out of it — see
   **Decision B step 2 — deferred follow-ups** immediately below the Decision B
   hazards. All 13 methods now
   live once in `public/js/utils/council-crud.js`; each tab keeps its own
   prototype method delegating at CALL time
   (`window.CouncilCrud.markDirty(this)`), exactly as 3a-pre established.
   VoiceCentricConfigTab 1641→1524, AdvancedConfigTab 1592→1446,
   council-crud.js 359→761. Where the implementation made a choice this spec
   left open:

   - **Home is `council-crud.js`, not a new module.** It is already
     script-tagged on all four pages that load the tabs (pr/local/index/
     settings). A new module means four new tags, and one missed page is a
     runtime `TypeError` on a page nobody tested. Its file-top doc was widened
     from "the five CRUD flows" to the full shared-behaviour remit.
   - **Spec ids are explicit literals, not a derived prefix.** The two tabs
     would in fact reduce to two prefixes (`vc-council`/`council` for the
     action row, `vc`/`council` for the char-count block), but tab element ids
     are page-global and a derived id is ungreppable. Every id is written out.
   - **`defaultTimeout: TabClass.DEFAULT_TIMEOUT`**, not a second literal
     `600000`. Static fields initialize in source order, so this required
     moving the `COUNCIL_CRUD_SPEC` declaration BELOW `static DEFAULT_TIMEOUT`
     in both classes. A forward reference evaluates to `undefined` silently.
   - **The char-count method names stay asymmetric** — `_updateCharCount` on
     the voice tab, `_updateCouncilCharCount` on the advanced one. Both
     delegate to one `updateCharCount(tab, spec, count)`. Renaming is not part
     of this refactor.
   - **Tests now need `window.CouncilCrud` installed.** Seven test files
     called these methods off the prototype without it. jsdom files get
     `require('.../council-crud.js')`; the three node-env files
     (`advanced-config-tab-defaults`, `config-tab-timeout`,
     `config-tab-validation`) need
     `global.window = global.window || {}; global.window.CouncilCrud = require(...)`
     because the module cannot self-install with no `window` at require time.
     `config-tab-export.test.js` REPLACES `global.window` wholesale and had to
     carry `CouncilCrud` into the replacement object.
   - **New: `tests/unit/config-tab-shared-spec.test.js`** — pins spec key
     completeness, that every id resolves against a really-mounted non-hosted
     tab, that a hosted tab drops exactly the action row + char-count block,
     that all 13 stay own-prototype functions, and that the bodies read the
     spec LEXICALLY (a `this.constructor.COUNCIL_CRUD_SPEC` read would break
     the large amount of existing `TabClass.prototype.m.call(plainCtx)`
     coverage).
   - **`CouncilManager` keeps its own hardcoded panel-id literal.** Reading
     `TabClass.COUNCIL_CRUD_SPEC.panelId` was tried and reverted: everything
     before `_openEditor`'s try/catch runs unguarded, so reaching into a
     static there turns a broken tab class into an unhandled throw instead of
     the "Failed to open the council editor" recovery (two existing tests stub
     a bare `class { inject() { throw } }` precisely to model that). The copy
     is instead pinned to the spec by two assertions in
     `council-manager.test.js`, mutation-verified.
   - **`AnalysisConfigModal` keeps its EIGHT panel-id literals too**, for the
     same reason and asked again in the 2026-08-19 round. It constructs its
     tabs guarded (`typeof VoiceCentricConfigTab !== 'undefined'`,
     `AnalysisConfigModal.js:59`), so it explicitly tolerates the tab classes
     being absent; a bare `VoiceCentricConfigTab.COUNCIL_CRUD_SPEC.panelId`
     read at `:1028` would throw in exactly the case the modal is written to
     survive. The eight sites are four pairs — create (`:1028`, `:1034`), look
     up to `inject()` (`:925`, `:937`), toggle in `_switchTab` (`:1100`,
     `:1101`), reset in `hide()` (`:1333`, `:1334`) — and all four pairs are
     now pinned to the spec by
     `tests/unit/analysis-config-modal-tab-panels.test.js`, mutation-verified
     per pair.

   Verification, after the 2026-08-19 review round below: **10311
   unit/integration tests green (304 files)**; E2E `council-settings` +
   `council-save-button` + `ai-analysis` + `global-settings` 61 passed.
   Mutation-verified that the two deliberate asymmetries are still pinned —
   flipping the advanced `councilFilter` to `c => c.type === 'advanced'`
   reddens 2 tests in `config-tab-load-councils.test.js`, and flipping
   `autoSaveNamePrefix` to `'Council'` reddens 4 across
   `config-tab-new-council-defaults.test.js` and
   `config-tab-shared-spec.test.js`.

   **Review round, 2026-08-19 — four latent bugs the extraction exposed.**
   None was a regression; each was a faithful copy of pre-existing tab code
   that only became decidable once the two copies were one. All four are fixed
   and mutation-verified:
   1. `loadCouncils` emptied `councils`/`_allCouncils` on a failed refresh
      without repainting the `<select>`, so real `<option>` nodes kept offering
      councils no JS believed in. Reachable without a reload —
      `putCouncil`/`postCouncil` both re-fetch AFTER a successful write. Worst
      consequence: the selector's `change` handler assigns `selectedCouncilId`
      BEFORE its `if (council)` guard, so picking X from the stale dropdown
      repointed the id at X while the editor showed Y, and the next Save PUT
      Y's config over X. Now keeps the last-good lists, matching
      `SettingsPage.loadCouncils` and `CouncilManager._loadCouncils`.
   2. `renderCouncilSelector` never reconciled `tab.selectedCouncilId` when its
      council vanished from the repainted list — `select.value = <missing id>`
      falls back to "+ New Council" without touching the model, so the screen
      said create while every write path said update. Rewritten to compute one
      `target`; the early `return` is gone and `syncSelectorToSelection`'s
      duplicate two steps now share `applySelectorValue`. **Two deviations from
      the review's literal suggestion, both deliberate**: the model gets `null`
      (not `''`) because the constructor, `reset()` and both `change` handlers
      all normalise with `|| null`; and the fallback order is pending →
      `tab.selectedCouncilId` → `currentValue` → `''`, because `postCouncil`
      assigns the new id and only THEN reloads, so the DOM's value is still the
      council the user saved FROM.
   3. `CouncilManager._canSave` proved "file council" from a list lookup —
      `find()` returns `undefined` on a miss and `_isReadOnly(undefined)` is
      falsy, so a miss read as *writable* and Save lit up on a `file:` council
      the API refuses with 403. Now asks the id, like every other gate.
   4. `updateCharCount` disables the modal's shared Analyze button from a panel
      that may be hidden, and nothing recomputed on tab switch — so over-limit
      text in one council tab left Analyze stuck disabled with a tooltip about
      a limit nothing on screen exceeded. `_switchTab` now recounts for the
      revealed tab. Button OWNERSHIP deliberately unchanged; see the deferred
      follow-ups.

   Also in this round: `_exportCouncil` reads `spec.type` instead of a second
   copy of the literal; both tabs gained a `_panel()` accessor replacing 13
   open-coded `querySelector(panelId)` sites; the module header now names its
   three off-remit helpers (`syncTierToModel`, `getProviderDefaultTimeout`,
   `formatTimestamp`) and admits `syncTierToModel` is spec-free by design; and
   the `councilFilter` justification was corrected — it claimed untyped rows
   "predate the `type` column", but **no current write path can produce one**
   (`src/database.js:227` table default, migration 18's constant ADD COLUMN
   default which SQLite applies to pre-existing rows, `CouncilRepository.create`
   default, `routes/councils.js` POST default, and `parseCouncilDocument`
   throwing on any other type). The asymmetry stays; only the false premise
   went, in five places, with three stale `loadCouncils` pointers repointed at
   `COUNCIL_CRUD_SPEC.councilFilter`.

   Test work in the round: three behavioural suites for contracts that moved
   with NO coverage anywhere (`_syncTierToModel`, the char-count near-limit
   tier — a branch never once executed in this repo — and `onStateChange`
   including that it fires BEFORE the `!panel` guard, which is the hosted
   case); five restatement blocks deleted from `config-tab-shared-spec.test.js`
   (a test comparing the spec to a literal typed beside it cannot detect a
   mistake); `tests/unit/analysis-config-modal-tab-panels.test.js` pinning all
   four pairs of the modal's panel-id literals; and the `window.CouncilCrud`
   bootstrap consolidated from three hand-copied variants across 14 files into
   `tests/utils/config-tab-modules.js`.
3. CSS extraction is **deferred** — see below. Do not fold it into step 2.

**Hazards (Decision B)**

> `loadCouncils`'s predicate and `autoSaveIfDirty`'s prefix look like
> incidental drift and are **not**. The filter asymmetry is deliberate (legacy
> untyped councils are advanced-only — the 3a-pre trap 2 above insists it stays
> a parameter) and the prefixes are deliberately different per Decision A. A
> "merge the duplicates" pass will naturally unify both. They must stay
> parameterized through `COUNCIL_CRUD_SPEC`.
> Both are now pinned, so such a pass goes red rather than green:
> `tests/unit/config-tab-load-councils.test.js` for the filter, and
> `tests/unit/config-tab-new-council-defaults.test.js` for the prefixes
> (including an explicit "falls back to Advanced, not Config" case).
>
> `_updateDirtyHint`, `_updateSaveButtonStates` and `_updateCharCount` reach
> for modal-owned nodes through the tab root. The settings-page host has none
> of them; the null-tolerance pinned by
> `tests/unit/config-tab-bare-container.test.js` (3b) must survive the
> extraction.
>
> `setDefaultCouncilId` is called by both the modal and CouncilManager, and its
> body depends on `_councilsLoaded` / `_injected`. Extracting it moves a method
> that two hosts call at different points in their mount sequence.

### Decision B step 2 — deferred follow-ups (recorded 2026-08-19)

Three items the reviewer took OUT of the step-2 extraction. All measured
against the tree as of 2026-08-19 (line numbers drift; the names do not).

#### (a) The remaining tab duplication — deferred on purpose

Still copied verbatim (or near enough) in both tabs after step 2:

| What | Where | How different |
| --- | --- | --- |
| `_updateModelDropdown` | `VoiceCentricConfigTab.js:966`, `AdvancedConfigTab.js:908` | Identical apart from three comment lines |
| `_populateProviderDropdown` | `VoiceCentricConfigTab.js:938`, `AdvancedConfigTab.js:880` | Identical apart from the `DUPLICATED in …` comment; 26 lines of body |
| `_updateAllVoiceDropdowns` | `VoiceCentricConfigTab.js:928`, `AdvancedConfigTab.js:870` | Identical; its own comment says it stays until `_populateProviderDropdown` moves |
| `setProviders` | `VoiceCentricConfigTab.js:167`, `AdvancedConfigTab.js:175` | Byte-identical |
| `getSelectedCouncilId` | `VoiceCentricConfigTab.js:204`, `AdvancedConfigTab.js:213` | Byte-identical |
| `validate` | `VoiceCentricConfigTab.js:213`, `AdvancedConfigTab.js:368` | Byte-identical |
| `setDefaultOrchestration` | `VoiceCentricConfigTab.js:329`, `AdvancedConfigTab.js:280` | Byte-identical |
| the council-selector `change` handler | `VoiceCentricConfigTab.js:582` (`_setupListeners`), `AdvancedConfigTab.js:655` (`_setupCouncilListeners`) | Differs only by the `<select>` id — which `spec.selectorId` already carries — and two comments |

**Why deferred.** These pull DOM the shared module does not currently own, so
they grow the review surface without closing a known bug. The two that DID land
in this round earned it: `_applyModelSelection` closed a path that had actually
drifted — the alias fix was written twice, once per tab, in `883e32e2`. Nothing
in the list above has a matching incident.

**Where it should go — decide before starting; the two candidates disagree.**
The reviewer's suggestion was `public/js/utils/provider-map.js` on the grounds
that it already owns the four model/orchestration resolvers (`buildProviderMap`,
`findModelWithAliases`, `resolveModelDisplay`, `resolveDefaultOrchestration`)
and that none of this is CRUD. Two facts cut the other way, and whoever picks
this up should weigh them rather than re-derive them:

- `provider-map.js`'s file-top doc ends "Pure logic — no DOM access at load
  time", and all four exports take/return plain provider maps.
  `_populateProviderDropdown` and `_updateModelDropdown` are `innerHTML`,
  `createElement` and `<select>.value` from top to bottom.
- `syncTierToModel` already lives in `council-crud.js` and is the TAIL of
  `_updateModelDropdown` — the two do the same tier sync, one off the option's
  `data-tier`, the other off the model list. The extraction boundary therefore
  cuts through the middle of one flow today, and `council-crud.js`'s own header
  already records "Pulling `_updateModelDropdown` across is tracked as a
  follow-up". Moving it there reunites them and lets `syncTierToModel` become a
  normal `(tab, spec)` participant instead of the calling-convention exception
  that same header has to call out.

A defensible split is possible (pure model-list resolution to `provider-map`,
the DOM painting to `council-crud`) but it is a third option, not the default.

**For the selector handler specifically.** A `bindCouncilSelector(tab, spec,
panel)` would serve all three call sites: `_setupListeners`,
`_setupCouncilListeners`, AND the pending-default branch at the end of
`renderCouncilSelector` (`council-crud.js:754`), which is a near-copy of the
handler's found-a-council branch (`_applyConfigToUI(council.config)` +
`_markClean()`). While doing it, note that `markClean`/`markDirty`
(`council-crud.js:764`, `:773`) already call `tab._updateSaveButtonStates()`
unconditionally, so the handler's trailing `_updateSaveButtonStates()` is a
second full pass on two of its three branches (selected-and-found, and
no-selection; only selected-but-NOT-found needs it). That is not free: the pass
re-runs `_readConfigFromUI()` + `_validateConfig()` and fires `onStateChange`,
so on the settings page every selector change syncs the host footer twice.

#### (b) The modal should own its own submit button

Delete the `if (submitBtn)` block at the end of `CouncilCrud.updateCharCount`
(`council-crud.js:888`) so the shared helper only touches nodes inside its own
panel, and have `AnalysisConfigModal` gate `[data-action="submit"]` from
whichever tab is active. That block is the ONLY reason the helper reaches for
`tab.modal` instead of `panel`, and its `if` guard exists purely because the
settings-page host has no submit button at all.

Related, and part of the same change:

- `AnalysisConfigModal.updateCharacterCount` (`AnalysisConfigModal.js:701`) is a
  THIRD implementation of what `CouncilCrud.updateCharCount` now holds for both
  tabs — same `char-count-warning` / `char-count-error` / `textarea-warning` /
  `textarea-error` classes, same near-limit ladder, same tooltip strings. Once
  button ownership moves, the panel-scoped remainder is one helper taking
  `(container, textarea, countEl, limit, threshold)`.
- The limit is declared THREE times — `AnalysisConfigModal.js:22`,
  `VoiceCentricConfigTab.js:123`, `AdvancedConfigTab.js:133`, all `5000` /
  `4500` — and the modal's tooltip still hardcodes the string `'5,000'`
  (`AnalysisConfigModal.js:739`) rather than deriving it, so the number the user
  is told can drift from the number enforced. The council-crud copy was already
  fixed to derive it (`${tab.CHAR_LIMIT.toLocaleString()}`).

Worth its own change with its own tests: it touches the Single-tab submit path
that step 2 otherwise leaves alone. The recount added to `_switchTab` in this
round is pinned by `tests/unit/analysis-config-modal-tab-panels.test.js`, which
asserts on the shared button — that suite is the regression net this change has
to keep green while moving who writes it.

#### (c) Source the id table in `config-tab-hosted.test.js` from the spec

`tests/unit/config-tab-hosted.test.js:57` spells nine ids as literals per tab —
`panelId`, `selectorId`, `instructionsId`, `charCountId`,
`charCountContainerId`, three `writeControlIds`, `exportId` — every one of which
`COUNCIL_CRUD_SPEC` already carries. That suite already mounts both tabs hosted
and non-hosted and queries exactly those ids, so reading them off the spec turns
its existing assertions into a spec-to-DOM binding at no cost, and stops the
table quietly asserting about ids that no longer exist after a rename.

Two wrinkles for whoever does it: the suite stores BARE ids (`vc-char-count`)
and builds `#${id}` selectors, while the spec stores full selectors
(`#vc-char-count`) — so the conversion is one `.slice(1)`, not a swap. And
`repoBannerId` has no spec counterpart; it stays a literal.

Once it lands, the equivalent id-resolution block in
`tests/unit/config-tab-shared-spec.test.js` becomes redundant and can go,
leaving that file as the small structural suite it wants to be.

Deferred because it edits a suite this round already touched, for a payoff that
is protection against a future rename rather than a present defect.

### Deferral — CSS extraction waits for a third settings-page manager

`public/css/council-manager.css` (261 lines) and
`public/css/snippet-manager.css` (233 lines) are near-copies. Measured
2026-08-17, after normalizing the BEM block prefix: **13 shared element
families** — `__loading`, `__empty`, `__error`, `__list-wrap`, `__list`,
`__row`, `__row-actions`, `__row-btn`, `__preview`, `__add-btn`, `__save-btn`,
`__cancel-btn`, `__delete-btn` — and **131 identical lines** by longest-common-
subsequence alignment (138 by `diff`'s changed-line accounting; ~104 of them
non-blank). Either way, over half of `council-manager.css` is a rename away
from the snippet one, and `settings.html` links both.

**DECIDED: defer the extraction until the third settings-page manager
arrives** (Phase 4 or later — the CLI phase adds no manager, so this may sit
past it). Two copies is tolerable; three is not. Waiting means the shared base
is designed against three real cases instead of guessed from two —
and the extraction is not free, since the class rename has to move through the
JS and the E2E selectors (`.council-manager__save-btn` is asserted in
`tests/e2e/council-settings.spec.js:297`).

### Follow-ups (explicitly NOT in this round)

Listed worst-first. The head of this list is a real bug, not a tidy-up.
The three follow-ups the Decision B step 2 extraction itself left behind are
recorded separately, with their measurements, under
**Decision B step 2 — deferred follow-ups** above.

- **BUG, prioritise — "Add council" can silently overwrite a DIFFERENT
  council.** Pre-existing; found by integration review and traced by the
  CouncilManager agent, 2026-08-17. Not a cosmetic label defect — an
  unintended in-place overwrite with no confirmation and no undo.

  Repro: Councils → Add council → pick a type → the editor opens in Add mode on
  "+ New Council" **with the tab's full council `<select>` right there in the
  panel** → pick an existing council from it → footer Save. The existing
  council is overwritten.

  Why the `<select>` is there and live: it is the one control from the tab's
  action row that survives hosting, and it must be —
  `_renderCouncilSelector` is where `_pendingDefaultCouncilId` becomes
  `selectedCouncilId`, so `hosted: true` suppresses only
  `buildCouncilActionsHTML()` (`VoiceCentricConfigTab.js:415`), never the
  `<select>` on the line above. Its change handler is fully wired
  (`VoiceCentricConfigTab.js:574`): it sets `this.selectedCouncilId`, paints
  that council's config into the panel, and `_markClean()`s. So picking from it
  is not an obscure gesture — with a dropdown sitting in an "Add" pane it is
  the obvious way to say "start from that one".

  Why Save then overwrites: `CouncilCrud.saveCouncil` branches on
  `tab.selectedCouncilId` (`council-crud.js:141`) and PUTs. Meanwhile
  `CouncilManager` set its header once at `_openEditor`
  (`CouncilManager.js:594`, `councilId ? 'Edit council' : 'New council'`) and
  `_editingId` stays `null` — neither follows the selector. **The header
  reading "New council" is what creates the false expectation**; the user
  presses Save believing they are creating.

  Accurate parts to keep: the data stays internally consistent (the PUT writes
  exactly what the panel shows), and this does **not** undermine the
  `_listSignature` deletion — the write goes through footer Save, which reaches
  `_exitEditor({ mutated: true })` (`CouncilManager.js:823`), so the host is
  correctly notified either way.

  Candidate fixes, as proposed:
  1. Make the header reflect the tab's live selection. Stops the lie, but Save
     still overwrites.
  2. Have `_openEditor`'s Add path treat a selection change as **leaving Add
     mode**: header follows, `_editingId` follows, and Save then legitimately
     updates the council the user chose.

  **Recommended: (2)** — (1) alone leaves the surprising write in place. A
  third option, suppressing the `<select>` when hosted in Add mode, was
  considered and rejected: it costs the "start from an existing council"
  affordance for no gain.

- **`tests/e2e/helpers.js` consolidation.** `council-settings.spec.js`
  re-implements Phase 2's file-council fixture verbatim from
  `council-file-overlay.spec.js`, and its `seedCouncil` / `clearDbCouncils` /
  two config fixtures duplicate `council-save-button.spec.js`'s — with a third
  inline seeder in `global-settings.spec.js`. `helpers.js` is the shared home.
  When consolidating, **pick ONE seeding transport**: the copies use
  `page.request` and `page.evaluate(fetch)` for the same operation, and only
  the latter is visible to a spec's failed-request watcher.
- **Repo settings never clears a dead `default_council_id`.**
  `checkForChanges` compares against `originalSettings`, so a council id whose
  council was deleted is silently resubmitted on the next Save rather than
  cleared. Whether Save *should* clear it is an undecided behaviour change, not
  a bug fix — decide before implementing.
- **Duplicate fetches on `/settings`.** `AnalysisConfigModal` fetches nothing
  twice, but the settings page fetches `/api/providers` and `/api/config`
  twice — once in `settings.js`, once in `CouncilManager`. Partly addressed in
  this round via constructor options; re-measure what remains before doing
  more.
- **The council-load tri-state has four shapes.** `SettingsPage` and
  `RepoSettingsPage` each carry a `councilsLoadFailed` boolean (an empty
  `councils` array alone cannot distinguish "none exist" from "we don't know");
  `CouncilManager` reuses its own `_error` string for the same distinction.
  Semantically equivalent, cosmetically divergent: on a failed load the three
  surfaces respectively show an explanatory note, hide the preview, and
  suppress the empty state. Recorded as a **decision to revisit** — not a
  defect, and not worth unifying until something depends on the three agreeing.

---

## Phase 4 — CLI `pair-review council <verb>` (PR 4, later)

**Implemented** (uncommitted), then hardened by a 16-finding review round —
see "Phase 4 review round (2026-08-21)" below, which supersedes several details
of the spec that follows. Two divergences from the spec are recorded inline as
**As shipped**: the advanced starter template (the spec's level 2 was invalid),
and `printCouncilList` moved to `src/councils/print-list.js` to break a require
cycle. One addition: `show` and `export`-to-stdout silence startup narration so
their stdout is only the document.

**Prerequisite from the Phase 3 review round** (above): Decision B step 2 — the
tab-duplication extraction, as its own commit — lands before Phase 4 work
starts. **Both steps of Decision B are now done** (step 1 in the 2026-08-17
review round, step 2 on 2026-08-18); Phase 4 is unblocked. The
`council-manager.css` / `snippet-manager.css` extraction is
deferred separately and is *not* a Phase 4 prerequisite (its trigger is a third
settings-page manager, which the CLI does not add). Neither touches the CLI
surface below; Phase 4's own spec is unaffected.

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
  **As shipped**: `printCouncilList` moved verbatim out of `src/main.js` into
  `src/councils/print-list.js`, which main.js requires and re-exports (existing
  callers and `tests/unit/print-council-list.test.js` unchanged). Required:
  main.js requires `./councils/cli`, so a `require('../main')` from the
  subcommand would resolve to a half-initialized module — main.js assigns its
  exports last, so `printCouncilList` would be `undefined` at call time.
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
exit 1. **As shipped**: a `spawnSync` `error` (no such editor) aborts
immediately rather than entering the loop — re-editing cannot fix a missing
editor.

**Stdout purity (added)**: `show`, and `export` with no file target or `-`,
call `redirectConsoleToStderr({ quiet: true })` before opening the database.
`initializeDatabase` narrates its schema version on stdout, which would
otherwise land inside `council show <handle> > file.json`. The command's own
output writes to `process.stdout`/`process.stderr` directly, so it survives the
redirect that silences the narration.

**Templates** (exact starter content for `new`) — **superseded by the review
round: the model ids below are not real Claude catalog ids and are now derived
from the provider registry instead**:

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

**As shipped**: level 2 carries a voice. The spec's shape is invalid —
`validateAdvancedFormat` rejects an enabled level with an empty voices array
("levels.2.voices must be a non-empty array when enabled"), which is exactly why
`_defaultConfig` seeds one voice per ENABLED level. Only the disabled level 3
has `voices: []`. `tests/unit/council-cli.test.js` pins both templates against
`normalizeAndValidateCouncilConfig`.

### 4d. Tests (Phase 4)

- `tests/unit/council-cli.test.js` — mock deps: fake `spawnSync` that mutates
  the temp file (valid doc / invalid doc / unchanged), scripted `prompt`.
  Cover every verb: happy path, resolve failure, file-council refusals
  (delete/rename), file-council `edit` validate-only, `new` template +
  `--type advanced`, uniqueness collisions, `--yes`, editor-loop retry and
  abort. In-memory/mkdtemp DB via existing repository test helpers
  (`tests/unit/council-repository.test.js` shows the pattern).
  **As shipped**: 50 tests. `tmpdir` is injected so every temp file lands in the
  test's own mkdtemp root, and `quietStdout` is injected as a spy — the real one
  reassigns the worker's `console`.
- Integration: extend the `tests/integration/cli-council-flags.test.js`
  pattern (child process, seeded temp `HOME` — required because `CONFIG_DIR`
  is fixed at module load; env must include `PAIR_REVIEW_NO_OPEN: '1'`):
  `council list` and `council show` end-to-end. **As shipped**: also
  `council show` on a bad handle, `council --help` (proves the dispatch beats
  the global help), and an unknown-flag rejection. The `show` test parses the
  whole stdout as JSON — that is the stdout-purity regression test.
- Help-text tests if `printHelp` is snapshot-tested anywhere.

### 4e. Checklist

Changeset (minor). Copyright header. README: "Managing councils from the CLI"
with the verb table.

---

## Phase 4 review round (2026-08-21) — 16 findings, all fixed

Full suite green afterwards: **10404 tests / 305 files**. Every fix was also
exercised against the real spawned CLI, not only through injected deps.

Bugs the round found in Phase 4 as first written:
- **stdout was truncated at exactly one pipe buffer.** `process.exit(await
  runCouncilCommand(...))` terminates before an async pipe write drains, so
  `council show > f.json` delivered exactly 65536 bytes and exit code 0.
  Reproduced deliberately before fixing. Now every document-emitting path exits
  through `exitAfterStdoutFlush` (`src/main.js`), a zero-length write used as a
  drain barrier — the third instance of this hazard in that file, after the
  headless `--json` envelope. **Invariant: no CLI path that writes a document to
  stdout may call bare `process.exit`.**
- **The `new` templates seeded a model that does not exist.** `sonnet` is
  neither an id nor an alias in the Claude catalog (verified: ids are
  `fable-5-*`, `opus-5-*`, `opus-4.8-*`, `opus-4.7-*`, `opus-4.6-*`,
  `sonnet-5-xhigh`, `sonnet-5-high`, `sonnet-4.6`, `haiku`; the only aliases are
  `fable`, `opus`, `opus-4.6-low/medium`, `opus-4.5`). An unknown id falls
  through to `--model <raw string>` and loses the catalog entry's `env` (effort
  level) and `extra_args`. Templates now derive their ids from the provider
  registry (`_templateModelForTier`) with verified canonical fallbacks.
- **Multi-word `$VISUAL`/`$EDITOR` failed with ENOENT.** `code --wait`,
  `subl -w`, `emacsclient -nw` are ordinary values. The editor now runs through
  a shell with the path appended via `quoteShellArgs`, matching the
  checkout-script precedent in `src/git/worktree.js`.
- **A failed or signalled editor read as success.** Only `result.error` was
  checked, so `:cq` out of `council new` created the untouched (valid) template.
  Non-zero `status` and any `signal` are now aborts.
- **`defaultPrompt` never settled on EOF.** readline emits `close` without
  calling the question callback on closed/piped stdin, so `delete` could hang —
  or, worse, hang inside the editor retry loop holding an un-cleaned temp dir.
  Now resolves `''` once, through a single settle guard.
- **Repository write results were discarded.** `update()`/`delete()` return
  false when the row is gone; `edit`, `rename`, and `delete` all claimed
  success. The `edit` window is wide — the web UI can delete the row while the
  editor blocks.
- **Prototype members were dispatchable verbs.** `council toString` found
  `Object.prototype` on the handler object literal and bypassed the
  unknown-command guard. The table is now a `Map`.
- **Extra operands were silently dropped.** `council delete My Dream Team --yes`
  parsed as handle `My`, which partial matching resolves — and then deletes a
  real council. Each verb now declares its operand count and extras are rejected
  before the database is opened.
- **Document descriptions vanished on save.** Decision: descriptions stay
  file-only (no schema change), but `new`/`edit`/`duplicate` now WARN on stderr
  when one is dropped instead of losing it silently.
- **`edit` could not reach an invalid council file** — the one file most needing
  a validate-as-you-edit session, since the loader skips it and it never becomes
  resolvable. `edit` now falls back to locating `<stem>.council.json` /
  `<stem>.json` under `defaultCouncilsDir()`, and does not offer `council new`
  for a handle that turned out to name a real broken file.

Design/structure changes:
- **Name uniqueness now lives in the resolver's normalized space.**
  `findCouncilNameCollision` (`src/councils/resolve-council.js`) rejects exact
  name, slugified name, AND a file council's filename stem — because
  `resolveCouncilHandle` matches all three, so `Dream Team` + `dream-team`
  made `--council dream-team` ambiguous for both. The two frontend copies keep
  the narrower name-equality rule ON PURPOSE (widening them is a frontend change
  with its own E2E surface); the stale comment in `council-crud.js` that claimed
  otherwise now records the asymmetry.
- **`--list-councils` is a delegation, not a copy**: it calls
  `runCouncilCommand(['list'])`. This depends on `defaultOpenDatabase` keeping
  `applyConfigOverrides` BEFORE `initializeDatabase` — if that ordering moves,
  config-declared providers' file councils silently vanish from the listing with
  no error. Verified empirically with an alias-provider council file.
- `printCouncilList` no longer has a `main.js` re-export; require it from
  `src/councils/print-list.js`.
- The temp-document edit lifecycle (seed → editor → `finally` cleanup) is one
  helper, `_editTempDocument`, shared by `new` and saved-council `edit`.

Test-harness lessons:
- `seedCouncil` must pass a large council config by FILE, not env var — a ~500KB
  environment block fails the spawn with E2BIG on macOS. Any CLI test capturing
  a large stdout must also raise `maxBuffer` past spawnSync's 1MB default.
- `runCli`/`seedCouncil` now delete `PAIR_REVIEW_DB_NAME` from the child env
  before applying test overrides: `resolveDbName` checks the env var FIRST, so a
  developer's or CI's value would point the CLI at a different database than the
  one the test seeded.
- An ordering invariant needs an ordering assertion. The "quiet stdout before
  opening the database" test passed with the call moved below `openDatabase` —
  the exact regression — until both calls were recorded in one order log.

Reviewer claims that did NOT hold up: `seedCouncil` was said to share the
`PAIR_REVIEW_DB_NAME` hole — it does not, because it passes a literal to
`initializeDatabase`, which never consults the env var (only `resolveDbName`
does). The var is deleted there anyway as insurance against a future seed script
that starts using `resolveDbName`.

---

## Phase 4 review round 2 (2026-08-21) — 2 findings + 1 found while fixing them

Green afterwards: **10420 tests / 305 files**. All three verified against the
real spawned CLI, not only through injected deps.

- **`council new` seeds from the resolved global defaults, not hardcoded
  Claude.** The ladder is `resolveSingleProviderModel({}, null, config)`
  (`src/review-config.js`) → `resolveDefaultOrchestration`
  (`public/js/utils/provider-map.js`, the coherence pass both config tabs run)
  → `ProviderClass.defaultTimeout`. `repoSettings` is `null` on purpose:
  `council new` has no repository context. `resolveSingleProviderModel`
  deliberately bypasses both default-COUNCIL tiers, which is what we want — a
  council cannot seed a voice. `buildTemplateDocument(name, type, orchestration)`
  stays pure and synchronous; resolution happens at the call site.
  Verified: `default_provider: codex` seeds `codex/gpt-5.6-sol-high` for voices
  AND consolidation; a `default_provider: pi` row written the way /settings
  writes it seeds `pi` with its own 900000 timeout.
- **The council CLI is a FOURTH global-settings entry point.**
  `defaultOpenDatabase` now folds `GlobalSettingsService.buildEffectiveConfig()`
  in after the DB opens and before `applyConfigOverrides` — the ordering
  contract in `src/settings/global-settings-service.js` names server.js,
  main.js and mcp-stdio.js; the CLI was missing and an in-app /settings
  `default_provider` was invisible to it. Safe because `db_name` and `providers`
  are `editable: false` in `src/settings/registry.js`, so an overlay can never
  change which DB opens or clobber config-declared providers.
  **Unit tests inject `openDatabase`, so nothing in vitest covers this** — a
  mutation deleting the overlay stays green. Only the end-to-end run catches it.
- **`tier` is the PROMPT tier, and the template now says `'balanced'`
  everywhere**, matching both tabs' `_defaultConfig()` and the analyzer's own
  `voice.tier || 'balanced'` fallbacks. The CLI's earlier `tier: 'thorough'`
  consolidation was inventing a convention. The old test's "a voice's tier must
  equal its model's catalog tier" invariant was FALSE — `_updateModelDropdown`
  lists every model of a provider regardless of tier — and is gone.
- **File-council edits are staged.** `_editCouncilFile` used to hand the REAL
  path to `$EDITOR`, so an editor that wrote garbage before an abort left the
  original damaged — worst exactly where it matters, repairing a file the loader
  already rejected. Now: copy → edit the copy → write back only after
  validation. **Invariant: no council verb ever hands a real path to `$EDITOR`.**
  `_editTempFile` is the single mkdtemp/cleanup owner; council files stage RAW
  BYTES (a broken file cannot become a document first) and write back the user's
  EXACT bytes, not a re-serialized document — `parseCouncilDocument` returns a
  normalized subset, so re-serializing would silently drop any other key the
  file carries and reflow the user's formatting on every validation pass.
  Write-back is `fs.writeFile` to the original path, never `rename` (the temp
  dir and the councils dir can be on different mounts — `EXDEV`).
  Residual, accepted: `fs.writeFile` truncates first, so a failure MID-write
  (ENOSPC) can still truncate. The airtight fix is write-sibling-then-rename
  inside the councils dir, with a temp name not ending in `.json`.
- **Found while fixing the above: EOF at the retry prompt looped, then exited
  0.** `defaultPrompt` resolved `''` at EOF and the retry prompt reads `''` as
  "edit again", so a non-interactive `council edit` on a broken file re-opened
  the editor, then died silently with EXIT CODE 0 — readline never re-emits
  `close` on an already-ended stream, so the second prompt never settled and
  nothing kept the event loop alive. CI would read that as a successful repair.
  **EOF is now `null`, an actual empty line is `''`**, and callers branch
  explicitly: the retry prompt aborts on `null`, `delete` treats both as "not
  yes". The regression test TIMES OUT against the old behavior — that timeout
  is the loop.

## Phase 4 review round 3 (2026-08-22) — 3 merge blockers, all fixed

Green afterwards: **10425 tests / 305 files**. Each fix has a regression test
that FAILS against the old code (two of them as a 5s vitest timeout — that
timeout is the hang).

- **A second prompt on a spent stdin never settled — `council edit` exited 0
  having repaired nothing.** Round 2 only closed half of this. `null`-at-EOF
  covers EOF at the FIRST prompt; `_editUntilValid` is a `for(;;)` that
  re-prompts on every bare Enter, so ONE line of piped input reaches prompt #2:
  `printf '\n' | pair-review council edit broken` retries, re-spawns the editor,
  and then faces a stream that will never emit `close` again and never deliver a
  line — **both** settle paths dead. better-sqlite3 holds no libuv handle, so
  the loop drained and the process EXITED 0 with the council still broken and
  the scratch dir leaked (`_editTempFile`'s `finally` sits downstream of an
  await that never returns). `defaultPrompt` now settles as EOF up front when
  `input.readableEnded || input.destroyed`. Verified empirically, not assumed:
  after one `PassThrough` line is consumed the stream reports
  `readableEnded=true, destroyed=true`. The old regression test could not catch
  this — its already-ended input is consumed by prompt #1, so only prompt #1 ever
  ran, and `spawnCalls === 1` pinned the single-prompt case as if it were the
  whole thing. It now drives a stream carrying exactly one line and asserts
  **two** editor spawns, exit 1, and no leaked scratch dir.
- **`edit` suppressed ambiguity and wrote to an arbitrarily selected file
  council.** `_edit` treated EVERY `resolveCouncilHandle` failure as "possibly a
  broken council file". That is valid only for a NO-MATCH. On an ambiguity —
  a saved `Dream Team` plus `dream-team.council.json`, both matched by tier 4 —
  `_findCouncilFile` matched the stem, suppressed the ambiguity error, and wrote
  the user's edits into the file the user never chose, exiting 0. Every other
  verb refuses the same handle, and `_findCouncilFile`'s own docstring says
  write operations must not guess. `resolveCouncilHandle` now stamps
  `error.code`: **`COUNCIL_NOT_FOUND`** on the no-match throw and
  **`COUNCIL_AMBIGUOUS`** on `_ambiguityError`; `_edit` falls back to the file
  ONLY for `COUNCIL_NOT_FOUND` and re-throws everything else (ambiguity,
  database errors) with no create hint. **Branch on the code, never on message
  text** — a reworded message would silently re-open the hole. The codes are
  additive; the other five call sites read only `.message`.
- **Post-editor validation could delete the user's only copy of their work.**
  `_editTempFile`'s cleanup ran BEFORE `_new`/`_edit` did their final
  name-availability check and their `create`/`update`, so a name collision — or
  a council the web UI deleted while the editor was open, or an unwritable
  council file — destroyed the document the user had just authored, with no
  recovery path. The scratch-file lifecycle now spans everything that can still
  fail, via two hooks on `_editTempFile`:
  - `validate(document)` runs INSIDE the retry loop, right after
    `parseCouncilDocument`. Both name checks moved there, so a collision prints
    the message and **reopens the user's own text** through the existing "edit
    again or abort" prompt. `store.list()` re-reads the DB per call, so the
    re-check also catches a name the web UI took mid-session.
  - `commit({document, text})` runs while the scratch file is still on disk and
    owns the real write (`create`, `update`, and the council-file write-back).
    A throw sets `keep` so the `finally` does NOT clean up, and the error gains
    `Your edits were kept at <path>` — the only copy of the user's work, named.
  Only a clean commit or a deliberate abort throws the scratch away.
  **Invariant: the scratch file outlives anything that can still fail.**

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
- **Two tab methods only LOOK like drift** (Decision B, 2026-08-17):
  `loadCouncils`'s filter predicate (`c.type === 'council'` vs
  `!c.type || c.type === 'advanced'`) and `autoSaveIfDirty`'s name prefix
  (`Council` vs `Advanced`) are deliberate per-tab differences. Any
  deduplication pass must keep them parameterized through
  `COUNCIL_CRUD_SPEC`, never unify them.
- **Legacy untyped councils are advanced, in one place only.** The
  untyped ⇒ advanced rule lives in `CouncilCard.render` (layout),
  `CouncilDropdown.typeBadge` (label), and the two `loadCouncils` filters
  (which editor owns them). Those four must agree; the Phase 3 review round
  fixed a case where the badge and the card disagreed for one commit. Do not
  add a fifth copy by pre-normalizing `type` in a consumer.
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
- Auto-save prefixes are `Council <timestamp>` / `Advanced <timestamp>`,
  tracking the `type` column literals; the voice half deliberately does not
  match its "Standard" badge (Decision A, 2026-08-17).
- The remaining ~346 lines of tab duplication get extracted as its own commit
  before Phase 4, after the `loadCouncils` filter tests pin the asymmetry
  (Decision B, 2026-08-17). **Both steps done; the shared bodies live in
  `council-crud.js` and the per-tab values in a grown `COUNCIL_CRUD_SPEC`
  (2026-08-18).**
- `council-manager.css` / `snippet-manager.css` extraction deferred until a
  third settings-page manager exists — design the base against three cases,
  not two (2026-08-17).
