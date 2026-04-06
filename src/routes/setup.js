// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Setup Routes
 *
 * Provides API endpoints for the auto-create review flow with WebSocket
 * progress updates. Supports both PR-based and local review setup.
 *
 * Endpoints:
 * - POST /api/setup/pr/:owner/:repo/:number  - Start PR review setup
 * - POST /api/setup/local                     - Start local review setup
 */

const express = require('express');
const crypto = require('crypto');
const { activeSetups, broadcastSetupProgress } = require('./shared');
const { setupPRReview } = require('../setup/pr-setup');
const { setupLocalReview } = require('../setup/local-setup');
const { getGitHubToken, expandPath } = require('../config');
const { queryOne, ReviewRepository } = require('../database');
const { normalizeRepository } = require('../utils/paths');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Send a setup progress event via WebSocket.
 *
 * Converts the named event pattern to a WebSocket message with a `type`
 * field so the client can dispatch on `msg.type` (e.g. 'step', 'complete', 'error').
 *
 * @param {string} setupId - Setup operation ID
 * @param {string} eventType - Event type (e.g. 'step', 'complete', 'error')
 * @param {Object} data - JSON-serialisable payload
 */
function sendSetupEvent(setupId, eventType, data) {
  broadcastSetupProgress(setupId, { type: eventType, ...data });
}

// ---------------------------------------------------------------------------
// POST /api/setup/pr/:owner/:repo/:number
// ---------------------------------------------------------------------------

/**
 * Initiate an asynchronous PR review setup.
 *
 * Returns immediately with a { setupId } that the client uses to subscribe
 * to WebSocket progress events. If setup is already in-flight for this PR, the
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
      'SELECT id, pr_data FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
      [prNumber, repository]
    );
    if (existingPR) {
      const worktree = await queryOne(
        db,
        'SELECT id FROM worktrees WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
        [prNumber, repository]
      );
      if (worktree) {
        // If the worktree belongs to the pool, verify it is still actively
        // owned (in_use). Pool slots retain their worktrees row after being
        // released — markAvailable() clears ownership without deleting the
        // record. A released slot may have been reassigned to a different PR,
        // so we must fall through to re-run setup and reacquire a pool slot.
        const poolLifecycle = req.app.get('poolLifecycle');
        const poolEntry = poolLifecycle ? await poolLifecycle.poolRepo.getPoolEntry(worktree.id) : null;
        if (poolEntry && poolEntry.status !== 'in_use') {
          if (poolEntry.status === 'available' && poolEntry.current_pr_number === prNumber) {
            // Still associated with this PR — reclaim without re-setup
            logger.info(`Reclaiming pool worktree ${worktree.id} for ${repository} #${prNumber} (was ${poolEntry.status})`);
            await poolLifecycle.poolRepo.markInUse(poolEntry.id, prNumber);
            const reviewRepo = new ReviewRepository(db);
            const { review } = await reviewRepo.getOrCreate({ prNumber, repository });
            await poolLifecycle.poolRepo.setCurrentReviewId(poolEntry.id, review.id);
            return res.json({ existing: true, reviewUrl: `/pr/${owner}/${repo}/${prNumber}` });
          }
          logger.info(`Pool worktree ${worktree.id} for ${repository} #${prNumber} is ${poolEntry.status}, re-running setup to reacquire`);
        } else {
          return res.json({ existing: true, reviewUrl: `/pr/${owner}/${repo}/${prNumber}` });
        }
      } else {
        logger.info(`PR metadata exists but worktree missing for ${repository} #${prNumber}, re-running setup`);
      }
    }

    // If we have stored PR data with a head_sha, pass it to setupPRReview
    // so it can attempt restore mode (skip GitHub fetch + diff regeneration).
    let restoreMetadata = null;
    if (existingPR && existingPR.pr_data) {
      try {
        const parsed = JSON.parse(existingPR.pr_data);
        if (parsed.head_sha) {
          restoreMetadata = parsed;
        }
      } catch (e) {
        logger.warn(`Could not parse stored pr_data for ${repository} #${prNumber}`);
      }
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
          poolLifecycle: req.app.get('poolLifecycle'),
          restoreMetadata,
          onProgress: (progress) => {
            sendSetupEvent(setupId, 'step', progress);
          }
        });

        sendSetupEvent(setupId, 'complete', { reviewUrl: result.reviewUrl, title: result.title });
      } catch (err) {
        logger.error(`PR setup failed for ${setupKey}:`, err);
        sendSetupEvent(setupId, 'error', { message: err.message });
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
// POST /api/setup/local
// ---------------------------------------------------------------------------

/**
 * Initiate an asynchronous local review setup.
 *
 * Expects JSON body `{ path }` with the local directory to review. Returns
 * `{ setupId }` for the client to subscribe to WebSocket progress events.
 */
router.post('/api/setup/local', async (req, res) => {
  try {
    const { path: rawPath } = req.body;

    if (!rawPath) {
      return res.status(400).json({ error: 'Missing required field: path' });
    }

    const targetPath = expandPath(rawPath);
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
          config: req.app.get('config') || {},
          onProgress: (progress) => {
            sendSetupEvent(setupId, 'step', progress);
          }
        });

        sendSetupEvent(setupId, 'complete', {
          reviewUrl: result.reviewUrl,
          reviewId: result.reviewId,
          existing: result.existing,
          branch: result.branch,
          repository: result.repository
        });
      } catch (err) {
        logger.error(`Local setup failed for ${setupKey}:`, err);
        sendSetupEvent(setupId, 'error', { message: err.message });
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

module.exports = router;
