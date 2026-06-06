// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../../../utils/logger');

/**
 * GraphQL implementation of the review-lifecycle area:
 *   - addPullRequestReview (with or without body)
 *   - submitPullRequestReview
 *   - deletePullRequestReview
 *
 * Each function takes an Octokit-like client as its first parameter.
 * Return shapes match what `GitHubClient` historically returned for these
 * primitives so callers (notably the orchestration in `createReviewGraphQL`
 * and `createDraftReviewGraphQL`) remain byte-identical.
 */

const ADD_REVIEW_MUTATION = `
  mutation AddPendingReview($prId: ID!) {
    addPullRequestReview(input: {
      pullRequestId: $prId
    }) {
      pullRequestReview {
        id
        databaseId
      }
    }
  }
`;

const ADD_REVIEW_WITH_BODY_MUTATION = `
  mutation AddPendingReview($prId: ID!, $body: String) {
    addPullRequestReview(input: {
      pullRequestId: $prId
      body: $body
    }) {
      pullRequestReview {
        id
        databaseId
        url
      }
    }
  }
`;

const SUBMIT_REVIEW_MUTATION = `
  mutation SubmitReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
    submitPullRequestReview(input: {
      pullRequestReviewId: $reviewId
      event: $event
      body: $body
    }) {
      pullRequestReview {
        id
        databaseId
        url
        state
      }
    }
  }
`;

const DELETE_REVIEW_MUTATION = `
  mutation DeleteReview($reviewId: ID!) {
    deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
      pullRequestReview { id }
    }
  }
`;

/**
 * Create a pending review (no body). Used by the submit-review flow that
 * passes the body later via `submitPullRequestReview`.
 *
 * Returns both the GraphQL node id (`id`) and the numeric database id
 * (`databaseId`). The numeric id is required by the orchestration in
 * `client.js` to address the same review via REST/host endpoints (e.g.
 * the host `addCommentsInBatches` extension, which is path-shaped).
 *
 * @param {Object} octokit
 * @param {string} prNodeId
 * @returns {Promise<{id: string, databaseId: number|null}>}
 */
async function addPullRequestReview(octokit, prNodeId) {
  const result = await octokit.graphql(ADD_REVIEW_MUTATION, { prId: prNodeId });
  const review = result.addPullRequestReview.pullRequestReview;
  return {
    id: review.id,
    databaseId: typeof review.databaseId === 'number' ? review.databaseId : null
  };
}

/**
 * Create a pending review with a body. Used by the draft-review flow which
 * persists the summary on the pending review itself.
 *
 * @param {Object} octokit
 * @param {string} prNodeId
 * @param {string|null} body
 * @returns {Promise<{id: string, databaseId: number|null, url: string}>}
 */
async function addPullRequestReviewWithBody(octokit, prNodeId, body) {
  const result = await octokit.graphql(ADD_REVIEW_WITH_BODY_MUTATION, {
    prId: prNodeId,
    body: body || null
  });
  const review = result.addPullRequestReview.pullRequestReview;
  return {
    id: review.id,
    databaseId: review.databaseId,
    url: review.url
  };
}

/**
 * Submit a pending review with the chosen event (APPROVE/REQUEST_CHANGES/COMMENT).
 *
 * @param {Object} octokit
 * @param {string} reviewId - GraphQL node ID of the pending review
 * @param {string} event - APPROVE | REQUEST_CHANGES | COMMENT
 * @param {string|null} body
 * @returns {Promise<{id: string, databaseId: number|null, url: string, state: string}>}
 */
async function submitPullRequestReview(octokit, reviewId, event, body) {
  const result = await octokit.graphql(SUBMIT_REVIEW_MUTATION, {
    reviewId,
    event,
    body: body || null
  });
  const review = result.submitPullRequestReview.pullRequestReview;
  return {
    id: review.id,
    databaseId: review.databaseId,
    url: review.url,
    state: review.state
  };
}

/**
 * Delete a pending review (cleanup on failure). Never throws; logs and
 * returns false on failure.
 *
 * @param {Object} octokit
 * @param {string} reviewId
 * @returns {Promise<boolean>}
 */
async function deletePullRequestReview(octokit, reviewId) {
  try {
    await octokit.graphql(DELETE_REVIEW_MUTATION, { reviewId });
    logger.info('Cleaned up pending review after failure');
    return true;
  } catch (cleanupError) {
    logger.warn(`Failed to clean up pending review: ${cleanupError.message}`);
    return false;
  }
}

module.exports = {
  addPullRequestReview,
  addPullRequestReviewWithBody,
  submitPullRequestReview,
  deletePullRequestReview
};
