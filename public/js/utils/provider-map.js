// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Provider map: the frontend's shape for AI provider definitions.
 *
 * `GET /api/providers` returns `{ providers: [...] }` — an ARRAY of provider
 * objects. Every consumer that has to answer "what models does provider X
 * have?" wants an OBJECT keyed by provider id instead, so each of them used to
 * do the same array→object conversion inline. That conversion lives here.
 *
 * A "provider map" is therefore:
 *
 *   { claude: { id: 'claude', name: 'Claude', models: [...], ... }, ... }
 *
 * Consumers:
 *   - `AnalysisConfigModal` (`setProviders` on both council config tabs, model
 *     selection, availability badges),
 *   - the settings-page `CouncilManager` (same tabs, hosted outside the modal).
 *
 * Providers with no models are DROPPED, not kept-and-empty: an entry with an
 * empty `models` array is an unconfigured provider (e.g. OpenCode with no
 * models declared), and offering it in the UI would produce a selection that
 * cannot be submitted. Dropping it is the long-standing modal behavior and is
 * preserved verbatim here, console warning included.
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

const providerMapApi = { buildProviderMap };

if (typeof window !== 'undefined') {
  window.ProviderMap = { ...providerMapApi };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ...providerMapApi };
}
