// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const LOCAL_REVIEW_PATH_URL_ERROR = 'Local reviews require a filesystem path, not a URL. Pass GitHub or Graphite URLs as PR review inputs instead.';

/**
 * Detect inputs that are URLs or remote-style Git URLs rather than filesystem paths.
 * This intentionally checks only unambiguous URL forms so normal absolute,
 * relative, tilde, and Windows paths continue to work.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
function isUrlLikeLocalReviewPath(input) {
  if (typeof input !== 'string') return false;

  const value = input.trim();
  if (!value) return false;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^(?:github\.com|app\.graphite\.(?:dev|com))\//i.test(value)) return true;
  // Treat only a leading user@host:path token as SSH remote syntax; if a
  // directory prefix contains @ and : it should remain a filesystem path.
  if (/^[^@/\\\s]+@[^:/\\\s]+:[^\s]+$/.test(value)) return true;

  return false;
}

/**
 * Throw a user-facing error when a local review path is actually a URL.
 *
 * @param {unknown} input
 * @throws {Error}
 */
function rejectUrlLikeLocalReviewPath(input) {
  if (isUrlLikeLocalReviewPath(input)) {
    throw new Error(LOCAL_REVIEW_PATH_URL_ERROR);
  }
}

module.exports = {
  LOCAL_REVIEW_PATH_URL_ERROR,
  isUrlLikeLocalReviewPath,
  rejectUrlLikeLocalReviewPath
};
