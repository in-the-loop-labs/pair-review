// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Comment CRUD Routes
 *
 * Handles all comment-related endpoints:
 * - AI suggestion status updates and editing
 * - User comment CRUD operations
 * - Bulk comment operations
 */

const express = require('express');
const { queryOne, run, CommentRepository, ReviewRepository } = require('../database');
const { normalizeRepository } = require('../utils/paths');

const router = express.Router();

/**
 * Helper function to verify that a review_id exists.
 * Checks both reviews table (for PR and local mode) and pr_metadata table (legacy).
 * @param {Database} db - Database instance
 * @param {number} reviewId - The review_id to verify
 * @returns {Promise<boolean>} True if the ID exists in either table
 */
async function verifyReviewIdExists(db, reviewId) {
  // First check reviews table (preferred - handles both PR and local mode)
  const review = await queryOne(db, `
    SELECT id FROM reviews WHERE id = ?
  `, [reviewId]);

  if (review) {
    return true;
  }

  // Fall back to checking pr_metadata for legacy compatibility
  // This handles cases where old data used prMetadata.id directly
  const prMetadata = await queryOne(db, `
    SELECT id FROM pr_metadata WHERE id = ?
  `, [reviewId]);

  return !!prMetadata;
}

/**
 * Edit AI suggestion and adopt as user comment
 */
router.post('/api/ai-suggestion/:id/edit', async (req, res) => {
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

    // Get the suggestion to validate PR exists
    const suggestion = await commentRepo.getComment(id, 'ai');

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    // Validate PR/review exists (checks both reviews and pr_metadata tables)
    const exists = await verifyReviewIdExists(db, suggestion.review_id);

    if (!exists) {
      return res.status(404).json({
        error: 'Associated pull request or review not found'
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

  } catch (error) {
    console.error('Error editing suggestion:', error);
    res.status(500).json({
      error: error.message || 'Failed to edit suggestion'
    });
  }
});

/**
 * Update AI suggestion status
 * Sets status to 'adopted', 'dismissed', or 'active' (restored)
 * Note: This only updates the status flag. For 'adopted' status, the actual
 * user comment creation is handled separately via /api/user-comment endpoint.
 */
router.post('/api/ai-suggestion/:id/status', async (req, res) => {
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

    // Update suggestion status using repository
    await commentRepo.updateSuggestionStatus(id, status);

    res.json({
      success: true,
      status
    });

  } catch (error) {
    console.error('Error updating suggestion status:', error);
    res.status(500).json({
      error: error.message || 'Failed to update suggestion status'
    });
  }
});

/**
 * Create file-level user comment
 * File-level comments are about an entire file, not tied to specific lines
 */
router.post('/api/file-comment', async (req, res) => {
  try {
    const { review_id, file, body, commit_sha, parent_id, type, title } = req.body;

    if (!review_id || !file || !body) {
      return res.status(400).json({
        error: 'Missing required fields: review_id, file, body'
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

    // Verify PR/review exists (checks both reviews and pr_metadata tables)
    const exists = await verifyReviewIdExists(db, review_id);

    if (!exists) {
      return res.status(404).json({
        error: 'Pull request or review not found'
      });
    }

    // Create file-level user comment using repository
    const commentRepo = new CommentRepository(db);
    const commentId = await commentRepo.createFileComment({
      review_id,
      file,
      body: trimmedBody,
      commit_sha,
      type,
      title,
      parent_id
    });

    res.json({
      success: true,
      commentId,
      message: 'File-level comment saved successfully'
    });

  } catch (error) {
    console.error('Error creating file-level comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to create file-level comment'
    });
  }
});

/**
 * Create user comment
 */
router.post('/api/user-comment', async (req, res) => {
  try {
    const { review_id, file, line_start, line_end, diff_position, side, commit_sha, body, parent_id, type, title } = req.body;

    if (!review_id || !file || !line_start || !body) {
      return res.status(400).json({
        error: 'Missing required fields: review_id, file, line_start, body'
      });
    }

    const db = req.app.get('db');

    // Verify PR/review exists (checks both reviews and pr_metadata tables)
    const exists = await verifyReviewIdExists(db, review_id);

    if (!exists) {
      return res.status(404).json({
        error: 'Pull request or review not found'
      });
    }

    // Create user comment using repository
    const commentRepo = new CommentRepository(db);
    const commentId = await commentRepo.createLineComment({
      review_id,
      file,
      line_start,
      line_end,
      diff_position,
      side,
      commit_sha,
      body,
      parent_id,
      type,
      title
    });

    res.json({
      success: true,
      commentId,
      message: 'Comment saved successfully'
    });

  } catch (error) {
    console.error('Error creating user comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to create comment'
    });
  }
});

/**
 * Get user comments for a PR (by owner/repo/number format for consistency)
 * Query params:
 * - includeDismissed: if 'true', includes dismissed (inactive) comments
 */
router.get('/api/pr/:owner/:repo/:number/user-comments', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { includeDismissed } = req.query;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    // Get or create a review record for this PR
    // Comments are associated with review.id to avoid ID collision with local mode
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReviewByPR(prNumber, repository);

    if (!review) {
      return res.json({
        success: true,
        comments: []
      });
    }

    // Use CommentRepository to fetch comments with options
    const commentRepo = new CommentRepository(db);
    const comments = await commentRepo.getUserComments(review.id, {
      includeDismissed: includeDismissed === 'true'
    });

    res.json({
      success: true,
      comments: comments || []
    });

  } catch (error) {
    console.error('Error fetching user comments:', error);
    res.status(500).json({
      error: 'Failed to fetch user comments'
    });
  }
});

/**
 * Get single user comment
 */
router.get('/api/user-comment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    const comment = await commentRepo.getComment(id, 'user');

    if (!comment) {
      return res.status(404).json({
        error: 'User comment not found'
      });
    }

    res.json(comment);

  } catch (error) {
    console.error('Error fetching user comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch comment'
    });
  }
});

/**
 * Update user comment
 */
router.put('/api/user-comment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { body } = req.body;

    if (!body || !body.trim()) {
      return res.status(400).json({
        error: 'Comment body cannot be empty'
      });
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Update comment using repository
    await commentRepo.updateComment(id, body);

    res.json({
      success: true,
      message: 'Comment updated successfully'
    });

  } catch (error) {
    console.error('Error updating user comment:', error);

    // Return 404 if comment not found
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message
      });
    }

    res.status(500).json({
      error: error.message || 'Failed to update comment'
    });
  }
});

/**
 * Delete user comment
 * If the comment was adopted from an AI suggestion, the parent suggestion
 * is automatically transitioned to 'dismissed' state.
 */
router.delete('/api/user-comment/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Soft delete using repository (also dismisses parent AI suggestion if applicable)
    const result = await commentRepo.deleteComment(id);

    res.json({
      success: true,
      message: 'Comment deleted successfully',
      dismissedSuggestionId: result.dismissedSuggestionId
    });

  } catch (error) {
    console.error('Error deleting user comment:', error);

    // Return 404 if comment not found
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message
      });
    }

    res.status(500).json({
      error: error.message || 'Failed to delete comment'
    });
  }
});

/**
 * Restore a dismissed user comment
 * Sets status from 'inactive' back to 'active'
 */
router.put('/api/user-comment/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const commentId = parseInt(id, 10);

    if (isNaN(commentId)) {
      return res.status(400).json({ error: 'Invalid comment ID' });
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Restore the comment
    await commentRepo.restoreComment(commentId);

    // Get the restored comment to return
    const comment = await commentRepo.getComment(commentId, 'user');

    res.json({
      success: true,
      message: 'Comment restored successfully',
      comment
    });

  } catch (error) {
    console.error('Error restoring user comment:', error);

    // Return 404 if comment not found
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message
      });
    }

    // Return 400 if comment is not dismissed
    if (error.message && error.message.includes('not dismissed')) {
      return res.status(400).json({
        error: error.message
      });
    }

    res.status(500).json({
      error: error.message || 'Failed to restore comment'
    });
  }
});

/**
 * Bulk delete all user comments for a PR
 * Also dismisses any AI suggestions that were parents of the deleted comments.
 */
router.delete('/api/pr/:owner/:repo/:number/user-comments', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const db = req.app.get('db');
    const repository = normalizeRepository(owner, repo);

    // Get the review record to find associated comments
    // Comments are associated with review.id to avoid ID collision with local mode
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReviewByPR(prNumber, repository);

    // If no review exists, there are no comments to delete - return success with 0 deletions
    if (!review) {
      return res.json({
        success: true,
        deletedCount: 0,
        dismissedSuggestionIds: [],
        message: 'No comments to delete'
      });
    }

    // Begin transaction to ensure atomicity
    await run(db, 'BEGIN TRANSACTION');

    try {
      // Bulk delete using repository (also dismisses parent AI suggestions)
      const commentRepo = new CommentRepository(db);
      const result = await commentRepo.bulkDeleteComments(review.id);

      // Commit transaction
      await run(db, 'COMMIT');

      res.json({
        success: true,
        deletedCount: result.deletedCount,
        dismissedSuggestionIds: result.dismissedSuggestionIds,
        message: `Deleted ${result.deletedCount} user comment${result.deletedCount !== 1 ? 's' : ''}`
      });

    } catch (transactionError) {
      // Rollback transaction on error
      await run(db, 'ROLLBACK');
      throw transactionError;
    }

  } catch (error) {
    console.error('Error deleting user comments:', error);
    res.status(500).json({
      error: error.message || 'Failed to delete comments'
    });
  }
});

module.exports = router;
