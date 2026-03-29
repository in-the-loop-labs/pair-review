// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { GitWorktreeManager } = require('../../src/git/worktree');

describe('GitWorktreeManager.checkoutBranch', () => {
  let manager;
  let mockGit;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new GitWorktreeManager();

    mockGit = {
      fetch: vi.fn().mockResolvedValue(undefined),
      raw: vi.fn().mockResolvedValue(''),
      revparse: vi.fn().mockResolvedValue('abc123def456\n'),
    };

    // Stub the git instance factory so no real git calls are made
    manager._gitFor = vi.fn().mockReturnValue(mockGit);
    manager.hasLocalChanges = vi.fn().mockResolvedValue(false);
    manager.resolveRemoteForPR = vi.fn().mockResolvedValue('upstream');
  });

  it('should fetch the correct ref, reset hard, and return the HEAD SHA', async () => {
    const sha = await manager.checkoutBranch('/tmp/worktree', 42);

    expect(manager.hasLocalChanges).toHaveBeenCalledWith('/tmp/worktree');
    expect(mockGit.fetch).toHaveBeenCalledWith([
      'origin',
      '+refs/pull/42/head:refs/remotes/origin/pr-42',
    ]);
    expect(mockGit.raw).toHaveBeenCalledWith([
      'reset', '--hard', 'refs/remotes/origin/pr-42',
    ]);
    expect(mockGit.revparse).toHaveBeenCalledWith(['HEAD']);
    expect(sha).toBe('abc123def456');
  });

  it('should reject when the worktree has uncommitted changes', async () => {
    manager.hasLocalChanges = vi.fn().mockResolvedValue(true);

    await expect(
      manager.checkoutBranch('/tmp/worktree', 42)
    ).rejects.toThrow('uncommitted changes');

    expect(mockGit.fetch).not.toHaveBeenCalled();
  });

  it('should use the resolved remote for fork PRs when prData is provided', async () => {
    manager.resolveRemoteForPR.mockResolvedValue('fork-remote');
    const prData = { head: { repo: { full_name: 'fork-owner/repo' } } };

    const sha = await manager.checkoutBranch('/tmp/worktree', 99, { prData });

    expect(manager.resolveRemoteForPR).toHaveBeenCalledWith(mockGit, prData, null);
    expect(mockGit.fetch).toHaveBeenCalledWith([
      'fork-remote',
      '+refs/pull/99/head:refs/remotes/fork-remote/pr-99',
    ]);
    expect(mockGit.raw).toHaveBeenCalledWith([
      'reset', '--hard', 'refs/remotes/fork-remote/pr-99',
    ]);
    expect(sha).toBe('abc123def456');
  });

  it('should use the default remote when no prData is provided', async () => {
    await manager.checkoutBranch('/tmp/worktree', 10);

    expect(manager.resolveRemoteForPR).not.toHaveBeenCalled();
    expect(mockGit.fetch).toHaveBeenCalledWith([
      'origin',
      '+refs/pull/10/head:refs/remotes/origin/pr-10',
    ]);
  });

  it('should propagate fetch failures', async () => {
    mockGit.fetch.mockRejectedValue(new Error('Could not resolve host'));

    await expect(
      manager.checkoutBranch('/tmp/worktree', 42)
    ).rejects.toThrow('Failed to checkout PR #42: Could not resolve host');
  });

  it('should store a persistent ref in the fetch refspec', async () => {
    await manager.checkoutBranch('/tmp/worktree', 77, { remote: 'upstream' });

    const fetchCall = mockGit.fetch.mock.calls[0][0];
    expect(fetchCall[1]).toBe('+refs/pull/77/head:refs/remotes/upstream/pr-77');
  });
});
