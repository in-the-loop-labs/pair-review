// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared per-PR host resolution helpers for dual (github.com + alt-host) repos.
 *
 * A single source of truth for the "legacy NULL" back-compat convention that
 * translates a stored `pr_metadata.host` value into the `options` argument for
 * `resolveHostBinding`. Multiple entry points need this exact mapping
 * (PR-mode routes, PR setup, external-comment sync, stack analysis); keeping it
 * here stops the copies from drifting.
 */

const { getRepoConfig, isExclusiveAltHost, resolveHostBinding } = require('../config');

/**
 * Translate a stored `pr_metadata.host` value into the `options` object for
 * `resolveHostBinding`, applying the legacy-NULL back-compat convention:
 *
 *   - `undefined` (no pr_metadata row) → `undefined` (ambiguity rule; caller
 *     should pass `{}` / omit the option to `resolveHostBinding`).
 *   - `null` on an EXCLUSIVE alt-host repo → `undefined`. A legacy NULL row
 *     predates host stamping and that repo has no github.com presence, so
 *     `{ host: null }` would throw. Falling back to the ambiguity rule binds
 *     to its alt host exactly as before this feature.
 *   - `null` on a plain or dual repo → `{ host: null }` (github.com).
 *   - a URL string → `{ host: '<url>' }` (that alt host).
 *
 * @param {Object} config - Application config
 * @param {string} bindingRepository - `repos[...]` config-lookup key
 * @param {string|null|undefined} storedHost - Value from `getPRHost`
 * @returns {{ host: string|null }|undefined} The `resolveHostBinding` option,
 *   or `undefined` to signal "use the ambiguity rule".
 */
function storedHostToOption(config, bindingRepository, storedHost) {
  if (storedHost === undefined) return undefined;
  if (storedHost === null && isExclusiveAltHost(getRepoConfig(config, bindingRepository))) {
    return undefined;
  }
  return { host: storedHost };
}

/**
 * A DUAL repo has an `api_host` configured but is NOT exclusive — its PRs may
 * live on github.com OR the alt host, so a host-unknown setup must probe.
 * Exclusive alt-host repos and plain github repos are NOT dual.
 *
 * This is the `repoConfig`-shaped predicate; callers that hold a `repos[...]`
 * entry directly (e.g. repo-links, pr-setup) use it, while `isDualHostRepo`
 * resolves a binding key to its entry first.
 *
 * @param {Object|null|undefined} repoConfig - A single `repos[...]` entry
 * @returns {boolean}
 */
function isDualHostRepoConfig(repoConfig) {
  const apiHost = (repoConfig && typeof repoConfig.api_host === 'string' && repoConfig.api_host)
    ? repoConfig.api_host
    : null;
  return apiHost !== null && isExclusiveAltHost(repoConfig) === false;
}

/**
 * Binding-key-shaped variant of {@link isDualHostRepoConfig}: resolves the
 * `repos[...]` entry for `bindingRepository` before applying the predicate.
 *
 * @param {Object} config - Application config
 * @param {string} bindingRepository - `repos[...]` config-lookup key
 * @returns {boolean}
 */
function isDualHostRepo(config, bindingRepository) {
  return isDualHostRepoConfig(getRepoConfig(config, bindingRepository));
}

/**
 * The configured `api_host` URL string for a binding key, or `null` when the
 * repo has none (plain github). Used by credential preflights that need to
 * resolve the alt-host binding as a second candidate.
 *
 * @param {Object} config - Application config
 * @param {string} bindingRepository - `repos[...]` config-lookup key
 * @returns {string|null}
 */
function getConfiguredApiHost(config, bindingRepository) {
  const repoConfig = getRepoConfig(config, bindingRepository);
  return (repoConfig && typeof repoConfig.api_host === 'string' && repoConfig.api_host)
    ? repoConfig.api_host
    : null;
}

// --- live-validation filler block for src/utils/host-resolution.js (throwaway PR) ---
// host_resolution filler line 1: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 2: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 3: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 4: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 5: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 6: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 7: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 8: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 9: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 10: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 11: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 12: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 13: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 14: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 15: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 16: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 17: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 18: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 19: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 20: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 21: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 22: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 23: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 24: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 25: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 26: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 27: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 28: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 29: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 30: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 31: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 32: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 33: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 34: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 35: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 36: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 37: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 38: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 39: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 40: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 41: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 42: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 43: synthetic content so the diff is large enough to virtualize.
// host_resolution filler line 44: synthetic content so the diff is large enough to virtualize.
// --- end live-validation filler block ---

/**
 * Resolve the binding used for a credential PREFLIGHT (fail-fast gate before
 * network work), tolerating a dual repo whose host is still unknown.
 *
 * The primary binding is resolved against `host` (undefined = unknown →
 * ambiguity rule; null = github; api_host string = that alt host). When the
 * host is unknown AND the repo is dual, the ambiguity rule yields the github.com
 * binding — but the downstream probe (`resolvePrHostBinding`) tries the alt host
 * first, so an alt-only repo token IS usable even though the github binding has
 * none. In that case return the alt binding so the caller does not falsely
 * reject; the caller only fails when NEITHER candidate has a token.
 *
 * Shared by the CLI (`src/main.js`) and the setup route (`src/routes/setup.js`).
 *
 * @param {string} bindingRepository - `repos[...]` config-lookup key
 * @param {Object} config
 * @param {string|null|undefined} host - explicit host (URL paste / body) or undefined
 * @returns {{ apiHost: string|null, token: string }} A binding; empty `.token`
 *   signals the caller to reject (missing credential).
 */
function resolvePreflightBinding(bindingRepository, config, host) {
  const primary = resolveHostBinding(
    bindingRepository,
    config,
    host !== undefined ? { host } : {}
  );
  if (primary.token) return primary;
  if (host === undefined && isDualHostRepo(config, bindingRepository)) {
    const apiHost = getConfiguredApiHost(config, bindingRepository);
    if (apiHost) {
      const alt = resolveHostBinding(bindingRepository, config, { host: apiHost });
      if (alt.token) return alt;
    }
  }
  return primary;
}

/**
 * Map a parser/stored host to the VALUE for the setup `?host=` query param, or
 * `null` to omit the param. Single source for the CLI cold-start, single-port
 * delegation, and (mirrored) the web paste flow — so a pasted alt URL binds the
 * alt host directly instead of re-probing at setup.
 *
 *   - alt api_host URL string → that string (setup binds the alt host)
 *   - `null` on a DUAL repo   → the `'github'` sentinel (setup binds github.com,
 *     no probe — avoids a loud failure if the alt host is down for a PR we KNOW
 *     is on github)
 *   - anything else (plain/exclusive repo, or unknown host) → `null` (omit; no
 *     probe happens for those, and omitting avoids the exclusive-null throw)
 *
 * Callers append the value as `host=${encodeURIComponent(value)}`.
 *
 * @param {string|null|undefined} host - parser/stored host
 * @param {boolean} isDual - whether the repo is dual (github + alt-host)
 * @returns {string|null} the param value, or null to omit
 */
function hostSetupParamValue(host, isDual) {
  if (typeof host === 'string' && host) return host;
  if (host === null && isDual) return 'github';
  return null;
}

module.exports = {
  storedHostToOption,
  isDualHostRepo,
  isDualHostRepoConfig,
  getConfiguredApiHost,
  resolvePreflightBinding,
  hostSetupParamValue,
};
