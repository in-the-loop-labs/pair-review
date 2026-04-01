// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * In-memory worktree lock manager.
 *
 * Prevents concurrent git operations on the same worktree during
 * stack analysis. Non-blocking — callers check and fail fast.
 */

const logger = require('../utils/logger');

class WorktreeLockManager {
  constructor() {
    /** @type {Map<string, { holderId: string, lockedAt: Date }>} */
    this._locks = new Map();
  }

  /**
   * Acquire a lock on a worktree path.
   *
   * @param {string} worktreePath - Absolute path to the worktree
   * @param {string} holderId - Unique identifier for the lock holder (e.g. stackAnalysisId)
   * @returns {boolean} true if acquired (or re-acquired by same holder), false if held by another
   */
  acquire(worktreePath, holderId) {
    const existing = this._locks.get(worktreePath);

    if (existing) {
      if (existing.holderId === holderId) {
        // Re-acquire by same holder — update timestamp
        existing.lockedAt = new Date();
        logger.debug(`Worktree lock re-acquired: ${worktreePath} by ${holderId}`);
        return true;
      }
      logger.debug(`Worktree lock denied: ${worktreePath} held by ${existing.holderId}, requested by ${holderId}`);
      return false;
    }

    this._locks.set(worktreePath, { holderId, lockedAt: new Date() });
    logger.info(`Worktree lock acquired: ${worktreePath} by ${holderId}`);
    return true;
  }

  /**
   * Release a lock on a worktree path.
   *
   * @param {string} worktreePath - Absolute path to the worktree
   * @param {string} holderId - Must match the holder that acquired the lock
   * @returns {boolean} true if released, false if not held or held by a different holder
   */
  release(worktreePath, holderId) {
    const existing = this._locks.get(worktreePath);

    if (!existing) {
      logger.debug(`Worktree lock release: no lock found for ${worktreePath}`);
      return false;
    }

    if (existing.holderId !== holderId) {
      logger.debug(`Worktree lock release denied: ${worktreePath} held by ${existing.holderId}, release requested by ${holderId}`);
      return false;
    }

    this._locks.delete(worktreePath);
    logger.info(`Worktree lock released: ${worktreePath} by ${holderId}`);
    return true;
  }

  /**
   * Check whether a worktree is currently locked.
   *
   * @param {string} worktreePath - Absolute path to the worktree
   * @returns {{ locked: boolean, holderId?: string }}
   */
  isLocked(worktreePath) {
    const existing = this._locks.get(worktreePath);

    if (!existing) {
      return { locked: false };
    }

    return { locked: true, holderId: existing.holderId };
  }
}

// Singleton instance for application-wide use
const worktreeLock = new WorktreeLockManager();

module.exports = { worktreeLock, WorktreeLockManager };
