// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
'use strict';

const logger = require('../utils/logger');

const GRACE_PERIOD_MS = 30_000; // 30 seconds after last WS disconnect

/**
 * In-memory tracker that determines whether a pool worktree is "in use".
 *
 * A pool worktree is considered in-use when any of:
 * - At least one WebSocket session is subscribed to its review topic
 * - An AI analysis is running against it
 * - The grace period after the last session disconnect hasn't expired
 *
 * When a worktree becomes idle (all of the above are false), the `onIdle`
 * callback fires so the pool manager can mark it available.
 */
class WorktreePoolUsageTracker {
  constructor() {
    /** @type {Map<string, Set<string>>} worktreeId -> Set of active session keys */
    this._sessions = new Map();
    /** @type {Map<string, Set<string>>} worktreeId -> Set of active analysis IDs */
    this._analyses = new Map();
    /** @type {Map<string, NodeJS.Timeout>} worktreeId -> grace period timer */
    this._graceTimers = new Map();
    /** @type {Function|null} Callback when a worktree becomes idle: (worktreeId) => void */
    this.onIdle = null;
  }

  /**
   * Register an active WebSocket session for a worktree.
   * Clears any pending grace-period timer.
   * @param {string} worktreeId - Pool worktree ID
   * @param {string} sessionKey - Unique key for this WS connection
   */
  addSession(worktreeId, sessionKey) {
    if (!this._sessions.has(worktreeId)) {
      this._sessions.set(worktreeId, new Set());
    }
    this._sessions.get(worktreeId).add(sessionKey);

    // Cancel any pending grace timer
    const timer = this._graceTimers.get(worktreeId);
    if (timer) {
      clearTimeout(timer);
      this._graceTimers.delete(worktreeId);
      logger.debug(`Grace period cancelled for pool worktree ${worktreeId} — new session connected`);
    }
  }

  /**
   * Remove a WebSocket session. Starts grace period if no sessions remain
   * and no analyses are running.
   * @param {string} worktreeId
   * @param {string} sessionKey
   */
  removeSession(worktreeId, sessionKey) {
    const sessions = this._sessions.get(worktreeId);
    if (!sessions) return;

    sessions.delete(sessionKey);
    if (sessions.size === 0) {
      this._sessions.delete(worktreeId);
    }

    this._checkIdle(worktreeId);
  }

  /**
   * Register an active analysis for a worktree.
   * Clears any pending grace-period timer.
   * @param {string} worktreeId - Pool worktree ID
   * @param {string} analysisId - Unique analysis identifier
   */
  addAnalysis(worktreeId, analysisId) {
    if (!this._analyses.has(worktreeId)) {
      this._analyses.set(worktreeId, new Set());
    }
    this._analyses.get(worktreeId).add(analysisId);

    // Cancel any pending grace timer
    const timer = this._graceTimers.get(worktreeId);
    if (timer) {
      clearTimeout(timer);
      this._graceTimers.delete(worktreeId);
      logger.debug(`Grace period cancelled for pool worktree ${worktreeId} — new analysis started`);
    }
  }

  /**
   * Remove an active analysis hold.
   * @param {string} worktreeId
   * @param {string} analysisId
   */
  removeAnalysis(worktreeId, analysisId) {
    const analyses = this._analyses.get(worktreeId);
    if (!analyses) return;

    analyses.delete(analysisId);
    if (analyses.size === 0) {
      this._analyses.delete(worktreeId);
    }

    this._checkIdle(worktreeId);
  }

  /**
   * Remove an analysis hold by analysisId only (without knowing worktreeId).
   * Searches all worktrees for the analysis.
   * @param {string} analysisId
   */
  removeAnalysisById(analysisId) {
    for (const [worktreeId, analyses] of this._analyses) {
      if (analyses.has(analysisId)) {
        this.removeAnalysis(worktreeId, analysisId);
        return;
      }
    }
  }

  /**
   * Check if a worktree is currently in use.
   * @param {string} worktreeId
   * @returns {boolean}
   */
  isInUse(worktreeId) {
    const hasSessions = (this._sessions.get(worktreeId)?.size || 0) > 0;
    const hasAnalyses = (this._analyses.get(worktreeId)?.size || 0) > 0;
    const hasGraceTimer = this._graceTimers.has(worktreeId);
    return hasSessions || hasAnalyses || hasGraceTimer;
  }

  /**
   * Return the set of active analysis IDs for a worktree (may be empty).
   * @param {string} worktreeId
   * @returns {Set<string>}
   */
  getActiveAnalyses(worktreeId) {
    return new Set(this._analyses.get(worktreeId) || []);
  }

  /**
   * Forcefully clear all tracking state for a single worktree.
   *
   * Removes sessions, analyses, and grace timers.
   * Does NOT fire the onIdle callback — the caller is assumed to be
   * handling the worktree lifecycle directly (e.g., deleting or
   * marking it available in the pool).
   *
   * @param {string} worktreeId - Pool worktree ID to purge
   */
  clearWorktree(worktreeId) {
    this._sessions.delete(worktreeId);
    this._analyses.delete(worktreeId);
    const timer = this._graceTimers.get(worktreeId);
    if (timer) {
      clearTimeout(timer);
      this._graceTimers.delete(worktreeId);
    }
    logger.debug(`Cleared all tracking state for pool worktree ${worktreeId}`);
  }

  /**
   * Internal: check if a worktree has become idle and start grace period or fire callback.
   * @param {string} worktreeId
   * @private
   */
  _checkIdle(worktreeId) {
    const hasSessions = (this._sessions.get(worktreeId)?.size || 0) > 0;
    const hasAnalyses = (this._analyses.get(worktreeId)?.size || 0) > 0;

    if (hasSessions || hasAnalyses) return; // still in use

    // Already have a grace timer? Let it run
    if (this._graceTimers.has(worktreeId)) return;

    // Start grace period
    logger.debug(`Starting ${GRACE_PERIOD_MS / 1000}s grace period for pool worktree ${worktreeId}`);
    const timer = setTimeout(async () => {
      this._graceTimers.delete(worktreeId);
      // Double-check still idle (a new session could have connected during grace)
      const stillHasSessions = (this._sessions.get(worktreeId)?.size || 0) > 0;
      const stillHasAnalyses = (this._analyses.get(worktreeId)?.size || 0) > 0;
      if (!stillHasSessions && !stillHasAnalyses) {
        logger.info(`Pool worktree ${worktreeId} idle after grace period`);
        if (this.onIdle) {
          try {
            await this.onIdle(worktreeId);
          } catch (err) {
            logger.error(`onIdle callback failed for ${worktreeId}: ${err.message}`);
          }
        }
      }
    }, GRACE_PERIOD_MS);

    // Don't hold the process open for grace timers
    if (timer.unref) timer.unref();
    this._graceTimers.set(worktreeId, timer);
  }

  /**
   * Clear all tracking state. Useful for testing.
   */
  reset() {
    this._sessions.clear();
    this._analyses.clear();
    for (const timer of this._graceTimers.values()) {
      clearTimeout(timer);
    }
    this._graceTimers.clear();
    this.onIdle = null;
  }
}

// Singleton instance
const worktreePoolUsage = new WorktreePoolUsageTracker();

module.exports = { worktreePoolUsage, WorktreePoolUsageTracker, GRACE_PERIOD_MS };
