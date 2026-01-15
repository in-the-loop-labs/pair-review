// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const database = require('../../src/database.js');
const {
  query,
  queryOne,
  run,
  CommentRepository,
} = database;

/**
 * Create an in-memory SQLite database with the proper schema for testing.
 * Uses better-sqlite3 for synchronous operations.
 */
function createTestDatabase() {
  const db = new Database(':memory:');

  // Disable foreign keys to match legacy sqlite3 behavior
  // (sqlite3 has foreign keys disabled by default, better-sqlite3 has them enabled)
  db.pragma('foreign_keys = OFF');

  // Create comments table with is_file_level column
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      pr_id INTEGER,
      source TEXT,
      author TEXT,
      ai_run_id TEXT,
      ai_level INTEGER,
      ai_confidence REAL,
      file TEXT,
      line_start INTEGER,
      line_end INTEGER,
      diff_position INTEGER,
      side TEXT DEFAULT 'RIGHT' CHECK(side IN ('LEFT', 'RIGHT')),
      commit_sha TEXT,
      type TEXT,
      title TEXT,
      body TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'dismissed', 'adopted', 'submitted', 'draft', 'inactive')),
      adopted_as_id INTEGER,
      parent_id INTEGER,
      is_file_level INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (adopted_as_id) REFERENCES comments(id),
      FOREIGN KEY (parent_id) REFERENCES comments(id)
    )
  `);

  return db;
}

describe('CommentRepository', () => {
  let db;
  let commentRepo;

  beforeEach(async () => {
    db = await createTestDatabase();
    commentRepo = new CommentRepository(db);
  });

  describe('createLineComment', () => {
    it('should create a line-level user comment with all fields', async () => {
      const commentId = await commentRepo.createLineComment({
        pr_id: 1,
        file: 'test.js',
        line_start: 10,
        line_end: 15,
        body: 'Test comment',
        diff_position: 5,
        side: 'RIGHT',
        commit_sha: 'abc123',
        type: 'comment',
        title: 'Test Title',
        parent_id: null,
        author: 'Test User'
      });

      expect(commentId).toBeDefined();
      expect(commentId).toBeGreaterThan(0);

      // Verify the comment was created correctly
      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId]);
      expect(comment.pr_id).toBe(1);
      expect(comment.file).toBe('test.js');
      expect(comment.line_start).toBe(10);
      expect(comment.line_end).toBe(15);
      expect(comment.body).toBe('Test comment');
      expect(comment.source).toBe('user');
      expect(comment.author).toBe('Test User');
      expect(comment.status).toBe('active');
      expect(comment.side).toBe('RIGHT');
      expect(comment.is_file_level).toBe(0);
    });

    it('should default line_end to line_start if not provided', async () => {
      const commentId = await commentRepo.createLineComment({
        pr_id: 1,
        file: 'test.js',
        line_start: 10,
        body: 'Test comment'
      });

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId]);
      expect(comment.line_end).toBe(10);
    });

    it('should default side to RIGHT if not provided', async () => {
      const commentId = await commentRepo.createLineComment({
        pr_id: 1,
        file: 'test.js',
        line_start: 10,
        body: 'Test comment'
      });

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId]);
      expect(comment.side).toBe('RIGHT');
    });

    it('should normalize side to LEFT or RIGHT', async () => {
      const commentId = await commentRepo.createLineComment({
        pr_id: 1,
        file: 'test.js',
        line_start: 10,
        body: 'Test comment',
        side: 'LEFT'
      });

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId]);
      expect(comment.side).toBe('LEFT');
    });

    it('should throw error if required fields are missing', async () => {
      await expect(commentRepo.createLineComment({
        file: 'test.js',
        line_start: 10,
        body: 'Test comment'
      })).rejects.toThrow('Missing required fields');
    });

    it('should trim whitespace from body', async () => {
      const commentId = await commentRepo.createLineComment({
        pr_id: 1,
        file: 'test.js',
        line_start: 10,
        body: '  Test comment  '
      });

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId]);
      expect(comment.body).toBe('Test comment');
    });
  });

  describe('createFileComment', () => {
    it('should create a file-level user comment', async () => {
      const commentId = await commentRepo.createFileComment({
        pr_id: 1,
        file: 'test.js',
        body: 'File-level comment',
        commit_sha: 'abc123',
        type: 'comment',
        title: 'File Title'
      });

      expect(commentId).toBeDefined();
      expect(commentId).toBeGreaterThan(0);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId]);
      expect(comment.pr_id).toBe(1);
      expect(comment.file).toBe('test.js');
      expect(comment.body).toBe('File-level comment');
      expect(comment.is_file_level).toBe(1);
      expect(comment.line_start).toBeNull();
      expect(comment.line_end).toBeNull();
      expect(comment.diff_position).toBeNull();
      expect(comment.side).toBeNull();
      expect(comment.status).toBe('active');
    });

    it('should throw error if required fields are missing', async () => {
      await expect(commentRepo.createFileComment({
        file: 'test.js',
        body: 'Test comment'
      })).rejects.toThrow('Missing required fields');
    });

    it('should trim whitespace from body', async () => {
      const commentId = await commentRepo.createFileComment({
        pr_id: 1,
        file: 'test.js',
        body: '  File comment  '
      });

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId]);
      expect(comment.body).toBe('File comment');
    });
  });

  describe('adoptSuggestion', () => {
    it('should adopt an AI suggestion and create a user comment', async () => {
      // First create an AI suggestion
      const aiSuggestionId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, type, title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 10, 'AI suggestion', 'active', 'suggestion', 'AI Title']);

      // Adopt the suggestion
      const userCommentId = await commentRepo.adoptSuggestion(aiSuggestionId.lastID, 'Edited suggestion text');

      expect(userCommentId).toBeDefined();
      expect(userCommentId).toBeGreaterThan(0);

      // Verify user comment was created with correct metadata
      const userComment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [userCommentId]);
      expect(userComment.source).toBe('user');
      expect(userComment.body).toBe('Edited suggestion text');
      expect(userComment.parent_id).toBe(aiSuggestionId.lastID);
      expect(userComment.file).toBe('test.js');
      expect(userComment.line_start).toBe(10);
      expect(userComment.title).toBe('AI Title');
    });

    it('should adopt a file-level AI suggestion', async () => {
      // Create a file-level AI suggestion
      const aiSuggestionId = await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, is_file_level)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 'File-level AI suggestion', 'active', 1]);

      const userCommentId = await commentRepo.adoptSuggestion(aiSuggestionId.lastID, 'Adopted file comment');

      const userComment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [userCommentId]);
      expect(userComment.is_file_level).toBe(1);
      expect(userComment.body).toBe('Adopted file comment');
    });

    it('should throw error if suggestion not found', async () => {
      await expect(commentRepo.adoptSuggestion(999, 'Test')).rejects.toThrow('AI suggestion not found');
    });

    it('should throw error if suggestion is not active', async () => {
      const aiSuggestionId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 10, 'AI suggestion', 'dismissed']);

      await expect(commentRepo.adoptSuggestion(aiSuggestionId.lastID, 'Test')).rejects.toThrow('already been processed');
    });
  });

  describe('updateSuggestionStatus', () => {
    it('should update suggestion status to dismissed', async () => {
      const aiSuggestionId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 10, 'AI suggestion', 'active']);

      await commentRepo.updateSuggestionStatus(aiSuggestionId.lastID, 'dismissed');

      const suggestion = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [aiSuggestionId.lastID]);
      expect(suggestion.status).toBe('dismissed');
    });

    it('should update suggestion status to adopted with adoptedAsId', async () => {
      const aiSuggestionId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 10, 'AI suggestion', 'active']);

      await commentRepo.updateSuggestionStatus(aiSuggestionId.lastID, 'adopted', 999);

      const suggestion = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [aiSuggestionId.lastID]);
      expect(suggestion.status).toBe('adopted');
      expect(suggestion.adopted_as_id).toBe(999);
    });

    it('should restore to active and clear adopted_as_id', async () => {
      const aiSuggestionId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, adopted_as_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 10, 'AI suggestion', 'adopted', 999]);

      await commentRepo.updateSuggestionStatus(aiSuggestionId.lastID, 'active');

      const suggestion = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [aiSuggestionId.lastID]);
      expect(suggestion.status).toBe('active');
      expect(suggestion.adopted_as_id).toBeNull();
    });

    it('should throw error for invalid status', async () => {
      await expect(commentRepo.updateSuggestionStatus(1, 'invalid')).rejects.toThrow('Invalid status');
    });
  });

  describe('getComment', () => {
    it('should get a comment by id', async () => {
      const commentId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body)
        VALUES (?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Test comment']);

      const comment = await commentRepo.getComment(commentId.lastID);
      expect(comment).toBeDefined();
      expect(comment.body).toBe('Test comment');
    });

    it('should filter by source', async () => {
      const commentId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body)
        VALUES (?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 10, 'AI comment']);

      const userComment = await commentRepo.getComment(commentId.lastID, 'user');
      expect(userComment).toBeFalsy();

      const aiComment = await commentRepo.getComment(commentId.lastID, 'ai');
      expect(aiComment).toBeDefined();
    });
  });

  describe('updateComment', () => {
    it('should update a user comment body', async () => {
      const commentId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body)
        VALUES (?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Original comment']);

      await commentRepo.updateComment(commentId.lastID, 'Updated comment');

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId.lastID]);
      expect(comment.body).toBe('Updated comment');
    });

    it('should throw error if comment not found', async () => {
      await expect(commentRepo.updateComment(999, 'Test')).rejects.toThrow('User comment not found');
    });

    it('should throw error if body is empty', async () => {
      const commentId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body)
        VALUES (?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Original comment']);

      await expect(commentRepo.updateComment(commentId.lastID, '')).rejects.toThrow('cannot be empty');
    });

    it('should trim whitespace from updated body', async () => {
      const commentId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body)
        VALUES (?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Original comment']);

      await commentRepo.updateComment(commentId.lastID, '  Updated comment  ');

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId.lastID]);
      expect(comment.body).toBe('Updated comment');
    });
  });

  describe('deleteComment', () => {
    it('should soft delete a user comment', async () => {
      const commentId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Test comment', 'active']);

      const result = await commentRepo.deleteComment(commentId.lastID);

      expect(result.deleted).toBe(true);
      expect(result.dismissedSuggestionId).toBeNull();

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId.lastID]);
      expect(comment.status).toBe('inactive');
    });

    it('should throw error if comment not found', async () => {
      await expect(commentRepo.deleteComment(999)).rejects.toThrow('User comment not found');
    });

    it('should dismiss parent AI suggestion when deleting adopted comment', async () => {
      // Create an AI suggestion
      const aiSuggestionId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 10, 'AI suggestion', 'adopted']);

      // Create a user comment that adopted the AI suggestion
      const userCommentId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Adopted comment', 'active', aiSuggestionId.lastID]);

      const result = await commentRepo.deleteComment(userCommentId.lastID);

      expect(result.deleted).toBe(true);
      expect(result.dismissedSuggestionId).toBe(aiSuggestionId.lastID);

      // Verify the AI suggestion was dismissed
      const suggestion = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [aiSuggestionId.lastID]);
      expect(suggestion.status).toBe('dismissed');
    });
  });

  describe('bulkDeleteComments', () => {
    it('should delete multiple user comments for a PR', async () => {
      // Create multiple comments
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Comment 1', 'active']);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 20, 'Comment 2', 'active']);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [2, 'user', 'test.js', 30, 'Comment 3', 'active']);

      const result = await commentRepo.bulkDeleteComments(1);

      expect(result.deletedCount).toBe(2);
      expect(result.dismissedSuggestionIds).toEqual([]);

      // Verify comments were soft deleted
      const comments = await query(db, 'SELECT * FROM comments WHERE pr_id = ? AND status = ?', [1, 'inactive']);
      expect(comments.length).toBe(2);

      // PR 2 comment should not be affected
      const pr2Comment = await queryOne(db, 'SELECT * FROM comments WHERE pr_id = ?', [2]);
      expect(pr2Comment.status).toBe('active');
    });

    it('should return 0 if no comments to delete', async () => {
      const result = await commentRepo.bulkDeleteComments(999);
      expect(result.deletedCount).toBe(0);
      expect(result.dismissedSuggestionIds).toEqual([]);
    });

    it('should dismiss parent AI suggestions when deleting adopted comments', async () => {
      // Create an AI suggestion
      const aiSuggestionId = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 10, 'AI suggestion', 'adopted']);

      // Create a user comment that adopted the AI suggestion
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Adopted comment', 'active', aiSuggestionId.lastID]);

      const result = await commentRepo.bulkDeleteComments(1);

      expect(result.deletedCount).toBe(1);
      expect(result.dismissedSuggestionIds).toContain(aiSuggestionId.lastID);

      // Verify the AI suggestion was dismissed
      const suggestion = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [aiSuggestionId.lastID]);
      expect(suggestion.status).toBe('dismissed');
    });
  });

  describe('getUserComments', () => {
    it('should get all active user comments for a PR', async () => {
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 10, 'Comment 1', 'active']);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 20, 'Comment 2', 'active']);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'user', 'test.js', 30, 'Comment 3', 'inactive']);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'test.js', 40, 'AI Comment', 'active']);

      const comments = await commentRepo.getUserComments(1);

      expect(comments.length).toBe(2);
      expect(comments[0].body).toBe('Comment 1');
      expect(comments[1].body).toBe('Comment 2');
    });

    it('should return empty array if no comments', async () => {
      const comments = await commentRepo.getUserComments(999);
      expect(comments).toEqual([]);
    });
  });
});
