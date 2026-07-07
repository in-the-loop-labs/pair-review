// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * setupLocalReviewSession scope/base precedence (CLI --scope / --base).
 *
 * Exercises the CLI seam directly (per CLAUDE.md "CLI vs Web UI entry points"):
 * setupLocalReviewSession is the single function both CLI paths (headless and
 * interactive) route through. Git side effects are stubbed via vi.spyOn on the
 * module exports (vi.mock doesn't work for CommonJS require() under the forks
 * pool). No real git, no network, no browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const localReviewModule = require('../../src/local-review');
const summaryGenerator = require('../../src/ai/summary-generator');
const tourGenerator = require('../../src/ai/tour-generator');
const { ReviewRepository } = require('../../src/database');
const { localReviewDiffs } = require('../../src/routes/shared');
// local-review.js uses a namespace import of this module and calls
// baseBranchModule.detectBaseBranch(...), so a spy on this same cached object is
// observed at call time (a destructured binding would not be).
const baseBranchModule = require('../../src/git/base-branch');

describe('setupLocalReviewSession scope/base precedence', () => {
  let db;
  const repoPath = '/mock/repo';
  const config = { port: 7247 };

  beforeEach(() => {
    db = createTestDatabase();

    vi.spyOn(localReviewModule, 'getHeadSha').mockResolvedValue('abc123def456');
    vi.spyOn(localReviewModule, 'getRepositoryName').mockResolvedValue('owner/repo');
    vi.spyOn(localReviewModule, 'getCurrentBranch').mockResolvedValue('feature');
    vi.spyOn(localReviewModule, 'findMainGitRoot').mockResolvedValue('/mock/repo');
    vi.spyOn(localReviewModule, 'generateScopedDiff').mockResolvedValue({
      diff: 'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new',
      stats: { trackedChanges: 1, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 1 },
      mergeBaseSha: null
    });
    vi.spyOn(localReviewModule, 'computeScopedDigest').mockResolvedValue('digest123');
    vi.spyOn(localReviewModule, 'detectAndBuildBranchInfo').mockResolvedValue(null);
    vi.spyOn(localReviewModule, 'findMergeBase').mockResolvedValue('mergebase123');
    // Background jobs are opted out per-call (startBackgroundJobs: false), but
    // stub the kickoffs defensively so a stray call is a no-op, not a real job.
    vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockReturnValue(null);
    vi.spyOn(tourGenerator, 'kickOffTourJob').mockReturnValue(null);
    // Safe defaults for the base-detection + auto-name seams; overridden per test.
    // detectBaseBranch → null means "no base found"; getFirstCommitSubject → null
    // means "no name to apply". Both are harmless no-ops unless a test exercises them.
    vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue(null);
    vi.spyOn(localReviewModule, 'getFirstCommitSubject').mockResolvedValue(null);
  });

  afterEach(() => {
    closeTestDatabase(db);
    localReviewDiffs.clear();
    vi.restoreAllMocks();
  });

  const setup = (flags) =>
    localReviewModule.setupLocalReviewSession({ db, config, repoPath, flags, startBackgroundJobs: false });

  it('fresh review + --scope uses the flag scope and persists it', async () => {
    const session = await setup({ scope: 'staged..untracked' });

    expect(session.scopeStart).toBe('staged');
    expect(session.scopeEnd).toBe('untracked');

    const persisted = await new ReviewRepository(db).getLocalReviewById(session.sessionId);
    expect(persisted.local_scope_start).toBe('staged');
    expect(persisted.local_scope_end).toBe('untracked');
    // Non-branch scope leaves head_branch/base cleared.
    expect(persisted.local_head_branch).toBeNull();
    expect(persisted.local_base_branch).toBeNull();
  });

  it('fresh review with no flag falls back to DEFAULT_SCOPE and does not persist a scope override', async () => {
    const session = await setup({});

    expect(session.scopeStart).toBe('unstaged');
    expect(session.scopeEnd).toBe('untracked');

    // The row keeps schema defaults (unstaged..untracked); no explicit override written.
    const persisted = await new ReviewRepository(db).getLocalReviewById(session.sessionId);
    expect(persisted.local_scope_start).toBe('unstaged');
    expect(persisted.local_scope_end).toBe('untracked');
  });

  it('existing persisted scope is overridden by --scope, and the override persists', async () => {
    // First run persists staged..untracked.
    const first = await setup({ scope: 'staged..untracked' });
    const reviewId = first.sessionId;

    // Second run with a different --scope wins and rewrites the persisted scope.
    const second = await setup({ scope: 'unstaged..unstaged' });
    expect(second.sessionId).toBe(reviewId); // same session resumed
    expect(second.scopeStart).toBe('unstaged');
    expect(second.scopeEnd).toBe('unstaged');

    const persisted = await new ReviewRepository(db).getLocalReviewById(reviewId);
    expect(persisted.local_scope_start).toBe('unstaged');
    expect(persisted.local_scope_end).toBe('unstaged');
  });

  it('existing persisted scope is used untouched when no --scope flag is passed', async () => {
    // Persist staged..untracked via a first flagged run.
    const first = await setup({ scope: 'staged..untracked' });
    const reviewId = first.sessionId;

    // Watch updateLocalScope from here on: a no-flag resume must NOT re-persist
    // scope. (Spy set up after the first run so its persist isn't counted.)
    const updateScopeSpy = vi.spyOn(ReviewRepository.prototype, 'updateLocalScope');

    const second = await setup({});
    expect(second.sessionId).toBe(reviewId);
    expect(second.scopeStart).toBe('staged');
    expect(second.scopeEnd).toBe('untracked');
    expect(updateScopeSpy).not.toHaveBeenCalled();

    const persisted = await new ReviewRepository(db).getLocalReviewById(reviewId);
    expect(persisted.local_scope_start).toBe('staged');
    expect(persisted.local_scope_end).toBe('untracked');
  });

  it('--base is persisted with a branch-relative --scope and used for the diff', async () => {
    const session = await setup({ scope: 'branch..untracked', base: 'develop' });

    expect(session.scopeStart).toBe('branch');
    expect(session.scopeEnd).toBe('untracked');
    expect(session.baseBranch).toBe('develop');

    // generateScopedDiff receives the explicit base branch (no detection needed).
    expect(localReviewModule.generateScopedDiff).toHaveBeenCalledWith(
      repoPath, 'branch', 'untracked', 'develop'
    );

    const persisted = await new ReviewRepository(db).getLocalReviewById(session.sessionId);
    expect(persisted.local_scope_start).toBe('branch');
    expect(persisted.local_scope_end).toBe('untracked');
    expect(persisted.local_base_branch).toBe('develop');
    // Branch scope records the current branch as the head branch.
    expect(persisted.local_head_branch).toBe('feature');
    expect(persisted.local_mode).toBe('branch');
  });

  describe('base-branch precedence for branch scopes', () => {
    it('(a) uses persisted local_base_branch without calling detectBaseBranch', async () => {
      // Seed a persisted branch scope with base 'main' (explicit --base, no detection).
      const first = await setup({ scope: 'branch..untracked', base: 'main' });
      baseBranchModule.detectBaseBranch.mockClear();

      // Resume with a branch scope and NO --base: the persisted base must be reused.
      const second = await setup({ scope: 'branch..untracked' });
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.baseBranch).toBe('main');
      expect(baseBranchModule.detectBaseBranch).not.toHaveBeenCalled();

      const persisted = await new ReviewRepository(db).getLocalReviewById(second.sessionId);
      expect(persisted.local_base_branch).toBe('main');
    });

    it('(b) detects the base branch when none is persisted, then uses/persists it', async () => {
      baseBranchModule.detectBaseBranch.mockResolvedValue({ baseBranch: 'main', source: 'github' });

      const session = await setup({ scope: 'branch..untracked' });

      expect(baseBranchModule.detectBaseBranch).toHaveBeenCalledTimes(1);
      expect(session.baseBranch).toBe('main');
      // Detected base flows into the diff...
      expect(localReviewModule.generateScopedDiff).toHaveBeenCalledWith(
        repoPath, 'branch', 'untracked', 'main'
      );
      // ...and is persisted.
      const persisted = await new ReviewRepository(db).getLocalReviewById(session.sessionId);
      expect(persisted.local_base_branch).toBe('main');
    });

    it('(c) rejects when detection finds no base branch', async () => {
      baseBranchModule.detectBaseBranch.mockResolvedValue(null);

      await expect(setup({ scope: 'branch..untracked' })).rejects.toThrow(
        /Could not detect a base branch/
      );
    });

    it('(d) explicit --base wins over a persisted base and persists', async () => {
      const first = await setup({ scope: 'branch..untracked', base: 'develop' });
      baseBranchModule.detectBaseBranch.mockClear();

      const second = await setup({ scope: 'branch..untracked', base: 'main' });
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.baseBranch).toBe('main');
      expect(baseBranchModule.detectBaseBranch).not.toHaveBeenCalled();

      const persisted = await new ReviewRepository(db).getLocalReviewById(second.sessionId);
      expect(persisted.local_base_branch).toBe('main');
    });
  });

  describe('stale base cleared when leaving branch scope (finding 3)', () => {
    it('reopening a branch-scoped review with a non-branch --scope nulls the base everywhere', async () => {
      // Persist a branch scope with base 'develop'.
      const first = await setup({ scope: 'branch..untracked', base: 'develop' });
      localReviewModule.generateScopedDiff.mockClear();

      // Reopen with unstaged..untracked: the stale 'develop' base must be dropped.
      const second = await setup({ scope: 'unstaged..untracked' });
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.baseBranch).toBeNull();

      // The diff generator must not receive the stale base.
      expect(localReviewModule.generateScopedDiff).toHaveBeenCalledWith(
        repoPath, 'unstaged', 'untracked', null
      );

      // The persisted row matches the web set-scope route: base null, mode uncommitted.
      const persisted = await new ReviewRepository(db).getLocalReviewById(second.sessionId);
      expect(persisted.local_scope_start).toBe('unstaged');
      expect(persisted.local_scope_end).toBe('untracked');
      expect(persisted.local_base_branch).toBeNull();
      expect(persisted.local_head_branch).toBeNull();
      expect(persisted.local_mode).toBe('uncommitted');
    });
  });

  describe('auto-name on newly-applied branch scope (finding 4)', () => {
    it('names a fresh, unnamed review from the first commit subject', async () => {
      localReviewModule.getFirstCommitSubject.mockResolvedValue('Implement the widget');

      const session = await setup({ scope: 'branch..untracked', base: 'main' });

      expect(localReviewModule.getFirstCommitSubject).toHaveBeenCalledWith(repoPath, 'main');
      const persisted = await new ReviewRepository(db).getLocalReviewById(session.sessionId);
      expect(persisted.name).toBe('Implement the widget');
    });

    it('truncates a long commit subject to 200 characters', async () => {
      const longSubject = 'x'.repeat(250);
      localReviewModule.getFirstCommitSubject.mockResolvedValue(longSubject);

      const session = await setup({ scope: 'branch..untracked', base: 'main' });

      const persisted = await new ReviewRepository(db).getLocalReviewById(session.sessionId);
      expect(persisted.name).toBe('x'.repeat(200));
    });

    it('does NOT auto-name when the review already has a name', async () => {
      // Create an unnamed default-scope session, then give it a name.
      const first = await setup({});
      await new ReviewRepository(db).updateReview(first.sessionId, { name: 'Existing name' });
      localReviewModule.getFirstCommitSubject.mockClear();
      localReviewModule.getFirstCommitSubject.mockResolvedValue('Should not be used');

      // Apply a branch scope: the name must be preserved, auto-name skipped.
      await setup({ scope: 'branch..untracked', base: 'main' });

      expect(localReviewModule.getFirstCommitSubject).not.toHaveBeenCalled();
      const persisted = await new ReviewRepository(db).getLocalReviewById(first.sessionId);
      expect(persisted.name).toBe('Existing name');
    });

    it('does NOT auto-name when the scope was already a branch scope', async () => {
      // Seed a branch-scoped, unnamed review directly (bypass setup's own auto-name).
      const reviewRepo = new ReviewRepository(db);
      const id = await reviewRepo.upsertLocalReview({
        localPath: repoPath,
        localHeadSha: 'abc123def456',
        repository: 'owner/repo',
        localHeadBranch: 'feature'
      });
      await reviewRepo.updateLocalScope(id, 'branch', 'untracked', 'main', 'feature');
      localReviewModule.getFirstCommitSubject.mockResolvedValue('Should not be used');

      // Resume with another branch scope: oldScopeStart is already 'branch', so
      // the "newly entered branch scope" guard is false and auto-name is skipped.
      const session = await setup({ scope: 'branch..unstaged', base: 'main' });
      expect(session.sessionId).toBe(id);
      expect(localReviewModule.getFirstCommitSubject).not.toHaveBeenCalled();

      const persisted = await reviewRepo.getLocalReviewById(id);
      expect(persisted.name).toBeNull();
    });
  });
});
