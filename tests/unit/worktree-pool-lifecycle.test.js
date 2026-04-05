// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { WorktreePoolLifecycle, PoolExhaustedError } = require('../../src/git/worktree-pool-lifecycle.js');
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
    createWorktreeForPR: vi.fn().mockResolvedValue({ path: '/tmp/worktree/pool-abc', id: 'pool-abc' }),
    refreshWorktree: vi.fn().mockResolvedValue('/tmp/worktree/pool-abc'),
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
      resetStaleAndPreserve: vi.fn().mockResolvedValue([]),
    },
    worktreeRepo: {
      findById: vi.fn().mockResolvedValue(null),
      findByPR: vi.fn().mockResolvedValue({ id: 'pool-abc', pr_number: 123, path: '/tmp/worktree/pool-abc' }),
      findByPath: vi.fn().mockResolvedValue({ id: 'pool-abc', pr_number: 123, path: '/tmp/worktree/pool-abc' }),
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
      const poolEntry = { id: 'pool-abc', path: '/tmp/worktree/pool-abc', current_pr_number: 123, repository: 'test/repo' };
      const worktreeRecord = { id: 'pool-abc', pr_number: 123, path: '/tmp/worktree/pool-abc' };
      deps.poolRepo.claimByPR.mockResolvedValue(poolEntry);
      deps.worktreeRepo.findById.mockResolvedValue(worktreeRecord);

      const result = await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(result.worktreePath).toBe('/tmp/worktree/pool-abc');
      expect(result.worktreeId).toBe('pool-abc');
      expect(deps._mockWorktreeManagerInstance.refreshWorktree).toHaveBeenCalledWith(
        worktreeRecord,
        123,
        expect.objectContaining({ head_sha: 'abc123', head_branch: 'feature-branch' }),
        expect.objectContaining({ owner: 'test', repo: 'repo', number: 123 })
      );
      expect(deps.poolRepo.markInUse).toHaveBeenCalledWith('pool-abc', 123);
    });

    it('switches an available worktree when no existing assignment', async () => {
      const availableEntry = { id: 'pool-xyz', path: '/tmp/worktree/pool-xyz', status: 'available', repository: 'test/repo' };
      const worktreeRecord = { id: 'pool-xyz', pr_number: 99, path: '/tmp/worktree/pool-xyz' };
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(availableEntry);
      deps.worktreeRepo.findById.mockResolvedValue(worktreeRecord);

      const result = await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(result.worktreePath).toBe('/tmp/worktree/pool-xyz');
      expect(result.worktreeId).toBe('pool-xyz');
      // claimAvailable already marked as switching -- no separate markSwitching call
      expect(deps.poolRepo.markSwitching).not.toHaveBeenCalled();
      expect(deps._mockGit.fetch).toHaveBeenCalled();
      expect(deps._mockGit.checkout).toHaveBeenCalled();
    });

    it('creates a new worktree when pool is not full (reserveSlot succeeds)', async () => {
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      const result = await lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(result.worktreePath).toBe('/tmp/worktree/pool-abc');
      expect(deps.poolRepo.reserveSlot).toHaveBeenCalledWith(
        expect.stringMatching(/^pool-/), 'test/repo', 3
      );
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
      // finalizeReservation must be called with the same poolId that was
      // passed to reserveSlot, NOT the worktrees-table ID from createWorktreeForPR.
      const reservedPoolId = deps.poolRepo.reserveSlot.mock.calls[0][0];
      expect(deps.poolRepo.finalizeReservation).toHaveBeenCalledWith(
        reservedPoolId, '/tmp/worktree/pool-abc', 123
      );
      // The returned worktreeId should be the poolId, not the worktrees-table ID
      expect(result.worktreeId).toBe(reservedPoolId);
      // Old create and markInUse should NOT be called
      expect(deps.poolRepo.create).not.toHaveBeenCalled();
      expect(deps.poolRepo.markInUse).not.toHaveBeenCalled();
    });

    it('throws PoolExhaustedError when reserveSlot returns false (at capacity)', async () => {
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(false);

      await expect(lifecycle.acquireForPR(prInfo, prData, '/tmp/source', options))
        .rejects.toThrow(PoolExhaustedError);
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
    const poolEntry = { id: 'pool-xyz', path: '/tmp/worktree/pool-xyz' };
    const worktreeRecord = { id: 'pool-xyz', pr_number: 99, path: '/tmp/worktree/pool-xyz' };

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
      expect(deps._mockGit.clean).toHaveBeenCalledWith(['-fd']);
    });

    it('clears all tracking state via usageTracker.clearWorktree', async () => {
      await lifecycle._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('pool-xyz');
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

      expect(result.worktreeId).toBe('pool-xyz');
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

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pool-xyz');
    });
  });

  // ── _createPoolWorktree (ported from WorktreePoolManager) ───────────────
  describe('_createPoolWorktree', () => {
    it('finalizes the reservation on success and passes explicitId to createWorktreeForPR', async () => {
      const result = await lifecycle._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pool-reserved');

      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
      // Verify explicitId is passed so the worktrees-table record uses the pool ID
      const createCall = deps._mockWorktreeManagerInstance.createWorktreeForPR.mock.calls[0];
      expect(createCall[3]).toEqual(expect.objectContaining({ explicitId: 'pool-reserved' }));
      // finalizeReservation must use the poolId ('pool-reserved'), NOT the
      // worktrees-table ID ('pool-abc') returned by createWorktreeForPR.
      expect(deps.poolRepo.finalizeReservation).toHaveBeenCalledWith(
        'pool-reserved', '/tmp/worktree/pool-abc', 123
      );
      // Old create and markInUse should NOT be called
      expect(deps.poolRepo.create).not.toHaveBeenCalled();
      expect(deps.poolRepo.markInUse).not.toHaveBeenCalled();
      expect(result.worktreePath).toBe('/tmp/worktree/pool-abc');
      // The returned worktreeId should be the poolId, consistent with other methods
      expect(result.worktreeId).toBe('pool-reserved');
    });

    it('deletes reservation on creation failure', async () => {
      deps._mockWorktreeManagerInstance.createWorktreeForPR.mockRejectedValue(new Error('clone failed'));

      await expect(lifecycle._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pool-reserved'))
        .rejects.toThrow('clone failed');

      expect(deps.poolRepo.deleteReservation).toHaveBeenCalledWith('pool-reserved');
      expect(deps.poolRepo.finalizeReservation).not.toHaveBeenCalled();
    });

    it('still throws the original error even if deleteReservation fails', async () => {
      deps._mockWorktreeManagerInstance.createWorktreeForPR.mockRejectedValue(new Error('clone failed'));
      deps.poolRepo.deleteReservation.mockRejectedValue(new Error('db error'));

      await expect(lifecycle._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pool-reserved'))
        .rejects.toThrow('clone failed');

      expect(deps.poolRepo.deleteReservation).toHaveBeenCalledWith('pool-reserved');
    });
  });

  // ── _refreshPoolWorktree (ported from WorktreePoolManager) ──────────────
  describe('_refreshPoolWorktree', () => {
    it('calls refreshWorktree and marks in use', async () => {
      const poolEntry = { id: 'pool-abc', path: '/tmp/worktree/pool-abc' };
      const worktreeRecord = { id: 'pool-abc', pr_number: 123, path: '/tmp/worktree/pool-abc' };

      const result = await lifecycle._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

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
      expect(deps.poolRepo.markInUse).toHaveBeenCalledWith('pool-abc', 123);
      expect(result).toEqual({ worktreePath: '/tmp/worktree/pool-abc', worktreeId: 'pool-abc' });
    });
  });

  // ── release (ported from WorktreePoolManager) ───────────────────────────
  describe('release', () => {
    it('marks the pool worktree as available', async () => {
      await lifecycle.release('pool-abc');

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pool-abc');
    });
  });

  // ── startSession ────────────────────────────────────────────────────────
  describe('startSession', () => {
    it('finds pool worktree and registers session', async () => {
      deps.poolRepo.findByReviewId.mockResolvedValue({ id: 'pool-abc' });

      const result = await lifecycle.startSession(42, 'ws-sess-1');

      expect(deps.poolRepo.findByReviewId).toHaveBeenCalledWith(42);
      expect(deps._mockUsageTracker.addSession).toHaveBeenCalledWith('pool-abc', 'ws-sess-1');
      expect(result).toEqual({ worktreeId: 'pool-abc' });
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
      lifecycle.endSession('pool-abc', 'ws-sess-1');

      expect(deps._mockUsageTracker.removeSession).toHaveBeenCalledWith('pool-abc', 'ws-sess-1');
    });
  });

  // ── startAnalysis ───────────────────────────────────────────────────────
  describe('startAnalysis', () => {
    it('finds pool worktree and registers analysis', async () => {
      deps.poolRepo.findByReviewId.mockResolvedValue({ id: 'pool-xyz' });

      const result = await lifecycle.startAnalysis(42, 'run-1');

      expect(deps.poolRepo.findByReviewId).toHaveBeenCalledWith(42);
      expect(deps._mockUsageTracker.addAnalysis).toHaveBeenCalledWith('pool-xyz', 'run-1');
      expect(result).toBe('pool-xyz');
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

      await lifecycle.releaseForDeletion('pool-abc');

      expect(callOrder).toEqual(['clearWorktree', 'markAvailable']);
      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('pool-abc');
      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pool-abc');
    });
  });

  // ── releaseAfterHeadless ────────────────────────────────────────────────
  describe('releaseAfterHeadless', () => {
    it('clears usage state then marks available (ordering matters -- prevents race)', async () => {
      const callOrder = [];
      deps._mockUsageTracker.clearWorktree.mockImplementation(() => { callOrder.push('clearWorktree'); });
      deps.poolRepo.markAvailable.mockImplementation(() => { callOrder.push('markAvailable'); return Promise.resolve(); });

      await lifecycle.releaseAfterHeadless('pool-abc');

      expect(callOrder).toEqual(['clearWorktree', 'markAvailable']);
      expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('pool-abc');
      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pool-abc');
    });
  });

  // ── setReviewOwner ──────────────────────────────────────────────────────
  describe('setReviewOwner', () => {
    it('delegates to poolRepo.setCurrentReviewId', async () => {
      await lifecycle.setReviewOwner('pool-abc', 42);

      expect(deps.poolRepo.setCurrentReviewId).toHaveBeenCalledWith('pool-abc', 42);
    });

    it('supports null reviewId to clear ownership', async () => {
      await lifecycle.setReviewOwner('pool-abc', null);

      expect(deps.poolRepo.setCurrentReviewId).toHaveBeenCalledWith('pool-abc', null);
    });
  });

  // ── getActiveAnalyses ───────────────────────────────────────────────────
  describe('getActiveAnalyses', () => {
    it('delegates to usage tracker', () => {
      const mockSet = new Set(['run-1', 'run-2']);
      deps._mockUsageTracker.getActiveAnalyses.mockReturnValue(mockSet);

      const result = lifecycle.getActiveAnalyses('pool-abc');

      expect(deps._mockUsageTracker.getActiveAnalyses).toHaveBeenCalledWith('pool-abc');
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
      const preserved = [{ id: 'pool-abc', current_review_id: 10 }];
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
      await deps._mockUsageTracker.onIdle('pool-abc');

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pool-abc');
    });

    it('onIdle callback retries once on failure then succeeds', async () => {
      await lifecycle.resetAndRehydrate();

      deps.poolRepo.markAvailable
        .mockRejectedValueOnce(new Error('db busy'))
        .mockResolvedValueOnce(undefined);

      // Use fake timers to handle the 1s retry delay
      vi.useFakeTimers();
      const promise = deps._mockUsageTracker.onIdle('pool-abc');
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
      const promise = deps._mockUsageTracker.onIdle('pool-abc');
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      vi.useRealTimers();

      // Should not throw, just log. Both attempts were made.
      expect(deps.poolRepo.markAvailable).toHaveBeenCalledTimes(2);
    });

    it('rehydrates preserved entries by triggering synthetic session cycle', async () => {
      const preserved = [
        { id: 'pool-abc', current_review_id: 10 },
        { id: 'pool-xyz', current_review_id: 20 },
      ];
      deps.poolRepo.resetStaleAndPreserve.mockResolvedValue(preserved);

      await lifecycle.resetAndRehydrate();

      // Each preserved entry should have addSession then removeSession called
      expect(deps._mockUsageTracker.addSession).toHaveBeenCalledWith('pool-abc', 'startup-rehydration');
      expect(deps._mockUsageTracker.removeSession).toHaveBeenCalledWith('pool-abc', 'startup-rehydration');
      expect(deps._mockUsageTracker.addSession).toHaveBeenCalledWith('pool-xyz', 'startup-rehydration');
      expect(deps._mockUsageTracker.removeSession).toHaveBeenCalledWith('pool-xyz', 'startup-rehydration');
    });

    it('does not rehydrate when there are no preserved entries', async () => {
      deps.poolRepo.resetStaleAndPreserve.mockResolvedValue([]);

      await lifecycle.resetAndRehydrate();

      expect(deps._mockUsageTracker.addSession).not.toHaveBeenCalled();
      expect(deps._mockUsageTracker.removeSession).not.toHaveBeenCalled();
    });
  });
});

// ── PoolExhaustedError ───────────────────────────────────────────────────
describe('PoolExhaustedError (from worktree-pool-lifecycle)', () => {
  it('has correct properties', () => {
    const error = new PoolExhaustedError('test/repo', 3);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PoolExhaustedError');
    expect(error.repository).toBe('test/repo');
    expect(error.poolSize).toBe(3);
    expect(error.message).toContain('3');
    expect(error.message).toContain('test/repo');
  });
});
