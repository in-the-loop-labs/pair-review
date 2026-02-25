// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Context Files Routes
 *
 * Provides endpoints for managing context file ranges that pin specific
 * line ranges from non-diff files into the diff panel for review.
 *
 * All endpoints live under /api/reviews/:reviewId/context-files
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { ReviewRepository, ContextFileRepository, WorktreeRepository } = require('../database');
const logger = require('../utils/logger');
const { broadcastReviewEvent } = require('../sse/review-events');
const { getDiffFileList } = require('../utils/diff-file-list');

const router = express.Router();

/**
 * Resolve the repository root directory for a review.
 * Local reviews use local_path; PR reviews look up the worktree path.
 * Returns null when the root cannot be determined (e.g. worktree not set up).
 *
 * @param {object} db     - SQLite database handle
 * @param {object} review - Review row from the database
 * @returns {Promise<string|null>} Absolute path to the repo root, or null
 */
async function resolveRepoRoot(db, review) {
  // Local mode – the path is stored directly on the review record
  if (review.local_path) {
    return review.local_path;
  }

  // PR mode – look up the worktree record
  if (review.pr_number && review.repository) {
    const worktreeRepo = new WorktreeRepository(db);
    const worktree = await worktreeRepo.findByPR(review.pr_number, review.repository);
    if (worktree && worktree.path) {
      return worktree.path;
    }
  }

  return null;
}

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
 * POST /api/reviews/:reviewId/context-files
 * Add a context file range for a review.
 * Body: { file, line_start, line_end, label? }
 */
router.post('/api/reviews/:reviewId/context-files', validateReviewId, async (req, res) => {
  try {
    const { file, line_start, line_end, label } = req.body;

    // Validate: file is required and non-empty string
    if (!file || typeof file !== 'string' || file.trim().length === 0) {
      return res.status(400).json({ error: 'file is required and must be a non-empty string' });
    }

    if (file.includes('..') || file.startsWith('/')) {
      return res.status(400).json({ error: 'file must be a relative path without .. segments' });
    }

    // Validate: line_start and line_end are positive integers
    const lineStart = parseInt(line_start, 10);
    const lineEnd = parseInt(line_end, 10);

    if (isNaN(lineStart) || lineStart <= 0) {
      return res.status(400).json({ error: 'line_start must be a positive integer' });
    }

    if (isNaN(lineEnd) || lineEnd <= 0) {
      return res.status(400).json({ error: 'line_end must be a positive integer' });
    }

    // Validate: line_end >= line_start
    if (lineEnd < lineStart) {
      return res.status(400).json({ error: 'line_end must be >= line_start' });
    }

    // Validate: max range of 500 lines
    if (lineEnd - lineStart + 1 > 500) {
      return res.status(400).json({ error: 'Range cannot exceed 500 lines' });
    }

    const db = req.app.get('db');

    // Reject files that are already part of the review's diff
    const diffFiles = await getDiffFileList(db, req.review);
    if (diffFiles.includes(file.trim())) {
      return res.status(400).json({
        error: `Cannot add context file: '${file.trim()}' is already part of the diff`
      });
    }

    // Validate that the file exists on disk when we can resolve the repo root
    const repoRoot = await resolveRepoRoot(db, req.review);
    if (repoRoot) {
      const resolved = path.resolve(repoRoot, file.trim());
      // Double-check the resolved path is still within the repo root (belt-and-suspenders with the .. check above)
      if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
        return res.status(400).json({ error: 'file must be a relative path without .. segments' });
      }
      if (!fs.existsSync(resolved)) {
        return res.status(400).json({ error: 'File not found in repository' });
      }
    }

    const contextFileRepo = new ContextFileRepository(db);

    const record = await contextFileRepo.add(
      req.reviewId,
      file.trim(),
      lineStart,
      lineEnd,
      label || null
    );

    res.status(201).json({ success: true, contextFile: record });
    broadcastReviewEvent(req.reviewId, { type: 'review:context_files_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    logger.error('Error adding context file:', error);
    res.status(500).json({ error: 'Failed to add context file' });
  }
});

/**
 * GET /api/reviews/:reviewId/context-files
 * List all context file ranges for a review.
 */
router.get('/api/reviews/:reviewId/context-files', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');
    const contextFileRepo = new ContextFileRepository(db);

    const contextFiles = await contextFileRepo.getByReviewId(req.reviewId);

    res.json({ success: true, contextFiles: contextFiles || [] });
  } catch (error) {
    logger.error('Error fetching context files:', error);
    res.status(500).json({ error: 'Failed to fetch context files' });
  }
});

/**
 * PATCH /api/reviews/:reviewId/context-files/:id
 * Update the line range of an existing context file entry.
 * Body: { line_start, line_end }
 */
router.patch('/api/reviews/:reviewId/context-files/:id', validateReviewId, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid context file ID' });
    }

    const { line_start, line_end } = req.body;

    const lineStart = parseInt(line_start, 10);
    const lineEnd = parseInt(line_end, 10);

    if (isNaN(lineStart) || lineStart <= 0) {
      return res.status(400).json({ error: 'line_start must be a positive integer' });
    }

    if (isNaN(lineEnd) || lineEnd <= 0) {
      return res.status(400).json({ error: 'line_end must be a positive integer' });
    }

    if (lineEnd < lineStart) {
      return res.status(400).json({ error: 'line_end must be >= line_start' });
    }

    if (lineEnd - lineStart + 1 > 500) {
      return res.status(400).json({ error: 'Range cannot exceed 500 lines' });
    }

    const db = req.app.get('db');
    const contextFileRepo = new ContextFileRepository(db);

    const updated = await contextFileRepo.updateRange(id, req.reviewId, lineStart, lineEnd);

    if (!updated) {
      return res.status(404).json({ error: 'Context file not found' });
    }

    res.json({ success: true });
    broadcastReviewEvent(req.reviewId, { type: 'review:context_files_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    logger.error('Error updating context file range:', error);
    res.status(500).json({ error: 'Failed to update context file range' });
  }
});

/**
 * DELETE /api/reviews/:reviewId/context-files/:id
 * Remove a single context file range by ID.
 */
router.delete('/api/reviews/:reviewId/context-files/:id', validateReviewId, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid context file ID' });
    }

    const db = req.app.get('db');
    const contextFileRepo = new ContextFileRepository(db);

    const deleted = await contextFileRepo.remove(id, req.reviewId);

    if (!deleted) {
      return res.status(404).json({ error: 'Context file not found' });
    }

    res.json({ success: true, message: 'Context file removed' });
    broadcastReviewEvent(req.reviewId, { type: 'review:context_files_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    logger.error('Error removing context file:', error);
    res.status(500).json({ error: 'Failed to remove context file' });
  }
});

/**
 * DELETE /api/reviews/:reviewId/context-files
 * Remove all context file ranges for a review.
 */
router.delete('/api/reviews/:reviewId/context-files', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');
    const contextFileRepo = new ContextFileRepository(db);

    const deletedCount = await contextFileRepo.removeAll(req.reviewId);

    res.json({ success: true, deletedCount, message: `Removed ${deletedCount} context file${deletedCount !== 1 ? 's' : ''}` });
    broadcastReviewEvent(req.reviewId, { type: 'review:context_files_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    logger.error('Error removing all context files:', error);
    res.status(500).json({ error: 'Failed to remove context files' });
  }
});

module.exports = router;
