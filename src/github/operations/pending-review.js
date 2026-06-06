// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const graphqlImpl = require('../impl/graphql/pending-review');
const restImpl = require('../impl/rest/pending-review');

/**
 * Dispatcher for the `pending_review_check` area.
 *
 * Each operation inspects `features.pending_review_check`:
 *   - `"graphql"` (default for github.com): delegates to the GraphQL impl
 *     in `impl/graphql/pending-review.js`. Identical behaviour to what
 *     `GitHubClient` did before the Phase 3 refactor.
 *   - `"rest"`: delegates to `impl/rest/pending-review.js`. The REST
 *     implementation produces the same return shape as the GraphQL impl.
 *     Note that `getReviewById` requires a `prContext` because the
 *     REST API identifies a review by (owner, repo, pull_number,
 *     review_id) rather than by node id alone.
 *   - `"host"`: not yet implemented — Phase 5 will add it (no host
 *     extension is currently defined for this area).
 *
 * The dispatch shape allows each call site to use the same function
 * signature regardless of which transport actually runs underneath.
 */

const AREA = 'pending_review_check';
// Modes actually implemented by the dispatcher below. Co-located with the
// dispatch logic so validateRepoConfig() and the dispatcher can't drift.
// `host` is reserved for Phase 5 and is not yet implemented.
const IMPLEMENTED_MODES = new Set(['graphql', 'rest']);

function selectFeature(features) {
  return (features && features[AREA]) || 'graphql';
}

/**
 * Fetch the pending review (if any) authored by the authenticated user.
 *
 * @param {Object} octokit - Octokit instance bound to the host's baseUrl
 * @param {Object} features - Feature-flag object from the host binding
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<Object|null>}
 */
async function getPendingReviewForUser(octokit, features, owner, repo, prNumber) {
  const mode = selectFeature(features);
  if (mode === 'graphql') {
    return graphqlImpl.getPendingReviewForUser(octokit, owner, repo, prNumber);
  }
  if (mode === 'rest') {
    return restImpl.getPendingReviewForUser(octokit, owner, repo, prNumber);
  }
  if (mode === 'host') {
    throw new Error('Host implementation for pending_review_check not yet available (Phase 5)');
  }
  throw new Error(`Unknown features.pending_review_check value: "${mode}"`);
}

/**
 * Fetch a review by its GraphQL/database node ID.
 *
 * @param {Object} octokit
 * @param {Object} features
 * @param {string} nodeId
 * @param {Object} [prContext] - { owner, repo, prNumber, reviewId? }
 *   REQUIRED when `features.pending_review_check === "rest"` because the
 *   REST endpoint identifies a review by (owner, repo, pull_number,
 *   review_id) rather than by node id. Optional for the GraphQL path.
 * @returns {Promise<Object|null>}
 */
async function getReviewById(octokit, features, nodeId, prContext) {
  const mode = selectFeature(features);
  if (mode === 'graphql') {
    return graphqlImpl.getReviewById(octokit, nodeId);
  }
  if (mode === 'rest') {
    return restImpl.getReviewById(octokit, nodeId, prContext);
  }
  if (mode === 'host') {
    throw new Error('Host implementation for pending_review_check not yet available (Phase 5)');
  }
  throw new Error(`Unknown features.pending_review_check value: "${mode}"`);
}

module.exports = {
  getPendingReviewForUser,
  getReviewById,
  AREA,
  IMPLEMENTED_MODES
};
