// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { WorktreePoolManager, PoolExhaustedError } = require('../../src/git/worktree-pool.js');

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

  return {
    fs: {
      existsSync: vi.fn().mockReturnValue(true),
    },
    poolRepo: {
      claimByPR: vi.fn().mockResolvedValue(null),
      claimAvailable: vi.fn().mockResolvedValue(null),
      findByPR: vi.fn().mockResolvedValue(null),
      findAvailable: vi.fn().mockResolvedValue(null),
      countForRepo: vi.fn().mockResolvedValue(0),
      reserveSlot: vi.fn().mockResolvedValue(true),
      finalizeReservation: vi.fn().mockResolvedValue(undefined),
      deleteReservation: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
      markInUse: vi.fn().mockResolvedValue(undefined),
      markAvailable: vi.fn().mockResolvedValue(undefined),
      markSwitching: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    worktreeRepo: {
      findById: vi.fn().mockResolvedValue(null),
      findByPR: vi.fn().mockResolvedValue({ id: 'pool-abc', pr_number: 123, path: '/tmp/worktree/pool-abc' }),
      findByPath: vi.fn().mockResolvedValue({ id: 'pool-abc', pr_number: 123, path: '/tmp/worktree/pool-abc' }),
      switchPR: vi.fn().mockResolvedValue([]),
      updateLastAccessed: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(true),
    },
    simpleGit: vi.fn(() => mockGit),
    GitWorktreeManager: MockGitWorktreeManager,
    _mockGit: mockGit,
    _mockWorktreeManagerInstance: mockWorktreeManagerInstance,
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

describe('WorktreePoolManager', () => {
  let deps;
  let manager;

  beforeEach(() => {
    deps = createMockDeps();
    manager = new WorktreePoolManager({}, {}, deps);
  });

  // ── acquireForPR ─────────────────────────────────────────────────────────
  describe('acquireForPR', () => {
    it('refreshes when pool worktree is already assigned to the PR', async () => {
      const poolEntry = { id: 'pool-abc', path: '/tmp/worktree/pool-abc', current_pr_number: 123, repository: 'test/repo' };
      const worktreeRecord = { id: 'pool-abc', pr_number: 123, path: '/tmp/worktree/pool-abc' };
      deps.poolRepo.claimByPR.mockResolvedValue(poolEntry);
      deps.worktreeRepo.findById.mockResolvedValue(worktreeRecord);

      const result = await manager.acquireForPR(prInfo, prData, '/tmp/source', options);

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

      const result = await manager.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(result.worktreePath).toBe('/tmp/worktree/pool-xyz');
      expect(result.worktreeId).toBe('pool-xyz');
      // claimAvailable already marked as switching — no separate markSwitching call
      expect(deps.poolRepo.markSwitching).not.toHaveBeenCalled();
      expect(deps._mockGit.fetch).toHaveBeenCalled();
      expect(deps._mockGit.checkout).toHaveBeenCalled();
    });

    it('creates a new worktree when pool is not full (reserveSlot succeeds)', async () => {
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      const result = await manager.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(result.worktreePath).toBe('/tmp/worktree/pool-abc');
      expect(deps.poolRepo.reserveSlot).toHaveBeenCalledWith(
        expect.stringMatching(/^pool-/), 'test/repo', 3
      );
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
      expect(deps.poolRepo.finalizeReservation).toHaveBeenCalledWith(
        'pool-abc', '/tmp/worktree/pool-abc', 123
      );
      // Old create and markInUse should NOT be called
      expect(deps.poolRepo.create).not.toHaveBeenCalled();
      expect(deps.poolRepo.markInUse).not.toHaveBeenCalled();
    });

    it('throws PoolExhaustedError when reserveSlot returns false (at capacity)', async () => {
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(false);

      await expect(manager.acquireForPR(prInfo, prData, '/tmp/source', options))
        .rejects.toThrow(PoolExhaustedError);
    });

    it('deletes orphaned pool entry when claimByPR returns entry with no worktree record and falls through', async () => {
      const orphanedEntry = { id: 'orphan-1', path: '/tmp/worktree/orphan-1', current_pr_number: 123, repository: 'test/repo' };
      deps.poolRepo.claimByPR.mockResolvedValue(orphanedEntry);
      // findById returns null — orphaned
      deps.worktreeRepo.findById.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      await manager.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(deps.poolRepo.delete).toHaveBeenCalledWith('orphan-1');
      // Falls through to create a new worktree
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
    });

    it('deletes orphaned available pool entry when claimAvailable returns entry with no worktree record and falls through', async () => {
      const orphanedAvailable = { id: 'orphan-2', path: '/tmp/worktree/orphan-2', status: 'available', repository: 'test/repo' };
      deps.poolRepo.claimByPR.mockResolvedValue(null);
      deps.poolRepo.claimAvailable.mockResolvedValue(orphanedAvailable);
      // findById returns null — orphaned
      deps.worktreeRepo.findById.mockResolvedValue(null);
      deps.poolRepo.reserveSlot.mockResolvedValue(true);

      await manager.acquireForPR(prInfo, prData, '/tmp/source', options);

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

      await manager.acquireForPR(prInfo, prData, '/tmp/source', options);

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

      await manager.acquireForPR(prInfo, prData, '/tmp/source', options);

      expect(deps.fs.existsSync).toHaveBeenCalledWith('/tmp/worktree/stale-2');
      expect(deps.poolRepo.delete).toHaveBeenCalledWith('stale-2');
      expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('stale-2');
      // Falls through to create a new worktree
      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
    });
  });

  // ── _switchPoolWorktree ──────────────────────────────────────────────────
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
      deps.poolRepo.markInUse.mockImplementation(() => { callOrder.push('markInUse'); return Promise.resolve(); });

      await manager._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      // markSwitching is NOT in this list — it was already done atomically by claimAvailable
      expect(callOrder).toEqual(['fetch', 'reset', 'clean', 'checkout', 'switchPR', 'markInUse']);
    });

    it('runs executeCheckoutScript when resetScript is provided', async () => {
      const optionsWithReset = { ...options, resetScript: '/bin/reset.sh' };

      await manager._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, optionsWithReset);

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
      await manager._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(deps._mockGit.reset).toHaveBeenCalledWith(['--hard', 'HEAD']);
      expect(deps._mockGit.clean).toHaveBeenCalledWith(['-fd']);
    });

    it('clears all tracking state via clearWorktree (not just review mappings)', async () => {
      const { worktreePoolUsage } = require('../../src/git/worktree-pool-usage.js');
      const clearSpy = vi.spyOn(worktreePoolUsage, 'clearWorktree');

      await manager._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(clearSpy).toHaveBeenCalledWith('pool-xyz');
      clearSpy.mockRestore();
    });

    it('cleans up deleted non-pool worktree directories from switchPR', async () => {
      deps.worktreeRepo.switchPR.mockResolvedValue(['/tmp/legacy-wt-1', '/tmp/legacy-wt-2']);

      await manager._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledTimes(2);
      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledWith('/tmp/legacy-wt-1');
      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledWith('/tmp/legacy-wt-2');
    });

    it('does not fail when disk cleanup throws (best-effort)', async () => {
      deps.worktreeRepo.switchPR.mockResolvedValue(['/tmp/legacy-wt']);
      deps._mockWorktreeManagerInstance.cleanupWorktree.mockRejectedValue(new Error('cleanup failed'));

      // Should not throw — cleanup errors are swallowed
      const result = await manager._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(result.worktreeId).toBe('pool-xyz');
      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledWith('/tmp/legacy-wt');
    });

    it('does not attempt cleanup when switchPR returns empty array', async () => {
      deps.worktreeRepo.switchPR.mockResolvedValue([]);

      await manager._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options);

      expect(deps._mockWorktreeManagerInstance.cleanupWorktree).not.toHaveBeenCalled();
    });

    it('rolls back to available on failure', async () => {
      deps._mockGit.fetch.mockRejectedValue(new Error('fetch failed'));

      await expect(manager._switchPoolWorktree(poolEntry, worktreeRecord, prInfo, prData, options))
        .rejects.toThrow('fetch failed');

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pool-xyz');
    });
  });

  // ── _createPoolWorktree ──────────────────────────────────────────────────
  describe('_createPoolWorktree', () => {
    it('finalizes the reservation on success', async () => {
      const result = await manager._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pool-reserved');

      expect(deps._mockWorktreeManagerInstance.createWorktreeForPR).toHaveBeenCalled();
      expect(deps.poolRepo.finalizeReservation).toHaveBeenCalledWith(
        'pool-abc', '/tmp/worktree/pool-abc', 123
      );
      // Old create and markInUse should NOT be called
      expect(deps.poolRepo.create).not.toHaveBeenCalled();
      expect(deps.poolRepo.markInUse).not.toHaveBeenCalled();
      expect(result.worktreePath).toBe('/tmp/worktree/pool-abc');
    });

    it('deletes reservation on creation failure', async () => {
      deps._mockWorktreeManagerInstance.createWorktreeForPR.mockRejectedValue(new Error('clone failed'));

      await expect(manager._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pool-reserved'))
        .rejects.toThrow('clone failed');

      expect(deps.poolRepo.deleteReservation).toHaveBeenCalledWith('pool-reserved');
      expect(deps.poolRepo.finalizeReservation).not.toHaveBeenCalled();
    });

    it('still throws the original error even if deleteReservation fails', async () => {
      deps._mockWorktreeManagerInstance.createWorktreeForPR.mockRejectedValue(new Error('clone failed'));
      deps.poolRepo.deleteReservation.mockRejectedValue(new Error('db error'));

      await expect(manager._createPoolWorktree(prInfo, prData, '/tmp/source', options, 'pool-reserved'))
        .rejects.toThrow('clone failed');

      expect(deps.poolRepo.deleteReservation).toHaveBeenCalledWith('pool-reserved');
    });
  });

  // ── _refreshPoolWorktree ─────────────────────────────────────────────────
  describe('_refreshPoolWorktree', () => {
    it('calls refreshWorktree and marks in use', async () => {
      const poolEntry = { id: 'pool-abc', path: '/tmp/worktree/pool-abc' };
      const worktreeRecord = { id: 'pool-abc', pr_number: 123, path: '/tmp/worktree/pool-abc' };

      const result = await manager._refreshPoolWorktree(poolEntry, worktreeRecord, prInfo, prData);

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

  // ── release ──────────────────────────────────────────────────────────────
  describe('release', () => {
    it('marks the pool worktree as available', async () => {
      await manager.release('pool-abc');

      expect(deps.poolRepo.markAvailable).toHaveBeenCalledWith('pool-abc');
    });
  });
});

// ── PoolExhaustedError ───────────────────────────────────────────────────
describe('PoolExhaustedError', () => {
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
