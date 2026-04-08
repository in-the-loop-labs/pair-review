// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { WorktreePoolLifecycle } = require('../../src/git/worktree-pool-lifecycle.js');
const { GRACE_PERIOD_MS } = require('../../src/git/worktree-pool-usage.js');

function createMockDeps() {
  const mockGit = {
    getRemotes: vi.fn().mockResolvedValue([{ name: 'origin' }]),
    fetch: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
    clean: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
  };

  const mockWorktreeManagerInstance = {
    createWorktreeForPR: vi.fn().mockResolvedValue({ path: '/tmp/worktree/pair-review--abc', id: 'pair-review--abc' }),
    refreshWorktree: vi.fn().mockResolvedValue('/tmp/worktree/pair-review--abc'),
    executeCheckoutScript: vi.fn().mockResolvedValue(undefined),
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
  };

  // Must use function (not arrow) so it can be called with `new`
  const MockGitWorktreeManager = vi.fn().mockImplementation(function () {
    Object.assign(this, mockWorktreeManagerInstance);
  });

  const mockUsageTracker = {
    addSession: vi.fn(),
    removeSession: vi.fn(),
    addAnalysis: vi.fn(),
    removeAnalysis: vi.fn(),
    removeAnalysisById: vi.fn(),
    clearWorktree: vi.fn(),
    getActiveAnalyses: vi.fn().mockReturnValue(new Set()),
    isInUse: vi.fn().mockReturnValue(false),
    onIdle: null,
    reset: vi.fn(),
  };

  return {
    fs: {
      existsSync: vi.fn().mockReturnValue(true),
    },
    poolRepo: {
      claimByPR: vi.fn().mockResolvedValue(null),
      claimAvailable: vi.fn().mockResolvedValue(null),
      findByPR: vi.fn().mockResolvedValue(null),
      findAvailable: vi.fn().mockResolvedValue(null),
      findByReviewId: vi.fn().mockResolvedValue(null),
      countForRepo: vi.fn().mockResolvedValue(0),
      reserveSlot: vi.fn().mockResolvedValue(true),
      finalizeReservation: vi.fn().mockResolvedValue(undefined),
      deleteReservation: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
      markInUse: vi.fn().mockResolvedValue(undefined),
      markAvailable: vi.fn().mockResolvedValue(undefined),
      markSwitching: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      setCurrentReviewId: vi.fn().mockResolvedValue(undefined),
      getPoolEntry: vi.fn().mockResolvedValue(null),
      resetStaleAndPreserve: vi.fn().mockResolvedValue([]),
      findOrphanWorktrees: vi.fn().mockResolvedValue([]),
    },
    worktreeRepo: {
      findById: vi.fn().mockResolvedValue(null),
      findByPR: vi.fn().mockResolvedValue({ id: 'pair-review--abc', pr_number: 123, path: '/tmp/worktree/pair-review--abc' }),
      findByPath: vi.fn().mockResolvedValue({ id: 'pair-review--abc', pr_number: 123, path: '/tmp/worktree/pair-review--abc' }),
      switchPR: vi.fn().mockResolvedValue([]),
      updateLastAccessed: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(true),
    },
    usageTracker: mockUsageTracker,
    simpleGit: vi.fn(() => mockGit),
    GitWorktreeManager: MockGitWorktreeManager,
    _mockGit: mockGit,
    _mockWorktreeManagerInstance: mockWorktreeManagerInstance,
    _mockUsageTracker: mockUsageTracker,
  };
}

const prInfo = { owner: 'test', repo: 'repo', prNumber: 123, repository: 'test/repo' };
const prData = {
  head: { sha: 'abc123', ref: 'feature-branch' },
  base: { sha: 'def456', ref: 'main' },
};
const options = {
  worktreeSourcePath: '/tmp/source',
  checkoutScript: null,
  checkoutTimeout: 300000,
  resetScript: null,
  worktreeConfig: {},
  poolSize: 3,
};

describe('WorktreePoolLifecycle', () => {
  let deps;
  let lifecycle;

  beforeEach(() => {
    deps = createMockDeps();
    lifecycle = new WorktreePoolLifecycle({}, {}, deps);
  });

  // ── poolRepo getter ─────────────────────────────────────────────────────
  describe('poolRepo getter', () => {
    it('returns the pool repository instance', () => {
      expect(lifecycle.poolRepo).toBe(deps.poolRepo);
    });
  });

  // ── acquireForPR (ported from WorktreePoolManager) ──────────────────────
  describe('acquireForPR', () => {
    it('refreshes when pool worktree is already assigned to the PR', async () => {
      const poolEntry = { id: 'pair-review--abc', path: '/tmp/worktree/pair-review--abc', current_pr_number: 123, repository: 'test/repo' };
      const worktreeRecord = { id: 'pair-review--abc', pr_number: 123, path: '/tmp/worktree/pair-review--abc' };
      deps.poolRepo.claimByPR.mockResolvedValue(poolEntry);
      deps.worktreeRepo.findById.mockResolvedValue(worktreeRecord);

      const result = await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(result.worktreePath).toBe('/tmp/worktree/pair-review--abc');
      expect(result.worktreeId).toBe('pair-review--abc');
      expect(deps._mockWorktreeManagerInstance.refreshWorktree).toHaveBeenCalledWith(
        worktreeRecord,
        123,
        expect.objectContaining({ head_sha: 'abc123', head_branch: 'feature-branch' }),
        expect.objectContaining({ owner: 'test', repo: 'repo', number: 123 })
      );
      expect(deps.poolRepo.markInUse).toHaveBeenCalledWith('pair-review--abc', 123);
    });

    it('switches an available worktree when no existing assignment', async () => {
      const availableEntry = { id: 'pair-review--xyz', path: '/tmp/worktree/pair-review--xyz', status: 'available', repository: 'test/repo' };
      const worktreeRecord = { id: 'pair-review--xyz', pr_number: 99, path: '/tmp/worktree/pair-review--xyz' };
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(availableEntry);
      deps.worktreeRepo.findById.mockResolvedValue(worktreeRecord);

      const result = await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(result.worktreePath).toBe('/tmp/worktree/pair-review--xyz');
      expect(result.worktreeId).toBe('pair-review--xyz');
      // claimAvailable already marked as switching -- no separate markSwitching call
      expect(deps.poolRepo.markSwitching).not.toHaveBeenCalled();
      // PR-specific refspec fetch — no --prune (only broad fetches get --prune)
      expect(deps._mockGit.fetch).toHaveBeenCalledWith([
        'origin',
        '+refs/pull/123/head:refs/remotes/origin/pr-123',
      ]);
      expect(deps._mockGit.checkout).toHaveBeenCalled();
    });

    it('creates a new worktree when pool is not full (reserveSlot succeeds)', async () => {
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      const result = await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(result.worktreePath).toBe('/tmp/worktree/pair-review--abc');
      expect(deps.poolRepo.reserveSlot).toHaveBeenCalledWith(
        expect.stringMatching(/^pair-review--/), 'test/repo', 3
      );
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
      // finalizeReservation must be called with the same poolId that was
      // passed to reserveSlot, NOT the worktrees-table ID from createWorktreeForPR.
      const reservedPoolId = deps.poolRepo.reserveSlot.mock.calls[0][0];
      expect(deps.poolRepo.finalizeReservation).toHaveBeenCalledWith(
        reservedPoolId, '/tmp/worktree/pair-review--abc', 123
      );
      // The returned worktreeId should be the poolId, not the worktrees-table ID
      expect(result.worktreeId).toBe(reservedPoolId);
      // Old create and markInUse should NOT be called
      expect(deps.poolRepo.create).not.toHaveBeenCalled();
      expect(deps.poolRepo.markInUse).not.toHaveBeenCalled();
    });

    it('creates non-pool worktree when reserveSlot returns false (at capacity) instead of throwing', async () => {
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(false);

      const result = await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      // Should succeed with a non-pool worktree
      expect(result.worktreePath).toBe('/tmp/worktree/pair-review--abc');
      expect(result.worktreeId).toBe('pair-review--abc');

      // Should call createWorktreeForPR WITHOUT explicitId (non-pool path)
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalledOnce();
      const createCall = deps._mockWorktreeManagerInstance.createWorktreeForPR.mock.calls[0];
      expect(createCall[0]).toEqual({ owner: 'test', repo: 'repo', number: 123 });
      expect(createCall[3]).not.toHaveProperty('explicitId');

      // Should NOT finalize any pool reservation
      expect(deps.poolRepo.finalizeReservation).not.toHaveBeenCalled();
    });

    it('deletes orphaned pool entry when claimByPR returns entry with no worktree record and falls through', async () => {
      const orphanedEntry = { id: 'orphan-1', path: '/tmp/worktree/orphan-1', current_pr_number: 123, repository: 'test/repo' };
      deps.poolRepo.claimByPR.mockResolvedValue(orphanedEntry);
      // findById returns null -- orphaned
      deps.worktreeRepo.findById.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(deps.poolRepo.delete).toHaveBeenCalledWith('orphan-1');
      // Falls through to create a new worktree
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
    });

    it('deletes orphaned available pool entry when claimAvailable returns entry with no worktree record and falls through', async () => {
      const orphanedAvailable = { id: 'orphan-2', path: '/tmp/worktree/orphan-2', status: 'available', repository: 'test/repo' };
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(orphanedAvailable);
      // findById returns null -- orphaned
      deps.worktreeRepo.findById.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(deps.poolRepo.delete).toHaveBeenCalledWith('orphan-2');
      // Falls through to create a new worktree
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
    });

    it('deletes stale records when claimed existingPool worktree directory is missing from disk and falls through', async () => {
      const staleEntry = { id: 'stale-1', path: '/tmp/worktree/stale-1', current_pr_number: 123, repository: 'test/repo' };
      const worktreeRecord = { id: 'stale-1', pr_number: 123, path: '/tmp/worktree/stale-1' };
      deps.poolRepo.claimByPR.mockResolvedValue(staleEntry);
      deps.worktreeRepo.findById.mockResolvedValue(worktreeRecord);
      // Directory does not exist on disk
      deps.fs.existsSync.mockReturnValue(false);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(deps.fs.existsSync).toHaveBeenCalledWith('/tmp/worktree/stale-1');
      expect(deps.poolRepo.delete).toHaveBeenCalledWith('stale-1');
      expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('stale-1');
      // Falls through to create a new worktree
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
    });

    it('deletes stale records when claimed available worktree directory is missing from disk and falls through', async () => {
      const staleAvailable = { id: 'stale-2', path: '/tmp/worktree/stale-2', status: 'available', repository: 'test/repo' };
      const worktreeRecord = { id: 'stale-2', pr_number: 99, path: '/tmp/worktree/stale-2' };
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(staleAvailable);
      deps.worktreeRepo.findById.mockResolvedValue(worktreeRecord);
      // Directory does not exist on disk
      deps.fs.existsSync.mockReturnValue(false);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(deps.fs.existsSync).toHaveBeenCalledWith('/tmp/worktree/stale-2');
      expect(deps.poolRepo.delete).toHaveBeenCalledWith('stale-2');
      expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('stale-2');
      // Falls through to create a new worktree
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
    });
  });

  // ── _switchPoolWorktree (ported from WorktreePoolManager) ───────────────
  describe('_switchPoolWorktree', () => {
    const poolEntry = { id: 'pair-review--xyz', path: '/tmp/worktree/pair-review--xyz' };
    const worktreeRecord = { id: 'pair-review--xyz', pr_number: 99, path: '/tmp/worktree/pair-review--xyz' };

    it('executes operations in the correct order (markSwitching already done by claimAvailable)', async () => {
      const callOrder = [];
      deps._mockGit.fetch.mockImplementation(() => { callOrder.push('fetch'); return Promise.resolve(); });
      deps._mockGit.reset.mockImplementation(() => { callOrder.push('reset'); return Promise.resolve(); });
      deps._mockGit.clean.mockImplementation(() => { callOrder.push('clean'); return Promise.resolve(); });
      deps._mockGit.checkout.mockImplementation(() => { callOrder.push('checkout'); return Promise.resolve(); });
      deps.worktreeRepo.switchPR.mockImplementation(() => { callOrder.push('switchPR'); return Promise.resolve([]); });
      deps._mockUsageTracker.clearWorktree.mockImplementation(() => { callOrder.push('clearWorktree'); });
      deps.poolRepo.markInUse.mockImplementation(() => { callOrder.push('markInUse'); return Promise.resolve(); });

      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(callOrder).toEqual(['fetch', 'reset', 'clean', 'checkout', 'switchPR', 'clearWorktree', 'markInUse']);
    });

    it('runs executeCheckoutScript when resetScript is provided', async () => {
      const optionsWithReset = { ...options, resetScript: '/bin/reset.sh' };

      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, optionsWithReset);

      expect(deps._mockWorktreeManagerInstance.executeCheckoutScript).toHaveBeenCalledWith(
        '/bin/reset.sh',
        poolEntry.path,
        expect.objectContaining({
          BASE_BRANCH: 'main',
          HEAD_BRANCH: 'feature-branch',
          BASE_SHA: 'def456',
          HEAD_SHA: 'abc123',
          PR_NUMBER: '123',
          WORKTREE_PATH: poolEntry.path,
        }),
        options.checkoutTimeout
      );
    });

    it('calls git reset --hard and git clean -fd before checkout', async () => {
      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(deps._mockGit.reset).toHaveBeenCalledWith(['--hard', 'HEAD']);
      expect(deps._mockGit.clean).toHaveBeenCalledWith('f', ['-d']);
    });

    it('clears all tracking state via usageTracker.clearWorktree', async () => {
      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('pair-review--xyz');
    });

    it('cleans up deleted non-pool worktree directories from switchPR', async () => {
      deps.worktreeRepo.switchPR.mockResolvedValue(['/tmp/legacy-wt-1', '/tmp/legacy-wt-2']);

      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledTimes(2);
      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledWith('/tmp/legacy-wt-1');
      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledWith('/tmp/legacy-wt-2');
    });

    it('does not fail when disk cleanup throws (best-effort)', async () => {
      deps.worktreeRepo.switchPR.mockResolvedValue(['/tmp/legacy-wt']);
      deps._mockWorktreeManagerInstance.cleanupWorktree.mockRejectedValue(new Error('cleanup failed'));

      // Should not throw -- cleanup errors are swallowed
      const result = await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(result.worktreeId).toBe('pair-review--xyz');
      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledWith('/tmp/legacy-wt');
    });

    it('does not attempt cleanup when switchPR returns empty array', async () => {
      deps.worktreeRepo.switchPR.mockResolvedValue([]);

      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).not.toHaveBeenCalled();
    });

    it('rolls back to available on failure', async () => {
      deps._mockGit.fetch.mockRejectedValue(new Error('fetch failed'));

      await expect(lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options))
        .rejects.toThrow('fetch failed');

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pair-review--xyz');
    });

    it('checks out prData.head.sha instead of ref when available', async () => {
      const prDataWithSha = {
        head: { sha: 'deadbeef1234', ref: 'feature-branch' },
        base: { sha: 'def456', ref: 'main' },
      };

      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prDataWithSha, options);

      expect(deps._mockGit.checkout).toHaveBeenCalledWith(['deadbeef1234']);
    });

    it('checks out prData.head_sha (flat format) instead of ref when available', async () => {
      const prDataFlat = {
        head_sha: 'flat1234abcd',
        head_branch: 'feature-branch',
        base_sha: 'def456',
        base_branch: 'main',
      };

      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prDataFlat, options);

      expect(deps._mockGit.checkout).toHaveBeenCalledWith(['flat1234abcd']);
    });

    it('falls back to ref checkout when no head_sha in prData', async () => {
      const prDataNoSha = {
        head: { ref: 'feature-branch' },
        base: { ref: 'main' },
      };

      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prDataNoSha, options);

      expect(deps._mockGit.checkout).toHaveBeenCalledWith(['refs/remotes/origin/pr-123']);
    });

    it('propagates error when SHA checkout fails (rollback happens)', async () => {
      deps._mockGit.checkout.mockRejectedValue(new Error('checkout failed: unknown revision'));

      await expect(lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options))
        .rejects.toThrow('checkout failed: unknown revision');

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pair-review--xyz');
    });
  });

  // ── _createPoolWorktree (ported from WorktreePoolManager) ───────────────
  describe('_createPoolWorktree', () => {
    it('finalizes the reservation on success and passes explicitId to createWorktreeForPR', async () => {
      const result = await lifecycle._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pair-review--reserved');

      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
      // Verify explicitId is passed so the worktrees-table record uses the pool ID
      const createCall = deps._mockWorktreeManagerInstance.createWorktreeForPR.mock.calls[0];
      expect(createCall[3]).toEqual(expect.objectContaining({ explicitId: 'pair-review--reserved' }));
      // finalizeReservation must use the poolId ('pair-review--reserved'), NOT the
      // worktrees-table ID ('pair-review--abc') returned by createWorktreeForPR.
      expect(deps.poolRepo.finalizeReservation).toHaveBeenCalledWith(
        'pair-review--reserved', '/tmp/worktree/pair-review--abc', 123
      );
      // Old create and markInUse should NOT be called
      expect(deps.poolRepo.create).not.toHaveBeenCalled();
      expect(deps.poolRepo.markInUse).not.toHaveBeenCalled();
      expect(result.worktreePath).toBe('/tmp/worktree/pair-review--abc');
      // The returned worktreeId should be the poolId, consistent with other methods
      expect(result.worktreeId).toBe('pair-review--reserved');
    });

    it('deletes reservation on creation failure', async () => {
      deps._mockWorktreeManagerInstance.createWorktreeForPR.mockRejectedValue(new Error('clone failed'));

      await expect(lifecycle._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pair-review--reserved'))
        .rejects.toThrow('clone failed');

      expect(deps.poolRepo.deleteReservation).toHaveBeenCalledWith('pair-review--reserved');
      expect(deps.poolRepo.finalizeReservation).not.toHaveBeenCalled();
    });

    it('still throws the original error even if deleteReservation fails', async () => {
      deps._mockWorktreeManagerInstance.createWorktreeForPR.mockRejectedValue(new Error('clone failed'));
      deps.poolRepo.deleteReservation.mockRejectedValue(new Error('db error'));

      await expect(lifecycle._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pair-review--reserved'))
        .rejects.toThrow('clone failed');

      expect(deps.poolRepo.deleteReservation).toHaveBeenCalledWith('pair-review--reserved');
    });
  });

  // ── _refreshPoolWorktree (ported from WorktreePoolManager) ──────────────
  describe('_refreshPoolWorktree', () => {
    const poolEntry = { id: 'pair-review--abc', path: '/tmp/worktree/pair-review--abc' };
    const worktreeRecord = { id: 'pair-review--abc', pr_number: 123, path: '/tmp/worktree/pair-review--abc' };

    it('calls refreshWorktree and marks in use', async () => {
      const result = await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

      expect(deps._mockGit.reset).toHaveBeenCalledWith(['--hard', 'HEAD']);
      expect(deps._mockGit.clean).toHaveBeenCalledWith('f', ['-d']);
      expect(deps._mockWorktreeManagerInstance.refreshWorktree).toHaveBeenCalledWith(
        worktreeRecord,
        123,
        expect.objectContaining({
          head_sha: 'abc123',
          head_branch: 'feature-branch',
          base_sha: 'def456',
          base_branch: 'main',
        }),
        expect.objectContaining({ owner: 'test', repo: 'repo', number: 123 })
      );
      expect(deps.poolRepo.markInUse).toHaveBeenCalledWith('pair-review--abc', 123);
      expect(result).toEqual({ worktreePath: '/tmp/worktree/pair-review--abc', worktreeId: 'pair-review--abc' });
    });

    it('executes reset+clean before refreshWorktree (call ordering)', async () => {
      const callOrder = [];
      deps._mockGit.reset.mockImplementation(() => { callOrder.push('reset'); return Promise.resolve(); });
      deps._mockGit.clean.mockImplementation(() => { callOrder.push('clean'); return Promise.resolve(); });
      deps._mockWorktreeManagerInstance.refreshWorktree.mockImplementation(() => { callOrder.push('refreshWorktree'); return Promise.resolve('/tmp/worktree/pair-review--abc'); });
      deps.poolRepo.markInUse.mockImplementation(() => { callOrder.push('markInUse'); return Promise.resolve(); });

      await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

      expect(callOrder).toEqual(['reset', 'clean', 'refreshWorktree', 'markInUse']);
    });

    it('skips refresh when worktree HEAD matches target SHA', async () => {
      deps._mockGit.revparse = vi.fn().mockResolvedValue('abc123');

      const result = await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

      expect(deps._mockGit.revparse).toHaveBeenCalledWith(['HEAD']);
      // Should NOT call refreshWorktree -- early return
      expect(deps._mockWorktreeManagerInstance.refreshWorktree).not.toHaveBeenCalled();
      // Should still mark in_use
      expect(deps.poolRepo.markInUse).toHaveBeenCalledWith('pair-review--abc', 123);
      expect(result).toEqual({ worktreePath: '/tmp/worktree/pair-review--abc', worktreeId: 'pair-review--abc' });
    });

    it('skips refresh when HEAD matches target SHA with trailing whitespace', async () => {
      deps._mockGit.revparse = vi.fn().mockResolvedValue('abc123\n');

      const result = await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

      expect(deps._mockWorktreeManagerInstance.refreshWorktree).not.toHaveBeenCalled();
      expect(result).toEqual({ worktreePath: '/tmp/worktree/pair-review--abc', worktreeId: 'pair-review--abc' });
    });

    it('proceeds with refresh when HEAD differs from target SHA', async () => {
      deps._mockGit.revparse = vi.fn().mockResolvedValue('different_sha_999');

      const result = await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

      expect(deps._mockGit.revparse).toHaveBeenCalledWith(['HEAD']);
      // HEAD differs -- should proceed with full refresh
      expect(deps._mockWorktreeManagerInstance.refreshWorktree).toHaveBeenCalled();
      expect(deps.poolRepo.markInUse).toHaveBeenCalledWith('pair-review--abc', 123);
      expect(result).toEqual({ worktreePath: '/tmp/worktree/pair-review--abc', worktreeId: 'pair-review--abc' });
    });

    it('proceeds with refresh when revparse throws (graceful fallback)', async () => {
      deps._mockGit.revparse = vi.fn().mockRejectedValue(new Error('not a git repo'));

      const result = await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

      // Error checking HEAD should not block refresh -- falls through to refreshWorktree
      expect(deps._mockWorktreeManagerInstance.refreshWorktree).toHaveBeenCalled();
      expect(result).toEqual({ worktreePath: '/tmp/worktree/pair-review--abc', worktreeId: 'pair-review--abc' });
    });

    it('proceeds with refresh when no target SHA is available', async () => {
      const prDataNoSha = {
        head: { ref: 'feature-branch' },
        base: { ref: 'main' },
      };

      const result = await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prDataNoSha);

      // No SHA to compare -- should skip the early-return check entirely
      expect(deps._mockWorktreeManagerInstance.refreshWorktree).toHaveBeenCalled();
      expect(result).toEqual({ worktreePath: '/tmp/worktree/pair-review--abc', worktreeId: 'pair-review--abc' });
    });

    it('checks out targetSha after refreshWorktree when HEAD differs', async () => {
      deps._mockGit.revparse = vi.fn().mockResolvedValue('different_sha_999');

      await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

      // refreshWorktree should have been called first
      expect(deps._mockWorktreeManagerInstance.refreshWorktree).toHaveBeenCalled();
      // Then an explicit checkout of the target SHA
      expect(deps._mockGit.checkout).toHaveBeenCalledWith(['abc123']);
    });

    it('falls back gracefully when targetSha checkout fails after refreshWorktree', async () => {
      deps._mockGit.revparse = vi.fn().mockResolvedValue('different_sha_999');
      deps._mockGit.checkout.mockRejectedValue(new Error('fatal: reference is not a tree: abc123'));

      // Should NOT throw -- falls back to FETCH_HEAD with a warning
      const result = await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

      expect(deps._mockWorktreeManagerInstance.refreshWorktree).toHaveBeenCalled();
      expect(deps._mockGit.checkout).toHaveBeenCalledWith(['abc123']);
      // Should still succeed and return the worktree path
      expect(result).toEqual({ worktreePath: '/tmp/worktree/pair-review--abc', worktreeId: 'pair-review--abc' });
      // Should still mark in_use
      expect(deps.poolRepo.markInUse).toHaveBeenCalledWith('pair-review--abc', 123);
    });
  });

  // ── release (ported from WorktreePoolManager) ───────────────────────────
  describe('release', () => {
    it('marks the pool worktree as available', async () => {
      await lifecycle.release('pair-review--abc');

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pair-review--abc');
    });
  });

  // ── startSession ────────────────────────────────────────────────────────
  describe('startSession', () => {
    it('finds pool worktree and registers session', async () => {
      deps.poolRepo.findByReviewId.mockResolvedValue({ id: 'pair-review--abc' });

      const result = await lifecycle.startSession(42, 'ws-sess-1');

      expect(deps.poolRepo.findByReviewId).toHaveBeenCalledWith(42);
      expect(deps._mockUsageTracker.addSession).toHaveBeenCalledWith('pair-review--abc', 'ws-sess-1');
      expect(result).toEqual({ worktreeId: 'pair-review--abc' });
    });

    it('returns null for non-pool review', async () => {
      deps.poolRepo.findByReviewId.mockResolvedValue(null);

      const result = await lifecycle.startSession(99, 'ws-sess-2');

      expect(result).toBeNull();
      expect(deps._mockUsageTracker.addSession).not.toHaveBeenCalled();
    });
  });

  // ── endSession ──────────────────────────────────────────────────────────
  describe('endSession', () => {
    it('delegates to usage tracker', () => {
      lifecycle.endSession('pair-review--abc', 'ws-sess-1');

      expect(deps._mockUsageTracker.removeSession).toHaveBeenCalledWith('pair-review--abc', 'ws-sess-1');
    });
  });

  // ── startAnalysis ───────────────────────────────────────────────────────
  describe('startAnalysis', () => {
    it('finds pool worktree and registers analysis', async () => {
      deps.poolRepo.findByReviewId.mockResolvedValue({ id: 'pair-review--xyz' });

      const result = await lifecycle.startAnalysis(42, 'run-1');

      expect(deps.poolRepo.findByReviewId).toHaveBeenCalledWith(42);
      expect(deps._mockUsageTracker.addAnalysis).toHaveBeenCalledWith('pair-review--xyz', 'run-1');
      expect(result).toBe('pair-review--xyz');
    });

    it('returns null for non-pool review', async () => {
      deps.poolRepo.findByReviewId.mockResolvedValue(null);

      const result = await lifecycle.startAnalysis(99, 'run-2');

      expect(result).toBeNull();
      expect(deps._mockUsageTracker.addAnalysis).not.toHaveBeenCalled();
    });
  });

  // ── endAnalysis ─────────────────────────────────────────────────────────
  describe('endAnalysis', () => {
    it('delegates to usage tracker removeAnalysisById', () => {
      lifecycle.endAnalysis('run-1');

      expect(deps._mockUsageTracker.removeAnalysisById).toHaveBeenCalledWith('run-1');
    });
  });

  // ── releaseForDeletion ──────────────────────────────────────────────────
  describe('releaseForDeletion', () => {
    it('clears usage state then marks available (ordering matters)', async () => {
      const callOrder = [];
      deps._mockUsageTracker.clearWorktree.mockImplementation(() => { callOrder.push('clearWorktree'); });
      deps.poolRepo.markAvailable.mockImplementation(() => { callOrder.push('markAvailable'); return Promise.resolve(); });

      await lifecycle.releaseForDeletion('pair-review--abc');

      expect(callOrder).toEqual(['clearWorktree', 'markAvailable']);
      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('pair-review--abc');
      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pair-review--abc');
    });
  });

  // ── releaseAfterHeadless ────────────────────────────────────────────────
  describe('releaseAfterHeadless', () => {
    it('clears usage state then marks available (ordering matters -- prevents race)', async () => {
      const callOrder = [];
      deps._mockUsageTracker.clearWorktree.mockImplementation(() => { callOrder.push('clearWorktree'); });
      deps.poolRepo.markAvailable.mockImplementation(() => { callOrder.push('markAvailable'); return Promise.resolve(); });

      await lifecycle.releaseAfterHeadless('pair-review--abc');

      expect(callOrder).toEqual(['clearWorktree', 'markAvailable']);
      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('pair-review--abc');
      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pair-review--abc');
    });
  });

  // ── setReviewOwner ──────────────────────────────────────────────────────
  describe('setReviewOwner', () => {
    it('delegates to poolRepo.setCurrentReviewId', async () => {
      await lifecycle.setReviewOwner('pair-review--abc', 42);

      expect(deps.poolRepo.setCurrentReviewId).toHaveBeenCalledWith('pair-review--abc', 42);
    });

    it('supports null reviewId to clear ownership', async () => {
      await lifecycle.setReviewOwner('pair-review--abc', null);

      expect(deps.poolRepo.setCurrentReviewId).toHaveBeenCalledWith('pair-review--abc', null);
    });
  });

  // ── getActiveAnalyses ───────────────────────────────────────────────────
  describe('getActiveAnalyses', () => {
    it('delegates to usage tracker', () => {
      const mockSet = new Set(['run-1', 'run-2']);
      deps._mockUsageTracker.getActiveAnalyses.mockReturnValue(mockSet);

      const result = lifecycle.getActiveAnalyses('pair-review--abc');

      expect(deps._mockUsageTracker.getActiveAnalyses).toHaveBeenCalledWith('pair-review--abc');
      expect(result).toBe(mockSet);
    });
  });

  // ── resetAndRehydrate ───────────────────────────────────────────────────
  describe('resetAndRehydrate', () => {
    it('calls resetStaleAndPreserve on the pool repo', async () => {
      await lifecycle.resetAndRehydrate();

      expect(deps.poolRepo.resetStaleAndPreserve).toHaveBeenCalled();
    });

    it('returns preserved entries', async () => {
      const preserved = [{ id: 'pair-review--abc', current_review_id: 10 }];
      deps.poolRepo.resetStaleAndPreserve.mockResolvedValue(preserved);

      const result = await lifecycle.resetAndRehydrate();

      expect(result).toEqual(preserved);
    });

    it('wires onIdle callback on the usage tracker', async () => {
      await lifecycle.resetAndRehydrate();

      expect(deps._mockUsageTracker.onIdle).toBeTypeOf('function');
    });

    it('onIdle callback marks worktree available', async () => {
      await lifecycle.resetAndRehydrate();

      // Invoke the wired-up onIdle callback
      await deps._mockUsageTracker.onIdle('pair-review--abc');

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pair-review--abc');
    });

    it('onIdle callback retries once on failure then succeeds', async () => {
      await lifecycle.resetAndRehydrate();

      deps.poolRepo.markAvailable
        .mockRejectedValueOnce(new Error('db busy'))
        .mockResolvedValueOnce(undefined);

      // Use fake timers to handle the 1s retry delay
      vi.useFakeTimers();
      const promise = deps._mockUsageTracker.onIdle('pair-review--abc');
      // Advance past the 1s retry delay
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      vi.useRealTimers();

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledTimes(2);
    });

    it('onIdle callback logs error after both attempts fail', async () => {
      await lifecycle.resetAndRehydrate();

      deps.poolRepo.markAvailable
        .mockRejectedValueOnce(new Error('db busy'))
        .mockRejectedValueOnce(new Error('db still busy'));

      vi.useFakeTimers();
      const promise = deps._mockUsageTracker.onIdle('pair-review--abc');
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      vi.useRealTimers();

      // Should not throw, just log. Both attempts were made.
      expect(deps.poolRepo.markAvailable).toHaveBeenCalledTimes(2);
    });

    it('rehydrates preserved entries by triggering synthetic session cycle', async () => {
      const preserved = [
        { id: 'pair-review--abc', current_review_id: 10 },
        { id: 'pair-review--xyz', current_review_id: 20 },
      ];
      deps.poolRepo.resetStaleAndPreserve.mockResolvedValue(preserved);

      await lifecycle.resetAndRehydrate();

      // Each preserved entry should have addSession then removeSession called
      expect(deps._mockUsageTracker.addSession).toHaveBeenCalledWith('pair-review--abc', 'startup-rehydration');
      expect(deps._mockUsageTracker.removeSession).toHaveBeenCalledWith('pair-review--abc', 'startup-rehydration');
      expect(deps._mockUsageTracker.addSession).toHaveBeenCalledWith('pair-review--xyz', 'startup-rehydration');
      expect(deps._mockUsageTracker.removeSession).toHaveBeenCalledWith('pair-review--xyz', 'startup-rehydration');
    });

    it('does not rehydrate when there are no preserved entries', async () => {
      deps.poolRepo.resetStaleAndPreserve.mockResolvedValue([]);

      await lifecycle.resetAndRehydrate();

      expect(deps._mockUsageTracker.addSession).not.toHaveBeenCalled();
      expect(deps._mockUsageTracker.removeSession).not.toHaveBeenCalled();
    });

    it('adopts existing non-pool worktrees for pool-enabled repos', async () => {
      const config = {
        repos: {
          'test/repo': { pool_size: 3 },
        },
      };
      deps.poolRepo.countForRepo.mockResolvedValue(0);
      deps.poolRepo.findOrphanWorktrees.mockResolvedValue([
        { id: 'wt-1', pr_number: 10, path: '/tmp/wt-1', repository: 'test/repo', reviewId: 100 },
        { id: 'wt-2', pr_number: 20, path: '/tmp/wt-2', repository: 'test/repo', reviewId: null },
      ]);
      const poolLifecycle = new WorktreePoolLifecycle({}, config, deps);

      const result = await poolLifecycle.resetAndRehydrate();

      // wt-1 has a review -> adopted as in_use
      expect(deps.poolRepo.create).toHaveBeenCalledWith({
        id: 'wt-1', repository: 'test/repo', path: '/tmp/wt-1', prNumber: 10,
      });
      expect(deps.poolRepo.setCurrentReviewId).toHaveBeenCalledWith('wt-1', 100);

      // wt-2 has no review -> adopted as available (no prNumber)
      expect(deps.poolRepo.create).toHaveBeenCalledWith({
        id: 'wt-2', repository: 'test/repo', path: '/tmp/wt-2',
      });

      // Only wt-1 (in_use) should be rehydrated with synthetic session
      expect(deps._mockUsageTracker.addSession).toHaveBeenCalledWith('wt-1', 'startup-rehydration');
      expect(deps._mockUsageTracker.removeSession).toHaveBeenCalledWith('wt-1', 'startup-rehydration');
      // wt-2 (available) should NOT get a synthetic session
      expect(deps._mockUsageTracker.addSession).not.toHaveBeenCalledWith('wt-2', 'startup-rehydration');

      // Result should include the adopted in_use entry
      expect(result).toContainEqual({ id: 'wt-1', current_review_id: 100 });
    });

    it('skips adoption when already at pool capacity', async () => {
      const config = {
        repos: {
          'test/repo': { pool_size: 2 },
        },
      };
      deps.poolRepo.countForRepo.mockResolvedValue(2); // already at capacity
      const poolLifecycle = new WorktreePoolLifecycle({}, config, deps);

      await poolLifecycle.resetAndRehydrate();

      // Should not even query for orphan worktrees
      expect(deps.poolRepo.findOrphanWorktrees).not.toHaveBeenCalled();
      expect(deps.poolRepo.create).not.toHaveBeenCalled();
    });

    it('adopted worktrees with no review get status available', async () => {
      const config = {
        repos: {
          'test/repo': { pool_size: 3 },
        },
      };
      deps.poolRepo.countForRepo.mockResolvedValue(0);
      deps.poolRepo.findOrphanWorktrees.mockResolvedValue([
        { id: 'wt-orphan', pr_number: 99, path: '/tmp/wt-orphan', repository: 'test/repo', reviewId: null },
      ]);
      const poolLifecycle = new WorktreePoolLifecycle({}, config, deps);

      const result = await poolLifecycle.resetAndRehydrate();

      // Should be created without prNumber (-> available status)
      expect(deps.poolRepo.create).toHaveBeenCalledWith({
        id: 'wt-orphan', repository: 'test/repo', path: '/tmp/wt-orphan',
      });
      // setCurrentReviewId should NOT be called for available entries
      expect(deps.poolRepo.setCurrentReviewId).not.toHaveBeenCalled();

      // Should NOT be included in the preserved/rehydrated set
      expect(result).not.toContainEqual(expect.objectContaining({ id: 'wt-orphan' }));
      // No synthetic session for available entries
      expect(deps._mockUsageTracker.addSession).not.toHaveBeenCalledWith('wt-orphan', 'startup-rehydration');
    });

    it('skips adoption of orphan worktrees whose directory is missing from disk', async () => {
      const config = {
        repos: {
          'test/repo': { pool_size: 3 },
        },
      };
      deps.poolRepo.countForRepo.mockResolvedValue(0);
      deps.poolRepo.findOrphanWorktrees.mockResolvedValue([
        { id: 'wt-exists', pr_number: 10, path: '/tmp/wt-exists', repository: 'test/repo', reviewId: 100 },
        { id: 'wt-missing', pr_number: 20, path: '/tmp/wt-missing', repository: 'test/repo', reviewId: 200 },
      ]);
      deps.fs.existsSync.mockImplementation((path) => path !== '/tmp/wt-missing');
      const poolLifecycle = new WorktreePoolLifecycle({}, config, deps);

      const result = await poolLifecycle.resetAndRehydrate();

      // wt-exists should be adopted
      expect(deps.poolRepo.create).toHaveBeenCalledWith({
        id: 'wt-exists', repository: 'test/repo', path: '/tmp/wt-exists', prNumber: 10,
      });
      expect(deps.poolRepo.setCurrentReviewId).toHaveBeenCalledWith('wt-exists', 100);

      // wt-missing should NOT be adopted (directory missing)
      expect(deps.poolRepo.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wt-missing' })
      );
      expect(deps.poolRepo.setCurrentReviewId).not.toHaveBeenCalledWith('wt-missing', expect.anything());

      // Only wt-exists should be in the result
      expect(result).toContainEqual({ id: 'wt-exists', current_review_id: 100 });
      expect(result).not.toContainEqual(expect.objectContaining({ id: 'wt-missing' }));
    });
  });

  // ── destroyPoolWorktree ──────────────────────────────────────────────────
  describe('destroyPoolWorktree', () => {
    it('throws when pool entry status is creating', async () => {
      deps.poolRepo.getPoolEntry.mockResolvedValue({ id: 'wt-1', status: 'creating' });

      await expect(lifecycle.destroyPoolWorktree('wt-1'))
        .rejects.toThrow('Cannot delete worktree wt-1: currently creating');

      // Should not proceed with any cleanup
      expect(deps._mockUsageTracker.clearWorktree).not.toHaveBeenCalled();
      expect(deps.poolRepo.delete).not.toHaveBeenCalled();
      expect(deps.worktreeRepo.delete).not.toHaveBeenCalled();
    });

    it('throws when pool entry status is switching', async () => {
      deps.poolRepo.getPoolEntry.mockResolvedValue({ id: 'wt-1', status: 'switching' });

      await expect(lifecycle.destroyPoolWorktree('wt-1'))
        .rejects.toThrow('Cannot delete worktree wt-1: currently switching');

      expect(deps._mockUsageTracker.clearWorktree).not.toHaveBeenCalled();
      expect(deps.poolRepo.delete).not.toHaveBeenCalled();
      expect(deps.worktreeRepo.delete).not.toHaveBeenCalled();
    });

    it('proceeds when pool entry status is in_use', async () => {
      deps.poolRepo.getPoolEntry.mockResolvedValue({ id: 'wt-1', status: 'in_use' });
      deps.worktreeRepo.findById.mockResolvedValue({ id: 'wt-1', path: '/tmp/wt-1' });

      await lifecycle.destroyPoolWorktree('wt-1');

      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('wt-1');
      expect(deps.poolRepo.delete).toHaveBeenCalledWith('wt-1');
      expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('wt-1');
    });

    it('proceeds when pool entry status is available', async () => {
      deps.poolRepo.getPoolEntry.mockResolvedValue({ id: 'wt-1', status: 'available' });
      deps.worktreeRepo.findById.mockResolvedValue({ id: 'wt-1', path: '/tmp/wt-1' });

      await lifecycle.destroyPoolWorktree('wt-1');

      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('wt-1');
      expect(deps.poolRepo.delete).toHaveBeenCalledWith('wt-1');
      expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('wt-1');
    });

    it('proceeds when pool entry does not exist', async () => {
      deps.poolRepo.getPoolEntry.mockResolvedValue(null);

      await lifecycle.destroyPoolWorktree('wt-1');

      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('wt-1');
      expect(deps.poolRepo.delete).toHaveBeenCalledWith('wt-1');
      expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('wt-1');
    });

    it('cancels active analyses before destroying', async () => {
      deps.poolRepo.getPoolEntry.mockResolvedValue({ id: 'wt-1', status: 'in_use' });
      deps._mockUsageTracker.getActiveAnalyses.mockReturnValue(new Set(['run-1', 'run-2']));
      deps.worktreeRepo.findById.mockResolvedValue({ id: 'wt-1', path: '/tmp/wt-1' });

      const cancelFn = vi.fn();
      await lifecycle.destroyPoolWorktree('wt-1', { cancelAnalyses: cancelFn });

      expect(cancelFn).toHaveBeenCalledWith('wt-1', new Set(['run-1', 'run-2']));
      expect(deps.poolRepo.delete).toHaveBeenCalledWith('wt-1');
    });

    it('cleans up worktree from disk when record exists', async () => {
      deps.poolRepo.getPoolEntry.mockResolvedValue({ id: 'wt-1', status: 'available' });
      deps.worktreeRepo.findById.mockResolvedValue({ id: 'wt-1', path: '/tmp/wt-1' });

      await lifecycle.destroyPoolWorktree('wt-1');

      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledWith('/tmp/wt-1');
    });

    it('does not fail when disk cleanup throws (best-effort)', async () => {
      deps.poolRepo.getPoolEntry.mockResolvedValue({ id: 'wt-1', status: 'available' });
      deps.worktreeRepo.findById.mockResolvedValue({ id: 'wt-1', path: '/tmp/wt-1' });
      deps._mockWorktreeManagerInstance.cleanupWorktree.mockRejectedValue(new Error('disk error'));

      // Should not throw
      await lifecycle.destroyPoolWorktree('wt-1');

      expect(deps.poolRepo.delete).toHaveBeenCalledWith('wt-1');
      expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('wt-1');
    });
  });
});

