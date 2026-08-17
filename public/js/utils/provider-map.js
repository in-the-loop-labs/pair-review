// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Provider map: the frontend's shape for AI provider definitions.
 *
 * `GET /api/providers` returns `{ providers: [...] }` — an ARRAY of provider
 * objects. Every consumer that has to answer "what models does provider X
 * have?" wants an OBJECT keyed by provider id instead, so each of them used to
 * do the same array→object conversion inline. That conversion lives here, and
 * this module is the ONLY place it should happen.
 *
 * A "provider map" is therefore:
 *
 *   { claude: { id: 'claude', name: 'Claude', models: [...], ... }, ... }
 *
 * Beyond the conversion this module owns the two questions every consumer asks
 * OF a provider map — "which model definition does this id mean?"
 * (`findModelWithAliases`) and "what do I show a human for this pair?"
 * (`resolveModelDisplay`) — plus the one the council config tabs ask before
 * seeding a new council: "which provider/model can this UI actually render?"
 * (`resolveDefaultOrchestration`). Each existed as near-copies across the four
 * consumers below, and the copies had already drifted apart on alias handling.
 *
 * Consumers, by export:
 *   - `buildProviderMap`: `AnalysisConfigModal.loadProviders` (feeding
 *     `setProviders` on both council config tabs, model selection, availability
 *     badges), the settings-page `CouncilManager` (same tabs, hosted outside the
 *     modal), and `RepoSettings.loadProviders`.
 *   - `findModelWithAliases`: `repo-settings.js` (model card + provider-switch
 *     model carry-over), and `resolveModelDisplay` /
 *     `resolveDefaultOrchestration` internally.
 *   - `resolveModelDisplay`: `settings.js` and `repo-settings.js` (both feed it
 *     to `CouncilCard`), and `CouncilManager`.
 *   - `resolveDefaultOrchestration`: `VoiceCentricConfigTab` and
 *     `AdvancedConfigTab`, from `setDefaultOrchestration`.
 *
 * Callers hold their providers in whichever shape suits them — `settings.js`
 * keeps the raw array, `repo-settings.js` and the tabs a map, `CouncilManager`
 * both — so the two resolvers accept EITHER (see `asProviderMap`).
 *
 * Providers with no models are DROPPED by `buildProviderMap`, not
 * kept-and-empty: an entry with an empty `models` array is an unconfigured
 * provider (e.g. OpenCode with no models declared), and offering it in the UI
 * would produce a selection that cannot be submitted. Dropping it is the
 * long-standing modal behavior and is preserved verbatim here, console warning
 * included.
 *
 * That dropping is exactly why `resolveModelDisplay` does NOT normalize an
 * array through `buildProviderMap` — do not "simplify" it into doing so. A
 * council voice stored against a provider that has since lost its models must
 * still render that provider's NAME; running it through `buildProviderMap`
 * would drop the entry, fall through to the unknown-provider branch, print the
 * raw id, and emit a spurious console warning on every render. Resolving a name
 * for display is not offering a choice.
 *
 * Loaded in the browser as `window.ProviderMap`; also exported via CommonJS for
 * unit tests. Pure logic — no DOM access at load time.
 */

/**
 * Convert the `/api/providers` array into a map keyed by provider id.
 *
 * Providers whose `models` is missing or empty are omitted (with a console
 * warning naming the provider), because the UI cannot offer a model for them.
 * Duplicate ids resolve last-wins, matching plain object assignment.
 *
 * A non-array argument yields `{}` rather than throwing: callers hand this
 * whatever a fetch produced, and an empty map degrades to "no providers" while
 * a throw would take out the caller. (The modal keeps its own explicit
 * malformed-payload check so its hardcoded fallback still fires.)
 *
 * @param {Array<Object>} providerList - Providers as returned by GET /api/providers
 * @returns {Object<string, Object>} Provider map keyed by provider id
 */
function buildProviderMap(providerList) {
  const providers = {};
  if (!Array.isArray(providerList)) return providers;

  for (const provider of providerList) {
    if (provider.models && provider.models.length > 0) {
      providers[provider.id] = provider;
    } else {
      console.warn(`Provider "${provider.name}" has no models configured and will not be available`);
    }
  }

  return providers;
}

/**
 * Accept EITHER shape callers hold and answer with a map keyed by provider id.
 *
 * `settings.js` keeps the raw `/api/providers` ARRAY, `repo-settings.js` and the
 * config tabs keep a MAP, and `CouncilManager` keeps both. Rather than make
 * every caller convert, the display helpers below take whichever they have.
 *
 * Deliberately NOT `buildProviderMap`: that one DROPS providers with no models
 * (they cannot be offered in a picker) and warns about each. Resolving a name
 * for display is not offering a choice — a stored voice naming a provider that
 * has since lost its models should still print that provider's name.
 *
 * @param {Array<Object>|Object<string, Object>} providers - Provider array or map
 * @returns {Object<string, Object>} Provider map keyed by provider id
 */
function asProviderMap(providers) {
  if (Array.isArray(providers)) {
    const map = {};
    for (const provider of providers) {
      if (provider && provider.id != null) map[provider.id] = provider;
    }
    return map;
  }
  return providers && typeof providers === 'object' ? providers : {};
}

/**
 * Look up a model by ID within a provider, matching both canonical `id` and
 * `aliases`. Historical settings and saved councils may still reference legacy
 * model IDs (e.g. `gpt-5.4` before reasoning-effort variants were introduced),
 * and `resolveProviderModelPair` deliberately PRESERVES a configured alias
 * (`--model opus`); those must still resolve to the canonical model so the UI
 * shows the correct selection instead of silently falling back to a default —
 * or, in a `<select>` whose options are canonical ids only, to nothing at all.
 *
 * @param {Object} provider - Provider object with a `models` array
 * @param {string} modelId - Model ID to look up (may be an alias)
 * @returns {Object|undefined} Matching model definition, or undefined if not found
 */
function findModelWithAliases(provider, modelId) {
  if (!provider || !provider.models || !modelId) return undefined;
  return provider.models.find(m => m.id === modelId || m.aliases?.includes(modelId));
}

/**
 * Resolve provider/model ids to the names a human should see, falling back to
 * the raw ids (then to 'Unknown') whenever the metadata cannot answer.
 *
 * Alias-aware via `findModelWithAliases`, and tolerant of a `models` entry that
 * is a bare id string rather than an object — both shapes occur in the wild and
 * the three call sites this replaces each handled only one of them.
 *
 * @param {Array<Object>|Object<string, Object>} providers - Provider array or map
 * @param {string} providerId
 * @param {string} modelId
 * @returns {{ providerName: string, modelName: string }}
 */
function resolveModelDisplay(providers, providerId, modelId) {
  const provider = providerId == null ? undefined : asProviderMap(providers)[providerId];
  if (!provider) {
    return { providerName: providerId || 'Unknown', modelName: modelId || 'Unknown' };
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  const model = findModelWithAliases(provider, modelId)
    || models.find(m => m && (m.id != null ? m.id : m) === modelId);
  return {
    providerName: provider.name || provider.id || providerId,
    modelName: model ? (model.name || model.id || modelId) : (modelId || 'Unknown')
  };
}

/**
 * Whether a provider entry has been positively reported as unavailable.
 * Availability arrives asynchronously, so an absent `availability` block means
 * "not known yet", which must NOT hide the provider.
 */
function isUnavailable(provider) {
  return !!(provider && provider.availability && provider.availability.available === false);
}

/** The model id a provider's own `<select>` would land on with nothing chosen. */
function defaultModelId(provider) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  const declared = findModelWithAliases(provider, provider.defaultModel);
  const model = declared || models.find(m => m && m.default) || models[0];
  return model ? (model.id != null ? model.id : model) : null;
}

/**
 * Reduce a desired provider/model pair to one the council config tabs can
 * actually RENDER, given the provider map they were handed.
 *
 * The tabs seed a new council from this pair by assigning it straight onto two
 * `<select>` elements. Anything the selects cannot offer silently selects
 * nothing, `_readConfigFromUI` drops the reviewer row (`if (provider && model)`)
 * and the save POSTs `voices: []`, which the server rejects with
 * 'config.voices must be a non-empty array'. Two independent doors lead there:
 *
 *   - MODEL: `resolveProviderModelPair` deliberately preserves a configured
 *     alias, and the model options carry canonical ids only, so `opus`
 *     (reachable via `pair-review <pr> --model opus`, or a stored
 *     `default_model`) matches no option.
 *   - PROVIDER: the pair is resolved against the raw `/api/providers` array,
 *     while the tabs render `buildProviderMap` output minus unavailable
 *     providers — so a provider with no models, or one reported unavailable,
 *     has no option either.
 *
 * `{ provider: null, model: null }` is NOT a safe answer for the caller to fall
 * back to: the tabs' hardcoded seed is claude/sonnet, which fails identically
 * when claude is the provider that went missing. When nothing can be resolved
 * this returns the inputs unchanged and lets the caller keep its own seed.
 *
 * @param {Object<string, Object>|Array<Object>} providers - The tab's provider map
 * @param {string|null} providerId - Desired provider id (may be unavailable/unknown)
 * @param {string|null} modelId - Desired model id (may be an alias)
 * @returns {{ provider: string|null, model: string|null }} A renderable pair, or
 *   the inputs unchanged when there is no provider metadata to resolve against.
 */
function resolveDefaultOrchestration(providers, providerId, modelId) {
  const map = asProviderMap(providers);
  const ids = Object.keys(map);
  if (ids.length === 0) return { provider: providerId || null, model: modelId || null };

  // Prefer the providers the tab would actually list; if availability has ruled
  // every one of them out, fall back to the full map rather than to nothing.
  const renderable = ids.filter(id => !isUnavailable(map[id]));
  const eligible = renderable.length > 0 ? renderable : ids;

  const provider = eligible.includes(providerId) ? providerId : eligible[0];
  const entry = map[provider];

  // Only honour the requested model when the provider survived: a model id from
  // provider A means nothing under provider B.
  const wanted = provider === providerId ? modelId : null;
  const match = findModelWithAliases(entry, wanted);
  const model = (match ? match.id : null) || defaultModelId(entry) || modelId || null;

  return { provider, model };
}

const providerMapApi = {
  buildProviderMap,
  findModelWithAliases,
  resolveModelDisplay,
  resolveDefaultOrchestration
};

if (typeof window !== 'undefined') {
  window.ProviderMap = { ...providerMapApi };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ...providerMapApi };
}
