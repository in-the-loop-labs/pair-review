// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { GitWorktreeManager } = require('../../src/git/worktree');

describe('GitWorktreeManager remote resolution', () => {
  let manager;
  let mockGit;

  beforeEach(() => {
    manager = new GitWorktreeManager();
    mockGit = {
      raw: vi.fn(),
      addRemote: vi.fn()
    };
  });

  describe('resolveRemoteForRepo', () => {
    it('should return correct remote name for HTTPS match (clone_url)', async () => {
      mockGit.raw.mockResolvedValue(
        'origin\thttps://github.com/owner/repo.git (fetch)\n' +
        'origin\thttps://github.com/owner/repo.git (push)\n'
      );

      const result = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/owner/repo.git',
        'git@github.com:owner/repo.git'
      );

      expect(result).toBe('origin');
      expect(mockGit.addRemote).not.toHaveBeenCalled();
    });

    it('should return correct remote name for SSH match (ssh_url)', async () => {
      mockGit.raw.mockResolvedValue(
        'origin\tgit@github.com:owner/repo.git (fetch)\n' +
        'origin\tgit@github.com:owner/repo.git (push)\n'
      );

      const result = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/owner/repo.git',
        'git@github.com:owner/repo.git'
      );

      expect(result).toBe('origin');
      expect(mockGit.addRemote).not.toHaveBeenCalled();
    });

    it('should normalize .git suffix so it does not prevent matching', async () => {
      // Remote has .git suffix, target URL does not
      mockGit.raw.mockResolvedValue(
        'origin\thttps://github.com/owner/repo.git (fetch)\n' +
        'origin\thttps://github.com/owner/repo.git (push)\n'
      );

      const result = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/owner/repo',
        ''
      );

      expect(result).toBe('origin');
      expect(mockGit.addRemote).not.toHaveBeenCalled();
    });

    it('should match URLs case-insensitively', async () => {
      mockGit.raw.mockResolvedValue(
        'origin\thttps://GitHub.com/Owner/Repo.git (fetch)\n' +
        'origin\thttps://GitHub.com/Owner/Repo.git (push)\n'
      );

      const result = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/owner/repo.git',
        ''
      );

      expect(result).toBe('origin');
      expect(mockGit.addRemote).not.toHaveBeenCalled();
    });

    it('should match ssh:// protocol form against scp-like form', async () => {
      // Remote uses ssh:// protocol form
      mockGit.raw.mockResolvedValue(
        'origin\tssh://git@github.com/owner/repo (fetch)\n' +
        'origin\tssh://git@github.com/owner/repo (push)\n'
      );

      const result = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/other/repo.git',
        'git@github.com:owner/repo.git'
      );

      expect(result).toBe('origin');
      expect(mockGit.addRemote).not.toHaveBeenCalled();
    });

    it('should add pair-review-base remote when no remote matches', async () => {
      mockGit.raw.mockResolvedValue(
        'origin\thttps://github.com/fork-owner/repo.git (fetch)\n' +
        'origin\thttps://github.com/fork-owner/repo.git (push)\n'
      );
      mockGit.addRemote.mockResolvedValue(undefined);

      const result = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/upstream-owner/repo.git',
        'git@github.com:upstream-owner/repo.git'
      );

      expect(result).toBe('pair-review-base');
      expect(mockGit.addRemote).toHaveBeenCalledWith(
        'pair-review-base',
        'https://github.com/upstream-owner/repo.git'
      );
    });

    it('should use set-url when pair-review-base remote already exists', async () => {
      mockGit.raw.mockImplementation(async (args) => {
        if (args[0] === 'remote' && args[1] === '-v') {
          return (
            'origin\thttps://github.com/fork-owner/repo.git (fetch)\n' +
            'origin\thttps://github.com/fork-owner/repo.git (push)\n' +
            'pair-review-base\thttps://github.com/old-upstream/repo.git (fetch)\n' +
            'pair-review-base\thttps://github.com/old-upstream/repo.git (push)\n'
          );
        }
        // set-url call
        return '';
      });

      const result = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/new-upstream/repo.git',
        ''
      );

      expect(result).toBe('pair-review-base');
      expect(mockGit.addRemote).not.toHaveBeenCalled();
      expect(mockGit.raw).toHaveBeenCalledWith([
        'remote', 'set-url', 'pair-review-base', 'https://github.com/new-upstream/repo.git'
      ]);
    });

    it('should not produce false matches when sshUrl is null or empty', async () => {
      mockGit.raw.mockResolvedValue(
        'origin\thttps://github.com/owner/repo.git (fetch)\n' +
        'origin\thttps://github.com/owner/repo.git (push)\n'
      );

      // cloneUrl matches, sshUrl is null — should still match via cloneUrl
      const result1 = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/owner/repo.git',
        null
      );
      expect(result1).toBe('origin');

      // cloneUrl does NOT match, sshUrl is empty — should NOT match
      mockGit.addRemote.mockResolvedValue(undefined);
      const result2 = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/different-owner/repo.git',
        ''
      );
      expect(result2).toBe('pair-review-base');
    });

    it('should add managed remote when remote output is empty', async () => {
      mockGit.raw.mockResolvedValue('');
      mockGit.addRemote.mockResolvedValue(undefined);

      const result = await manager.resolveRemoteForRepo(
        mockGit,
        'https://github.com/owner/repo.git',
        'git@github.com:owner/repo.git'
      );

      expect(result).toBe('pair-review-base');
      expect(mockGit.addRemote).toHaveBeenCalledWith(
        'pair-review-base',
        'https://github.com/owner/repo.git'
      );
    });
  });

  describe('resolveRemoteForPR', () => {
    it('should use prData.repository.clone_url and ssh_url when available', async () => {
      mockGit.raw.mockResolvedValue(
        'origin\thttps://github.com/owner/repo.git (fetch)\n' +
        'origin\thttps://github.com/owner/repo.git (push)\n'
      );

      const prData = {
        repository: {
          clone_url: 'https://github.com/owner/repo.git',
          ssh_url: 'git@github.com:owner/repo.git'
        }
      };
      const prInfo = { owner: 'owner', repo: 'repo', number: 42 };

      const result = await manager.resolveRemoteForPR(mockGit, prData, prInfo);

      expect(result).toBe('origin');
    });

    it('should fall back to constructing URL from prInfo when prData.repository is missing', async () => {
      mockGit.raw.mockResolvedValue(
        'origin\thttps://github.com/owner/repo.git (fetch)\n' +
        'origin\thttps://github.com/owner/repo.git (push)\n'
      );

      const prData = {};  // no repository property
      const prInfo = { owner: 'owner', repo: 'repo', number: 42 };

      const result = await manager.resolveRemoteForPR(mockGit, prData, prInfo);

      // Constructed URL is https://github.com/owner/repo.git which matches origin
      expect(result).toBe('origin');
    });

    it('should handle null prData by falling back to prInfo', async () => {
      mockGit.raw.mockResolvedValue(
        'origin\thttps://github.com/owner/repo.git (fetch)\n' +
        'origin\thttps://github.com/owner/repo.git (push)\n'
      );

      const prInfo = { owner: 'owner', repo: 'repo', number: 42 };

      const result = await manager.resolveRemoteForPR(mockGit, null, prInfo);

      expect(result).toBe('origin');
    });

    it('should return origin when both prData and prInfo are null', async () => {
      const result = await manager.resolveRemoteForPR(mockGit, null, null);

      expect(result).toBe('origin');
      // Should not attempt any git operations
      expect(mockGit.raw).not.toHaveBeenCalled();
      expect(mockGit.addRemote).not.toHaveBeenCalled();
    });
  });
});
