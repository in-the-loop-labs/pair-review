// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Known PR Host Names
 *
 * Derives the list of code hosts pair-review will accept a pull request from,
 * for use in copy that is rendered BEFORE any repository has been resolved —
 * the landing-page PR input, the URL validation errors, and the
 * "that's a URL, not a path" local-review error.
 *
 * `resolveHostName()` in ./repo-links.js answers the same question for a
 * KNOWN repo. This module answers it for the whole configuration, which is
 * what the pre-resolution surfaces need: at the point where a user is typing
 * a URL there is no repo to look up yet.
 *
 * The list is derived, never hardcoded:
 *
 *   - "GitHub" is always present. Unconfigured repos fall back to github.com
 *     with the top-level credentials, so github.com is always reachable.
 *   - "Graphite" appears only when `enable_graphite` is true. It defaults to
 *     false, so a default install must not advertise it.
 *   - Each distinct `repos[*].links.external.name` for a repo that also sets
 *     `api_host` — the alt-host display name (e.g. "Meteorite").
 *
 * Alt-host repos with no `links.external.name` resolve to "GitHub" via
 * `resolveHostName` and are therefore de-duplicated away rather than
 * appearing twice.
 */

const { resolveHostName } = require('./repo-links');

const DEFAULT_HOST_NAME = 'GitHub';
const GRAPHITE_HOST_NAME = 'Graphite';

// Hostnames whose PR URLs are recognised even without a scheme. Alt hosts are
// appended from config by resolveUrlLikeHostnames().
const BUILTIN_PR_HOSTNAMES = Object.freeze([
  'github.com',
  'app.graphite.dev',
  'app.graphite.com'
]);

/**
 * Iterate every configured repo entry.
 *
 * `loadConfig()` lowercases the legacy `monorepos` map, merges it into `repos`,
 * and deletes it, so for any loaded config that branch never fires — it is here
 * only for raw/hand-built configs, mirroring `getRepoConfig`'s equivalent
 * fallback.
 *
 * @param {Object} config
 * @returns {Array<[string, Object]>} `[repoKey, repoEntry]` pairs
 */
function configuredRepoEntries(config) {
  const entries = [];
  for (const section of [config.repos, config.monorepos]) {
    if (!section || typeof section !== 'object') continue;
    for (const [repoKey, repoEntry] of Object.entries(section)) {
      if (!repoEntry || typeof repoEntry !== 'object') continue;
      entries.push([repoKey, repoEntry]);
    }
  }
  return entries;
}

/**
 * True when a repo entry declares an alt host.
 *
 * @param {Object} repoEntry
 * @returns {boolean}
 */
function hasApiHost(repoEntry) {
  return typeof repoEntry.api_host === 'string' && repoEntry.api_host.length > 0;
}

/**
 * Resolve the ordered, de-duplicated list of host display names that
 * pair-review can accept PR URLs for.
 *
 * @param {Object} [config] - Configuration object from loadConfig()
 * @returns {string[]} Non-empty list, always starting with "GitHub"
 */
function resolveKnownHostNames(config) {
  const safeConfig = (config && typeof config === 'object') ? config : {};

  const names = [DEFAULT_HOST_NAME];
  if (safeConfig.enable_graphite === true) names.push(GRAPHITE_HOST_NAME);

  const seen = new Set(names.map(name => name.toLowerCase()));

  for (const [repoKey, repoEntry] of configuredRepoEntries(safeConfig)) {
    if (!hasApiHost(repoEntry)) continue;
    // Route through resolveHostName so the global list agrees with the
    // per-repo name used in the submit toast and draft notices — including
    // its validation (a `name` without a usable `label`/`url_template` pair
    // does not register as an external link, and so does not appear here).
    const name = resolveHostName(safeConfig, repoKey);
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    names.push(name);
  }

  return names;
}

/**
 * Join host names into a user-facing fragment with an Oxford comma:
 * "GitHub", "GitHub or Graphite", "GitHub, Graphite, or Meteorite".
 *
 * @param {string[]} names
 * @returns {string}
 */
function formatHostList(names) {
  const list = Array.isArray(names) ? names.filter(name => typeof name === 'string' && name) : [];
  if (list.length === 0) return DEFAULT_HOST_NAME;
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} or ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}`;
}

/**
 * Convenience wrapper: the formatted host fragment for a config.
 *
 * @param {Object} [config]
 * @returns {string}
 */
function resolveHostListText(config) {
  return formatHostList(resolveKnownHostNames(config));
}

/**
 * Hostnames (lowercased) that belong to configured alt hosts, recorded both
 * with and without an explicit port so either shape of paste is recognised.
 *
 * Derived from each alt-host repo's `api_host` and, when present, the web
 * host in `links.external.url_template` — the API host and the web host are
 * frequently different domains, and a user pastes the latter.
 *
 * @param {Object} [config]
 * @returns {string[]}
 */
function resolveAltHostHostnames(config) {
  const safeConfig = (config && typeof config === 'object') ? config : {};
  const hostnames = new Set();

  const add = (value) => {
    if (typeof value !== 'string' || !value) return;
    // `api_host` is only validated as a non-empty string, so a bare
    // `ghe.example.com` is a legitimate configuration — give it a scheme so
    // `new URL()` can parse it rather than throwing into the catch below.
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    let url;
    try {
      url = new URL(absolute);
    } catch {
      // Not parseable even with a scheme — nothing to derive.
      return;
    }
    // A template can carry a placeholder in its authority section
    // (`https://{owner}.example/…` parses, yielding hostname `{owner}.example`);
    // no pasted input can start with that, so drop it rather than ship junk.
    if (!url.hostname || url.hostname.includes('{')) return;
    // `host` keeps a non-default port — what a user actually pastes for
    // `https://ghe.example.com:8443/…`; `hostname` drops it.
    hostnames.add(url.host.toLowerCase());
    hostnames.add(url.hostname.toLowerCase());
  };

  for (const [, repoEntry] of configuredRepoEntries(safeConfig)) {
    if (!hasApiHost(repoEntry)) continue;
    add(repoEntry.api_host);
    add(repoEntry.links?.external?.url_template);
  }

  return Array.from(hostnames);
}

/**
 * Every hostname whose PR URLs should be recognised without a scheme —
 * the built-ins plus every configured alt host. De-duplicated, lowercased.
 *
 * @param {Object} [config]
 * @returns {string[]}
 */
function resolveUrlLikeHostnames(config) {
  const seen = new Set(BUILTIN_PR_HOSTNAMES);
  for (const hostname of resolveAltHostHostnames(config)) seen.add(hostname);
  return Array.from(seen);
}

module.exports = {
  DEFAULT_HOST_NAME,
  GRAPHITE_HOST_NAME,
  BUILTIN_PR_HOSTNAMES,
  resolveKnownHostNames,
  formatHostList,
  resolveHostListText,
  resolveAltHostHostnames,
  resolveUrlLikeHostnames,
};
