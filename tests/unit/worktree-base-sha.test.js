// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { GitWorktreeManager, MISSING_COMMIT_ERROR_CODE } = require('../../src/git/worktree');

function createMockGit(overrides = {}) {
  return {
    fetch: vi.fn().mockResolvedValue(undefined),
    raw: vi.fn().mockResolvedValue(''),
    checkout: vi.fn().mockResolvedValue(undefined),
    revparse: vi.fn().mockResolvedValue('head-sha\n'),
    branch: vi.fn().mockResolvedValue(undefined),
    diff: vi.fn().mockResolvedValue('diff --git a/file.js b/file.js'),
    diffSummary: vi.fn().mockResolvedValue({ files: [] }),
    ...overrides,
  };
}

describe('GitWorktreeManager base SHA availability', () => {
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new GitWorktreeManager(null, { worktreeBaseDir: '/tmp/worktrees' });
    manager.ensureWorktreeBaseDir = vi.fn().mockResolvedValue(undefined);
    manager.cleanupWorktree = vi.fn().mockResolvedValue(undefined);
    manager.resolveRemoteForPR = vi.fn().mockResolvedValue('fork-remote');
    manager.fetchPRHead = vi.fn().mockResolvedValue({ checkoutTarget: 'refs/remotes/fork-remote/pr-42' });
    manager.hasLocalChanges = vi.fn().mockResolvedValue(false);
    manager.getWorktreePath = vi.fn().mockResolvedValue('/tmp/worktrees/existing');
    manager.worktreeExists = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the exact base SHA when creating a new worktree and the commit is missing locally', async () => {
    const repoPath = '/tmp/repo';
    const repoGit = createMockGit();
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file' && args[2] === 'base-sha') {
          if (!worktreeGit._seenBaseFetch) {
            throw new Error('missing');
          }
          return 'commit\n';
        }
        if (args[0] === 'fetch' && args[1] === 'fork-remote' && args[2] === 'base-sha') {
          worktreeGit._seenBaseFetch = true;
          return '';
        }
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('head-sha\n'),
    });
    worktreeGit._seenBaseFetch = false;

    manager._gitFor = vi.fn((dirPath) => (dirPath === repoPath ? repoGit : worktreeGit));

    await manager.createWorktreeForPR(
      { owner: 'owner', repo: 'repo', number: 42 },
      { base_branch: 'main', base_sha: 'base-sha', head_sha: 'head-sha', head_branch: 'feature' },
      repoPath
    );

    expect(worktreeGit.raw).toHaveBeenCalledWith(['fetch', 'fork-remote', 'base-sha']);
  });

  it('fetches the exact base SHA when updating an existing worktree', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file' && args[2] === 'base-sha') {
          if (!worktreeGit._seenBaseFetch) {
            throw new Error('missing');
          }
          return 'commit\n';
        }
        if (args[0] === 'fetch' && args[1] === 'fork-remote' && args[2] === 'base-sha') {
          worktreeGit._seenBaseFetch = true;
          return '';
        }
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('head-sha\n'),
    });
    worktreeGit._seenBaseFetch = false;

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    await manager.updateWorktree('owner', 'repo', 42, {
      base_sha: 'base-sha',
      head_sha: 'head-sha',
    });

    expect(worktreeGit.fetch).toHaveBeenCalledWith(['fork-remote', '--prune']);
    expect(worktreeGit.raw).toHaveBeenCalledWith(['fetch', 'fork-remote', 'base-sha']);
    expect(worktreeGit.checkout).toHaveBeenCalledWith(['refs/remotes/fork-remote/pr-42']);
  });

  it('uses nested REST-format SHAs during update verification', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') {
          return 'commit\n';
        }
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('nested-head-sha\n'),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    await manager.updateWorktree('owner', 'repo', 42, {
      base: { sha: 'nested-base-sha' },
      head: { sha: 'nested-head-sha' },
    });

    expect(worktreeGit.checkout).toHaveBeenCalledWith(['refs/remotes/fork-remote/pr-42']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('fetches the exact base SHA when refreshing an existing worktree record', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file' && args[2] === 'base-sha') {
          if (!worktreeGit._seenBaseFetch) {
            throw new Error('missing');
          }
          return 'commit\n';
        }
        if (args[0] === 'fetch' && args[1] === 'fork-remote' && args[2] === 'base-sha') {
          worktreeGit._seenBaseFetch = true;
          return '';
        }
        return '';
      }),
    });
    worktreeGit._seenBaseFetch = false;

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    await manager.refreshWorktree(
      { id: 'wt-1', path: '/tmp/worktrees/existing' },
      42,
      { base_sha: 'base-sha', head_sha: 'head-sha' },
      { owner: 'owner', repo: 'repo', number: 42 }
    );

    expect(worktreeGit.raw).toHaveBeenCalledWith(['fetch', 'fork-remote', 'base-sha']);
    expect(worktreeGit.raw).toHaveBeenCalledWith(['reset', '--hard', 'refs/remotes/fork-remote/pr-42']);
  });

  it('fails with a targeted diff error when the base SHA is missing locally', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file' && args[2] === 'base-sha') {
          throw new Error('missing');
        }
        return 'commit\n';
      }),
    });

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    const error = await manager.generateUnifiedDiff('/tmp/worktrees/existing', {
      base_sha: 'base-sha',
      head_sha: 'head-sha',
    }).catch((err) => err);

    expect(error.message).toBe(
      'Failed to generate diff: Base SHA base-sha is not available locally. Refresh the worktree to fetch the missing commit before generating the diff.'
    );
    expect(error.code).toBe(MISSING_COMMIT_ERROR_CODE);

    expect(worktreeGit.diff).not.toHaveBeenCalled();
  });

  it('passes BASE_SHA to checkout scripts when PR data uses nested REST-format SHAs', async () => {
    const repoPath = '/tmp/repo';
    const repoGit = createMockGit();
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') {
          return 'commit\n';
        }
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('nested-head\n'),
    });

    manager._gitFor = vi.fn((dirPath) => (dirPath === repoPath ? repoGit : worktreeGit));
    manager.executeCheckoutScript = vi.fn().mockResolvedValue(undefined);

    await manager.createWorktreeForPR(
      { owner: 'owner', repo: 'repo', number: 42 },
      {
        base_branch: 'main',
        base: { sha: 'nested-base', ref: 'main' },
        head: { sha: 'nested-head', ref: 'feature' },
      },
      repoPath,
      { checkoutScript: '/tmp/checkout.sh' }
    );

    expect(manager.executeCheckoutScript).toHaveBeenCalledWith(
      '/tmp/checkout.sh',
      expect.any(String),
      expect.objectContaining({
        BASE_SHA: 'nested-base',
        HEAD_SHA: 'nested-head',
      }),
      undefined
    );
  });

  it('uses --numstat when collecting changed files so long paths are not abbreviated', async () => {
    const longPath = 'areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx';
    const worktreeGit = createMockGit({
      diffSummary: vi.fn().mockResolvedValue({
        files: [{ file: longPath, insertions: 12, deletions: 3, changes: 15, binary: false }]
      })
    });

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);
    manager.assertCommitAvailableLocally = vi.fn().mockResolvedValue(undefined);

    const result = await manager.getChangedFiles('/tmp/worktrees/existing', {
      base_sha: 'base-sha',
      head_sha: 'head-sha'
    });

    expect(worktreeGit.diffSummary).toHaveBeenCalledWith([
      'base-sha...head-sha',
      '--no-color',
      '--no-ext-diff',
      '--no-relative',
      '--numstat'
    ]);
    expect(result[0].file).toBe(longPath);
  });
});
