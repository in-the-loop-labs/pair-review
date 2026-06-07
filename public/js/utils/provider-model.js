// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared provider/model pair resolver.
 *
 * Provider and model defaults are sourced from several scopes (repository
 * settings, then app config) and historically each half was resolved
 * independently with `repo || app || hardcoded`. When a scope overrides only
 * ONE half, the halves can come from different scopes and produce an invalid
 * pair such as `gemini` + `opus` (an Anthropic model). The modal then shows no
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
 * @returns {boolean} Whether modelId is one of the provider's models
 */
function _modelBelongsToProvider(providerInfo, modelId) {
  return !!(
    providerInfo &&
    Array.isArray(providerInfo.models) &&
    providerInfo.models.some(m => m && m.id === modelId)
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

if (typeof window !== 'undefined') {
  window.resolveProviderModelPair = resolveProviderModelPair;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveProviderModelPair };
}
