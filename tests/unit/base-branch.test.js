// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
const { detectBaseBranch } = require('../../src/git/base-branch');

/**
 * Create mock deps for detectBaseBranch testing.
 * Override individual properties as needed.
 */
function createMockDeps(overrides = {}) {
  return {
    execSync: vi.fn(() => { throw new Error('not mocked'); }),
    getGitHubToken: vi.fn(() => ''),
    createGitHubClient: vi.fn(() => ({
      findPRByBranch: vi.fn(() => Promise.resolve(null))
    })),
    ...overrides
  };
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

  it('detects base via Graphite parent branch', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'which gt') return '/usr/local/bin/gt\n';
      if (cmd === 'gt trunk') return 'main\n';
      if (cmd === 'gt branch parent') return 'feature-parent\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature-child', { enableGraphite: true, _deps: deps });
    expect(result).toEqual({ baseBranch: 'feature-parent', source: 'graphite' });
  });

  it('falls back to Graphite trunk when parent equals current branch', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'which gt') return '/usr/local/bin/gt\n';
      if (cmd === 'gt trunk') return 'main\n';
      if (cmd === 'gt branch parent') return 'my-branch\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'my-branch', { enableGraphite: true, _deps: deps });
    expect(result).toEqual({ baseBranch: 'main', source: 'graphite' });
  });

  it('skips Graphite when enableGraphite is false', async () => {
    const execSync = vi.fn((cmd) => {
      // gt is installed, but should NOT be called when enableGraphite is false
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      if (cmd.includes('rev-parse --verify')) return 'abc123\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { _deps: deps });
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
    // Verify gt commands were never called
    expect(execSync).not.toHaveBeenCalledWith('which gt', expect.anything());
  });

  it('skips Graphite gracefully when gt is not installed', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'which gt') throw new Error('not found');
      // Default branch fallback
      if (cmd === 'git remote show origin') return '  HEAD branch: main\n';
      if (cmd.includes('rev-parse --verify')) return 'abc123\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { enableGraphite: true, _deps: deps });
    expect(result).toEqual({ baseBranch: 'main', source: 'default-branch' });
  });

  // -- GitHub PR priority --

  it('detects base via GitHub PR when Graphite is unavailable', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'which gt') throw new Error('not found');
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
      if (cmd === 'which gt') throw new Error('not found');
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
      if (cmd === 'which gt') throw new Error('not found');
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
      if (cmd === 'which gt') throw new Error('not found');
      if (cmd === 'git remote show origin') return '  HEAD branch: develop\n';
      throw new Error(`unexpected: ${cmd}`);
    });
    const deps = createMockDeps({ execSync });

    const result = await detectBaseBranch('/repo', 'feature', { _deps: deps });
    expect(result).toEqual({ baseBranch: 'develop', source: 'default-branch' });
  });

  it('falls back to local main when remote fails', async () => {
    const execSync = vi.fn((cmd) => {
      if (cmd === 'which gt') throw new Error('not found');
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
      if (cmd === 'which gt') throw new Error('not found');
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
      if (cmd === 'which gt') throw new Error('not found');
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
      if (cmd === 'which gt') throw new Error('not found');
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
