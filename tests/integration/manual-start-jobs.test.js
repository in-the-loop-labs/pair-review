// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the manual summary/tour generation start endpoints.
 *
 * Covers BOTH modes (CLAUDE.md parity requirement):
 *   - POST /api/pr/:owner/:repo/:number/jobs/:jobKey/start   (PR mode)
 *   - POST /api/local/:reviewId/jobs/:jobKey/start           (local mode)
 *
 * These endpoints back the "click to generate" toolbar behavior used when a
 * feature's `auto_generate` flag is off. They must:
 *   - 409 when the feature is disabled in config
 *   - 400 for an unknown jobKey
 *   - 200 { started: true } and kick the job with trigger: 'manual' when enabled
 *   - 200 { started: false, alreadyRunning: true } when a job is in flight
 *   - 200 { started: false, reason: 'no-diff' } when there is no diff/worktree
 *
 * The generators are spied so no real provider/CLI runs; we assert on the
 * kickoff call shape (notably trigger: 'manual') rather than on generation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const prRouter = require('../../src/routes/pr');
const localRouter = require('../../src/routes/local');
const { ReviewRepository, run } = require('../../src/database');
const summaryGenerator = require('../../src/ai/summary-generator');
const tourGenerator = require('../../src/ai/tour-generator');
const { backgroundQueue } = require('../../src/ai/background-queue');

const SAMPLE_DIFF =
  'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new';

function buildApp(db, config) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', '');
  app.set('config', { port: 7247, ...config });
  app.use(prRouter);
  app.use(localRouter);
  return app;
}

async function seedPr(db, { prNumber = 1, repository = 'owner/repo' } = {}) {
  const prData = JSON.stringify({
    state: 'open',
    diff: SAMPLE_DIFF,
    worktree_path: '/tmp/worktree/pr-1',
    changed_files: [{ file: 'file.js', additions: 1, deletions: 1 }],
    html_url: 'https://github.com/owner/repo/pull/1',
  });
  await run(
    db,
    `INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [prNumber, repository, 'My PR', 'A description', 'alice', 'main', 'feature', prData]
  );
}

async function seedLocal(db) {
  const reviewRepo = new ReviewRepository(db);
  const reviewId = await reviewRepo.upsertLocalReview({
    localPath: '/mock/repo',
    localHeadSha: 'abc123',
    repository: 'owner/repo',
    localHeadBranch: 'main',
  });
  await reviewRepo.saveLocalDiff(reviewId, {
    diff: SAMPLE_DIFF,
    stats: { trackedChanges: 1 },
    digest: 'd1',
  });
  return reviewId;
}

describe('Manual start endpoints', () => {
  let db;
  let summarySpy;
  let tourSpy;
  let findActiveSpy;

  beforeEach(() => {
    db = createTestDatabase();
    // Spy the generators so no real provider/CLI runs. Return null (the
    // "nothing enqueued" shape the kickoffs use when gated).
    summarySpy = vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockReturnValue(null);
    tourSpy = vi.spyOn(tourGenerator, 'kickOffTourJob').mockReturnValue(null);
    // Default: no job in flight. Individual tests override to simulate one.
    findActiveSpy = vi.spyOn(backgroundQueue, 'findActiveJobType').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
  });

  describe('PR mode: POST /api/pr/:owner/:repo/:number/jobs/:jobKey/start', () => {
    it('returns 409 when summaries are disabled', async () => {
      const app = buildApp(db, { summaries: { enabled: false } });
      await seedPr(db);
      const res = await request(app).post('/api/pr/owner/repo/1/jobs/summary/start');
      expect(res.status).toBe(409);
      expect(summarySpy).not.toHaveBeenCalled();
    });

    it('returns 409 when tours are disabled', async () => {
      const app = buildApp(db, { tours: { enabled: false } });
      await seedPr(db);
      const res = await request(app).post('/api/pr/owner/repo/1/jobs/tour/start');
      expect(res.status).toBe(409);
      expect(tourSpy).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown jobKey', async () => {
      const app = buildApp(db, { summaries: { enabled: true } });
      await seedPr(db);
      const res = await request(app).post('/api/pr/owner/repo/1/jobs/bogus/start');
      expect(res.status).toBe(400);
    });

    it('returns 404 when the PR is not found', async () => {
      const app = buildApp(db, { summaries: { enabled: true } });
      const res = await request(app).post('/api/pr/owner/repo/999/jobs/summary/start');
      expect(res.status).toBe(404);
    });

    it('starts a summary job with trigger: manual when enabled', async () => {
      const app = buildApp(db, { summaries: { enabled: true, auto_generate: false } });
      await seedPr(db);
      const res = await request(app).post('/api/pr/owner/repo/1/jobs/summary/start');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: true, alreadyRunning: false });
      expect(summarySpy).toHaveBeenCalledTimes(1);
      const call = summarySpy.mock.calls[0][0];
      expect(call.trigger).toBe('manual');
      expect(call.diffText).toContain('diff --git');
      expect(call.worktreePath).toBe('/tmp/worktree/pr-1');
    });

    it('starts a tour job with trigger: manual when enabled', async () => {
      const app = buildApp(db, { tours: { enabled: true, auto_generate: false } });
      await seedPr(db);
      const res = await request(app).post('/api/pr/owner/repo/1/jobs/tour/start');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: true, alreadyRunning: false });
      expect(tourSpy).toHaveBeenCalledTimes(1);
      expect(tourSpy.mock.calls[0][0].trigger).toBe('manual');
    });

    it('is idempotent: returns alreadyRunning when a job is in flight', async () => {
      findActiveSpy.mockReturnValue('summaries:abc123');
      const app = buildApp(db, { summaries: { enabled: true } });
      await seedPr(db);
      const res = await request(app).post('/api/pr/owner/repo/1/jobs/summary/start');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: false, alreadyRunning: true });
      expect(summarySpy).not.toHaveBeenCalled();
    });

    it('returns no-diff when the PR has no diff in pr_data', async () => {
      const app = buildApp(db, { summaries: { enabled: true } });
      // Seed a pr_metadata row whose pr_data has no diff (and no worktree_path).
      const prData = JSON.stringify({ state: 'open' });
      await run(
        db,
        `INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [2, 'owner/repo', 'Empty PR', '', 'bob', 'main', 'empty', prData]
      );
      const res = await request(app).post('/api/pr/owner/repo/2/jobs/summary/start');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: false, reason: 'no-diff' });
      expect(summarySpy).not.toHaveBeenCalled();
    });
  });

  describe('Local mode: POST /api/local/:reviewId/jobs/:jobKey/start', () => {
    it('returns 409 when summaries are disabled', async () => {
      const app = buildApp(db, { summaries: { enabled: false } });
      const reviewId = await seedLocal(db);
      const res = await request(app).post(`/api/local/${reviewId}/jobs/summary/start`);
      expect(res.status).toBe(409);
      expect(summarySpy).not.toHaveBeenCalled();
    });

    it('returns 409 when tours are disabled', async () => {
      const app = buildApp(db, { tours: { enabled: false } });
      const reviewId = await seedLocal(db);
      const res = await request(app).post(`/api/local/${reviewId}/jobs/tour/start`);
      expect(res.status).toBe(409);
      expect(tourSpy).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown jobKey', async () => {
      const app = buildApp(db, { summaries: { enabled: true } });
      const reviewId = await seedLocal(db);
      const res = await request(app).post(`/api/local/${reviewId}/jobs/bogus/start`);
      expect(res.status).toBe(400);
    });

    it('returns 404 when the local review is not found', async () => {
      const app = buildApp(db, { summaries: { enabled: true } });
      const res = await request(app).post('/api/local/999999/jobs/summary/start');
      expect(res.status).toBe(404);
    });

    it('starts a summary job with trigger: manual when enabled', async () => {
      const app = buildApp(db, { summaries: { enabled: true, auto_generate: false } });
      const reviewId = await seedLocal(db);
      const res = await request(app).post(`/api/local/${reviewId}/jobs/summary/start`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: true, alreadyRunning: false });
      expect(summarySpy).toHaveBeenCalledTimes(1);
      const call = summarySpy.mock.calls[0][0];
      expect(call.trigger).toBe('manual');
      expect(call.reviewId).toBe(reviewId);
      expect(call.diffText).toContain('diff --git');
      expect(call.worktreePath).toBe('/mock/repo');
    });

    it('starts a tour job with trigger: manual when enabled', async () => {
      const app = buildApp(db, { tours: { enabled: true, auto_generate: false } });
      const reviewId = await seedLocal(db);
      const res = await request(app).post(`/api/local/${reviewId}/jobs/tour/start`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: true, alreadyRunning: false });
      expect(tourSpy).toHaveBeenCalledTimes(1);
      expect(tourSpy.mock.calls[0][0].trigger).toBe('manual');
    });

    it('returns no-diff when the local review has no persisted diff', async () => {
      const app = buildApp(db, { summaries: { enabled: true } });
      const reviewRepo = new ReviewRepository(db);
      const reviewId = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'abc123',
        repository: 'owner/repo',
        localHeadBranch: 'main',
      });
      // No saveLocalDiff — no diff row.
      const res = await request(app).post(`/api/local/${reviewId}/jobs/summary/start`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: false, reason: 'no-diff' });
      expect(summarySpy).not.toHaveBeenCalled();
    });

    it('is idempotent: returns alreadyRunning when a job is in flight', async () => {
      findActiveSpy.mockReturnValue('tour');
      const app = buildApp(db, { tours: { enabled: true } });
      const reviewId = await seedLocal(db);
      const res = await request(app).post(`/api/local/${reviewId}/jobs/tour/start`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: false, alreadyRunning: true });
      expect(tourSpy).not.toHaveBeenCalled();
    });
  });
});
