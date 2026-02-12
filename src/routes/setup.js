// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Setup Routes
 *
 * Provides API endpoints for the auto-create review flow with SSE progress
 * updates. Supports both PR-based and local review setup.
 *
 * Endpoints:
 * - POST /api/setup/pr/:owner/:repo/:number  - Start PR review setup
 * - GET  /api/setup/pr/:owner/:repo/:number/progress - SSE progress for PR setup
 * - POST /api/setup/local                     - Start local review setup
 * - GET  /api/setup/local/:setupId/progress   - SSE progress for local setup
 */

const express = require('express');
const crypto = require('crypto');
const { activeSetups, setupProgressClients, broadcastSetupProgress } = require('./shared');
const { setupPRReview } = require('../setup/pr-setup');
const { setupLocalReview } = require('../setup/local-setup');
const { getGitHubToken } = require('../config');
const { queryOne } = require('../database');
const { normalizeRepository } = require('../utils/paths');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Send a named SSE event to all clients listening for a given setupId.
 *
 * Unlike broadcastSetupProgress (which sends unnamed `data:` lines), this
 * helper emits SSE named events (`event: <type>\n`) so the frontend
 * EventSource `addEventListener(type, ...)` listeners fire correctly.
 *
 * @param {string} setupId - Setup operation ID
 * @param {string} eventType - SSE event name (e.g. 'step', 'complete', 'error')
 * @param {Object} data - JSON-serialisable payload
 */
function sendSetupSSE(setupId, eventType, data) {
  const clients = setupProgressClients.get(setupId);
  if (clients && clients.size > 0) {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => {
      try {
        client.write(message);
      } catch (e) {
        clients.delete(client);
      }
    });
    if (clients.size === 0) {
      setupProgressClients.delete(setupId);
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/setup/pr/:owner/:repo/:number
// ---------------------------------------------------------------------------

/**
 * Initiate an asynchronous PR review setup.
 *
 * Returns immediately with a { setupId } that the client uses to subscribe
 * to SSE progress events. If setup is already in-flight for this PR, the
 * existing setupId is returned. If the PR already exists in the database the
 * response includes `{ existing: true, reviewUrl }` so the client can
 * navigate directly.
 */
router.post('/api/setup/pr/:owner/:repo/:number', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;

    // Validate params
    const prNumber = parseInt(number, 10);
    if (!owner || !repo || isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({ error: 'Invalid owner, repo, or PR number' });
    }

    const db = req.app.get('db');
    const config = req.app.get('config');

    // GitHub token is required for PR setup
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }

    // Concurrency guard: if a setup is already running for this PR, return its ID
    const setupKey = `pr:${owner}/${repo}/${prNumber}`;
    const existing = activeSetups.get(setupKey);
    if (existing) {
      return res.json({ setupId: existing.setupId });
    }

    // Check if we already have data AND a worktree for this PR in the database.
    // When a user deletes a worktree, PR metadata is preserved but the worktree
    // record is removed. We must re-run setup to recreate the worktree.
    const repository = normalizeRepository(owner, repo);
    const existingPR = await queryOne(
      db,
      'SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
      [prNumber, repository]
    );
    if (existingPR) {
      const worktree = await queryOne(
        db,
        'SELECT id FROM worktrees WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
        [prNumber, repository]
      );
      if (worktree) {
        return res.json({ existing: true, reviewUrl: `/pr/${owner}/${repo}/${prNumber}` });
      }
      logger.info(`PR metadata exists but worktree missing for ${repository} #${prNumber}, re-running setup`);
    }

    // Start the async setup
    const setupId = crypto.randomUUID();

    const promise = (async () => {
      try {
        const result = await setupPRReview({
          db,
          owner,
          repo,
          prNumber,
          githubToken,
          config,
          onProgress: (progress) => {
            sendSetupSSE(setupId, 'step', progress);
          }
        });

        sendSetupSSE(setupId, 'complete', { reviewUrl: result.reviewUrl, title: result.title });
      } catch (err) {
        logger.error(`PR setup failed for ${setupKey}:`, err);
        sendSetupSSE(setupId, 'error', { message: err.message });
      } finally {
        activeSetups.delete(setupKey);
      }
    })();

    activeSetups.set(setupKey, { setupId, promise });

    return res.json({ setupId });
  } catch (err) {
    logger.error('Error in POST /api/setup/pr:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/setup/pr/:owner/:repo/:number/progress
// ---------------------------------------------------------------------------

/**
 * SSE endpoint for streaming PR setup progress to the client.
 *
 * The client must pass `?setupId=<id>` as a query parameter (returned from
 * the POST endpoint above).
 */
router.get('/api/setup/pr/:owner/:repo/:number/progress', (req, res) => {
  const { setupId } = req.query;

  if (!setupId) {
    return res.status(400).json({ error: 'Missing setupId query parameter' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Register this client
  if (!setupProgressClients.has(setupId)) {
    setupProgressClients.set(setupId, new Set());
  }
  setupProgressClients.get(setupId).add(res);

  // Clean up on disconnect
  req.on('close', () => {
    const clients = setupProgressClients.get(setupId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        setupProgressClients.delete(setupId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/setup/local
// ---------------------------------------------------------------------------

/**
 * Initiate an asynchronous local review setup.
 *
 * Expects JSON body `{ path }` with the local directory to review. Returns
 * `{ setupId }` for the client to subscribe to SSE progress events.
 */
router.post('/api/setup/local', async (req, res) => {
  try {
    const { path: targetPath } = req.body;

    if (!targetPath) {
      return res.status(400).json({ error: 'Missing required field: path' });
    }

    const db = req.app.get('db');

    // Concurrency guard
    const setupKey = `local:${targetPath}`;
    const existing = activeSetups.get(setupKey);
    if (existing) {
      return res.json({ setupId: existing.setupId });
    }

    const setupId = crypto.randomUUID();

    const promise = (async () => {
      try {
        const result = await setupLocalReview({
          db,
          targetPath,
          onProgress: (progress) => {
            sendSetupSSE(setupId, 'step', progress);
          }
        });

        sendSetupSSE(setupId, 'complete', {
          reviewUrl: result.reviewUrl,
          reviewId: result.reviewId,
          existing: result.existing,
          branch: result.branch,
          repository: result.repository
        });
      } catch (err) {
        logger.error(`Local setup failed for ${setupKey}:`, err);
        sendSetupSSE(setupId, 'error', { message: err.message });
      } finally {
        activeSetups.delete(setupKey);
      }
    })();

    activeSetups.set(setupKey, { setupId, promise });

    return res.json({ setupId });
  } catch (err) {
    logger.error('Error in POST /api/setup/local:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/setup/local/:setupId/progress
// ---------------------------------------------------------------------------

/**
 * SSE endpoint for streaming local review setup progress to the client.
 */
router.get('/api/setup/local/:setupId/progress', (req, res) => {
  const { setupId } = req.params;

  if (!setupId) {
    return res.status(400).json({ error: 'Missing setupId parameter' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Register this client
  if (!setupProgressClients.has(setupId)) {
    setupProgressClients.set(setupId, new Set());
  }
  setupProgressClients.get(setupId).add(res);

  // Clean up on disconnect
  req.on('close', () => {
    const clients = setupProgressClients.get(setupId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        setupProgressClients.delete(setupId);
      }
    }
  });
});

module.exports = router;
