// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared SSE client registry and review-scoped event broadcaster.
 *
 * All SSE connections (chat, analysis, etc.) share a single Set of
 * Express response objects.  broadcastReviewEvent sends review-level
 * events (as opposed to session-level events handled in chat.js).
 */

const logger = require('../utils/logger');

/**
 * Connected SSE clients shared across all route modules.
 * Each entry is an Express response object with an open SSE connection.
 * @type {Set<import('express').Response>}
 */
const sseClients = new Set();

/**
 * Broadcast a review-scoped SSE event to all connected clients.
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
  const data = JSON.stringify(envelope);
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      // Client disconnected — remove from set
      sseClients.delete(client);
      logger.debug('[ReviewEvents] Removed disconnected SSE client');
    }
  }
}

module.exports = { sseClients, broadcastReviewEvent };
