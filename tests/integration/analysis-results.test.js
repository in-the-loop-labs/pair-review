// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

// Mock modules that analysis routes depend on but we don't need
vi.mock('../../src/ai/analyzer', () => ({
  default: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({
    isGenerated: vi.fn().mockReturnValue(false)
  })
}));

const { GitWorktreeManager } = require('../../src/git/worktree');
vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/tmp/worktree/test');

const configModule = require('../../src/config');
vi.spyOn(configModule, 'saveConfig').mockResolvedValue(undefined);
vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
  github_token: 'test-token',
  port: 7247,
  theme: 'light'
});
vi.spyOn(configModule, 'getConfigDir').mockReturnValue('/tmp/.pair-review-test');

const { query, queryOne, run } = require('../../src/database');

const analysisRoutes = require('../../src/routes/analyses');

function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', 'test-token');
  app.set('config', {
    github_token: 'test-token',
    port: 7247,
    theme: 'light',
    model: 'sonnet'
  });
  app.use('/', analysisRoutes);
  return app;
}

describe('POST /api/analyses/results', () => {
  let db;
  let app;

  beforeEach(() => {
    db = createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(() => {
    if (db) {
      closeTestDatabase(db);
    }
    vi.clearAllMocks();
  });

  // --- Validation ---

  it('should return 400 when no identification pair is provided', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({ suggestions: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Must provide either');
  });

  it('should return 400 when both identification pairs are provided', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'abc123',
        repo: 'owner/repo',
        prNumber: 1,
        suggestions: []
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('only one identification pair');
  });

  it('should return 400 when path is provided without headSha', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({ path: '/tmp/project', suggestions: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Must provide either');
  });

  it('should return 400 when repo is provided without prNumber', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({ repo: 'owner/repo', suggestions: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Must provide either');
  });

  it('should return 400 when suggestions is not an array', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'abc123',
        suggestions: 'not-an-array'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('suggestions must be an array');
  });

  it('should return 400 when fileLevelSuggestions is not an array', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'abc123',
        suggestions: [],
        fileLevelSuggestions: 'not-an-array'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('fileLevelSuggestions must be an array');
  });

  it('should return 400 when a suggestion is missing required fields', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'abc123',
        suggestions: [{ file: 'test.js' }]
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/suggestions\[0\] missing required field/);
  });

  it('should return 400 when prNumber is not a positive integer', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({ repo: 'owner/repo', prNumber: -1, suggestions: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid pull request number');
  });

  it('should return 400 when prNumber is zero', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({ repo: 'owner/repo', prNumber: 0, suggestions: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid pull request number');
  });

  it('should return 400 when prNumber is not a number', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({ repo: 'owner/repo', prNumber: 'abc', suggestions: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid pull request number');
  });

  it('should return 400 when a file-level suggestion is missing required fields', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'abc123',
        suggestions: [],
        fileLevelSuggestions: [{ file: 'test.js', type: 'bug' }]
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/fileLevelSuggestions\[0\] missing required field/);
  });

  // --- Local mode happy path ---

  it('should create analysis run and suggestions for local mode', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/my-project',
        headSha: 'abc123def',
        provider: 'claude',
        model: 'sonnet',
        summary: 'Found 2 issues',
        suggestions: [
          {
            file: 'src/index.js',
            line_start: 10,
            line_end: 15,
            old_or_new: 'NEW',
            type: 'bug',
            title: 'Null check missing',
            description: 'This could throw if input is null.',
            suggestion: 'Add a null check before accessing properties.',
            confidence: 0.9
          },
          {
            file: 'src/utils.js',
            line_start: 42,
            line_end: 42,
            old_or_new: 'OLD',
            type: 'improvement',
            title: 'Simplify expression',
            description: 'This boolean expression can be simplified.',
            confidence: 0.7
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.runId).toBeDefined();
    expect(response.body.reviewId).toBeDefined();
    expect(response.body.totalSuggestions).toBe(2);
    expect(response.body.status).toBe('completed');

    // Verify analysis_run was created with completed status
    const analysisRun = await queryOne(db, 'SELECT * FROM analysis_runs WHERE id = ?', [response.body.runId]);
    expect(analysisRun).toBeTruthy();
    expect(analysisRun.status).toBe('completed');
    expect(analysisRun.provider).toBe('claude');
    expect(analysisRun.model).toBe('sonnet');
    expect(analysisRun.summary).toBe('Found 2 issues');
    expect(analysisRun.total_suggestions).toBe(2);
    expect(analysisRun.files_analyzed).toBe(2);
    expect(analysisRun.completed_at).toBeTruthy();
    expect(analysisRun.head_sha).toBe('abc123def');

    // Verify comments were created
    const comments = await query(db, 'SELECT * FROM comments WHERE ai_run_id = ? ORDER BY file', [response.body.runId]);
    expect(comments).toHaveLength(2);

    // First comment: src/index.js
    expect(comments[0].file).toBe('src/index.js');
    expect(comments[0].source).toBe('ai');
    expect(comments[0].ai_level).toBeNull();
    expect(comments[0].ai_confidence).toBe(0.9);
    expect(comments[0].line_start).toBe(10);
    expect(comments[0].line_end).toBe(15);
    expect(comments[0].side).toBe('RIGHT');
    expect(comments[0].type).toBe('bug');
    expect(comments[0].title).toBe('Null check missing');
    expect(comments[0].body).toContain('This could throw if input is null.');
    expect(comments[0].body).toContain('**Suggestion:**');
    expect(comments[0].status).toBe('active');
    expect(comments[0].is_file_level).toBe(0);

    // Second comment: src/utils.js - OLD side maps to LEFT
    expect(comments[1].file).toBe('src/utils.js');
    expect(comments[1].side).toBe('LEFT');
    expect(comments[1].type).toBe('improvement');
  });

  // --- PR mode happy path ---

  it('should create analysis run and suggestions for PR mode', async () => {
    // Manually insert a review to test the "review already exists" code path
    // (contrast with the test below that verifies auto-creation when no review exists)
    await run(db, `
      INSERT INTO reviews (pr_number, repository, status, review_type)
      VALUES (?, ?, 'draft', 'pr')
    `, [42, 'owner/repo']);

    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        repo: 'owner/repo',
        prNumber: 42,
        provider: 'gemini',
        model: 'pro',
        summary: 'Looks good overall',
        suggestions: [
          {
            file: 'app.js',
            line_start: 5,
            line_end: 5,
            type: 'praise',
            title: 'Nice error handling',
            description: 'Good use of try/catch here.',
            confidence: 0.95
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.totalSuggestions).toBe(1);
    expect(response.body.status).toBe('completed');

    // Verify the suggestion was stored
    const comments = await query(db, 'SELECT * FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comments).toHaveLength(1);
    expect(comments[0].file).toBe('app.js');
    expect(comments[0].type).toBe('praise');
  });

  it('should create a new review for PR mode if none exists', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        repo: 'owner/repo',
        prNumber: 99,
        suggestions: []
      });

    expect(response.status).toBe(201);
    expect(response.body.reviewId).toBeDefined();

    // Verify review was created
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [response.body.reviewId]);
    expect(review).toBeTruthy();
    expect(review.pr_number).toBe(99);
    expect(review.repository).toBe('owner/repo');
    expect(review.review_type).toBe('pr');
  });

  // --- Empty suggestions ---

  it('should create a run with zero suggestions', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/empty-project',
        headSha: 'deadbeef',
        summary: 'No issues found',
        suggestions: []
      });

    expect(response.status).toBe(201);
    expect(response.body.totalSuggestions).toBe(0);

    const analysisRun = await queryOne(db, 'SELECT * FROM analysis_runs WHERE id = ?', [response.body.runId]);
    expect(analysisRun.total_suggestions).toBe(0);
    expect(analysisRun.files_analyzed).toBe(0);
    expect(analysisRun.summary).toBe('No issues found');
  });

  // --- Side mapping ---

  it('should map OLD to LEFT and NEW to RIGHT', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'sha1',
        suggestions: [
          {
            file: 'a.js', line_start: 1, line_end: 1, old_or_new: 'OLD',
            type: 'bug', title: 'Old side', description: 'desc'
          },
          {
            file: 'b.js', line_start: 2, line_end: 2, old_or_new: 'NEW',
            type: 'bug', title: 'New side', description: 'desc'
          },
          {
            file: 'c.js', line_start: 3, line_end: 3,
            type: 'bug', title: 'Default side', description: 'desc'
          }
        ]
      });

    expect(response.status).toBe(201);

    const comments = await query(db,
      'SELECT file, side FROM comments WHERE ai_run_id = ? ORDER BY file',
      [response.body.runId]
    );

    expect(comments[0]).toEqual({ file: 'a.js', side: 'LEFT' });
    expect(comments[1]).toEqual({ file: 'b.js', side: 'RIGHT' });
    expect(comments[2]).toEqual({ file: 'c.js', side: 'RIGHT' }); // default
  });

  // --- File-level suggestions ---

  it('should store file-level suggestions with is_file_level=1 and null line numbers', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'sha2',
        suggestions: [],
        fileLevelSuggestions: [
          {
            file: 'README.md',
            type: 'suggestion',
            title: 'Add examples section',
            description: 'README would benefit from usage examples.',
            confidence: 0.6
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.totalSuggestions).toBe(1);

    const comments = await query(db, 'SELECT * FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comments).toHaveLength(1);
    expect(comments[0].is_file_level).toBe(1);
    expect(comments[0].line_start).toBeNull();
    expect(comments[0].line_end).toBeNull();
    expect(comments[0].file).toBe('README.md');
  });

  // --- Summary written to analysis_run record ---

  it('should store summary on the analysis_run record', async () => {
    const summary = 'This PR introduces 3 new utility functions. Overall quality is high.';
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'sha3',
        summary,
        suggestions: [
          {
            file: 'utils.js', line_start: 1, line_end: 1,
            type: 'praise', title: 'Clean code', description: 'Well structured.'
          }
        ]
      });

    expect(response.status).toBe(201);

    const analysisRun = await queryOne(db, 'SELECT summary FROM analysis_runs WHERE id = ?', [response.body.runId]);
    expect(analysisRun.summary).toBe(summary);
  });

  // --- Suggestion body formatting ---

  it('should format suggestion body with description and suggestion text', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'sha4',
        suggestions: [
          {
            file: 'x.js', line_start: 1, line_end: 1,
            type: 'bug', title: 'Issue',
            description: 'There is a problem.',
            suggestion: 'Fix it like this.'
          }
        ]
      });

    expect(response.status).toBe(201);

    const comment = await queryOne(db, 'SELECT body FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comment.body).toBe('There is a problem.\n\n**Suggestion:** Fix it like this.');
  });

  it('should format suggestion body without suggestion text when absent', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'sha5',
        suggestions: [
          {
            file: 'x.js', line_start: 1, line_end: 1,
            type: 'praise', title: 'Nice',
            description: 'Well done.'
          }
        ]
      });

    expect(response.status).toBe(201);

    const comment = await queryOne(db, 'SELECT body FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comment.body).toBe('Well done.');
  });

  // --- Mixed line-level and file-level suggestions ---

  it('should handle both line-level and file-level suggestions in one request', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'sha6',
        suggestions: [
          {
            file: 'a.js', line_start: 10, line_end: 12,
            type: 'bug', title: 'Line bug', description: 'Bug on line 10.'
          }
        ],
        fileLevelSuggestions: [
          {
            file: 'a.js',
            type: 'design', title: 'File structure', description: 'Consider reorganizing.'
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.totalSuggestions).toBe(2);
    expect(response.body.reviewId).toBeDefined();

    const comments = await query(db,
      'SELECT is_file_level, line_start FROM comments WHERE ai_run_id = ? ORDER BY is_file_level',
      [response.body.runId]
    );
    expect(comments).toHaveLength(2);
    // Line-level first (is_file_level=0)
    expect(comments[0].is_file_level).toBe(0);
    expect(comments[0].line_start).toBe(10);
    // File-level second (is_file_level=1)
    expect(comments[1].is_file_level).toBe(1);
    expect(comments[1].line_start).toBeNull();
  });

  // --- Line normalization ---

  it('should normalize line to line_start/line_end', async () => {
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/project',
        headSha: 'sha-norm',
        suggestions: [{
          file: 'a.js', line: 10,
          type: 'bug', title: 'Test', description: 'Test'
        }]
      });
    expect(response.status).toBe(201);
    const comment = await queryOne(db,
      'SELECT line_start, line_end FROM comments WHERE ai_run_id = ?',
      [response.body.runId]);
    expect(comment.line_start).toBe(10);
    expect(comment.line_end).toBe(10);
  });

  // --- Idempotent local review upsert ---

  it('should reuse existing local review on repeat POST with same path+headSha', async () => {
    const payload = {
      path: '/tmp/same-project',
      headSha: 'sameSha',
      suggestions: [
        {
          file: 'f.js', line_start: 1, line_end: 1,
          type: 'bug', title: 'Bug', description: 'A bug.'
        }
      ]
    };

    const first = await request(app).post('/api/analyses/results').send(payload);
    const second = await request(app).post('/api/analyses/results').send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Same review, different run IDs
    expect(first.body.reviewId).toBe(second.body.reviewId);
    expect(first.body.runId).not.toBe(second.body.runId);
  });

  // --- SSE broadcast on review-level key ---

  it('should broadcast on review-${reviewId} key for local mode', async () => {
    const { progressClients } = require('../../src/routes/shared');

    // We'll capture messages by registering a fake SSE client before the request
    // First, make the request to discover the reviewId
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/sse-project',
        headSha: 'ssesha1',
        suggestions: [{
          file: 'a.js', line_start: 1, line_end: 1,
          type: 'bug', title: 'Bug', description: 'desc'
        }]
      });

    expect(response.status).toBe(201);
    const reviewId = response.body.reviewId;

    // Now register a fake client and make a second request to verify broadcast
    const messages = [];
    const fakeClient = { write: (msg) => messages.push(msg) };
    const key = `review-${reviewId}`;
    progressClients.set(key, new Set([fakeClient]));

    const response2 = await request(app)
      .post('/api/analyses/results')
      .send({
        path: '/tmp/sse-project',
        headSha: 'ssesha1',
        suggestions: [{
          file: 'a.js', line_start: 1, line_end: 1,
          type: 'bug', title: 'Bug2', description: 'desc2'
        }]
      });

    expect(response2.status).toBe(201);
    // The fake client should have received a message with source: 'external'
    const externalMessages = messages.filter(m => m.includes('"source":"external"'));
    expect(externalMessages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(externalMessages[0].replace('data: ', '').trim());
    expect(parsed.status).toBe('completed');
    expect(parsed.source).toBe('external');

    // Clean up
    progressClients.delete(key);
  });

  it('should broadcast on review-${reviewId} key for PR mode', async () => {
    const { progressClients } = require('../../src/routes/shared');

    // First request to discover reviewId
    const response = await request(app)
      .post('/api/analyses/results')
      .send({
        repo: 'owner/repo',
        prNumber: 77,
        suggestions: [{
          file: 'b.js', line_start: 1, line_end: 1,
          type: 'bug', title: 'Bug', description: 'desc'
        }]
      });

    expect(response.status).toBe(201);
    const reviewId = response.body.reviewId;

    // Register fake client on the review-level key
    const messages = [];
    const fakeClient = { write: (msg) => messages.push(msg) };
    const key = `review-${reviewId}`;
    progressClients.set(key, new Set([fakeClient]));

    const response2 = await request(app)
      .post('/api/analyses/results')
      .send({
        repo: 'owner/repo',
        prNumber: 77,
        suggestions: [{
          file: 'b.js', line_start: 1, line_end: 1,
          type: 'bug', title: 'Bug2', description: 'desc2'
        }]
      });

    expect(response2.status).toBe(201);
    const externalMessages = messages.filter(m => m.includes('"source":"external"'));
    expect(externalMessages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(externalMessages[0].replace('data: ', '').trim());
    expect(parsed.status).toBe('completed');
    expect(parsed.source).toBe('external');

    // Clean up
    progressClients.delete(key);
  });
});
