// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../../../utils/logger');
const { GitHubApiError } = require('../../errors');

/**
 * Derive an identity for a REST review payload. Falls back to the
 * stringified numeric id when `node_id` is absent so callers always
 * have a non-null id to work with. Returns null only when the payload
 * has neither field.
 */
function deriveRestReviewId(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.node_id) return data.node_id;
  if (data.id !== undefined && data.id !== null) return String(data.id);
  return null;
}

/**
 * REST implementation of the pending-review-check area.
 *
 * Provides REST-backed equivalents of the GraphQL implementations in
 * `impl/graphql/pending-review.js`. Each function returns the same shape
 * that the GraphQL implementation does so the dispatcher's callers do
 * not see any difference in behaviour.
 *
 *   - getPendingReviewForUser(octokit, owner, repo, prNumber)
 *   - getReviewById(octokit, nodeId, prContext)
 *
 * Note: `getReviewById` requires a `prContext = { owner, repo, prNumber }`
 * because the GitHub REST API's `pulls.getReview` endpoint identifies a
 * review by `(owner, repo, pull_number, review_id)` — the node ID alone
 * is not enough. The GraphQL form accepts only the node ID, so the
 * dispatcher signature accepts an optional `prContext` and the REST path
 * requires it.
 */

/**
 * Cache of authenticated-user lookups, keyed by Octokit instance. The
 * cache survives across calls within a single Octokit instance, which
 * matches how `GitHubClient` uses a single Octokit per host.
 *
 * Using a WeakMap so disposed Octokit instances don't keep entries
 * alive. The cache value is a Promise so concurrent callers share one
 * request.
 *
 * @type {WeakMap<Object, Promise<{id: number, login: string}>>}
 */
const authenticatedUserCache = new WeakMap();

/**
 * Resolve the authenticated user for the given Octokit instance,
 * caching the result on the instance via a WeakMap so subsequent
 * lookups in the same process don't re-call the API.
 *
 * @param {Object} octokit
 * @returns {Promise<{id: number, login: string}>}
 */
async function getAuthenticatedUserCached(octokit) {
  const cached = authenticatedUserCache.get(octokit);
  if (cached) return cached;

  const pending = (async () => {
    const { data } = await octokit.rest.users.getAuthenticated();
    return { id: data.id, login: data.login };
  })();

  authenticatedUserCache.set(octokit, pending);
  try {
    return await pending;
  } catch (err) {
    // On failure, drop the cache entry so the next caller retries.
    authenticatedUserCache.delete(octokit);
    throw err;
  }
}

/**
 * Fetch the pending review (if any) authored by the authenticated user
 * via the REST API.
 *
 * GitHub allows only ONE pending review per user per PR. We list all
 * reviews, filter to `state === 'PENDING'` and the authenticated user's
 * id, then shape the result to match the GraphQL implementation:
 *
 *   { id (node_id), databaseId (numeric id), body, url (html_url),
 *     state, createdAt (submitted_at || created), comments: { totalCount } }
 *
 * The `comments.totalCount` field is computed by a follow-up call to
 * `pulls.listCommentsForReview({ review_id })` so the caller can rely
 * on the same field being populated regardless of transport.
 *
 * @param {Object} octokit - Octokit instance bound to the host's baseUrl
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<Object|null>} Pending review or null
 */
async function getPendingReviewForUser(octokit, owner, repo, prNumber) {
  try {
    logger.debug(`Checking for pending review on PR #${prNumber} in ${owner}/${repo} (REST)`);

    const user = await getAuthenticatedUserCached(octokit);

    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100
    });

    const pending = reviews.find(r =>
      r.state === 'PENDING' && r.user && r.user.id === user.id
    );

    if (!pending) {
      logger.debug('No pending review found for user (REST)');
      return null;
    }

    // GraphQL exposes the review's createdAt directly. REST does not
    // expose a created-at timestamp on the review payload at all —
    // `submitted_at` is always null for a PENDING review by definition.
    // Return null explicitly so callers do not mistake a missing-submit
    // timestamp for a missing-created timestamp; the GraphQL shape is
    // nullable for never-submitted reviews so this is consistent.
    const createdAt = null;

    // Count comments attached to the pending review. We use
    // `pulls.listCommentsForReview` (GET
    // /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments)
    // which returns comments scoped to a single review — no filtering
    // required and far less wasteful than listing every comment on the
    // PR and discarding non-matching ones. Alt-hosts that do not
    // surface `pull_request_review_id` consistently also benefit from
    // this scoped endpoint. Paginated to match GraphQL's totalCount
    // semantics.
    let totalCount = 0;
    try {
      const reviewComments = await octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
        owner,
        repo,
        pull_number: prNumber,
        review_id: pending.id,
        per_page: 100
      });
      totalCount = reviewComments.length;
    } catch (commentErr) {
      logger.warn(`Could not count comments on pending review ${pending.id}: ${commentErr.message}`);
    }

    logger.debug(`Found pending review for user: ${pending.node_id} with ${totalCount} comments`);

    return {
      id: deriveRestReviewId(pending),
      databaseId: pending.id,
      body: pending.body || '',
      url: pending.html_url,
      state: pending.state,
      createdAt,
      comments: { totalCount }
    };
  } catch (error) {
    logger.error(`Error checking for pending review (REST): ${error.message}`);

    if (error.status === 401) {
      throw new GitHubApiError('GitHub authentication failed. Check your token in ~/.pair-review/config.json', 401);
    }

    if (error.status === 404) {
      throw new GitHubApiError(`Pull request #${prNumber} not found in repository ${owner}/${repo}`, 404);
    }

    throw new Error(`Failed to check for pending review: ${error.message}`);
  }
}

/**
 * Fetch a review by id via REST.
 *
 * Unlike GraphQL, the REST endpoint requires `(owner, repo, pull_number,
 * review_id)`. Callers must therefore supply a `prContext` argument when
 * the dispatcher is in REST mode. The `nodeId` parameter is accepted for
 * signature parity with the GraphQL impl but is not used by REST — the
 * `prContext.reviewId` (numeric) field is consulted first, then we fall
 * back to the `nodeId` argument when it is a numeric string.
 *
 * @param {Object} octokit
 * @param {string|number} nodeId - GraphQL node id OR numeric review id
 * @param {Object} prContext - { owner, repo, prNumber, reviewId? }
 * @returns {Promise<Object|null>}
 */
async function getReviewById(octokit, nodeId, prContext) {
  if (!prContext || !prContext.owner || !prContext.repo || !prContext.prNumber) {
    throw new Error(
      'REST getReviewById requires prContext={owner, repo, prNumber}. ' +
      'The REST API identifies a review by (owner, repo, pull_number, review_id); ' +
      'a node id alone is not sufficient.'
    );
  }

  // Prefer an explicit numeric review id when present; otherwise expect
  // `nodeId` to be a numeric REST id (callers that have only a GraphQL
  // node id should resolve it upstream).
  let reviewId = prContext.reviewId;
  if (reviewId === undefined || reviewId === null) {
    if (typeof nodeId === 'number') {
      reviewId = nodeId;
    } else if (typeof nodeId === 'string' && /^\d+$/.test(nodeId)) {
      reviewId = Number(nodeId);
    } else {
      // No usable numeric id — surface a clear error rather than calling
      // the REST API with a GraphQL node id (which would 404).
      logger.warn(`REST getReviewById called with non-numeric id "${nodeId}" and no prContext.reviewId`);
      return null;
    }
  }

  try {
    logger.debug(`Fetching review ${reviewId} on PR #${prContext.prNumber} (REST)`);

    const { data } = await octokit.rest.pulls.getReview({
      owner: prContext.owner,
      repo: prContext.repo,
      pull_number: prContext.prNumber,
      review_id: reviewId
    });

    return {
      id: deriveRestReviewId(data),
      state: data.state,
      submittedAt: data.submitted_at || null,
      url: data.html_url
    };
  } catch (error) {
    if (error.status === 404) {
      logger.debug(`Review ${reviewId} not found via REST`);
      return null;
    }
    logger.warn(`Error fetching review ${reviewId} via REST: ${error.message}`);
    return null;
  }
}

module.exports = {
  getPendingReviewForUser,
  getReviewById,
  // Exported for tests so they can reset the per-instance cache.
  _resetAuthenticatedUserCache(octokit) {
    if (octokit) authenticatedUserCache.delete(octokit);
  }
};
