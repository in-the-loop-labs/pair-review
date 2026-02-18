// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const database = require('../../src/database.js');
const {
  query,
  queryOne,
  run,
  ChatRepository,
} = database;

describe('ChatRepository', () => {
  let db;
  let chatRepo;

  // Helper to seed a review + comment for FK constraints
  async function seedComment(reviewId = 1, source = 'ai', file = 'test.js', lineStart = 10) {
    await run(db, `
      INSERT OR IGNORE INTO reviews (id, repository, status)
      VALUES (?, 'test/repo', 'draft')
    `, [reviewId]);

    const result = await run(db, `
      INSERT INTO comments (review_id, source, file, line_start, body, status)
      VALUES (?, ?, ?, ?, 'Test comment', 'active')
    `, [reviewId, source, file, lineStart]);

    return result.lastID;
  }

  // Helper to seed an analysis run
  async function seedAnalysisRun(reviewId = 1, runId = 'run-1') {
    await run(db, `
      INSERT OR IGNORE INTO reviews (id, repository, status)
      VALUES (?, 'test/repo', 'draft')
    `, [reviewId]);

    await run(db, `
      INSERT INTO analysis_runs (id, review_id, provider, model, status)
      VALUES (?, ?, 'claude', 'opus', 'completed')
    `, [runId, reviewId]);

    return runId;
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    chatRepo = new ChatRepository(db);
  });

  describe('createSession', () => {
    it('should create a chat session with all fields', async () => {
      const commentId = await seedComment();
      const runId = await seedAnalysisRun();

      const session = await chatRepo.createSession('session-1', commentId, runId, 'claude', 'opus');

      expect(session.id).toBe('session-1');
      expect(session.comment_id).toBe(commentId);
      expect(session.analysis_run_id).toBe(runId);
      expect(session.provider).toBe('claude');
      expect(session.model).toBe('opus');
      expect(session.status).toBe('active');
      expect(session.created_at).toBeDefined();
      expect(session.updated_at).toBeDefined();
    });

    it('should create a session with null analysis_run_id', async () => {
      const commentId = await seedComment();

      const session = await chatRepo.createSession('session-1', commentId, null, 'gemini', 'pro');

      expect(session.analysis_run_id).toBeFalsy();
      expect(session.provider).toBe('gemini');
      expect(session.model).toBe('pro');
    });

    it('should persist the session in the database', async () => {
      const commentId = await seedComment();

      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const row = await queryOne(db, 'SELECT * FROM chat_sessions WHERE id = ?', ['session-1']);
      expect(row).toBeDefined();
      expect(row.comment_id).toBe(commentId);
      expect(row.provider).toBe('claude');
    });

    it('should reject duplicate session IDs', async () => {
      const commentId = await seedComment();

      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      await expect(
        chatRepo.createSession('session-1', commentId, null, 'claude', 'opus')
      ).rejects.toThrow();
    });
  });

  describe('getSession', () => {
    it('should return a session by ID', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const session = await chatRepo.getSession('session-1');

      expect(session).toBeDefined();
      expect(session.id).toBe('session-1');
      expect(session.comment_id).toBe(commentId);
    });

    it('should return null for non-existent session', async () => {
      const session = await chatRepo.getSession('non-existent');
      expect(session).toBeFalsy();
    });
  });

  describe('getSessionsByComment', () => {
    it('should return all sessions for a comment', async () => {
      const commentId = await seedComment();

      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.createSession('session-2', commentId, null, 'claude', 'sonnet');

      const sessions = await chatRepo.getSessionsByComment(commentId);

      expect(sessions).toHaveLength(2);
      const ids = sessions.map(s => s.id);
      expect(ids).toContain('session-1');
      expect(ids).toContain('session-2');
    });

    it('should return empty array when comment has no sessions', async () => {
      const sessions = await chatRepo.getSessionsByComment(999);
      expect(sessions).toEqual([]);
    });

    it('should not return sessions for other comments', async () => {
      const commentId1 = await seedComment(1, 'ai', 'a.js', 1);
      const commentId2 = await seedComment(1, 'ai', 'b.js', 2);

      await chatRepo.createSession('session-1', commentId1, null, 'claude', 'opus');
      await chatRepo.createSession('session-2', commentId2, null, 'claude', 'opus');

      const sessions = await chatRepo.getSessionsByComment(commentId1);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('session-1');
    });
  });

  describe('getActiveSessionByComment', () => {
    it('should return the most recent active session', async () => {
      const commentId = await seedComment();

      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.createSession('session-2', commentId, null, 'claude', 'sonnet');

      // Mark first session as completed
      await chatRepo.updateSessionStatus('session-1', 'completed');

      const session = await chatRepo.getActiveSessionByComment(commentId);

      expect(session).toBeDefined();
      expect(session.id).toBe('session-2');
      expect(session.status).toBe('active');
    });

    it('should return null when no active sessions exist', async () => {
      const commentId = await seedComment();

      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.updateSessionStatus('session-1', 'completed');

      const session = await chatRepo.getActiveSessionByComment(commentId);
      expect(session).toBeFalsy();
    });

    it('should return null for comment with no sessions', async () => {
      const session = await chatRepo.getActiveSessionByComment(999);
      expect(session).toBeFalsy();
    });
  });

  describe('updateSessionStatus', () => {
    it('should update status to completed', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const updated = await chatRepo.updateSessionStatus('session-1', 'completed');

      expect(updated).toBe(true);
      const session = await chatRepo.getSession('session-1');
      expect(session.status).toBe('completed');
    });

    it('should update status to error', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      await chatRepo.updateSessionStatus('session-1', 'error');

      const session = await chatRepo.getSession('session-1');
      expect(session.status).toBe('error');
    });

    it('should update the updated_at timestamp', async () => {
      const commentId = await seedComment();
      const created = await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 10));

      await chatRepo.updateSessionStatus('session-1', 'completed');

      const session = await chatRepo.getSession('session-1');
      expect(session.updated_at).not.toBe(created.updated_at);
    });

    it('should return false for non-existent session', async () => {
      const updated = await chatRepo.updateSessionStatus('non-existent', 'completed');
      expect(updated).toBe(false);
    });
  });

  describe('addMessage', () => {
    it('should add a user message', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const message = await chatRepo.addMessage('session-1', 'user', 'Hello, can you explain this?');

      expect(message.id).toBeDefined();
      expect(message.chat_session_id).toBe('session-1');
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello, can you explain this?');
      expect(message.token_count).toBeFalsy();
      expect(message.created_at).toBeDefined();
    });

    it('should add an assistant message with token count', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const message = await chatRepo.addMessage('session-1', 'assistant', 'Here is my answer.', 150);

      expect(message.role).toBe('assistant');
      expect(message.token_count).toBe(150);
    });

    it('should update the session updated_at when adding a message', async () => {
      const commentId = await seedComment();
      const created = await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      await new Promise(r => setTimeout(r, 10));
      await chatRepo.addMessage('session-1', 'user', 'Test message');

      const session = await chatRepo.getSession('session-1');
      expect(session.updated_at).not.toBe(created.updated_at);
    });

    it('should persist the message in the database', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      await chatRepo.addMessage('session-1', 'user', 'Persisted message');

      const rows = await query(db, 'SELECT * FROM chat_messages WHERE chat_session_id = ?', ['session-1']);
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe('Persisted message');
    });

    it('should auto-increment message IDs', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const msg1 = await chatRepo.addMessage('session-1', 'user', 'First');
      const msg2 = await chatRepo.addMessage('session-1', 'assistant', 'Second');

      expect(msg2.id).toBeGreaterThan(msg1.id);
    });
  });

  describe('getMessages', () => {
    it('should return messages in chronological order (ASC)', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      await chatRepo.addMessage('session-1', 'user', 'Question');
      await chatRepo.addMessage('session-1', 'assistant', 'Answer');
      await chatRepo.addMessage('session-1', 'user', 'Follow-up');

      const messages = await chatRepo.getMessages('session-1');

      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Question');
      expect(messages[1].role).toBe('assistant');
      expect(messages[2].role).toBe('user');
      expect(messages[2].content).toBe('Follow-up');
    });

    it('should return empty array for session with no messages', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const messages = await chatRepo.getMessages('session-1');
      expect(messages).toEqual([]);
    });

    it('should not return messages from other sessions', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.createSession('session-2', commentId, null, 'claude', 'opus');

      await chatRepo.addMessage('session-1', 'user', 'Session 1 message');
      await chatRepo.addMessage('session-2', 'user', 'Session 2 message');

      const messages = await chatRepo.getMessages('session-1');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Session 1 message');
    });
  });

  describe('getSessionWithMessages', () => {
    it('should return session with its messages', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.addMessage('session-1', 'user', 'Hello');
      await chatRepo.addMessage('session-1', 'assistant', 'Hi there');

      const result = await chatRepo.getSessionWithMessages('session-1');

      expect(result).toBeDefined();
      expect(result.id).toBe('session-1');
      expect(result.provider).toBe('claude');
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].content).toBe('Hi there');
    });

    it('should return session with empty messages array if no messages', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const result = await chatRepo.getSessionWithMessages('session-1');

      expect(result).toBeDefined();
      expect(result.messages).toEqual([]);
    });

    it('should return null for non-existent session', async () => {
      const result = await chatRepo.getSessionWithMessages('non-existent');
      expect(result).toBeFalsy();
    });
  });

  describe('deleteSession', () => {
    it('should delete a session and return true', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const deleted = await chatRepo.deleteSession('session-1');

      expect(deleted).toBe(true);
      const session = await chatRepo.getSession('session-1');
      expect(session).toBeFalsy();
    });

    it('should cascade delete messages when deleting a session', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.addMessage('session-1', 'user', 'Message 1');
      await chatRepo.addMessage('session-1', 'assistant', 'Message 2');

      await chatRepo.deleteSession('session-1');

      const messages = await query(db, 'SELECT * FROM chat_messages WHERE chat_session_id = ?', ['session-1']);
      expect(messages).toHaveLength(0);
    });

    it('should return false for non-existent session', async () => {
      const deleted = await chatRepo.deleteSession('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('getCommentsWithChatHistory', () => {
    it('should return comment IDs that have chat messages', async () => {
      const commentId = await seedComment(1, 'ai', 'test.js', 10);
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.addMessage('session-1', 'user', 'Hello');

      const result = await chatRepo.getCommentsWithChatHistory(1);

      expect(result).toHaveLength(1);
      expect(result[0].comment_id).toBe(commentId);
    });

    it('should not return comments with sessions but no messages', async () => {
      const commentId = await seedComment(1, 'ai', 'test.js', 10);
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      // No messages added

      const result = await chatRepo.getCommentsWithChatHistory(1);
      expect(result).toHaveLength(0);
    });

    it('should return adopted child comment IDs when parent has chat history', async () => {
      // Create parent AI suggestion
      const parentId = await seedComment(1, 'ai', 'test.js', 10);

      // Create adopted child comment with parent_id
      const childResult = await run(db, `
        INSERT INTO comments (review_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 10, 'Adopted', 'active', ?)
      `, [1, parentId]);
      const childId = childResult.lastID;

      // Add chat session to parent
      await chatRepo.createSession('session-1', parentId, null, 'claude', 'opus');
      await chatRepo.addMessage('session-1', 'user', 'Chat on parent');

      const result = await chatRepo.getCommentsWithChatHistory(1);

      const commentIds = result.map(r => r.comment_id);
      // Both parent and adopted child should appear
      expect(commentIds).toContain(parentId);
      expect(commentIds).toContain(childId);
    });

    it('should return distinct comment IDs (no duplicates)', async () => {
      const commentId = await seedComment(1, 'ai', 'test.js', 10);

      // Create two sessions with messages
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.addMessage('session-1', 'user', 'Hello');
      await chatRepo.createSession('session-2', commentId, null, 'claude', 'opus');
      await chatRepo.addMessage('session-2', 'user', 'World');

      const result = await chatRepo.getCommentsWithChatHistory(1);

      expect(result).toHaveLength(1);
      expect(result[0].comment_id).toBe(commentId);
    });

    it('should return empty array for review with no chat history', async () => {
      const result = await chatRepo.getCommentsWithChatHistory(999);
      expect(result).toEqual([]);
    });

    it('should not return comments from other reviews', async () => {
      const commentId1 = await seedComment(1, 'ai', 'test.js', 10);
      const commentId2 = await seedComment(2, 'ai', 'test.js', 20);

      await chatRepo.createSession('session-1', commentId1, null, 'claude', 'opus');
      await chatRepo.addMessage('session-1', 'user', 'Review 1');

      await chatRepo.createSession('session-2', commentId2, null, 'claude', 'opus');
      await chatRepo.addMessage('session-2', 'user', 'Review 2');

      const result = await chatRepo.getCommentsWithChatHistory(1);

      expect(result).toHaveLength(1);
      expect(result[0].comment_id).toBe(commentId1);
    });
  });
});
