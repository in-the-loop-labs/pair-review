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
 * callers depend on those fields for cleanup and error reporting. The
 * additive `posted` array maps successful aliases back to input indexes;
 * null means a transport failure left the subset unknown.
 */

const MIN_BATCH_SIZE = 1;
const DEFAULT_BATCH_SIZE = 10;

// Connection failures that happen before any request bytes reach GitHub.
// Octokit wraps fetch failures in a status-500 RequestError carrying only
// the original message, so match the code in the message as well.
const PRE_SEND_NETWORK_CODES = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/;
// GraphQL error messages that mean execution may have started.
const AMBIGUOUS_GRAPHQL_MESSAGE = /timeout|timed out|something went wrong/i;

/**
 * Whether a failed batch mutation can be re-sent without risk of adding
 * the same comments twice. Mutations are not idempotent: if GitHub ran
 * the first request and only the response was lost (timeout, reset, 5xx),
 * a retry duplicates every comment in the batch. So retry only failures
 * that show GitHub did not run the mutation:
 *  - the connection was never made (refused, DNS failure);
 *  - GitHub refused the request with a 4xx response;
 *  - a GraphQL error response with no `data` at all (errors raised before
 *    execution, per the GraphQL spec), unless it reports a timeout;
 *  - a complexity/size rejection (never one carried by a 5xx response or a
 *    failed fetch: those are judged by status and connection alone).
 * Anything carrying `data` (even null) ran at least partly and is never
 * re-sent; everything else is ambiguous and fails the batch.
 *
 * @param {Error} error - The error thrown by octokit.graphql
 * @returns {boolean} True if the batch can safely be sent again
 */
function isSafeToRetry(error) {
  if (!error) return false;
  if (error.data !== undefined) return false;

  const status = typeof error.status === 'number' ? error.status : null;
  const neverConnected = () => PRE_SEND_NETWORK_CODES.test(
    [error.code, error.cause && error.cause.code, error.message].filter(Boolean).join(' ')
  );
  // A real 5xx response: GitHub may have run the mutation, whatever the
  // message says (even one that looks like a complexity limit).
  if (error.response && status !== null && status >= 500) return false;
  // A status with no response is octokit's wrapper for a fetch failure;
  // only a connection that was never made is safe.
  if (!error.response && status !== null) return neverConnected();

  if (isComplexityError(error)) return true;

  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return !error.errors.some(e => AMBIGUOUS_GRAPHQL_MESSAGE.test((e && e.message) || ''));
  }

  // A real HTTP response means the request reached GitHub: only a 4xx
  // rejection is safe, whatever the message says.
  if (error.response) return status !== null && status >= 400 && status < 500;
  return neverConnected();
}

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
            thread { id comments(first: 1) { nodes { id fullDatabaseId url } } }
          }
        `;
    }

    const side = comment.side || 'RIGHT';
    // A range sends its start side too: GitHub defaults startSide to RIGHT,
    // which breaks a LEFT-side (deleted lines) range.
    const startLineField = comment.start_line
      ? `startLine: ${comment.start_line}\n            startSide: ${comment.start_side || side}\n            `
      : '';
    return `
          comment${index}: addPullRequestReviewThread(input: {
            pullRequestId: $prId
            pullRequestReviewId: $reviewId
            path: ${JSON.stringify(comment.path)}
            ${startLineField}line: ${comment.line}
            side: ${side}
            body: ${JSON.stringify(comment.body)}
          }) {
            thread { id comments(first: 1) { nodes { id fullDatabaseId url } } }
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
 * on GitHub complexity errors. Sequential, with at most one retry per
 * batch, and only when the failure shows GitHub did not run the mutation
 * (see isSafeToRetry).
 *
 * @param {Object} octokit - Octokit instance (must expose .graphql)
 * @param {string} prNodeId - GraphQL node ID for the PR
 * @param {string} reviewId - GraphQL node ID for the pending review
 * @param {Array} comments - Array of comments with path, line (optional), side, body, isFileLevel
 * @param {number} [batchSize=10] - Initial batch size
 * @returns {Promise<{successCount: number, failed: boolean, failedDetails: string[], posted: Array|null}>}
 */
async function addCommentsInBatches(octokit, prNodeId, reviewId, comments, batchSize = DEFAULT_BATCH_SIZE) {
  if (comments.length === 0) {
    return { successCount: 0, failed: false, failedDetails: [], posted: [] };
  }

  let currentBatchSize = batchSize;
  let remaining = comments.slice();
  let totalSuccessful = 0;
  const failedDetails = [];
  const posted = [];
  const recordPosted = (result, index) => {
    const comment = result.thread.comments?.nodes?.[0];
    posted.push({
      index,
      github_comment_id: comment?.fullDatabaseId != null ? String(comment.fullDatabaseId) : null,
      github_comment_node_id: comment?.id ?? null,
      github_comment_url: comment?.url ?? null
    });
  };
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

        // Inspect partial results before any retry, including complexity
        // retries. Replaying this mutation would duplicate successful aliases.
        // Stop this batch and report its exact subset to the orchestrator.
        if (error.data) break;

        // Complexity/cost limit: halve batch size and re-attempt. Only when
        // re-sending is safe: never after data (some comments may have
        // landed) or a 5xx response (the batch may have run).
        if (isComplexityError(error) && isSafeToRetry(error)) {
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

        if (!isSafeToRetry(error)) {
          logger.error(
            `Batch ${batchNumber} failed after GitHub may have applied it; not retrying ` +
            `so comments are not added twice: ${error.message}`
          );
          break;
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
            recordPosted(commentResult, comments.length - remaining.length + i);
          } else {
            const ghError = perCommentErrors[`comment${i}`] || 'No error details available';
            const location = `${batch[i].path}:${batch[i].line || 'file-level'}`;
            logger.warn(`Comment ${i} in batch ${batchNumber} failed to add: ${location} - ${ghError}`);
            failedDetails.push(`${location} - ${ghError}`);
          }
        }
        if (batchSuccessful < batch.length) {
          logger.error(`CRITICAL: Batch ${batchNumber} had ${batch.length - batchSuccessful} failures`);
          return { successCount: totalSuccessful + batchSuccessful, failed: true, failedDetails, posted };
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
        return { successCount: totalSuccessful, failed: true, failedDetails,
          posted: Array.isArray(batchError.errors) ? posted : null };
      }
    } else if (batchResult) {
      let batchSuccessful = 0;
      for (let i = 0; i < batch.length; i++) {
        const commentResult = batchResult[`comment${i}`];
        if (commentResult && commentResult.thread && commentResult.thread.id) {
          batchSuccessful++;
          recordPosted(commentResult, comments.length - remaining.length + i);
        } else {
          const location = `${batch[i].path}:${batch[i].line || 'file-level'}`;
          logger.warn(`Comment ${i} in batch ${batchNumber} failed to add: ${location} - No error details available`);
          failedDetails.push(`${location} - No error details available`);
        }
      }

      if (batchSuccessful < batch.length) {
        logger.error(`CRITICAL: Batch ${batchNumber} had ${batch.length - batchSuccessful} failures`);
        return { successCount: totalSuccessful + batchSuccessful, failed: true, failedDetails, posted };
      }

      totalSuccessful += batchSuccessful;
      logger.info(`Batch ${batchNumber} complete: ${batchSuccessful} comments added`);
    }

    remaining = remaining.slice(batch.length);
  }

  logger.info(`All batches complete: ${totalSuccessful} total comments added`);
  return { successCount: totalSuccessful, failed: false, failedDetails, posted };
}

module.exports = {
  addCommentsInBatches,
  buildBatchMutation,
  isSafeToRetry,
  MIN_BATCH_SIZE,
  DEFAULT_BATCH_SIZE
};
