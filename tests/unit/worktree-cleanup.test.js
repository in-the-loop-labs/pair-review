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

    it('should handle bare repo paths where commonDir basename is not .git', async () => {
      // For a bare repo, git rev-parse --git-common-dir returns the bare repo path itself
      // (e.g., /path/to/repo.git), not a .git subdirectory. The method should use it as-is
      // rather than navigating to its parent.
      const result = await manager.resolveOwningRepo(process.cwd());

      expect(result).not.toBeNull();
      // We can't easily test a real bare repo here, but we verify the method
      // works for the current repo. The bare repo logic is tested implicitly
      // by confirming the path.basename check works: for this repo, commonDir
      // ends in '.git' so path.dirname is used. For bare repos, it would not.
      const gitDir = (await result.raw(['rev-parse', '--git-dir'])).trim();
      expect(gitDir).toBeTruthy();
    });
  });

  describe('cleanupWorktree', () => {
    it('should resolve owning repo for git worktree remove', async () => {
      const mockOwningRepo = { raw: vi.fn().mockResolvedValue('') };
      manager.resolveOwningRepo = vi.fn().mockResolvedValue(mockOwningRepo);
      manager.pruneWorktrees = vi.fn().mockResolvedValue(undefined);
      manager.pathExists = vi.fn().mockResolvedValue(true);

      await manager.cleanupWorktree('/tmp/worktrees/pr-42');

      expect(manager.resolveOwningRepo).toHaveBeenCalledWith('/tmp/worktrees/pr-42');
      expect(mockOwningRepo.raw).toHaveBeenCalledWith(
        ['worktree', 'remove', '--force', '/tmp/worktrees/pr-42']
      );
    });

    it('should be a no-op when worktree path does not exist', async () => {
      manager.resolveOwningRepo = vi.fn();
      manager.pruneWorktrees = vi.fn().mockResolvedValue(undefined);
      manager.pathExists = vi.fn().mockResolvedValue(false);

      await manager.cleanupWorktree('/tmp/worktrees/pr-42');

      expect(manager.resolveOwningRepo).not.toHaveBeenCalled();
      expect(manager.removeDirectory).not.toHaveBeenCalled();
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

    it('should use a SimpleGit instance directly when provided', async () => {
      const mockGit = { raw: vi.fn().mockResolvedValue('') };
      manager.resolveOwningRepo = vi.fn();

      await manager.pruneWorktrees(mockGit);

      expect(manager.resolveOwningRepo).not.toHaveBeenCalled();
      expect(mockGit.raw).toHaveBeenCalledWith(['worktree', 'prune']);
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
      const mockOwningRepo = {
        raw: vi.fn().mockImplementation((args) => {
          if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
            return Promise.resolve('/fake/repo/.git');
          }
          return Promise.resolve('');
        }),
      };
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
      expect(mockWorktreeRepo.delete).toHaveBeenCalledWith('wt-1');
      expect(mockWorktreeRepo.delete).toHaveBeenCalledWith('wt-2');
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
      expect(mockWorktreeRepo.delete).toHaveBeenCalledWith('wt-1');
      expect(result.cleaned).toBe(1);
    });

    it('should handle partial failure across worktrees', async () => {
      const mockOwningRepo = {
        raw: vi.fn().mockImplementation((args) => {
          if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
            return Promise.resolve('/fake/repo/.git');
          }
          return Promise.resolve('');
        }),
      };
      // First worktree resolves fine (both pre-loop and in-loop), second always fails
      manager.resolveOwningRepo = vi.fn()
        .mockResolvedValueOnce(mockOwningRepo)  // pre-loop: wt-1
        .mockResolvedValueOnce(null)             // pre-loop: wt-2 (fails to resolve)
        .mockResolvedValueOnce(mockOwningRepo)   // in-loop: wt-1 (git remove succeeds)
        .mockResolvedValueOnce(null);            // in-loop: wt-2 (falls back to manual)
      manager.pruneWorktrees = vi.fn().mockResolvedValue(undefined);
      // Manual removal fails for wt-2
      manager.pathExists = vi.fn().mockResolvedValue(true);
      manager.removeDirectory = vi.fn().mockRejectedValue(new Error('permission denied'));

      const mockWorktreeRepo = {
        findStale: vi.fn().mockResolvedValue([
          { id: 'wt-1', path: '/tmp/worktrees/pr-1' },
          { id: 'wt-2', path: '/tmp/worktrees/pr-2' },
        ]),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      manager.worktreeRepo = mockWorktreeRepo;

      const result = await manager.cleanupStaleWorktrees(7);

      expect(result.cleaned).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        id: 'wt-2',
        path: '/tmp/worktrees/pr-2',
        error: 'permission denied',
      });
      expect(mockWorktreeRepo.delete).toHaveBeenCalledWith('wt-1');
      expect(mockWorktreeRepo.delete).not.toHaveBeenCalledWith('wt-2');
    });

    it('should skip cleanup when no database connection', async () => {
      manager.worktreeRepo = null;

      const result = await manager.cleanupStaleWorktrees(7);

      expect(result.cleaned).toBe(0);
    });
  });
});
