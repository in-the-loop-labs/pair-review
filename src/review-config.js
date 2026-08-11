// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Repo-default review-configuration resolver.
 *
 * A single helper that decides whether a review run should use a council or a
 * single provider/model, honoring (in order of precedence): explicit CLI/request
 * picks, the repo's saved defaults (`repo_settings.default_council_id` /
 * `default_provider` / `default_model`), and finally the global config defaults.
 *
 * Both the headless CLI path and the interactive web analyze routes use this so
 * that a repo's `default_council_id` — previously stored but never consulted —
 * is honored consistently everywhere.
 *
 * The council-selection object returned here is intentionally drop-in compatible
 * with what `runHeadlessCouncilAnalysis` (src/councils/headless-council.js) and
 * the existing `performHeadlessReview` council path (src/main.js) consume:
 *   `{ council, configType, councilConfig }`.
 * The derivation of `configType`/`councilConfig` mirrors that code exactly
 * (`council.type || 'advanced'` + `normalizeAndValidateCouncilConfig`).
 */

const { RepoSettingsRepository, CouncilRepository } = require('./database');
const { resolveCouncilHandle } = require('./councils/resolve-council');
const { normalizeAndValidateCouncilConfig } = require('./councils/council-validation');
// Require the ./ai index (not ./ai/provider) so the provider registry is
// populated by the provider files' self-registration before lookups here.
const {
  getProviderClass,
  getProviderConfigOverrides,
  applyModelOverrides,
  resolveDefaultModel
} = require('./ai');
const logger = require('./utils/logger');

/**
 * Derive the `{ council, configType, councilConfig }` selection object from a
 * resolved council row, applying the same normalization + validation as the
 * existing headless council path (`performHeadlessReview`, src/main.js).
 *
 * @param {Object} council - Full council row (parsed config), as returned by
 *   `resolveCouncilHandle` or `CouncilRepository.getById`.
 * @returns {{ council: Object, configType: string, councilConfig: Object }}
 * @throws {Error} If the council's config is invalid for its type.
 * @private
 */
function _buildCouncilSelection(council) {
  const configType = council.type || 'advanced';
  // Normalizes, then validates the normalized config; `error` is a string, or
  // null when valid.
  const { config: councilConfig, error: validationError } =
    normalizeAndValidateCouncilConfig(council.config, configType);
  if (validationError) {
    throw new Error(`Invalid council "${council.name}": ${validationError}`);
  }
  return { council, configType, councilConfig };
}

/**
 * Resolve the single-provider/model pair from the per-field precedence ladders.
 *
 * Precedence (highest first), per the global-settings design ("specificity
 * first, then in-app > files"):
 *   provider: explicit › repo default › global in-app override › config.default_provider › config.provider › 'claude'
 *   model:    explicit › repo default › global in-app override › config.default_model › provider's own default › 'opus'
 *
 * The global in-app override (from the /settings page, carried on
 * `config._globalOverrides`) sits ABOVE the config files but BELOW the repo
 * default. The effective config also folds the override into
 * `config.default_provider`; reading it from `_globalOverrides` here lets us
 * rank it above the config-file value explicitly.
 *
 * `explicit` carries the per-run `--provider`/`--model` CLI flags (there is no
 * env-var side channel). `--ai-draft`/`--ai-review` and the interactive analyze
 * routes thread the flags in as `explicit`, so per-run intent stays supreme.
 *
 * When `default_provider`/`default_model` is locked as final by configuration,
 * the effective config already excludes the key from `_globalOverrides` and
 * folds its config-file value into `cfg.default_*`, so the value resolves from
 * the config file (or the hardcoded fallback) here without any special-casing.
 * A repo-scoped default and an explicit per-run flag are more specific and
 * still win.
 *
 * The interactive web "Analyze" route keeps its own single ladder in
 * `src/routes/{pr,local}.js` (`resolveProviderModel`, which ranks the CLI-flag
 * override above repo settings); it consults this resolver only to detect
 * council mode, not to pick the model.
 *
 * Each field falls through independently, so supplying only `explicit.model`
 * still resolves the provider from repo/override/config defaults (and vice
 * versa) — BUT a tier's `default_model` is *intended* to pair with that
 * tier's `default_provider`, so a tier's model is only consulted when its
 * provider agrees with the resolved provider. Without that guard, a
 * provider-only pick (`--provider omp`) walks the model ladder down to the
 * global default and hands OMP a foreign model id like 'opus' instead of the
 * provider's own default mode. A tier that names no provider is treated as
 * provider-agnostic and still applies (e.g. a model-only in-app override).
 * Note `cfg` is the FLATTENED effective config, not a single layer:
 * loadConfig() merges DEFAULT_CONFIG and the config files, then
 * buildEffectiveConfig() dot-path-writes in-app overrides into the same flat
 * object, so `cfg.default_provider` and `cfg.default_model` may come from
 * different layers — see the `cfgPairSuspect` guard below for the case where
 * that incoherence is provable. When no compatible tier supplies a model,
 * the provider's own default is used (mirroring what the settings UI derives
 * via `models.find(m => m.default)`), with the global model as the last
 * resort for providers with no built-in default (e.g. OpenCode).
 *
 * @param {Object} explicit - { provider, model } (either may be undefined)
 * @param {Object|null} repoSettings - Row from RepoSettingsRepository.getRepoSettings
 * @param {Object} config - Global config object (may carry `_globalOverrides`)
 * @returns {{ type: 'single', provider: string, model: string }}
 * @private
 */
function _buildSingleSelection(explicit, repoSettings, config) {
  const cfg = config || {};
  const overrides = cfg._globalOverrides || {};
  const provider = explicit.provider
    || repoSettings?.default_provider
    || overrides.default_provider
    || cfg.default_provider
    || cfg.provider
    || 'claude';

  // A tier's model applies only when that tier's provider matches the
  // resolved provider (or the tier names no provider at all).
  const tierModel = (tierProvider, model) =>
    ((!tierProvider || tierProvider === provider) ? model : null);

  // A provider-only in-app override proves the flattened `cfg` pair is
  // incoherent: buildEffectiveConfig() wrote the new provider into `cfg` via
  // setPath() but left the config-file/default model beneath it. In that
  // case `cfg`'s provider matches the resolved provider by construction, so
  // the tier guard cannot catch the mismatch — skip the `cfg` tier entirely
  // and let the provider's own default supply the model. (A config FILE that
  // sets only default_provider over DEFAULT_CONFIG's model has the same
  // incoherence but is not detectable here; tracked separately.)
  const cfgPairSuspect = Boolean(overrides.default_provider && !overrides.default_model);

  // An explicit --model passes through verbatim: Pi/OMP fuzzy-match arbitrary
  // ids ('opus', 'gpt-5.2') that are deliberately not in their model list, so
  // it must never be second-guessed against the provider's models. The
  // hardcoded 'claude'/'opus' pair sits BELOW the override-aware provider
  // default as a last-resort rescue (e.g. no provider class registered for
  // 'claude'), so a configured `providers.claude.default_model` or a
  // disabled 'opus' is honored on the provider-default rung first.
  const model = explicit.model
    || tierModel(repoSettings?.default_provider, repoSettings?.default_model)
    || tierModel(overrides.default_provider, overrides.default_model)
    || (cfgPairSuspect ? null : tierModel(cfg.default_provider || cfg.provider, cfg.default_model || cfg.model))
    || _resolveProviderDefaultModel(provider)
    || tierModel('claude', 'opus')
    || cfg.default_model
    || cfg.model
    || 'opus';
  return { type: 'single', provider, model };
}

/**
 * Resolve a provider's own default model, honoring config overrides
 * (`providers.<id>.models` / `default_model` / `disabled_models`) exactly the
 * way `createProvider` does when handed a null model — so a provider-only
 * selection lands on the same model the settings UI shows as that provider's
 * default. Returns null for unknown providers and for providers with no
 * default (e.g. OpenCode), letting the caller fall back to the global model.
 *
 * @param {string} providerId - Provider ID
 * @returns {string|null} Default model id, or null
 * @private
 */
function _resolveProviderDefaultModel(providerId) {
  const ProviderClass = getProviderClass(providerId);
  if (!ProviderClass) return null;
  try {
    const overrides = getProviderConfigOverrides(providerId);
    const effectiveModels = applyModelOverrides(ProviderClass.getModels(), overrides);
    return resolveDefaultModel(effectiveModels, overrides?.default_model)
      || ProviderClass.getDefaultModel();
  } catch (error) {
    logger.warn(`Could not resolve default model for provider "${providerId}": ${error.message}`);
    return null;
  }
}

/**
 * Resolve the review configuration (council vs single provider/model) for a run.
 *
 * Precedence (highest first):
 *   1. `explicit.council` — a `--council` handle (id / id-prefix / name). Resolved
 *      via `resolveCouncilHandle`. A bad handle throws (fail-fast for CLI/UI).
 *   2. `explicit.provider` / `explicit.model` — an explicit single-model pick
 *      (e.g. `--model`). Returns a single selection; any missing field falls
 *      through to env/repo/config defaults.
 *   3. `repo_settings.default_council_id` — looked up directly by id via
 *      `CouncilRepository.getById` (we already hold the UUID, so no handle
 *      matching is needed). If the id points to a council that no longer exists,
 *      a warning is logged and resolution falls through to the single default.
 *   4. Global default council — `config._globalOverrides.default_council_id`
 *      (an in-app /settings override) or a config-file `default_council_id`.
 *      Resolved by id like the repo tier; a stale id logs a warning and falls
 *      through. Sits ABOVE the single ladder, so it also outranks a repo's
 *      single provider/model default.
 *   5. `repo_settings.default_provider` / `default_model`, then global in-app
 *      override (`config._globalOverrides`) › global `config` defaults — single
 *      selection. The final fallback provider is 'claude' with that provider's
 *      own default model; 'opus' remains the hardcoded last-resort model floor.
 *
 * @param {Object} db - Database instance.
 * @param {string} repository - Repository in `owner/repo` form (may be null/undefined
 *   for repos with no saved settings; treated as "no repo defaults").
 * @param {Object} [explicit] - Explicit picks: `{ council, provider, model }`.
 *   `council` is a CLI handle string (id-prefix/name) or a pre-resolved id.
 *   Any field may be undefined.
 * @param {Object} [config] - Global config object (default provider/model, etc.).
 * @returns {Promise<{ type: 'council', council: Object, configType: string, councilConfig: Object }
 *   | { type: 'single', provider: string, model: string }>}
 * @throws {Error} If `explicit.council` cannot be resolved or its config is invalid.
 */
async function resolveReviewConfig(db, repository, explicit = {}, config = {}) {
  const { council: explicitCouncil, provider: explicitProvider, model: explicitModel } = explicit || {};

  // 1. Explicit --council handle wins over everything.
  if (explicitCouncil) {
    const council = await resolveCouncilHandle(db, explicitCouncil);
    return { type: 'council', ..._buildCouncilSelection(council) };
  }

  // 2. Explicit single-model pick (--provider / --model). Returns single; any
  //    missing field still resolves from repo/config defaults via the ladder.
  if (explicitProvider || explicitModel) {
    const repoSettings = repository
      ? await new RepoSettingsRepository(db).getRepoSettings(repository)
      : null;
    return _buildSingleSelection({ provider: explicitProvider, model: explicitModel }, repoSettings, config);
  }

  // No explicit pick — consult the repo's saved defaults.
  const cfg = config || {};
  const repoSettings = repository
    ? await new RepoSettingsRepository(db).getRepoSettings(repository)
    : null;

  // 3. Repo default council (resolve directly by id — we already hold the UUID).
  if (repoSettings?.default_council_id) {
    const council = await new CouncilRepository(db).getById(repoSettings.default_council_id);
    if (council) {
      return { type: 'council', ..._buildCouncilSelection(council) };
    }
    // The configured default council no longer exists. Don't fail the run —
    // fall through to the single-provider default so analysis still proceeds.
    logger.warn(
      `Repo default council "${repoSettings.default_council_id}" for ${repository} ` +
      `was not found; falling back to default provider/model.`
    );
  }

  // 4. Global default council (from the /settings page, carried on
  //    `config._globalOverrides.default_council_id`, or a config-file
  //    `default_council_id`). Mirrors the repo-council tier but sits below it:
  //    a repo's own council still wins, while a global council outranks the
  //    single provider/model ladder — INCLUDING a repo's single default — so a
  //    global council is the default analysis mode wherever a repo hasn't
  //    chosen its own council. NOTE: single-model resolvers
  //    (`resolveSingleProviderModel`, used by MCP `start_analysis`, hunk
  //    summaries, and tours) intentionally never reach this tier, so a global
  //    default council does not fire on those paths — consistent with repo
  //    default councils.
  const globalCouncilId = (cfg._globalOverrides && cfg._globalOverrides.default_council_id)
    || cfg.default_council_id;
  if (globalCouncilId) {
    const council = await new CouncilRepository(db).getById(globalCouncilId);
    if (council) {
      return { type: 'council', ..._buildCouncilSelection(council) };
    }
    // Stale global council id (the council was deleted). Match the repo-council
    // behavior: warn and fall through to the single-provider default.
    logger.warn(
      `Global default council "${globalCouncilId}" was not found; ` +
      `falling back to default provider/model.`
    );
  }

  // 5. Single selection from repo defaults, then global config, then hardcoded.
  return _buildSingleSelection({}, repoSettings, cfg);
}

/**
 * Resolve a single provider/model pair from the canonical per-field precedence
 * ladders, WITHOUT any council dispatch.
 *
 * This is the same ladder `resolveReviewConfig` applies for the single-selection
 * case (explicit › repo default › global in-app override › config-file › legacy
 * keys › hardcoded). It is exported for callers that intentionally run a single
 * provider/model only and must NOT consult a council — the MCP `start_analysis`
 * tool (src/routes/mcp.js) documents this divergence. This deliberately bypasses
 * BOTH the repo default council AND the global default council
 * (`config.default_council_id`): a global default council never fires on these
 * single-model paths (hunk summaries, tours, MCP start_analysis), by design.
 * Those callers reuse this helper so they inherit the in-app-override tier
 * instead of maintaining a parallel inline ladder.
 *
 * @param {Object} [explicit] - { provider, model } (either may be undefined)
 * @param {Object|null} [repoSettings] - Row from RepoSettingsRepository.getRepoSettings
 * @param {Object} [config] - Global config object (may carry `_globalOverrides`)
 * @returns {{ type: 'single', provider: string, model: string }}
 */
function resolveSingleProviderModel(explicit = {}, repoSettings = null, config = {}) {
  return _buildSingleSelection(explicit, repoSettings, config);
}

module.exports = { resolveReviewConfig, resolveSingleProviderModel };
