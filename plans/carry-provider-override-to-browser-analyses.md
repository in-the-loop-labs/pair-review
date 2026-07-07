# Carry `--provider` / `--model` overrides into browser-driven analyses

## Context

Commit `662e60f8` added a `--provider` CLI flag (mirrored into `PAIR_REVIEW_PROVIDER`, alongside the existing `--model`/`PAIR_REVIEW_MODEL`). It works for **headless** modes and is correctly honored by the backend resolvers (`resolveProviderModel` in `src/routes/shared.js`, `_resolveStackProviderModel` in `src/routes/stack-analysis.js`, MCP paths). But for **browser-driven** analyses (the headline goal — `pair-review <target> --ai --provider codex`) the override never takes effect. Two independent root causes:

1. **The browser sources its default from a channel blind to the CLI flag.** Auto-analyze / stack / manual / bulk modals seed their provider/model from `/api/config` (`default_provider`/`default_model` via `resolveDefaultProviderModel` in `src/routes/config.js`) + saved repo settings, resolved by `window.resolveProviderModelPair([repoSettings, appConfig])`. None of these read `PAIR_REVIEW_PROVIDER`/`PAIR_REVIEW_MODEL`. The browser then POSTs the resolved pair, and because the request body has top priority in the backend resolvers, the env-fallback branch is dead code for every browser analysis. (Blocker — flagged on `src/routes/shared.js:130` and `src/routes/stack-analysis.js:363`.)

2. **Single-port delegation exits before the env is even mirrored.** With `single_port` on (default), `pair-review <target> --ai --provider codex` delegates to an already-running server and `process.exit(0)`s before `handlePullRequest` mirrors the flag into `process.env`. The delegated-to server is a *different* process that never saw the flag, and the delegation URL doesn't carry it. (Medium — flagged on `src/main.js:678`.)

Both must be fixed. Fix #1 covers the process that actually owns the CLI flag (non-delegated: `single_port:false`, or the first invocation that starts the server). Fix #2 carries the override across the delegation boundary via the URL — the only channel to the already-running server.

**Product decision (confirmed):** when an override is active and the repo default is a *council*, auto-analyze **forces the single-provider path** with the override pair (council default is bypassed) — so `--provider` is always meaningful.

## Hazards

- **`resolveProviderModelPair([repoSettings, appConfig])` seeds repoSettings FIRST.** Simply folding the env override into `appConfig.default_provider` is insufficient — it would still lose to a repo's saved `default_provider`, violating the documented `CLI/env > repo settings` contract. The override scope must be **prepended ahead of repoSettings**. This is the central trap.
- **Five frontend seed sites** call `resolveProviderModelPair([...])` and must all be routed through one helper to avoid divergence:
  - `public/js/pr.js:655` `_buildDefaultAnalysisConfig` (PR **and** local auto-analyze — shared)
  - `public/js/pr.js:3000` `triggerStackAnalysis` (stack modal)
  - `public/js/pr.js:6868` PR manual analyze dialog
  - `public/js/local.js:332` local manual analyze dialog
  - `public/js/index.js:2003` bulk analysis modal (seeds from `window.__pairReview.defaultProvider/defaultModel`, set at `index.js:1386`)
- **Delegated + manual (no `--ai`) is out of scope.** The delegation URL only carries provider/model when `analyze=true` (the auto-analyze path is the only consumer that reads + strips them). A delegated `--provider` without `--ai` seeds nothing on the other process's manual dialog. Documented limitation; use `--ai` or headless.
- **`buildDelegationUrl` currently hand-toggles `?`/`&`.** Adding params by hand is error-prone; switch to `URLSearchParams`.
- **Backend resolvers already cooperate** — no backend precedence change needed. `resolveProviderModel` / `_resolveStackProviderModel` already rank request-body highest. Once the browser POSTs the right pair, it wins.
- **Existing tests to extend, not duplicate:** `tests/unit/provider-model.test.js`, `build-default-analysis-config.test.js`, `resolve-default-provider-model.test.js`, `single-port.test.js`, `stack-analysis-provider-model.test.js`, `main.test.js`, `shared.test.js`.

## Implementation

### Part A — Backend: expose the override signal from `/api/config`
`src/routes/config.js` (`GET /api/config` handler, ~line 151): add two fields carrying the raw env override so the frontend can prepend them ahead of repo settings:
```js
provider_override: process.env.PAIR_REVIEW_PROVIDER || null,
model_override: process.env.PAIR_REVIEW_MODEL || null,
```
Comment explaining the ordering trap (dedicated signal, not folded into `default_provider`, precisely because seed sites put repoSettings first). Leave `resolveDefaultProviderModel` unchanged (it stays "config/repo-agnostic default"; env is a separate, higher scope).

`public/js/index.js:1386` (where `window.__pairReview` is populated from `/api/config`): also expose
```js
window.__pairReview.providerOverride = config.provider_override || null;
window.__pairReview.modelOverride = config.model_override || null;
```

### Part B — Frontend: shared scope-builder (`public/js/utils/provider-model.js`)
Add and export (via `window` + `module.exports`) a helper that prepends override scopes ahead of repoSettings:
```js
function buildProviderModelScopes(repoSettings, appConfig = {}, extraOverride = null) {
  const scopes = [];
  // 1. Per-invocation override (delegation URL params) — highest.
  if (extraOverride && (extraOverride.provider || extraOverride.model)) {
    scopes.push({ provider: extraOverride.provider || null, model: extraOverride.model || null });
  }
  // 2. CLI/env override surfaced by /api/config (non-delegated invocations).
  if (appConfig.provider_override || appConfig.model_override) {
    scopes.push({ provider: appConfig.provider_override || null, model: appConfig.model_override || null });
  }
  // 3. Saved repo settings.  4. App/config defaults.
  scopes.push({ provider: repoSettings?.default_provider, model: repoSettings?.default_model });
  scopes.push({ provider: appConfig.default_provider, model: appConfig.default_model });
  return scopes;
}
function hasProviderModelOverride(appConfig = {}, extraOverride = null) {
  return !!(extraOverride?.provider || extraOverride?.model
    || appConfig.provider_override || appConfig.model_override);
}
```
A provider-only override (`{provider:'codex', model:null}`) resolves via the existing `resolveProviderModelPair` to codex + codex's default model — correct.

### Part C — Route the five seed sites through the helper
Replace each `resolveProviderModelPair([{repo}, {app}], providers)` with
`resolveProviderModelPair(window.buildProviderModelScopes(repoSettings, appConfig), providers)`.
- `pr.js:3000` (stack), `pr.js:6868` (PR manual), `local.js:332` (local manual): straight substitution (`appConfig` in scope).
- `index.js:2003` (bulk): build an `appConfig`-shaped object from `window.__pairReview` (`default_provider`, `default_model`, `provider_override`, `modelOverride→model_override`) and pass to the helper.

### Part D — Auto-analyze honors override + council decision (`_buildDefaultAnalysisConfig`)
`public/js/pr.js:621` — change signature to accept an optional URL override:
`_buildDefaultAnalysisConfig(repoSettings, reviewSettings, appConfig = {}, providersInfo = null, urlOverride = null)`.
- Compute `overrideActive = window.hasProviderModelOverride(appConfig, urlOverride)`.
- **Council skip:** guard the council/advanced branch with `!overrideActive` (per confirmed decision — override forces single-provider).
- Resolve the pair via `resolveProviderModelPair(window.buildProviderModelScopes(repoSettings, appConfig, urlOverride), providers)`.

### Part E — Single-port delegation carries the override
`src/single-port.js`:
- `buildDelegationUrl(port, mode, context)`: rebuild query string with `URLSearchParams`; append `provider`/`model` when present **and** `context.analyze` is true (auto-analyze is the only consumer that reads + strips them). Applies to both `pr` and `local` modes.
- `attemptDelegation`: add `provider: flags.provider, model: flags.model` to the `context` passed to `buildDelegationUrl` for both the `local` and `pr` branches.

`public/js/pr.js` `_maybeAutoAnalyze` (~699) and `public/js/local.js` auto-analyze (~73):
- Read `provider`/`model` from `URLSearchParams`.
- Pass `{provider, model}` as the `urlOverride` arg to `_buildDefaultAnalysisConfig` (default-config branch only; the stored-`analysisConfigId` branch is untouched).
- In the existing URL cleanup, also `searchParams.delete('provider')` and `delete('model')` so a refresh doesn't replay them.

## Tests

- **`tests/unit/provider-model.test.js`** — new cases for `buildProviderModelScopes` / `hasProviderModelOverride`: env override prepended ahead of repoSettings; `extraOverride` (URL) outranks env; provider-only override → provider's default model; no override → unchanged `[repo, app]` order.
- **`tests/unit/build-default-analysis-config.test.js`** — regression cases exercising the **real auto-analyze request shape** (provider/model default-filled from an env-aware `appConfig`, not explicitly chosen): `appConfig.provider_override` outranks `repoSettings.default_provider`; `urlOverride` outranks both; **council default is bypassed when an override is active** (forces single-provider); no override preserves current behavior (incl. council).
- **`tests/unit/resolve-default-provider-model.test.js`** or `config.test.js` — assert `/api/config` returns `provider_override`/`model_override` from the env (and `null` when unset). Save/restore env in `beforeEach`/`afterEach`.
- **`tests/unit/single-port.test.js`** — `buildDelegationUrl` appends `provider`/`model` (URL-encoded) only when `analyze` is true, for `pr` and `local`; `attemptDelegation` threads `flags.provider`/`flags.model` into the built URL.
- **`stack-analysis-provider-model.test.js`** stays as the per-file marker (backend already correct); no change required, but confirm still green.
- **E2E:** run via a Task subagent (Opus) per project rule for frontend changes — verify auto-analyze picks up the override under `single_port:false` and under delegation.

## Docs / changeset

- **README:** note that `--provider`/`--model` now also apply to interactive/browser auto-analysis (`--ai`), including the single-port delegation path; document the delegated + no-`--ai` limitation.
- **Changeset:** update `.changeset/add-provider-cli-flag.md` (feature is unreleased, added on this branch) to state the override now reaches browser-driven analyses (auto-analyze, stack, manual, bulk) and rides the single-port delegation URL.

## Verification

1. `pnpm test` — all unit tests green (new + existing).
2. Manual, non-delegated: `PAIR_REVIEW_NO_OPEN=1` + `single_port:false`, start server with `PAIR_REVIEW_PROVIDER=codex`, open a PR/local review with `?analyze=true` — confirm the POSTed analysis uses `codex` (check `/api/config` shows `provider_override:"codex"`, and network POST body `provider:"codex"`).
3. Manual, delegated: with a server already running, `pair-review <target> --ai --provider codex` — confirm the opened URL carries `?analyze=true&provider=codex`, auto-analyze uses codex, and the param is stripped after (refresh doesn't replay).
4. Council repo default + `--ai --provider codex` — confirm single-provider codex analysis runs (not the council).
5. E2E suite via subagent for the frontend paths.
