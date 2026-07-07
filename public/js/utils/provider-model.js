// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared provider/model pair resolver.
 *
 * Provider and model defaults are sourced from several scopes (repository
 * settings, then app config) and historically each half was resolved
 * independently with `repo || app || hardcoded`. When a scope overrides only
 * ONE half, the halves can come from different scopes and produce an invalid
 * pair such as `antigravity` + `opus` (an Anthropic model). The modal then shows no
 * selected model, and the non-modal auto-analyze path posts the broken pair
 * straight to the backend.
 *
 * This resolver treats each scope as a unit and never mixes a provider from one
 * scope with a model from another: it picks the first scope that names a known
 * provider, keeps that scope's model only if it belongs to the provider, and
 * otherwise derives the model from the provider's own default.
 */

/**
 * @param {Object} providerInfo - One entry from /api/providers
 * @param {string} modelId
 * @returns {boolean} Whether modelId is one of the provider's models, matched by
 *   canonical id OR any of its aliases. A persisted/configured value may name an
 *   alias (e.g. `opus`) rather than the canonical id; matching aliases keeps the
 *   user's choice instead of silently falling back to the provider default. The
 *   model cards carry their `aliases` in the /api/providers payload. Mirrors the
 *   backend `modelMatches()` helper in src/ai/provider.js.
 */
function _modelBelongsToProvider(providerInfo, modelId) {
  return !!(
    providerInfo &&
    Array.isArray(providerInfo.models) &&
    // Optional chaining: a model with no `aliases` short-circuits to undefined
    // (falsy) rather than throwing, so no Array.isArray guard is needed.
    providerInfo.models.some(m => m && (m.id === modelId || m.aliases?.includes(modelId)))
  );
}

/**
 * Resolve a coherent { provider, model } pair from ordered candidate scopes.
 *
 * @param {Array<{provider?: string, model?: string}>} scopes - Ordered by
 *   precedence (e.g. [repoSettings, appConfig]). Entries, and either half, may
 *   be null/undefined.
 * @param {Array<Object>} providersInfo - The `providers` array from
 *   /api/providers (each `{ id, models: [{id, ...}], defaultModel }`). May be
 *   empty if the fetch failed.
 * @returns {{provider: string, model: (string|null)}} A matched pair. `model`
 *   is null only when no provider metadata is available to derive one.
 */
function resolveProviderModelPair(scopes, providersInfo) {
  const providers = Array.isArray(providersInfo) ? providersInfo : [];
  const findProvider = (id) => providers.find(p => p && p.id === id);
  const providerDefaultModel = (info) =>
    (info && (info.defaultModel || (Array.isArray(info.models) && info.models[0] && info.models[0].id))) || null;

  for (const scope of (Array.isArray(scopes) ? scopes : [])) {
    if (!scope) continue;
    const provId = scope.provider || null;
    const modelId = scope.model || null;

    if (provId) {
      const info = findProvider(provId);
      if (info) {
        if (modelId && _modelBelongsToProvider(info, modelId)) {
          return { provider: provId, model: modelId };
        }
        return { provider: provId, model: providerDefaultModel(info) };
      }
      // Provider not in metadata (custom/unavailable): can't validate, pass
      // through this scope's own halves rather than mixing in another scope's.
      return { provider: provId, model: modelId };
    }

    if (modelId) {
      // Scope names a model but no provider — attribute it to whichever
      // provider owns it. If none owns it, fall through to the next scope.
      const owner = providers.find(p => _modelBelongsToProvider(p, modelId));
      if (owner) return { provider: owner.id, model: modelId };
    }
  }

  // Nothing resolved: fall back to claude, deriving its default model from
  // metadata when available (else null → let the backend/provider decide).
  const claude = findProvider('claude');
  return { provider: 'claude', model: providerDefaultModel(claude) };
}

/**
 * Build the ordered scope list for resolveProviderModelPair, injecting the
 * CLI/env override AHEAD of saved repo settings.
 *
 * The override must outrank repo settings to honor the documented
 * `CLI/env > repo settings` contract. Folding the override into appConfig's
 * default_provider/default_model alone is NOT enough: every seed site passes
 * repoSettings first, so an env-aware appConfig would still lose to a repo's
 * saved default. Prepending the override scope is the only correct fix.
 *
 * Two override channels, highest precedence first:
 *   1. `extraOverride` — a per-invocation override carried on the auto-analyze
 *      URL (single-port delegation: the flag can only reach the already-running
 *      server through the URL).
 *   2. `appConfig.provider_override` / `appConfig.model_override` — the per-run
 *      `--provider` / `--model` override surfaced by /api/config, for the
 *      process that actually received the CLI flag.
 *
 * A provider-only override (`{ provider: 'codex', model: null }`) resolves via
 * resolveProviderModelPair to codex + codex's own default model, matching CLI
 * semantics where `--provider codex` alone pins the provider.
 *
 * @param {Object} repoSettings - saved repo settings row (may be null)
 * @param {Object} [appConfig] - /api/config response (or __pairReview-shaped equivalent)
 * @param {{provider?: string, model?: string}} [extraOverride] - per-invocation override (URL params)
 * @returns {Array<{provider?: string, model?: string}>} ordered scopes for resolveProviderModelPair
 */
function buildProviderModelScopes(repoSettings, appConfig = {}, extraOverride = null) {
  const cfg = appConfig || {};
  const scopes = [];
  // 1. Per-invocation override (delegation URL params) — highest precedence.
  if (extraOverride && (extraOverride.provider || extraOverride.model)) {
    scopes.push({ provider: extraOverride.provider || null, model: extraOverride.model || null });
  }
  // 2. CLI/env override surfaced by /api/config (non-delegated invocations).
  if (cfg.provider_override || cfg.model_override) {
    scopes.push({ provider: cfg.provider_override || null, model: cfg.model_override || null });
  }
  // 3. Saved repo settings.
  scopes.push({ provider: repoSettings?.default_provider, model: repoSettings?.default_model });
  // 4. App/config defaults.
  scopes.push({ provider: cfg.default_provider, model: cfg.default_model });
  return scopes;
}

/**
 * Whether a CLI/env provider-or-model override is active (from either channel).
 * Used to decide whether auto-analyze should bypass a council default and force
 * the single-provider path (a single-provider override is incompatible with a
 * multi-voice council).
 *
 * @param {Object} [appConfig] - /api/config response (or __pairReview-shaped equivalent)
 * @param {{provider?: string, model?: string}} [extraOverride] - per-invocation override (URL params)
 * @returns {boolean}
 */
function hasProviderModelOverride(appConfig = {}, extraOverride = null) {
  const cfg = appConfig || {};
  return !!(
    (extraOverride && (extraOverride.provider || extraOverride.model)) ||
    cfg.provider_override || cfg.model_override
  );
}

if (typeof window !== 'undefined') {
  window.resolveProviderModelPair = resolveProviderModelPair;
  window.buildProviderModelScopes = buildProviderModelScopes;
  window.hasProviderModelOverride = hasProviderModelOverride;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveProviderModelPair, buildProviderModelScopes, hasProviderModelOverride };
}
