// SPDX-License-Identifier: GPL-3.0-or-later
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
    vi.spyOn(localReviewModule, 'generateLocalDiff').mockResolvedValue({
      diff: 'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js',
      untrackedFiles: [],
      stats: { trackedChanges: 1, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 1 }
    });
    vi.spyOn(localReviewModule, 'computeLocalDiffDigest').mockResolvedValue('digest123');

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
});
