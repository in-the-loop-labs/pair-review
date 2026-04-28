// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Summary Generator Trigger Site Tests
 *
 * Verifies that three of the four kickOffSummaryJob trigger sites (Local web
 * start, Local web load, PR web load) call the orchestrator with the correct
 * arguments. These tests isolate the WIRING from the orchestrator itself by
 * mocking out src/ai/summary-generator.
 *
 * TODO(local-cli): the fourth trigger site — handleLocalReview in
 * src/local-review.js — is currently UNTESTED. Per CLAUDE.md "CLI vs Web UI
 * entry points," dual-entry behavior must be exercised from both paths. The
 * recommended fix is to extract setupLocalReviewSession() so the CLI seam can
 * be invoked directly without spying out every git helper. Until then,
 * removing the kickOff call from src/local-review.js will not fail any test.
 *
 * The orchestrator's gating logic (summaries_enabled flag, missing args) is
 * covered by tests/unit/summary-generator.test.js. Here we verify only that
 * the trigger sites pass through the right shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

// vi.mock doesn't work for CommonJS require() under the forks pool, so we use
// vi.spyOn on the actual module exports. The trigger sites call
// summaryGenerator.kickOffSummaryJob (not a destructured binding) so the spy
// is observable at call time. Returning null mimics the "feature gated off"
// path; the trigger sites use optional-chained .catch which must tolerate null.
const summaryGenerator = require('../../src/ai/summary-generator');
const stackWalkerModule = require('../../src/github/stack-walker');
const { ReviewRepository } = require('../../src/database');
const { localReviewDiffs } = require('../../src/routes/shared');
const localReviewModule = require('../../src/local-review');
const { run } = require('../../src/database');

describe('kickOffSummaryJob trigger sites', () => {
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
      diff: 'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new',
      stats: { trackedChanges: 1, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 1 },
      mergeBaseSha: null
    });
    vi.spyOn(localReviewModule, 'computeScopedDigest').mockResolvedValue('digest123');
    vi.spyOn(localReviewModule, 'detectAndBuildBranchInfo').mockResolvedValue(null);
    vi.spyOn(localReviewModule, 'findMergeBase').mockResolvedValue('mergebase123');

    vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockReturnValue(null);
    vi.spyOn(stackWalkerModule, 'walkPRStack').mockResolvedValue(null);

    app = express();
    app.use(express.json());
    app.set('db', db);
    app.set('config', {
      summaries_enabled: true,
      port: 7247
    });

    const localRouter = require('../../src/routes/local');
    const prRouter = require('../../src/routes/pr');
    app.use(localRouter);
    app.use(prRouter);
  });

  afterEach(() => {
    closeTestDatabase(db);
    localReviewDiffs.clear();
    vi.restoreAllMocks();
  });

  describe('POST /api/local/start', () => {
    it('calls kickOffSummaryJob with reviewId/diffText/worktreePath/db/config when summaries_enabled is true', async () => {
      const res = await request(app)
        .post('/api/local/start')
        .send({ path: '/tmp' });

      expect(res.status).toBe(200);
      expect(summaryGenerator.kickOffSummaryJob).toHaveBeenCalledTimes(1);

      const call = summaryGenerator.kickOffSummaryJob.mock.calls[0][0];
      expect(call.db).toBe(db);
      expect(call.config).toEqual(expect.objectContaining({ summaries_enabled: true }));
      expect(call.reviewId).toBe(res.body.sessionId);
      expect(call.diffText).toContain('diff --git');
      expect(call.worktreePath).toBe('/mock/repo');
    });

    it('still calls kickOffSummaryJob even when summaries_enabled is false (gating happens inside the orchestrator, not at the trigger)', async () => {
      app.set('config', { summaries_enabled: false, port: 7247 });

      const res = await request(app)
        .post('/api/local/start')
        .send({ path: '/tmp' });

      expect(res.status).toBe(200);
      expect(summaryGenerator.kickOffSummaryJob).toHaveBeenCalledTimes(1);
      const call = summaryGenerator.kickOffSummaryJob.mock.calls[0][0];
      expect(call.config.summaries_enabled).toBe(false);
    });

    it('does not throw when kickOffSummaryJob returns null (optional-chain catch)', async () => {
      summaryGenerator.kickOffSummaryJob.mockReturnValue(null);

      const res = await request(app)
        .post('/api/local/start')
        .send({ path: '/tmp' });

      expect(res.status).toBe(200);
    });

    it('is invoked twice across two POST calls; the trigger does no dedup itself (queue handles dedup)', async () => {
      await request(app).post('/api/local/start').send({ path: '/tmp' });
      await request(app).post('/api/local/start').send({ path: '/tmp' });

      expect(summaryGenerator.kickOffSummaryJob).toHaveBeenCalledTimes(2);
      const firstReviewId = summaryGenerator.kickOffSummaryJob.mock.calls[0][0].reviewId;
      const secondReviewId = summaryGenerator.kickOffSummaryJob.mock.calls[1][0].reviewId;
      // Same path/sha/branch reuses the same session
      expect(secondReviewId).toBe(firstReviewId);
    });
  });

  describe('GET /api/local/:reviewId', () => {
    it('calls kickOffSummaryJob with the persisted diff and review.local_path as worktreePath', async () => {
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

      const res = await request(app).get(`/api/local/${sessionId}`);
      expect(res.status).toBe(200);

      expect(summaryGenerator.kickOffSummaryJob).toHaveBeenCalledTimes(1);
      const call = summaryGenerator.kickOffSummaryJob.mock.calls[0][0];
      expect(call.reviewId).toBe(sessionId);
      expect(call.worktreePath).toBe('/some/local/path');
      expect(call.diffText).toContain('diff --git');
    });

    it('skips kickOffSummaryJob when no diff is available (cache miss + no DB row)', async () => {
      const reviewRepo = new ReviewRepository(db);
      const sessionId = await reviewRepo.upsertLocalReview({
        localPath: '/some/local/path',
        localHeadSha: 'sha-abc',
        repository: 'owner/repo',
        localHeadBranch: 'main'
      });
      // No saveLocalDiff call — DB has no row.

      const res = await request(app).get(`/api/local/${sessionId}`);
      expect(res.status).toBe(200);

      expect(summaryGenerator.kickOffSummaryJob).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/pr/:owner/:repo/:number', () => {
    it('calls kickOffSummaryJob with reviewContext (prTitle, prDescription, changedFiles)', async () => {
      // Insert a PR row with diff + worktree_path + changed_files in pr_data JSON
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
      app.set('config', { summaries_enabled: true, port: 7247 });

      const res = await request(app).get('/api/pr/owner/repo/1');
      expect(res.status).toBe(200);

      expect(summaryGenerator.kickOffSummaryJob).toHaveBeenCalledTimes(1);
      const call = summaryGenerator.kickOffSummaryJob.mock.calls[0][0];
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
});
