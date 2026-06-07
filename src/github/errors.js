// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Custom error class for GitHub API errors that preserves the HTTP status code.
 * Route handlers can check `error.status` or use `instanceof GitHubApiError`
 * instead of fragile string matching on error messages.
 */
class GitHubApiError extends Error {
  /**
   * @param {string} message - Human-readable error message
   * @param {number} status - HTTP status code (e.g. 401, 403, 404, 429)
   */
  constructor(message, status) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/**
 * Detect whether a GraphQL error is a complexity/cost limit error from GitHub.
 * These errors mean the mutation was too large and can be retried with fewer items.
 *
 * @param {Error} error - The error thrown by octokit.graphql
 * @returns {boolean} True if the error is a complexity/cost limit error
 */
function isComplexityError(error) {
  const patterns = [
    /complexity/i,
    /MAX_NODE_LIMIT/,
    /cost exceeds/i,
    /too large/i,
    /query size exceeds/i,
  ];

  if (error.message) {
    for (const pattern of patterns) {
      if (pattern.test(error.message)) return true;
    }
  }

  if (error.errors && Array.isArray(error.errors)) {
    for (const err of error.errors) {
      if (err.message) {
        for (const pattern of patterns) {
          if (pattern.test(err.message)) return true;
        }
      }
    }
  }

  return false;
}

module.exports = { GitHubApiError, isComplexityError };
