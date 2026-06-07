# Address review feedback: matched provider/model pairs + bulk-config fixes

## Context

Code review of the `bulk-analysis-config-modal` branch surfaced one dominant bug
family plus several smaller issues.

**The dominant problem:** provider and model are resolved *independently*
everywhere, using `repo override → app default → hardcoded` *separately* for each
half:

```js
provider = repoSettings?.default_provider || appConfig.default_provider || 'claude';
model    = repoSettings?.default_model    || appConfig.default_model    || 'opus';
```

When a scope overrides only one half (e.g. a repo sets `default_provider: 'gemini'`
but no model, or app config has `default_provider: 'gemini'` + legacy
`default_model: 'opus'`), the halves come from different scopes and produce an
**invalid pair** like `gemini/opus`. Consequences:
- The modal shows no selected model card (`selectModel` stores the id anyway).
- Auto-analyze posts the broken pair straight to the backend → runtime failure.
- `/api/config` itself can publish a mismatched pair that seeds all of the above.

The remaining findings are independent: duplicated storage-key helpers, the bulk
modal leaking council state between runs, a missing-config error dead-end, and
three validation bugs in the bulk-analysis-config route.

Goal: address every review comment, fixing the matched-pair family **centrally**
rather than patching each call site.

## Hazards

- **`AnalysisConfigModal` is reused** (module-scoped in `index.js`,
  instance-scoped `this.analysisConfigModal` in `pr.js`/`local.js`). A central
  modal change affects bulk, stack, and manual analyze dialogs in all modes —
  verify all three.
- **`getRepoStorageKey` / `encodeBase64Utf8` are duplicated** in `index.js`
  (free functions ~138/145), `pr.js` (free fn line 14 + static method line 97).
  Keys are shared across pages (bulk page writes keys the PR page reads), so the
  extracted util must produce **byte-identical** base64.
- **`_buildDefaultAnalysisConfig` (`pr.js:596`)** is the non-modal path; it is
  also called from `local.js:83`. Both must get matched pairs.
- **Council route precedence** (`src/routes/pr.js:2276`, `local.js:2201`,
  `stack-analysis.js:561`): when both `councilId` and `councilConfig` are present,
  `councilId` wins and the DB record is re-fetched at analysis time — this is why
  the bulk route must drop `councilId` when it stores an inline snapshot.

## Changes

### Backend

**1. `src/routes/config.js` — `/api/config` matched pair (finding config.js:94)**
- `default_provider` stays `getDefaultProvider(config)`.
- `default_model`: only use an *explicitly configured* model
  (`getConfigValue(config, 'default_model', 'model')`). If none is set, derive the
  model from the selected provider's `defaultModel` via `getAllProvidersInfo()`
  (already imported). Fall back to `getDefaultModel(config)` only if the provider
  isn't found. Response shape unchanged.

**2. `src/routes/bulk-analysis-configs.js` — three fixes**
- *Preset chips dropped (line ~146):* in `sanitizeSingleConfig`, compute
  `const effective = config.instructions || config.customInstructions;`, validate
  `effective` with `validateCustomInstructions`, and store it as
  `customInstructions`. (`instructions` carries presets+textarea; `customInstructions`
  is textarea-only — downstream analysis only sends `customInstructions`.)
- *`configType` silent coercion (line ~156):* reject invalid values instead of
  coercing:
  ```js
  if (config.configType != null && !VALID_CONFIG_TYPES.has(config.configType)) {
    return { error: `configType must be one of ${[...VALID_CONFIG_TYPES].join(', ')}` };
  }
  const configType = config.configType || 'advanced';
  ```
- *`councilId` overrides snapshot (line ~191):* store
  `councilId: councilConfig ? undefined : (config.councilId || undefined)` so an
  inline snapshot is authoritative. Keep `councilName` for UI.

### Frontend — matched pair

**3. New `public/js/utils/provider-model.js`** exposing
`window.resolveProviderModelPair(scopes, providersInfo)`:
- `scopes`: ordered `[{provider, model}, ...]` (repo, then app).
- For the first scope with a provider known to `providersInfo`: keep its model
  only if it belongs to that provider; otherwise use the provider's `defaultModel`
  (then `models[0]`). A scope with a model but no provider resolves to whichever
  provider owns that model. Final fallback `{ provider: 'claude', model: null }`
  (null → let the provider's default stand).
- Load via `<script>` in `index.html`, `pr.html`, `local.html` (alongside other
  `js/utils/*`, before `index.js`/`pr.js`/`local.js`). Add the
  `if (typeof module !== 'undefined')` export tail for unit testing.

**4. `AnalysisConfigModal.js` — central guard (covers bulk/stack/manual dialogs)**
- `selectModel(modelId)` (line 627): if `this.models` is populated and `modelId`
  isn't in it, fall back to `models.find(m=>m.default) || models[0]` instead of
  storing the unknown id.
- `_initializeContent` (lines ~945): only `selectModel(options.currentModel)` when
  it exists in the now-selected provider's `this.models`; otherwise leave
  `selectProvider`'s tier-matched choice. This fixes finding index.js:2002 and the
  pr.js stack/manual dialog findings for every caller.

**5. `pr.js:_buildDefaultAnalysisConfig` (line 596) — non-modal path**
- Add a cached `_getProvidersInfo()` on `PRManager` (fetch `/api/providers`,
  cache like `_getAppConfig`).
- Replace the independent provider/model fallback (lines 626-627) with
  `window.resolveProviderModelPair([{provider: repoSettings?.default_provider, model: repoSettings?.default_model}, {provider: appConfig.default_provider, model: appConfig.default_model}], providersInfo)`.
  `local.js:83` reuses this method, so local auto-analyze is fixed automatically.

> The modal guard (#4) makes the stack (`pr.js:2797`), manual (`pr.js:6427`), and
> local (`local.js:315`) modal call sites robust without threading
> `providersInfo` into them; they keep passing repo/app values and the modal
> resolves the valid pair. This satisfies the local.js and pr.js modal findings
> centrally.

### Frontend — other findings

**6. Modal council-state leak between bulk runs (finding index.js:1987)**
- Add an explicit reset on the modal (e.g. `_resetTabsForOpen()`), called at the
  top of `_initializeContent`, that re-baselines council-tab state every open:
  always `setRepoInstructions(options.repoInstructions || '')`, always
  `setDefaultCouncilId(councilDefault || null)`, and clear any selected/pending
  council so a previous bulk run can't bleed into the next. Centralizing here also
  protects the reused `pr.js`/`local.js` instances. (Verify the
  `VoiceCentricConfigTab` / `AdvancedConfigTab` setters accept empty/null to clear.)

**7. Storage-key dedup (finding index.js:145)**
- New `public/js/utils/storage-keys.js` exposing byte-identical
  `window.encodeBase64Utf8` and `window.getRepoStorageKey`. Load in all three HTML
  pages. Replace the copies in `index.js` (free fns) and have
  `PRManager.getRepoStorageKey`/the `pr.js` free fn delegate to the globals.

**8. Missing-bulk-config dead-end (finding pr.js:691)**
- In the `requested && !config` branch of `_maybeAutoAnalyze`: **drop**
  `this.showError(message)`, keep the warning toast, and set
  `shouldCleanUrl = true` so `analyze`/`analysisConfigId` are stripped. The
  already-rendered PR diff stays usable; reword the message to "Could not load the
  selected bulk analysis settings. Start analysis manually to choose new settings."

## Tests (mandatory)

- **`tests/integration/bulk-analysis-configs.test.js`**: effective-instructions
  storage (presets preserved), `configType` rejection (400 on invalid),
  `councilId` dropped when inline `councilConfig` present.
- **`tests/integration/routes.test.js`** (or `config.test.js`): `/api/config`
  returns a matched pair when only one half is configured (e.g. provider override
  + legacy model).
- **New `tests/unit/provider-model.test.js`**: `resolveProviderModelPair` happy
  path, single-half scopes, model-without-provider, unknown provider, empty input.
- **New/extended modal test**: `selectModel` ignores unknown ids;
  `_initializeContent` keeps the valid pair given a mismatched `currentModel`.
- **`tests/unit/build-default-analysis-config.test.js`**: extend for matched-pair
  resolution (provider-only repo override no longer yields a foreign model).
- **New `tests/unit/storage-keys.test.js`**: parity between the util,
  `PRManager.getRepoStorageKey`, and `index.js` output.
- Update test DB schemas only if a schema changes (none expected here).
- Run E2E (`pnpm run test:e2e`) after frontend changes per project rules.

## Verification

1. `pnpm test` — unit + integration green.
2. `pnpm run test:e2e` — frontend flows (bulk analyze, manual analyze, local).
3. Manual smoke: configure a repo with provider-only override (`gemini`, no model)
   and confirm the modal shows a valid gemini model (not opus) in PR, local, and
   bulk flows; confirm auto-analyze (`?analyze=true`) starts without a backend
   model error; confirm an expired `analysisConfigId` leaves the PR usable with a
   toast (no Retry loop).

## Changeset

Add `.changeset/*.md` (`patch`, package `@in-the-loop-labs/pair-review`) — these
are user-facing bug fixes (invalid provider/model pairs, dropped preset
instructions, error dead-end).
