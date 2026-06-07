// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../../../utils/logger');

/**
 * Derive an identity for a REST review payload. GraphQL identifies
 * reviews by their `node_id` string; on alt-hosts that don't surface
 * `node_id` we fall back to the numeric `id` stringified, so callers
 * always receive a non-null id when the review was created. Returns
 * null only when neither field is present.
 *
 * @param {Object|null|undefined} data - The REST API review payload
 * @returns {string|null}
 */
function deriveRestReviewId(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.node_id) return data.node_id;
  if (data.id !== undefined && data.id !== null) return String(data.id);
  return null;
}

/**
 * REST implementation of the review-lifecycle area:
 *   - addPullRequestReview         -> `pulls.createReview({ body: '' })` (no event, empty body)
 *   - addPullRequestReviewWithBody -> `pulls.createReview({ body })`
 *   - submitPullRequestReview      -> `pulls.submitReview({ event, body })`
 *   - deletePullRequestReview      -> `pulls.deletePendingReview()`
 *
 * Each function takes an Octokit-like client as its first parameter and
 * a `prContext = { owner, repo, prNumber }` since REST endpoints
 * identify the review by `(owner, repo, pull_number, review_id)` rather
 * than by a GraphQL node id.
 *
 * Return shapes are byte-identical to the GraphQL impl in
 * `impl/graphql/review-lifecycle.js` so the orchestration in
 * `client.js` does not have to branch on transport.
 */

/**
 * Ensure prContext has the fields REST endpoints require. Throws a
 * descriptive error pointing at the dispatcher/client wiring when
 * called without enough context.
 *
 * @param {Object} prContext
 * @param {string} fnName - Function name for the error message
 */
function requirePRContext(prContext, fnName) {
  if (!prContext || !prContext.owner || !prContext.repo || !prContext.prNumber) {
    throw new Error(
      `REST ${fnName} requires prContext={owner, repo, prNumber}. ` +
      'The REST API needs the PR coordinates to identify the review; ' +
      'pass them via the dispatcher / GitHubClient.'
    );
  }
}

/**
 * Create a pending review with no body. Used by the submit-review flow
 * that supplies the body at submission time.
 *
 * Returns both the GraphQL node id (`id`) and the numeric REST database
 * id (`databaseId`). Downstream callers (e.g.
 * `submitPullRequestReview`, `deletePullRequestReview`, the host
 * `addCommentsInBatches` extension) require the numeric id to address
 * the review via REST/host endpoints — they read it from
 * `prContext.reviewId` populated by the orchestration in `client.js`.
 *
 * @param {Object} octokit
 * @param {string} prNodeId - Accepted for signature parity; REST does not need it
 * @param {Object} prContext - { owner, repo, prNumber }
 * @returns {Promise<{id: string, databaseId: number|null}>}
 */
async function addPullRequestReview(octokit, prNodeId, prContext) {
  requirePRContext(prContext, 'addPullRequestReview');

  const { data } = await octokit.rest.pulls.createReview({
    owner: prContext.owner,
    repo: prContext.repo,
    pull_number: prContext.prNumber,
    // No `event` -> review is created in PENDING state.
    //
    // The explicit empty `body` is REQUIRED, not cosmetic. Without any
    // body params Octokit serializes a POST with an empty HTTP body.
    // github.com tolerates that and creates an empty pending review, but
    // strict GitHub-compatible alt-hosts (those with an `api_host`)
    // reject it with HTTP 400 `{ message: "request body is empty" }`.
    // Sending `body: ''` makes the serialized body non-empty (`{"body":""}`)
    // while keeping the review PENDING. This is observationally identical
    // on github.com to an empty-summary pending review and mirrors the
    // sibling `addPullRequestReviewWithBody` (`body: body || ''`).
    // Do NOT "simplify" this away.
    body: ''
  });

  return {
    id: deriveRestReviewId(data),
    databaseId: typeof data.id === 'number' ? data.id : null
  };
}

/**
 * Create a pending review with a body. Used by the draft-review flow
 * which persists the summary on the pending review itself.
 *
 * @param {Object} octokit
 * @param {string} prNodeId
 * @param {string|null} body
 * @param {Object} prContext
 * @returns {Promise<{id: string, databaseId: number|null, url: string}>}
 */
async function addPullRequestReviewWithBody(octokit, prNodeId, body, prContext) {
  requirePRContext(prContext, 'addPullRequestReviewWithBody');

  const { data } = await octokit.rest.pulls.createReview({
    owner: prContext.owner,
    repo: prContext.repo,
    pull_number: prContext.prNumber,
    body: body || ''
    // No `event` -> PENDING.
  });

  return {
    id: deriveRestReviewId(data),
    databaseId: typeof data.id === 'number' ? data.id : null,
    url: data.html_url
  };
}

/**
 * Submit a pending review. Maps the GraphQL `event` enum values
 * (APPROVE/REQUEST_CHANGES/COMMENT) directly to REST's `event` field,
 * which accepts the same uppercase values.
 *
 * @param {Object} octokit
 * @param {string} reviewId - GraphQL node id OR numeric review id
 * @param {string} event - APPROVE | REQUEST_CHANGES | COMMENT
 * @param {string|null} body
 * @param {Object} prContext - { owner, repo, prNumber, reviewId? } - numeric id required for REST
 * @returns {Promise<{id: string, databaseId: number|null, url: string, state: string}>}
 */
async function submitPullRequestReview(octokit, reviewId, event, body, prContext) {
  requirePRContext(prContext, 'submitPullRequestReview');

  const numericId = resolveNumericReviewId(reviewId, prContext);
  if (numericId === null) {
    throw new Error(
      'REST submitPullRequestReview needs a numeric review id. Pass prContext.reviewId ' +
      'when the reviewId argument is a GraphQL node id.'
    );
  }

  const { data } = await octokit.rest.pulls.submitReview({
    owner: prContext.owner,
    repo: prContext.repo,
    pull_number: prContext.prNumber,
    review_id: numericId,
    event,
    body: body || ''
  });

  return {
    id: deriveRestReviewId(data),
    databaseId: typeof data.id === 'number' ? data.id : null,
    url: data.html_url,
    state: data.state
  };
}

/**
 * Delete a pending review (cleanup on failure). Never throws — mirrors
 * the GraphQL impl, which logs and returns false on failure.
 *
 * @param {Object} octokit
 * @param {string} reviewId
 * @param {Object} prContext
 * @returns {Promise<boolean>}
 */
async function deletePullRequestReview(octokit, reviewId, prContext) {
  try {
    requirePRContext(prContext, 'deletePullRequestReview');

    const numericId = resolveNumericReviewId(reviewId, prContext);
    if (numericId === null) {
      logger.warn('REST deletePullRequestReview called without a numeric review id; skipping');
      return false;
    }

    await octokit.rest.pulls.deletePendingReview({
      owner: prContext.owner,
      repo: prContext.repo,
      pull_number: prContext.prNumber,
      review_id: numericId
    });
    logger.info('Cleaned up pending review after failure (REST)');
    return true;
  } catch (cleanupError) {
    logger.warn(`Failed to clean up pending review (REST): ${cleanupError.message}`);
    return false;
  }
}

/**
 * Resolve a numeric REST review id from the dispatcher-supplied
 * `reviewId` (which may be either a numeric REST id or a GraphQL node
 * id) plus an optional override on `prContext.reviewId`.
 *
 * @param {string|number} reviewId
 * @param {Object} prContext
 * @returns {number|null}
 */
function resolveNumericReviewId(reviewId, prContext) {
  if (prContext && (typeof prContext.reviewId === 'number' || typeof prContext.reviewId === 'string')) {
    const fromCtx = Number(prContext.reviewId);
    if (Number.isFinite(fromCtx)) return fromCtx;
  }
  if (typeof reviewId === 'number') return reviewId;
  if (typeof reviewId === 'string' && /^\d+$/.test(reviewId)) return Number(reviewId);
  return null;
}

module.exports = {
  addPullRequestReview,
  addPullRequestReviewWithBody,
  submitPullRequestReview,
  deletePullRequestReview,
  _internals: { resolveNumericReviewId, requirePRContext }
};
