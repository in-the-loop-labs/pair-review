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

const { getRepoConfig, isExclusiveAltHost, resolveHostBinding, resolveBindingRepositoryFromPR } = require('../config');
const logger = require('./logger');

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
 * Normalise an EXPLICIT host hint (a setup request body, a `?host=` sentinel, a
 * pasted URL's parsed host) against config. The explicit-hint sibling of
 * {@link storedHostToOption}:
 *
 *   - `undefined` → `undefined` (no hint; the ambiguity rule applies).
 *   - a URL string → unchanged; `resolveHostBinding` validates it against the
 *     repo's `api_host` and reports a mismatch.
 *   - `null` (github.com) on a plain or dual repo → `null`.
 *   - `null` on an EXCLUSIVE alt-host repo → `undefined` + a warning. The repo
 *     config asserts there is no github.com presence (`exclusive` defaults to
 *     true whenever `api_host` is set), so the hint contradicts configuration.
 *     Ignoring it matches `applyHostQueryCorrection` in `src/server.js`, which
 *     warns and ignores the same sentinel rather than acting on it, and keeps
 *     `resolveHostBinding`'s exclusive-null guard unreachable from user input —
 *     a clickable dashboard row must never 500 on a config contradiction.
 *
 * @param {Object} config - Application config
 * @param {string} bindingRepository - `repos[...]` config-lookup key
 * @param {string|null|undefined} host - The explicit hint
 * @returns {string|null|undefined} The host to bind with
 */
function explicitHostForBinding(config, bindingRepository, host) {
  if (host !== null) return host;
  if (!isExclusiveAltHost(getRepoConfig(config, bindingRepository))) return null;
  logger.warn(
    `Ignoring github.com host hint for "${bindingRepository}": it is configured as an ` +
    'exclusive alt-host repo (api_host without "exclusive": false), so it has no github.com ' +
    'binding. Set "exclusive": false on that repo if its PRs can live on github.com too.'
  );
  return undefined;
}

/**
 * Resolve the host a RECORDED PR lives on, from its stored `host` column plus
 * its recorded `html_url`.
 *
 * Mirrors the convention {@link storedHostToOption} encodes, which already says
 * which stored NULLs are ambiguous: dual-host support shipped WITH host stamping
 * (schema v50), so a NULL on a dual or plain repo means github.com. What a NULL
 * cannot tell us is whether an older row predates stamping — and the recorded
 * `html_url` settles that in ONE direction, since a URL that is not on
 * github.com cannot be a github.com PR:
 *
 *   - a URL string → that host (already stamped; nothing to infer).
 *   - NULL on a repo with no `api_host` → `null`; there is no other host.
 *   - NULL with a non-github `html_url` → the configured `api_host`. This is the
 *     pre-stamping row (or a repo that was exclusive-alt before gaining
 *     `exclusive: false`), so github.com would be wrong.
 *   - NULL otherwise → `null` (github.com), per the convention above.
 *   - `undefined` (no row) → `undefined`.
 *
 * One resolver serves links, navigation, AND binding on purpose: a row that
 * renders a github.com icon must bind github.com when clicked, and the only way
 * to guarantee that is to derive every one of them from the same value.
 *
 * @param {Object} config - Application config
 * @param {string} bindingRepository - `repos[...]` config-lookup key
 * @param {string|null|undefined} storedHost - Value from the `host` column
 * @param {string|null|undefined} recordedUrl - The PR's stored `html_url`
 * @returns {string|null|undefined} The host this PR is recorded on
 */
function resolveRecordedHost(config, bindingRepository, storedHost, recordedUrl) {
  if (storedHost !== null) return storedHost;
  const apiHost = getConfiguredApiHost(config, bindingRepository);
  if (!apiHost) return null;
  if (typeof recordedUrl !== 'string' || !recordedUrl) return null;
  let hostname;
  try {
    hostname = new URL(recordedUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return (hostname === 'github.com' || hostname.endsWith('.github.com')) ? null : apiHost;
}

/**
 * Resolve the `repos[...]` config key for a PR whose host is KNOWN.
 *
 * `resolveBindingRepositoryFromPR` answers "which entry serves this
 * owner/repo?" with no host context: its slow path probes each entry's
 * `url_pattern` against a URL built from that entry's OWN `api_host`, so a
 * correctly anchored monorepo-style pattern claims EVERY owner/repo — including
 * repos that exist only on github.com.
 *
 * `PRArgumentParser.parsePRUrl` already refuses the same overreach in the URL
 * dimension (see its INVARIANT: "an `api_host`-bearing `url_pattern` must NEVER
 * bind a canonical github.com / Graphite URL"), discarding the match so a
 * pasted github.com URL resolves to its own `owner/repo`. This applies that
 * settled rule to the owner/repo dimension, for the one case that can be
 * decided safely:
 *
 *   - `host` unknown or an alt-host string → the matched key, unchanged.
 *   - `host === null` (github.com) and the entry was claimed by its
 *     `url_pattern` probe (its key is not this PR's identity) and it is an
 *     EXCLUSIVE alt-host entry → the PR's own `owner/repo`. Such an entry has
 *     no github.com presence, so it describes neither this PR's API host nor
 *     its checkout.
 *   - a DUAL entry is kept for either host: `resolveHostBinding` has a
 *     first-class github.com binding for dual repos, so the entry does serve
 *     this PR (and its path/pool/reset config still applies).
 *   - a directly-keyed exclusive entry is kept: there the configuration itself
 *     asserts this exact repo is alt-host-only, and config wins over inference.
 *
 * Two entry points share the rule: this one resolves the key itself, while
 * {@link bindingRepositoryForHost} filters a key a caller already holds (from a
 * `url_pattern` parse, say) without re-deriving it.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {Object} config
 * @param {string|null|undefined} host
 * @returns {string} The `repos[...]` config-lookup key
 */
function resolveBindingRepositoryForHost(owner, repo, config, host) {
  const identity = `${String(owner || '').toLowerCase()}/${String(repo || '').toLowerCase()}`;
  return bindingRepositoryForHost(
    config,
    identity,
    resolveBindingRepositoryFromPR(owner, repo, config),
    host
  );
}

/**
 * Filter form of {@link resolveBindingRepositoryForHost}: applies the same rule
 * to a binding key the caller already resolved. Used where re-deriving the key
 * from owner/repo could lose it — a `url_pattern` entry whose captures do not
 * reproduce its config key, for instance.
 *
 * @param {Object} config
 * @param {string} identity - The PR's own normalized `owner/repo`
 * @param {string} bindingRepository - Key the caller resolved
 * @param {string|null|undefined} host
 * @returns {string} The key to bind through
 */
function bindingRepositoryForHost(config, identity, bindingRepository, host) {
  if (host !== null) return bindingRepository;
  if (String(bindingRepository).toLowerCase() === String(identity).toLowerCase()) return bindingRepository;
  return isExclusiveAltHost(getRepoConfig(config, bindingRepository)) ? identity : bindingRepository;
}

/**
 * The single mapping from a PR's KNOWN host to the setup `?host=` param value.
 * Used by every entry point that can name a PR's host up front: dashboard
 * collection rows, recent-review rows, the pasted-URL flow, the CLI cold start,
 * and single-port delegation.
 *
 *   - an alt-host string → that string (setup binds it directly, no probe).
 *   - `null` (github.com) with ANY `api_host`-bearing entry in play → the
 *     `'github'` sentinel. Staying silent here leaves setup on the ambiguity
 *     rule, which probes a dual repo and binds an exclusive one to its alt host;
 *     announcing it is also what lets setup apply the host-aware key rule above.
 *   - `null` on a plain github.com repo → `null` (omit; the ambiguity rule
 *     already binds github.com, so there is nothing to say).
 *   - unknown host → `null` (omit; the server derives it).
 *
 * @param {Object} config
 * @param {string} owner
 * @param {string} repo
 * @param {string|null|undefined} host - The PR's resolved host
 * @returns {string|null} `?host=` value, or null to omit
 */
function setupHostParam(config, owner, repo, host) {
  if (typeof host === 'string' && host) return host;
  if (host !== null) return null;
  const matched = resolveBindingRepositoryFromPR(owner, repo, config);
  return getConfiguredApiHost(config, matched) ? 'github' : null;
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

module.exports = {
  storedHostToOption,
  explicitHostForBinding,
  resolveRecordedHost,
  resolveBindingRepositoryForHost,
  bindingRepositoryForHost,
  setupHostParam,
  isDualHostRepo,
  isDualHostRepoConfig,
  getConfiguredApiHost,
  resolvePreflightBinding,
};
