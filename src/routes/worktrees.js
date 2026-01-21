/**
 * Worktree Management Routes
 *
 * Handles all worktree-related endpoints:
 * - Creating worktrees from PR URLs
 * - Getting recent worktrees
 * - Deleting worktrees
 */

const express = require('express');
const { query, queryOne, run, WorktreeRepository, RepoSettingsRepository } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const { GitHubClient } = require('../github/client');
const { normalizeRepository } = require('../utils/paths');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const simpleGit = require('simple-git');

const router = express.Router();

/**
 * Create worktree from PR URL (for web UI start review)
 * Creates worktree, fetches PR data from GitHub, stores in database
 */
router.post('/api/worktrees/create', async (req, res) => {
  try {
    const { owner, repo, prNumber } = req.body;

    // Validate required parameters
    if (!owner || !repo || !prNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: owner, repo, prNumber'
      });
    }

    const parsedPrNumber = parseInt(prNumber, 10);
    if (isNaN(parsedPrNumber) || parsedPrNumber <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pull request number'
      });
    }

    const db = req.app.get('db');
    const config = req.app.get('config');

    // Validate GitHub token
    if (!config || !config.github_token) {
      return res.status(500).json({
        success: false,
        error: 'GitHub token not configured. Please set github_token in ~/.pair-review/config.json'
      });
    }

    const repository = normalizeRepository(owner, repo);
    logger.section(`Web UI Start Review - PR #${parsedPrNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');

    // Create GitHub client and validate token
    const githubClient = new GitHubClient(config.github_token);
    const tokenValid = await githubClient.validateToken();
    if (!tokenValid) {
      return res.status(401).json({
        success: false,
        error: 'GitHub authentication failed. Please check your token in ~/.pair-review/config.json'
      });
    }

    // Check if repository is accessible
    const repoExists = await githubClient.repositoryExists(owner, repo);
    if (!repoExists) {
      return res.status(404).json({
        success: false,
        error: `Repository ${repository} not found or not accessible`
      });
    }

    // Fetch PR data from GitHub
    logger.info('Fetching pull request data from GitHub...');
    let prData;
    try {
      prData = await githubClient.fetchPullRequest(owner, repo, parsedPrNumber);
    } catch (error) {
      if (error.message && error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: `Pull request #${parsedPrNumber} not found in ${repository}`
        });
      }
      throw error;
    }

    // Get current working directory for worktree creation
    // Since we're running from the web UI, we need to find a valid git repository
    // The worktree manager will handle this by using its configured base directory
    const worktreeManager = new GitWorktreeManager(db);

    // We need a source repository to create worktrees from
    // Tier 0: Check known local path from repo_settings (registered by CLI usage)
    let repositoryPath;
    const repoSettingsRepo = new RepoSettingsRepository(db);
    const worktreeRepo = new WorktreeRepository(db);
    const knownPath = await repoSettingsRepo.getLocalPath(repository);

    if (knownPath && await worktreeManager.pathExists(knownPath)) {
      // Validate it's still a valid git repo
      try {
        const git = simpleGit(knownPath);
        await git.revparse(['--is-inside-work-tree']);
        repositoryPath = knownPath;
        logger.info(`Using known repository location at ${repositoryPath}`);
      } catch {
        // Path exists but isn't a valid git repo anymore, clear it
        logger.warn(`Known path ${knownPath} is no longer a valid git repo, clearing`);
        await repoSettingsRepo.setLocalPath(repository, null);
      }
    }

    // Tier 1: Check if we have an existing worktree for this repo
    if (!repositoryPath) {
      const existingWorktree = await worktreeRepo.findByPR(parsedPrNumber, repository);

      if (existingWorktree && await worktreeManager.pathExists(existingWorktree.path)) {
        // Use the existing worktree path to find the parent git repository
        try {
          const git = simpleGit(existingWorktree.path);
          repositoryPath = await git.revparse(['--show-toplevel']);
          repositoryPath = repositoryPath.trim();
          logger.info(`Using repository from existing worktree at ${repositoryPath}`);
        } catch {
          // If we can't get the git root, we'll need to clone
          repositoryPath = null;
        }
      }
    }

    // Tier 2 & 3: Check cached clone or clone fresh
    if (!repositoryPath) {
      // Check if there's a cached clone for this repository
      const { getConfigDir } = require('../config');
      const cachedRepoPath = path.join(getConfigDir(), 'repos', owner, repo);

      if (await worktreeManager.pathExists(cachedRepoPath)) {
        repositoryPath = cachedRepoPath;
        logger.info(`Using cached repository at ${repositoryPath}`);
      } else {
        // Clone the repository
        logger.info(`Cloning repository ${repository}...`);
        await fs.mkdir(path.dirname(cachedRepoPath), { recursive: true });

        const git = simpleGit();

        // Clone with minimal depth for efficiency
        const cloneUrl = `https://github.com/${owner}/${repo}.git`;
        try {
          await git.clone(cloneUrl, cachedRepoPath, ['--filter=blob:none', '--no-checkout']);
          repositoryPath = cachedRepoPath;
          logger.info(`Cloned repository to ${repositoryPath}`);
        } catch (cloneError) {
          return res.status(500).json({
            success: false,
            error: `Failed to clone repository: ${cloneError.message}`
          });
        }
      }
    }

    // Setup git worktree
    logger.info('Setting up git worktree...');
    const prInfo = { owner, repo, number: parsedPrNumber };
    const worktreePath = await worktreeManager.createWorktreeForPR(prInfo, prData, repositoryPath);

    // Generate unified diff
    logger.info('Generating unified diff...');
    const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
    const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);

    // Store PR data in database (similar to storePRData in main.js)
    logger.info('Storing pull request data...');
    await run(db, 'BEGIN TRANSACTION');

    try {
      // Store or update worktree record
      await worktreeRepo.getOrCreate({
        prNumber: parsedPrNumber,
        repository,
        branch: prData.head_branch,
        path: worktreePath
      });

      // Prepare extended PR data
      const extendedPRData = {
        ...prData,
        diff: diff,
        changed_files: changedFiles,
        worktree_path: worktreePath,
        fetched_at: new Date().toISOString()
      };

      // Check if PR metadata exists
      const existingPR = await queryOne(db, `
        SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ?
      `, [parsedPrNumber, repository]);

      if (existingPR) {
        // Update existing PR metadata
        await run(db, `
          UPDATE pr_metadata
          SET title = ?, description = ?, author = ?,
              base_branch = ?, head_branch = ?, pr_data = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [
          prData.title,
          prData.body,
          prData.author,
          prData.base_branch,
          prData.head_branch,
          JSON.stringify(extendedPRData),
          existingPR.id
        ]);
        logger.info(`Updated existing PR metadata (ID: ${existingPR.id})`);
      } else {
        // Insert new PR metadata
        const result = await run(db, `
          INSERT INTO pr_metadata
          (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          parsedPrNumber,
          repository,
          prData.title,
          prData.body,
          prData.author,
          prData.base_branch,
          prData.head_branch,
          JSON.stringify(extendedPRData)
        ]);
        logger.info(`Created new PR metadata (ID: ${result.lastID})`);
      }

      // Create or update review record
      const existingReview = await queryOne(db, `
        SELECT id FROM reviews WHERE pr_number = ? AND repository = ?
      `, [parsedPrNumber, repository]);

      if (existingReview) {
        await run(db, `
          UPDATE reviews
          SET review_data = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [
          JSON.stringify({
            worktree_path: worktreePath,
            created_at: new Date().toISOString()
          }),
          existingReview.id
        ]);
      } else {
        await run(db, `
          INSERT INTO reviews
          (pr_number, repository, status, review_data)
          VALUES (?, ?, 'draft', ?)
        `, [
          parsedPrNumber,
          repository,
          JSON.stringify({
            worktree_path: worktreePath,
            created_at: new Date().toISOString()
          })
        ]);
      }

      await run(db, 'COMMIT');
      logger.success(`Stored PR data for ${repository} #${parsedPrNumber}`);

      // Register the repository path for future use if it wasn't already known
      // This ensures web UI discoveries also benefit future sessions
      // Skip registration if: (1) knownPath was used (path === knownPath), or
      // (2) we have a knownPath but it failed validation (already cleared above)
      // Only register when we discovered a genuinely new path
      if (repositoryPath && knownPath === null) {
        // Only register if this path isn't already stored (avoid redundant writes)
        const currentPath = await repoSettingsRepo.getLocalPath(repository);
        if (path.resolve(currentPath || '') !== path.resolve(repositoryPath)) {
          await repoSettingsRepo.setLocalPath(repository, repositoryPath);
          logger.info(`Registered repository location: ${repositoryPath}`);
        }
      }

    } catch (dbError) {
      await run(db, 'ROLLBACK');
      throw new Error(`Failed to store PR data: ${dbError.message}`);
    }

    // Return success with review URL
    const reviewUrl = `/pr/${owner}/${repo}/${parsedPrNumber}`;

    logger.success(`Review ready at ${reviewUrl}`);

    res.json({
      success: true,
      reviewUrl,
      prNumber: parsedPrNumber,
      repository,
      title: prData.title
    });

  } catch (error) {
    logger.error('Error creating worktree from web UI:', error);

    // Provide user-friendly error messages
    if (error.message && error.message.includes('authentication failed')) {
      return res.status(401).json({
        success: false,
        error: 'GitHub authentication failed. Please check your token.'
      });
    } else if (error.message && error.message.includes('rate limit')) {
      return res.status(429).json({
        success: false,
        error: 'GitHub API rate limit exceeded. Please try again later.'
      });
    } else if (error.message && error.message.includes('Network error')) {
      return res.status(503).json({
        success: false,
        error: 'Network error. Please check your internet connection.'
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create worktree'
    });
  }
});

/**
 * Get recently accessed worktrees
 * Returns list of recently reviewed PRs with metadata
 * Filters out stale worktrees where the directory no longer exists
 */
router.get('/api/worktrees/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Default 10, max 50
    const db = req.app.get('db');

    // Get more worktrees than requested to account for stale ones we'll filter out
    const enrichedWorktrees = await query(db, `
      SELECT
        w.id,
        w.repository,
        w.pr_number,
        w.branch,
        w.path,
        w.last_accessed_at,
        w.created_at,
        pm.title as pr_title,
        pm.author,
        pm.head_branch
      FROM worktrees w
      LEFT JOIN pr_metadata pm ON w.pr_number = pm.pr_number AND w.repository = pm.repository
      ORDER BY w.last_accessed_at DESC
      LIMIT ?
    `, [limit * 2]); // Fetch extra to account for stale entries

    // Filter out worktrees where:
    // 1. The directory no longer exists
    // 2. The data is incomplete/corrupted (no author, unknown branch)
    const staleIds = [];
    const validWorktrees = [];

    for (const w of enrichedWorktrees) {
      // Check for corrupted/incomplete data
      if (w.branch === 'unknown' || !w.pr_title || w.pr_title === `PR #${w.pr_number}`) {
        staleIds.push(w.id);
        continue;
      }

      // Check if path still exists
      try {
        await fs.access(w.path);
        validWorktrees.push(w);
      } catch {
        // Path doesn't exist - mark for cleanup
        staleIds.push(w.id);
      }
    }

    // Cleanup stale worktree records in background (don't block response)
    if (staleIds.length > 0) {
      setImmediate(async () => {
        try {
          const placeholders = staleIds.map(() => '?').join(',');
          await run(db, `DELETE FROM worktrees WHERE id IN (${placeholders})`, staleIds);
          logger.info(`Cleaned up ${staleIds.length} stale worktree records`);
        } catch (err) {
          logger.warn(`Failed to cleanup stale worktrees: ${err.message}`);
        }
      });
    }

    // Format the results with fallback values, limited to requested count
    const formattedWorktrees = validWorktrees.slice(0, limit).map(w => ({
      id: w.id,
      repository: w.repository,
      pr_number: w.pr_number,
      pr_title: w.pr_title || `PR #${w.pr_number}`,
      author: w.author || null,
      branch: w.branch,
      head_branch: w.head_branch || w.branch,
      last_accessed_at: w.last_accessed_at,
      created_at: w.created_at
    }));

    res.json({
      success: true,
      worktrees: formattedWorktrees
    });

  } catch (error) {
    console.error('Error fetching recent worktrees:', error);
    res.status(500).json({
      error: 'Failed to fetch recent worktrees'
    });
  }
});

/**
 * Delete a worktree
 * Removes the worktree record from the database and optionally deletes the directory
 */
router.delete('/api/worktrees/:id', async (req, res) => {
  try {
    const worktreeId = req.params.id;

    if (!worktreeId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid worktree ID'
      });
    }

    const db = req.app.get('db');
    const worktreeRepo = new WorktreeRepository(db);

    // Get worktree info before deletion
    const worktree = await queryOne(db, `
      SELECT id, path, pr_number, repository FROM worktrees WHERE id = ?
    `, [worktreeId]);

    if (!worktree) {
      return res.status(404).json({
        success: false,
        error: 'Worktree not found'
      });
    }

    logger.info(`Deleting worktree ID ${worktreeId} for ${worktree.repository} #${worktree.pr_number}`);

    // Delete the worktree directory if it exists
    if (worktree.path) {
      try {
        await fs.access(worktree.path);
        // Directory exists, try to remove it
        await fs.rm(worktree.path, { recursive: true, force: true });
        logger.info(`Deleted worktree directory: ${worktree.path}`);
      } catch (pathError) {
        // Directory doesn't exist or can't be accessed - that's okay
        logger.warn(`Could not delete worktree directory (may not exist): ${worktree.path}`);
      }
    }

    // Delete the worktree record from the database
    await run(db, `DELETE FROM worktrees WHERE id = ?`, [worktreeId]);

    // Also delete associated PR metadata and comments (optional cleanup)
    // Keep PR metadata for now as user might want to reload the PR later
    // await run(db, `DELETE FROM pr_metadata WHERE pr_number = ? AND repository = ?`,
    //   [worktree.pr_number, worktree.repository]);

    logger.success(`Deleted worktree ID ${worktreeId}`);

    res.json({
      success: true,
      message: `Worktree for ${worktree.repository} #${worktree.pr_number} deleted`
    });

  } catch (error) {
    logger.error('Error deleting worktree:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete worktree: ' + error.message
    });
  }
});

module.exports = router;
