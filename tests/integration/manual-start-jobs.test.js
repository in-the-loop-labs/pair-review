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
import { execSync } from 'child_process';
import express from 'express';
import nodeFs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const prRouter = require('../../src/routes/pr');
const localRouter = require('../../src/routes/local');
const { ReviewRepository, run } = require('../../src/database');
const summaryGenerator = require('../../src/ai/summary-generator');
const tourGenerator = require('../../src/ai/tour-generator');
const { backgroundQueue } = require('../../src/ai/background-queue');
const { localReviewDiffs } = require('../../src/routes/shared');

/**
 * Create a throwaway git repo with an unstaged change so the manual-start
 * handler's working-tree regeneration (scope-aware) produces a real diff.
 * Returns the repo path; caller is responsible for cleanup.
 */
function createTempRepoWithChanges() {
  const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-manual-start-'));
  execSync('git init -b main', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: tempRepo, stdio: 'pipe' });
  const repoFile = path.join(tempRepo, 'file.js');
  nodeFs.writeFileSync(repoFile, 'line 1\nline 2\nline 3\n');
  execSync('git add file.js', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: tempRepo, stdio: 'pipe' });
  // Unstaged modification — falls within the default 'unstaged'→'untracked' scope.
  nodeFs.writeFileSync(repoFile, 'line 1 changed\nline 2\nline 3\nline 4 added\n');
  return tempRepo;
}

/**
 * Create a throwaway git repo with a clean working tree (a committed file and
 * NO unstaged/untracked changes). Working-tree regeneration succeeds but
 * produces an empty diff, exercising the genuine "no changes in scope" path
 * (as opposed to the regeneration-throws path). Caller cleans up.
 */
function createTempRepoNoChanges() {
  const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-manual-start-clean-'));
  execSync('git init -b main', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: tempRepo, stdio: 'pipe' });
  const repoFile = path.join(tempRepo, 'file.js');
  nodeFs.writeFileSync(repoFile, 'line 1\nline 2\nline 3\n');
  execSync('git add file.js', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: tempRepo, stdio: 'pipe' });
  // No further edits — the working tree is clean, so the default-scope diff is empty.
  return tempRepo;
}

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
    // The manual-start handler caches regenerated diffs in this module-level
    // Map (keyed by reviewId). Clear it so an entry from one test cannot make a
    // later test reusing the same reviewId see a diff it never seeded.
    localReviewDiffs.clear();
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

    it('returns no-diff when regeneration fails (worktree missing) and no diff is cached', async () => {
      // The toast must still appear when the diff cannot be resolved at all.
      // There is no local_diffs row, no in-memory cache entry, and the
      // (non-existent) local_path makes working-tree regeneration throw, which
      // the handler catches and treats as an empty diff → no-diff. This covers
      // the regeneration-error fallthrough; the genuine clean-working-tree case
      // is covered by the next test.
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

    it('returns no-diff when the working tree is clean (genuinely no changes in scope)', async () => {
      // The toast must appear when there is truly nothing to review: a real git
      // repo with a committed file and no unstaged/untracked changes. There is
      // no local_diffs row and no in-memory cache entry, so the handler
      // regenerates from the working tree — regeneration SUCCEEDS but yields an
      // empty diff (default 'unstaged'→'untracked' scope, clean tree) → no-diff.
      // We seed the review's recorded HEAD to the repo's REAL HEAD so the
      // snapshot guard passes and regen actually runs (rather than being
      // blocked for a moved HEAD, which would be the wrong reason for no-diff).
      const tempRepo = createTempRepoNoChanges();
      try {
        const app = buildApp(db, { summaries: { enabled: true } });
        const reviewRepo = new ReviewRepository(db);
        const realHead = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
        const reviewId = await reviewRepo.upsertLocalReview({
          localPath: tempRepo,
          localHeadSha: realHead,
          repository: 'owner/repo',
          localHeadBranch: 'main',
        });
        expect(await reviewRepo.getLocalDiff(reviewId)).toBeNull();

        const res = await request(app).post(`/api/local/${reviewId}/jobs/summary/start`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ started: false, reason: 'no-diff' });
        expect(summarySpy).not.toHaveBeenCalled();
      } finally {
        nodeFs.rmSync(tempRepo, { recursive: true, force: true });
      }
    });

    it('regenerates the diff from the working tree when no local_diffs row exists', async () => {
      // Regression for the reported bug: a local review created via an
      // analysis/council/MCP path never wrote local_diffs, so the DB-only read
      // falsely reported no-diff. The handler must now regenerate from the live
      // working tree, kick the job, and persist the diff for next time.
      const tempRepo = createTempRepoWithChanges();
      try {
        const app = buildApp(db, { tours: { enabled: true, auto_generate: false } });
        const reviewRepo = new ReviewRepository(db);
        // Seed the review's recorded HEAD to the repo's REAL HEAD so the
        // snapshot guard (non-branch HEAD-pinning) passes and regeneration runs.
        // A fake SHA would now be (correctly) blocked by the moved-HEAD guard.
        const realHead = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
        const reviewId = await reviewRepo.upsertLocalReview({
          localPath: tempRepo,
          localHeadSha: realHead,
          repository: 'owner/repo',
          localHeadBranch: 'main',
        });
        // Intentionally no saveLocalDiff and no in-memory cache entry.
        expect(await reviewRepo.getLocalDiff(reviewId)).toBeNull();

        const res = await request(app).post(`/api/local/${reviewId}/jobs/tour/start`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ started: true, alreadyRunning: false });
        expect(tourSpy).toHaveBeenCalledTimes(1);
        const call = tourSpy.mock.calls[0][0];
        expect(call.trigger).toBe('manual');
        expect(call.diffText).toContain('diff --git');
        expect(call.worktreePath).toBe(tempRepo);

        // The regenerated diff is now durably persisted (self-heal).
        const persisted = await reviewRepo.getLocalDiff(reviewId);
        expect(persisted).not.toBeNull();
        expect(persisted.diff).toContain('diff --git');
      } finally {
        nodeFs.rmSync(tempRepo, { recursive: true, force: true });
      }
    });

    it('does NOT regenerate (no-diff) for a non-branch review whose HEAD has moved', async () => {
      // Regression for the snapshot-invariant bug: the self-heal regen block used
      // to persist a diff describing the CURRENT worktree onto a review row still
      // pinned to the OLDER local_head_sha. For a non-branch review whose HEAD has
      // since moved, regenerating + persisting here would silently re-snapshot the
      // moved HEAD onto a pinned review — the same hole the refresh-diff handler
      // closes by routing through resolve-head-change. The guard must now BLOCK
      // regen: no generator call, no persisted local_diffs row, and a no-diff
      // response so the user is funneled through the established flow.
      //
      // NOTE: without the guard this test FAILS — regen would succeed against the
      // (changed) working tree and return { started: true }.
      const tempRepo = createTempRepoWithChanges();
      try {
        const app = buildApp(db, { tours: { enabled: true, auto_generate: false } });
        const reviewRepo = new ReviewRepository(db);
        // Pin the review to the repo's INITIAL HEAD...
        const initialHead = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
        const reviewId = await reviewRepo.upsertLocalReview({
          localPath: tempRepo,
          localHeadSha: initialHead,
          repository: 'owner/repo',
          localHeadBranch: 'main',
        });
        // ...then move HEAD by committing a new change so current HEAD differs.
        nodeFs.writeFileSync(path.join(tempRepo, 'file2.js'), 'new file\n');
        execSync('git add file2.js', { cwd: tempRepo, stdio: 'pipe' });
        execSync('git commit -m "second"', { cwd: tempRepo, stdio: 'pipe' });
        const movedHead = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
        expect(movedHead).not.toBe(initialHead);

        // No cache entry, no local_diffs row.
        expect(await reviewRepo.getLocalDiff(reviewId)).toBeNull();

        const res = await request(app).post(`/api/local/${reviewId}/jobs/tour/start`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ started: false, reason: 'no-diff' });
        // Guard blocked regen: generator not called and nothing persisted.
        expect(tourSpy).not.toHaveBeenCalled();
        expect(await reviewRepo.getLocalDiff(reviewId)).toBeNull();
      } finally {
        nodeFs.rmSync(tempRepo, { recursive: true, force: true });
      }
    });

    it('STILL regenerates for a branch-scoped review whose HEAD has moved', async () => {
      // Branch-scoped reviews persist across HEAD changes (the diff is computed
      // against the base branch, not a pinned HEAD snapshot), so the snapshot
      // guard must NOT block them. Even with a moved HEAD, regen runs and the job
      // starts. This complements the non-branch regression test above.
      const tempRepo = createTempRepoWithChanges();
      try {
        const app = buildApp(db, { tours: { enabled: true, auto_generate: false } });
        const reviewRepo = new ReviewRepository(db);
        const initialHead = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
        // Branch scope: start='branch', end='unstaged', with a base branch.
        const reviewId = await reviewRepo.upsertLocalReview({
          localPath: tempRepo,
          localHeadSha: initialHead,
          repository: 'owner/repo',
          localHeadBranch: 'main',
          scopeStart: 'branch',
          scopeEnd: 'unstaged',
          localBaseBranch: 'main',
        });
        // Move HEAD: create a feature branch with a new commit so there is a
        // branch-ahead diff against the 'main' base branch.
        execSync('git checkout -b feature', { cwd: tempRepo, stdio: 'pipe' });
        nodeFs.writeFileSync(path.join(tempRepo, 'file3.js'), 'branch change\n');
        execSync('git add file3.js', { cwd: tempRepo, stdio: 'pipe' });
        execSync('git commit -m "feature commit"', { cwd: tempRepo, stdio: 'pipe' });
        const movedHead = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
        expect(movedHead).not.toBe(initialHead);

        expect(await reviewRepo.getLocalDiff(reviewId)).toBeNull();

        const res = await request(app).post(`/api/local/${reviewId}/jobs/tour/start`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ started: true, alreadyRunning: false });
        expect(tourSpy).toHaveBeenCalledTimes(1);
        expect(tourSpy.mock.calls[0][0].diffText).toContain('diff --git');
      } finally {
        nodeFs.rmSync(tempRepo, { recursive: true, force: true });
      }
    });

    it('starts the job from the in-memory diff cache when no DB row exists', async () => {
      // The analysis/council paths populate the in-memory cache before any DB
      // write. The handler must honor that cache without needing a local_diffs
      // row and without touching the working tree.
      const app = buildApp(db, { tours: { enabled: true, auto_generate: false } });
      const reviewRepo = new ReviewRepository(db);
      const reviewId = await reviewRepo.upsertLocalReview({
        localPath: '/mock/repo',
        localHeadSha: 'abc123',
        repository: 'owner/repo',
        localHeadBranch: 'main',
      });
      // Seed only the module-level in-memory cache (keyed by integer reviewId).
      localReviewDiffs.set(reviewId, {
        diff: SAMPLE_DIFF,
        stats: { trackedChanges: 1 },
        digest: 'mem-1',
      });
      expect(await reviewRepo.getLocalDiff(reviewId)).toBeNull();

      const res = await request(app).post(`/api/local/${reviewId}/jobs/tour/start`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: true, alreadyRunning: false });
      expect(tourSpy).toHaveBeenCalledTimes(1);
      expect(tourSpy.mock.calls[0][0].diffText).toContain('diff --git');
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
