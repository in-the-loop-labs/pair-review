// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs');
const logger = require('../utils/logger');
const { WorktreePoolRepository, WorktreeRepository, generatePoolWorktreeId } = require('../database');
const { GitWorktreeManager } = require('./worktree');
const { normalizeRepository } = require('../utils/paths');
const { worktreePoolUsage } = require('./worktree-pool-usage');

/**
 * Error thrown when all pool slots for a repository are occupied.
 */
class PoolExhaustedError extends Error {
  constructor(repository, poolSize) {
    super(`All ${poolSize} worktree pool slots for ${repository} are occupied. Close an existing review or wait for an analysis to complete.`);
    this.name = 'PoolExhaustedError';
    this.repository = repository;
    this.poolSize = poolSize;
  }
}

/**
 * Manages a pool of reusable git worktrees per repository.
 *
 * Instead of creating and destroying worktrees per PR review, pool worktrees
 * persist and are switched between PRs via incremental fetch + checkout + reset_script.
 */
class WorktreePoolManager {
  /**
   * @param {Object} db - Database instance
   * @param {Object} config - Configuration object from loadConfig()
   * @param {Object} [_deps={}] - Injected dependencies for testing
   */
  constructor(db, config, _deps = {}) {
    this.db = db;
    this.config = config;
    this.poolRepo = _deps.poolRepo || new WorktreePoolRepository(db);
    this.worktreeRepo = _deps.worktreeRepo || new WorktreeRepository(db);
    this.usageTracker = _deps.usageTracker || null;
    this._fs = _deps.fs || fs;
    this._simpleGit = _deps.simpleGit || require('simple-git');
    this._GitWorktreeManager = _deps.GitWorktreeManager || GitWorktreeManager;
  }

  /**
   * Acquire a pool worktree for a PR review.
   *
   * Claim steps use DB-level serialization (BEGIN IMMEDIATE transactions in
   * poolRepo.claimByPR / claimAvailable) so that concurrent requests cannot
   * grab the same slot — even across independent WorktreePoolManager instances.
   *
   * Decision tree:
   * 1. Pool worktree already assigned to this PR -> claim atomically, refresh and return
   * 2. Available (LRU) pool worktree exists -> claim atomically, switch to this PR
   * 3. Pool not full -> create a new pool worktree
   * 4. All slots occupied -> throw PoolExhaustedError
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
    const existingPool = await this.poolRepo.claimByPR(prInfo.prNumber, repository);
    if (existingPool) {
      const worktreeRecord = await this.worktreeRepo.findById(existingPool.id);
      if (worktreeRecord) {
        if (!this._fs.existsSync(worktreeRecord.path)) {
          logger.warn(`Pool worktree ${existingPool.id} directory missing from disk (${worktreeRecord.path}) — removing stale records`);
          await this.poolRepo.delete(existingPool.id);
          await this.worktreeRepo.delete(existingPool.id);
        } else {
          logger.info(`Pool worktree ${existingPool.id} already assigned to PR #${prInfo.prNumber}, refreshing`);
          return this._refreshPoolWorktree(existingPool, worktreeRecord, prInfo, prData);
        }
      } else {
        logger.warn(`Orphaned pool entry ${existingPool.id} — removing`);
        await this.poolRepo.delete(existingPool.id);
      }
    }

    // 2. Available slot (LRU eviction)? Atomically claim via DB transaction.
    const available = await this.poolRepo.claimAvailable(repository);
    if (available) {
      const worktreeRecord = await this.worktreeRepo.findById(available.id);
      if (worktreeRecord) {
        if (!this._fs.existsSync(worktreeRecord.path)) {
          logger.warn(`Pool worktree ${available.id} directory missing from disk (${worktreeRecord.path}) — removing stale records`);
          await this.poolRepo.delete(available.id);
          await this.worktreeRepo.delete(available.id);
        } else {
          logger.info(`Switching pool worktree ${available.id} to PR #${prInfo.prNumber}`);
          return this._switchPoolWorktree(available, worktreeRecord, prInfo, prData, options);
        }
      } else {
        logger.warn(`Orphaned pool entry ${available.id} — removing`);
        await this.poolRepo.delete(available.id);
      }
    }

    // 3. Pool not full — atomically reserve a slot, then create
    const poolId = generatePoolWorktreeId();
    const reserved = await this.poolRepo.reserveSlot(poolId, repository, poolSize);
    if (reserved) {
      logger.info(`Reserved pool slot ${poolId} for PR #${prInfo.prNumber}, creating worktree`);
      return this._createPoolWorktree(prInfo, prData, repositoryPath, options, poolId);
    }

    // 4. All slots occupied
    throw new PoolExhaustedError(repository, poolSize);
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
        { worktreeSourcePath, checkoutScript, checkoutTimeout }
      );

      // Finalize the reservation: set path and mark in_use
      await this.poolRepo.finalizeReservation(worktreeId, worktreePath, prInfo.prNumber);

      logger.info(`Created pool worktree ${worktreeId} at ${worktreePath}`);
      return { worktreePath, worktreeId };
    } catch (err) {
      // Creation failed — remove the placeholder to free the slot
      try {
        await this.poolRepo.deleteReservation(poolId);
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

      // Fetch new PR refs (incremental — cheap on a warm worktree)
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
      const deletedPaths = await this.worktreeRepo.switchPR(poolEntry.id, prInfo.prNumber, branch);

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
      worktreePoolUsage.clearWorktree(poolEntry.id);

      // Mark in_use in pool table
      await this.poolRepo.markInUse(poolEntry.id, prInfo.prNumber);

      logger.info(`Switched pool worktree ${poolEntry.id} to PR #${prInfo.prNumber}`);
      return { worktreePath: poolEntry.path, worktreeId: poolEntry.id };
    } catch (err) {
      // Roll back to available on failure
      try {
        await this.poolRepo.markAvailable(poolEntry.id);
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
    await this.poolRepo.markInUse(poolEntry.id, prInfo.prNumber);

    logger.info(`Refreshed pool worktree ${poolEntry.id} for PR #${prInfo.prNumber}`);
    return { worktreePath: poolEntry.path, worktreeId: poolEntry.id };
  }

  /**
   * Release a pool worktree, marking it as available for reuse.
   * Called by the usage tracker when all sessions and analyses for a
   * worktree have ended.
   *
   * @param {string} worktreeId - Pool worktree ID
   */
  async release(worktreeId) {
    await this.poolRepo.markAvailable(worktreeId);
    logger.info(`Pool worktree ${worktreeId} released`);
  }
}

module.exports = { WorktreePoolManager, PoolExhaustedError };
