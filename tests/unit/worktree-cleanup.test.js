// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { GitWorktreeManager } = require('../../src/git/worktree');

describe('GitWorktreeManager worktree cleanup', () => {
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new GitWorktreeManager();
    // Stub out methods that hit the filesystem
    manager.pathExists = vi.fn().mockResolvedValue(false);
    manager.removeDirectory = vi.fn().mockResolvedValue(undefined);
  });

  describe('resolveOwningRepo', () => {
    it('should return null when the path is not a git worktree', async () => {
      const result = await manager.resolveOwningRepo('/tmp/definitely-not-a-worktree');

      expect(result).toBeNull();
    });

    it('should return a simpleGit instance for a valid worktree', async () => {
      // Use the actual project repo as a known-good git directory
      const result = await manager.resolveOwningRepo(process.cwd());

      expect(result).not.toBeNull();
      // Verify it's a functional git instance by running a command
      const branch = await result.raw(['rev-parse', '--abbrev-ref', 'HEAD']);
      expect(branch.trim()).toBeTruthy();
    });
  });

  describe('cleanupWorktree', () => {
    it('should resolve owning repo for git worktree remove', async () => {
      const mockOwningRepo = { raw: vi.fn().mockResolvedValue('') };
      manager.resolveOwningRepo = vi.fn().mockResolvedValue(mockOwningRepo);
      manager.pruneWorktrees = vi.fn().mockResolvedValue(undefined);

      await manager.cleanupWorktree('/tmp/worktrees/pr-42');

      expect(manager.resolveOwningRepo).toHaveBeenCalledWith('/tmp/worktrees/pr-42');
      expect(mockOwningRepo.raw).toHaveBeenCalledWith(
        ['worktree', 'remove', '--force', '/tmp/worktrees/pr-42']
      );
    });

    it('should fall back to manual removal when resolveOwningRepo returns null', async () => {
      manager.resolveOwningRepo = vi.fn().mockResolvedValue(null);
      manager.pruneWorktrees = vi.fn().mockResolvedValue(undefined);
      manager.pathExists = vi.fn().mockResolvedValue(true);

      await manager.cleanupWorktree('/tmp/worktrees/pr-42');

      expect(manager.removeDirectory).toHaveBeenCalledWith('/tmp/worktrees/pr-42');
    });

    it('should fall back to manual removal when git worktree remove fails', async () => {
      const mockOwningRepo = { raw: vi.fn().mockRejectedValue(new Error('remove failed')) };
      manager.resolveOwningRepo = vi.fn().mockResolvedValue(mockOwningRepo);
      manager.pruneWorktrees = vi.fn().mockResolvedValue(undefined);
      manager.pathExists = vi.fn().mockResolvedValue(true);

      await manager.cleanupWorktree('/tmp/worktrees/pr-42');

      expect(manager.removeDirectory).toHaveBeenCalledWith('/tmp/worktrees/pr-42');
    });

    it('should not throw on cleanup failure', async () => {
      manager.resolveOwningRepo = vi.fn().mockRejectedValue(new Error('unexpected'));
      manager.pruneWorktrees = vi.fn().mockRejectedValue(new Error('prune failed'));

      await expect(manager.cleanupWorktree('/tmp/worktrees/pr-42')).resolves.not.toThrow();
    });
  });

  describe('pruneWorktrees', () => {
    it('should resolve owning repo from worktree path when provided', async () => {
      const mockOwningRepo = { raw: vi.fn().mockResolvedValue('') };
      manager.resolveOwningRepo = vi.fn().mockResolvedValue(mockOwningRepo);

      await manager.pruneWorktrees('/tmp/worktrees/pr-42');

      expect(manager.resolveOwningRepo).toHaveBeenCalledWith('/tmp/worktrees/pr-42');
      expect(mockOwningRepo.raw).toHaveBeenCalledWith(['worktree', 'prune']);
    });

    it('should fall back when no worktree path given', async () => {
      // When no path is given, pruneWorktrees falls back to simpleGit(process.cwd()).
      // Since we're in a real git repo (the project), this should not throw.
      await expect(manager.pruneWorktrees()).resolves.not.toThrow();
    });

    it('should fall back when resolveOwningRepo returns null', async () => {
      manager.resolveOwningRepo = vi.fn().mockResolvedValue(null);

      // Falls back to simpleGit(process.cwd()), should not throw in this repo
      await expect(manager.pruneWorktrees('/tmp/worktrees/gone')).resolves.not.toThrow();
    });

    it('should not throw on failure', async () => {
      manager.resolveOwningRepo = vi.fn().mockRejectedValue(new Error('resolve failed'));

      await expect(manager.pruneWorktrees('/tmp/worktrees/gone')).resolves.not.toThrow();
    });
  });

  describe('cleanupStaleWorktrees', () => {
    it('should use resolveOwningRepo for each stale worktree', async () => {
      const mockOwningRepo = { raw: vi.fn().mockResolvedValue('') };
      manager.resolveOwningRepo = vi.fn().mockResolvedValue(mockOwningRepo);
      manager.pruneWorktrees = vi.fn().mockResolvedValue(undefined);

      const mockWorktreeRepo = {
        findStale: vi.fn().mockResolvedValue([
          { id: 'wt-1', path: '/tmp/worktrees/pr-1' },
          { id: 'wt-2', path: '/tmp/worktrees/pr-2' },
        ]),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      manager.worktreeRepo = mockWorktreeRepo;

      const result = await manager.cleanupStaleWorktrees(7);

      expect(manager.resolveOwningRepo).toHaveBeenCalledWith('/tmp/worktrees/pr-1');
      expect(manager.resolveOwningRepo).toHaveBeenCalledWith('/tmp/worktrees/pr-2');
      expect(mockOwningRepo.raw).toHaveBeenCalledWith(
        ['worktree', 'remove', '--force', '/tmp/worktrees/pr-1']
      );
      expect(mockOwningRepo.raw).toHaveBeenCalledWith(
        ['worktree', 'remove', '--force', '/tmp/worktrees/pr-2']
      );
      expect(result.cleaned).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should fall back to manual removal when owning repo is null', async () => {
      manager.resolveOwningRepo = vi.fn().mockResolvedValue(null);
      manager.pruneWorktrees = vi.fn().mockResolvedValue(undefined);
      manager.pathExists = vi.fn().mockResolvedValue(true);

      const mockWorktreeRepo = {
        findStale: vi.fn().mockResolvedValue([
          { id: 'wt-1', path: '/tmp/worktrees/pr-1' },
        ]),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      manager.worktreeRepo = mockWorktreeRepo;

      const result = await manager.cleanupStaleWorktrees(7);

      expect(manager.removeDirectory).toHaveBeenCalledWith('/tmp/worktrees/pr-1');
      expect(result.cleaned).toBe(1);
    });

    it('should skip cleanup when no database connection', async () => {
      manager.worktreeRepo = null;

      const result = await manager.cleanupStaleWorktrees(7);

      expect(result.cleaned).toBe(0);
    });
  });
});
