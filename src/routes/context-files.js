// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Context Files Routes
 *
 * Provides endpoints for managing context file ranges that pin specific
 * line ranges from non-diff files into the diff panel for review.
 *
 * All endpoints live under /api/reviews/:reviewId/context-files
 */

const express = require('express');
const { promisify } = require('util');
const { exec } = require('child_process');
const { queryOne, ReviewRepository, ContextFileRepository } = require('../database');
const logger = require('../utils/logger');
const { broadcastReviewEvent } = require('../sse/review-events');

const execPromise = promisify(exec);

const router = express.Router();

/**
 * Return the list of file paths that belong to the review's diff.
 * Works for both PR-mode and local-mode reviews.
 *
 * @param {object} db   - SQLite database handle
 * @param {object} review - Review row from the database
 * @returns {Promise<string[]>} Array of relative file paths in the diff
 */
async function getDiffFileList(db, review) {
  // PR mode – pull from pr_metadata table
  if (review.pr_number && review.repository) {
    try {
      const prRecord = await queryOne(db, `
        SELECT pr_data FROM pr_metadata
        WHERE pr_number = ? AND repository = ? COLLATE NOCASE
      `, [review.pr_number, review.repository]);

      if (prRecord?.pr_data) {
        const prData = JSON.parse(prRecord.pr_data);
        return (prData.changed_files || []).map(f => f.file);
      }
    } catch {
      // parse / query error – fall through to empty list
    }
    return [];
  }

  // Local mode – ask git for changed / untracked files
  if (review.local_path) {
    try {
      const opts = { cwd: review.local_path };
      const [{ stdout: unstaged }, { stdout: untracked }] = await Promise.all([
        execPromise('git diff --name-only', opts),
        execPromise('git ls-files --others --exclude-standard', opts),
      ]);
      const combined = `${unstaged}\n${untracked}`
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      return [...new Set(combined)];
    } catch {
      // git error – fall through to empty list
    }
    return [];
  }

  return [];
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
