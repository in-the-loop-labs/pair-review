// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Worktree Management Routes
 *
 * Handles all worktree-related endpoints:
 * - Creating worktrees from PR URLs
 * - Getting recent worktrees
 * - Deleting worktrees
 */

const express = require('express');
const { query, queryOne, run, ReviewRepository, WorktreePoolRepository } = require('../database');
const { setupPRReview } = require('../setup/pr-setup');
const { GitHubApiError } = require('../github/client');
const { GitWorktreeManager } = require('../git/worktree');
const { activeAnalyses, reviewToAnalysisId, killProcesses, broadcastProgress } = require('./shared');
const { AnalysisRunRepository } = require('../database');
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
      poolLifecycle: req.app.get('poolLifecycle'),
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
        w.branch,
        (SELECT r.id FROM reviews r WHERE r.pr_number = pm.pr_number AND r.repository = pm.repository COLLATE NOCASE ORDER BY r.updated_at DESC LIMIT 1) as review_id
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
          // Worktree dir missing — clean up stale record asynchronously on first page,
          // but only if it's not a pool worktree (pool worktrees are managed separately)
          if (!before) {
            setImmediate(async () => {
              try {
                const poolRepo = new WorktreePoolRepository(db);
                const isPool = await poolRepo.isPoolWorktree(row.worktree_id);
                if (!isPool) {
                  await run(db, 'DELETE FROM worktrees WHERE id = ?', [row.worktree_id]);
                  logger.info(`Cleaned up stale worktree record ${row.worktree_id}`);
                }
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
        html_url: row.html_url || null,
        review_id: row.review_id || null
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
 * Delete a single review by pr_metadata ID.
 * Cleans up: worktree directory, worktree record, comments, reviews, and pr_metadata.
 *
 * @param {object} db - Database handle
 * @param {number} metadataId - pr_metadata.id
 * @param {import('../git/worktree-pool-lifecycle').WorktreePoolLifecycle} [poolLifecycle] - Pool lifecycle manager (optional)
 * @returns {{ success: boolean, message: string }}
 * @throws {Error} if deletion fails
 */
async function deleteReviewById(db, metadataId, poolLifecycle) {
  const metadata = await queryOne(db, `
    SELECT id, pr_number, repository FROM pr_metadata WHERE id = ?
  `, [metadataId]);

  if (!metadata) {
    return { success: false, message: 'Review not found' };
  }

  const { pr_number: prNumber, repository } = metadata;
  logger.info(`Deleting review for ${repository} #${prNumber} (metadata ID ${metadataId})`);

  // Look up associated worktree path for cleanup after DB commit
  const worktree = await queryOne(db, `
    SELECT id, path FROM worktrees WHERE pr_number = ? AND repository = ? COLLATE NOCASE
  `, [prNumber, repository]);

  // Check if this worktree belongs to the pool — pool worktrees are preserved
  const poolRepo = poolLifecycle ? poolLifecycle.poolRepo : new WorktreePoolRepository(db);
  const isPool = worktree ? await poolRepo.isPoolWorktree(worktree.id) : false;

  // Delete all associated database records in a transaction
  await run(db, 'BEGIN TRANSACTION');
  try {
    // Pool worktrees: keep the worktrees row and pool entry intact
    if (!isPool) {
      await run(db, 'DELETE FROM worktrees WHERE pr_number = ? AND repository = ? COLLATE NOCASE', [prNumber, repository]);
    }
    await run(db, 'DELETE FROM chat_sessions WHERE review_id IN (SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE)', [prNumber, repository]);
    await run(db, `
      DELETE FROM comments WHERE review_id IN (
        SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE
      )
    `, [prNumber, repository]);
    await run(db, 'DELETE FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE', [prNumber, repository]);
    await run(db, 'DELETE FROM pr_metadata WHERE id = ?', [metadataId]);
    // Clean up cached GitHub PR data
    const parts = repository.split('/');
    if (parts.length === 2) {
      await run(db, 'DELETE FROM github_pr_cache WHERE owner = ? AND repo = ? AND number = ?', [parts[0], parts[1], prNumber]);
    }
    await run(db, 'COMMIT');
  } catch (txError) {
    await run(db, 'ROLLBACK');
    throw txError;
  }

  // Clean up worktree AFTER successful DB commit so rollback doesn't orphan data
  // Pool worktrees: skip filesystem cleanup, mark as available instead
  if (isPool) {
    // Cancel any active analyses reading from this worktree before returning
    // the slot to the pool.  Without this, a reclaimed worktree could have its
    // filesystem switched out from under a still-running analysis subprocess.
    const activeAnalysisIds = poolLifecycle ? poolLifecycle.getActiveAnalyses(worktree.id) : new Set();
    if (activeAnalysisIds.size > 0) {
      const analysisRunRepo = new AnalysisRunRepository(db);
      for (const analysisId of activeAnalysisIds) {
        killProcesses(analysisId);
        const analysis = activeAnalyses.get(analysisId);
        if (analysis) {
          const cancelledStatus = { ...analysis, status: 'cancelled', cancelledAt: new Date().toISOString(), progress: 'Cancelled — review deleted' };
          activeAnalyses.set(analysisId, cancelledStatus);
          broadcastProgress(analysisId, cancelledStatus);
          if (analysis.reviewId) reviewToAnalysisId.delete(analysis.reviewId);
        }
        if (analysis?.runId) {
          try { await analysisRunRepo.update(analysis.runId, { status: 'cancelled' }); } catch { /* best effort */ }
        }
      }
      logger.info(`Cancelled ${activeAnalysisIds.size} active analysis(es) on pool worktree ${worktree.id}`);
    }

    // Release all in-memory tracking and mark the slot available in DB so it
    // cleanly returns to the pool.
    if (poolLifecycle) {
      await poolLifecycle.releaseForDeletion(worktree.id);
    }
    logger.info(`Pool worktree ${worktree.id} cleared and marked available after review deletion`);
  } else if (worktree && worktree.path) {
    try {
      const worktreeManager = new GitWorktreeManager(db);
      await worktreeManager.cleanupWorktree(worktree.path);
      logger.info(`Cleaned up worktree: ${worktree.path}`);
    } catch {
      logger.warn(`Could not clean up worktree (may not exist): ${worktree.path}`);
    }
  }

  logger.success(`Deleted review for ${repository} #${prNumber}`);
  return { success: true, message: `Review for ${repository} #${prNumber} deleted` };
}

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
    const poolLifecycle = req.app.get('poolLifecycle');
    const result = await deleteReviewById(db, metadataId, poolLifecycle);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.message
      });
    }

    res.json({
      success: true,
      message: result.message
    });

  } catch (error) {
    logger.error('Error deleting review:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete review: ' + error.message
    });
  }
});

/**
 * Bulk delete reviews by pr_metadata IDs.
 * Accepts { ids: number[] } in request body. Max 50 IDs per request.
 * Each deletion is independent — partial failures are reported per-ID.
 */
router.post('/api/worktrees/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Request body must contain a non-empty "ids" array'
      });
    }

    if (ids.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 50 IDs per request'
      });
    }

    const parsedIds = ids.map(id => parseInt(id, 10));
    if (parsedIds.some(id => isNaN(id) || id <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'All IDs must be positive integers'
      });
    }

    const db = req.app.get('db');
    const poolLifecycle = req.app.get('poolLifecycle');
    let deleted = 0;
    const errors = [];

    for (const id of parsedIds) {
      try {
        const result = await deleteReviewById(db, id, poolLifecycle);
        if (result.success) {
          deleted++;
        } else {
          errors.push({ id, error: result.message });
        }
      } catch (err) {
        errors.push({ id, error: err.message });
      }
    }

    if (deleted > 0) logger.success(`Bulk deleted ${deleted} review(s)`);

    res.json({
      success: deleted > 0 || errors.length === 0,
      deleted,
      failed: errors.length,
      errors
    });

  } catch (error) {
    logger.error('Error in bulk delete:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process bulk delete: ' + error.message
    });
  }
});

module.exports = router;
