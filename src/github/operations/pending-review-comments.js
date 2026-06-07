// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const graphqlImpl = require('../impl/graphql/pending-review-comments');
const hostImpl = require('../impl/host/pending-review-comments');

/**
 * Dispatcher for the `pending_review_comments` area.
 *
 * Adds inline comments (line / range / file-level) to an already-pending
 * review. This area is special: GitHub provides no REST equivalent for
 * attaching comments to a pending draft, so the `"rest"` value is
 * explicitly rejected at runtime per the plan. Alt-hosts must declare
 * `"host"` and provide an extension endpoint.
 *
 * Dispatch:
 *   - `"graphql"` (default for github.com): delegates to
 *     `impl/graphql/pending-review-comments.js`. Identical behaviour to
 *     `GitHubClient.addCommentsInBatches` prior to the Phase 3 refactor,
 *     including the adaptive batch-size halving on complexity errors.
 *   - `"rest"`: rejected with a clear error. GitHub REST cannot reliably
 *     attach comments to a pending draft (see plan Hazards).
 *   - `"host"`: delegates to `impl/host/pending-review-comments.js`,
 *     which posts to the host's extension endpoint. Requires `prContext`
 *     ({ owner, repo, prNumber }) because the host endpoint is
 *     path-shaped — the GraphQL node IDs alone are not sufficient.
 */

const AREA = 'pending_review_comments';
// Modes actually implemented by the dispatcher below. Co-located with the
// dispatch logic so validateRepoConfig() and the dispatcher can't drift.
// REST is intentionally excluded: GitHub REST cannot attach comments to a
// pending draft review.
const IMPLEMENTED_MODES = new Set(['graphql', 'host']);

function selectFeature(features) {
  return (features && features[AREA]) || 'graphql';
}

/**
 * Add a list of comments to a pending review.
 *
 * The `prNodeId` / `reviewId` arguments are GraphQL-shaped (opaque node
 * IDs) for the GraphQL path. For the `"host"` path, `prContext` supplies
 * the path components and `reviewId` is interpreted as the host's review
 * identifier (a REST id returned by the host's `review_lifecycle` impl).
 *
 * @param {Object} octokit - Octokit instance bound to the host's baseUrl
 * @param {Object} features - Feature-flag object from the host binding
 * @param {string} prNodeId - GraphQL node ID for the PR (graphql path)
 * @param {string} reviewId - Review identifier. GraphQL node ID on the
 *   graphql path; the host's REST review id on the host path.
 * @param {Array} comments - Comments with path, line (optional), side, body, isFileLevel
 * @param {number} [batchSize=10]
 * @param {Object} [prContext] - `{ owner, repo, prNumber }`. Required for
 *   the `"host"` path; ignored on the graphql path.
 * @returns {Promise<{successCount: number, failed: boolean, failedDetails: string[]}>}
 */
async function addCommentsInBatches(octokit, features, prNodeId, reviewId, comments, batchSize, prContext) {
  const mode = selectFeature(features);
  if (mode === 'graphql') {
    return graphqlImpl.addCommentsInBatches(octokit, prNodeId, reviewId, comments, batchSize);
  }
  if (mode === 'rest') {
    throw new Error(
      'REST implementation for pending_review_comments is not supported: ' +
      'GitHub REST cannot reliably attach comments to a pending draft review. ' +
      'Use "graphql" for github.com or "host" with a host extension for alt-hosts.'
    );
  }
  if (mode === 'host') {
    return hostImpl.addCommentsInBatches(octokit, features, prContext, reviewId, comments, batchSize);
  }
  throw new Error(`Unknown features.pending_review_comments value: "${mode}"`);
}

module.exports = {
  addCommentsInBatches,
  AREA,
  IMPLEMENTED_MODES
};
