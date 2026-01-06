/**
 * Comment CRUD Routes
 *
 * Handles all comment-related endpoints:
 * - AI suggestion status updates and editing
 * - User comment CRUD operations
 * - Bulk comment operations
 */

const express = require('express');
const { query, queryOne, run } = require('../database');

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

    // Get the suggestion and validate it
    const suggestion = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'ai'
    `, [id]);

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    // Validate suggestion status is active
    if (suggestion.status !== 'active') {
      return res.status(400).json({
        error: 'This suggestion has already been processed'
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

    // Create a user comment with the edited text
    // Preserve diff_position and side from the original suggestion if available
    const result = await run(db, `
      INSERT INTO comments (
        pr_id, source, author, file, line_start, line_end,
        diff_position, side, commit_sha,
        type, title, body, status, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      suggestion.pr_id,
      'user',
      'Current User', // TODO: Get actual user from session/config
      suggestion.file,
      suggestion.line_start,
      suggestion.line_end,
      suggestion.diff_position || null,  // Preserve for GitHub API
      suggestion.side || 'RIGHT',        // Default to RIGHT for added/context lines
      suggestion.commit_sha || null,     // Preserve commit SHA
      'comment',
      suggestion.title,
      editedText.trim(),
      'active',
      id  // Link to parent AI suggestion
    ]);

    const userCommentId = result.lastID;

    // Update suggestion status to adopted and link to user comment
    await run(db, `
      UPDATE comments
      SET status = 'adopted', adopted_as_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [userCommentId, id]);

    res.json({
      success: true,
      userCommentId,
      message: 'Suggestion edited and adopted as user comment'
    });

  } catch (error) {
    console.error('Error editing suggestion:', error);
    res.status(500).json({
      error: 'Failed to edit suggestion'
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

    // Get the suggestion
    const suggestion = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'ai'
    `, [id]);

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    // Update suggestion status
    // When restoring to active, we need to clear adopted_as_id
    // Note: User comment creation for adopted suggestions is handled separately
    // by the frontend via /api/user-comment endpoint to avoid duplicate comments
    if (status === 'active') {
      await run(db, `
        UPDATE comments
        SET status = ?, adopted_as_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [status, id]);
    } else {
      await run(db, `
        UPDATE comments
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [status, id]);
    }

    res.json({
      success: true,
      status
    });

  } catch (error) {
    console.error('Error updating suggestion status:', error);
    res.status(500).json({
      error: 'Failed to update suggestion status'
    });
  }
});

/**
 * Create file-level user comment
 * File-level comments are about an entire file, not tied to specific lines
 */
router.post('/api/file-comment', async (req, res) => {
  try {
    const { pr_id, file, body, commit_sha } = req.body;

    if (!pr_id || !file || !body) {
      return res.status(400).json({
        error: 'Missing required fields: pr_id, file, body'
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

    // Create file-level user comment
    // line_start, line_end, diff_position, and side are NULL for file-level comments
    const result = await run(db, `
      INSERT INTO comments (
        pr_id, source, author, file, line_start, line_end, diff_position, side, commit_sha,
        type, title, body, status, is_file_level
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, 1)
    `, [
      pr_id,
      'user',
      'Current User', // TODO: Get actual user from session/config
      file,
      commit_sha || null,
      'comment',
      body.trim(),
      'active'
    ]);

    res.json({
      success: true,
      commentId: result.lastID,
      message: 'File-level comment saved successfully'
    });

  } catch (error) {
    console.error('Error creating file-level comment:', error);
    res.status(500).json({
      error: 'Failed to create file-level comment'
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

    // Create user comment with optional parent_id and metadata
    // Validate side if provided (must be LEFT or RIGHT)
    const validSide = side === 'LEFT' ? 'LEFT' : 'RIGHT';

    const result = await run(db, `
      INSERT INTO comments (
        pr_id, source, author, file, line_start, line_end, diff_position, side, commit_sha,
        type, title, body, status, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      pr_id,
      'user',
      'Current User', // TODO: Get actual user from session/config
      file,
      line_start,
      line_end || line_start,
      diff_position || null,  // Store diff position for legacy fallback
      validSide,              // LEFT for deleted lines, RIGHT for added/context
      commit_sha || null,     // Commit SHA for new GitHub API (line/side/commit_id)
      type || 'comment',  // Use provided type or default to 'comment'
      title || null,       // Optional title from AI suggestion
      body.trim(),
      'active',
      parent_id || null    // Link to parent AI suggestion if adopted
    ]);

    res.json({
      success: true,
      commentId: result.lastID,
      message: 'Comment saved successfully'
    });

  } catch (error) {
    console.error('Error creating user comment:', error);
    res.status(500).json({
      error: 'Failed to create comment'
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

    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'user'
    `, [id]);

    if (!comment) {
      return res.status(404).json({
        error: 'User comment not found'
      });
    }

    res.json(comment);

  } catch (error) {
    console.error('Error fetching user comment:', error);
    res.status(500).json({
      error: 'Failed to fetch comment'
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

    // Get the comment and verify it exists and is a user comment
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'user'
    `, [id]);

    if (!comment) {
      return res.status(404).json({
        error: 'User comment not found'
      });
    }

    // Update comment
    await run(db, `
      UPDATE comments
      SET body = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [body.trim(), id]);

    res.json({
      success: true,
      message: 'Comment updated successfully'
    });

  } catch (error) {
    console.error('Error updating user comment:', error);
    res.status(500).json({
      error: 'Failed to update comment'
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

    // Get the comment and verify it exists and is a user comment
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'user'
    `, [id]);

    if (!comment) {
      return res.status(404).json({
        error: 'User comment not found'
      });
    }

    // Soft delete by setting status to inactive
    await run(db, `
      UPDATE comments
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);

    res.json({
      success: true,
      message: 'Comment deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting user comment:', error);
    res.status(500).json({
      error: 'Failed to delete comment'
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
      // Soft delete all user comments for this PR (active, submitted, or draft)
      const result = await run(db, `
        UPDATE comments
        SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE pr_id = ? AND source = 'user' AND status IN ('active', 'submitted', 'draft')
      `, [prMetadata.id]);

      // Commit transaction
      await run(db, 'COMMIT');

      // Use actual number of affected rows from the UPDATE
      const deletedCount = result.changes;

      res.json({
        success: true,
        deletedCount: deletedCount,
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
      error: 'Failed to delete comments'
    });
  }
});

module.exports = router;
