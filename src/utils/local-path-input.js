// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const { resolveHostListText, resolveUrlLikeHostnames } = require('../links/host-names');

/**
 * Error code stamped on the "you passed a URL, not a path" error.
 *
 * Callers MUST branch on this rather than comparing the message text — the
 * message names the configured hosts and therefore varies per installation.
 */
const LOCAL_PATH_IS_URL_CODE = 'LOCAL_PATH_IS_URL';

/**
 * Build the user-facing message for a local-review path that is really a URL.
 *
 * Without a config the message stays host-neutral. Falling back to the
 * built-in list would name GitHub alone, which actively misinforms: on an
 * install with `enable_graphite` or an alt host, those URLs ARE accepted as PR
 * review inputs.
 *
 * @param {Object} [config] - Configuration object from loadConfig()
 * @returns {string}
 */
function localReviewPathUrlError(config) {
  const hostClause = (config && typeof config === 'object')
    ? `${resolveHostListText(config)} URLs`
    : 'PR URLs';
  return 'Local reviews require a filesystem path, not a URL. '
    + `Pass ${hostClause} as PR review inputs instead.`;
}

/**
 * Detect inputs that are URLs or remote-style Git URLs rather than filesystem paths.
 * This intentionally checks only unambiguous URL forms so normal absolute,
 * relative, tilde, and Windows paths continue to work.
 *
 * Scheme-less PR URLs are recognised for github.com, Graphite, and every
 * configured alt host (both its `api_host` and its `links.external`
 * web host, which are frequently different domains).
 *
 * @param {unknown} input
 * @param {Object} [config] - Configuration object; without it only the
 *                            built-in hosts are recognised scheme-less.
 * @returns {boolean}
 */
function isUrlLikeLocalReviewPath(input, config) {
  if (typeof input !== 'string') return false;

  const value = input.trim();
  if (!value) return false;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;

  const hostnames = resolveUrlLikeHostnames(config);
  const lower = value.toLowerCase();
  // Require a path separator so a bare hostname-shaped directory name is not
  // mistaken for a URL, matching the previous built-in behaviour.
  if (hostnames.some(hostname => lower.startsWith(`${hostname}/`))) return true;

  // Treat only a leading user@host:path token as SSH remote syntax; if a
  // directory prefix contains @ and : it should remain a filesystem path.
  if (/^[^@/\\\s]+@[^:/\\\s]+:[^\s]+$/.test(value)) return true;

  return false;
}

/**
 * Throw a user-facing error when a local review path is actually a URL.
 *
 * The thrown error carries `code === LOCAL_PATH_IS_URL_CODE`.
 *
 * @param {unknown} input
 * @param {Object} [config] - Configuration object from loadConfig()
 * @throws {Error}
 */
function rejectUrlLikeLocalReviewPath(input, config) {
  if (isUrlLikeLocalReviewPath(input, config)) {
    const error = new Error(localReviewPathUrlError(config));
    error.code = LOCAL_PATH_IS_URL_CODE;
    throw error;
  }
}

/**
 * True when an error came from rejectUrlLikeLocalReviewPath().
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isLocalPathUrlError(error) {
  return Boolean(error) && error.code === LOCAL_PATH_IS_URL_CODE;
}

module.exports = {
  LOCAL_PATH_IS_URL_CODE,
  localReviewPathUrlError,
  isUrlLikeLocalReviewPath,
  rejectUrlLikeLocalReviewPath,
  isLocalPathUrlError
};
