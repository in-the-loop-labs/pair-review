// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Worktree Management Routes
 *
 * Handles all worktree-related endpoints:
 * - Creating worktrees from PR URLs
 * - Getting recent worktrees
 * - Deleting worktrees
 */

const express = require('express');
const { query, queryOne, run, WorktreeRepository } = require('../database');
const { setupPRReview } = require('../setup/pr-setup');
const { GitHubApiError } = require('../github/client');
const fs = require('fs').promises;
const logger = require('../utils/logger');

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
    const { getGitHubToken } = require('../config');
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      return res.status(500).json({
        success: false,
        error: 'GitHub token not configured. Please set github_token in ~/.pair-review/config.json'
      });
    }

    logger.section(`Web UI Start Review - PR #${parsedPrNumber}`);

    const { reviewUrl, title } = await setupPRReview({
      db,
      owner,
      repo,
      prNumber: parsedPrNumber,
      githubToken,
      onProgress: (progress) => {
        logger.info(`[Setup] ${progress.step}: ${progress.message}`);
      }
    });

    logger.success(`Review ready at ${reviewUrl}`);

    res.json({
      success: true,
      reviewUrl,
      prNumber: parsedPrNumber,
      repository: `${owner}/${repo}`,
      title
    });

  } catch (error) {
    logger.error('Error creating worktree from web UI:', error);

    // GitHubApiError carries a numeric HTTP status from the GitHub client,
    // so we can route errors precisely without fragile string matching.
    if (error instanceof GitHubApiError) {
      const statusCode = error.status;
      if (statusCode === 401 || statusCode === 403) {
        return res.status(401).json({
          success: false,
          error: 'GitHub authentication failed. Please check your token.'
        });
      } else if (statusCode === 429) {
        return res.status(429).json({
          success: false,
          error: 'GitHub API rate limit exceeded. Please try again later.'
        });
      } else if (statusCode === 503) {
        return res.status(503).json({
          success: false,
          error: 'Network error. Please check your internet connection.'
        });
      } else if (statusCode === 404) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }
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
      LEFT JOIN pr_metadata pm ON w.pr_number = pm.pr_number AND w.repository = pm.repository COLLATE NOCASE
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
