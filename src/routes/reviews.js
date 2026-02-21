// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unified Review Comment Routes
 *
 * Provides a single set of comment CRUD endpoints under /api/reviews/:reviewId/comments
 * that work for both PR mode and Local mode. This replaces the previously separate
 * comment routes in comments.js (PR mode) and local.js (Local mode).
 */

const express = require('express');
const { query, queryOne, run, CommentRepository, ReviewRepository, AnalysisRunRepository } = require('../database');
const { calculateStats, getStatsQuery } = require('../utils/stats-calculator');
const { activeAnalyses, reviewToAnalysisId } = require('./shared');
const logger = require('../utils/logger');
const { broadcastReviewEvent } = require('../sse/review-events');
const path = require('path');
const fs = require('fs').promises;
const simpleGit = require('simple-git');
const { GitWorktreeManager } = require('../git/worktree');
const { normalizeRepository } = require('../utils/paths');

const router = express.Router();

/**
 * Middleware: validate that :reviewId exists in the reviews table.
 * Attaches the review record to req.review for downstream handlers.
 */
async function validateReviewId(req, res, next) {
  try {
    const reviewId = parseInt(req.params.reviewId, 10);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReview(reviewId);

    if (!review) {
      return res.status(404).json({ error: `Review #${reviewId} not found` });
    }

    req.review = review;
    req.reviewId = reviewId;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/reviews/:reviewId/comments
 * Get all comments for a review.
 * Query params:
 *   - includeDismissed: if 'true', includes dismissed (inactive) comments
 */
router.get('/api/reviews/:reviewId/comments', validateReviewId, async (req, res) => {
  try {
    const { includeDismissed } = req.query;
    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    const comments = await commentRepo.getUserComments(req.reviewId, {
      includeDismissed: includeDismissed === 'true'
    });

    res.json({
      success: true,
      comments: comments || []
    });
  } catch (error) {
    logger.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

/**
 * POST /api/reviews/:reviewId/comments
 * Create a new comment. If line_start is present, creates a line-level comment;
 * otherwise creates a file-level comment.
 */
router.post('/api/reviews/:reviewId/comments', validateReviewId, async (req, res) => {
  try {
    const { file, line_start, line_end, diff_position, side, commit_sha, body, parent_id, type, title } = req.body;

    if (!file || !body) {
      return res.status(400).json({
        error: 'Missing required fields: file, body'
      });
    }

    // Validate body is not just whitespace
    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) {
      return res.status(400).json({
        error: 'Comment body cannot be empty or whitespace only'
      });
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    let commentId;

    if (line_start) {
      // Line-level comment
      commentId = await commentRepo.createLineComment({
        review_id: req.reviewId,
        file,
        line_start,
        line_end,
        diff_position,
        side,
        commit_sha,
        body: trimmedBody,
        parent_id,
        type,
        title
      });
    } else {
      // File-level comment
      commentId = await commentRepo.createFileComment({
        review_id: req.reviewId,
        file,
        body: trimmedBody,
        commit_sha,
        type,
        title,
        parent_id
      });
    }

    res.json({
      success: true,
      commentId,
      message: line_start ? 'Comment saved successfully' : 'File-level comment saved successfully'
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    logger.error('Error creating comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to create comment'
    });
  }
});

/**
 * GET /api/reviews/:reviewId/comments/:id
 * Get a single comment, verifying it belongs to the review.
 */
router.get('/api/reviews/:reviewId/comments/:id', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    const comment = await commentRepo.getComment(id, 'user');

    if (!comment) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    if (comment.review_id !== req.reviewId) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    res.json(comment);
  } catch (error) {
    logger.error('Error fetching comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch comment'
    });
  }
});

/**
 * PUT /api/reviews/:reviewId/comments/:id
 * Update a comment, verifying it belongs to the review.
 */
router.put('/api/reviews/:reviewId/comments/:id', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const { body } = req.body;

    if (!body || !body.trim()) {
      return res.status(400).json({
        error: 'Comment body cannot be empty'
      });
    }

    const db = req.app.get('db');

    // Verify the comment exists and belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [id, req.reviewId]);

    if (!comment) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    const commentRepo = new CommentRepository(db);
    await commentRepo.updateComment(id, body);

    res.json({
      success: true,
      message: 'Comment updated successfully'
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    logger.error('Error updating comment:', error);

    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({
      error: error.message || 'Failed to update comment'
    });
  }
});

/**
 * DELETE /api/reviews/:reviewId/comments/:id
 * Soft-delete a comment, verifying it belongs to the review.
 * If the comment was adopted from an AI suggestion, the parent suggestion
 * is automatically transitioned to 'dismissed' state.
 */
router.delete('/api/reviews/:reviewId/comments/:id', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.get('db');

    // Verify the comment exists and belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [id, req.reviewId]);

    if (!comment) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    const commentRepo = new CommentRepository(db);
    const result = await commentRepo.deleteComment(id);

    res.json({
      success: true,
      message: 'Comment deleted successfully',
      dismissedSuggestionId: result.dismissedSuggestionId
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
    if (result.dismissedSuggestionId) {
      broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });
    }
  } catch (error) {
    logger.error('Error deleting comment:', error);

    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({
      error: error.message || 'Failed to delete comment'
    });
  }
});

/**
 * PUT /api/reviews/:reviewId/comments/:id/restore
 * Restore a dismissed (inactive) comment, verifying it belongs to the review.
 */
router.put('/api/reviews/:reviewId/comments/:id/restore', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const commentId = parseInt(id, 10);

    if (isNaN(commentId)) {
      return res.status(400).json({ error: 'Invalid comment ID' });
    }

    const db = req.app.get('db');

    // Verify the comment exists and belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [commentId, req.reviewId]);

    if (!comment) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    if (comment.status !== 'inactive') {
      return res.status(400).json({ error: 'Comment is not dismissed' });
    }

    const commentRepo = new CommentRepository(db);
    await commentRepo.restoreComment(commentId);

    // Get the restored comment to return
    const restoredComment = await commentRepo.getComment(commentId, 'user');

    res.json({
      success: true,
      message: 'Comment restored successfully',
      comment: restoredComment
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    logger.error('Error restoring comment:', error);

    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message && error.message.includes('not dismissed')) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({
      error: error.message || 'Failed to restore comment'
    });
  }
});

/**
 * DELETE /api/reviews/:reviewId/comments
 * Bulk delete all user comments for a review.
 * Also dismisses any AI suggestions that were parents of the deleted comments.
 */
router.delete('/api/reviews/:reviewId/comments', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');

    // Begin transaction to ensure atomicity
    await run(db, 'BEGIN TRANSACTION');

    try {
      const commentRepo = new CommentRepository(db);
      const result = await commentRepo.bulkDeleteComments(req.reviewId);

      await run(db, 'COMMIT');

      res.json({
        success: true,
        deletedCount: result.deletedCount,
        dismissedSuggestionIds: result.dismissedSuggestionIds,
        message: `Deleted ${result.deletedCount} user comment${result.deletedCount !== 1 ? 's' : ''}`
      });
      broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
      if (result.dismissedSuggestionIds.length > 0) {
        broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });
      }
    } catch (transactionError) {
      await run(db, 'ROLLBACK');
      throw transactionError;
    }
  } catch (error) {
    logger.error('Error deleting comments:', error);
    res.status(500).json({
      error: error.message || 'Failed to delete comments'
    });
  }
});

// ==========================================================================
// AI Suggestion Routes
// ==========================================================================

/**
 * GET /api/reviews/:reviewId/suggestions/check
 * Check whether AI suggestions exist for a review and return summary stats.
 * Query params:
 *   - runId: specific analysis run ID. Default: latest run
 */
router.get('/api/reviews/:reviewId/suggestions/check', validateReviewId, async (req, res) => {
  try {
    const { runId } = req.query;
    const db = req.app.get('db');
    const reviewId = req.reviewId;

    // Check if any AI suggestions exist for this review
    // Exclude raw council voice suggestions (is_raw=1) — only count final/consolidated suggestions
    const result = await queryOne(db, `
      SELECT EXISTS(
        SELECT 1 FROM comments
        WHERE review_id = ? AND source = 'ai' AND (is_raw = 0 OR is_raw IS NULL)
      ) as has_suggestions
    `, [reviewId]);

    const hasSuggestions = result?.has_suggestions === 1;

    // Check if any analysis has been run using analysis_runs table
    let analysisHasRun = hasSuggestions;
    const analysisRunRepo = new AnalysisRunRepository(db);
    let selectedRun = null;
    try {
      // If runId is provided, fetch that specific run; otherwise get the latest
      if (runId) {
        selectedRun = await analysisRunRepo.getById(runId);
      } else {
        selectedRun = await analysisRunRepo.getLatestByReviewId(reviewId);
      }
      analysisHasRun = !!(selectedRun || hasSuggestions);
    } catch (e) {
      logger.debug('analysis_runs query failed, falling back to hasSuggestions:', e.message);
      analysisHasRun = hasSuggestions;
    }

    // Get AI summary from the selected analysis run if available, otherwise fall back to review summary
    const summary = selectedRun?.summary || req.review?.summary || null;

    // Get stats for AI suggestions (issues/suggestions/praise for final level only)
    // Filter by runId if provided, otherwise use the latest analysis run
    let stats = { issues: 0, suggestions: 0, praise: 0 };
    if (hasSuggestions) {
      try {
        const statsQuery = getStatsQuery(runId);
        const statsResult = await query(db, statsQuery.query, statsQuery.params(reviewId));
        stats = calculateStats(statsResult);
      } catch (e) {
        logger.warn('Error fetching AI suggestion stats:', e);
      }
    }

    res.json({
      hasSuggestions: hasSuggestions,
      analysisHasRun: analysisHasRun,
      summary: summary,
      stats: stats
    });
  } catch (error) {
    logger.error('Error checking for AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to check for AI suggestions'
    });
  }
});

/**
 * GET /api/reviews/:reviewId/suggestions
 * Get AI suggestions for a review.
 * Query params:
 *   - levels: comma-separated list of levels (e.g., 'final,1,2'). Default: 'final'
 *   - runId: specific analysis run ID. Default: latest run
 */
router.get('/api/reviews/:reviewId/suggestions', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');
    const reviewId = req.reviewId;

    // Parse levels query parameter (e.g., ?levels=final,1,2)
    // Default to 'final' (orchestrated suggestions only) if not specified
    const levelsParam = req.query.levels || 'final';
    const requestedLevels = levelsParam.split(',').map(l => l.trim());

    // Parse optional runId query parameter to fetch suggestions from a specific analysis run
    // If not provided, defaults to the latest run
    const runIdParam = req.query.runId;

    // Build level filter clause
    const levelConditions = [];
    requestedLevels.forEach(level => {
      if (level === 'final') {
        levelConditions.push('ai_level IS NULL');
      } else if (['1', '2', '3'].includes(level)) {
        levelConditions.push(`ai_level = ${parseInt(level)}`);
      }
    });

    // If no valid levels specified, default to final
    const levelFilter = levelConditions.length > 0
      ? `(${levelConditions.join(' OR ')})`
      : 'ai_level IS NULL';

    // Build the run ID filter clause
    // If a specific runId is provided, use it directly; otherwise use subquery for latest
    let runIdFilter;
    let queryParams;
    if (runIdParam) {
      runIdFilter = 'ai_run_id = ?';
      queryParams = [reviewId, runIdParam];
    } else {
      // Get AI suggestions from the comments table
      // Only return suggestions from the latest analysis run (ai_run_id)
      // This preserves history while showing only the most recent results
      //
      // Note: If no AI suggestions exist (subquery returns NULL), the ai_run_id = NULL
      // comparison returns no rows. This is intentional - we only show suggestions
      // when there's a matching analysis run.
      //
      // Note: reviewId is passed twice because SQLite requires separate parameters
      // for the outer WHERE clause and the subquery. A CTE could consolidate this but
      // adds complexity without meaningful benefit here.
      runIdFilter = `ai_run_id = (
          SELECT ai_run_id FROM comments
          WHERE review_id = ? AND source = 'ai' AND ai_run_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        )`;
      queryParams = [reviewId, reviewId];
    }

    const rows = await query(db, `
      SELECT
        id,
        source,
        author,
        ai_run_id,
        ai_level,
        ai_confidence,
        file,
        line_start,
        line_end,
        side,
        type,
        title,
        body,
        reasoning,
        status,
        is_file_level,
        created_at,
        updated_at
      FROM comments
      WHERE review_id = ?
        AND source = 'ai'
        AND ${levelFilter}
        AND status IN ('active', 'dismissed', 'adopted', 'draft', 'submitted')
        AND (is_raw = 0 OR is_raw IS NULL)
        AND ${runIdFilter}
      ORDER BY
        CASE
          WHEN ai_level IS NULL THEN 0
          WHEN ai_level = 1 THEN 1
          WHEN ai_level = 2 THEN 2
          WHEN ai_level = 3 THEN 3
          ELSE 4
        END,
        is_file_level DESC,
        file,
        line_start
    `, queryParams);

    const suggestions = rows.map(row => ({
      ...row,
      reasoning: row.reasoning ? JSON.parse(row.reasoning) : null
    }));

    res.json({ suggestions });

  } catch (error) {
    logger.error('Error fetching AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to fetch AI suggestions'
    });
  }
});

/**
 * POST /api/reviews/:reviewId/suggestions/:id/status
 * Update AI suggestion status (adopt/dismiss/restore).
 */
router.post('/api/reviews/:reviewId/suggestions/:id/status', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['adopted', 'dismissed', 'active'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid status. Must be "adopted", "dismissed", or "active"'
      });
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Get the suggestion
    const suggestion = await commentRepo.getComment(id, 'ai');

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    // Verify suggestion belongs to this review
    if (suggestion.review_id !== req.reviewId) {
      return res.status(403).json({
        error: 'Suggestion does not belong to this review'
      });
    }

    // Update suggestion status using repository
    await commentRepo.updateSuggestionStatus(id, status);

    res.json({
      success: true,
      status
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });

  } catch (error) {
    logger.error('Error updating suggestion status:', error);
    res.status(500).json({
      error: error.message || 'Failed to update suggestion status'
    });
  }
});

/**
 * POST /api/reviews/:reviewId/suggestions/:id/edit
 * Edit AI suggestion and adopt as user comment.
 */
router.post('/api/reviews/:reviewId/suggestions/:id/edit', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const { editedText, action } = req.body;

    if (action !== 'adopt_edited') {
      return res.status(400).json({
        error: 'Invalid action. Must be "adopt_edited"'
      });
    }

    if (!editedText || !editedText.trim()) {
      return res.status(400).json({
        error: 'Edited text cannot be empty'
      });
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Get the suggestion to validate it exists
    const suggestion = await commentRepo.getComment(id, 'ai');

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    // Verify suggestion belongs to this review
    if (suggestion.review_id !== req.reviewId) {
      return res.status(403).json({
        error: 'Suggestion does not belong to this review'
      });
    }

    // Adopt the suggestion with edited text using repository
    const userCommentId = await commentRepo.adoptSuggestion(id, editedText);

    // Update suggestion status to adopted and link to user comment
    await commentRepo.updateSuggestionStatus(id, 'adopted', userCommentId);

    res.json({
      success: true,
      userCommentId,
      message: 'Suggestion edited and adopted as user comment'
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });

  } catch (error) {
    logger.error('Error editing suggestion:', error);
    res.status(500).json({
      error: error.message || 'Failed to edit suggestion'
    });
  }
});

// ==========================================================================
// Analysis Status Route
// ==========================================================================

/**
 * GET /api/reviews/:reviewId/analyses/status
 * Check if an analysis is running for a given review.
 * Replaces both:
 *   - GET /api/pr/:owner/:repo/:number/analysis-status
 *   - GET /api/local/:reviewId/analysis-status
 */
router.get('/api/reviews/:reviewId/analyses/status', validateReviewId, async (req, res) => {
  try {
    const reviewId = req.reviewId;

    // 1. Check unified in-memory map
    const analysisId = reviewToAnalysisId.get(reviewId);

    if (analysisId) {
      const analysis = activeAnalyses.get(analysisId);

      if (analysis) {
        return res.json({
          running: true,
          analysisId,
          status: analysis
        });
      }

      // Clean up stale mapping
      reviewToAnalysisId.delete(reviewId);
    }

    // 2. Fall back to database — an analysis may have been started externally (e.g. via MCP)
    const db = req.app.get('db');
    const analysisRunRepo = new AnalysisRunRepository(db);
    const latestRun = await analysisRunRepo.getLatestByReviewId(reviewId);

    if (latestRun && latestRun.status === 'running') {
      return res.json({
        running: true,
        analysisId: latestRun.id,
        status: {
          id: latestRun.id,
          reviewId,
          status: 'running',
          startedAt: latestRun.started_at,
          progress: 'Analysis in progress...',
          levels: {
            1: { status: 'running', progress: 'Running...' },
            2: { status: 'running', progress: 'Running...' },
            3: { status: 'running', progress: 'Running...' },
            4: { status: 'pending', progress: 'Pending' }
          },
          filesAnalyzed: latestRun.files_analyzed || 0,
          filesRemaining: 0
        }
      });
    }

    // 3. Not running
    res.json({
      running: false,
      analysisId: null,
      status: null
    });

  } catch (error) {
    logger.error('Error checking review analysis status:', error);
    res.status(500).json({
      error: 'Failed to check analysis status'
    });
  }
});

// ==========================================================================
// Hunk Expansion Route
// ==========================================================================

/**
 * POST /api/reviews/:reviewId/expand-hunk
 * Broadcast a request to expand a hidden hunk in the diff view.
 * This is a transient UI command — no database writes.
 *
 * Body: { file, line_start, line_end, side? }
 *   - file: (string, required) path of the file whose hunk to expand
 *   - line_start: (integer, required) first line to reveal (>= 1)
 *   - line_end: (integer, required) last line to reveal (>= line_start)
 *   - side: ('left' | 'right', optional, default 'right')
 */
router.post('/api/reviews/:reviewId/expand-hunk', validateReviewId, async (req, res) => {
  try {
    const { file, line_start, line_end, side } = req.body;

    // --- validation ---
    if (!file || typeof file !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid required field: file' });
    }

    if (!Number.isInteger(line_start) || line_start < 1) {
      return res.status(400).json({ error: 'Missing or invalid required field: line_start (must be a positive integer)' });
    }

    if (!Number.isInteger(line_end) || line_end < line_start) {
      return res.status(400).json({ error: 'Missing or invalid required field: line_end (must be an integer >= line_start)' });
    }

    const resolvedSide = side || 'right';
    if (!['left', 'right'].includes(resolvedSide)) {
      return res.status(400).json({ error: 'Invalid value for side: must be "left" or "right"' });
    }

    // --- broadcast ---
    broadcastReviewEvent(req.reviewId, {
      type: 'review:expand_hunk',
      file,
      line_start,
      line_end,
      side: resolvedSide
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting expand-hunk event:', error);
    res.status(500).json({ error: 'Failed to broadcast expand-hunk event' });
  }
});

/**
 * GET /api/reviews/:reviewId/file-content/:fileName(*)
 * Fetch file content for context expansion and context files.
 * Replaces the legacy /api/file-content-original/ endpoint by using
 * the review record to determine local vs PR mode.
 */
router.get('/api/reviews/:reviewId/file-content/:fileName(*)', validateReviewId, async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);
    const review = req.review;
    const db = req.app.get('db');

    // Local mode: use local_path + local_head_sha
    if (review.review_type === 'local' || review.local_path) {
      const localPath = review.local_path;
      if (!localPath) {
        return res.status(404).json({ error: 'Local review missing path' });
      }

      const localHeadSha = review.local_head_sha;

      // Try git show for HEAD version (correct line numbers for diff)
      if (localHeadSha) {
        try {
          const git = simpleGit(localPath);
          const content = await git.show([`${localHeadSha}:${fileName}`]);
          const lines = content.split('\n');
          return res.json({ fileName, lines, totalLines: lines.length });
        } catch (gitError) {
          logger.debug(`Could not read file ${fileName} from HEAD: ${gitError.message}, falling back to working directory`);
        }
      }

      // Fallback: read from filesystem
      const filePath = path.join(localPath, fileName);
      try {
        const realFilePath = await fs.realpath(filePath);
        const realLocalPath = await fs.realpath(localPath);
        if (!realFilePath.startsWith(realLocalPath + path.sep) && realFilePath !== realLocalPath) {
          return res.status(403).json({ error: 'Access denied: path outside repository' });
        }
        const content = await fs.readFile(realFilePath, 'utf8');
        const lines = content.split('\n');
        return res.json({ fileName, lines, totalLines: lines.length });
      } catch (fileError) {
        if (fileError.code === 'ENOENT') {
          return res.status(404).json({ error: 'File not found in local repository' });
        } else if (fileError.code === 'EISDIR') {
          return res.status(400).json({ error: 'Path is a directory, not a file' });
        }
        throw fileError;
      }
    }

    // PR mode: use pr_number + repository to find worktree
    const prNumber = review.pr_number;
    const repository = review.repository;

    if (!prNumber || !repository) {
      return res.status(400).json({ error: 'Review missing PR metadata' });
    }

    const [owner, repo] = repository.split('/');
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({ error: 'Worktree not found for this PR. The PR may need to be reloaded.' });
    }

    // Get base_sha from stored PR data
    const normalizedRepo = normalizeRepository(owner, repo);
    const prRecord = await queryOne(db, `
      SELECT pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, normalizedRepo]);

    let baseSha = null;
    if (prRecord?.pr_data) {
      try {
        const prData = JSON.parse(prRecord.pr_data);
        baseSha = prData.base_sha;
      } catch (parseError) {
        logger.warn('Could not parse pr_data for base_sha:', parseError.message);
      }
    }

    // Try git show for BASE version (correct line numbers for diff)
    if (baseSha) {
      try {
        const git = simpleGit(worktreePath);
        const content = await git.show([`${baseSha}:${fileName}`]);
        const lines = content.split('\n');
        return res.json({ fileName, lines, totalLines: lines.length });
      } catch (gitError) {
        logger.debug(`Could not read file ${fileName} from base commit: ${gitError.message}, falling back to HEAD`);
      }
    }

    // Fallback: read from filesystem
    const filePath = path.join(worktreePath, fileName);
    try {
      const realFilePath = await fs.realpath(filePath);
      const realWorktreePath = await fs.realpath(worktreePath);
      if (!realFilePath.startsWith(realWorktreePath + path.sep) && realFilePath !== realWorktreePath) {
        return res.status(403).json({ error: 'Access denied: path outside repository' });
      }
      const content = await fs.readFile(realFilePath, 'utf8');
      const lines = content.split('\n');
      return res.json({ fileName, lines, totalLines: lines.length });
    } catch (fileError) {
      if (fileError.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found in worktree' });
      } else if (fileError.code === 'EISDIR') {
        return res.status(400).json({ error: 'Path is a directory, not a file' });
      }
      throw fileError;
    }
  } catch (error) {
    logger.error('Error retrieving file content:', error);
    res.status(500).json({ error: 'Internal server error while retrieving file content' });
  }
});

module.exports = router;
