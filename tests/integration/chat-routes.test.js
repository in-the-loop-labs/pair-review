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
    resumeSession: vi.fn().mockResolvedValue({ id: 1, status: 'active' }),
    getMRUSession: vi.fn().mockReturnValue(null),
    getSessionsWithMessageCount: vi.fn().mockReturnValue([]),
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
      // Insert analysis run record
      const runId = 'test-run-123';
      db.prepare(`
        INSERT INTO analysis_runs (id, review_id, provider, model, status, summary, total_suggestions, files_analyzed, config_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, 1, 'council', 'claude-sonnet-4', 'completed', 'Found 2 issues in review.', 2, 2, 'advanced');

      // Insert AI suggestions for the review
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
      // Analysis run metadata should be included
      expect(callArgs.initialContext).toContain('Analysis Run Metadata');
      expect(callArgs.initialContext).toContain('test-run-123');
      expect(callArgs.initialContext).toContain('council');
      expect(callArgs.initialContext).toContain('claude-sonnet-4');
      expect(callArgs.initialContext).toContain('Found 2 issues in review.');
      // Suggestions should still be included
      expect(callArgs.initialContext).toContain('Null check missing');
      expect(callArgs.initialContext).toContain('Use const');

      // Response should include context metadata with suggestion count and run metadata
      expect(res.body.data.context).toBeDefined();
      expect(res.body.data.context.suggestionCount).toBe(2);
      expect(res.body.data.context.aiRunId).toBe('test-run-123');
      expect(res.body.data.context.provider).toBe('council');
      expect(res.body.data.context.model).toBe('claude-sonnet-4');
      expect(res.body.data.context.summary).toBe('Found 2 issues in review.');
      expect(res.body.data.context.configType).toBe('advanced');
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
        { id: 1, review_id: 1, provider: 'pi', status: 'active', agent_session_id: null },
        { id: 2, review_id: 1, provider: 'pi', status: 'closed', agent_session_id: null }
      ];
      mockManager.getSessionsWithMessageCount.mockReturnValue(mockSessions);
      mockManager.isSessionActive.mockReturnValue(false);

      const res = await request(app)
        .get('/api/review/1/chat/sessions');

      expect(res.status).toBe(200);
      expect(res.body.data.sessions).toHaveLength(2);
      expect(mockManager.getSessionsWithMessageCount).toHaveBeenCalledWith(1);
    });

    it('should return empty array when no sessions exist', async () => {
      mockManager.getSessionsWithMessageCount.mockReturnValue([]);

      const res = await request(app)
        .get('/api/review/42/chat/sessions');

      expect(res.status).toBe(200);
      expect(res.body.data.sessions).toEqual([]);
    });
  });

  describe('POST /api/chat/session/:id/message (auto-resume)', () => {
    it('should auto-resume when session has agent_session_id', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status, agent_session_id) VALUES (5, 1, 'pi', 'closed', '/tmp/session.json')"
      ).run();

      // Session is NOT active in memory
      mockManager.isSessionActive.mockReturnValue(false);
      mockManager.getSession.mockReturnValue({
        id: 5,
        review_id: 1,
        agent_session_id: '/tmp/session.json',
        status: 'closed'
      });
      // After resume, sendMessage should work
      mockManager.resumeSession.mockResolvedValue({ id: 5, status: 'active' });

      const res = await request(app)
        .post('/api/chat/session/5/message')
        .send({ content: 'hello after restart' });

      expect(res.status).toBe(200);
      expect(mockManager.resumeSession).toHaveBeenCalledWith(5, expect.objectContaining({
        systemPrompt: expect.any(String),
      }));
      expect(mockManager.sendMessage).toHaveBeenCalled();
    });

    it('should return 404 when review is not found during auto-resume', async () => {
      // Use mock getSession (no DB insert needed — review_id 999 intentionally missing)
      mockManager.isSessionActive.mockReturnValue(false);
      mockManager.getSession.mockReturnValue({
        id: 8,
        review_id: 999,
        agent_session_id: '/tmp/session.json',
        status: 'closed'
      });

      const res = await request(app)
        .post('/api/chat/session/8/message')
        .send({ content: 'hello' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Review not found');
    });

    it('should return 410 when session has no agent_session_id', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (6, 1, 'pi', 'closed')"
      ).run();

      mockManager.isSessionActive.mockReturnValue(false);
      mockManager.getSession.mockReturnValue({
        id: 6,
        review_id: 1,
        agent_session_id: null,
        status: 'closed'
      });

      const res = await request(app)
        .post('/api/chat/session/6/message')
        .send({ content: 'hello' });

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('not resumable');
    });

    it('should return 410 when resume fails', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status, agent_session_id) VALUES (7, 1, 'pi', 'closed', '/tmp/session.json')"
      ).run();

      mockManager.isSessionActive.mockReturnValue(false);
      mockManager.getSession.mockReturnValue({
        id: 7,
        review_id: 1,
        agent_session_id: '/tmp/session.json',
        status: 'closed'
      });
      mockManager.resumeSession.mockRejectedValue(new Error('Session file not found'));

      const res = await request(app)
        .post('/api/chat/session/7/message')
        .send({ content: 'hello' });

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('Session file not found');
    });
  });

  describe('POST /api/chat/session/:id/resume', () => {
    it('should return active if already active', async () => {
      mockManager.isSessionActive.mockReturnValue(true);

      const res = await request(app)
        .post('/api/chat/session/1/resume');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: 1, status: 'active' });
      expect(mockManager.resumeSession).not.toHaveBeenCalled();
    });

    it('should resume a resumable session', async () => {
      mockManager.isSessionActive.mockReturnValue(false);
      mockManager.getSession.mockReturnValue({
        id: 1,
        review_id: 1,
        agent_session_id: '/tmp/session.json',
        status: 'closed'
      });

      const res = await request(app)
        .post('/api/chat/session/1/resume');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: 1, status: 'active' });
      expect(mockManager.resumeSession).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it('should return 404 for unknown session', async () => {
      mockManager.isSessionActive.mockReturnValue(false);
      mockManager.getSession.mockReturnValue(null);

      const res = await request(app)
        .post('/api/chat/session/999/resume');

      expect(res.status).toBe(404);
    });

    it('should return 404 when review not found during resume', async () => {
      mockManager.isSessionActive.mockReturnValue(false);
      mockManager.getSession.mockReturnValue({
        id: 1,
        review_id: 999,
        agent_session_id: '/tmp/session.json',
        status: 'closed'
      });

      const res = await request(app)
        .post('/api/chat/session/1/resume');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Review not found');
    });

    it('should return 410 for non-resumable session', async () => {
      mockManager.isSessionActive.mockReturnValue(false);
      mockManager.getSession.mockReturnValue({
        id: 1,
        review_id: 1,
        agent_session_id: null,
        status: 'closed'
      });

      const res = await request(app)
        .post('/api/chat/session/1/resume');

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('not resumable');
    });
  });

  describe('POST /api/chat/session/:id/context', () => {
    it('should save context and return messageId', async () => {
      db.prepare(
        "INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (1, 1, 'pi', 'active')"
      ).run();

      const contextData = { type: 'analysis', suggestionCount: 5, aiRunId: 'run-abc' };
      mockManager.saveContextMessage = vi.fn().mockReturnValue({ id: 200 });

      const res = await request(app)
        .post('/api/chat/session/1/context')
        .send({ contextData });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('messageId', 200);
      expect(mockManager.saveContextMessage).toHaveBeenCalledWith(1, contextData);
    });

    it('should return 400 when contextData is missing', async () => {
      const res = await request(app)
        .post('/api/chat/session/1/context')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('contextData');
    });

    it('should return 404 when session is not found', async () => {
      mockManager.saveContextMessage = vi.fn().mockImplementation(() => {
        throw new Error('Session 999 not found');
      });

      const res = await request(app)
        .post('/api/chat/session/999/context')
        .send({ contextData: { type: 'analysis', suggestionCount: 1 } });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('should return 500 on unexpected error', async () => {
      mockManager.saveContextMessage = vi.fn().mockImplementation(() => {
        throw new Error('database locked');
      });

      const res = await request(app)
        .post('/api/chat/session/1/context')
        .send({ contextData: { type: 'analysis', suggestionCount: 1 } });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Failed to save context');
    });
  });

  describe('GET /api/review/:reviewId/chat/sessions (enhanced)', () => {
    it('should return sessions with message_count, isActive, and isResumable', async () => {
      const mockSessions = [
        { id: 1, review_id: 1, provider: 'pi', status: 'active', agent_session_id: '/tmp/s1.json', message_count: 5 },
        { id: 2, review_id: 1, provider: 'pi', status: 'closed', agent_session_id: '/tmp/s2.json', message_count: 3 },
        { id: 3, review_id: 1, provider: 'pi', status: 'closed', agent_session_id: null, message_count: 0 }
      ];
      mockManager.getSessionsWithMessageCount.mockReturnValue(mockSessions);
      mockManager.isSessionActive.mockImplementation((id) => id === 1);

      const res = await request(app)
        .get('/api/review/1/chat/sessions');

      expect(res.status).toBe(200);
      const sessions = res.body.data.sessions;
      expect(sessions).toHaveLength(3);

      // Session 1: active, not resumable
      expect(sessions[0].isActive).toBe(true);
      expect(sessions[0].isResumable).toBe(false);
      expect(sessions[0].message_count).toBe(5);

      // Session 2: not active, resumable (has agent_session_id)
      expect(sessions[1].isActive).toBe(false);
      expect(sessions[1].isResumable).toBe(true);
      expect(sessions[1].message_count).toBe(3);

      // Session 3: not active, not resumable (no agent_session_id)
      expect(sessions[2].isActive).toBe(false);
      expect(sessions[2].isResumable).toBe(false);
      expect(sessions[2].message_count).toBe(0);
    });
  });
});
