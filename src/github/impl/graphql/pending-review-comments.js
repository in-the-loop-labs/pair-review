// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../../../utils/logger');
const { isComplexityError } = require('../../errors');

/**
 * GraphQL implementation of the pending-review-comments area.
 *
 * Adds inline comments (line-level, range-level, and file-level) to an
 * already-pending review. Uses the `addPullRequestReviewThread` mutation
 * batched together for throughput, with adaptive batch sizing that halves
 * on GitHub complexity errors.
 *
 * The return shape (success count, failed flag, failedDetails) is the
 * same shape `GitHubClient.addCommentsInBatches` historically returned;
 * callers depend on that exact shape for cleanup and error reporting.
 */

const MIN_BATCH_SIZE = 1;
const DEFAULT_BATCH_SIZE = 10;

/**
 * Build the GraphQL mutation text for a batch of comments. Aliases each
 * inner mutation as `comment0`, `comment1`, ... so partial-failure paths
 * can map errors back to individual comments via `error.path[0]`.
 *
 * @param {Array} batch - Slice of comments to include in this mutation
 * @returns {string} The full mutation text
 */
function buildBatchMutation(batch) {
  const commentMutations = batch.map((comment, index) => {
    const isFileLevel = comment.isFileLevel || !comment.line;

    if (isFileLevel) {
      return `
          comment${index}: addPullRequestReviewThread(input: {
            pullRequestId: $prId
            pullRequestReviewId: $reviewId
            path: ${JSON.stringify(comment.path)}
            subjectType: FILE
            body: ${JSON.stringify(comment.body)}
          }) {
            thread { id }
          }
        `;
    }

    const side = comment.side || 'RIGHT';
    const startLineField = comment.start_line ? `startLine: ${comment.start_line}\n                ` : '';
    return `
          comment${index}: addPullRequestReviewThread(input: {
            pullRequestId: $prId
            pullRequestReviewId: $reviewId
            path: ${JSON.stringify(comment.path)}
            ${startLineField}line: ${comment.line}
            side: ${side}
            body: ${JSON.stringify(comment.body)}
          }) {
            thread { id }
          }
        `;
  }).join('\n');

  return `
      mutation AddReviewComments($prId: ID!, $reviewId: ID!) {
        ${commentMutations}
      }
    `;
}

/**
 * Add comments to a pending review in batches, with adaptive batch sizing
 * on GitHub complexity errors. Sequential, with one retry per batch.
 *
 * @param {Object} octokit - Octokit instance (must expose .graphql)
 * @param {string} prNodeId - GraphQL node ID for the PR
 * @param {string} reviewId - GraphQL node ID for the pending review
 * @param {Array} comments - Array of comments with path, line (optional), side, body, isFileLevel
 * @param {number} [batchSize=10] - Initial batch size
 * @returns {Promise<{successCount: number, failed: boolean, failedDetails: string[]}>}
 */
async function addCommentsInBatches(octokit, prNodeId, reviewId, comments, batchSize = DEFAULT_BATCH_SIZE) {
  if (comments.length === 0) {
    return { successCount: 0, failed: false, failedDetails: [] };
  }

  let currentBatchSize = batchSize;
  let remaining = comments.slice();
  let totalSuccessful = 0;
  const failedDetails = [];
  let batchNumber = 0;

  logger.info(`Adding ${comments.length} comments in batches of up to ${currentBatchSize}`);

  while (remaining.length > 0) {
    batchNumber++;
    const batch = remaining.slice(0, currentBatchSize);
    logger.info(`Adding comments batch ${batchNumber} (${batch.length} comments, ${remaining.length} remaining)...`);

    const batchMutation = buildBatchMutation(batch);

    // Try the batch, with one retry on failure
    let batchResult = null;
    let batchError = null;
    let retryAttempt = 0;
    const maxRetries = 1;
    let reducedBatchSize = false;

    while (retryAttempt <= maxRetries) {
      try {
        batchResult = await octokit.graphql(batchMutation, {
          prId: prNodeId,
          reviewId
        });
        batchError = null;
        break;
      } catch (error) {
        batchError = error;

        // Complexity/cost limit: halve batch size and re-attempt
        if (isComplexityError(error)) {
          const newSize = Math.max(MIN_BATCH_SIZE, Math.floor(currentBatchSize / 2));
          if (newSize < currentBatchSize) {
            logger.warn(
              `Batch ${batchNumber} hit complexity limit (size ${currentBatchSize}), ` +
              `reducing batch size to ${newSize}`
            );
            currentBatchSize = newSize;
            reducedBatchSize = true;
            break;
          }
          // Already at the minimum - fall through to normal retry logic
        }

        if (retryAttempt < maxRetries) {
          logger.warn(`Batch ${batchNumber} failed, retrying... (${error.message})`);
          retryAttempt++;
          // Fixed 1-second delay before a single retry. Backoff has no benefit
          // with maxRetries=1; either it works on retry or we clean up.
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          logger.error(`Batch ${batchNumber} failed after retry: ${error.message}`);
          break;
        }
      }
    }

    if (reducedBatchSize) {
      // Re-attempt the same remaining slice with the smaller batch size.
      continue;
    }

    if (batchError) {
      // Build a map of per-comment errors from the GraphQL errors array.
      // Each GraphQL error has a `path` like ["comment0"] that maps to the
      // mutation alias, letting us match errors to specific comments.
      const perCommentErrors = {};
      if (batchError.errors && Array.isArray(batchError.errors)) {
        for (const err of batchError.errors) {
          if (err.path && err.path.length > 0) {
            const alias = err.path[0];
            perCommentErrors[alias] = err.message || 'Unknown error';
          }
        }
      }

      if (batchError.data) {
        logger.warn(`GraphQL returned partial results with errors: ${JSON.stringify(batchError.errors || batchError.message)}`);
        let batchSuccessful = 0;
        for (let i = 0; i < batch.length; i++) {
          const commentResult = batchError.data[`comment${i}`];
          if (commentResult && commentResult.thread && commentResult.thread.id) {
            batchSuccessful++;
          } else {
            const ghError = perCommentErrors[`comment${i}`] || 'No error details available';
            const location = `${batch[i].path}:${batch[i].line || 'file-level'}`;
            logger.warn(`Comment ${i} in batch ${batchNumber} failed to add: ${location} - ${ghError}`);
            failedDetails.push(`${location} - ${ghError}`);
          }
        }
        if (batchSuccessful < batch.length) {
          logger.error(`CRITICAL: Batch ${batchNumber} had ${batch.length - batchSuccessful} failures`);
          return { successCount: totalSuccessful + batchSuccessful, failed: true, failedDetails };
        }
        logger.info(`Batch ${batchNumber} complete (recovered from partial error): ${batchSuccessful} comments added`);
        totalSuccessful += batchSuccessful;
      } else {
        const totalError = batchError.message || 'Unknown error';
        logger.error(`CRITICAL: Batch ${batchNumber} failed completely: ${totalError}`);
        for (let i = 0; i < batch.length; i++) {
          const ghError = perCommentErrors[`comment${i}`] || totalError;
          const location = `${batch[i].path}:${batch[i].line || 'file-level'}`;
          failedDetails.push(`${location} - ${ghError}`);
        }
        return { successCount: totalSuccessful, failed: true, failedDetails };
      }
    } else if (batchResult) {
      let batchSuccessful = 0;
      for (let i = 0; i < batch.length; i++) {
        const commentResult = batchResult[`comment${i}`];
        if (commentResult && commentResult.thread && commentResult.thread.id) {
          batchSuccessful++;
        } else {
          const location = `${batch[i].path}:${batch[i].line || 'file-level'}`;
          logger.warn(`Comment ${i} in batch ${batchNumber} failed to add: ${location} - No error details available`);
          failedDetails.push(`${location} - No error details available`);
        }
      }

      if (batchSuccessful < batch.length) {
        logger.error(`CRITICAL: Batch ${batchNumber} had ${batch.length - batchSuccessful} failures`);
        return { successCount: totalSuccessful + batchSuccessful, failed: true, failedDetails };
      }

      totalSuccessful += batchSuccessful;
      logger.info(`Batch ${batchNumber} complete: ${batchSuccessful} comments added`);
    }

    remaining = remaining.slice(batch.length);
  }

  logger.info(`All batches complete: ${totalSuccessful} total comments added`);
  return { successCount: totalSuccessful, failed: false, failedDetails };
}

module.exports = {
  addCommentsInBatches,
  buildBatchMutation,
  MIN_BATCH_SIZE,
  DEFAULT_BATCH_SIZE
};
