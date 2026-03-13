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
 * Insert a pr_metadata record with an associated worktree into the test database.
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
 * @param {object} [opts.prData]    - PR data JSON (stored in pr_metadata.pr_data)
 */
async function insertWorktree(db, { id, prNumber, repository, title, author, accessedAt, branch = 'feature', path = '/tmp/wt', prData = null }) {
  const createdAt = accessedAt; // simplify: same as accessed

  await run(db, `
    INSERT OR IGNORE INTO pr_metadata (pr_number, repository, title, author, base_branch, head_branch, last_accessed_at, pr_data)
    VALUES (?, ?, ?, ?, 'main', ?, ?, ?)
  `, [prNumber, repository, title, author, branch, accessedAt, prData ? JSON.stringify(prData) : null]);

  await run(db, `
    INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, prNumber, repository, branch, path, createdAt, accessedAt]);
}

/**
 * Insert a pr_metadata record WITHOUT a worktree (for testing cached entries).
 *
 * @param {object} db - Database instance
 * @param {object} opts
 * @param {number} opts.prNumber    - PR number
 * @param {string} opts.repository  - owner/repo
 * @param {string} opts.title       - PR title
 * @param {string} opts.author      - PR author
 * @param {string} opts.accessedAt  - ISO date for last_accessed_at
 * @param {string} [opts.branch]    - Branch name (default: 'feature')
 */
async function insertPRMetadata(db, { prNumber, repository, title, author, accessedAt, branch = 'feature' }) {
  await run(db, `
    INSERT OR IGNORE INTO pr_metadata (pr_number, repository, title, author, base_branch, head_branch, last_accessed_at)
    VALUES (?, ?, ?, ?, 'main', ?, ?)
  `, [prNumber, repository, title, author, branch, accessedAt]);
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

  it('should return hasMore=false when total reviews fit in one page', async () => {
    // Insert 3 reviews, request with limit=10 (default)
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
    expect(res.body.reviews).toHaveLength(3);
    expect(res.body.hasMore).toBe(false);
  });

  it('should return hasMore=true when more reviews exist beyond the limit', async () => {
    // Insert 5 reviews, request limit=3
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
    expect(res.body.reviews).toHaveLength(3);
    expect(res.body.hasMore).toBe(true);
  });

  it('should paginate correctly using cursor-based before parameter', async () => {
    // Insert 5 reviews with descending access times
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
    expect(page1.body.reviews).toHaveLength(2);
    expect(page1.body.reviews[0].pr_number).toBe(1); // Most recent
    expect(page1.body.reviews[1].pr_number).toBe(2);
    expect(page1.body.hasMore).toBe(true);

    // Page 2: use last item's timestamp as cursor
    const cursor1 = page1.body.reviews[1].last_accessed_at;
    const page2 = await request(app).get(`/api/worktrees/recent?limit=2&before=${encodeURIComponent(cursor1)}`);
    expect(page2.body.reviews).toHaveLength(2);
    expect(page2.body.reviews[0].pr_number).toBe(3);
    expect(page2.body.reviews[1].pr_number).toBe(4);
    expect(page2.body.hasMore).toBe(true);

    // Page 3: use last item's timestamp as cursor
    const cursor2 = page2.body.reviews[1].last_accessed_at;
    const page3 = await request(app).get(`/api/worktrees/recent?limit=2&before=${encodeURIComponent(cursor2)}`);
    expect(page3.body.reviews).toHaveLength(1);
    expect(page3.body.reviews[0].pr_number).toBe(5);
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
    expect(res.body.reviews).toHaveLength(0);
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

    expect(res.body.reviews).toHaveLength(2);
    expect(res.body.reviews[0].pr_number).toBe(1); // Most recent
    expect(res.body.hasMore).toBe(true);
  });

  it('should exclude pr_metadata entries with empty or null title', async () => {
    // Insert 4 entries: 2 with valid titles, 2 with empty/null titles
    for (let i = 1; i <= 4; i++) {
      const title = (i % 2 === 0) ? '' : `PR ${i}`;
      await insertWorktree(db, {
        id: `wt-${i}`,
        prNumber: i,
        repository: 'owner/repo',
        title,
        author: 'user',
        accessedAt: new Date(Date.now() - i * 60000).toISOString()
      });
    }

    // Also insert one with NULL title directly
    await run(db, `
      INSERT OR IGNORE INTO pr_metadata (pr_number, repository, title, author, base_branch, head_branch, last_accessed_at)
      VALUES (?, ?, NULL, ?, 'main', 'feature', ?)
    `, [5, 'owner/repo', 'user', new Date(Date.now() - 5 * 60000).toISOString()]);

    // Request all — should only get PR 1 and PR 3 (the ones with valid titles)
    const res = await request(app).get('/api/worktrees/recent?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(2);
    expect(res.body.reviews[0].pr_number).toBe(1);
    expect(res.body.reviews[1].pr_number).toBe(3);
    expect(res.body.hasMore).toBe(false);
  });

  it('should return hasMore in response even for empty results', async () => {
    const res = await request(app).get('/api/worktrees/recent?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reviews).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('should respect the limit cap of 50', async () => {
    // Insert 5 reviews
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
    expect(res.body.reviews).toHaveLength(5);
    expect(res.body.hasMore).toBe(false);
  });

  it('should show entries with missing worktree paths as cached instead of filtering them', async () => {
    // Insert 4 entries: 2 with accessible paths, 2 with stale paths
    for (let i = 1; i <= 4; i++) {
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

    const res = await request(app).get('/api/worktrees/recent?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // All 4 entries should appear (stale paths are no longer filtered out)
    expect(res.body.reviews).toHaveLength(4);
    expect(res.body.reviews[0].pr_number).toBe(1);
    expect(res.body.reviews[0].storage_status).toBe('local');
    expect(res.body.reviews[1].pr_number).toBe(2);
    expect(res.body.reviews[1].storage_status).toBe('cached');
    expect(res.body.reviews[2].pr_number).toBe(3);
    expect(res.body.reviews[2].storage_status).toBe('local');
    expect(res.body.reviews[3].pr_number).toBe(4);
    expect(res.body.reviews[3].storage_status).toBe('cached');
    expect(res.body.hasMore).toBe(false);
  });

  it('should paginate correctly with storage_status set for each entry', async () => {
    // Insert 5 entries: wt-2 and wt-4 have stale filesystem paths
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

    // Page 1: limit=3 — all 3 entries appear with correct storage_status
    const page1 = await request(app).get('/api/worktrees/recent?limit=3');
    expect(page1.body.reviews).toHaveLength(3);
    expect(page1.body.reviews[0].pr_number).toBe(1);
    expect(page1.body.reviews[0].storage_status).toBe('local');
    expect(page1.body.reviews[1].pr_number).toBe(2);
    expect(page1.body.reviews[1].storage_status).toBe('cached');
    expect(page1.body.reviews[2].pr_number).toBe(3);
    expect(page1.body.reviews[2].storage_status).toBe('local');
    expect(page1.body.hasMore).toBe(true);

    // Page 2: cursor from page 1 — remaining 2 entries
    const cursor = page1.body.reviews[2].last_accessed_at;
    const page2 = await request(app).get(`/api/worktrees/recent?limit=3&before=${encodeURIComponent(cursor)}`);
    expect(page2.body.reviews).toHaveLength(2);
    expect(page2.body.reviews[0].pr_number).toBe(4);
    expect(page2.body.reviews[0].storage_status).toBe('cached');
    expect(page2.body.reviews[1].pr_number).toBe(5);
    expect(page2.body.reviews[1].storage_status).toBe('local');
    expect(page2.body.hasMore).toBe(false);
  });

  it('should list pr_metadata entries without worktrees as cached', async () => {
    // Insert 2 entries with worktrees and 2 as pr_metadata only (no worktree)
    await insertWorktree(db, {
      id: 'wt-1',
      prNumber: 1,
      repository: 'owner/repo',
      title: 'PR with worktree 1',
      author: 'user',
      accessedAt: new Date(Date.now() - 1 * 60000).toISOString()
    });

    await insertPRMetadata(db, {
      prNumber: 2,
      repository: 'owner/repo',
      title: 'PR cached only 2',
      author: 'user',
      accessedAt: new Date(Date.now() - 2 * 60000).toISOString()
    });

    await insertWorktree(db, {
      id: 'wt-3',
      prNumber: 3,
      repository: 'owner/repo',
      title: 'PR with worktree 3',
      author: 'user',
      accessedAt: new Date(Date.now() - 3 * 60000).toISOString()
    });

    await insertPRMetadata(db, {
      prNumber: 4,
      repository: 'owner/repo',
      title: 'PR cached only 4',
      author: 'user',
      accessedAt: new Date(Date.now() - 4 * 60000).toISOString()
    });

    const res = await request(app).get('/api/worktrees/recent?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reviews).toHaveLength(4);

    // PR 1: has worktree, fs.access passes → local
    expect(res.body.reviews[0].pr_number).toBe(1);
    expect(res.body.reviews[0].storage_status).toBe('local');
    expect(res.body.reviews[0].pr_title).toBe('PR with worktree 1');

    // PR 2: no worktree record → cached
    expect(res.body.reviews[1].pr_number).toBe(2);
    expect(res.body.reviews[1].storage_status).toBe('cached');
    expect(res.body.reviews[1].pr_title).toBe('PR cached only 2');

    // PR 3: has worktree, fs.access passes → local
    expect(res.body.reviews[2].pr_number).toBe(3);
    expect(res.body.reviews[2].storage_status).toBe('local');

    // PR 4: no worktree record → cached
    expect(res.body.reviews[3].pr_number).toBe(4);
    expect(res.body.reviews[3].storage_status).toBe('cached');

    expect(res.body.hasMore).toBe(false);
  });

  it('should include html_url from pr_data in the response', async () => {
    const htmlUrl = 'https://github.com/owner/repo/pull/42';
    await insertWorktree(db, {
      id: 'wt-with-url',
      prNumber: 42,
      repository: 'owner/repo',
      title: 'PR with html_url',
      author: 'user',
      accessedAt: new Date().toISOString(),
      prData: { html_url: htmlUrl }
    });

    const res = await request(app).get('/api/worktrees/recent?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].html_url).toBe(htmlUrl);
  });

  it('should return html_url as null when pr_data has no html_url', async () => {
    await insertWorktree(db, {
      id: 'wt-no-url',
      prNumber: 43,
      repository: 'owner/repo',
      title: 'PR without html_url',
      author: 'user',
      accessedAt: new Date().toISOString(),
      prData: { some_field: 'value' }
    });

    const res = await request(app).get('/api/worktrees/recent?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].html_url).toBeNull();
  });
});
