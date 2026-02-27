// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Review-scoped event broadcaster.
 *
 * Broadcasts review-level events (comment mutations, analysis completion, etc.)
 * to all WebSocket clients subscribed to the `review:{reviewId}` topic.
 */

const ws = require('../ws');

/**
 * Broadcast a review-scoped event via WebSocket to all clients
 * subscribed to `review:{reviewId}`.
 * Optionally includes a `sourceClientId` so the originating browser tab
 * can recognise (and skip) its own echo.
 *
 * @param {number} reviewId - Review ID to include in the event
 * @param {Object} payload - Event data (must include at minimum a `type` field)
 * @param {Object} [options]
 * @param {string} [options.sourceClientId] - Client ID of the tab that triggered the mutation
 */
function broadcastReviewEvent(reviewId, payload, options = {}) {
  const envelope = { ...payload, reviewId };
  if (options.sourceClientId) {
    envelope.sourceClientId = options.sourceClientId;
  }
  ws.broadcast('review:' + reviewId, envelope);
}

module.exports = { broadcastReviewEvent };
