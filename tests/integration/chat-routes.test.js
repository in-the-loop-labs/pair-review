// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema.js';

// Mock logger
vi.mock('../../src/utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  section: vi.fn()
}));

const chatRouter = require('../../src/routes/chat');

/**
 * Creates a mock ChatSessionManager with controllable behavior.
 */
function createMockSessionManager(db) {
  return {
    createSession: vi.fn().mockResolvedValue({ id: 1, status: 'active' }),
    sendMessage: vi.fn().mockResolvedValue({ id: 100 }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockImplementation((id) => {
      return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) || null;
    }),
    isSessionActive: vi.fn().mockImplementation((id) => {
      // Mirror getSession behavior for test purposes — session is "active" if it exists in DB
      const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
      return !!row;
    }),
    getSessionsForReview: vi.fn().mockReturnValue([]),
    getMessages: vi.fn().mockReturnValue([]),
    onDelta: vi.fn().mockReturnValue(() => {}),
    onComplete: vi.fn().mockReturnValue(() => {}),
    onToolUse: vi.fn().mockReturnValue(() => {})
  };
}

describe('Chat Routes', () => {
  let app;
  let db;
  let mockManager;

  beforeEach(() => {
    db = createTestDatabase();

    // Insert a review to satisfy foreign key constraints
    db.prepare(
      "INSERT INTO reviews (id, repository, status, review_type) VALUES (1, 'owner/repo', 'draft', 'pr')"
    ).run();

    mockManager = createMockSessionManager(db);

    app = express();
    app.use(express.json());

    // Attach mocks to app for route access
    app.chatSessionManager = mockManager;
    app.set('db', db);

    app.use(chatRouter);
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  describe('POST /api/chat/session', () => {
    it('should create a session', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({
          provider: 'pi',
          model: 'claude-sonnet-4',
          reviewId: 1,
          systemPrompt: 'Be helpful'
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('id', 1);
      expect(res.body.data).toHaveProperty('status', 'active');
      expect(mockManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'pi',
          model: 'claude-sonnet-4',
          reviewId: 1,
          systemPrompt: 'Be helpful'
        })
      );
    });

    it('should return 400 when provider is missing', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({ reviewId: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('should return 400 when reviewId is missing', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({ provider: 'pi' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('should return 400 when reviewId is not a number', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({ provider: 'pi', reviewId: 'abc' });

      expect(res.status).toBe(400);
    });

    it('should build system prompt from review when not provided', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({ provider: 'pi', reviewId: 1 });

      expect(res.status).toBe(200);
      // systemPrompt should have been auto-built
      const callArgs = mockManager.createSession.mock.calls[0][0];
      expect(callArgs.systemPrompt).toBeTruthy();
      expect(callArgs.systemPrompt).toContain('code review');
    });

    it('should pass initialContext as null when no AI suggestions exist', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({ provider: 'pi', reviewId: 1 });

      expect(res.status).toBe(200);
      const callArgs = mockManager.createSession.mock.calls[0][0];
      expect(callArgs.initialContext).toBeNull();
    });

    it('should pass initialContext with suggestion content when AI suggestions exist', async () => {
      // Insert AI suggestions for the review
      const runId = 'test-run-123';
      db.prepare(`
        INSERT INTO comments (id, review_id, source, ai_run_id, ai_level, ai_confidence, file, line_start, line_end, type, title, body, status, is_file_level, is_raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(10, 1, 'ai', runId, null, 0.85, 'src/app.js', 10, 15, 'bug', 'Null check missing', 'Variable may be null', 'active', 0, 0);

      db.prepare(`
        INSERT INTO comments (id, review_id, source, ai_run_id, ai_level, ai_confidence, file, line_start, line_end, type, title, body, status, is_file_level, is_raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(11, 1, 'ai', runId, null, 0.7, 'src/utils.js', 5, 5, 'improvement', 'Use const', 'Never reassigned', 'active', 0, 0);

      const res = await request(app)
        .post('/api/chat/session')
        .send({ provider: 'pi', reviewId: 1 });

      expect(res.status).toBe(200);
      const callArgs = mockManager.createSession.mock.calls[0][0];
      expect(callArgs.initialContext).toBeTypeOf('string');
      expect(callArgs.initialContext).toContain('Null check missing');
      expect(callArgs.initialContext).toContain('Use const');
    });

    it('should return 404 when review does not exist and no system prompt given', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({ provider: 'pi', reviewId: 999 });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Review not found');
    });
  });

  describe('POST /api/chat/session/:id/message', () => {
    it('should send a message', async () => {
      // Insert a session into the DB so getSession finds it
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (1, 1, 'pi', 'active')"
      ).run();

      const res = await request(app)
        .post('/api/chat/session/1/message')
        .send({ content: 'What does this code do?' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('messageId', 100);
      expect(mockManager.sendMessage).toHaveBeenCalledWith(1, 'What does this code do?');
    });

    it('should return 404 for unknown session', async () => {
      const res = await request(app)
        .post('/api/chat/session/999/message')
        .send({ content: 'hello' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('should return 400 when content is missing', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (2, 1, 'pi', 'active')"
      ).run();

      const res = await request(app)
        .post('/api/chat/session/2/message')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('content');
    });
  });

  describe('GET /api/chat/session/:id/messages', () => {
    it('should return message history', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (1, 1, 'pi', 'active')"
      ).run();

      const mockMessages = [
        { id: 1, role: 'user', content: 'hello' },
        { id: 2, role: 'assistant', content: 'hi there' }
      ];
      mockManager.getMessages.mockReturnValue(mockMessages);

      const res = await request(app)
        .get('/api/chat/session/1/messages');

      expect(res.status).toBe(200);
      expect(res.body.data.messages).toEqual(mockMessages);
    });

    it('should return 404 for unknown session', async () => {
      const res = await request(app)
        .get('/api/chat/session/999/messages');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('DELETE /api/chat/session/:id', () => {
    it('should close a session', async () => {
      const res = await request(app)
        .delete('/api/chat/session/1');

      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);
      expect(mockManager.closeSession).toHaveBeenCalledWith(1);
    });
  });

  describe('GET /api/review/:reviewId/chat/sessions', () => {
    it('should list sessions for a review', async () => {
      const mockSessions = [
        { id: 1, review_id: 1, provider: 'pi', status: 'active' },
        { id: 2, review_id: 1, provider: 'pi', status: 'closed' }
      ];
      mockManager.getSessionsForReview.mockReturnValue(mockSessions);

      const res = await request(app)
        .get('/api/review/1/chat/sessions');

      expect(res.status).toBe(200);
      expect(res.body.data.sessions).toEqual(mockSessions);
      expect(mockManager.getSessionsForReview).toHaveBeenCalledWith(1);
    });

    it('should return empty array when no sessions exist', async () => {
      mockManager.getSessionsForReview.mockReturnValue([]);

      const res = await request(app)
        .get('/api/review/42/chat/sessions');

      expect(res.status).toBe(200);
      expect(res.body.data.sessions).toEqual([]);
    });
  });
});
