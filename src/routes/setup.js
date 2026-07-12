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
const { expandPath, resolveBindingRepositoryFromPR } = require('../config');
const { resolvePreflightBinding } = require('../utils/host-resolution');
const { queryOne, ReviewRepository } = require('../database');
const { normalizeRepository } = require('../utils/paths');
const { rejectUrlLikeLocalReviewPath } = require('../utils/local-path-input');
const { parseScopeArg, VALID_SCOPE_RANGES } = require('../local-scope');
const logger = require('../utils/logger');

const router = express.Router();

// Terminal-state entries linger this long so a delegating CLI that finishes its
// own work slightly after setup completes can still read the result. Mirrors the
// activeAnalyses 30-minute auto-cleanup in src/routes/mcp.js.
const SETUP_STATUS_TTL_MS = 30 * 60 * 1000;

// Poll-friendly mirror of the `setup:{setupId}` WebSocket pushes. Keyed by
// setupId (the same UUID handed back to the client), value is the latest
// { status, reviewUrl?, reviewId?, error?, progress? } snapshot. The delegating
// CLI polls GET /api/setup/:setupId/status instead of opening a WebSocket, which
// sidesteps the missed-event race between "server returns setupId" and "CLI
// subscribes". Not exported: it is process-local runtime state, never persisted.
const setupStatuses = new Map();

/**
 * Record (or patch) the polling status for a setup operation. The first write
 * establishes the entry as `running`; later writes shallow-merge onto it. On a
 * terminal status (`complete`/`error`) an expiry timer is armed so the map does
 * not grow without bound — matching the activeAnalyses cleanup pattern.
 *
 * @param {string} setupId - Setup operation ID
 * @param {Object} patch - Partial status fields to merge (must include `status`
 *   on the first call; typically `{ status, reviewUrl?, reviewId?, error?, progress? }`)
 */
function setSetupStatus(setupId, patch) {
  const prev = setupStatuses.get(setupId) || {};
  const next = { ...prev, ...patch };
  setupStatuses.set(setupId, next);

  if (next.status === 'complete' || next.status === 'error') {
    // Do not let the cleanup timer keep the process alive; if the process is
    // exiting the map dies with it anyway.
    const timer = setTimeout(() => setupStatuses.delete(setupId), SETUP_STATUS_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

/**
 * Send a setup progress event via WebSocket AND update the polling status map so
 * both delivery channels stay in lock-step. Terminal events ('complete'/'error')
 * map to the polling states 'complete'/'error'; 'step' events refresh the
 * `progress` field but leave the status 'running'.
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

  if (eventType === 'complete') {
    setSetupStatus(setupId, {
      status: 'complete',
      reviewUrl: data.reviewUrl,
      reviewId: data.reviewId
    });
  } else if (eventType === 'error') {
    setSetupStatus(setupId, { status: 'error', error: data.message });
  } else if (eventType === 'step') {
    // Keep status 'running'; surface the human-readable step message as progress.
    setSetupStatus(setupId, { status: 'running', progress: data.message });
  }
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

    // Optional per-PR host override. Contract: `null` = github.com, an api_host
    // URL string = that alt host, absent/undefined = unknown (server derives via
    // stored host or a probe). A dashboard row (alt-host PR) and a URL paste both
    // send this so setup binds to the right system without probing. Reject other
    // shapes; the "must match the repo's api_host" check is enforced downstream
    // by resolveHostBinding (a mismatch surfaces as a setup error).
    const bodyHost = req.body ? req.body.host : undefined;
    if (bodyHost !== undefined && bodyHost !== null && typeof bodyHost !== 'string') {
      return res.status(400).json({ error: 'Invalid host: expected null or an api_host URL string' });
    }

    const db = req.app.get('db');
    const config = req.app.get('config');

    // GitHub token is required for PR setup. Resolve the binding key first so
    // monorepo-style `repos[...]` entries (matched via `url_pattern` named
    // captures) supply their per-repo token even when the captured owner/repo
    // differs from the config key.
    const repositoryForToken = resolveBindingRepositoryFromPR(owner, repo, config);
    // Preflight the credential. resolvePreflightBinding gates on ANY usable
    // binding — including a dual repo's alt-only token or a token pinned by an
    // explicit body host — so an alt-host setup isn't falsely 401'd.
    const preflightBinding = resolvePreflightBinding(repositoryForToken, config, bodyHost);
    if (!preflightBinding.token) {
      return res.status(401).json({ error: 'GitHub token not configured' });
    }
    // Split the two roles: the gate above accepts an alt token, but only a
    // github.com token may be forwarded downstream as the github FALLBACK.
    // resolvePrHostBinding can drop `githubToken` into a github.com client on the
    // 404 probe fallback (clientArgFor's github-flavored branch), so an alt token
    // must NEVER reach it — the CLI (main.js) applies the identical guard.
    const githubToken = preflightBinding.apiHost === null ? preflightBinding.token : '';

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
    // Seed the polling status so a CLI that polls immediately (before the first
    // 'step' WS push) still observes 'running' rather than a spurious 404.
    setSetupStatus(setupId, { status: 'running' });

    const promise = (async () => {
      try {
        const result = await setupPRReview({
          db,
          owner,
          repo,
          prNumber,
          githubToken,
          bindingRepository: repositoryForToken,
          config,
          host: bodyHost,
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
    const { path: rawPath, scope: rawScope, base: rawBase } = req.body;

    if (!rawPath) {
      return res.status(400).json({ error: 'Missing required field: path' });
    }

    try {
      rejectUrlLikeLocalReviewPath(rawPath);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Re-validate scope/base server-side — NEVER trust the delegated URL. Mirrors
    // the CLI checks in main() so a delegated launch is held to the same contract.
    let flags = {};
    if (rawScope !== undefined && rawScope !== null && rawScope !== '') {
      const parsed = parseScopeArg(rawScope);
      if (!parsed) {
        return res.status(400).json({
          error: `Invalid scope value "${rawScope}". Valid ranges are: ${VALID_SCOPE_RANGES.join(', ')}. ` +
            "The range must be two stops joined by '..' and must include 'unstaged'."
        });
      }
      flags.scope = rawScope;
      if (rawBase !== undefined && rawBase !== null && rawBase !== '') {
        // --base only applies to a branch-relative scope, and must be a safe branch name.
        if (parsed.start !== 'branch') {
          return res.status(400).json({
            error: "base requires a branch-relative scope (starting at 'branch', e.g. branch..untracked)."
          });
        }
        if (!/^[\w.\-/]+$/.test(rawBase)) {
          return res.status(400).json({ error: `Invalid base branch name "${rawBase}".` });
        }
        flags.base = rawBase;
      }
    } else if (rawBase !== undefined && rawBase !== null && rawBase !== '') {
      // base without scope is meaningless (mirrors main()'s "base requires branch scope").
      return res.status(400).json({
        error: "base requires a branch-relative scope (starting at 'branch', e.g. branch..untracked)."
      });
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
    // Seed the polling status so a CLI that polls immediately (before the first
    // 'step' WS push) still observes 'running' rather than a spurious 404.
    setSetupStatus(setupId, { status: 'running' });

    const promise = (async () => {
      try {
        const result = await setupLocalReview({
          db,
          targetPath,
          config: req.app.get('config') || {},
          flags,
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

// ---------------------------------------------------------------------------
// GET /api/setup/:setupId/status
// ---------------------------------------------------------------------------

/**
 * Poll the current status of a setup operation.
 *
 * The delegating CLI polls this instead of opening a WebSocket, avoiding the
 * missed-event race between receiving the setupId and subscribing. Returns the
 * latest snapshot recorded alongside the `setup:{setupId}` WS pushes. Unknown
 * ids (never started, or expired after their terminal-state TTL) → 404.
 */
router.get('/api/setup/:setupId/status', (req, res) => {
  const { setupId } = req.params;
  const status = setupStatuses.get(setupId);
  if (!status) {
    return res.status(404).json({ error: 'Setup not found' });
  }
  return res.json(status);
});

module.exports = router;
