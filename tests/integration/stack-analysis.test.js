// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

/**
 * Stack Analysis API Integration Tests
 *
 * Tests the stack analysis endpoints:
 * - POST /api/pr/:owner/:repo/:number/analyses/stack
 * - GET  /api/analyses/stack/:stackAnalysisId
 * - POST /api/analyses/stack/:stackAnalysisId/cancel
 * - GET  /api/pr/:owner/:repo/:number/stack-info
 *
 * External dependencies are mocked. The background executeStackAnalysis is
 * prevented from running by mocking GitWorktreeManager so the POST endpoint
 * returns immediately without spawning real git operations.
 */

const { GitWorktreeManager } = require('../../src/git/worktree');
const { GitHubClient } = require('../../src/github/client');
const configModule = require('../../src/config');

// Spy on GitWorktreeManager prototype — the stack endpoint uses getWorktreePath
vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/tmp/worktree/test');
vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
vi.spyOn(GitWorktreeManager.prototype, 'generateUnifiedDiff').mockResolvedValue('diff');
vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles').mockResolvedValue([]);
vi.spyOn(GitWorktreeManager.prototype, 'checkoutBranch').mockResolvedValue('abc123');

// Spy on GitHubClient prototype
vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockResolvedValue({
  title: 'Test PR', body: 'desc', author: 'testuser',
  base_branch: 'main', head_branch: 'feature', state: 'open',
  base_sha: 'abc123', head_sha: 'def456', node_id: 'PR_node1',
  html_url: 'https://github.com/owner/repo/pull/1', additions: 10, deletions: 5
});

// Spy on config module
vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
  config: { github_token: 'test-token', port: 7247, theme: 'light', monorepos: {} },
  isFirstRun: false
});
vi.spyOn(configModule, 'getConfigDir').mockReturnValue('/tmp/.pair-review-test');
vi.spyOn(configModule, 'getGitHubToken').mockReturnValue('test-token');

// Mock the analyzer to prevent real AI calls
vi.mock('../../src/ai/analyzer', () => ({
  default: vi.fn().mockImplementation(() => ({
    analyzeLevel1: vi.fn().mockResolvedValue({ suggestions: [], level2Result: null }),
    analyzeLevel2: vi.fn().mockResolvedValue({ suggestions: [] }),
    analyzeLevel3: vi.fn().mockResolvedValue({ suggestions: [] })
  }))
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({
    isGenerated: vi.fn().mockReturnValue(false),
    getPatterns: vi.fn().mockReturnValue([])
  })
}));

// Mock ws to prevent actual WebSocket broadcasts
vi.mock('../../src/ws', () => ({
  broadcast: vi.fn()
}));

// Mock events/review-events to prevent broadcast side effects
vi.mock('../../src/events/review-events', () => ({
  broadcastReviewEvent: vi.fn()
}));

// Load route modules
const stackAnalysisRoutes = require('../../src/routes/stack-analysis');
const prRoutes = require('../../src/routes/pr');

const { run } = require('../../src/database');

/**
 * Create a test Express app with stack-analysis and pr routes
 */
function createTestApp(db, config = {}) {
  const app = express();
  app.use(express.json());

  app.set('db', db);
  app.set('githubToken', 'test-token');
  app.set('config', {
    github_token: 'test-token',
    port: 7247,
    theme: 'light',
    enable_graphite: true,
    ...config
  });

  // Mount stack-analysis routes before pr routes (more specific first)
  app.use('/', stackAnalysisRoutes);
  app.use('/', prRoutes);

  return app;
}

/**
 * Insert test PR metadata and review into the database.
 */
async function insertTestPR(db, prNumber = 1, repository = 'owner/repo') {
  const prData = JSON.stringify({
    state: 'open', diff: 'diff content',
    changed_files: [{ file: 'file.js', additions: 1, deletions: 0 }],
    additions: 10, deletions: 5,
    html_url: `https://github.com/${repository}/pull/${prNumber}`,
    base_sha: 'abc123', head_sha: 'def456', node_id: 'PR_node123'
  });

  await run(db, `
    INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [prNumber, repository, `Test PR #${prNumber}`, 'Test Description', 'testuser', 'main', `feature-${prNumber}`, prData]);

  const reviewResult = await run(db, `
    INSERT INTO reviews (pr_number, repository, status, created_at, updated_at)
    VALUES (?, ?, 'draft', datetime('now'), datetime('now'))
  `, [prNumber, repository]);

  return reviewResult.lastID;
}

/**
 * Insert a test worktree record.
 */
async function insertTestWorktree(db, prNumber = 1, repository = 'owner/repo') {
  const now = new Date().toISOString();
  await run(db, `
    INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [`wt-${prNumber}`, prNumber, repository, `feature-${prNumber}`, '/tmp/worktree/test', now, now]);
}

// ============================================================================
// POST /api/pr/:owner/:repo/:number/analyses/stack
// ============================================================================

describe('POST /api/pr/:owner/:repo/:number/analyses/stack', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db);
    await insertTestPR(db, 1);
    await insertTestWorktree(db, 1);
  });

  afterEach(async () => {
    // Clear the in-memory stack analyses map
    stackAnalysisRoutes.activeStackAnalyses.clear();
    if (db) closeTestDatabase(db);
    vi.clearAllMocks();
    // Restore default mocks
    vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/tmp/worktree/test');
  });

  it('returns stackAnalysisId and pending prAnalyses for valid request', async () => {
    const res = await request(app)
      .post('/api/pr/owner/repo/1/analyses/stack')
      .send({
        prNumbers: [1, 2, 3],
        analysisConfig: { configType: 'single', provider: 'claude', model: 'opus' }
      })
      .expect(200);

    expect(res.body).toHaveProperty('stackAnalysisId');
    expect(res.body.status).toBe('started');
    expect(res.body.prAnalyses).toHaveLength(3);
    expect(res.body.prAnalyses[0]).toEqual({ prNumber: 1, status: 'pending' });
    expect(res.body.prAnalyses[1]).toEqual({ prNumber: 2, status: 'pending' });
    expect(res.body.prAnalyses[2]).toEqual({ prNumber: 3, status: 'pending' });
  });

  it('rejects with 400 when prNumbers is empty', async () => {
    const res = await request(app)
      .post('/api/pr/owner/repo/1/analyses/stack')
      .send({
        prNumbers: [],
        analysisConfig: { configType: 'single' }
      })
      .expect(400);

    expect(res.body.error).toMatch(/prNumbers must be a non-empty array/);
  });

  it('rejects with 400 when prNumbers is not an array', async () => {
    const res = await request(app)
      .post('/api/pr/owner/repo/1/analyses/stack')
      .send({
        prNumbers: 'not-an-array',
        analysisConfig: { configType: 'single' }
      })
      .expect(400);

    expect(res.body.error).toMatch(/prNumbers must be a non-empty array/);
  });

  it('rejects with 400 when prNumbers is missing', async () => {
    const res = await request(app)
      .post('/api/pr/owner/repo/1/analyses/stack')
      .send({
        analysisConfig: { configType: 'single' }
      })
      .expect(400);

    expect(res.body.error).toMatch(/prNumbers must be a non-empty array/);
  });

  it('rejects with 400 when analysisConfig is missing', async () => {
    const res = await request(app)
      .post('/api/pr/owner/repo/1/analyses/stack')
      .send({
        prNumbers: [1, 2]
      })
      .expect(400);

    expect(res.body.error).toMatch(/analysisConfig is required/);
  });

  it('rejects with 400 for invalid PR numbers in array', async () => {
    const res = await request(app)
      .post('/api/pr/owner/repo/1/analyses/stack')
      .send({
        prNumbers: [1, -5, 3],
        analysisConfig: { configType: 'single' }
      })
      .expect(400);

    expect(res.body.error).toMatch(/Invalid PR number/);
  });

  it('rejects with 400 for invalid trigger PR number', async () => {
    const res = await request(app)
      .post('/api/pr/owner/repo/abc/analyses/stack')
      .send({
        prNumbers: [1, 2],
        analysisConfig: { configType: 'single' }
      })
      .expect(400);

    expect(res.body.error).toMatch(/Invalid pull request number/);
  });

  // Lock check was removed — per-PR worktrees eliminate shared worktree contention

  it('returns 404 when worktree not found', async () => {
    vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(null);

    const res = await request(app)
      .post('/api/pr/owner/repo/1/analyses/stack')
      .send({
        prNumbers: [1, 2],
        analysisConfig: { configType: 'single' }
      })
      .expect(404);

    expect(res.body.error).toMatch(/Worktree not found/);
  });
});

// ============================================================================
// GET /api/analyses/stack/:stackAnalysisId
// ============================================================================

describe('GET /api/analyses/stack/:stackAnalysisId', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    stackAnalysisRoutes.activeStackAnalyses.clear();
    if (db) closeTestDatabase(db);
    vi.clearAllMocks();
  });

  it('returns current state for a valid stack analysis', async () => {
    const stackAnalysisId = 'test-stack-123';
    const prStatuses = new Map();
    prStatuses.set(1, { status: 'completed', analysisId: 'a1', suggestionsCount: 5 });
    prStatuses.set(2, { status: 'running' });
    prStatuses.set(3, { status: 'pending' });

    stackAnalysisRoutes.activeStackAnalyses.set(stackAnalysisId, {
      id: stackAnalysisId,
      status: 'running',
      totalPRs: 3,
      startedAt: '2026-03-29T00:00:00.000Z',
      completedAt: null,
      error: null,
      prStatuses
    });

    const res = await request(app)
      .get(`/api/analyses/stack/${stackAnalysisId}`)
      .expect(200);

    expect(res.body.id).toBe(stackAnalysisId);
    expect(res.body.status).toBe('running');
    expect(res.body.currentPRNumber).toBeNull();
    expect(res.body.currentPRIndex).toBeNull();
    expect(res.body.totalPRs).toBe(3);
    expect(res.body.prStatuses).toHaveLength(3);
    expect(res.body.prStatuses[0]).toEqual({
      prNumber: 1, status: 'completed', analysisId: 'a1', suggestionsCount: 5
    });
    expect(res.body.prStatuses[1]).toEqual({ prNumber: 2, status: 'running' });
    expect(res.body.prStatuses[2]).toEqual({ prNumber: 3, status: 'pending' });
  });

  it('returns 404 for unknown stack analysis ID', async () => {
    const res = await request(app)
      .get('/api/analyses/stack/nonexistent-id')
      .expect(404);

    expect(res.body.error).toMatch(/not found/);
  });
});

// ============================================================================
// POST /api/analyses/stack/:stackAnalysisId/cancel
// ============================================================================

describe('POST /api/analyses/stack/:stackAnalysisId/cancel', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    stackAnalysisRoutes.activeStackAnalyses.clear();
    if (db) closeTestDatabase(db);
    vi.clearAllMocks();
  });

  it('sets cancelled flag on active analysis', async () => {
    const stackAnalysisId = 'cancel-test-123';
    const prStatuses = new Map();
    prStatuses.set(1, { status: 'completed' });
    prStatuses.set(2, { status: 'running' });

    stackAnalysisRoutes.activeStackAnalyses.set(stackAnalysisId, {
      id: stackAnalysisId,
      status: 'running',
      currentPRNumber: 2,
      currentPRIndex: 1,
      totalPRs: 2,
      startedAt: '2026-03-29T00:00:00.000Z',
      cancelled: false,
      prStatuses
    });

    const res = await request(app)
      .post(`/api/analyses/stack/${stackAnalysisId}/cancel`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/cancellation requested/);
    expect(res.body.status).toBe('cancelling');

    // Verify the cancelled flag was set
    const state = stackAnalysisRoutes.activeStackAnalyses.get(stackAnalysisId);
    expect(state.cancelled).toBe(true);
  });

  it('returns success for already-completed analysis', async () => {
    const stackAnalysisId = 'completed-test-123';
    const prStatuses = new Map();
    prStatuses.set(1, { status: 'completed' });

    stackAnalysisRoutes.activeStackAnalyses.set(stackAnalysisId, {
      id: stackAnalysisId,
      status: 'completed',
      prStatuses
    });

    const res = await request(app)
      .post(`/api/analyses/stack/${stackAnalysisId}/cancel`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/already completed/);
    expect(res.body.status).toBe('completed');
  });

  it('returns 404 for unknown stack analysis ID', async () => {
    const res = await request(app)
      .post('/api/analyses/stack/nonexistent-id/cancel')
      .expect(404);

    expect(res.body.error).toMatch(/not found/);
  });
});

// ============================================================================
// GET /api/pr/:owner/:repo/:number/stack-info
// ============================================================================

describe('GET /api/pr/:owner/:repo/:number/stack-info', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db);
    await insertTestPR(db, 1);
    await insertTestWorktree(db, 1);
  });

  afterEach(async () => {
    if (db) closeTestDatabase(db);
    vi.clearAllMocks();
    vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/tmp/worktree/test');
  });

  it('returns 404 when Graphite is not enabled', async () => {
    const appNoGraphite = createTestApp(db, { enable_graphite: false });

    const res = await request(appNoGraphite)
      .get('/api/pr/owner/repo/1/stack-info')
      .expect(404);

    expect(res.body.error).toMatch(/Graphite integration is not enabled/);
  });

  it('returns 404 when config has no enable_graphite', async () => {
    // Config without enable_graphite at all — the default createTestApp sets it,
    // so override with a false value.
    const appNoGraphite = createTestApp(db, { enable_graphite: undefined });

    const res = await request(appNoGraphite)
      .get('/api/pr/owner/repo/1/stack-info')
      .expect(404);

    expect(res.body.error).toMatch(/Graphite integration is not enabled/);
  });

  it('returns 400 for invalid PR number', async () => {
    const res = await request(app)
      .get('/api/pr/owner/repo/abc/stack-info')
      .expect(400);

    expect(res.body.error).toMatch(/Invalid pull request number/);
  });

  it('returns 404 when PR metadata not found', async () => {
    const res = await request(app)
      .get('/api/pr/owner/repo/999/stack-info')
      .expect(404);

    expect(res.body.error).toMatch(/not found/);
  });

  it('returns 404 when worktree not found', async () => {
    vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(null);

    const res = await request(app)
      .get('/api/pr/owner/repo/1/stack-info')
      .expect(404);

    expect(res.body.error).toMatch(/Worktree not found/);
  });
});
