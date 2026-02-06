// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

// CommonJS require() is used here (instead of ESM import) because:
// 1. vi.spyOn(fs, 'access') must be set up BEFORE the route module is loaded,
//    and ESM static imports are hoisted above any runtime statements.
// 2. require() is evaluated in order, giving us control over mock timing.
const { run } = require('../../src/database.js');

// Mock fs.access to simulate worktree path existence checks
const fs = require('fs').promises;
vi.spyOn(fs, 'access').mockResolvedValue(undefined);

// Load the worktrees route module (after fs mock is in place)
const worktreesRoutes = require('../../src/routes/worktrees');

/**
 * Create a minimal test Express app with just worktree routes
 */
function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('config', { github_token: 'test-token' });
  app.use('/', worktreesRoutes);
  return app;
}

/**
 * Insert a worktree with associated pr_metadata into the test database.
 *
 * @param {object} db - Database instance
 * @param {object} opts
 * @param {string} opts.id          - Worktree ID (unique)
 * @param {number} opts.prNumber    - PR number
 * @param {string} opts.repository  - owner/repo
 * @param {string} opts.title       - PR title
 * @param {string} opts.author      - PR author
 * @param {string} opts.accessedAt  - ISO date for last_accessed_at
 * @param {string} [opts.branch]    - Branch name (default: 'feature')
 * @param {string} [opts.path]      - Worktree filesystem path
 */
async function insertWorktree(db, { id, prNumber, repository, title, author, accessedAt, branch = 'feature', path = '/tmp/wt' }) {
  const createdAt = accessedAt; // simplify: same as accessed

  await run(db, `
    INSERT OR IGNORE INTO pr_metadata (pr_number, repository, title, author, base_branch, head_branch)
    VALUES (?, ?, ?, ?, 'main', ?)
  `, [prNumber, repository, title, author, branch]);

  await run(db, `
    INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, prNumber, repository, branch, path, createdAt, accessedAt]);
}

// ============================================================================
// GET /api/worktrees/recent — Pagination Tests
// ============================================================================

describe('GET /api/worktrees/recent — pagination', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    closeTestDatabase(db);
    vi.restoreAllMocks();
    // Re-apply the fs.access mock for the next test (restoreAllMocks clears it)
    vi.spyOn(fs, 'access').mockResolvedValue(undefined);
  });

  it('should return hasMore=false when total worktrees fit in one page', async () => {
    // Insert 3 worktrees, request with limit=10 (default)
    for (let i = 1; i <= 3; i++) {
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title: `PR ${i}`,
        author: 'user',
        accessedAt: new Date(Date.now() - i * 60000).toISOString()
      });
    }

    const res = await request(app).get('/api/worktrees/recent?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.worktrees).toHaveLength(3);
    expect(res.body.hasMore).toBe(false);
  });

  it('should return hasMore=true when more worktrees exist beyond the limit', async () => {
    // Insert 5 worktrees, request limit=3
    for (let i = 1; i <= 5; i++) {
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title: `PR ${i}`,
        author: 'user',
        accessedAt: new Date(Date.now() - i * 60000).toISOString()
      });
    }

    const res = await request(app).get('/api/worktrees/recent?limit=3');

    expect(res.status).toBe(200);
    expect(res.body.worktrees).toHaveLength(3);
    expect(res.body.hasMore).toBe(true);
  });

  it('should paginate correctly using cursor-based before parameter', async () => {
    // Insert 5 worktrees with descending access times
    for (let i = 1; i <= 5; i++) {
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title: `PR ${i}`,
        author: 'user',
        // Most recent first: wt-1 is newest
        accessedAt: new Date(Date.now() - i * 60000).toISOString()
      });
    }

    // Page 1: no cursor (initial load), limit=2
    const page1 = await request(app).get('/api/worktrees/recent?limit=2');
    expect(page1.body.worktrees).toHaveLength(2);
    expect(page1.body.worktrees[0].pr_number).toBe(1); // Most recent
    expect(page1.body.worktrees[1].pr_number).toBe(2);
    expect(page1.body.hasMore).toBe(true);

    // Page 2: use last item's timestamp as cursor
    const cursor1 = page1.body.worktrees[1].last_accessed_at;
    const page2 = await request(app).get(`/api/worktrees/recent?limit=2&before=${encodeURIComponent(cursor1)}`);
    expect(page2.body.worktrees).toHaveLength(2);
    expect(page2.body.worktrees[0].pr_number).toBe(3);
    expect(page2.body.worktrees[1].pr_number).toBe(4);
    expect(page2.body.hasMore).toBe(true);

    // Page 3: use last item's timestamp as cursor
    const cursor2 = page2.body.worktrees[1].last_accessed_at;
    const page3 = await request(app).get(`/api/worktrees/recent?limit=2&before=${encodeURIComponent(cursor2)}`);
    expect(page3.body.worktrees).toHaveLength(1);
    expect(page3.body.worktrees[0].pr_number).toBe(5);
    expect(page3.body.hasMore).toBe(false);
  });

  it('should return empty array when cursor is older than all entries', async () => {
    await insertWorktree(db, {
      id: 'wt-1',
      prNumber: 1,
      repository: 'owner/repo',
      title: 'PR 1',
      author: 'user',
      accessedAt: new Date().toISOString()
    });

    // Use a very old cursor that predates all entries
    const oldCursor = new Date('2000-01-01T00:00:00.000Z').toISOString();
    const res = await request(app).get(`/api/worktrees/recent?limit=10&before=${encodeURIComponent(oldCursor)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.worktrees).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('should return results from the top when no cursor is provided', async () => {
    for (let i = 1; i <= 3; i++) {
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title: `PR ${i}`,
        author: 'user',
        accessedAt: new Date(Date.now() - i * 60000).toISOString()
      });
    }

    const res = await request(app).get('/api/worktrees/recent?limit=2');

    expect(res.body.worktrees).toHaveLength(2);
    expect(res.body.worktrees[0].pr_number).toBe(1); // Most recent
    expect(res.body.hasMore).toBe(true);
  });

  it('should filter stale worktrees and still paginate correctly', async () => {
    // Insert 4 worktrees: 2 valid, 2 with corrupted data (unknown branch)
    for (let i = 1; i <= 4; i++) {
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title: `PR ${i}`,
        author: 'user',
        accessedAt: new Date(Date.now() - i * 60000).toISOString(),
        // Make wt-2 and wt-4 stale by giving them 'unknown' branch
        branch: (i % 2 === 0) ? 'unknown' : 'feature'
      });
    }

    // Request limit=1 — should get wt-1 (wt-2 is stale)
    const page1 = await request(app).get('/api/worktrees/recent?limit=1');
    expect(page1.body.worktrees).toHaveLength(1);
    expect(page1.body.worktrees[0].pr_number).toBe(1);
    expect(page1.body.hasMore).toBe(true);

    // Page 2: cursor from page 1 — should get wt-3 (wt-4 is stale)
    const cursor = page1.body.worktrees[0].last_accessed_at;
    const page2 = await request(app).get(`/api/worktrees/recent?limit=1&before=${encodeURIComponent(cursor)}`);
    expect(page2.body.worktrees).toHaveLength(1);
    expect(page2.body.worktrees[0].pr_number).toBe(3);
    expect(page2.body.hasMore).toBe(false);
  });

  it('should return hasMore in response even for empty results', async () => {
    const res = await request(app).get('/api/worktrees/recent?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.worktrees).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('should respect the limit cap of 50', async () => {
    // Insert 5 worktrees
    for (let i = 1; i <= 5; i++) {
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title: `PR ${i}`,
        author: 'user',
        accessedAt: new Date(Date.now() - i * 60000).toISOString()
      });
    }

    // Request with limit=100 (should be capped at 50, but only 5 exist)
    const res = await request(app).get('/api/worktrees/recent?limit=100');
    expect(res.body.worktrees).toHaveLength(5);
    expect(res.body.hasMore).toBe(false);
  });

  it('should filter out worktrees whose paths no longer exist on the filesystem', async () => {
    // Insert 4 worktrees: 2 with accessible paths, 2 with stale paths
    for (let i = 1; i <= 4; i++) {
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title: `PR ${i}`,
        author: 'user',
        accessedAt: new Date(Date.now() - i * 60000).toISOString(),
        // Mark wt-2 and wt-4 as stale via their path
        path: (i % 2 === 0) ? `/tmp/stale-wt-${i}` : `/tmp/wt-${i}`
      });
    }

    // Override fs.access to reject paths containing 'stale'
    vi.restoreAllMocks();
    vi.spyOn(fs, 'access').mockImplementation(path =>
      path.includes('stale') ? Promise.reject(new Error('ENOENT')) : Promise.resolve()
    );

    const res = await request(app).get('/api/worktrees/recent?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Only wt-1 and wt-3 should survive (wt-2 and wt-4 have stale paths)
    expect(res.body.worktrees).toHaveLength(2);
    expect(res.body.worktrees[0].pr_number).toBe(1);
    expect(res.body.worktrees[1].pr_number).toBe(3);
    expect(res.body.hasMore).toBe(false);
  });

  it('should correctly paginate when fs.access filters out stale filesystem entries', async () => {
    // Insert 5 worktrees: wt-2 and wt-4 have stale filesystem paths
    for (let i = 1; i <= 5; i++) {
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title: `PR ${i}`,
        author: 'user',
        accessedAt: new Date(Date.now() - i * 60000).toISOString(),
        path: (i % 2 === 0) ? `/tmp/stale-wt-${i}` : `/tmp/wt-${i}`
      });
    }

    // Override fs.access to reject paths containing 'stale'
    vi.restoreAllMocks();
    vi.spyOn(fs, 'access').mockImplementation(path =>
      path.includes('stale') ? Promise.reject(new Error('ENOENT')) : Promise.resolve()
    );

    // Page 1: limit=2 — should get wt-1 and wt-3 (wt-2 filtered out by fs.access)
    const page1 = await request(app).get('/api/worktrees/recent?limit=2');
    expect(page1.body.worktrees).toHaveLength(2);
    expect(page1.body.worktrees[0].pr_number).toBe(1);
    expect(page1.body.worktrees[1].pr_number).toBe(3);
    expect(page1.body.hasMore).toBe(true);

    // Page 2: cursor from page 1 — should get wt-5 (wt-4 filtered out by fs.access)
    const cursor = page1.body.worktrees[1].last_accessed_at;
    const page2 = await request(app).get(`/api/worktrees/recent?limit=2&before=${encodeURIComponent(cursor)}`);
    expect(page2.body.worktrees).toHaveLength(1);
    expect(page2.body.worktrees[0].pr_number).toBe(5);
    expect(page2.body.hasMore).toBe(false);
  });
});
