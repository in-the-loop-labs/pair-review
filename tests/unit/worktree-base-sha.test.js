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
        if (args[0] === 'fetch' && args[1] === '--no-tags' && args[2] === 'fork-remote' && args[3] === 'base-sha') {
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

    expect(repoGit.fetch).toHaveBeenCalledWith([
      '--no-tags',
      'fork-remote',
      '+refs/heads/main:refs/remotes/fork-remote/main',
    ]);
    expect(worktreeGit.raw).toHaveBeenCalledWith(['fetch', '--no-tags', 'fork-remote', 'base-sha']);
  });

  it('prunes stale remote-tracking refs and retries when the base branch fetch hits a ref hierarchy conflict', async () => {
    const repoPath = '/tmp/repo';
    const repoGit = createMockGit({
      fetch: vi.fn()
        .mockRejectedValueOnce(new Error("cannot lock ref 'refs/remotes/fork-remote/main/x': 'refs/remotes/fork-remote/main' exists"))
        .mockResolvedValue(undefined),
    });
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('head-sha\n'),
    });

    manager._gitFor = vi.fn((dirPath) => (dirPath === repoPath ? repoGit : worktreeGit));

    await manager.createWorktreeForPR(
      { owner: 'owner', repo: 'repo', number: 42 },
      { base_branch: 'main', base_sha: 'base-sha', head_sha: 'head-sha', head_branch: 'feature' },
      repoPath
    );

    expect(repoGit.raw).toHaveBeenCalledWith(['remote', 'prune', 'fork-remote']);
    expect(repoGit.fetch).toHaveBeenNthCalledWith(2, [
      '--no-tags',
      'fork-remote',
      '+refs/heads/main:refs/remotes/fork-remote/main',
    ]);
    expect(repoGit.raw).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch', '--force'])
    );
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
        if (args[0] === 'fetch' && args[1] === '--no-tags' && args[2] === 'fork-remote' && args[3] === 'base-sha') {
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

    expect(worktreeGit.fetch).not.toHaveBeenCalledWith(['--no-tags', '--prune', 'fork-remote']);
    expect(worktreeGit.raw).toHaveBeenCalledWith(['fetch', '--no-tags', 'fork-remote', 'base-sha']);
    expect(worktreeGit.checkout).toHaveBeenCalledWith(['refs/remotes/fork-remote/pr-42']);
  });

  it('fetches only the base branch when updating, never a bulk prune fetch', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('head-sha\n'),
    });

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    await manager.updateWorktree(
      'owner', 'repo', 42,
      { base_sha: 'base-sha', head_sha: 'head-sha', base_branch: 'main' }
    );

    expect(worktreeGit.fetch).toHaveBeenCalledWith([
      '--no-tags',
      'fork-remote',
      '+refs/heads/main:refs/remotes/fork-remote/main',
    ]);
    expect(worktreeGit.fetch).not.toHaveBeenCalledWith(['--no-tags', '--prune', 'fork-remote']);
    expect(worktreeGit.checkout).toHaveBeenCalledWith(['refs/remotes/fork-remote/pr-42']);
  });

  it('prunes and retries when the update base-branch fetch hits a ref hierarchy conflict', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('head-sha\n'),
    });
    worktreeGit.fetch = vi.fn()
      .mockRejectedValueOnce(new Error("cannot lock ref 'refs/remotes/fork-remote/main/x': 'refs/remotes/fork-remote/main' exists"))
      .mockResolvedValue(undefined);

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    await manager.updateWorktree(
      'owner', 'repo', 42,
      { base_sha: 'base-sha', head_sha: 'head-sha', base_branch: 'main' }
    );

    expect(worktreeGit.raw).toHaveBeenCalledWith(['remote', 'prune', 'fork-remote']);
    expect(worktreeGit.fetch).toHaveBeenNthCalledWith(2, [
      '--no-tags',
      'fork-remote',
      '+refs/heads/main:refs/remotes/fork-remote/main',
    ]);
    expect(worktreeGit.checkout).toHaveBeenCalledWith(['refs/remotes/fork-remote/pr-42']);
  });

  it('tolerates a failed targeted base-branch fetch and proceeds to checkout', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('head-sha\n'),
    });
    worktreeGit.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('fatal: could not read from remote repository'))
      .mockResolvedValue(undefined);

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    await expect(manager.updateWorktree(
      'owner', 'repo', 42,
      { base_sha: 'base-sha', head_sha: 'head-sha', base_branch: 'main' }
    )).resolves.toBeDefined();

    expect(worktreeGit.raw).not.toHaveBeenCalledWith(['remote', 'prune', 'fork-remote']);
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
    // This payload carries a base SHA but no ref anywhere, so the advisory
    // missing-base-branch warn fires — only fetch failures would be a problem.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No base branch recorded for PR #42')
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Targeted base-branch fetch failed')
    );
  });

  it('fetches the base branch from a nested REST base.ref during update', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('nested-head-sha\n'),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    await manager.updateWorktree('owner', 'repo', 42, {
      base: { sha: 'nested-base-sha', ref: 'main' },
      head: { sha: 'nested-head-sha' },
    });

    expect(worktreeGit.fetch).toHaveBeenCalledWith([
      '--no-tags',
      'fork-remote',
      '+refs/heads/main:refs/remotes/fork-remote/main',
    ]);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('No base branch recorded')
    );
  });

  it('tolerates a non-hierarchy base-branch fetch failure when creating a worktree', async () => {
    const repoPath = '/tmp/repo';
    const repoGit = createMockGit({
      fetch: vi.fn().mockRejectedValue(new Error('fatal: could not read from remote repository')),
    });
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
      revparse: vi.fn().mockResolvedValue('head-sha\n'),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    manager._gitFor = vi.fn((dirPath) => (dirPath === repoPath ? repoGit : worktreeGit));

    await expect(manager.createWorktreeForPR(
      { owner: 'owner', repo: 'repo', number: 42 },
      { base_branch: 'main', base_sha: 'base-sha', head_sha: 'head-sha', head_branch: 'feature' },
      repoPath
    )).resolves.toBeDefined();

    expect(repoGit.raw).not.toHaveBeenCalledWith(['remote', 'prune', 'fork-remote']);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not fetch base branch main')
    );
    // The flow continues: the worktree is still created from the existing ref.
    expect(repoGit.raw).toHaveBeenCalledWith(
      expect.arrayContaining(['worktree', 'add'])
    );
  });

  it('creates the worktree from the base SHA when the PR data carries no base branch', async () => {
    const repoPath = '/tmp/repo';
    const repoGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file' && args[2] === 'nested-base') {
          if (!repoGit._seenBaseFetch) {
            throw new Error('missing');
          }
          return 'commit\n';
        }
        if (args[0] === 'fetch' && args[1] === '--no-tags' && args[2] === 'fork-remote' && args[3] === 'nested-base') {
          repoGit._seenBaseFetch = true;
          return '';
        }
        return '';
      }),
    });
    repoGit._seenBaseFetch = false;
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    manager._gitFor = vi.fn((dirPath) => (dirPath === repoPath ? repoGit : worktreeGit));

    await expect(manager.createWorktreeForPR(
      { owner: 'owner', repo: 'repo', number: 42 },
      { base: { sha: 'nested-base' }, head: { sha: 'head-sha' } },
      repoPath
    )).resolves.toBeDefined();

    const rawCalls = repoGit.raw.mock.calls.map(([args]) => args);
    const addCall = rawCalls.find(args => args[0] === 'worktree' && args[1] === 'add');
    // The bare SHA is the start point — `fork-remote/null` is not a ref.
    expect(addCall[addCall.length - 1]).toBe('nested-base');
    expect(rawCalls.some(args => args.includes('fork-remote/null'))).toBe(false);

    // The SHA must land in the source repo's object store before the add,
    // since the add itself resolves the start point.
    const fetchIndex = rawCalls.findIndex(args => args[0] === 'fetch' && args[3] === 'nested-base');
    const addIndex = rawCalls.indexOf(addCall);
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeLessThan(addIndex);
  });

  it('fails with a PR-specific error when the PR data has neither a base branch nor a base SHA', async () => {
    const repoPath = '/tmp/repo';
    const repoGit = createMockGit();
    const worktreeGit = createMockGit();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    manager._gitFor = vi.fn((dirPath) => (dirPath === repoPath ? repoGit : worktreeGit));

    await expect(manager.createWorktreeForPR(
      { owner: 'owner', repo: 'repo', number: 42 },
      { head_sha: 'head-sha' },
      repoPath
    )).rejects.toThrow(/PR #42 \(owner\/repo\).*neither a base branch nor a base SHA/);

    expect(repoGit.raw).not.toHaveBeenCalledWith(
      expect.arrayContaining(['worktree', 'add'])
    );
  });

  it('prunes and retries when the checkout-script head-branch fetch hits a ref hierarchy conflict', async () => {
    const repoPath = '/tmp/repo';
    const repoGit = createMockGit();
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
      fetch: vi.fn()
        .mockRejectedValueOnce(new Error("cannot lock ref 'refs/remotes/fork-remote/feature/x': 'refs/remotes/fork-remote/feature' exists"))
        .mockResolvedValue(undefined),
    });

    manager._gitFor = vi.fn((dirPath) => (dirPath === repoPath ? repoGit : worktreeGit));
    manager.executeCheckoutScript = vi.fn().mockResolvedValue(undefined);

    await expect(manager.createWorktreeForPR(
      { owner: 'owner', repo: 'repo', number: 42 },
      { base_branch: 'main', base_sha: 'base-sha', head_sha: 'head-sha', head_branch: 'feature' },
      repoPath,
      { checkoutScript: '/tmp/checkout.sh' }
    )).resolves.toBeDefined();

    expect(worktreeGit.raw).toHaveBeenCalledWith(['remote', 'prune', 'fork-remote']);
    expect(worktreeGit.fetch).toHaveBeenNthCalledWith(2, [
      '--no-tags',
      'fork-remote',
      '+refs/heads/feature:refs/remotes/fork-remote/feature',
    ]);
    // The retry succeeded, so the local branch is still created.
    expect(worktreeGit.branch).toHaveBeenCalledWith(['-f', 'feature', 'fork-remote/feature']);
  });

  it('tolerates a missing head branch on the base remote for fork PRs', async () => {
    const repoPath = '/tmp/repo';
    const repoGit = createMockGit();
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
      fetch: vi.fn().mockRejectedValue(new Error("couldn't find remote ref refs/heads/feature")),
    });

    manager._gitFor = vi.fn((dirPath) => (dirPath === repoPath ? repoGit : worktreeGit));
    manager.executeCheckoutScript = vi.fn().mockResolvedValue(undefined);

    await expect(manager.createWorktreeForPR(
      { owner: 'owner', repo: 'repo', number: 42 },
      { base_branch: 'main', base_sha: 'base-sha', head_sha: 'head-sha', head_branch: 'feature' },
      repoPath,
      { checkoutScript: '/tmp/checkout.sh' }
    )).resolves.toBeDefined();

    // A fork's head branch legitimately does not exist on the base remote, so
    // the failure must not prune or abort the checkout-script flow.
    expect(worktreeGit.raw).not.toHaveBeenCalledWith(['remote', 'prune', 'fork-remote']);
    expect(manager.executeCheckoutScript).toHaveBeenCalled();
  });

  it('fetches the base branch before refreshing an existing worktree', async () => {
    const worktreeGit = createMockGit({
      raw: vi.fn(async (args) => {
        if (args[0] === 'cat-file') return 'commit\n';
        return '';
      }),
    });

    manager._gitFor = vi.fn().mockReturnValue(worktreeGit);

    await manager.refreshWorktree(
      { id: 'wt-1', path: '/tmp/worktrees/existing' },
      42,
      { base_branch: 'main', base_sha: 'base-sha', head_sha: 'head-sha' },
      { owner: 'owner', repo: 'repo', number: 42 }
    );

    expect(worktreeGit.fetch).toHaveBeenCalledWith([
      '--no-tags',
      'fork-remote',
      '+refs/heads/main:refs/remotes/fork-remote/main',
    ]);
    expect(worktreeGit.raw).toHaveBeenCalledWith(['reset', '--hard', 'refs/remotes/fork-remote/pr-42']);
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
        if (args[0] === 'fetch' && args[1] === '--no-tags' && args[2] === 'fork-remote' && args[3] === 'base-sha') {
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

    expect(worktreeGit.raw).toHaveBeenCalledWith(['fetch', '--no-tags', 'fork-remote', 'base-sha']);
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
