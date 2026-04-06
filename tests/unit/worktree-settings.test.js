// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { WorktreeRepository } = require('../../src/database');
const { WorktreePoolLifecycle } = require('../../src/git/worktree-pool-lifecycle');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema');

// ============================================================================
// WorktreeRepository.findAllByRepository
// ============================================================================

describe('WorktreeRepository.findAllByRepository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new WorktreeRepository(db);
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  function insertWorktree(id, prNumber, repository, branch = 'feature', path = `/tmp/wt/${id}`) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, prNumber, repository, branch, path, now, now);
  }

  it('returns worktrees for the specified repository', async () => {
    insertWorktree('wt-1', 1, 'owner/repo', 'branch-a');
    insertWorktree('wt-2', 2, 'owner/repo', 'branch-b');
    insertWorktree('wt-3', 3, 'other/repo', 'branch-c');

    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toHaveLength(2);
    const ids = results.map(r => r.id);
    expect(ids).toContain('wt-1');
    expect(ids).toContain('wt-2');
    expect(ids).not.toContain('wt-3');
  });

  it('matches case-insensitively', async () => {
    insertWorktree('wt-1', 1, 'Owner/Repo', 'branch-a');
    insertWorktree('wt-2', 2, 'owner/repo', 'branch-b');

    const results = await repo.findAllByRepository('OWNER/REPO');

    expect(results).toHaveLength(2);
    expect(results.map(r => r.id)).toEqual(expect.arrayContaining(['wt-1', 'wt-2']));
  });

  it('returns empty array when no worktrees exist for the repository', async () => {
    insertWorktree('wt-1', 1, 'other/repo', 'branch-a');

    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toEqual([]);
  });

  it('returns empty array when no worktrees exist at all', async () => {
    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toEqual([]);
  });

  it('returns results ordered by last_accessed_at DESC', async () => {
    const earlier = '2026-01-01T00:00:00.000Z';
    const later = '2026-01-02T00:00:00.000Z';

    db.prepare(`
      INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('wt-old', 1, 'owner/repo', 'old', '/tmp/wt/old', earlier, earlier);

    db.prepare(`
      INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('wt-new', 2, 'owner/repo', 'new', '/tmp/wt/new', later, later);

    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('wt-new');
    expect(results[1].id).toBe('wt-old');
  });

  it('returns all expected fields', async () => {
    insertWorktree('wt-1', 42, 'owner/repo', 'feature-branch', '/tmp/wt/1');

    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toHaveLength(1);
    const wt = results[0];
    expect(wt).toHaveProperty('id', 'wt-1');
    expect(wt).toHaveProperty('pr_number', 42);
    expect(wt).toHaveProperty('repository', 'owner/repo');
    expect(wt).toHaveProperty('branch', 'feature-branch');
    expect(wt).toHaveProperty('path', '/tmp/wt/1');
    expect(wt).toHaveProperty('created_at');
    expect(wt).toHaveProperty('last_accessed_at');
  });
});

// ============================================================================
// WorktreePoolLifecycle.destroyPoolWorktree
// ============================================================================

function createMockDeps() {
  const mockWorktreeManagerInstance = {
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
  };

  const MockGitWorktreeManager = vi.fn().mockImplementation(function () {
    Object.assign(this, mockWorktreeManagerInstance);
  });

  const mockUsageTracker = {
    getActiveAnalyses: vi.fn().mockReturnValue(new Set()),
    clearWorktree: vi.fn(),
    addSession: vi.fn(),
    removeSession: vi.fn(),
    addAnalysis: vi.fn(),
    removeAnalysis: vi.fn(),
    removeAnalysisById: vi.fn(),
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
      findByPR: vi.fn().mockResolvedValue(null),
      findByPath: vi.fn().mockResolvedValue(null),
      switchPR: vi.fn().mockResolvedValue([]),
      updateLastAccessed: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(true),
    },
    usageTracker: mockUsageTracker,
    simpleGit: vi.fn(() => ({})),
    GitWorktreeManager: MockGitWorktreeManager,
    _mockWorktreeManagerInstance: mockWorktreeManagerInstance,
    _mockUsageTracker: mockUsageTracker,
  };
}

describe('WorktreePoolLifecycle.destroyPoolWorktree', () => {
  let deps;
  let lifecycle;

  beforeEach(() => {
    deps = createMockDeps();
    lifecycle = new WorktreePoolLifecycle({}, {}, deps);
  });

  it('calls cancelAnalyses callback when active analyses exist', async () => {
    const activeIds = new Set(['run-1', 'run-2']);
    deps._mockUsageTracker.getActiveAnalyses.mockReturnValue(activeIds);
    const cancelAnalyses = vi.fn().mockResolvedValue(undefined);

    await lifecycle.destroyPoolWorktree('pool-wt-1', { cancelAnalyses });

    expect(cancelAnalyses).toHaveBeenCalledWith('pool-wt-1', activeIds);
  });

  it('does NOT call cancelAnalyses when no active analyses', async () => {
    deps._mockUsageTracker.getActiveAnalyses.mockReturnValue(new Set());
    const cancelAnalyses = vi.fn().mockResolvedValue(undefined);

    await lifecycle.destroyPoolWorktree('pool-wt-1', { cancelAnalyses });

    expect(cancelAnalyses).not.toHaveBeenCalled();
  });

  it('does NOT fail when cancelAnalyses is not provided but active analyses exist', async () => {
    deps._mockUsageTracker.getActiveAnalyses.mockReturnValue(new Set(['run-1']));

    // Should not throw even without cancelAnalyses callback
    await expect(lifecycle.destroyPoolWorktree('pool-wt-1')).resolves.toBeUndefined();
  });

  it('clears the usage tracker via clearWorktree', async () => {
    await lifecycle.destroyPoolWorktree('pool-wt-1');

    expect(deps._mockUsageTracker.clearWorktree).toHaveBeenCalledWith('pool-wt-1');
  });

  it('looks up the worktree record and calls cleanupWorktree on the path', async () => {
    deps.worktreeRepo.findById.mockResolvedValue({
      id: 'pool-wt-1',
      path: '/tmp/worktree/pool-wt-1',
      pr_number: 42,
    });

    await lifecycle.destroyPoolWorktree('pool-wt-1');

    expect(deps.worktreeRepo.findById).toHaveBeenCalledWith('pool-wt-1');
    expect(deps._mockWorktreeManagerInstance.cleanupWorktree).toHaveBeenCalledWith('/tmp/worktree/pool-wt-1');
  });

  it('deletes from both pool and worktree repos', async () => {
    deps.worktreeRepo.findById.mockResolvedValue({
      id: 'pool-wt-1',
      path: '/tmp/worktree/pool-wt-1',
    });

    await lifecycle.destroyPoolWorktree('pool-wt-1');

    expect(deps.poolRepo.delete).toHaveBeenCalledWith('pool-wt-1');
    expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('pool-wt-1');
  });

  it('handles missing worktree record gracefully (path not found)', async () => {
    deps.worktreeRepo.findById.mockResolvedValue(null);

    await lifecycle.destroyPoolWorktree('pool-wt-1');

    // Should skip disk cleanup but still delete from repos
    expect(deps._mockWorktreeManagerInstance.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.poolRepo.delete).toHaveBeenCalledWith('pool-wt-1');
    expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('pool-wt-1');
  });

  it('handles worktree record with no path gracefully', async () => {
    deps.worktreeRepo.findById.mockResolvedValue({
      id: 'pool-wt-1',
      path: null,
    });

    await lifecycle.destroyPoolWorktree('pool-wt-1');

    expect(deps._mockWorktreeManagerInstance.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.poolRepo.delete).toHaveBeenCalledWith('pool-wt-1');
    expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('pool-wt-1');
  });

  it('disk cleanup failure does not prevent DB cleanup', async () => {
    deps.worktreeRepo.findById.mockResolvedValue({
      id: 'pool-wt-1',
      path: '/tmp/worktree/pool-wt-1',
    });
    deps._mockWorktreeManagerInstance.cleanupWorktree.mockRejectedValue(
      new Error('disk cleanup failed')
    );

    // Should not throw
    await expect(lifecycle.destroyPoolWorktree('pool-wt-1')).resolves.toBeUndefined();

    // DB cleanup should still happen
    expect(deps.poolRepo.delete).toHaveBeenCalledWith('pool-wt-1');
    expect(deps.worktreeRepo.delete).toHaveBeenCalledWith('pool-wt-1');
  });

  it('calls operations in the correct order', async () => {
    const callOrder = [];
    deps._mockUsageTracker.getActiveAnalyses.mockReturnValue(new Set(['run-1']));

    const cancelAnalyses = vi.fn().mockImplementation(() => {
      callOrder.push('cancelAnalyses');
      return Promise.resolve();
    });
    deps._mockUsageTracker.clearWorktree.mockImplementation(() => {
      callOrder.push('clearWorktree');
    });
    deps.worktreeRepo.findById.mockImplementation(() => {
      callOrder.push('findById');
      return Promise.resolve({ id: 'pool-wt-1', path: '/tmp/wt' });
    });
    deps._mockWorktreeManagerInstance.cleanupWorktree.mockImplementation(() => {
      callOrder.push('cleanupWorktree');
      return Promise.resolve();
    });
    deps.poolRepo.delete.mockImplementation(() => {
      callOrder.push('poolRepo.delete');
      return Promise.resolve();
    });
    deps.worktreeRepo.delete.mockImplementation(() => {
      callOrder.push('worktreeRepo.delete');
      return Promise.resolve();
    });

    await lifecycle.destroyPoolWorktree('pool-wt-1', { cancelAnalyses });

    expect(callOrder).toEqual([
      'cancelAnalyses',
      'clearWorktree',
      'findById',
      'cleanupWorktree',
      'poolRepo.delete',
      'worktreeRepo.delete',
    ]);
  });
});
