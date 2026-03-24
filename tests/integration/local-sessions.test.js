// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

/**
 * Local Sessions API Integration Tests
 *
 * Tests for the local review session listing, naming, start, and diff persistence endpoints.
 */

const { ReviewRepository } = require('../../src/database');
const { localReviewDiffs } = require('../../src/routes/shared');

// Spy on local-review functions to avoid real git operations
// Note: vi.mock doesn't work with CommonJS require() in this project (forks pool),
// so we use vi.spyOn on the actual module exports instead.
const localReviewModule = require('../../src/local-review');
const baseBranchModule = require('../../src/git/base-branch');
const { RepoSettingsRepository } = require('../../src/database');

describe('Local Sessions API', () => {
  let app;
  let db;

  beforeEach(() => {
    db = createTestDatabase();

    // Spy on local-review functions to prevent real git operations
    vi.spyOn(localReviewModule, 'findGitRoot').mockResolvedValue('/mock/repo');
    vi.spyOn(localReviewModule, 'getHeadSha').mockResolvedValue('abc123def456');
    vi.spyOn(localReviewModule, 'getRepositoryName').mockResolvedValue('owner/repo');
    vi.spyOn(localReviewModule, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(localReviewModule, 'generateScopedDiff').mockResolvedValue({
      diff: 'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js',
      stats: { trackedChanges: 1, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 1 },
      mergeBaseSha: null
    });
    vi.spyOn(localReviewModule, 'computeScopedDigest').mockResolvedValue('digest123');
    vi.spyOn(localReviewModule, 'detectAndBuildBranchInfo').mockResolvedValue(null);
    vi.spyOn(localReviewModule, 'findMergeBase').mockResolvedValue('mergebase123');
    vi.spyOn(localReviewModule, 'getBranchCommitCount').mockResolvedValue(0);
    vi.spyOn(localReviewModule, 'getFirstCommitSubject').mockResolvedValue(null);

    app = express();
    app.use(express.json());
    app.set('db', db);

    // Register the local routes
    const localRouter = require('../../src/routes/local');
    app.use(localRouter);
  });

  afterEach(() => {
    closeTestDatabase(db);
    // Clear the in-memory diff cache between tests to prevent leakage
    localReviewDiffs.clear();
    vi.restoreAllMocks();
  });

  describe('GET /api/local/sessions', () => {
    it('should return empty sessions list when no local reviews exist', async () => {
      const res = await request(app).get('/api/local/sessions');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sessions).toEqual([]);
      expect(res.body.hasMore).toBe(false);
    });

    it('should return local review sessions ordered by updated_at DESC', async () => {
      const reviewRepo = new ReviewRepository(db);
      const { run } = require('../../src/database');

      // Create two local review sessions
      const id1 = await reviewRepo.upsertLocalReview({
        localPath: '/path/to/repo1',
        localHeadSha: 'sha1',
        repository: 'owner/repo1'
      });
      // Set distinct timestamps to ensure deterministic ordering
      await run(db, `UPDATE reviews SET updated_at = ? WHERE id = ?`,
        ['2025-01-01T00:00:00.000Z', id1]);

      const id2 = await reviewRepo.upsertLocalReview({
        localPath: '/path/to/repo2',
        localHeadSha: 'sha2',
        repository: 'owner/repo2'
      });
      await run(db, `UPDATE reviews SET updated_at = ? WHERE id = ?`,
        ['2025-01-02T00:00:00.000Z', id2]);

      const res = await request(app).get('/api/local/sessions');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sessions).toHaveLength(2);
      // Most recently updated first
      expect(res.body.sessions[0].repository).toBe('owner/repo2');
      expect(res.body.sessions[1].repository).toBe('owner/repo1');
    });

    it('should not return PR reviews', async () => {
      const reviewRepo = new ReviewRepository(db);

      // Create a PR review
      await reviewRepo.createReview({
        prNumber: 42,
        repository: 'owner/repo'
      });

      // Create a local review
      await reviewRepo.upsertLocalReview({
        localPath: '/path/to/local',
        localHeadSha: 'localsha',
        repository: 'owner/local-repo'
      });

      const res = await request(app).get('/api/local/sessions');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].repository).toBe('owner/local-repo');
    });

    it('should support cursor-based pagination', async () => {
      const reviewRepo = new ReviewRepository(db);
      const { run } = require('../../src/database');

      // Create 3 local reviews with distinct timestamps
      for (let i = 1; i <= 3; i++) {
        const id = await reviewRepo.upsertLocalReview({
          localPath: `/path/repo${i}`,
          localHeadSha: `sha${i}`,
          repository: `owner/repo${i}`
        });
        // Manually set distinct updated_at values so pagination cursor works
        await run(db, `UPDATE reviews SET updated_at = ? WHERE id = ?`,
          [`2025-01-0${i}T00:00:00.000Z`, id]);
      }

      // Request with limit=2 (ordered by updated_at DESC: repo3, repo2, repo1)
      const res1 = await request(app).get('/api/local/sessions?limit=2');
      expect(res1.body.sessions).toHaveLength(2);
      expect(res1.body.hasMore).toBe(true);

      // Request next page using cursor
      const cursor = res1.body.sessions[1].updated_at;
      const res2 = await request(app).get(`/api/local/sessions?limit=2&before=${cursor}`);
      expect(res2.body.sessions).toHaveLength(1);
      expect(res2.body.hasMore).toBe(false);
    });

    it('should include name field in session data', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/named',
        localHeadSha: 'shaNamed',
        repository: 'owner/named-repo'
      });

      await reviewRepo.updateReview(id, { name: 'My Feature Review' });

      const res = await request(app).get('/api/local/sessions');
      expect(res.body.sessions[0].name).toBe('My Feature Review');
    });
  });

  describe('PATCH /api/local/:reviewId/name', () => {
    it('should update the name of a local review session', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/rename',
        localHeadSha: 'shaRename',
        repository: 'owner/rename-repo'
      });

      const res = await request(app)
        .patch(`/api/local/${id}/name`)
        .send({ name: 'My Named Session' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.name).toBe('My Named Session');

      // Verify in database
      const review = await reviewRepo.getLocalReviewById(id);
      expect(review.name).toBe('My Named Session');
    });

    it('should clear the name when null is sent', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/clear',
        localHeadSha: 'shaClear',
        repository: 'owner/clear-repo'
      });

      // Set name first
      await reviewRepo.updateReview(id, { name: 'Some Name' });

      // Clear name
      const res = await request(app)
        .patch(`/api/local/${id}/name`)
        .send({ name: null });

      expect(res.status).toBe(200);
      expect(res.body.name).toBeNull();
    });

    it('should truncate name to 200 characters', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/long',
        localHeadSha: 'shaLong',
        repository: 'owner/long-repo'
      });

      const longName = 'A'.repeat(300);
      const res = await request(app)
        .patch(`/api/local/${id}/name`)
        .send({ name: longName });

      expect(res.status).toBe(200);
      expect(res.body.name).toHaveLength(200);
    });

    it('should return 404 for non-existent review', async () => {
      const res = await request(app)
        .patch('/api/local/9999/name')
        .send({ name: 'Test' });

      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid review ID', async () => {
      const res = await request(app)
        .patch('/api/local/abc/name')
        .send({ name: 'Test' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/local/start', () => {
    it('should return 400 when path is missing', async () => {
      const res = await request(app)
        .post('/api/local/start')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/path/i);
    });

    it('should return 400 when path is empty string', async () => {
      const res = await request(app)
        .post('/api/local/start')
        .send({ path: '  ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/path/i);
    });

    it('should start a local review for a valid directory', async () => {
      const res = await request(app)
        .post('/api/local/start')
        .send({ path: '/tmp' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.reviewUrl).toMatch(/^\/local\/\d+$/);
      expect(res.body.sessionId).toBeGreaterThan(0);
      expect(res.body.repository).toBe('owner/repo');
      expect(res.body.branch).toBe('main');
      expect(res.body.stats).toEqual({
        trackedChanges: 1,
        untrackedFiles: 0,
        stagedChanges: 0,
        unstagedChanges: 1
      });

      // Verify diff was persisted to in-memory Map
      const cachedDiff = localReviewDiffs.get(res.body.sessionId);
      expect(cachedDiff).toBeDefined();
      expect(cachedDiff.digest).toBe('digest123');

      // Verify diff was persisted to database
      const reviewRepo = new ReviewRepository(db);
      const dbDiff = await reviewRepo.getLocalDiff(res.body.sessionId);
      expect(dbDiff).not.toBeNull();
      expect(dbDiff.digest).toBe('digest123');
    });

    it('should return 400 for non-existent path', async () => {
      // Use a path that definitely doesn't exist - the endpoint checks fs.stat first
      const res = await request(app)
        .post('/api/local/start')
        .send({ path: '/nonexistent/path/that/does/not/exist/abc123xyz' });

      // Will get 400 because path doesn't exist (fs.stat fails)
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Path does not exist');
    });
  });

  describe('Diff persistence', () => {
    it('should save and retrieve local diffs from database', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/diff',
        localHeadSha: 'shaDiff',
        repository: 'owner/diff-repo'
      });

      const diffData = {
        diff: 'diff --git a/test.js b/test.js\n+hello',
        stats: { trackedChanges: 1, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 1 },
        digest: 'testdigest123'
      };

      await reviewRepo.saveLocalDiff(id, diffData);

      const result = await reviewRepo.getLocalDiff(id);
      expect(result).not.toBeNull();
      expect(result.diff).toBe(diffData.diff);
      expect(result.stats).toEqual(diffData.stats);
      expect(result.digest).toBe('testdigest123');
    });

    it('should return null for non-existent diff', async () => {
      const reviewRepo = new ReviewRepository(db);
      const result = await reviewRepo.getLocalDiff(9999);
      expect(result).toBeNull();
    });

    it('should upsert (replace) existing diff', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/upsert',
        localHeadSha: 'shaUpsert',
        repository: 'owner/upsert-repo'
      });

      // Save first diff
      await reviewRepo.saveLocalDiff(id, {
        diff: 'first diff',
        stats: { trackedChanges: 1 },
        digest: 'digest1'
      });

      // Save updated diff (upsert)
      await reviewRepo.saveLocalDiff(id, {
        diff: 'second diff',
        stats: { trackedChanges: 2 },
        digest: 'digest2'
      });

      const result = await reviewRepo.getLocalDiff(id);
      expect(result.diff).toBe('second diff');
      expect(result.stats.trackedChanges).toBe(2);
      expect(result.digest).toBe('digest2');
    });

    it('should cascade delete diffs when review is deleted', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/cascade',
        localHeadSha: 'shaCascade',
        repository: 'owner/cascade-repo'
      });

      await reviewRepo.saveLocalDiff(id, {
        diff: 'test diff',
        stats: {},
        digest: 'cascadedigest'
      });

      // Delete the review using the production method the DELETE endpoint uses
      await reviewRepo.deleteLocalSession(id);

      // Diff should be gone too
      const result = await reviewRepo.getLocalDiff(id);
      expect(result).toBeNull();
    });
  });

  describe('GET /api/local/:reviewId (name field)', () => {
    it('should include name in the response', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/getname',
        localHeadSha: 'shaGetName',
        repository: 'owner/getname-repo'
      });

      await reviewRepo.updateReview(id, { name: 'Get Name Test' });

      const res = await request(app).get(`/api/local/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Get Name Test');
    });

    it('should return null name when not set', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/noname',
        localHeadSha: 'shaNoName',
        repository: 'owner/noname-repo'
      });

      const res = await request(app).get(`/api/local/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBeNull();
    });
  });

  describe('DELETE /api/local/sessions/:reviewId', () => {
    it('should delete an existing local session and return 200', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/todelete',
        localHeadSha: 'shaDelete',
        repository: 'owner/delete-repo'
      });

      const res = await request(app).delete(`/api/local/sessions/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.reviewId).toBe(id);

      // Verify the session is actually gone
      const review = await reviewRepo.getLocalReviewById(id);
      expect(review).toBeFalsy();
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app).delete('/api/local/sessions/9999');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('should return 400 for invalid review ID', async () => {
      const res = await request(app).delete('/api/local/sessions/abc');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid/i);
    });

    it('should return 400 for negative review ID', async () => {
      const res = await request(app).delete('/api/local/sessions/-1');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid/i);
    });

    it('should clean up in-memory diff cache on delete', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/cacheclear',
        localHeadSha: 'shaCacheClear',
        repository: 'owner/cacheclear-repo'
      });

      // Populate the in-memory diff cache
      localReviewDiffs.set(id, {
        diff: 'some diff',
        stats: {},
        digest: 'somedigest'
      });

      const res = await request(app).delete(`/api/local/sessions/${id}`);
      expect(res.status).toBe(200);

      // In-memory cache should be cleared
      expect(localReviewDiffs.has(id)).toBe(false);
    });

    it('should cascade delete diffs when session is deleted via endpoint', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/cascadedel',
        localHeadSha: 'shaCascadeDel',
        repository: 'owner/cascadedel-repo'
      });

      await reviewRepo.saveLocalDiff(id, {
        diff: 'diff to cascade',
        stats: {},
        digest: 'cascadedigest'
      });

      const res = await request(app).delete(`/api/local/sessions/${id}`);
      expect(res.status).toBe(200);

      // DB diff should be gone too (cascade)
      const dbDiff = await reviewRepo.getLocalDiff(id);
      expect(dbDiff).toBeNull();
    });
  });

  describe('POST /api/local/:reviewId/set-scope', () => {
    it('should change scope from default to staged→untracked', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/scope-change',
        localHeadSha: 'shaScopeChange',
        repository: 'owner/scope-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'staged', scopeEnd: 'untracked' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.scopeStart).toBe('staged');
      expect(res.body.scopeEnd).toBe('untracked');
      expect(res.body.stats).toBeDefined();
      expect(res.body.stats).toHaveProperty('trackedChanges');
      expect(res.body.stats).toHaveProperty('untrackedFiles');
      expect(res.body.stats).toHaveProperty('stagedChanges');
      expect(res.body.stats).toHaveProperty('unstagedChanges');
    });

    it('should return 400 for invalid scope (end before start)', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/bad-scope',
        localHeadSha: 'shaBadScope',
        repository: 'owner/bad-scope-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'untracked', scopeEnd: 'staged' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid scope/i);
    });

    it('should return 400 when scopeStart is missing', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/missing-start',
        localHeadSha: 'shaMissStart',
        repository: 'owner/miss-start-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeEnd: 'untracked' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/scopeStart.*scopeEnd.*required/i);
    });

    it('should return 400 when scopeEnd is missing', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/missing-end',
        localHeadSha: 'shaMissEnd',
        repository: 'owner/miss-end-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'staged' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/scopeStart.*scopeEnd.*required/i);
    });

    it('should regenerate diff and persist to DB when scope changes', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/regen-diff',
        localHeadSha: 'shaRegenDiff',
        repository: 'owner/regen-diff-repo'
      });

      // Save an initial diff to DB with distinct values
      await reviewRepo.saveLocalDiff(id, {
        diff: 'old diff that should be replaced',
        stats: { trackedChanges: 99 },
        digest: 'olddigest'
      });

      // set-scope should regenerate the diff and overwrite DB
      const res = await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'staged', scopeEnd: 'untracked' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the DB diff was replaced by the regenerated diff
      const dbDiff = await reviewRepo.getLocalDiff(id);
      expect(dbDiff.diff).not.toBe('old diff that should be replaced');
      expect(dbDiff.digest).not.toBe('olddigest');

      // Verify the in-memory cache was also populated
      const cached = localReviewDiffs.get(id);
      expect(cached).toBeDefined();
      expect(cached.diff).not.toBe('old diff that should be replaced');
    });

    it('should return 404 for non-existent review', async () => {
      const res = await request(app)
        .post('/api/local/9999/set-scope')
        .send({ scopeStart: 'staged', scopeEnd: 'untracked' });

      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid review ID', async () => {
      const res = await request(app)
        .post('/api/local/abc/set-scope')
        .send({ scopeStart: 'staged', scopeEnd: 'untracked' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid review id/i);
    });

    it('should include localMode in response', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/local-mode',
        localHeadSha: 'shaLocalMode',
        repository: 'owner/localmode-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'staged', scopeEnd: 'untracked' });

      expect(res.status).toBe(200);
      expect(res.body.localMode).toBe('uncommitted');
    });

    it('should set branch scope with localMode=branch and persist DB columns', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/branch-scope',
        localHeadSha: 'shaBranchScope',
        repository: 'owner/branch-scope-repo'
      });

      // Mock findMergeBase to return a specific SHA for branch diff
      localReviewModule.findMergeBase.mockResolvedValue('abc123mergebase');

      const res = await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'branch', scopeEnd: 'branch', baseBranch: 'main' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.localMode).toBe('branch');
      expect(res.body.mergeBaseSha).toBeDefined();

      // Verify DB columns are persisted
      const review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_scope_start).toBe('branch');
      expect(review.local_scope_end).toBe('branch');
      expect(review.local_base_branch).toBe('main');
    });
  });

  describe('POST /api/local/:reviewId/branch-review-preference', () => {
    it('should accept preference value 1 (always)', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/pref-always',
        localHeadSha: 'shaPrefAlways',
        repository: 'owner/pref-always-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/branch-review-preference`)
        .send({ preference: 1 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.preference).toBe(1);

      // Verify in database
      const repoSettingsRepo = new RepoSettingsRepository(db);
      const settings = await repoSettingsRepo.getRepoSettings('owner/pref-always-repo');
      expect(settings.auto_branch_review).toBe(1);
    });

    it('should accept preference value -1 (never)', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/pref-never',
        localHeadSha: 'shaPrefNever',
        repository: 'owner/pref-never-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/branch-review-preference`)
        .send({ preference: -1 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.preference).toBe(-1);

      const repoSettingsRepo = new RepoSettingsRepository(db);
      const settings = await repoSettingsRepo.getRepoSettings('owner/pref-never-repo');
      expect(settings.auto_branch_review).toBe(-1);
    });

    it('should accept preference value 0 (ask)', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/pref-ask',
        localHeadSha: 'shaPrefAsk',
        repository: 'owner/pref-ask-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/branch-review-preference`)
        .send({ preference: 0 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.preference).toBe(0);
    });

    it('should reject invalid preference values', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/pref-bad',
        localHeadSha: 'shaPrefBad',
        repository: 'owner/pref-bad-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/branch-review-preference`)
        .send({ preference: 42 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid preference/i);
    });

    it('should reject missing preference', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/pref-missing',
        localHeadSha: 'shaPrefMissing',
        repository: 'owner/pref-missing-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/branch-review-preference`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid preference/i);
    });

    it('should return 404 for non-existent review', async () => {
      const res = await request(app)
        .post('/api/local/9999/branch-review-preference')
        .send({ preference: 1 });

      expect(res.status).toBe(404);
    });

    it('should update existing repo settings', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/pref-update',
        localHeadSha: 'shaPrefUpdate',
        repository: 'owner/pref-update-repo'
      });

      // Create initial setting
      await request(app)
        .post(`/api/local/${id}/branch-review-preference`)
        .send({ preference: 1 });

      // Update to a different value
      const res = await request(app)
        .post(`/api/local/${id}/branch-review-preference`)
        .send({ preference: -1 });

      expect(res.status).toBe(200);
      expect(res.body.preference).toBe(-1);

      const repoSettingsRepo = new RepoSettingsRepository(db);
      const settings = await repoSettingsRepo.getRepoSettings('owner/pref-update-repo');
      expect(settings.auto_branch_review).toBe(-1);
    });
  });

  describe('DB persistence of scope columns', () => {
    it('should set local_scope_start and local_scope_end in database after POST /api/local/start', async () => {
      const res = await request(app)
        .post('/api/local/start')
        .send({ path: '/tmp' });

      expect(res.status).toBe(200);
      const sessionId = res.body.sessionId;

      // Verify scope columns in database
      const reviewRepo = new ReviewRepository(db);
      const review = await reviewRepo.getLocalReviewById(sessionId);
      expect(review.local_scope_start).toBe('unstaged');
      expect(review.local_scope_end).toBe('untracked');
    });

    it('should update scope columns in database after POST set-scope', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/scope-persist',
        localHeadSha: 'shaScopePersist',
        repository: 'owner/scope-persist-repo'
      });

      // Verify initial defaults
      const beforeReview = await reviewRepo.getLocalReviewById(id);
      expect(beforeReview.local_scope_start).toBe('unstaged');
      expect(beforeReview.local_scope_end).toBe('untracked');

      // Change scope
      const res = await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'staged', scopeEnd: 'unstaged' });

      expect(res.status).toBe(200);

      // Verify updated columns
      const afterReview = await reviewRepo.getLocalReviewById(id);
      expect(afterReview.local_scope_start).toBe('staged');
      expect(afterReview.local_scope_end).toBe('unstaged');
    });

    it('should persist scope columns through multiple scope changes', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/scope-multi',
        localHeadSha: 'shaScopeMulti',
        repository: 'owner/scope-multi-repo'
      });

      // First change: staged→untracked
      await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'staged', scopeEnd: 'untracked' });

      let review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_scope_start).toBe('staged');
      expect(review.local_scope_end).toBe('untracked');

      // Second change: unstaged→unstaged
      await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'unstaged', scopeEnd: 'unstaged' });

      review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_scope_start).toBe('unstaged');
      expect(review.local_scope_end).toBe('unstaged');
    });
  });

  describe('GET /api/local/:reviewId (scope fields in metadata)', () => {
    it('should include scopeStart and scopeEnd in metadata response', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/scope-meta',
        localHeadSha: 'shaScopeMeta',
        repository: 'owner/scope-meta-repo'
      });

      const res = await request(app).get(`/api/local/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.scopeStart).toBe('unstaged');
      expect(res.body.scopeEnd).toBe('untracked');
      expect(res.body.baseBranch).toBeNull();
    });

    it('should reflect updated scope after set-scope call', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/scope-meta-updated',
        localHeadSha: 'shaScopeMetaUp',
        repository: 'owner/scope-meta-up-repo'
      });

      // Change scope
      await request(app)
        .post(`/api/local/${id}/set-scope`)
        .send({ scopeStart: 'staged', scopeEnd: 'unstaged' });

      // Get metadata
      const res = await request(app).get(`/api/local/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.scopeStart).toBe('staged');
      expect(res.body.scopeEnd).toBe('unstaged');
    });
  });

  describe('GET /api/local/:reviewId/diff (DB fallback)', () => {
    it('should fall back to database when in-memory diff is not available', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/dbfallback',
        localHeadSha: 'shaDBFallback',
        repository: 'owner/dbfallback-repo'
      });

      // Save diff directly to database (simulate a past session)
      await reviewRepo.saveLocalDiff(id, {
        diff: 'diff --git a/db-test.js b/db-test.js\n+from database',
        stats: { trackedChanges: 1, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 1 },
        digest: 'dbdigest'
      });

      const res = await request(app).get(`/api/local/${id}/diff`);
      expect(res.status).toBe(200);
      expect(res.body.diff).toContain('from database');
      expect(res.body.stats.unstagedChanges).toBe(1);
    });

    it('should return empty diff when neither in-memory nor DB has data', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/empty',
        localHeadSha: 'shaEmpty',
        repository: 'owner/empty-repo'
      });

      const res = await request(app).get(`/api/local/${id}/diff`);
      expect(res.status).toBe(200);
      expect(res.body.diff).toBe('');
    });
  });

  describe('Branch-aware session identity', () => {
    it('should create separate sessions for different branches at same path', async () => {
      const reviewRepo = new ReviewRepository(db);

      // Create two sessions, then set each to branch scope on different branches
      const id1 = await reviewRepo.upsertLocalReview({
        localPath: '/repo',
        localHeadSha: 'sha-feature-a',
        repository: 'owner/repo'
      });
      await reviewRepo.updateLocalScope(id1, 'branch', 'branch', 'main', 'feature-a');

      const id2 = await reviewRepo.upsertLocalReview({
        localPath: '/repo',
        localHeadSha: 'sha-feature-b',
        repository: 'owner/repo'
      });
      await reviewRepo.updateLocalScope(id2, 'branch', 'branch', 'main', 'feature-b');

      expect(id1).not.toBe(id2);

      // Each branch lookup returns the correct session
      const foundA = await reviewRepo.getLocalBranchScopeReview('/repo', 'feature-a');
      expect(foundA.id).toBe(id1);
      const foundB = await reviewRepo.getLocalBranchScopeReview('/repo', 'feature-b');
      expect(foundB.id).toBe(id2);
    });

    it('should reuse session for same branch with different HEAD SHA', async () => {
      const reviewRepo = new ReviewRepository(db);

      const id1 = await reviewRepo.upsertLocalReview({
        localPath: '/repo',
        localHeadSha: 'sha-old',
        repository: 'owner/repo'
      });
      await reviewRepo.updateLocalScope(id1, 'branch', 'branch', 'main', 'feature-a');

      // Simulate finding the session on the same branch with a new HEAD
      const found = await reviewRepo.getLocalBranchScopeReview('/repo', 'feature-a');
      expect(found).not.toBeNull();
      expect(found.id).toBe(id1);
    });

    it('should not find branch session for a different branch at same path', async () => {
      const reviewRepo = new ReviewRepository(db);

      const id = await reviewRepo.upsertLocalReview({
        localPath: '/repo',
        localHeadSha: 'sha-1',
        repository: 'owner/repo'
      });
      await reviewRepo.updateLocalScope(id, 'branch', 'branch', 'main', 'feature-a');

      const found = await reviewRepo.getLocalBranchScopeReview('/repo', 'feature-b');
      expect(found).toBeNull();
    });

    it('should store local_head_branch via updateLocalScope and retrieve it', async () => {
      const reviewRepo = new ReviewRepository(db);

      const id = await reviewRepo.upsertLocalReview({
        localPath: '/repo',
        localHeadSha: 'sha-1',
        repository: 'owner/repo'
      });

      // head_branch is null at creation
      let review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_head_branch).toBeNull();

      // Set when entering branch scope
      await reviewRepo.updateLocalScope(id, 'branch', 'branch', 'main', 'my-branch');
      review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_head_branch).toBe('my-branch');

      // Cleared when leaving branch scope
      await reviewRepo.updateLocalScope(id, 'unstaged', 'untracked');
      review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_head_branch).toBeNull();
    });

    it('POST /api/local/start should create separate sessions per branch after scope change', async () => {
      // Start session on feature-a
      localReviewModule.getCurrentBranch.mockResolvedValue('feature-a');
      localReviewModule.getHeadSha.mockResolvedValue('sha-a');

      const res1 = await request(app)
        .post('/api/local/start')
        .send({ path: '/tmp' });
      expect(res1.status).toBe(200);
      const sessionA = res1.body.sessionId;

      // Switch scope to branch mode (stores headBranch via updateLocalScope)
      const reviewRepo = new ReviewRepository(db);
      await reviewRepo.updateLocalScope(sessionA, 'branch', 'branch', 'main', 'feature-a');

      // Start session on feature-b (different branch)
      localReviewModule.getCurrentBranch.mockResolvedValue('feature-b');
      localReviewModule.getHeadSha.mockResolvedValue('sha-b');

      const res2 = await request(app)
        .post('/api/local/start')
        .send({ path: '/tmp' });
      expect(res2.status).toBe(200);
      const sessionB = res2.body.sessionId;

      // Should be different sessions
      expect(sessionA).not.toBe(sessionB);
    });
  });

  describe('POST /api/local/:reviewId/resolve-head-change', () => {
    it('action "update" — updates SHA and returns { action: "updated" }', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/resolve-update',
        localHeadSha: 'oldsha111',
        repository: 'owner/resolve-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'update', newHeadSha: 'newsha222' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('updated');

      // Verify the SHA was actually updated in the database
      const review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_head_sha).toBe('newsha222');

      // Verify diff was recomputed and persisted
      const dbDiff = await reviewRepo.getLocalDiff(id);
      expect(dbDiff).not.toBeNull();
      expect(dbDiff.digest).toBe('digest123');

      // Verify in-memory cache was populated
      const cached = localReviewDiffs.get(id);
      expect(cached).toBeDefined();
      expect(cached.digest).toBe('digest123');
    });

    it('action "update" with branch change — updates SHA and branch in place', async () => {
      const reviewRepo = new ReviewRepository(db);

      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/resolve-branch-update',
        localHeadSha: 'oldsha',
        localHeadBranch: 'old-branch',
        repository: 'owner/repo'
      });

      localReviewModule.getCurrentBranch.mockResolvedValue('new-branch');

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'update', newHeadSha: 'newsha' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('updated');

      const review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_head_sha).toBe('newsha');
      expect(review.local_head_branch).toBe('new-branch');

      const dbDiff = await reviewRepo.getLocalDiff(id);
      expect(dbDiff).not.toBeNull();
      expect(dbDiff.digest).toBe('digest123');

      // Verify the session is findable by its new identity tuple
      const found = await reviewRepo.getLocalReview('/path/resolve-branch-update', 'newsha', 'new-branch');
      expect(found).not.toBeNull();
      expect(found.id).toBe(id);
    });

    it('action "update" with UNIQUE conflict — returns { action: "redirect", sessionId }', async () => {
      const reviewRepo = new ReviewRepository(db);

      // Create the session we will try to update
      const originalId = await reviewRepo.upsertLocalReview({
        localPath: '/path/conflict-test',
        localHeadSha: 'sha-original',
        localHeadBranch: 'main',
        repository: 'owner/conflict-repo'
      });

      // Create a conflicting session at the same path+sha+branch combo
      const conflictId = await reviewRepo.upsertLocalReview({
        localPath: '/path/conflict-test',
        localHeadSha: 'sha-conflict-target',
        localHeadBranch: 'main',
        repository: 'owner/conflict-repo'
      });

      // Try to update the original session's SHA to the conflict target SHA
      const res = await request(app)
        .post(`/api/local/${originalId}/resolve-head-change`)
        .send({ action: 'update', newHeadSha: 'sha-conflict-target' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('redirect');
      expect(res.body.sessionId).toBe(conflictId);

      // Verify the original session SHA was NOT changed
      const review = await reviewRepo.getLocalReviewById(originalId);
      expect(review.local_head_sha).toBe('sha-original');
    });

    it('action "update" with branch change + UNIQUE conflict — redirects WITHOUT mutating original session branch', async () => {
      const reviewRepo = new ReviewRepository(db);

      // Create the original session on 'old-branch'
      const originalId = await reviewRepo.upsertLocalReview({
        localPath: '/path/branch-conflict',
        localHeadSha: 'sha-original',
        localHeadBranch: 'old-branch',
        repository: 'owner/branch-conflict-repo'
      });

      // Mock getCurrentBranch to simulate the user having checked out a new branch
      localReviewModule.getCurrentBranch.mockResolvedValue('new-branch');

      // Create a conflicting session at (same path, newHeadSha, 'new-branch')
      const conflictId = await reviewRepo.upsertLocalReview({
        localPath: '/path/branch-conflict',
        localHeadSha: 'sha-new-head',
        localHeadBranch: 'new-branch',
        repository: 'owner/branch-conflict-repo'
      });

      // Try to update the original session — should detect the conflict
      // at the FINAL tuple (path, newHeadSha, new-branch) and redirect
      const res = await request(app)
        .post(`/api/local/${originalId}/resolve-head-change`)
        .send({ action: 'update', newHeadSha: 'sha-new-head' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('redirect');
      expect(res.body.sessionId).toBe(conflictId);

      // CRITICAL: the original session must NOT have been mutated.
      // The branch must still be 'old-branch', not 'new-branch'.
      const original = await reviewRepo.getLocalReviewById(originalId);
      expect(original.local_head_branch).toBe('old-branch');
      expect(original.local_head_sha).toBe('sha-original');
    });

    it('action "new-session" — creates new session, returns its ID', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-old-session',
        repository: 'owner/repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'new-session', newHeadSha: 'sha-brand-new' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('new-session');
      expect(res.body.newSessionId).toBeDefined();
      expect(res.body.newSessionId).not.toBe(id);

      // Verify the new session exists in the database
      const newReview = await reviewRepo.getLocalReviewById(res.body.newSessionId);
      expect(newReview).not.toBeNull();
      expect(newReview.local_head_sha).toBe('sha-brand-new');
      expect(newReview.local_path).toBe('/mock/repo');

      // Verify the new session has a diff immediately available
      const diffRes = await request(app)
        .get(`/api/local/${res.body.newSessionId}/diff`);
      expect(diffRes.status).toBe(200);
      expect(diffRes.body.diff).toBeTruthy();
    });

    it('action "new-session" — returns existing session if one already exists for new HEAD', async () => {
      const reviewRepo = new ReviewRepository(db);

      // Create original session
      const originalId = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-current',
        repository: 'owner/repo'
      });

      // Create an existing session at the target HEAD
      const existingId = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-already-exists',
        repository: 'owner/repo'
      });

      const res = await request(app)
        .post(`/api/local/${originalId}/resolve-head-change`)
        .send({ action: 'new-session', newHeadSha: 'sha-already-exists' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('new-session');
      expect(res.body.newSessionId).toBe(existingId);
    });

    it('should return 400 for invalid review ID', async () => {
      const res = await request(app)
        .post('/api/local/abc/resolve-head-change')
        .send({ action: 'update', newHeadSha: 'sha123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid review id/i);
    });

    it('should return 400 for negative review ID', async () => {
      const res = await request(app)
        .post('/api/local/-5/resolve-head-change')
        .send({ action: 'update', newHeadSha: 'sha123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid review id/i);
    });

    it('should return 404 for non-existent review ID', async () => {
      const res = await request(app)
        .post('/api/local/9999/resolve-head-change')
        .send({ action: 'update', newHeadSha: 'sha123' });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('should return 400 when action is missing', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/missing-action',
        localHeadSha: 'sha-missing-action',
        repository: 'owner/missing-action-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ newHeadSha: 'sha123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/action/i);
    });

    it('should return 400 when action is invalid', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/bad-action',
        localHeadSha: 'sha-bad-action',
        repository: 'owner/bad-action-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'delete', newHeadSha: 'sha123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/action/i);
    });

    it('should return 400 when newHeadSha is missing', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/missing-sha',
        localHeadSha: 'sha-missing-sha',
        repository: 'owner/missing-sha-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'update' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/newHeadSha/i);
    });

    it('should return 400 when newHeadSha is not a string', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/path/bad-sha-type',
        localHeadSha: 'sha-bad-type',
        repository: 'owner/bad-type-repo'
      });

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'update', newHeadSha: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/newHeadSha/i);
    });

    it('action "new-session" should inherit scope from the original session', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-scoped',
        repository: 'owner/repo'
      });

      // Set a non-default scope on the original session
      await reviewRepo.updateLocalScope(id, 'staged', 'unstaged');

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'new-session', newHeadSha: 'sha-new-scoped' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.newSessionId).toBeDefined();

      // Verify the new session inherited the scope
      const newReview = await reviewRepo.getLocalReviewById(res.body.newSessionId);
      expect(newReview.local_scope_start).toBe('staged');
      expect(newReview.local_scope_end).toBe('unstaged');
    });
  });

  describe('POST /api/local/:reviewId/refresh (HEAD change on non-branch scope)', () => {
    it('should return headShaChanged: true but NOT sessionChanged or newSessionId when HEAD changes on non-branch-scope review', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-before-refresh',
        repository: 'owner/repo'
      });

      // Mock getHeadSha to return a different SHA than what was stored
      localReviewModule.getHeadSha.mockResolvedValue('sha-after-refresh');

      const res = await request(app)
        .post(`/api/local/${id}/refresh`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.headShaChanged).toBe(true);
      expect(res.body.previousHeadSha).toBe('sha-before-refresh');
      expect(res.body.currentHeadSha).toBe('sha-after-refresh');

      // These fields must NOT be present — the refresh endpoint defers
      // session creation to the resolve-head-change endpoint
      expect(res.body).not.toHaveProperty('sessionChanged');
      expect(res.body).not.toHaveProperty('newSessionId');

      // Verify the session's HEAD SHA was NOT updated (deferred to resolve-head-change)
      const review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_head_sha).toBe('sha-before-refresh');
    });

    it('should NOT persist diff when HEAD changes on non-branch-scope review', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-no-persist',
        repository: 'owner/repo'
      });

      // Save an initial diff
      await reviewRepo.saveLocalDiff(id, {
        diff: 'original diff before HEAD change',
        stats: { trackedChanges: 1 },
        digest: 'original-digest'
      });

      // Mock getHeadSha to return a different SHA
      localReviewModule.getHeadSha.mockResolvedValue('sha-different');

      const res = await request(app)
        .post(`/api/local/${id}/refresh`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.headShaChanged).toBe(true);

      // The old diff in the DB should be preserved (not overwritten)
      const dbDiff = await reviewRepo.getLocalDiff(id);
      expect(dbDiff.diff).toBe('original diff before HEAD change');
      expect(dbDiff.digest).toBe('original-digest');
    });

    it('should update HEAD SHA and persist diff when HEAD changes on branch-scope review', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-branch-old',
        repository: 'owner/repo'
      });

      // Set scope to branch
      await reviewRepo.updateLocalScope(id, 'branch', 'branch', 'main', 'feature-x');

      // Mock getHeadSha to return a different SHA
      localReviewModule.getHeadSha.mockResolvedValue('sha-branch-new');

      const res = await request(app)
        .post(`/api/local/${id}/refresh`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.headShaChanged).toBe(true);

      // Branch-scope reviews SHOULD update the SHA in-place
      const review = await reviewRepo.getLocalReviewById(id);
      expect(review.local_head_sha).toBe('sha-branch-new');

      // Diff should be persisted (not deferred)
      const dbDiff = await reviewRepo.getLocalDiff(id);
      expect(dbDiff).not.toBeNull();
      expect(dbDiff.digest).toBe('digest123');
    });

    it('should return branchAvailable: true when branch has commits ahead after HEAD change', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-before',
        repository: 'owner/repo',
        localHeadBranch: 'feature-branch'
      });

      // Mock HEAD change
      localReviewModule.getHeadSha.mockResolvedValue('sha-after');

      // Mock branch detection: branch has commits ahead
      vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({ baseBranch: 'main' });
      localReviewModule.getBranchCommitCount.mockResolvedValue(2);

      const res = await request(app)
        .post(`/api/local/${id}/refresh`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.headShaChanged).toBe(true);
      expect(res.body.branchAvailable).toBe(true);
    });

    it('should return branchAvailable: false when branch has no commits ahead', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'sha-before',
        repository: 'owner/repo',
        localHeadBranch: 'feature-branch'
      });

      // Mock HEAD change
      localReviewModule.getHeadSha.mockResolvedValue('sha-after');

      // Mock branch detection: no commits ahead
      vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({ baseBranch: 'main' });
      localReviewModule.getBranchCommitCount.mockResolvedValue(0);

      const res = await request(app)
        .post(`/api/local/${id}/refresh`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.branchAvailable).toBe(false);
    });
  });

  describe('POST /api/local/:reviewId/resolve-head-change (branchAvailable)', () => {
    it('action "update" should return branchAvailable: true when branch has commits ahead', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'oldsha',
        repository: 'owner/repo',
        localHeadBranch: 'feature-branch'
      });

      // Mock branch detection: branch has commits ahead
      vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({ baseBranch: 'main' });
      localReviewModule.getBranchCommitCount.mockResolvedValue(3);

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'update', newHeadSha: 'newsha' });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('updated');
      expect(res.body.branchAvailable).toBe(true);
    });

    it('action "update" should return branchAvailable: false when no commits ahead', async () => {
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'oldsha',
        repository: 'owner/repo',
        localHeadBranch: 'feature-branch'
      });

      // Mock branch detection: no commits ahead
      vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({ baseBranch: 'main' });
      localReviewModule.getBranchCommitCount.mockResolvedValue(0);

      const res = await request(app)
        .post(`/api/local/${id}/resolve-head-change`)
        .send({ action: 'update', newHeadSha: 'newsha' });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('updated');
      expect(res.body.branchAvailable).toBe(false);
    });
  });
});
