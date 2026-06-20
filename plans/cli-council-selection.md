# CLI Council Selection (`--council` + `--list-councils`)

> Rename this plan file to `plans/cli-council-selection.md` when implementation begins (per CLAUDE.md convention).

## Context

Today a "council" (a multi-voice / multi-provider AI review config) can only be
selected in the web UI or via the HTTP API (`POST /api/.../analyses/council`).
There is no way to choose a council from the command line — the existing
`--model <name>` flag only sets a single global model and feeds the standard
`analyzeAllLevels` path. Users running headless reviews (`--ai-draft`,
`--ai-review`) or kicking off an interactive analysis (`--ai`, `--local --ai`)
cannot use a council at all.

This change adds a `--council <handle>` flag (works in PR headless, PR
interactive, and local modes) plus a `--list-councils` discovery command.

**Identifier decision (settled):** Use a **smart resolver, no schema change.**
A council handle resolves by UUID → UUID-prefix (git-style) → exact name
(case-insensitive) → normalized name (`"My Council"` ↔ `my-council`). Ambiguous
matches fail loudly and list the candidates with their short ids;
`--list-councils` prints the short id as the always-unique fallback. We are
deliberately **not** adding a persistent `slug` column now (it would require a
migration, backfill, create/rename sync, UI work, and test-schema updates). The
resolver is a strict subset of a future hybrid, so slugs can be added later and
integrated with the resolver with nothing wasted.

## Approach

### 1. New resolver module — `src/councils/resolve-council.js`

Export `resolveCouncilHandle(db, handle)` returning the full council row
(`{ id, name, type, config, ... }`) or throwing a clear `Error`.

Algorithm (first unambiguous match wins):
1. `const all = await new CouncilRepository(db).list()` (small N; one query).
2. Exact id: `all.find(c => c.id === handle)`.
3. UUID-prefix (only when `handle.length >= 4` and `/^[0-9a-f-]+$/i`): filter by
   `c.id.startsWith(handle.toLowerCase())`. 1 → return; >1 → ambiguity error.
4. Exact name (case-insensitive). 1 → return; >1 → ambiguity error (names are
   non-unique).
5. Normalized name: `normalizeForMatch(s) = s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')` on both sides. 1 → return; >1 → ambiguity.
6. No match → not-found error: `No council matches "<handle>". Run \`pair-review --list-councils\` to see available councils.`

Also export `shortId(id) => id.slice(0, 8)` (reused by `--list-councils`).
Ambiguity message lists `name (shortId)` per candidate and tells the user to
disambiguate with the id.

`CouncilRepository` already exists at `src/database.js:5374` with `list()` and
`getById()` — reuse it; no new repo methods needed.

### 2. `--list-councils` discovery command (`src/main.js`)

Early-return handler, like `--configure`, runs **without a PR arg and without
starting the server** — needs only a DB handle.
- Guard `if (args.includes('--list-councils'))` placed **before** single-port
  delegation, after `loadConfig()`. Initialize the DB (mirror existing init),
  call `CouncilRepository.list()` (already MRU-ordered), enrich each council with
  its last-used repo (query below), print a table, then `db.close()` and
  `process.exit(0)` (mirror other early-exit handlers — do not leave a dangling
  handle).
- Columns: `HANDLE` (short id), `NAME`, `TYPE` (`council`/`advanced`),
  `LAST USED` (date or `never`), `LAST USED WITH` (repo, or `—`). Footer shows an
  example `--council` invocation.
- **"Last Used With" derivation.** Council runs are recorded in `analysis_runs`
  with `provider='council'` and `model=<councilId>` (inline configs use
  `model='inline-config'` and are excluded), tied to a `review_id`. Join to
  `reviews` for the repo. One grouped query covers all councils (SQLite's
  bare-column-with-MAX semantics return the row at the latest run):
  ```sql
  SELECT ar.model AS council_id,
         r.repository, r.review_type, r.pr_number,
         MAX(ar.started_at) AS last_started
  FROM analysis_runs ar
  JOIN reviews r ON r.id = ar.review_id
  WHERE ar.provider = 'council' AND ar.model != 'inline-config'
  GROUP BY ar.model
  ```
  Build a `Map(council_id → { repository, review_type, pr_number, last_started })`.
  Display: PR reviews → `repository` (append `#pr_number` when present); local
  reviews (`review_type='local'`) → `repository`; no matching run → `—`. Add this
  as a small read helper (e.g. `getCouncilLastUsedRepos(db)`) rather than inline
  SQL in `main.js`, so it is unit-testable. Note: `analysis_runs.started_at` is a
  more accurate "last used" than the touched `councils.last_used_at`; keep list
  ordering on `CouncilRepository.list()` (MRU by `last_used_at`) but source both
  the `LAST USED` date and the repo from this join when a run exists, falling back
  to `last_used_at`/`never`/`—` otherwise.
- Empty state: `No councils found. Create one in the web UI under Analysis settings.`

### 3. `--council <handle>` flag wiring

**parseArgs / flags (`src/main.js`):**
- Add `'--council'` and `'--list-councils'` to `KNOWN_FLAGS` (`:271`).
- Add a `--council` branch in `parseArgs` (`:323`) mirroring `--model` exactly
  (consume next arg unless it starts with `-`, else throw
  `--council flag requires a council handle (e.g., --council my-council)`).
  Sets `flags.council`.
- Add `--list-councils` to the skip-branch (`:341`, handled in `main()`).
- `printHelp()` (`:129`): document both flags under OPTIONS and add an EXAMPLE.

**Headless PR (`--ai-draft` / `--ai-review`):** Encapsulate the council run in a
NEW server-free helper `src/councils/headless-council.js` →
`runHeadlessCouncilAnalysis(db, { analyzer, reviewId, council, configType, councilConfig, worktreePath, prMetadata, instructions, githubClient })`,
called from `performHeadlessReview` (~`src/main.js:976`–`1000`) when `flags.council`
is set. This replicates the **server-free essence** of `launchCouncilAnalysis`
(`src/routes/analyses.js:505`) — verified contract below — WITHOUT the SSE /
pool / hooks / `activeAnalyses` coupling. Add a code comment in both functions
cross-referencing each other so the two council invokers stay in parity.

Resolve **early** in `performHeadlessReview` (right after `repoSettings`, before
GitHub work) so a bad handle aborts fast:
1. `const council = await resolveCouncilHandle(db, flags.council)`;
   `const configType = council.type` (`'council'` | `'advanced'`).
2. Reuse route helpers: `const { validateCouncilConfig, normalizeCouncilConfig } = require('./routes/councils')`;
   `const councilConfig = normalizeCouncilConfig(council.config, configType)`; throw on `validateCouncilConfig`.
3. Construct `const analyzer = new Analyzer(db, 'council', 'council', providerOverrides)` (per-voice provider/model come from the config).

Inside `runHeadlessCouncilAnalysis` (mirrors `launchCouncilAnalysis:530`–`654`):
1. `const runId = uuidv4()`.
2. Compute `levelsConfig` exactly as the route (analyses.js:533–541): voice-centric → `councilConfig.levels`; advanced → map each level to `val?.enabled !== false`.
3. **Pre-create the parent run with the council id** (this is the key — do NOT
   omit runId): `await new AnalysisRunRepository(db).create({ id: runId, reviewId, provider: 'council', model: council.id, tier: null, globalInstructions, repoInstructions, requestInstructions: null, headSha: prMetadata?.head_sha || null, configType, levelsConfig })`.
   (`runCouncilAnalysis`/advanced creates NO parent run itself;
   `runReviewerCentricCouncil` would create one with `model:'voice-centric'` when
   `runId` is omitted — both wrong for council attribution. Passing our `runId`
   makes the analyzer reuse our record, keeping `model = council.id` so
   `last_council_id` detection and the "Last Used With" join work.)
4. `new CouncilRepository(db).touchLastUsedAt(council.id).catch(() => {})` (best-effort).
5. `reviewContext = { reviewId, worktreePath, prMetadata, changedFiles: null, instructions: { globalInstructions, repoInstructions, requestInstructions: null } }`.
6. `const result = await (configType === 'council' ? analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, { runId, progressCallback: null, githubClient }) : analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId, progressCallback: null, githubClient }))`.
7. On success: `await runRepo.update(runId, { status: 'completed', summary: result.summary, totalSuggestions: result.suggestions.length, ...(result.levelOutcomes ? { levelOutcomes: result.levelOutcomes } : {}) })`. Return `result`.
8. On error: `await runRepo.update(runId, { status: 'failed' }).catch(() => {})`; rethrow.

Back in `performHeadlessReview`: `analysisSummary = result.summary`, then fall
through to the **existing** suggestions query/print path (`src/main.js:1000`) —
council methods persist orchestrated suggestions with the same shape
(`source='ai'`, `ai_level IS NULL`, `is_raw=0`, `status='active'`), so no
print/submit change is needed (the integration test must confirm suggestions land).

When `flags.council` is unset, the existing `analyzeAllLevels` path is unchanged.

**Interactive PR (`--ai`) and Local (`--local`) — pass through the browser URL:**
The browser already runs council analysis; we just need to hand it the id.
- `src/main.js:665` (PR URL build): when `flags.council`, resolve to
  `council.id` (reusing the already-initialized `db` in `handlePullRequest`) and
  append `&council=${council.id}` after `?analyze=true`. Resolve **before**
  building the URL so a bad handle errors at the CLI, not in the browser.
- `src/local-review.js:921` (local URL build): same append.
- **`--council` implies analysis** in interactive mode: if `--council` is set and
  none of `--ai`/`--ai-draft`/`--ai-review` is present, treat it like `--ai`
  (the browser only auto-analyzes on `?analyze=true`). Document this.

**Frontend (small change — the `council` param is NOT honored today):**
- `public/js/pr.js` `_buildDefaultAnalysisConfig` (~`:636`): read
  `const urlCouncilId = new URLSearchParams(window.location.search).get('council')`
  and use it as the highest-priority councilId:
  `urlCouncilId || repoSettings?.default_council_id || reviewSettings?.last_council_id || null`.
  When `urlCouncilId` is present, force the council branch and fetch
  `/api/councils/${councilId}` to get `config` + `type`.
- Clean the param: add `cleanUrl.searchParams.delete('council')` beside the
  existing `delete('analyze')` in `_maybeAutoAnalyze` (`pr.js:714`) and the local
  auto-analyze `finally` (`local.js:88`).
- `_buildDefaultAnalysisConfig` is shared (local monkey-patches `PRManager`), so
  the `pr.js` edit covers both routes; `local.js` only needs the cleanup line.

**Precedence:** explicit `--council` > (browser only) `repoSettings.default_council_id`.
Headless mode does **not** auto-apply `default_council_id` when `--council` is
absent — this preserves current headless behavior (deliberate; a one-line
opt-in fallback is a possible future follow-up).

**`--model` interaction:** a council defines per-voice models, so `--model` is
meaningless under `--council`. When both are set, print a stderr warning
(`Warning: --model is ignored when --council is set; council voices use their own per-voice models.`)
and **gate every `process.env.PAIR_REVIEW_MODEL = flags.model` assignment behind
`!flags.council`** (`src/main.js:654`, `src/local-review.js:912`).

### 4. Validation & errors
- Unknown / ambiguous handle → resolver throws (see §1); headless aborts before
  GitHub work, interactive errors before opening the browser.
- Invalid config / provider not configured → reuse `normalizeCouncilConfig` +
  `validateCouncilConfig` (same as `src/routes/local.js:2229`, `pr.js:2490`);
  `validateCouncilFormat` already checks each voice has a valid
  `provider`/`model`.

## Tests (mandatory)
- `tests/unit/resolve-council.test.js` (new): seed a temp DB via
  `CouncilRepository.create`; cover exact id, unique prefix, ambiguous prefix,
  exact name (case-insensitive), normalized name (`"My Council"` ↔ `my-council`),
  duplicate-name ambiguity, not-found, and short-prefix-treated-as-name. Assert
  error messages contain the short ids.
- `tests/unit/main.test.js` (extend): parseArgs — `--council x` sets
  `flags.council`; `--council` with no value throws; `--council --ai` (value
  looks like a flag) throws; `--list-councils` recognized (no unknown-flag
  error).
- `getCouncilLastUsedRepos(db)` (new helper) unit test: seed councils +
  `reviews` + `analysis_runs` rows (a PR review and a local review, plus an
  `inline-config` run that must be excluded); assert the map returns the repo of
  the **most recent** run per council and omits never-used councils.
- `tests/integration` (extend/new, spawnSync with `PAIR_REVIEW_NO_OPEN: '1'`):
  `--list-councils` against a seeded temp DB prints handle/name/type and the
  `LAST USED WITH` repo for a council with a seeded run (and `—` for an unused
  one), and exits 0; `--ai-draft --council <bad>` exits non-zero with
  "No council matches".
- No DB/migration/schema test changes (Option A adds no column).
- E2E: if an existing spec exercises `?analyze=true`, add a minimal assertion
  that `?analyze=true&council=<id>` selects the council config. Run frontend
  E2E via a Task per CLAUDE.md after the `pr.js`/`local.js` edits.

## Docs / changeset
- README: document `--council <handle>` and `--list-councils`, with PR
  (`--ai`/`--ai-draft`/`--ai-review`) and `--local --ai --council` examples; note
  the `--model` interaction and that `--council` implies analysis interactively.
- Changeset (`.changeset/*.md`, **minor**): "Add `--council <handle>` to select a
  multi-voice council from the CLI (PR headless, PR interactive, and local) plus
  `--list-councils` to discover handles. Handles resolve by id, id-prefix, or
  name."

## Hazards
- **Do NOT call `launchCouncilAnalysis` headless.** It mutates module-level
  server state (`activeAnalyses`, `reviewToAnalysisId`) and calls
  `broadcastProgress` / `broadcastReviewEvent` / `poolLifecycle` — all undefined
  or unsafe outside the running server. The analyzer council methods are
  self-contained (create their own run record, persist suggestions, tolerate a
  null `progressCallback`); call them directly, mirroring the existing
  `analyzeAllLevels` call.
- **Run-record creation (RESOLVED — pre-create with the council id, pass runId).**
  Verified: `runCouncilAnalysis` (advanced, `analyzer.js:3482`) creates NO parent
  `analysis_runs` row; `runReviewerCentricCouncil` (`:2943`) creates one with
  `model:'voice-centric'` only when `options.runId` is absent. The route
  (`launchCouncilAnalysis:543`–`556`) always pre-creates the row with
  `model = councilId || 'inline-config'` and passes `runId`, which is what makes
  `last_council_id` (`local.js:2125`, keyed on `model`) and the "Last Used With"
  join work. The headless helper MUST do the same: pre-create with
  `model = council.id` and pass `runId`. It also must replicate the route's
  completion/failure `analysisRunRepo.update` (the route does this in its
  `.then()/.catch()` at `analyses.js:648`/`731`), since the analyzer methods do
  not mark the parent run completed themselves.
- **Two council invokers must stay in parity.** `launchCouncilAnalysis` (web) and
  `runHeadlessCouncilAnalysis` (CLI) both drive the council analyzer methods.
  CLAUDE.md already documents three analyzer *paths*; this adds a second
  *invoker*, not a new analyzer path. Cross-reference them in comments; if the
  run-record fields or completion semantics change in one, change both.
- **`process.env.PAIR_REVIEW_MODEL` is process-global**, set in two places
  (`src/main.js:654`, `src/local-review.js:912`) and read at `src/main.js:977`.
  The `!flags.council` gate must be applied at **both** assignment sites.
- **`_buildDefaultAnalysisConfig` is shared by PR and local** via `PRManager`
  monkey-patching. Editing it to read the `council` param affects both — intended
  for parity, but verify the local path still cleans the param and that forcing
  the council branch when `urlCouncilId` is set doesn't break the `default_tab`
  UI assumptions in the progress modal.
- **`changedFiles: null` in `reviewContext`**: the analyzer falls back to
  `getChangedFilesList`. Confirm `storedPRData` carries `head_sha` so the diff
  snapshot + path validation behave identically to `analyzeAllLevels`.
- **`--list-councils` DB lifecycle**: `db.close()` before `process.exit(0)`, and
  place the check before single-port delegation so it doesn't collide with it.

## Verification (end-to-end)
1. `pnpm test` — new resolver + parseArgs + integration tests pass.
2. Manual discovery: `pair-review --list-councils` lists seeded councils with
   short-id handles (and prints the empty-state when none exist).
3. Headless PR: `pair-review <pr> --ai-draft --council <name-or-shortid>` runs the
   council (multiple voices in logs), persists suggestions, prints the summary;
   `--council <bad>` aborts with a clear error before any GitHub call.
4. Interactive: `pair-review <pr> --council <handle>` opens the browser, the
   council config tab is pre-selected, and analysis auto-runs; same for
   `pair-review --local --ai --council <handle>`.
5. `--model` + `--council` together prints the ignore warning and still uses the
   council's per-voice models.
6. Frontend E2E run (via Task) green after `pr.js`/`local.js` edits.

## Critical files
- `src/councils/resolve-council.js` — NEW resolver (`resolveCouncilHandle`,
  `shortId`, `normalizeForMatch`) and `getCouncilLastUsedRepos(db)` helper (the
  `analysis_runs`⋈`reviews` join for the "Last Used With" column).
- `src/councils/headless-council.js` — NEW `runHeadlessCouncilAnalysis(...)`:
  server-free council run (pre-create run with `model=council.id` + `runId`,
  invoke analyzer council method, update status/summary). Mirrors
  `launchCouncilAnalysis` minus SSE/pool/hooks.
- `src/database.js` — reuse `AnalysisRunRepository.create`/`update` (`:4969`/`:4995`)
  and `CouncilRepository` (`:5374`); no schema change.
- `src/main.js` — `KNOWN_FLAGS` (`:271`), `parseArgs` (`:299`), `printHelp`
  (`:129`), `--list-councils` early handler in `main()`, headless council branch
  in `performHeadlessReview` (~`:976`–`1000`), PR interactive URL (`:665`),
  `--model` gating (`:654`).
- `src/local-review.js` — local URL + `--model`/`--council` gating (`:912`–`921`).
- `src/ai/analyzer.js` — `runCouncilAnalysis` (`:3482`), `runReviewerCentricCouncil`
  (`:2943`): confirm self-contained run-record creation and suggestion-store
  columns match the headless query.
- `src/routes/councils.js` — reuse `normalizeCouncilConfig` / `validateCouncilConfig`.
- `public/js/pr.js` (`_buildDefaultAnalysisConfig` ~`:636`, `_maybeAutoAnalyze`
  `:714`) and `public/js/local.js` (`:78`/`:88`) — read & clean the `council` URL param.
- Tests + README + `.changeset/*.md` as above.
