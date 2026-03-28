// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
const { detectBaseBranch, getDefaultBranch, buildStack, readGraphitePRInfo, enrichStackWithPRInfo } = require('../../src/git/base-branch');

/**
 * Create mock deps for detectBaseBranch testing.
 * Override individual properties as needed.
 */
function createMockDeps(overrides = {}) {
  return {
    execSync: vi.fn(() => { throw new Error('not mocked'); }),
    readFileSync: vi.fn(() => { throw new Error('not mocked'); }),
    getGitHubToken: vi.fn(() => ''),
    createGitHubClient: vi.fn(() => ({
      findPRByBranch: vi.fn(() => Promise.resolve(null))
    })),
    ...overrides
  };
}

/**
 * Helper to build a gt state JSON object for testing.
 */
function makeGtState(entries) {
  const state = {};
  for (const [name, opts] of Object.entries(entries)) {
    state[name] = {
      trunk: opts.trunk || false,
      needs_restack: false,
      ...(opts.parent ? { parents: [{ ref: opts.parent, sha: opts.parentSha || 'abc123' }] } : {})
    };
  }
  return state;
}

describe('detectBaseBranch', () => {
  it('returns null for detached HEAD', async () => {
    const result = await detectBaseBranch('/repo', 'HEAD', { _deps: createMockDeps() });
    expect(result).toBeNull();
  });

  it('returns null for empty branch name', async () => {
    const result = await detectBaseBranch('/repo', '', { _deps: createMockDeps() });
    expect(result).toBeNull();
  });

  // -- Graphite priority --

  it('detects base via Graphite gt state', async () => {
    const gtState = makeGtState({
      main: { trunk: true },
      'feature-parent': { parent: 'main' },
      'feature-child': { parent: 'feature-parent' }
    });
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') return JSON.stringify(gtState);
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature-child', { enableGraphite: true, _deps: deps });
    expect(result.baseBranch).toBe('feature-parent');
    expect(result.source).toBe('graphite');
    expect(result.stack).toBeDefined();
    expect(result.stack.length).toBe(3);
  });

  it('returns null from Graphite when parent equals current branch', async () => {
    const gtState = {
      main: { trunk: true },
      'my-branch': { trunk: false, needs_restack: false, parents: [{ ref: 'my-branch', sha: 'abc123' }] }
    };
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') return JSON.stringify(gtState);
      // Falls through to default branch detection
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      if (cmd.includes('rev-parse --verify')) return 'abc123\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'my-branch', { enableGraphite: true, _deps: deps });
    // parent === currentBranch, so Graphite returns null and falls through
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
  });

  it('skips Graphite when enableGraphite is false', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      if (cmd.includes('rev-parse --verify')) return 'abc123\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { _deps: deps });
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
    // Verify gt state was never called
    expect(execSync).not.toHaveBeenCalledWith('gt state', expect.anything());
  });

  it('falls back gracefully when gt state fails', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('gt not installed');
      // Default branch fallback
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      if (cmd.includes('rev-parse --verify')) return 'abc123\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { enableGraphite: true, _deps: deps });
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
  });

  it('returns stack array with Graphite result', async () => {
    const gtState = makeGtState({
      main: { trunk: true },
      'feat-a': { parent: 'main' },
      'feat-b': { parent: 'feat-a' }
    });
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') return JSON.stringify(gtState);
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feat-b', { enableGraphite: true, _deps: deps });
    expect(result.baseBranch).toBe('feat-a');
    expect(result.source).toBe('graphite');
    expect(result.stack).toEqual([
      { branch: 'main', parentBranch: null, parentSha: null, isTrunk: true },
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'abc123', isTrunk: false },
      { branch: 'feat-b', parentBranch: 'feat-a', parentSha: 'abc123', isTrunk: false }
    ]);
  });

  it('falls back to GitHub when gt state returns invalid JSON', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') return 'not json';
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { enableGraphite: true, _deps: deps });
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
  });

  // -- GitHub PR priority --

  it('detects base via GitHub PR when Graphite is unavailable', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('not found');
      throw new Error('no remote');
    });
    const mockClient = {
      findPRByBranch: vi.fn(() => Promise.resolve({ baseBranch: 'develop', prNumber: 42 }))
    };
    const deps = createMockDeps({
      execSync,
      getGitHubToken: vi.fn(() => 'ghp_token'),
      createGitHubClient: vi.fn(() => mockClient)
    });

    const result = await detectBaseBranch('/repo', 'feature', {
      repository: 'owner/repo',
      _deps: deps
    });
    expect(result).toEqual({ baseBranch: 'develop', source: 'github-pr', prNumber: 42 });
    expect(mockClient.findPRByBranch).toHaveBeenCalledWith('owner', 'repo', 'feature');
  });

  it('skips GitHub when no token is available', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('not found');
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({
      execSync,
      getGitHubToken: vi.fn(() => '')
    });

    const result = await detectBaseBranch('/repo', 'feature', {
      repository: 'owner/repo',
      _deps: deps
    });
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
  });

  it('skips GitHub when no repository is provided', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('not found');
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { _deps: deps });
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
  });

  // -- Default branch priority --

  it('detects default branch from git remote show origin', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('not found');
      if (cmd === 'git remote show origin') return '  HEAD branch: develop\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { _deps: deps });
    expect(result).toEqual({ baseBranch: 'develop', source: 'default-branch' });
  });

  it('falls back to local main when remote fails', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('not found');
      if (cmd === 'git remote show origin') throw new Error('no remote');
      if (cmd === 'git rev-parse --verify main') return 'abc123\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { _deps: deps });
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
  });

  it('falls back to local master when main does not exist', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('not found');
      if (cmd === 'git remote show origin') throw new Error('no remote');
      if (cmd === 'git rev-parse --verify main') throw new Error('not found');
      if (cmd === 'git rev-parse --verify master') return 'abc123\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { _deps: deps });
    expect(result).toEqual({ baseBranch: 'master', source: 'default-branch' });
  });

  it('returns null when current branch IS the default branch', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('not found');
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'main', { _deps: deps });
    expect(result).toBeNull();
  });

  it('returns null when nothing can be determined', async () => {
    const execSync = vi.fn(() => { throw new Error('fail'); });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { _deps: deps });
    expect(result).toBeNull();
  });

  it('guards against GitHub PR returning same branch as base', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'gt state') throw new Error('not found');
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const mockClient = {
      findPRByBranch: vi.fn(() => Promise.resolve({ baseBranch: 'feature', prNumber: 42 }))
    };
    const deps = createMockDeps({
      execSync,
      getGitHubToken: vi.fn(() => 'ghp_token'),
      createGitHubClient: vi.fn(() => mockClient)
    });

    const result = await detectBaseBranch('/repo', 'feature', {
      repository: 'owner/repo',
      _deps: deps
    });
    // Should skip the PR result (base === current) and fall back to default branch
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
  });
});

describe('buildStack', () => {
  it('builds a 3-level chain from trunk to current branch', () => {
    const state = makeGtState({
      main: { trunk: true },
      'feat-a': { parent: 'main', parentSha: 'sha-a' },
      'feat-b': { parent: 'feat-a', parentSha: 'sha-b' }
    });

    const result = buildStack(state, 'feat-b', 'main');
    expect(result).toEqual([
      { branch: 'main', parentBranch: null, parentSha: null, isTrunk: true },
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false },
      { branch: 'feat-b', parentBranch: 'feat-a', parentSha: 'sha-b', isTrunk: false }
    ]);
  });

  it('builds a single branch directly off trunk', () => {
    const state = makeGtState({
      main: { trunk: true },
      'feat-a': { parent: 'main', parentSha: 'sha-a' }
    });

    const result = buildStack(state, 'feat-a', 'main');
    expect(result).toEqual([
      { branch: 'main', parentBranch: null, parentSha: null, isTrunk: true },
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false }
    ]);
  });

  it('terminates on cycle without infinite loop', () => {
    const state = {
      main: { trunk: true },
      'cycle-a': { trunk: false, needs_restack: false, parents: [{ ref: 'cycle-b', sha: 'sha-a' }] },
      'cycle-b': { trunk: false, needs_restack: false, parents: [{ ref: 'cycle-a', sha: 'sha-b' }] }
    };

    const result = buildStack(state, 'cycle-a', 'main');
    // Should terminate and prepend trunk since the walk never reached it
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].branch).toBe('main');
    expect(result[0].isTrunk).toBe(true);
    // Both cycle branches should appear exactly once
    const branches = result.map(e => e.branch);
    expect(branches.filter(b => b === 'cycle-a').length).toBe(1);
    expect(branches.filter(b => b === 'cycle-b').length).toBe(1);
  });

  it('terminates when branch is missing from state', () => {
    const state = makeGtState({
      main: { trunk: true },
      'feat-a': { parent: 'missing-branch', parentSha: 'sha-a' }
    });

    const result = buildStack(state, 'feat-a', 'main');
    // Walk stops at feat-a because missing-branch is not in state
    // Trunk should be prepended since walk didn't reach it
    expect(result).toEqual([
      { branch: 'main', parentBranch: null, parentSha: null, isTrunk: true },
      { branch: 'feat-a', parentBranch: 'missing-branch', parentSha: 'sha-a', isTrunk: false }
    ]);
  });

  it('prepends trunk if walk does not reach it', () => {
    // State where the parent chain doesn't go all the way to trunk
    const state = {
      main: { trunk: true },
      'feat-a': { trunk: false, needs_restack: false, parents: [{ ref: 'orphan', sha: 'sha-a' }] },
      orphan: { trunk: false, needs_restack: false, parents: [] }
    };

    const result = buildStack(state, 'feat-a', 'main');
    expect(result[0]).toEqual({ branch: 'main', parentBranch: null, parentSha: null, isTrunk: true });
  });

  it('does not duplicate trunk if walk reaches it', () => {
    const state = makeGtState({
      main: { trunk: true },
      'feat-a': { parent: 'main' }
    });

    const result = buildStack(state, 'feat-a', 'main');
    const trunkEntries = result.filter(e => e.branch === 'main');
    expect(trunkEntries.length).toBe(1);
  });
});

describe('readGraphitePRInfo', () => {
  it('returns parsed JSON from .graphite_pr_info', () => {
    const prInfoData = {
      prInfos: [
        { headRefName: 'feat-a', prNumber: 101 },
        { headRefName: 'feat-b', prNumber: 102 }
      ]
    };
    const deps = createMockDeps({
      execSync: vi.fn(() => '/repo/.git'),
      readFileSync: vi.fn(() => JSON.stringify(prInfoData))
    });

    const result = readGraphitePRInfo('/repo', deps);
    expect(result).toEqual(prInfoData);
    expect(deps.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.graphite_pr_info'),
      'utf8'
    );
  });

  it('returns null when .graphite_pr_info does not exist', () => {
    const deps = createMockDeps({
      execSync: vi.fn(() => '/repo/.git'),
      readFileSync: vi.fn(() => { throw new Error('ENOENT: no such file or directory'); })
    });

    const result = readGraphitePRInfo('/repo', deps);
    expect(result).toBeNull();
  });

  it('returns null when .graphite_pr_info contains invalid JSON', () => {
    const deps = createMockDeps({
      execSync: vi.fn(() => '/repo/.git'),
      readFileSync: vi.fn(() => 'not valid json {{{')
    });

    const result = readGraphitePRInfo('/repo', deps);
    expect(result).toBeNull();
  });

  it('resolves relative git-common-dir against repoPath', () => {
    const prInfoData = { prInfos: [{ headRefName: 'feat-a', prNumber: 101 }] };
    const deps = createMockDeps({
      // Standard (non-worktree) repos return relative '.git'
      execSync: vi.fn(() => '.git'),
      readFileSync: vi.fn(() => JSON.stringify(prInfoData))
    });

    const result = readGraphitePRInfo('/my/repo', deps);
    expect(result).toEqual(prInfoData);
    // path.resolve('/my/repo', '.git', '.graphite_pr_info') => '/my/repo/.git/.graphite_pr_info'
    expect(deps.readFileSync).toHaveBeenCalledWith(
      '/my/repo/.git/.graphite_pr_info',
      'utf8'
    );
  });

  it('returns null when git rev-parse fails', () => {
    const deps = createMockDeps({
      execSync: vi.fn(() => { throw new Error('not a git repository'); })
    });

    const result = readGraphitePRInfo('/repo', deps);
    expect(result).toBeNull();
  });
});

describe('enrichStackWithPRInfo', () => {
  it('matches stack entries by headRefName and adds prNumber', () => {
    const stack = [
      { branch: 'main', parentBranch: null, parentSha: null, isTrunk: true },
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false },
      { branch: 'feat-b', parentBranch: 'feat-a', parentSha: 'sha-b', isTrunk: false }
    ];
    const prInfos = [
      { headRefName: 'feat-a', prNumber: 101 },
      { headRefName: 'feat-b', prNumber: 102 }
    ];

    const result = enrichStackWithPRInfo(stack, prInfos);
    expect(result).toEqual([
      { branch: 'main', parentBranch: null, parentSha: null, isTrunk: true },
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false, prNumber: 101 },
      { branch: 'feat-b', parentBranch: 'feat-a', parentSha: 'sha-b', isTrunk: false, prNumber: 102 }
    ]);
  });

  it('leaves entries unchanged when no matching PR info exists', () => {
    const stack = [
      { branch: 'main', parentBranch: null, parentSha: null, isTrunk: true },
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false }
    ];
    const prInfos = [
      { headRefName: 'unrelated-branch', prNumber: 999 }
    ];

    const result = enrichStackWithPRInfo(stack, prInfos);
    expect(result).toEqual([
      { branch: 'main', parentBranch: null, parentSha: null, isTrunk: true },
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false }
    ]);
  });

  it('returns stack unchanged when prInfos is null', () => {
    const stack = [
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false }
    ];

    const result = enrichStackWithPRInfo(stack, null);
    expect(result).toBe(stack);
  });

  it('returns stack unchanged when prInfos is not an array', () => {
    const stack = [
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false }
    ];

    const result = enrichStackWithPRInfo(stack, 'not-an-array');
    expect(result).toBe(stack);
  });

  it('returns stack unchanged when prInfos is empty array', () => {
    const stack = [
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false }
    ];

    const result = enrichStackWithPRInfo(stack, []);
    // Empty array IS a valid array, so it goes through map but finds no matches
    expect(result).toEqual([
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false }
    ]);
  });

  it('does not mutate original stack entries', () => {
    const stack = [
      { branch: 'feat-a', parentBranch: 'main', parentSha: 'sha-a', isTrunk: false }
    ];
    const prInfos = [{ headRefName: 'feat-a', prNumber: 101 }];

    const result = enrichStackWithPRInfo(stack, prInfos);
    expect(result[0]).not.toBe(stack[0]);
    expect(stack[0]).not.toHaveProperty('prNumber');
  });
});

describe('getDefaultBranch', () => {
  it('returns branch name from symbolic-ref', () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return 'refs/remotes/origin/main\n';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const result = getDefaultBranch('/repo', { execSync });
    expect(result).toBe('main');
    expect(execSync).toHaveBeenCalledWith(
      'git symbolic-ref refs/remotes/origin/HEAD',
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('falls back to main when symbolic-ref fails', () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        throw new Error('not a symbolic ref');
      }
      if (cmd === 'git rev-parse --verify refs/heads/main') {
        return 'abc123\n';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const result = getDefaultBranch('/repo', { execSync });
    expect(result).toBe('main');
  });

  it('falls back to master when symbolic-ref fails and main does not exist', () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        throw new Error('not a symbolic ref');
      }
      if (cmd === 'git rev-parse --verify refs/heads/main') {
        throw new Error('not found');
      }
      if (cmd === 'git rev-parse --verify refs/heads/master') {
        return 'abc123\n';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const result = getDefaultBranch('/repo', { execSync });
    expect(result).toBe('master');
  });

  it('returns null when no default branch can be determined', () => {
    const execSync = vi.fn(() => { throw new Error('fail'); });

    const result = getDefaultBranch('/repo', { execSync });
    expect(result).toBeNull();
  });

  it('returns null when no localPath is provided', () => {
    const execSync = vi.fn();

    expect(getDefaultBranch(null, { execSync })).toBeNull();
    expect(getDefaultBranch(undefined, { execSync })).toBeNull();
    expect(getDefaultBranch('', { execSync })).toBeNull();
    // execSync should never have been called
    expect(execSync).not.toHaveBeenCalled();
  });
});
