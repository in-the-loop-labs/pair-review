/**
 * Comment CRUD Routes
 *
 * Handles all comment-related endpoints:
 * - AI suggestion status updates and editing
 * - User comment CRUD operations
 * - Bulk comment operations
 */

const express = require('express');
const { query, queryOne, run, CommentRepository } = require('../database');

const router = express.Router();

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

    // Validate PR exists
    const pr = await queryOne(db, `
      SELECT id FROM pr_metadata WHERE id = ?
    `, [suggestion.pr_id]);

    if (!pr) {
      return res.status(404).json({
        error: 'Associated pull request not found'
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
    const { pr_id, file, body, commit_sha, parent_id, type, title } = req.body;

    if (!pr_id || !file || !body) {
      return res.status(400).json({
        error: 'Missing required fields: pr_id, file, body'
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

    // Verify PR exists
    const pr = await queryOne(db, `
      SELECT id FROM pr_metadata WHERE id = ?
    `, [pr_id]);

    if (!pr) {
      return res.status(404).json({
        error: 'Pull request not found'
      });
    }

    // Create file-level user comment using repository
    const commentRepo = new CommentRepository(db);
    const commentId = await commentRepo.createFileComment({
      pr_id,
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
    const { pr_id, file, line_start, line_end, diff_position, side, commit_sha, body, parent_id, type, title } = req.body;

    if (!pr_id || !file || !line_start || !body) {
      return res.status(400).json({
        error: 'Missing required fields: pr_id, file, line_start, body'
      });
    }

    const db = req.app.get('db');

    // Verify PR exists
    const pr = await queryOne(db, `
      SELECT id FROM pr_metadata WHERE id = ?
    `, [pr_id]);

    if (!pr) {
      return res.status(404).json({
        error: 'Pull request not found'
      });
    }

    // Create user comment using repository
    const commentRepo = new CommentRepository(db);
    const commentId = await commentRepo.createLineComment({
      pr_id,
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
 */
router.get('/api/pr/:owner/:repo/:number/user-comments', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Get PR ID first
    const prMetadata = await queryOne(req.app.get('db'), `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.json({
        success: true,
        comments: []
      });
    }

    const comments = await query(req.app.get('db'), `
      SELECT
        id,
        source,
        author,
        file,
        line_start,
        line_end,
        diff_position,
        type,
        title,
        body,
        status,
        parent_id,
        is_file_level,
        created_at,
        updated_at
      FROM comments
      WHERE pr_id = ? AND source = 'user' AND status IN ('active', 'submitted', 'draft')
      ORDER BY file, line_start, created_at
    `, [prMetadata.id]);

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
 * Get user comments for a PR (legacy endpoint by ID)
 */
router.get('/api/pr/:id/user-comments', async (req, res) => {
  try {
    const prId = parseInt(req.params.id);

    if (isNaN(prId) || prId <= 0) {
      return res.status(400).json({
        error: 'Invalid PR ID'
      });
    }

    const comments = await query(req.app.get('db'), `
      SELECT
        id,
        source,
        author,
        file,
        line_start,
        line_end,
        diff_position,
        type,
        title,
        body,
        status,
        parent_id,
        is_file_level,
        created_at,
        updated_at
      FROM comments
      WHERE pr_id = ? AND source = 'user' AND status IN ('active', 'submitted', 'draft')
      ORDER BY file, line_start, created_at
    `, [prId]);

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
 */
router.delete('/api/user-comment/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Soft delete using repository
    await commentRepo.deleteComment(id);

    res.json({
      success: true,
      message: 'Comment deleted successfully'
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
 * Bulk delete all user comments for a PR
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
    const repository = `${owner}/${repo}`;

    // Get the PR ID to verify it exists
    const prMetadata = await queryOne(db, `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: 'Pull request not found'
      });
    }

    // Begin transaction to ensure atomicity
    await run(db, 'BEGIN TRANSACTION');

    try {
      // Bulk delete using repository
      const commentRepo = new CommentRepository(db);
      const deletedCount = await commentRepo.bulkDeleteComments(prMetadata.id);

      // Commit transaction
      await run(db, 'COMMIT');

      res.json({
        success: true,
        deletedCount,
        message: `Deleted ${deletedCount} user comment${deletedCount !== 1 ? 's' : ''}`
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
