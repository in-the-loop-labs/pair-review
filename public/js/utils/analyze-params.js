// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared "auto-analyze intent" URL-param relay.
 *
 * The params `analyze`, `analysisConfigId`, `council`, `provider`, and `model`
 * form a single bundle that must travel TOGETHER through every browser hop
 * between the single-port delegation URL and the review page that consumes them:
 *
 *   delegation URL → setup.html redirect(s) → review page auto-analyze
 *   review page → "Reload PR" retry → setup.html → review page auto-analyze
 *
 * Each hop used to cherry-pick fields by name, so any hop that forgot one
 * silently dropped it — which is exactly how a delegated `--provider` override
 * got lost on its way to the running server (and how a `--council` selection
 * would drop on the "Reload PR" retry). Centralizing the bundle here means
 * adding a new intent param later is a one-line edit in ONE place instead of a
 * fresh bug at every call site.
 *
 * Note: setup-internal params (e.g. `path`, consumed by the local-mode setup
 * POST) are deliberately NOT in the bundle, so they never leak onto the review
 * page URL.
 */
const ANALYZE_PARAM_KEYS = ['analyze', 'analysisConfigId', 'council', 'provider', 'model'];

/**
 * Copy the auto-analyze intent bundle from a source query onto a target URL.
 * Only non-empty values present in the source are copied; other params already
 * on `toUrl` are left untouched.
 *
 * @param {URLSearchParams|string} fromSearch - source query (e.g. window.location.search)
 * @param {URL} toUrl - destination URL object, mutated in place
 * @returns {URL} the same `toUrl`, for chaining
 */
function carryAnalyzeParams(fromSearch, toUrl) {
  if (!toUrl) return toUrl;
  const src = typeof fromSearch === 'string' ? new URLSearchParams(fromSearch) : fromSearch;
  if (!src || typeof src.get !== 'function') return toUrl;
  for (const key of ANALYZE_PARAM_KEYS) {
    const value = src.get(key);
    if (value !== null && value !== '') {
      toUrl.searchParams.set(key, value);
    }
  }
  return toUrl;
}

/**
 * Delete the auto-analyze intent bundle from a URL. Used by the consumer after
 * it acts on the intent, so a manual page refresh does not replay it.
 *
 * @param {URL} url - URL object, mutated in place
 * @returns {URL} the same `url`, for chaining
 */
function stripAnalyzeParams(url) {
  if (!url) return url;
  for (const key of ANALYZE_PARAM_KEYS) {
    url.searchParams.delete(key);
  }
  return url;
}

if (typeof window !== 'undefined') {
  window.carryAnalyzeParams = carryAnalyzeParams;
  window.stripAnalyzeParams = stripAnalyzeParams;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { carryAnalyzeParams, stripAnalyzeParams, ANALYZE_PARAM_KEYS };
}
