// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../../../utils/logger');
const { GitHubApiError } = require('../../errors');

/**
 * GraphQL implementation of the pending-review-check area.
 *
 * Provides:
 *   - getPendingReviewForUser(owner, repo, prNumber)
 *   - getReviewById(nodeId)
 *
 * Each function takes an Octokit-like client as its first parameter and
 * returns the same shape `GitHubClient` historically returned.
 */

const PENDING_REVIEW_QUERY = `
  query($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviews(states: PENDING, first: 1) {
          nodes {
            id
            databaseId
            body
            url
            state
            createdAt
            viewerDidAuthor
            comments {
              totalCount
            }
          }
        }
      }
    }
  }
`;

const REVIEW_BY_ID_QUERY = `
  query($nodeId: ID!) {
    node(id: $nodeId) {
      ... on PullRequestReview {
        id
        state
        submittedAt
        url
      }
    }
  }
`;

/**
 * GitHub allows only ONE pending review per user per PR, so this returns
 * either the single pending review or null if none exists.
 *
 * @param {Object} octokit - Octokit instance (must expose .graphql)
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - Pull request number
 * @returns {Promise<Object|null>} The pending review object or null
 */
async function getPendingReviewForUser(octokit, owner, repo, prNumber) {
  try {
    logger.debug(`Checking for pending review on PR #${prNumber} in ${owner}/${repo}`);

    const result = await octokit.graphql(PENDING_REVIEW_QUERY, {
      owner,
      repo,
      prNumber
    });

    const reviews = result.repository?.pullRequest?.reviews?.nodes || [];
    const userPendingReview = reviews.find(review => review.viewerDidAuthor);

    if (userPendingReview) {
      logger.debug(`Found pending review for user: ${userPendingReview.id} with ${userPendingReview.comments.totalCount} comments`);
      return {
        id: userPendingReview.id,
        databaseId: userPendingReview.databaseId,
        body: userPendingReview.body,
        url: userPendingReview.url,
        state: userPendingReview.state,
        createdAt: userPendingReview.createdAt,
        comments: {
          totalCount: userPendingReview.comments.totalCount
        }
      };
    }

    logger.debug('No pending review found for user');
    return null;
  } catch (error) {
    logger.error(`Error checking for pending review: ${error.message}`);

    if (error.status === 401) {
      throw new GitHubApiError('GitHub authentication failed. Check your token in ~/.pair-review/config.json', 401);
    }

    if (error.status === 404 || error.errors?.some(e => e.type === 'NOT_FOUND')) {
      throw new GitHubApiError(`Pull request #${prNumber} not found in repository ${owner}/${repo}`, 404);
    }

    if (error.errors) {
      const messages = error.errors.map(e => e.message).join(', ');
      throw new Error(`GitHub GraphQL error: ${messages}`);
    }

    throw new Error(`Failed to check for pending review: ${error.message}`);
  }
}

/**
 * Fetch a review by its GraphQL node ID.
 *
 * @param {Object} octokit - Octokit instance (must expose .graphql)
 * @param {string} nodeId - GraphQL node ID for the review
 * @returns {Promise<Object|null>} Review data or null if not found
 */
async function getReviewById(octokit, nodeId) {
  try {
    logger.debug(`Fetching review by node ID: ${nodeId}`);

    const result = await octokit.graphql(REVIEW_BY_ID_QUERY, { nodeId });

    if (!result.node || !result.node.id) {
      logger.debug(`Review not found for node ID: ${nodeId}`);
      return null;
    }

    const review = result.node;
    logger.debug(`Found review ${nodeId}: state=${review.state}, submittedAt=${review.submittedAt}`);

    return {
      id: review.id,
      state: review.state,
      submittedAt: review.submittedAt,
      url: review.url
    };
  } catch (error) {
    if (error.errors?.some(e => e.type === 'NOT_FOUND' || e.message?.includes('not found'))) {
      logger.debug(`Review not found for node ID: ${nodeId}`);
      return null;
    }

    logger.warn(`Error fetching review by node ID ${nodeId}: ${error.message}`);
    return null;
  }
}

module.exports = {
  getPendingReviewForUser,
  getReviewById
};
