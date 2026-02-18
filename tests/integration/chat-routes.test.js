// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

// Mock logger to suppress output
const logger = require('../../src/utils/logger');
vi.spyOn(logger, 'info').mockImplementation(() => {});
vi.spyOn(logger, 'debug').mockImplementation(() => {});
vi.spyOn(logger, 'warn').mockImplementation(() => {});
vi.spyOn(logger, 'error').mockImplementation(() => {});

// Mock fs.readFile for code snippet reading
const fs = require('fs').promises;
vi.spyOn(fs, 'readFile').mockResolvedValue(
  Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
);

// Mock the AI provider — spy on the actual module so CommonJS require() picks it up
const aiModule = require('../../src/ai/index');
vi.spyOn(aiModule, 'createProvider').mockReturnValue({
  execute: vi.fn().mockResolvedValue({ raw: 'Mock AI response' })
});

const database = require('../../src/database.js');
const { run, query, queryOne, ChatRepository } = database;

// Load routes after mocks
const chatRoutes = require('../../src/routes/chat');
const localRoutes = require('../../src/routes/local');

/**
 * Create a test Express app with chat routes
 */
function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', 'test-token');
  app.set('config', { github_token: 'test-token', port: 7247, theme: 'light' });

  app.use('/', chatRoutes);
  app.use('/', localRoutes);

  return app;
}

/**
 * Seed a PR review with comment and worktree
 */
async function seedPRReview(db) {
  // Review
  const reviewResult = await run(db, `
    INSERT INTO reviews (pr_number, repository, status, review_type)
    VALUES (1, 'owner/repo', 'draft', 'pr')
  `);
  const reviewId = reviewResult.lastID;

  // PR metadata
  await run(db, `
    INSERT INTO pr_metadata (pr_number, repository, title, author, base_branch, head_branch, pr_data)
    VALUES (1, 'owner/repo', 'Test PR', 'testuser', 'main', 'feature', '{}')
  `);

  // Worktree
  const now = new Date().toISOString();
  await run(db, `
    INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
    VALUES ('wt-1', 1, 'owner/repo', 'feature', '/tmp/worktree', ?, ?)
  `, [now, now]);

  // AI comment
  const commentResult = await run(db, `
    INSERT INTO comments (review_id, source, file, line_start, line_end, body, status, type, title)
    VALUES (?, 'ai', 'src/utils.js', 10, 15, 'Consider refactoring', 'active', 'improvement', 'Refactor')
  `, [reviewId]);

  return { reviewId, commentId: commentResult.lastID };
}

/**
 * Seed a local review with comment
 */
async function seedLocalReview(db) {
  const reviewResult = await run(db, `
    INSERT INTO reviews (repository, status, review_type, local_path, local_head_sha)
    VALUES ('test/repo', 'draft', 'local', '/tmp/local-repo', 'abc123')
  `);
  const reviewId = reviewResult.lastID;

  const commentResult = await run(db, `
    INSERT INTO comments (review_id, source, file, line_start, body, status, type)
    VALUES (?, 'ai', 'src/main.js', 5, 'Add error handling', 'active', 'bug')
  `, [reviewId]);

  return { reviewId, commentId: commentResult.lastID };
}

// ============================================================================
// PR Mode Chat Routes
// ============================================================================

describe('PR Mode Chat Routes', () => {
  let db;
  let app;
  let reviewId;
  let commentId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    const seed = await seedPRReview(db);
    reviewId = seed.reviewId;
    commentId = seed.commentId;
  });

  afterEach(async () => {
    if (db) closeTestDatabase(db);
  });

  describe('POST /api/chat/start', () => {
    it('should start a new chat session', async () => {
      const res = await request(app)
        .post('/api/chat/start')
        .send({ commentId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.chatId).toBeDefined();
      expect(res.body.provider).toBeDefined();
      expect(res.body.model).toBeDefined();
    });

    it('should return 400 when commentId is missing', async () => {
      const res = await request(app)
        .post('/api/chat/start')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('commentId');
    });

    it('should return 404 when comment does not exist', async () => {
      const res = await request(app)
        .post('/api/chat/start')
        .send({ commentId: 9999 });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/chat/:chatId/message', () => {
    let chatId;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/chat/start')
        .send({ commentId });
      chatId = res.body.chatId;
    });

    it('should send a message and receive a response', async () => {
      const res = await request(app)
        .post(`/api/chat/${chatId}/message`)
        .send({ content: 'Why should I refactor this?' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.response).toBeDefined();
      expect(res.body.messageId).toBeDefined();
    });

    it('should return 400 when content is empty', async () => {
      const res = await request(app)
        .post(`/api/chat/${chatId}/message`)
        .send({ content: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('content');
    });

    it('should return 400 when content is whitespace-only', async () => {
      const res = await request(app)
        .post(`/api/chat/${chatId}/message`)
        .send({ content: '   ' });

      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent chat session', async () => {
      const res = await request(app)
        .post('/api/chat/non-existent/message')
        .send({ content: 'Hello' });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/chat/:chatId/messages', () => {
    let chatId;

    beforeEach(async () => {
      const startRes = await request(app)
        .post('/api/chat/start')
        .send({ commentId });
      chatId = startRes.body.chatId;

      // Send a message to have some history
      await request(app)
        .post(`/api/chat/${chatId}/message`)
        .send({ content: 'Test question' });
    });

    it('should return chat session with messages', async () => {
      const res = await request(app)
        .get(`/api/chat/${chatId}/messages`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.session).toBeDefined();
      expect(res.body.session.messages).toBeDefined();
      expect(res.body.session.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .get('/api/chat/non-existent/messages');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/chat/:chatId/adopt', () => {
    let chatId;

    beforeEach(async () => {
      const startRes = await request(app)
        .post('/api/chat/start')
        .send({ commentId });
      chatId = startRes.body.chatId;

      await request(app)
        .post(`/api/chat/${chatId}/message`)
        .send({ content: 'Can you improve this suggestion?' });
    });

    it('should generate a refined suggestion', async () => {
      const res = await request(app)
        .post(`/api/chat/${chatId}/adopt`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.refinedText).toBeDefined();
      expect(res.body.commentId).toBe(commentId);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .post('/api/chat/non-existent/adopt');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/chat/comment/:commentId/sessions', () => {
    it('should return sessions for a comment', async () => {
      // Start a session first
      await request(app)
        .post('/api/chat/start')
        .send({ commentId });

      const res = await request(app)
        .get(`/api/chat/comment/${commentId}/sessions`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sessions).toBeDefined();
      expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('should return 404 for non-existent comment', async () => {
      const res = await request(app)
        .get('/api/chat/comment/9999/sessions');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/chat/review/:reviewId/comment-sessions', () => {
    it('should return comment IDs with chat history', async () => {
      // Start a session and send a message
      const startRes = await request(app)
        .post('/api/chat/start')
        .send({ commentId });

      await request(app)
        .post(`/api/chat/${startRes.body.chatId}/message`)
        .send({ content: 'Hello' });

      const res = await request(app)
        .get(`/api/chat/review/${reviewId}/comment-sessions`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.commentIds).toContain(commentId);
    });

    it('should return 400 for invalid review ID', async () => {
      const res = await request(app)
        .get('/api/chat/review/invalid/comment-sessions');

      expect(res.status).toBe(400);
    });

    it('should return empty array when no chat history exists', async () => {
      const res = await request(app)
        .get(`/api/chat/review/${reviewId}/comment-sessions`);

      expect(res.status).toBe(200);
      expect(res.body.commentIds).toEqual([]);
    });
  });
});

// ============================================================================
// Local Mode Chat Routes
// ============================================================================

describe('Local Mode Chat Routes', () => {
  let db;
  let app;
  let reviewId;
  let commentId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    const seed = await seedLocalReview(db);
    reviewId = seed.reviewId;
    commentId = seed.commentId;
  });

  afterEach(async () => {
    if (db) closeTestDatabase(db);
  });

  describe('POST /api/local/:reviewId/chat/start', () => {
    it('should start a local chat session', async () => {
      const res = await request(app)
        .post(`/api/local/${reviewId}/chat/start`)
        .send({ commentId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.chatId).toBeDefined();
    });

    it('should return 400 for invalid review ID', async () => {
      const res = await request(app)
        .post('/api/local/invalid/chat/start')
        .send({ commentId });

      expect(res.status).toBe(400);
    });

    it('should return 400 when commentId is missing', async () => {
      const res = await request(app)
        .post(`/api/local/${reviewId}/chat/start`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/local/:reviewId/chat/:chatId/message', () => {
    let chatId;

    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/local/${reviewId}/chat/start`)
        .send({ commentId });
      chatId = res.body.chatId;
    });

    it('should send a message in a local chat session', async () => {
      const res = await request(app)
        .post(`/api/local/${reviewId}/chat/${chatId}/message`)
        .send({ content: 'Tell me more about this bug' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.response).toBeDefined();
    });

    it('should return 400 for empty content', async () => {
      const res = await request(app)
        .post(`/api/local/${reviewId}/chat/${chatId}/message`)
        .send({ content: '' });

      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent chat session', async () => {
      const res = await request(app)
        .post(`/api/local/${reviewId}/chat/non-existent/message`)
        .send({ content: 'Hello' });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/local/:reviewId/chat/:chatId/messages', () => {
    let chatId;

    beforeEach(async () => {
      const startRes = await request(app)
        .post(`/api/local/${reviewId}/chat/start`)
        .send({ commentId });
      chatId = startRes.body.chatId;

      await request(app)
        .post(`/api/local/${reviewId}/chat/${chatId}/message`)
        .send({ content: 'Test question' });
    });

    it('should return messages for a local chat session', async () => {
      const res = await request(app)
        .get(`/api/local/${reviewId}/chat/${chatId}/messages`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.session.messages.length).toBeGreaterThanOrEqual(2);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .get(`/api/local/${reviewId}/chat/non-existent/messages`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/local/:reviewId/chat/:chatId/adopt', () => {
    let chatId;

    beforeEach(async () => {
      const startRes = await request(app)
        .post(`/api/local/${reviewId}/chat/start`)
        .send({ commentId });
      chatId = startRes.body.chatId;

      await request(app)
        .post(`/api/local/${reviewId}/chat/${chatId}/message`)
        .send({ content: 'Improve this' });
    });

    it('should generate a refined suggestion for local review', async () => {
      const res = await request(app)
        .post(`/api/local/${reviewId}/chat/${chatId}/adopt`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.refinedText).toBeDefined();
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .post(`/api/local/${reviewId}/chat/non-existent/adopt`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/local/:reviewId/chat/comment/:commentId/sessions', () => {
    it('should return sessions for a local comment', async () => {
      await request(app)
        .post(`/api/local/${reviewId}/chat/start`)
        .send({ commentId });

      const res = await request(app)
        .get(`/api/local/${reviewId}/chat/comment/${commentId}/sessions`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('should return 400 for invalid review ID', async () => {
      const res = await request(app)
        .get(`/api/local/abc/chat/comment/${commentId}/sessions`);

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/local/:reviewId/chat/comment-sessions', () => {
    it('should return comment IDs with chat history for local review', async () => {
      const startRes = await request(app)
        .post(`/api/local/${reviewId}/chat/start`)
        .send({ commentId });

      await request(app)
        .post(`/api/local/${reviewId}/chat/${startRes.body.chatId}/message`)
        .send({ content: 'Hello' });

      const res = await request(app)
        .get(`/api/local/${reviewId}/chat/comment-sessions`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.commentIds).toContain(commentId);
    });

    it('should return 400 for invalid review ID', async () => {
      const res = await request(app)
        .get('/api/local/abc/chat/comment-sessions');

      expect(res.status).toBe(400);
    });
  });
});
