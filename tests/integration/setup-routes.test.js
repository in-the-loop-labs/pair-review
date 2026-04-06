// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

// Mock config to provide a GitHub token without requiring real credentials
const configModule = require('../../src/config');
vi.spyOn(configModule, 'getGitHubToken');

// Mock setupPRReview to prevent real git operations
const prSetupModule = require('../../src/setup/pr-setup');
vi.spyOn(prSetupModule, 'setupPRReview');

// Now load the route (after spies are in place)
const express = require('express');
const request = require('supertest');
const setupRoutes = require('../../src/routes/setup');
const { WorktreePoolRepository } = require('../../src/database');

function createApp(db, config = { github_token: 'test-token' }, { withPool = false } = {}) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('config', config);
  if (withPool) {
    app.set('poolLifecycle', { poolRepo: new WorktreePoolRepository(db) });
  }
  app.use(setupRoutes);
  return app;
}

/** Seed a pr_metadata row for test assertions. */
function seedPRMetadata(db, { prNumber = 42, repository = 'owner/repo' } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO pr_metadata (pr_number, repository, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(prNumber, repository, 'Test PR', now, now);
}

/** Seed a worktrees row for test assertions. */
function seedWorktree(db, { id = 'wt-abc', prNumber = 42, repository = 'owner/repo', branch = 'main', path = '/tmp/wt-abc' } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, prNumber, repository, branch, path, now, now);
}

/** Seed a worktree_pool entry. */
function seedPoolEntry(db, { id = 'wt-abc', repository = 'owner/repo', path = '/tmp/wt-abc', status = 'in_use', prNumber = 42 } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO worktree_pool (id, repository, path, status, current_pr_number, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, repository, path, status, prNumber, now);
}

describe('POST /api/setup/pr/:owner/:repo/:number', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
    vi.clearAllMocks();
    configModule.getGitHubToken.mockReturnValue('test-token');
    // Default: setupPRReview resolves (should only be called when fast path is skipped)
    prSetupModule.setupPRReview.mockResolvedValue({ reviewUrl: '/pr/owner/repo/42', title: 'Test PR' });
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('returns existing: true when worktree exists and is NOT a pool worktree', async () => {
    seedPRMetadata(db);
    seedWorktree(db);
    // No pool entry — this is a traditional (non-pool) worktree

    const app = createApp(db);
    const res = await request(app).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
    expect(res.body.reviewUrl).toBe('/pr/owner/repo/42');
  });

  it('returns existing: true when worktree is a pool worktree with in_use status', async () => {
    seedPRMetadata(db);
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'in_use' });

    const app = createApp(db, undefined, { withPool: true });
    const res = await request(app).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
    expect(res.body.reviewUrl).toBe('/pr/owner/repo/42');
  });

  it('reclaims pool worktree when available but still associated with the same PR', async () => {
    seedPRMetadata(db);
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'available', prNumber: 42 });

    const app = createApp(db, undefined, { withPool: true });
    const res = await request(app).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
    expect(res.body.reviewUrl).toBe('/pr/owner/repo/42');
    // Pool entry should be reclaimed as in_use
    const poolEntry = db.prepare('SELECT status, current_review_id FROM worktree_pool WHERE id = ?').get('pool-abc');
    expect(poolEntry.status).toBe('in_use');
    expect(poolEntry.current_review_id).toBeTruthy();
  });

  it('falls through to setup when pool worktree was reassigned to a different PR', async () => {
    seedPRMetadata(db);
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'available', prNumber: 99 });

    const app = createApp(db, undefined, { withPool: true });
    const res = await request(app).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();
  });

  it('falls through to setup when pool worktree has switching status', async () => {
    seedPRMetadata(db);
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'switching' });

    const app = createApp(db, undefined, { withPool: true });
    const res = await request(app).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();
  });

  it('falls through to setup when worktree row is missing (metadata only)', async () => {
    seedPRMetadata(db);
    // No worktree row seeded

    const app = createApp(db);
    const res = await request(app).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();
  });
});
