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
const { query, queryOne, run } = require('../database');
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
      config,
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
 * Get recently reviewed PRs with cursor-based pagination.
 * Lists from pr_metadata (source of truth) and includes storage status
 * based on whether a local worktree directory exists.
 *
 * Query parameters:
 *   limit  - Number of reviews to return (default 10, max 50)
 *   before - ISO timestamp cursor: return reviews accessed before this time.
 *            For subsequent pages, send the last_accessed_at of the last item
 *            from the previous page. Omit for the initial load.
 *
 * Response includes:
 *   reviews - Array of review objects with storage_status
 *   hasMore - Whether more reviews are available beyond this page
 */
router.get('/api/worktrees/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const before = req.query.before || null;
    const db = req.app.get('db');

    // Fetch limit + 1 to determine hasMore
    const fetchCount = limit + 1;

    const params = before ? [before, fetchCount] : [fetchCount];
    const rows = await query(db, `
      SELECT
        pm.id,
        pm.repository,
        pm.pr_number,
        pm.title,
        pm.author,
        pm.head_branch,
        pm.last_accessed_at,
        pm.created_at,
        json_extract(pm.pr_data, '$.html_url') as html_url,
        w.id as worktree_id,
        w.path as worktree_path,
        w.branch
      FROM pr_metadata pm
      LEFT JOIN worktrees w ON pm.pr_number = w.pr_number AND pm.repository = w.repository COLLATE NOCASE
      WHERE pm.title IS NOT NULL AND pm.title != ''
        ${before ? 'AND pm.last_accessed_at < ?' : ''}
      ORDER BY pm.last_accessed_at DESC
      LIMIT ?
    `, params);

    // Determine storage status for each entry
    const reviews = [];
    for (const row of rows) {
      let storageStatus = 'cached';
      if (row.worktree_path) {
        try {
          await fs.access(row.worktree_path);
          storageStatus = 'local';
        } catch {
          // Worktree dir missing — clean up stale record asynchronously on first page
          if (!before) {
            setImmediate(async () => {
              try {
                await run(db, 'DELETE FROM worktrees WHERE id = ?', [row.worktree_id]);
                logger.info(`Cleaned up stale worktree record ${row.worktree_id}`);
              } catch (err) {
                logger.warn(`Failed to cleanup stale worktree: ${err.message}`);
              }
            });
          }
        }
      }
      reviews.push({
        id: row.id,
        repository: row.repository,
        pr_number: row.pr_number,
        pr_title: row.title,
        author: row.author || null,
        head_branch: row.head_branch || row.branch || null,
        last_accessed_at: row.last_accessed_at,
        created_at: row.created_at,
        storage_status: storageStatus,
        html_url: row.html_url || null
      });
    }

    // Take the first `limit` results; anything beyond means hasMore
    const hasMore = reviews.length > limit;
    const pageReviews = hasMore ? reviews.slice(0, limit) : reviews;

    res.json({
      success: true,
      reviews: pageReviews,
      hasMore
    });

  } catch (error) {
    logger.error('Error fetching recent reviews:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent reviews'
    });
  }
});

/**
 * Delete a review and all associated data.
 * Cleans up: worktree directory, worktree record, comments, reviews, and pr_metadata.
 *
 * :id is the pr_metadata.id (integer primary key)
 */
router.delete('/api/worktrees/:id', async (req, res) => {
  try {
    const metadataId = parseInt(req.params.id, 10);

    if (!metadataId || isNaN(metadataId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');

    // Look up pr_metadata to get the composite key
    const metadata = await queryOne(db, `
      SELECT id, pr_number, repository FROM pr_metadata WHERE id = ?
    `, [metadataId]);

    if (!metadata) {
      return res.status(404).json({
        success: false,
        error: 'Review not found'
      });
    }

    const { pr_number: prNumber, repository } = metadata;
    logger.info(`Deleting review for ${repository} #${prNumber} (metadata ID ${metadataId})`);

    // Look up associated worktree for filesystem cleanup
    const worktree = await queryOne(db, `
      SELECT id, path FROM worktrees WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    // Delete the worktree directory if it exists
    if (worktree && worktree.path) {
      try {
        await fs.access(worktree.path);
        await fs.rm(worktree.path, { recursive: true, force: true });
        logger.info(`Deleted worktree directory: ${worktree.path}`);
      } catch {
        logger.warn(`Could not delete worktree directory (may not exist): ${worktree.path}`);
      }
    }

    // Delete all associated database records in a transaction
    await run(db, 'BEGIN TRANSACTION');
    try {
      await run(db, 'DELETE FROM worktrees WHERE pr_number = ? AND repository = ? COLLATE NOCASE', [prNumber, repository]);
      await run(db, 'DELETE FROM chat_sessions WHERE review_id IN (SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE)', [prNumber, repository]);
      await run(db, `
        DELETE FROM comments WHERE review_id IN (
          SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE
        )
      `, [prNumber, repository]);
      await run(db, 'DELETE FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE', [prNumber, repository]);
      await run(db, 'DELETE FROM pr_metadata WHERE id = ?', [metadataId]);
      await run(db, 'COMMIT');
    } catch (txError) {
      await run(db, 'ROLLBACK');
      throw txError;
    }

    logger.success(`Deleted review for ${repository} #${prNumber}`);

    res.json({
      success: true,
      message: `Review for ${repository} #${prNumber} deleted`
    });

  } catch (error) {
    logger.error('Error deleting review:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete review: ' + error.message
    });
  }
});

module.exports = router;
