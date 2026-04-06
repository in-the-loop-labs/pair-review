// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const express = require('express');
const request = require('supertest');

// Mock GitWorktreeManager to prevent real git operations
const { GitWorktreeManager } = require('../../src/git/worktree');
vi.spyOn(GitWorktreeManager.prototype, 'cleanupWorktree').mockResolvedValue(undefined);

// Mock config module to prevent reading user's real config
const configModule = require('../../src/config');
vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
  config: { github_token: 'test-token', port: 7247, theme: 'light' },
  isFirstRun: false,
});
vi.spyOn(configModule, 'getConfigDir').mockReturnValue('/tmp/.pair-review-test');

// Load the route under test after mocks are in place
const worktreesRoutes = require('../../src/routes/worktrees');

// ── Helpers ──────────────────────────────────────────────────────────────

const REPO = 'owner/repo';

function createApp(db, { config, poolLifecycle } = {}) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('config', config || {
    github_token: 'test-token',
    port: 7247,
    theme: 'light',
    repos: {
      [REPO]: { pool_size: 3, pool_fetch_interval_minutes: 15 },
    },
  });
  if (poolLifecycle !== undefined) {
    app.set('poolLifecycle', poolLifecycle);
  }
  app.use('/', worktreesRoutes);
  return app;
}

function seedWorktree(db, { id, prNumber, repository = REPO, branch = 'feature', path = `/tmp/wt/${id}` }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, prNumber, repository, branch, path, now, now);
}

function seedPoolEntry(db, { id, repository = REPO, path = `/tmp/wt/${id}`, status = 'available', prNumber = null }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worktree_pool (id, repository, path, status, current_pr_number, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, repository, path, status, prNumber, now);
}

// ============================================================================
// GET /api/repos/:owner/:repo/worktrees
// ============================================================================

describe('GET /api/repos/:owner/:repo/worktrees', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('returns pool config when pool_size is configured', async () => {
    const app = createApp(db);
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.pool).toEqual({
      configured: true,
      size: 3,
      fetch_interval_minutes: 15,
      current_count: 0,
    });
    expect(res.body.worktrees).toEqual([]);
  });

  it('returns pool config with configured=false when pool_size is 0', async () => {
    const config = {
      github_token: 'test-token',
      repos: { [REPO]: { pool_size: 0 } },
    };
    const app = createApp(db, { config });
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.pool.configured).toBe(false);
    expect(res.body.pool.size).toBe(0);
  });

  it('returns pool config with configured=false when no repo config exists', async () => {
    const config = { github_token: 'test-token' };
    const app = createApp(db, { config });
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.pool.configured).toBe(false);
    expect(res.body.pool.size).toBe(0);
    expect(res.body.pool.fetch_interval_minutes).toBeNull();
  });

  it('returns empty worktrees array when none exist', async () => {
    const app = createApp(db);
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.worktrees).toEqual([]);
  });

  it('returns merged list of pool and non-pool worktrees', async () => {
    seedWorktree(db, { id: 'wt-pool', prNumber: 1 });
    seedPoolEntry(db, { id: 'wt-pool', status: 'in_use', prNumber: 1 });
    seedWorktree(db, { id: 'wt-regular', prNumber: 2 });

    const app = createApp(db);
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.worktrees).toHaveLength(2);

    const poolWt = res.body.worktrees.find(w => w.id === 'wt-pool');
    const regularWt = res.body.worktrees.find(w => w.id === 'wt-regular');

    expect(poolWt).toBeDefined();
    expect(poolWt.is_pool).toBe(true);
    expect(poolWt.status).toBe('in_use');
    expect(poolWt.pr_number).toBe(1);

    expect(regularWt).toBeDefined();
    expect(regularWt.is_pool).toBe(false);
    expect(regularWt.status).toBe('active');
    expect(regularWt.pr_number).toBe(2);
  });

  it('returns correct is_pool and status fields', async () => {
    seedWorktree(db, { id: 'pool-avail', prNumber: 10 });
    seedPoolEntry(db, { id: 'pool-avail', status: 'available', prNumber: 10 });

    seedWorktree(db, { id: 'pool-switching', prNumber: 20 });
    seedPoolEntry(db, { id: 'pool-switching', status: 'switching', prNumber: 20 });

    seedWorktree(db, { id: 'non-pool', prNumber: 30 });

    const app = createApp(db);
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.worktrees).toHaveLength(3);

    const avail = res.body.worktrees.find(w => w.id === 'pool-avail');
    expect(avail.is_pool).toBe(true);
    expect(avail.status).toBe('available');

    const switching = res.body.worktrees.find(w => w.id === 'pool-switching');
    expect(switching.is_pool).toBe(true);
    expect(switching.status).toBe('switching');

    const nonPool = res.body.worktrees.find(w => w.id === 'non-pool');
    expect(nonPool.is_pool).toBe(false);
    expect(nonPool.status).toBe('active');
  });

  it('includes pool-only entries that have no worktrees record (creating placeholders)', async () => {
    seedPoolEntry(db, { id: 'creating-1', status: 'creating', prNumber: null });

    const app = createApp(db);
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.worktrees).toHaveLength(1);
    expect(res.body.worktrees[0].id).toBe('creating-1');
    expect(res.body.worktrees[0].is_pool).toBe(true);
    expect(res.body.worktrees[0].status).toBe('creating');
    expect(res.body.worktrees[0].branch).toBeNull();
  });

  it('reports current_count in pool section from pool entries', async () => {
    seedWorktree(db, { id: 'p1', prNumber: 1 });
    seedPoolEntry(db, { id: 'p1', status: 'in_use', prNumber: 1 });
    seedWorktree(db, { id: 'p2', prNumber: 2 });
    seedPoolEntry(db, { id: 'p2', status: 'available', prNumber: 2 });

    const app = createApp(db);
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.pool.current_count).toBe(2);
  });

  it('sets disk_exists to false when path does not exist on disk', async () => {
    seedWorktree(db, { id: 'wt-1', prNumber: 1, path: '/nonexistent/path' });

    const app = createApp(db);
    const res = await request(app).get('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.worktrees).toHaveLength(1);
    expect(res.body.worktrees[0].disk_exists).toBe(false);
  });
});

// ============================================================================
// DELETE /api/repos/:owner/:repo/worktrees/:worktreeId
// ============================================================================

describe('DELETE /api/repos/:owner/:repo/worktrees/:worktreeId', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('deletes a non-pool worktree and returns success', async () => {
    seedWorktree(db, { id: 'wt-1', prNumber: 1 });

    const app = createApp(db);
    const res = await request(app).delete('/api/repos/owner/repo/worktrees/wt-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('wt-1');

    // Verify worktree was actually removed from the database
    const row = db.prepare('SELECT id FROM worktrees WHERE id = ?').get('wt-1');
    expect(row).toBeUndefined();
  });

  it('calls cleanupWorktree on the path for non-pool worktrees', async () => {
    seedWorktree(db, { id: 'wt-1', prNumber: 1, path: '/tmp/wt/wt-1' });

    const app = createApp(db);
    await request(app).delete('/api/repos/owner/repo/worktrees/wt-1');

    expect(GitWorktreeManager.prototype.cleanupWorktree).toHaveBeenCalledWith('/tmp/wt/wt-1');
  });

  it('returns 404 for unknown worktree ID (non-pool)', async () => {
    const app = createApp(db);
    const res = await request(app).delete('/api/repos/owner/repo/worktrees/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  it('calls destroyPoolWorktree for pool worktrees', async () => {
    seedWorktree(db, { id: 'pool-wt', prNumber: 1 });
    seedPoolEntry(db, { id: 'pool-wt', status: 'available', prNumber: 1 });

    const destroyPoolWorktree = vi.fn().mockResolvedValue(undefined);
    const poolLifecycle = { destroyPoolWorktree };

    const app = createApp(db, { poolLifecycle });
    const res = await request(app).delete('/api/repos/owner/repo/worktrees/pool-wt');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(destroyPoolWorktree).toHaveBeenCalledWith('pool-wt', {
      cancelAnalyses: expect.any(Function),
    });
  });

  it('passes cancelAnalyses callback to destroyPoolWorktree', async () => {
    seedWorktree(db, { id: 'pool-wt', prNumber: 1 });
    seedPoolEntry(db, { id: 'pool-wt', status: 'in_use', prNumber: 1 });

    let capturedOptions;
    const destroyPoolWorktree = vi.fn().mockImplementation((_id, opts) => {
      capturedOptions = opts;
      return Promise.resolve();
    });
    const poolLifecycle = { destroyPoolWorktree };

    const app = createApp(db, { poolLifecycle });
    await request(app).delete('/api/repos/owner/repo/worktrees/pool-wt');

    expect(capturedOptions).toBeDefined();
    expect(typeof capturedOptions.cancelAnalyses).toBe('function');
  });

  it('returns 500 when poolLifecycle is not available for pool worktree', async () => {
    seedWorktree(db, { id: 'pool-wt', prNumber: 1 });
    seedPoolEntry(db, { id: 'pool-wt', status: 'available', prNumber: 1 });

    // No poolLifecycle set on app
    const app = createApp(db);
    const res = await request(app).delete('/api/repos/owner/repo/worktrees/pool-wt');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Pool lifecycle not available');
  });
});

// ============================================================================
// DELETE /api/repos/:owner/:repo/worktrees (delete all)
// ============================================================================

describe('DELETE /api/repos/:owner/:repo/worktrees', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('deletes all worktrees for a repository', async () => {
    seedWorktree(db, { id: 'wt-1', prNumber: 1 });
    seedWorktree(db, { id: 'wt-2', prNumber: 2 });
    // A worktree for a different repo — should not be deleted
    seedWorktree(db, { id: 'wt-other', prNumber: 3, repository: 'other/repo' });

    const app = createApp(db);
    const res = await request(app).delete('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deleted).toBe(2);
    expect(res.body.failed).toBe(0);
    expect(res.body.errors).toEqual([]);

    // Verify the 'other/repo' worktree is still there
    const otherRow = db.prepare('SELECT id FROM worktrees WHERE id = ?').get('wt-other');
    expect(otherRow).toBeDefined();

    // Verify the 'owner/repo' worktrees are gone
    const rows = db.prepare('SELECT id FROM worktrees WHERE repository = ?').all(REPO);
    expect(rows).toHaveLength(0);
  });

  it('returns success with 0 deleted when no worktrees exist', async () => {
    const app = createApp(db);
    const res = await request(app).delete('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deleted).toBe(0);
    expect(res.body.failed).toBe(0);
    expect(res.body.errors).toEqual([]);
  });

  it('returns { deleted, failed, errors } counts', async () => {
    seedWorktree(db, { id: 'wt-1', prNumber: 1 });
    seedWorktree(db, { id: 'wt-2', prNumber: 2 });

    const app = createApp(db);
    const res = await request(app).delete('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deleted');
    expect(res.body).toHaveProperty('failed');
    expect(res.body).toHaveProperty('errors');
    expect(typeof res.body.deleted).toBe('number');
    expect(typeof res.body.failed).toBe('number');
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('calls destroyPoolWorktree for pool worktrees in the list', async () => {
    seedWorktree(db, { id: 'pool-1', prNumber: 1 });
    seedPoolEntry(db, { id: 'pool-1', status: 'available', prNumber: 1 });
    seedWorktree(db, { id: 'regular-1', prNumber: 2 });

    const destroyPoolWorktree = vi.fn().mockResolvedValue(undefined);
    const poolLifecycle = { destroyPoolWorktree };

    const app = createApp(db, { poolLifecycle });
    const res = await request(app).delete('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(destroyPoolWorktree).toHaveBeenCalledWith('pool-1', {
      cancelAnalyses: expect.any(Function),
    });
  });

  it('handles pool-only entries that have no worktrees record', async () => {
    seedPoolEntry(db, { id: 'creating-only', status: 'creating', prNumber: null });

    const destroyPoolWorktree = vi.fn().mockResolvedValue(undefined);
    const poolLifecycle = { destroyPoolWorktree };

    const app = createApp(db, { poolLifecycle });
    const res = await request(app).delete('/api/repos/owner/repo/worktrees');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(destroyPoolWorktree).toHaveBeenCalledWith('creating-only', {
      cancelAnalyses: expect.any(Function),
    });
  });
});
