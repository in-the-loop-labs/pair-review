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

const { execSync } = require('child_process');
const { getRepoConfig, isExclusiveAltHost, resolveHostBinding } = require('../config');
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

/**
 * The github.com hostnames a git remote may legitimately carry.
 */
const GITHUB_HOSTNAMES = new Set(['github.com', 'www.github.com']);

/** Trimmed + lowercased, or null. */
function normalizeHostname(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

/**
 * Extract the hostname from a configured `api_host`.
 *
 * `api_host` is an API BASE URL (`https://api.git.corp`,
 * `https://git.corp/api/v3`), but tolerate a bare hostname
 * (`git.corp`, `git.corp:8443`) rather than throwing on it.
 *
 * @param {string|null|undefined} apiHost
 * @returns {string|null} Lowercased hostname without port, or null
 */
function apiHostToHostname(apiHost) {
  if (typeof apiHost !== 'string') return null;
  const trimmed = apiHost.trim();
  if (!trimmed) return null;

  try {
    const { hostname } = new URL(trimmed);
    if (hostname) return hostname.toLowerCase();
  } catch {
    // Not a parseable absolute URL — fall through to the bare-hostname path.
  }

  // A bare hostname (optionally with a port or a path) has no scheme, so the
  // URL parser either throws or mis-reads `host:port` as `scheme:path`.
  try {
    const { hostname } = new URL(`https://${trimmed}`);
    return hostname ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Does a git remote's hostname denote the same host as a configured
 * `api_host`?
 *
 * The two are different URL shapes (API base vs git remote), so the
 * comparison tolerates an `api.` prefix on either side and ignores any
 * path/port. Compares HOSTNAMES, never raw strings.
 *
 * @param {string|null} remoteHostname - Hostname from `parseRemoteUrl`
 * @param {string|null} apiHost - Configured `api_host` (URL or bare hostname)
 * @returns {boolean}
 */
function hostnameMatchesApiHost(remoteHostname, apiHost) {
  const remote = normalizeHostname(remoteHostname);
  const api = apiHostToHostname(apiHost);
  if (!remote || !api) return false;

  if (remote === api) return true;
  // `https://api.git.corp` is the API endpoint for the `git.corp` git remote.
  if (api.startsWith('api.') && api.slice(4) === remote) return true;
  // The mirror case: an `api.`-prefixed remote against a bare api_host.
  if (remote.startsWith('api.') && remote.slice(4) === api) return true;

  return false;
}

/**
 * Timeout for the `git config` read below.
 *
 * The command is a local file read and normally returns in milliseconds, but
 * it runs on the BLOCKING page-load path (`GET /api/local/:reviewId`), and a
 * checkout living on a hung network mount can stall `execSync` forever with no
 * timeout at all. 5s matches the other git shell-outs in the codebase
 * (src/git/base-branch.js).
 */
const GIT_REMOTE_TIMEOUT_MS = 5000;

/**
 * Extract the hostname from a git remote URL.
 *
 * Two families are recognised:
 *   - `scheme://[user@]host[:port]/path` (https, ssh, git, …) — parsed with
 *     the WHATWG URL parser, which already strips the userinfo and the port.
 *   - SCP-style SSH (`[user@]host:owner/repo`) — no scheme, so the URL parser
 *     cannot be used; the host is everything before the first colon.
 *
 * Anything else (a bare filesystem path, garbage) has no host.
 *
 * Lives here rather than in `src/local-review.js` (its original home, which
 * still owns the `owner/repo` half of remote parsing) so that the host
 * resolution below can read a checkout's remote WITHOUT requiring
 * `local-review.js` — that module requires this one, and CommonJS resolves
 * such a cycle to an empty exports object because `local-review.js` assigns
 * `module.exports` wholesale.
 *
 * @param {string} trimmedUrl - A non-empty, already-trimmed remote URL
 * @returns {string|null} Lowercased hostname without port, or null
 */
function extractRemoteHostname(trimmedUrl) {
  if (typeof trimmedUrl !== 'string' || !trimmedUrl) return null;

  if (trimmedUrl.includes('://')) {
    try {
      const { hostname } = new URL(trimmedUrl);
      return hostname ? hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  // SCP-style: [user@]host:path — the host cannot contain '/' or '@'.
  const scpMatch = trimmedUrl.match(/^(?:[^@/]+@)?([^@/:]+):(?!\/)/);
  return scpMatch ? scpMatch[1].toLowerCase() : null;
}

/**
 * Default OS-level dependencies for the remote-reading helper. Overridable
 * via `_deps` so tests do not have to shell out to git.
 */
const remoteDefaults = {
  execSync
};

/**
 * Read `remote.origin.url` for a checkout and return its hostname.
 *
 * Local mode is the one context where the host a review belongs to is knowable
 * from disk, so this is what lets a dual-host repo (`api_host` configured,
 * `exclusive: false`) avoid guessing github.com.
 *
 * @param {string} repoPath - Path to the git repository
 * @param {Object} [_deps] - Dependency overrides (`execSync`)
 * @returns {string|null} Lowercased hostname, or null when there is no remote,
 *   the command fails or times out, or the URL has no recognizable host.
 */
function getRemoteHostname(repoPath, _deps = {}) {
  const deps = { ...remoteDefaults, ..._deps };
  try {
    const remoteUrl = deps.execSync('git config --get remote.origin.url', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_REMOTE_TIMEOUT_MS
    }).trim();

    if (!remoteUrl) return null;

    return extractRemoteHostname(remoteUrl);
  } catch (error) {
    // No remote configured, git failed, or the call timed out — the host
    // stays unknown. Never throws; callers treat null as "still ambiguous".
    logger.debug(`Could not get remote URL hostname: ${error.message}`);
    return null;
  }
}

/**
 * Map a git remote hostname to a host option for `resolveHostBinding`,
 * following the `{ host: <url string> }` / `{ host: null }` convention
 * documented on {@link storedHostToOption}.
 *
 * Fails safe: when the remote answers neither host, return null so the caller
 * keeps treating the host as unknown instead of guessing wrong.
 *
 * @param {string|null} remoteHostname - Hostname from `parseRemoteUrl`
 * @param {string|null} apiHost - The repo's configured `api_host`, if any
 * @returns {{host: string|null}|null} `{ host: null }` for github.com (and
 *   www.github.com); `{ host: apiHost }` when the remote matches `apiHost`;
 *   `null` when the remote is missing, unparseable, or matches neither —
 *   meaning "still ambiguous, do not guess".
 */
function remoteHostnameToHostOption(remoteHostname, apiHost) {
  const remote = normalizeHostname(remoteHostname);
  if (!remote) return null;

  if (GITHUB_HOSTNAMES.has(remote)) return { host: null };

  if (typeof apiHost === 'string' && apiHost && hostnameMatchesApiHost(remote, apiHost)) {
    return { host: apiHost };
  }

  return null;
}

module.exports = {
  storedHostToOption,
  hostnameMatchesApiHost,
  extractRemoteHostname,
  getRemoteHostname,
  remoteHostnameToHostOption,
  GIT_REMOTE_TIMEOUT_MS,
  isDualHostRepo,
  isDualHostRepoConfig,
  getConfiguredApiHost,
  resolvePreflightBinding,
  hostSetupParamValue,
};
