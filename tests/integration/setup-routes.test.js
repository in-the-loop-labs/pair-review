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
const logger = require('../../src/utils/logger');

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

/**
 * A COMPLETE `pr_data` snapshot — the shape storePRData / the PR refresh handler
 * persist. Every fast-path shortcut in the route (pool reclaim, plain
 * `existing: true`, restore mode) requires the stored diff this blob carries.
 */
const COMPLETE_PR_DATA = {
  title: 'Test PR',
  head_sha: 'abc123',
  head_branch: 'feature',
  base_sha: 'base123',
  diff: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-a\n+b\n',
  changed_files: [{ filename: 'a.js' }],
  worktree_path: '/somewhere/wt'
};

/**
 * Exactly the blob `PRMetadataRepository.upsertPRMetadata`'s INSERT arm writes
 * for a local review whose branch has an associated PR: metadata only, carrying
 * head_sha but NO diff and no worktree_path.
 */
const METADATA_ONLY_PR_DATA = {
  state: 'open',
  merged: false,
  html_url: 'https://github.com/owner/repo/pull/42',
  base_sha: 'base123',
  head_sha: 'head456',
  node_id: 'PR_node'
};

/**
 * Seed a pr_metadata row for test assertions. Defaults to a COMPLETE `pr_data`
 * blob: the route only serves a stored review when the blob carries a diff, so
 * a fixture without one exercises the fall-through, not the fast path.
 */
function seedPRMetadata(db, { prNumber = 42, repository = 'owner/repo', prData = COMPLETE_PR_DATA } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO pr_metadata (pr_number, repository, title, pr_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(prNumber, repository, 'Test PR', JSON.stringify(prData), now, now);
}

/**
 * Seed a pr_metadata row carrying a specific `pr_data` blob. Used by the
 * restore-mode gate tests, which turn entirely on which keys that blob holds.
 */
function seedPRMetadataWithData(db, prData, { prNumber = 42, repository = 'owner/repo', title = 'Test PR' } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO pr_metadata (pr_number, repository, title, pr_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(prNumber, repository, title, JSON.stringify(prData), now, now);
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
    expect(prSetupModule.setupPRReview).not.toHaveBeenCalled();
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
    expect(prSetupModule.setupPRReview).not.toHaveBeenCalled();
  });

  // The pool reclaim is a real optimization (it skips a fetch + checkout), so a
  // stored-diff gate that is too strict would silently make EVERY reclaim slow.
  // Pin the happy path: a complete blob still short-circuits setup entirely.
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
    expect(res.body.setupId).toBeUndefined();
    expect(prSetupModule.setupPRReview).not.toHaveBeenCalled();
    // Pool entry should be reclaimed as in_use
    const poolEntry = db.prepare('SELECT status, current_review_id FROM worktree_pool WHERE id = ?').get('pool-abc');
    expect(poolEntry.status).toBe('in_use');
    expect(poolEntry.current_review_id).toBeTruthy();
  });

  // REGRESSION: the stored-diff gate used to live BELOW the worktree lookup, so
  // the pool-reclaim return bypassed it entirely. Reachable sequence: review PR
  // 42 in a pool worktree → delete the review (deleteReviewById keeps the
  // worktrees row for pool slots, deletes pr_metadata, and releaseForDeletion →
  // markAvailable preserves current_pr_number) → start a local review on the
  // associated branch (cold cache → upsertPRMetadata INSERTs a diff-less blob) →
  // reopen the PR. The reclaim returned `existing: true` without ever
  // regenerating a diff, and GET /api/pr renders `diff || ''` — a structurally
  // valid PR page with ZERO files.
  it('does not reclaim an available pool worktree when pr_data is a metadata-only blob', async () => {
    seedPRMetadata(db, { prData: METADATA_ONLY_PR_DATA });
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'available', prNumber: 42 });

    const app = createApp(db, undefined, { withPool: true });
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();

    // Full setup runs, and NOT in restore mode (which skips diff generation too).
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    expect(prSetupModule.setupPRReview.mock.calls[0][0].restoreMetadata).toBeNull();
  });

  // The gate is evaluated BEFORE the reclaim's mutations, so falling through
  // must leave the pool slot exactly as it was — setup's own acquireForPR
  // (claimByPR → refresh) is what claims it. A half-applied reclaim (in_use with
  // no review owner) would leak the slot: no owner means the idle grace period
  // can never fire to reclaim it.
  it('leaves the pool entry untouched when the metadata-only blob forces a fall-through', async () => {
    seedPRMetadata(db, { prData: METADATA_ONLY_PR_DATA });
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'available', prNumber: 42 });

    const app = createApp(db, undefined, { withPool: true });
    server = await listenOnLoopback(app);
    await request(server).post('/api/setup/pr/owner/repo/42');

    const poolEntry = db.prepare('SELECT status, current_pr_number, current_review_id FROM worktree_pool WHERE id = ?').get('pool-abc');
    expect(poolEntry.status).toBe('available');
    expect(poolEntry.current_pr_number).toBe(42);
    expect(poolEntry.current_review_id).toBeFalsy();
  });

  // The SECOND early return (the `else` arm) is reachable with the same blob:
  // a `worktrees` row can outlive its pr_metadata row. `deleteWithRelatedData`
  // (the stale-review sweep in src/main.js) deletes reviews + orphan pr_metadata
  // and touches neither `worktrees` nor `worktree_pool`, and the stale-WORKTREE
  // sweep excludes pool rows (`wp.id IS NULL` in WorktreeRepository.findStale).
  // A pool slot left in_use across a server restart therefore keeps both its
  // worktrees row and its in_use status while its pr_metadata row is swept.
  it('does not serve an in_use pool worktree when pr_data is a metadata-only blob', async () => {
    seedPRMetadata(db, { prData: METADATA_ONLY_PR_DATA });
    seedWorktree(db, { id: 'pool-abc' });
    seedPoolEntry(db, { id: 'pool-abc', status: 'in_use', prNumber: 42 });

    const app = createApp(db, undefined, { withPool: true });
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    expect(prSetupModule.setupPRReview.mock.calls[0][0].restoreMetadata).toBeNull();
  });

  // Same `else` arm, non-pool branch (poolEntry === null): the stale-review
  // sweep leaves the worktrees row behind for non-pool worktrees too.
  it('does not serve a non-pool worktree when pr_data is a metadata-only blob', async () => {
    seedPRMetadata(db, { prData: METADATA_ONLY_PR_DATA });
    seedWorktree(db);
    // No pool entry — traditional worktree

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.existing).toBeUndefined();
    expect(res.body.setupId).toBeTruthy();
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    expect(prSetupModule.setupPRReview.mock.calls[0][0].restoreMetadata).toBeNull();
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

  it('passes restoreMetadata to setupPRReview when pr_data is a complete snapshot', async () => {
    // Seed PR metadata WITH a complete pr_data blob (head_sha AND a stored diff),
    // the shape every legitimate restore-eligible writer produces (storePRData /
    // the PR refresh handler).
    seedPRMetadataWithData(db, {
      title: 'Test PR',
      head_sha: 'abc123',
      head_branch: 'feature',
      diff: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-a\n+b\n',
      changed_files: [{ filename: 'a.js' }],
      worktree_path: '/somewhere/wt'
    });
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
    expect(callArgs.restoreMetadata.diff).toContain('diff --git');
  });

  it('passes null restoreMetadata when pr_data lacks head_sha', async () => {
    // Seed PR metadata with pr_data that has no head_sha
    seedPRMetadataWithData(db, { title: 'Test PR', body: 'no sha here' });

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.setupId).toBeTruthy();

    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.restoreMetadata).toBeNull();
  });

  // REGRESSION: PRMetadataRepository.upsertPRMetadata (local-mode PR association)
  // is the first writer to persist a PARTIAL pr_data blob — metadata only, no
  // diff and no worktree_path. It carries head_sha, so a head_sha-only restore
  // gate selected restore mode for it; setupPRReview then skips diff generation,
  // worktree creation still succeeds (base_sha + refs/pull/N/head), the
  // isShaNotFoundError fresh-setup fallback never fires, and the user lands on a
  // PR review page rendering zero files. The gate must require a stored diff.
  it('passes null restoreMetadata for a metadata-only pr_data blob (no diff)', async () => {
    // Exactly the shape upsertPRMetadata's INSERT arm produces.
    seedPRMetadataWithData(db, {
      state: 'open',
      merged: false,
      html_url: 'https://github.com/owner/repo/pull/42',
      base_sha: 'base123',
      head_sha: 'head456',
      node_id: 'PR_node'
    });
    // No worktree row — the dashboard-click path that reaches PR setup.

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(res.body.setupId).toBeTruthy();

    // Fresh setup must run: restore mode is NOT selected despite head_sha.
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.restoreMetadata).toBeNull();
  });

  it('passes null restoreMetadata when the stored diff is an empty string', async () => {
    // A blank diff cannot restore anything — degrade to fresh setup, which
    // self-heals the blob rather than rendering an empty review.
    seedPRMetadataWithData(db, {
      title: 'Test PR',
      head_sha: 'abc123',
      diff: '',
      worktree_path: '/somewhere/wt'
    });

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    expect(prSetupModule.setupPRReview.mock.calls[0][0].restoreMetadata).toBeNull();
  });

  it('passes null restoreMetadata when pr_data is unparseable', async () => {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO pr_metadata (pr_number, repository, title, pr_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(42, 'owner/repo', 'Test PR', '{not json', now, now);

    const app = createApp(db);
    server = await listenOnLoopback(app);
    const res = await request(server).post('/api/setup/pr/owner/repo/42');

    expect(res.status).toBe(200);
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    expect(prSetupModule.setupPRReview.mock.calls[0][0].restoreMetadata).toBeNull();
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

  it('ignores a github.com body host for a directly-keyed exclusive alt-host repo', async () => {
    // A dashboard collection row stamps host NULL for every github.com search
    // result and sends the 'github' sentinel, which setup.html forwards as
    // `{ host: null }`. When config declares this repo exclusive alt-host the
    // hint contradicts configuration: warn and fall back to the ambiguity rule
    // instead of surfacing resolveHostBinding's exclusive-null throw as a 500.
    const app = createApp(db, {
      repos: { 'owner/repo': { api_host: 'https://althost.example/api/v3', token: 'alt-tok' } }
    });
    const warnSpy = vi.spyOn(logger, 'warn');
    server = await listenOnLoopback(app);
    const res = await request(server)
      .post('/api/setup/pr/owner/repo/42')
      .send({ host: null });

    expect(res.status).toBe(200);
    expect(res.body.setupId).toBeTruthy();
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.host).toBeUndefined();
    expect(callArgs.bindingRepository).toBe('owner/repo');
    // The user is told why, and what to change, rather than silently getting
    // the alt host for a PR the dashboard sourced from github.com.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/exclusive alt-host repo.*"exclusive": false/s)
    );
  });

  it('rejects an exclusive monorepo entry that only pattern-claimed a github.com PR', async () => {
    // resolveBindingRepositoryFromPR probes each alt entry's url_pattern against
    // a URL built from that entry's own api_host, so an anchored monorepo pattern
    // claims every owner/repo. An exclusive alt entry has no github.com presence,
    // so for a PR we KNOW is on github.com it describes neither the API host nor
    // the checkout — the same call PRArgumentParser.parsePRUrl already makes for
    // a pasted github.com URL. Bind the PR's own identity instead.
    const app = createApp(db, {
      github_token: 'gh-tok',
      repos: {
        'acme/platform': {
          api_host: 'https://althost.example/api/v3',
          url_pattern: '^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)',
          token: 'alt-tok'
        }
      }
    });
    server = await listenOnLoopback(app);
    const res = await request(server)
      .post('/api/setup/pr/owner/repo/42')
      .send({ host: null });

    expect(res.status).toBe(200);
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.bindingRepository).toBe('owner/repo');
    // The github.com host survives, so the PR is fetched from where it lives.
    expect(callArgs.host).toBeNull();
    expect(callArgs.githubToken).toBe('gh-tok');
  });

  it('keeps a DUAL monorepo config key for a github.com body host', async () => {
    // A dual entry does serve github.com (resolveHostBinding has a first-class
    // dual-github binding), so its key must be preserved — setupPRReview reads
    // the repo's local path, checkout script, pool size, and reset script from it
    // (pr-setup.js findRepositoryPath / resolvePoolConfig / getRepoResetScript).
    // Dropping it here would silently discard the monorepo's local configuration.
    const app = createApp(db, {
      github_token: 'gh-tok',
      repos: {
        'acme/platform': {
          api_host: 'https://althost.example/api/v3',
          exclusive: false,
          url_pattern: '^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)',
          token: 'alt-tok'
        }
      }
    });
    server = await listenOnLoopback(app);
    const res = await request(server)
      .post('/api/setup/pr/owner/repo/42')
      .send({ host: null });

    expect(res.status).toBe(200);
    expect(prSetupModule.setupPRReview).toHaveBeenCalledOnce();
    const callArgs = prSetupModule.setupPRReview.mock.calls[0][0];
    expect(callArgs.bindingRepository).toBe('acme/platform');
    expect(callArgs.host).toBeNull();
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
