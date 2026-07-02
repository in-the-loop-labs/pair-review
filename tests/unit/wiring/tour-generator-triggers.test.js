// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tour Generator Trigger Site Wiring Tests
 *
 * Wiring tests verifying that all four kickOffTourJob trigger sites pass
 * through the right shape. Tour generation is independent of summary
 * generation post-decoupling, so the trigger sites must call kickOffTourJob
 * directly (not chain through summary-generator).
 *
 * The four trigger sites:
 *   1. POST /api/local/start                         (web UI start)
 *   2. GET  /api/local/:reviewId                     (web UI load)
 *   3. GET  /api/pr/:owner/:repo/:number             (PR web load)
 *   4. handleLocalReview / setupLocalReviewSession   (CLI entry point)
 *
 * Per CLAUDE.md "CLI vs Web UI entry points," the CLI seam is exercised
 * directly via setupLocalReviewSession().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../../utils/schema';
import { listenOnLoopback, closeServer } from '../../utils/loopback-server';

// vi.mock doesn't work for CommonJS require() under the forks pool, so we use
// vi.spyOn on the actual module exports. The trigger sites call
// tourGenerator.kickOffTourJob (not a destructured binding) so the spy is
// observable at call time. We also spy on summary-generator to keep its real
// implementation from running and coupling the test to summary behavior.
const tourGenerator = require('../../../src/ai/tour-generator');
const summaryGenerator = require('../../../src/ai/summary-generator');
const stackWalkerModule = require('../../../src/github/stack-walker');
const { ReviewRepository } = require('../../../src/database');
const { localReviewDiffs } = require('../../../src/routes/shared');
const localReviewModule = require('../../../src/local-review');
const { run } = require('../../../src/database');

describe('kickOffTourJob trigger sites', () => {
  let app;
  let server;
  let db;

  beforeEach(async () => {
    db = createTestDatabase();

    // Spy on local-review functions to prevent real git operations
    vi.spyOn(localReviewModule, 'findGitRoot').mockResolvedValue('/mock/repo');
    vi.spyOn(localReviewModule, 'getHeadSha').mockResolvedValue('abc123def456');
    vi.spyOn(localReviewModule, 'getRepositoryName').mockResolvedValue('owner/repo');
    vi.spyOn(localReviewModule, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(localReviewModule, 'generateScopedDiff').mockResolvedValue({
      diff: 'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new',
      stats: { trackedChanges: 1, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 1 },
      mergeBaseSha: null
    });
    vi.spyOn(localReviewModule, 'computeScopedDigest').mockResolvedValue('digest123');
    vi.spyOn(localReviewModule, 'detectAndBuildBranchInfo').mockResolvedValue(null);
    vi.spyOn(localReviewModule, 'findMergeBase').mockResolvedValue('mergebase123');
    vi.spyOn(localReviewModule, 'findMainGitRoot').mockResolvedValue('/mock/repo');

    vi.spyOn(tourGenerator, 'kickOffTourJob').mockReturnValue(null);
    vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockReturnValue(null);
    vi.spyOn(stackWalkerModule, 'walkPRStack').mockResolvedValue(null);

    app = express();
    app.use(express.json());
    app.set('db', db);
    app.set('config', {
      tours: { enabled: true },
      port: 7247
    });

    const localRouter = require('../../../src/routes/local');
    const prRouter = require('../../../src/routes/pr');
    app.use(localRouter);
    app.use(prRouter);

    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
    closeTestDatabase(db);
    localReviewDiffs.clear();
    vi.restoreAllMocks();
  });

  describe('POST /api/local/start', () => {
    it('calls kickOffTourJob with reviewId/diffText/worktreePath/db/config and reviewContext.prTitle = branch', async () => {
      const res = await request(server)
        .post('/api/local/start')
        .send({ path: '/tmp' });

      expect(res.status).toBe(200);
      expect(tourGenerator.kickOffTourJob).toHaveBeenCalledTimes(1);

      const call = tourGenerator.kickOffTourJob.mock.calls[0][0];
      expect(call.db).toBe(db);
      expect(call.config).toEqual(expect.objectContaining({ tours: { enabled: true } }));
      expect(call.reviewId).toBe(res.body.sessionId);
      expect(call.diffText).toContain('diff --git');
      expect(call.worktreePath).toBe('/mock/repo');
      expect(call.reviewContext).toEqual({ prTitle: 'main' });
      expect(call.trigger).toBe('auto');
      // The local-start seam must not leak PR-mode shape into local-mode context
      expect(call.reviewContext.changedFiles).toBeUndefined();
    });

    it('still calls kickOffTourJob even when tours.enabled is false (gating happens inside the orchestrator, not at the trigger)', async () => {
      app.set('config', { tours: { enabled: false }, port: 7247 });

      const res = await request(server)
        .post('/api/local/start')
        .send({ path: '/tmp' });

      expect(res.status).toBe(200);
      expect(tourGenerator.kickOffTourJob).toHaveBeenCalledTimes(1);
      const call = tourGenerator.kickOffTourJob.mock.calls[0][0];
      expect(call.config.tours.enabled).toBe(false);
    });

    it('does not throw when kickOffTourJob returns null (optional-chain catch)', async () => {
      tourGenerator.kickOffTourJob.mockReturnValue(null);

      const res = await request(server)
        .post('/api/local/start')
        .send({ path: '/tmp' });

      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/local/:reviewId', () => {
    it('calls kickOffTourJob with the persisted diff and review.local_path as worktreePath', async () => {
      const reviewRepo = new ReviewRepository(db);
      const sessionId = await reviewRepo.upsertLocalReview({
        localPath: '/some/local/path',
        localHeadSha: 'sha-abc',
        repository: 'owner/repo',
        localHeadBranch: 'main'
      });
      await reviewRepo.saveLocalDiff(sessionId, {
        diff: 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b',
        stats: { trackedChanges: 1 },
        digest: 'd1'
      });

      const res = await request(server).get(`/api/local/${sessionId}`);
      expect(res.status).toBe(200);

      expect(tourGenerator.kickOffTourJob).toHaveBeenCalledTimes(1);
      const call = tourGenerator.kickOffTourJob.mock.calls[0][0];
      expect(call.reviewId).toBe(sessionId);
      expect(call.worktreePath).toBe('/some/local/path');
      expect(call.diffText).toContain('diff --git');
      expect(call.reviewContext).toBeDefined();
      expect(call.reviewContext.prTitle).toBe('main');
      expect(call.reviewContext.changedFiles).toBeUndefined();
    });

    it('uses review.name as prTitle when present, falling back to branch otherwise', async () => {
      const reviewRepo = new ReviewRepository(db);
      const sessionId = await reviewRepo.upsertLocalReview({
        localPath: '/some/local/path',
        localHeadSha: 'sha-abc',
        repository: 'owner/repo',
        localHeadBranch: 'main'
      });
      await reviewRepo.updateReview(sessionId, { name: 'My Local Review' });
      await reviewRepo.saveLocalDiff(sessionId, {
        diff: 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b',
        stats: { trackedChanges: 1 },
        digest: 'd1'
      });

      const res = await request(server).get(`/api/local/${sessionId}`);
      expect(res.status).toBe(200);

      const call = tourGenerator.kickOffTourJob.mock.calls[0][0];
      expect(call.reviewContext.prTitle).toBe('My Local Review');
    });

    it('skips kickOffTourJob when no diff is available (cache miss + no DB row)', async () => {
      const reviewRepo = new ReviewRepository(db);
      const sessionId = await reviewRepo.upsertLocalReview({
        localPath: '/some/local/path',
        localHeadSha: 'sha-abc',
        repository: 'owner/repo',
        localHeadBranch: 'main'
      });
      // No saveLocalDiff call — DB has no row.

      const res = await request(server).get(`/api/local/${sessionId}`);
      expect(res.status).toBe(200);

      expect(tourGenerator.kickOffTourJob).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/pr/:owner/:repo/:number', () => {
    it('calls kickOffTourJob with reviewContext (prTitle, prDescription, changedFiles)', async () => {
      const prData = JSON.stringify({
        state: 'open',
        diff: 'diff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-old\n+new',
        worktree_path: '/tmp/worktree/pr-1',
        changed_files: [
          { file: 'foo.js', additions: 1, deletions: 1 },
          { file: 'bar.js', additions: 2, deletions: 0 }
        ],
        additions: 3,
        deletions: 1,
        html_url: 'https://github.com/owner/repo/pull/1',
        base_sha: 'abc',
        head_sha: 'def'
      });

      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [1, 'owner/repo', 'My PR', 'A description', 'alice', 'main', 'feature', prData]);

      // Ensure no GitHub token so the pendingDraft branch is skipped
      app.set('config', { tours: { enabled: true }, port: 7247 });

      const res = await request(server).get('/api/pr/owner/repo/1');
      expect(res.status).toBe(200);

      expect(tourGenerator.kickOffTourJob).toHaveBeenCalledTimes(1);
      const call = tourGenerator.kickOffTourJob.mock.calls[0][0];
      expect(call.db).toBe(db);
      expect(call.reviewId).toBe(res.body.data.id);
      expect(call.diffText).toContain('diff --git');
      expect(call.worktreePath).toBe('/tmp/worktree/pr-1');
      expect(call.reviewContext).toBeDefined();
      expect(call.reviewContext.prTitle).toBe('My PR');
      expect(call.reviewContext.prDescription).toBe('A description');
      expect(Array.isArray(call.reviewContext.changedFiles)).toBe(true);
      expect(call.reviewContext.changedFiles).toEqual(
        expect.arrayContaining(['foo.js', 'bar.js'])
      );
    });
  });

  describe('Local CLI: handleLocalReview via setupLocalReviewSession', () => {
    it('calls kickOffTourJob with reviewContext.prTitle = branch when tours.enabled is true', async () => {
      const config = { tours: { enabled: true }, port: 7247 };

      const session = await localReviewModule.setupLocalReviewSession({
        db,
        config,
        repoPath: '/mock/repo',
        flags: {}
      });

      expect(tourGenerator.kickOffTourJob).toHaveBeenCalledTimes(1);
      const call = tourGenerator.kickOffTourJob.mock.calls[0][0];
      expect(call.db).toBe(db);
      expect(call.config).toEqual(expect.objectContaining({ tours: { enabled: true } }));
      expect(call.reviewId).toBe(session.sessionId);
      expect(call.diffText).toContain('diff --git');
      expect(call.worktreePath).toBe('/mock/repo');
      expect(call.reviewContext).toEqual({ prTitle: 'main' });
      expect(call.trigger).toBe('auto');
    });

    it('still calls kickOffTourJob when tours.enabled is false (trigger is dumb; orchestrator gates)', async () => {
      const config = { tours: { enabled: false }, port: 7247 };

      await localReviewModule.setupLocalReviewSession({
        db,
        config,
        repoPath: '/mock/repo',
        flags: {}
      });

      expect(tourGenerator.kickOffTourJob).toHaveBeenCalledTimes(1);
      const call = tourGenerator.kickOffTourJob.mock.calls[0][0];
      expect(call.config.tours.enabled).toBe(false);
      expect(call.reviewContext).toEqual({ prTitle: 'main' });
    });

    it('does NOT call kickOffTourJob when startBackgroundJobs is false (headless one-shot)', async () => {
      // tours.enabled is true; only the explicit opt-out the headless path passes
      // suppresses the job. Guards the CLI-hang / wasted-budget fix.
      const config = { tours: { enabled: true }, port: 7247 };

      const session = await localReviewModule.setupLocalReviewSession({
        db,
        config,
        repoPath: '/mock/repo',
        flags: {},
        startBackgroundJobs: false
      });

      expect(session.sessionId).toBeDefined();
      expect(tourGenerator.kickOffTourJob).not.toHaveBeenCalled();
    });
  });
});
