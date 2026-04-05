// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const logger = require('../utils/logger');
const { WorktreePoolRepository, WorktreeRepository, generateWorktreeId } = require('../database');
const { GitWorktreeManager } = require('./worktree');
const { WorktreePoolUsageTracker } = require('./worktree-pool-usage');
const { normalizeRepository } = require('../utils/paths');
const { getRepoPoolSize } = require('../config');

/**
 * Consolidates the worktree pool state machine: absorbs WorktreePoolManager
 * and composes WorktreePoolUsageTracker to provide a single entry point for
 * all pool lifecycle operations (acquire, release, session/analysis tracking,
 * startup rehydration).
 */
class WorktreePoolLifecycle {
  /**
   * @param {Object} db - Database instance
   * @param {Object} config - Configuration object from loadConfig()
   * @param {Object} [_deps={}] - Injected dependencies for testing
   */
  constructor(db, config, _deps = {}) {
    const defaults = {
      poolRepo: new WorktreePoolRepository(db),
      worktreeRepo: new WorktreeRepository(db),
      usageTracker: new WorktreePoolUsageTracker(),
      fs: fs,
      simpleGit: require('simple-git'),
      GitWorktreeManager: GitWorktreeManager,
    };
    const deps = { ...defaults, ..._deps };

    this.db = db;
    this.config = config;
    this._poolRepo = deps.poolRepo;
    this._worktreeRepo = deps.worktreeRepo;
    this._usageTracker = deps.usageTracker;
    this._fs = deps.fs;
    this._simpleGit = deps.simpleGit;
    this._GitWorktreeManager = deps.GitWorktreeManager;
  }

  /**
   * Read-only accessor for the pool repository (used by callers that
   * need direct DB queries, e.g. route handlers checking pool status).
   */
  get poolRepo() {
    return this._poolRepo;
  }

  // ── Absorbed from WorktreePoolManager ────────────────────────────────────

  /**
   * Acquire a pool worktree for a PR review.
   *
   * Claim steps use DB-level serialization (BEGIN IMMEDIATE transactions in
   * poolRepo.claimByPR / claimAvailable) so that concurrent requests cannot
   * grab the same slot -- even across independent instances.
   *
   * Decision tree:
   * 1. Pool worktree already assigned to this PR -> claim atomically, refresh and return
   * 2. Available (LRU) pool worktree exists -> claim atomically, switch to this PR
   * 3. Pool not full -> create a new pool worktree
   * 4. All slots occupied -> create a standard non-pool worktree (slower fallback)
   *
   * @param {Object} prInfo - { owner, repo, prNumber, repository }
   * @param {Object} prData - { head: { sha, ref }, base: { sha, ref } }
   * @param {string} repositoryPath - Path to the main repository clone
   * @param {Object} options - { worktreeSourcePath, checkoutScript, checkoutTimeout, resetScript, worktreeConfig, poolSize }
   * @returns {Promise<{ worktreePath: string, worktreeId: string }>}
   */
  async acquireForPR(prInfo, prData, repositoryPath, options = {}) {
    const repository = prInfo.repository || normalizeRepository(prInfo.owner, prInfo.repo);
    const { poolSize } = options;

    // 1. Already assigned to this PR? Atomically claim via DB transaction.
    const existingPool = await this._poolRepo.claimByPR(prInfo.prNumber, repository);
    if (existingPool) {
      const worktreeRecord = await this._worktreeRepo.findById(existingPool.id);
      if (worktreeRecord) {
        if (!this._fs.existsSync(worktreeRecord.path)) {
          logger.warn(`Pool worktree ${existingPool.id} directory missing from disk (${worktreeRecord.path}) -- removing stale records`);
          await this._poolRepo.delete(existingPool.id);
          await this._worktreeRepo.delete(existingPool.id);
        } else {
          logger.info(`Pool worktree ${existingPool.id} already assigned to PR #${prInfo.prNumber}, refreshing`);
          return this._refreshPoolWorktree(existingPool, worktreeRecord, prInfo, prData);
        }
      } else {
        logger.warn(`Orphaned pool entry ${existingPool.id} -- removing`);
        await this._poolRepo.delete(existingPool.id);
      }
    }

    // 2. Available slot (LRU eviction)? Atomically claim via DB transaction.
    const available = await this._poolRepo.claimAvailable(repository);
    if (available) {
      const worktreeRecord = await this._worktreeRepo.findById(available.id);
      if (worktreeRecord) {
        if (!this._fs.existsSync(worktreeRecord.path)) {
          logger.warn(`Pool worktree ${available.id} directory missing from disk (${worktreeRecord.path}) -- removing stale records`);
          await this._poolRepo.delete(available.id);
          await this._worktreeRepo.delete(available.id);
        } else {
          logger.info(`Switching pool worktree ${available.id} to PR #${prInfo.prNumber}`);
          return this._switchPoolWorktree(available, worktreeRecord, prInfo, prData, options);
        }
      } else {
        logger.warn(`Orphaned pool entry ${available.id} -- removing`);
        await this._poolRepo.delete(available.id);
      }
    }

    // 3. Pool not full -- atomically reserve a slot, then create
    const poolId = generateWorktreeId();
    const reserved = await this._poolRepo.reserveSlot(poolId, repository, poolSize);
    if (reserved) {
      logger.info(`Reserved pool slot ${poolId} for PR #${prInfo.prNumber}, creating worktree`);
      return this._createPoolWorktree(prInfo, prData, repositoryPath, options, poolId);
    }

    // 4. All slots occupied — fall back to a standard non-pool worktree
    //    (slower but functional; the pool is pre-warmed capacity, not a hard limit)
    logger.warn(`Pool full for ${repository} (${poolSize} slots), creating non-pool worktree for PR #${prInfo.prNumber} — setup will be slower`);

    const normalizedPrData = {
      head_sha: prData.head?.sha || prData.head_sha,
      head_branch: prData.head?.ref || prData.head_branch,
      base_sha: prData.base?.sha || prData.base_sha,
      base_branch: prData.base?.ref || prData.base_branch,
      repository: prData.repository,
    };

    const normalizedPrInfo = {
      owner: prInfo.owner,
      repo: prInfo.repo,
      number: prInfo.prNumber,
    };

    const worktreeManager = new this._GitWorktreeManager(this.db, options.worktreeConfig || {});
    const { path: worktreePath, id: worktreeId } = await worktreeManager.createWorktreeForPR(
      normalizedPrInfo,
      normalizedPrData,
      repositoryPath,
      { worktreeSourcePath: options.worktreeSourcePath, checkoutScript: options.checkoutScript, checkoutTimeout: options.checkoutTimeout }
    );

    return { worktreePath, worktreeId };
  }

  /**
   * Create a new pool worktree from scratch.
   * Expects that the caller has already reserved a pool slot via
   * poolRepo.reserveSlot(). Delegates to GitWorktreeManager.createWorktreeForPR,
   * then finalizes the reservation on success or deletes it on failure.
   *
   * @param {Object} prInfo
   * @param {Object} prData
   * @param {string} repositoryPath
   * @param {Object} options
   * @param {string} poolId - Pre-reserved pool worktree ID
   * @returns {Promise<{ worktreePath: string, worktreeId: string }>}
   */
  async _createPoolWorktree(prInfo, prData, repositoryPath, options, poolId) {
    const repository = prInfo.repository || normalizeRepository(prInfo.owner, prInfo.repo);
    const { worktreeSourcePath, checkoutScript, checkoutTimeout, worktreeConfig } = options;

    // Build worktree config with pool ID substituted into the name template.
    // Preserve any user-configured template (e.g., '{id}/src' for monorepos)
    // and only replace the {id} placeholder with the pool-specific ID.
    const poolWorktreeConfig = {
      ...(worktreeConfig || {}),
      nameTemplate: (worktreeConfig?.nameTemplate || '{id}').replace(/\{id\}/g, poolId),
    };

    const worktreeManager = new this._GitWorktreeManager(this.db, poolWorktreeConfig);

    // Normalize prData into the shape createWorktreeForPR expects
    const normalizedPrData = {
      head_sha: prData.head?.sha || prData.head_sha,
      head_branch: prData.head?.ref || prData.head_branch,
      base_sha: prData.base?.sha || prData.base_sha,
      base_branch: prData.base?.ref || prData.base_branch,
      repository: prData.repository,
    };

    const normalizedPrInfo = {
      owner: prInfo.owner,
      repo: prInfo.repo,
      number: prInfo.prNumber,
    };

    try {
      const { path: worktreePath, id: worktreeId } = await worktreeManager.createWorktreeForPR(
        normalizedPrInfo,
        normalizedPrData,
        repositoryPath,
        { worktreeSourcePath, checkoutScript, checkoutTimeout, explicitId: poolId }
      );

      // Finalize the reservation: set path and mark in_use.
      // Use poolId (the reserved pool slot ID), NOT worktreeId (the worktrees-table ID).
      await this._poolRepo.finalizeReservation(poolId, worktreePath, prInfo.prNumber);

      logger.info(`Created pool worktree ${poolId} at ${worktreePath}`);
      return { worktreePath, worktreeId: poolId };
    } catch (err) {
      // Creation failed -- remove the placeholder to free the slot
      try {
        await this._poolRepo.deleteReservation(poolId);
      } catch (cleanupErr) {
        logger.error(`Failed to delete reservation ${poolId} after creation failure: ${cleanupErr.message}`);
      }
      throw err;
    }
  }

  /**
   * Switch an existing pool worktree to a different PR.
   *
   * @param {Object} poolEntry - Pool table record
   * @param {Object} worktreeRecord - Worktrees table record
   * @param {Object} prInfo
   * @param {Object} prData
   * @param {Object} options
   * @returns {Promise<{ worktreePath: string, worktreeId: string }>}
   */
  async _switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options) {
    // Note: poolEntry was already atomically marked 'switching' by claimAvailable()
    try {
      const git = this._simpleGit(poolEntry.path);

      // Resolve the remote
      const remotes = await git.getRemotes();
      const remote = remotes.find(r => r.name === 'origin') || remotes[0];
      const remoteName = remote ? remote.name : 'origin';

      // Fetch new PR refs (incremental -- cheap on a warm worktree)
      logger.info(`Fetching PR #${prInfo.prNumber} refs into pool worktree ${poolEntry.id}`);
      await git.fetch([remoteName, `+refs/pull/${prInfo.prNumber}/head:refs/remotes/${remoteName}/pr-${prInfo.prNumber}`]);

      // Clean the working tree before switching PRs. Without this, untracked
      // files (build artifacts, generated code) from the previous PR leak into
      // the new checkout, and modified tracked files can cause checkout to fail.
      // Use -fd (not -fdx) to preserve gitignored files like node_modules that
      // the resetScript may depend on.
      await git.reset(['--hard', 'HEAD']);
      await git.clean(['-fd']);

      // Checkout new PR head
      await git.checkout([`refs/remotes/${remoteName}/pr-${prInfo.prNumber}`]);

      // Run reset_script if configured
      if (options.resetScript) {
        const headRef = prData.head?.ref || prData.head_branch || '';
        const baseRef = prData.base?.ref || prData.base_branch || '';
        const headSha = prData.head?.sha || prData.head_sha || '';
        const baseSha = prData.base?.sha || prData.base_sha || '';

        const scriptEnv = {
          BASE_BRANCH: baseRef,
          HEAD_BRANCH: headRef,
          BASE_SHA: baseSha,
          HEAD_SHA: headSha,
          PR_NUMBER: String(prInfo.prNumber),
          WORKTREE_PATH: poolEntry.path,
        };
        const worktreeManager = new this._GitWorktreeManager();
        await worktreeManager.executeCheckoutScript(
          options.resetScript, poolEntry.path, scriptEnv, options.checkoutTimeout
        );
      }

      // Update worktrees table (returns paths of deleted non-pool worktree records)
      const branch = prData.head?.ref || prData.head_branch || '';
      const deletedPaths = await this._worktreeRepo.switchPR(poolEntry.id, prInfo.prNumber, branch);

      // Best-effort disk cleanup for deleted non-pool worktree directories
      if (deletedPaths && deletedPaths.length > 0) {
        const worktreeManager = new this._GitWorktreeManager();
        for (const deletedPath of deletedPaths) {
          try {
            await worktreeManager.cleanupWorktree(deletedPath);
            logger.info(`Cleaned up obsolete worktree directory: ${deletedPath}`);
          } catch (cleanupErr) {
            logger.warn(`Failed to clean up obsolete worktree directory ${deletedPath}: ${cleanupErr.message}`);
          }
        }
      }

      // Forcefully clear all previous tracking state (sessions, analyses, grace
      // timers, review mappings) before assigning to the new PR. Without this,
      // zombie holds from the previous PR could trigger a false onIdle event
      // that marks the worktree available while the new PR is using it.
      this._usageTracker.clearWorktree(poolEntry.id);

      // Mark in_use in pool table
      await this._poolRepo.markInUse(poolEntry.id, prInfo.prNumber);

      logger.info(`Switched pool worktree ${poolEntry.id} to PR #${prInfo.prNumber}`);
      return { worktreePath: poolEntry.path, worktreeId: poolEntry.id };
    } catch (err) {
      // Roll back to available on failure
      try {
        await this._poolRepo.markAvailable(poolEntry.id);
      } catch (rollbackErr) {
        logger.error(`Failed to roll back pool worktree ${poolEntry.id} status: ${rollbackErr.message}`);
      }
      throw err;
    }
  }

  /**
   * Refresh an existing pool worktree that is already assigned to the right PR.
   * Delegates to GitWorktreeManager.refreshWorktree for the git operations,
   * then ensures the pool entry is marked as in_use.
   *
   * @param {Object} poolEntry - Pool table record
   * @param {Object} worktreeRecord - Worktrees table record
   * @param {Object} prInfo
   * @param {Object} prData
   * @returns {Promise<{ worktreePath: string, worktreeId: string }>}
   */
  async _refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData) {
    const normalizedPrData = {
      head_sha: prData.head?.sha || prData.head_sha,
      head_branch: prData.head?.ref || prData.head_branch,
      base_sha: prData.base?.sha || prData.base_sha,
      base_branch: prData.base?.ref || prData.base_branch,
      repository: prData.repository,
    };

    const normalizedPrInfo = {
      owner: prInfo.owner,
      repo: prInfo.repo,
      number: prInfo.prNumber,
    };

    const worktreeManager = new this._GitWorktreeManager(this.db);
    await worktreeManager.refreshWorktree(worktreeRecord, normalizedPrInfo.number, normalizedPrData, normalizedPrInfo);

    // Ensure pool entry is marked in_use
    await this._poolRepo.markInUse(poolEntry.id, prInfo.prNumber);

    logger.info(`Refreshed pool worktree ${poolEntry.id} for PR #${prInfo.prNumber}`);
    return { worktreePath: poolEntry.path, worktreeId: poolEntry.id };
  }

  /**
   * Release a pool worktree, marking it as available for reuse.
   * Kept for backward compatibility -- callers that only need to mark
   * a worktree available without touching usage tracking can use this.
   *
   * @param {string} worktreeId - Pool worktree ID
   */
  async release(worktreeId) {
    await this._poolRepo.markAvailable(worktreeId);
    logger.info(`Pool worktree ${worktreeId} released`);
  }

  // ── New lifecycle methods ────────────────────────────────────────────────

  /**
   * Register a WebSocket session for a pool worktree.
   * Looks up the worktree by review ID, then adds the session to the
   * in-memory usage tracker.
   *
   * @param {number} reviewId - The review ID to look up
   * @param {string} sessionKey - Unique key for this WS connection
   * @returns {Promise<{ worktreeId: string }|null>} worktreeId if found, null otherwise
   */
  async startSession(reviewId, sessionKey) {
    const entry = await this._poolRepo.findByReviewId(reviewId);
    if (!entry) return null;

    this._usageTracker.addSession(entry.id, sessionKey);
    return { worktreeId: entry.id };
  }

  /**
   * Remove a WebSocket session from the usage tracker.
   * Synchronous -- does not touch the database.
   *
   * @param {string} worktreeId - Pool worktree ID
   * @param {string} sessionKey - Unique key for the WS connection
   */
  endSession(worktreeId, sessionKey) {
    this._usageTracker.removeSession(worktreeId, sessionKey);
  }

  /**
   * Register an AI analysis for a pool worktree.
   * Looks up the worktree by review ID, then adds the analysis to the
   * in-memory usage tracker.
   *
   * @param {number} reviewId - The review ID to look up
   * @param {string} analysisId - Unique analysis identifier
   * @returns {Promise<string|null>} worktreeId if found, null otherwise
   */
  async startAnalysis(reviewId, analysisId) {
    const entry = await this._poolRepo.findByReviewId(reviewId);
    if (!entry) return null;

    this._usageTracker.addAnalysis(entry.id, analysisId);
    return entry.id;
  }

  /**
   * Remove an analysis hold from the usage tracker by analysis ID.
   * Synchronous -- does not touch the database.
   *
   * @param {string} analysisId - Unique analysis identifier
   */
  endAnalysis(analysisId) {
    this._usageTracker.removeAnalysisById(analysisId);
  }

  /**
   * Release a worktree for deletion: clear usage state first, then
   * mark available in the database.
   *
   * @param {string} worktreeId - Pool worktree ID
   */
  async releaseForDeletion(worktreeId) {
    this._usageTracker.clearWorktree(worktreeId);
    await this._poolRepo.markAvailable(worktreeId);
  }

  /**
   * Release a worktree after a headless analysis completes: clear in-memory
   * usage state first, then mark available in the database. Clearing state
   * before the DB write prevents a race where another request claims the slot
   * (after the DB write) and then has its tracking state wiped by clearWorktree.
   *
   * @param {string} worktreeId - Pool worktree ID
   */
  async releaseAfterHeadless(worktreeId) {
    this._usageTracker.clearWorktree(worktreeId);
    await this._poolRepo.markAvailable(worktreeId);
  }

  /**
   * Set the review ID that owns a pool worktree (persistent ownership).
   *
   * @param {string} worktreeId - Pool worktree ID
   * @param {number|null} reviewId - Review ID that owns the worktree
   */
  async setReviewOwner(worktreeId, reviewId) {
    await this._poolRepo.setCurrentReviewId(worktreeId, reviewId);
  }

  /**
   * Return the set of active analysis IDs for a worktree.
   *
   * @param {string} worktreeId - Pool worktree ID
   * @returns {Set<string>} Active analysis IDs (may be empty)
   */
  getActiveAnalyses(worktreeId) {
    return this._usageTracker.getActiveAnalyses(worktreeId);
  }

  /**
   * Reset stale pool entries and rehydrate preserved ones on startup.
   *
   * This method:
   * 1. Calls resetStaleAndPreserve() to clean up stale DB entries and
   *    identify entries with valid review ownership
   * 2. Wires the onIdle callback with retry logic (2 attempts, 1s delay)
   *    so that idle worktrees are automatically marked available
   * 3. Rehydrates preserved entries by triggering a synthetic
   *    session add/remove cycle, which starts the grace-period timer.
   *    If a real user reconnects before the timer fires, their WS
   *    session will cancel it automatically.
   *
   * @returns {Promise<Array<{id: string, current_review_id: number}>>} Preserved entries
   */
  async resetAndRehydrate() {
    // 1. Reset stale entries and get preserved ones
    const preserved = await this._poolRepo.resetStaleAndPreserve();
    if (preserved.length > 0) {
      logger.info(`Pool startup: preserved ${preserved.length} active worktree(s)`);
    }

    // 1b. Adopt existing non-pool worktrees into pool for pool-enabled repos
    const adopted = await this._adoptExistingWorktrees();
    for (const entry of adopted) {
      preserved.push(entry);
    }

    // 2. Wire up idle callback with retry logic (2 attempts, 1s delay)
    this._usageTracker.onIdle = async (worktreeId) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await this._poolRepo.markAvailable(worktreeId);
          logger.info(`Pool worktree ${worktreeId} is now available`);
          return;
        } catch (err) {
          if (attempt < 2) {
            logger.warn(`Failed to release pool worktree ${worktreeId} (attempt ${attempt}), retrying: ${err.message}`);
            await new Promise(r => setTimeout(r, 1000));
          } else {
            logger.error(`Failed to release pool worktree ${worktreeId} after ${attempt} attempts: ${err.message}`);
          }
        }
      }
    };

    // 3. Rehydrate preserved entries by triggering grace-period timers
    if (preserved.length > 0) {
      logger.info(`Pool startup: preserved ${preserved.length} active worktree(s), starting grace periods`);
      for (const entry of preserved) {
        // Add then immediately remove a synthetic session to trigger the
        // idle grace period timer. If a real user reconnects before the
        // timer fires, their WS session will cancel it automatically.
        this._usageTracker.addSession(entry.id, 'startup-rehydration');
        this._usageTracker.removeSession(entry.id, 'startup-rehydration');
      }
    }

    return preserved;
  }

  /**
   * Adopt existing non-pool worktrees into the pool for repos that have pool_size configured.
   * Worktrees already in worktree_pool are skipped. Adoption stops at pool capacity.
   *
   * Returns adopted entries that have `status = 'in_use'` so the caller can
   * rehydrate them with synthetic sessions (same as preserved entries).
   *
   * @returns {Promise<Array<{id: string, current_review_id: number}>>} Adopted in_use entries
   * @private
   */
  async _adoptExistingWorktrees() {
    const repos = this.config.repos || {};
    const adoptedInUse = [];

    for (const repoName of Object.keys(repos)) {
      const poolSize = getRepoPoolSize(this.config, repoName);
      if (!poolSize) continue;

      // Count existing pool entries for this repo
      const existingCount = await this._poolRepo.countForRepo(repoName);
      if (existingCount >= poolSize) continue; // already at capacity

      // Find worktrees for this repo that are NOT in the pool (includes review ID via JOIN)
      const orphans = await this._poolRepo.findOrphanWorktrees(repoName);

      let adopted = 0;
      for (const orphan of orphans) {
        if (existingCount + adopted >= poolSize) break; // respect capacity

        // Skip orphans whose directory no longer exists on disk
        if (!this._fs.existsSync(orphan.path)) {
          logger.warn(`Pool startup: skipping adoption of ${orphan.id} — directory missing (${orphan.path})`);
          continue;
        }

        if (orphan.reviewId) {
          // Adopt as in_use with review ownership
          await this._poolRepo.create({
            id: orphan.id,
            repository: orphan.repository,
            path: orphan.path,
            prNumber: orphan.pr_number,
          });
          await this._poolRepo.setCurrentReviewId(orphan.id, orphan.reviewId);
          adoptedInUse.push({ id: orphan.id, current_review_id: orphan.reviewId });
          logger.info(`Pool startup: adopted worktree ${orphan.id} for PR #${orphan.pr_number} (in_use, review ${orphan.reviewId})`);
        } else {
          // Adopt as available (no active review)
          await this._poolRepo.create({
            id: orphan.id,
            repository: orphan.repository,
            path: orphan.path,
          });
          logger.info(`Pool startup: adopted worktree ${orphan.id} for PR #${orphan.pr_number} (available, no review)`);
        }

        adopted++;
      }

      if (adopted > 0) {
        logger.info(`Pool startup: adopted ${adopted} worktree(s) for ${repoName}`);
      }
    }

    return adoptedInUse;
  }
}

module.exports = { WorktreePoolLifecycle };
