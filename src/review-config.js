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
 * (`council.type || 'advanced'` + `normalizeCouncilConfig`).
 */

const { RepoSettingsRepository, CouncilRepository } = require('./database');
const { resolveCouncilHandle } = require('./councils/resolve-council');
const { normalizeCouncilConfig, validateCouncilConfig } = require('./routes/councils');
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
  const councilConfig = normalizeCouncilConfig(council.config, configType);
  // validateCouncilConfig returns an error string, or null when valid.
  const validationError = validateCouncilConfig(councilConfig, configType);
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
 *   model:    explicit › repo default › global in-app override › config.default_model    › config.model    › 'opus'
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
 * versa).
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
  const model = explicit.model
    || repoSettings?.default_model
    || overrides.default_model
    || cfg.default_model
    || cfg.model
    || 'opus';
  return { type: 'single', provider, model };
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
 *   4. `repo_settings.default_provider` / `default_model` — single selection
 *      (see `_buildSingleSelection`).
 *   5. Global in-app override (`config._globalOverrides`) › global `config`
 *      defaults — single selection (final hardcoded fallbacks 'claude' / 'opus').
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

  // 4 & 5. Single selection from repo defaults, then global config, then hardcoded.
  return _buildSingleSelection({}, repoSettings, config);
}

/**
 * Resolve a single provider/model pair from the canonical per-field precedence
 * ladders, WITHOUT any council dispatch.
 *
 * This is the same ladder `resolveReviewConfig` applies for the single-selection
 * case (explicit › repo default › global in-app override › config-file › legacy
 * keys › hardcoded). It is exported for callers that intentionally run a single
 * provider/model only and must NOT consult a repo's default council — the MCP
 * `start_analysis` tool (src/routes/mcp.js) documents this divergence. Those
 * callers reuse this helper so they inherit the in-app-override tier instead of
 * maintaining a parallel inline ladder.
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
