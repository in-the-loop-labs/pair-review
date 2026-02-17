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
const { _sseClients, _sseUnsubscribers } = require('../../src/routes/chat');

/**
 * Creates a mock ChatSessionManager with controllable behavior.
 */
function createMockSessionManager(db) {
  return {
    createSession: vi.fn().mockResolvedValue({ id: 1, status: 'active' }),
    sendMessage: vi.fn().mockResolvedValue({ id: 100 }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    abortSession: vi.fn(),
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
    onToolUse: vi.fn().mockReturnValue(() => {}),
    onStatus: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {})
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
    // Clean up any SSE clients and unsubscribers registered during tests
    _sseClients.clear();
    _sseUnsubscribers.clear();
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
      // systemPrompt should have been auto-built with reviewId
      const callArgs = mockManager.createSession.mock.calls[0][0];
      expect(callArgs.systemPrompt).toBeTruthy();
      expect(callArgs.systemPrompt).toContain('code review');
      expect(callArgs.systemPrompt).toContain('The review ID for this session is: 1');
      // Port should NOT be baked into the system prompt
      expect(callArgs.systemPrompt).not.toMatch(/http:\/\/localhost:\d+/);
    });

    it('should include port context in initialContext even when no AI suggestions exist', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({ provider: 'pi', reviewId: 1 });

      expect(res.status).toBe(200);
      const callArgs = mockManager.createSession.mock.calls[0][0];
      // Port is injected once at session start via initialContext
      expect(callArgs.initialContext).toMatch(/\[Server port: \d+\]/);
      expect(callArgs.initialContext).toMatch(/http:\/\/localhost:\d+/);
      // No suggestion metadata in the response since there are no suggestions
      expect(res.body.data.context).toBeUndefined();
    });

    it('should pass initialContext with port and suggestion content when AI suggestions exist', async () => {
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
      // Port context is prepended before suggestion context
      expect(callArgs.initialContext).toMatch(/\[Server port: \d+\]/);
      expect(callArgs.initialContext).toContain('Null check missing');
      expect(callArgs.initialContext).toContain('Use const');

      // Response should include context metadata with suggestion count
      expect(res.body.data.context).toBeDefined();
      expect(res.body.data.context.suggestionCount).toBe(2);
    });

    it('should not include context metadata when no AI suggestions exist (port is in initialContext but not in response)', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({ provider: 'pi', reviewId: 1 });

      expect(res.status).toBe(200);
      // Port is in initialContext, but response.context is only set when suggestions exist
      expect(res.body.data.context).toBeUndefined();
    });

    it('should register SSE broadcast listeners on session creation', async () => {
      const res = await request(app)
        .post('/api/chat/session')
        .send({
          provider: 'pi',
          reviewId: 1,
          systemPrompt: 'Be helpful'
        });

      expect(res.status).toBe(200);
      // All five event types should have broadcast listeners registered
      expect(mockManager.onDelta).toHaveBeenCalledWith(1, expect.any(Function));
      expect(mockManager.onToolUse).toHaveBeenCalledWith(1, expect.any(Function));
      expect(mockManager.onComplete).toHaveBeenCalledWith(1, expect.any(Function));
      expect(mockManager.onStatus).toHaveBeenCalledWith(1, expect.any(Function));
      expect(mockManager.onError).toHaveBeenCalledWith(1, expect.any(Function));
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
    it('should send a message without per-turn port context (port is injected at session start)', async () => {
      // Insert a session into the DB so getSession finds it
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (1, 1, 'pi', 'active')"
      ).run();

      const res = await request(app)
        .post('/api/chat/session/1/message')
        .send({ content: 'What does this code do?' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('messageId', 100);
      // Port context is NOT injected per-turn (it's sent once at session start)
      const callArgs = mockManager.sendMessage.mock.calls[0];
      expect(callArgs[0]).toBe(1);
      expect(callArgs[1]).toBe('What does this code do?');
      expect(callArgs[2].context).toBeUndefined();
      expect(callArgs[2].contextData).toBeUndefined();
    });

    it('should pass explicit context through unchanged (no port injection)', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (1, 1, 'pi', 'active')"
      ).run();

      const res = await request(app)
        .post('/api/chat/session/1/message')
        .send({
          content: 'Explain this bug',
          context: 'Suggestion: Null pointer on line 42'
        });

      expect(res.status).toBe(200);
      const callArgs = mockManager.sendMessage.mock.calls[0];
      expect(callArgs[1]).toBe('Explain this bug');
      // Context is passed through unchanged — no port injection per-turn
      expect(callArgs[2].context).toBe('Suggestion: Null pointer on line 42');
    });

    it('should pass contextData to sendMessage when provided', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (1, 1, 'pi', 'active')"
      ).run();

      const ctxData = { type: 'bug', title: 'Null pointer', file: 'app.js', line_start: 42 };
      const res = await request(app)
        .post('/api/chat/session/1/message')
        .send({
          content: 'Explain this bug',
          context: 'Suggestion: Null pointer on line 42',
          contextData: ctxData
        });

      expect(res.status).toBe(200);
      const callArgs = mockManager.sendMessage.mock.calls[0];
      expect(callArgs[1]).toBe('Explain this bug');
      // Context passed through unchanged — no port injection per-turn
      expect(callArgs[2].context).toBe('Suggestion: Null pointer on line 42');
      expect(callArgs[2].contextData).toEqual(ctxData);
    });

    it('should pass contextData without injecting port context', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (1, 1, 'pi', 'active')"
      ).run();

      const res = await request(app)
        .post('/api/chat/session/1/message')
        .send({
          content: 'test',
          contextData: { type: 'bug', title: 'test' }
        });

      expect(res.status).toBe(200);
      const callArgs = mockManager.sendMessage.mock.calls[0];
      expect(callArgs[1]).toBe('test');
      // No port context injected per-turn (port is sent at session start)
      expect(callArgs[2].context).toBeUndefined();
      expect(callArgs[2].contextData).toEqual({ type: 'bug', title: 'test' });
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

  describe('POST /api/chat/session/:id/abort', () => {
    it('should abort an active session', async () => {
      mockManager.isSessionActive.mockReturnValue(true);

      const res = await request(app)
        .post('/api/chat/session/1/abort');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ success: true });
      expect(mockManager.abortSession).toHaveBeenCalledWith(1);
    });

    it('should return 404 for inactive session', async () => {
      mockManager.isSessionActive.mockReturnValue(false);

      const res = await request(app)
        .post('/api/chat/session/999/abort');

      expect(res.status).toBe(404);
    });

    it('should return 500 on abort error', async () => {
      mockManager.isSessionActive.mockReturnValue(true);
      mockManager.abortSession.mockImplementation(() => {
        throw new Error('abort failed');
      });

      const res = await request(app)
        .post('/api/chat/session/1/abort');

      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/chat/stream (multiplexed SSE)', () => {
    it('should return SSE headers and connected event', async () => {
      // SSE connections stay open, so we use a raw HTTP approach with a promise
      const http = require('http');
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const result = await new Promise((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/api/chat/stream`, (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString();
              // We have data — destroy the connection
              req.destroy();
              resolve({ headers: res.headers, data });
            });
            res.on('error', () => resolve({ headers: res.headers, data }));
          });
          req.on('error', reject);
          setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 5000);
        });

        expect(result.headers['content-type']).toBe('text/event-stream');
        expect(result.headers['cache-control']).toBe('no-cache');
        expect(result.data).toContain('data: {"type":"connected"}');
      } finally {
        server.close();
      }
    });

    it('should add and remove clients from sseClients set', async () => {
      const http = require('http');
      const server = app.listen(0);
      const port = server.address().port;

      try {
        expect(_sseClients.size).toBe(0);

        const req = http.get(`http://127.0.0.1:${port}/api/chat/stream`, () => {});

        // Wait briefly for the connection to be registered
        await new Promise(r => setTimeout(r, 100));
        expect(_sseClients.size).toBe(1);

        // Disconnect the client
        req.destroy();
        await new Promise(r => setTimeout(r, 100));
        expect(_sseClients.size).toBe(0);
      } finally {
        server.close();
      }
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
