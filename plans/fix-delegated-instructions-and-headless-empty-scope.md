# Fix two headless/delegation bugs in `--instructions` + `--headless --local`

## Context

Two review-flagged bugs in the in-flight `--headless` CLI feature (branch `headless`):

### Bug 1 — interactive `--ai`/`--council` silently drops `--instructions` when a server is already running
With the default `single_port: true`, if a pair-review server is already up on the
configured port, `main.js:753` calls `attemptDelegation(...)` **before**
`prepareInteractiveAnalysisConfig` ever runs (that only fires in the cold-start
handlers, `handlePullRequest:941` / `handleLocalReview:946`). The skip guard
(`config.single_port !== false && !flags.aiReview && !flags.aiDraft && !flags.headless`)
does **not** exempt `flags.ai`/`flags.council`, so those modes delegate. But the
delegated URL (`single-port.js:buildDelegationUrl`) only encodes `analyze=true` +
optional `council=<id>` — no `analysisConfigId`, no instructions. Second trap:
`createBulkAnalysisConfig` writes an **in-process** `Map`
(`bulk-analysis-configs.js:264`); the CLI process and the running server don't
share memory, so even threading an id requires an HTTP handoff. Result: instructions
vanish silently, contradicting the README promise (line 198) that `--instructions`
is never silently dropped.

### Bug 2 — headless local review turns enumeration failures into false success
In `handleHeadlessAnalysis` (local branch, `main.js:2050-2095`), `changedFiles`
comes from `getChangedFiles()` (`executable-analysis.js:101`), which wraps its git
commands in try/catch and returns `[]` on **any** failure (and uses a smaller exec
buffer than diff generation, so it can fail independently). `changedFiles.length === 0`
is then treated as proof of an empty scope → `recordEmptyScopeRun()` → exit 0. The
web path is shielded by `rejectIfEmptyScope` (HTTP 409); headless has no backstop, so
an operational git error becomes a false "no changes" exit-0 success for CI/scripts.

The fix uses the **session diff** as the authoritative empty-scope signal:
`setupLocalReviewSession` (`local-review.js:714`) already generated the scoped diff via
`generateScopedDiff`, which **throws** on hard git failure (`local-review.js:538-543`)
and returns `''` only when the scope is genuinely empty. So `session.diff` is a
trustworthy signal; a separate, *throwing* enumeration is used only for the analysis path.

Both fixes follow the project's "proper, complete implementation" standard (the
feedback's recommended fixes, not the stopgaps).

---

## Bug 1 — HTTP POST handoff for the delegated case

### 1. `src/interactive-analysis-config.js` — split builder from storage
- Extract a pure `buildInteractiveAnalysisConfig({ db, config, flags, repository })`
  that returns the resolved `analysisConfig` object (single `{provider, model,
  customInstructions}` or council snapshot `{isCouncil, configType, councilConfig,
  councilName, customInstructions}`), or `null` when no instructions. This is lines
  90-114 minus the `createBulkAnalysisConfig` call.
- Keep `prepareInteractiveAnalysisConfig` as a **thin wrapper**: call the builder, return
  `null` if null, else `createBulkAnalysisConfig(cfg).id`. Cold-start callers
  (`handlePullRequest`, `handleLocalReview`) are unchanged.
- Export both.

### 2. `src/single-port.js` — remote handoff + URL threading
- Add `buildInteractiveAnalysisConfig` to the module `defaults` object (DI, so tests can
  stub it) and import `normalizeRepository` from `./utils/paths`.
- New `storeAnalysisConfigRemote(port, analysisConfig, _deps)`: POSTs `{ analysisConfig }`
  to `http://localhost:<port>/api/bulk-analysis-configs` (the endpoint already validates
  and returns `{ id }`, `bulk-analysis-configs.js:273`). Reads the response body
  (like `detectRunningServer`), resolves the `id` on 2xx, and **rejects with a clear
  error** on non-2xx / validation error / transport error / timeout. Uses
  `deps.httpRequest` + `HEALTH_TIMEOUT_MS` (mirrors `notifyVersion`).
- Extend `buildDelegationUrl` to accept `context.analysisConfigId`. When present, append
  `analysisConfigId=<id>` and **drop** `council=` (the id already encodes the council
  snapshot — mirrors the cold-start precedence at `main.js:944-948`). Applies to both
  `pr` and `local` modes.
- Extend `attemptDelegation(config, flags, prArgs, _deps, options)`:
  - New `options.db` and `options.localRepository`.
  - After confirming the server is running and resolving `prInfo`/`targetPath`, when
    `(flags.ai || flags.council) && options.db`: resolve `repository`
    (PR → `normalizeRepository(prInfo.owner, prInfo.repo)`; local →
    `options.localRepository`), build via `deps.buildInteractiveAnalysisConfig({db, config,
    flags, repository})`. If it returns a config, `storeAnalysisConfigRemote(...)` → id,
    pass `analysisConfigId` into `buildDelegationUrl`. A failed POST throws (propagates to
    `main()`'s catch → exit 1; loud, not silent).
  - When no config is built (no instructions, or `options.db` absent — as in existing
    tests), behavior is unchanged: fall back to the `councilId` param.
- Export `storeAnalysisConfigRemote`.

### 3. `src/main.js` — feed the delegation handoff
- Import `getRepositoryName` from `./local-review`.
- In the delegation block (`~747-760`): compute
  `wantsInstructionHandoff = (flags.instructions || flags.instructionsFile) && (flags.ai || flags.council)`.
  Open the DB if not already open and a handoff is needed (`--council` already opens it
  at `743-745`). For local mode, resolve `localRepository = await getRepositoryName(
  path.resolve(flags.localPath || process.cwd()))` (matches what `setupLocalReviewSession`
  uses at `local-review.js:725`, so the delegated config resolves repo defaults identically
  to cold start). Pass `{ councilId, db, localRepository }` to `attemptDelegation`.

*Note:* not adopting the optional "always thread analysisConfigId even when empty" idea —
the `councilId` fallback already works and keeping it is lower-risk.

---

## Bug 2 — session diff as the authoritative empty-scope signal

### 4. `src/routes/executable-analysis.js` — throwing variant of `getChangedFiles`
- Add a third param: `getChangedFiles(cwd, context, { throwOnError = false } = {})`.
  In the catch block, when `throwOnError` is set, rethrow a clear error
  (`Failed to enumerate changed files in <cwd>: <msg>`) instead of logging + returning `[]`.
  Default `false` keeps all existing callers (`local.js:95/1271/1606`,
  `executable-analysis.js:397`) unchanged.

### 5. `src/main.js` — drive the empty-scope branch off `session.diff`
- In `handleHeadlessAnalysis` local branch, replace the unconditional
  `getChangedFiles` + `changedFiles.length === 0` check with:
  - `const isEmptyScope = !session.diff || session.diff.trim().length === 0;`
  - `if (isEmptyScope) { recordEmptyScopeRun(...) }`
  - `else { const changedFiles = await getChangedFiles(repoPath, {scopeStart, scopeEnd,
    baseBranch}, { throwOnError: true }); runHeadlessAnalysis(... changedFiles ...) }`
  - Move `reviewConfig`/`providerOverrides`/`instructions` computation above the branch
    (already there) so both arms have what they need.
- Net effect: a genuinely empty scope still records an empty run (exit 0); a real git
  enumeration failure now **throws** → non-zero exit, never a false success.

---

## Tests

- **`tests/unit/interactive-analysis-config.test.js`**: add `buildInteractiveAnalysisConfig`
  cases (returns null without instructions; returns single + council shaped objects with
  `customInstructions`, no storage side-effect). Confirm `prepareInteractiveAnalysisConfig`
  wrapper still stores + returns an id.
- **`tests/unit/single-port.test.js`**: 
  - `buildDelegationUrl` with `analysisConfigId` (PR + local; drops council when both).
  - `storeAnalysisConfigRemote`: POSTs to `/api/bulk-analysis-configs` with
    `{analysisConfig}` body, resolves the returned id; rejects on non-2xx / error body /
    transport error (add a response-bearing `httpRequest` mock).
  - `attemptDelegation` handoff: with a stubbed `deps.buildInteractiveAnalysisConfig`
    returning a config + a mock POST returning an id → URL carries `analysisConfigId` and
    NOT `council`; builder returning `null` → existing council/analyze behavior; POST
    failure → rejects. Existing tests (no `options.db`) must stay green.
- **`tests/unit/executable-analysis.test.js`**: add `throwOnError` cases — throws on git
  error and on `findMergeBase` failure; default (no option) still returns `[]`.
- Bug 2's empty-scope decision lives in the large `handleHeadlessAnalysis` (not cleanly
  unit-isolatable without a real git repo); the throwing-`getChangedFiles` unit test is the
  direct regression guard for the operational-error-to-exit path. The `session.diff` switch
  is a small, low-risk readability change covered by a clear inline comment.

## Docs / changeset
- The behavior is part of the unreleased `--headless` feature; update the existing
  `.changeset/headless-cli-analysis.md` only if wording needs it (the README contract at
  line 198 is now actually upheld for the delegated path — no README change required).

## Verification
- `pnpm test tests/unit/single-port.test.js tests/unit/interactive-analysis-config.test.js tests/unit/executable-analysis.test.js tests/integration/headless-analysis.test.js`
- Manual Bug 1: start a server (`pair-review` on the configured port), then in another
  shell `pair-review <pr> --ai --instructions "focus on auth"` → delegated URL contains
  `analysisConfigId=...` (and no `council=`); the running server's analysis shows the
  custom instructions. Repeat with `--local --ai --instructions`.
- Manual Bug 2: `pair-review --local --headless` in a repo with no changes → clean exit 0,
  empty suggestions. (Enumeration-failure path is covered by the unit test.)
- Full suite: `pnpm test`.
