// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

// Mock config to provide a GitHub token without requiring real credentials
const configModule = require('../../src/config');
vi.spyOn(configModule, 'getGitHubToken');

// Mock setupPRReview to prevent real git operations
const prSetupModule = require('../../src/setup/pr-setup');
vi.spyOn(prSetupModule, 'setupPRReview');
const localSetupModule = require('../../src/setup/local-setup');
vi.spyOn(localSetupModule, 'setupLocalReview');

// Now load the route (after spies are in place)
const express = require('express');
const request = require('supertest');
const setupRoutes = require('../../src/routes/setup');
const { WorktreePoolRepository } = require('../../src/database');
const { activeSetups } = require('../../src/routes/shared');

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
  let server;

  beforeEach(() => {
    db = createTestDatabase();
    activeSetups.clear();
    vi.clearAllMocks();
    configModule.getGitHubToken.mockReturnValue('test-token');
    // Default: setupPRReview resolves (should only be called when fast path is skipped)
    prSetupModule.setupPRReview.mockResolvedValue({ reviewUrl: '/pr/owner/repo/42', title: 'Test PR' });
    localSetupModule.setupLocalReview.mockResolvedValue({
      reviewUrl: '/local/1',
      reviewId: 1,
      existing: false,
      branch: 'main',
      repository: 'owner/repo'
    });
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    activeSetups.clear();
    closeTestDatabase(db);
  });

  it('returns existing: true when worktree exists and is NOT a pool worktree', async () => {
    seedPRMetadata(db);
    seedWorktree(db);
    // No pool entry — this is a traditional (non-pool) worktree

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
    expect(res.body.reviewUrl).toBe('/pr/owner/repo/42');
  });

  it('returns existing: true when worktree is a pool worktree with in_use status', async () => {
    seedPRMetadata(db);
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'in_use' });

    const app = createApp(db, undefined, { withPool: true });
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
    expect(res.body.reviewUrl).toBe('/pr/owner/repo/42');
  });

  it('reclaims pool worktree when available but still associated with the same PR', async () => {
    seedPRMetadata(db);
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'available', prNumber: 42 });

    const app = createApp(db, undefined, { withPool: true });
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

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
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();
  });

  it('falls through to setup when pool worktree has switching status', async () => {
    seedPRMetadata(db);
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'switching' });

    const app = createApp(db, undefined, { withPool: true });
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();
  });

  it('falls through to setup when worktree row is missing (metadata only)', async () => {
    seedPRMetadata(db);
    // No worktree row seeded

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();
  });

  it('passes restoreMetadata to setupPRReview when pr_data has head_sha', async () => {
    // Seed PR metadata WITH pr_data containing head_sha
    const now = new Date().toISOString();
    const prDataJson = JSON.stringify({ title: 'Test PR', head_sha: 'abc123', head_branch: 'feature' });
    db.prepare(
      'INSERT INTO pr_metadata (pr_number, repository, title, pr_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(42, 'owner/repo', 'Test PR', prDataJson, now, now);
    // No worktree row — forces setup to run

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.setupId).toBeTruthy();

    // Verify setupPRReview was called with restoreMetadata
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.restoreMetadata).toBeTruthy();
    expect(callArgs.restoreMetadata.head_sha).toBe('abc123');
  });

  it('passes null restoreMetadata when pr_data lacks head_sha', async () => {
    // Seed PR metadata with pr_data that has no head_sha
    const now = new Date().toISOString();
    const prDataJson = JSON.stringify({ title: 'Test PR', body: 'no sha here' });
    db.prepare(
      'INSERT INTO pr_metadata (pr_number, repository, title, pr_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(42, 'owner/repo', 'Test PR', prDataJson, now, now);

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.setupId).toBeTruthy();

    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.restoreMetadata).toBeNull();
  });

  it('passes null restoreMetadata when no existing PR metadata', async () => {
    // No PR metadata seeded at all

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.setupId).toBeTruthy();

    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.restoreMetadata).toBeNull();
  });

  it('passes a body host through to setupPRReview', async () => {
    // The repo must actually declare this api_host — the credential gate now
    // resolves the token against the body host, which validates it against config.
    const app = createApp(db, {
      repos: { 'owner/repo': { api_host: 'https://althost.example/api/v3', exclusive: false, token: 'alt-tok' } }
    });
    server = await listenOnLoopback(app);
    const res = await request(server)
      .post('/api/setup/pr/owner/repo/42')
      .send({ host: 'https://althost.example/api/v3' });

    expect(res.status).toBe(200);
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    expect(prSetupModule.setupPRReview.mock.calls[0][0].host).toBe('https://althost.example/api/v3');
  });

  it('passes an explicit body host of null through to setupPRReview', async () => {
    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server)
      .post('/api/setup/pr/owner/repo/42')
      .send({ host: null });

    expect(res.status).toBe(200);
    expect(prSetupModule.setupPRReview.mock.calls[0][0].host).toBe(null);
  });

  it('leaves host undefined when no body host is supplied', async () => {
    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(prSetupModule.setupPRReview.mock.calls[0][0].host).toBeUndefined();
  });

  it('rejects an invalid host shape with 400 and does not start setup', async () => {
    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server)
      .post('/api/setup/pr/owner/repo/42')
      .send({ host: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid host/);
    expect(prSetupModule.setupPRReview).not.toHaveBeenCalled();
  });

  // FINDING 3: the credential gate must not falsely 401 a dual repo whose only
  // credential is the alt-host token. getGitHubToken (no host) returns empty for
  // such a repo; the route re-resolves via resolvePreflightBinding before 401ing.
  describe('dual-repo alt-only credential gate', () => {
    let savedEnvToken;
    const dualAltOnly = {
      repos: { 'owner/repo': { api_host: 'https://alt.example/api/v3', exclusive: false, token: 'alt-tok' } }
    };

    beforeEach(() => {
      // getGitHubToken (no host) resolves the github ambiguity binding → empty
      // for an alt-only dual repo. Force that so the extended path is exercised.
      configModule.getGitHubToken.mockReturnValue('');
      savedEnvToken = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN; // else the github chain short-circuits
    });
    afterEach(() => {
      if (savedEnvToken !== undefined) process.env.GITHUB_TOKEN = savedEnvToken;
    });

    it('alt bodyHost + alt-only token → passes the gate (no 401)', async () => {
      const app = createApp(db, dualAltOnly);
      server = await listenOnLoopback(app);
      const res = await request(server)
        .post('/api/setup/pr/owner/repo/42')
        .send({ host: 'https://alt.example/api/v3' });

      expect(res.status).toBe(200);
      expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    });

    it('no host + dual repo + alt-only token → passes the gate to the probe (no 401)', async () => {
      const app = createApp(db, dualAltOnly);
      server = await listenOnLoopback(app);
      const res = await request(server).post('/api/setup/pr/owner/repo/42');

      expect(res.status).toBe(200);
      expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    });

    it('no host + dual repo + NO token → still 401s', async () => {
      const app = createApp(db, {
        repos: { 'owner/repo': { api_host: 'https://alt.example/api/v3', exclusive: false } }
      });
      server = await listenOnLoopback(app);
      const res = await request(server).post('/api/setup/pr/owner/repo/42');

      expect(res.status).toBe(401);
      expect(prSetupModule.setupPRReview).not.toHaveBeenCalled();
    });
  });

  it('resolves the binding key for a monorepo url_pattern config and feeds it downstream', async () => {
    // Config has one `repos[...]` entry whose url_pattern captures
    // many owner/repo pairs. The route must resolve the token against the
    // BINDING KEY ("acme-monorepo"), not the captured "acme/widget-a".
    const monorepoConfig = {
      repos: {
        'acme-monorepo': {
          api_host: 'https://ghe.acme.example/api/v3',
          token: 'acme-monorepo-secret',
          url_pattern: '^https://ghe\\.acme\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)$',
          features: { stack_walker: 'rest', pending_review_check: 'rest', review_lifecycle: 'rest', pending_review_comments: 'host' }
        }
      }
    };

    const app = createApp(db, monorepoConfig);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/acme/widget-a/7');

    // The gate resolves the alt token for the binding key (not 401), and the
    // binding key is threaded to setupPRReview for downstream config lookups
    // (path, pool, reset_script). bindingRepository being the key (not the
    // captured PR identity) is the invariant this test protects.
    expect(res.status).toBe(200);
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.bindingRepository).toBe('acme-monorepo');
  });

  it('falls back to PR identity when no url_pattern matches (negative case)', async () => {
    const plainConfig = { github_token: 'test-token', repos: {} };
    const app = createApp(db, plainConfig);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/alice/tool/3');

    expect(res.status).toBe(200);
    // Binding key = "alice/tool" (the PR identity) when nothing matched.
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.bindingRepository).toBe('alice/tool');
  });
});

describe('POST /api/setup/local', () => {
  let db;
  let server;

  beforeEach(() => {
    db = createTestDatabase();
    activeSetups.clear();
    vi.clearAllMocks();
    localSetupModule.setupLocalReview.mockResolvedValue({
      reviewUrl: '/local/1',
      reviewId: 1,
      existing: false,
      branch: 'main',
      repository: 'owner/repo'
    });
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    activeSetups.clear();
    closeTestDatabase(db);
  });

  it('returns 400 immediately when local path is a URL', async () => {
    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server)
      .post('/api/setup/local')
      .send({ path: 'https://github.com/owner/repo/pull/123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('filesystem path');
    expect(res.body.setupId).toBeUndefined();
    expect(activeSetups.size).toBe(0);
    expect(localSetupModule.setupLocalReview).not.toHaveBeenCalled();
  });
});
