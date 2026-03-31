// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

const loggerModule = require('../../src/utils/logger');

vi.spyOn(loggerModule, 'info').mockImplementation(() => {});
vi.spyOn(loggerModule, 'warn').mockImplementation(() => {});
vi.spyOn(loggerModule, 'error').mockImplementation(() => {});
vi.spyOn(loggerModule, 'debug').mockImplementation(() => {});

const { walkPRStack } = require('../../src/github/stack-walker');

/**
 * Helper to build a mock client whose octokit.graphql resolves based on
 * a sequence of return values or a dynamic handler function.
 */
function createMockClient(graphqlImpl) {
  return {
    octokit: {
      graphql: typeof graphqlImpl === 'function'
        ? vi.fn(graphqlImpl)
        : vi.fn(),
    },
  };
}

/** Shorthand to create a PR node as returned by GraphQL */
function makePR({ number, title, base, head, state = 'OPEN', url }) {
  return {
    number,
    title: title || `PR #${number}`,
    baseRefName: base,
    headRefName: head,
    state,
    url: url || `https://github.com/owner/repo/pull/${number}`,
  };
}

describe('walkPRStack', () => {
  describe('happy path: 3-PR stack', () => {
    it('should discover full stack when starting from middle PR', async () => {
      // Stack: main <- feat-a (#1) <- feat-b (#2) <- feat-c (#3)
      // Starting from #2
      const prA = makePR({ number: 1, base: 'main', head: 'feat-a', state: 'MERGED' });
      const prB = makePR({ number: 2, base: 'feat-a', head: 'feat-b' });
      const prC = makePR({ number: 3, base: 'feat-b', head: 'feat-c' });

      const client = createMockClient((query, vars) => {
        // Fetch starting PR by number
        if (vars.number === 2) {
          return { repository: { pullRequest: prB } };
        }
        // Walk UP: find PR whose head is feat-a
        if (vars.branch === 'feat-a' && query.includes('headRefName')) {
          return { repository: { pullRequests: { nodes: [prA] } } };
        }
        // Walk UP: feat-a's base is main -> trunk, no query needed
        // Walk DOWN: find PR whose base is feat-b
        if (vars.branch === 'feat-b' && query.includes('baseRefName')) {
          return { repository: { pullRequests: { nodes: [prC] } } };
        }
        // Walk DOWN: no child of feat-c
        if (vars.branch === 'feat-c' && query.includes('baseRefName')) {
          return { repository: { pullRequests: { nodes: [] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 2);

      expect(stack).toHaveLength(4);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1, state: 'MERGED', isTrunk: false });
      expect(stack[2]).toMatchObject({ branch: 'feat-b', prNumber: 2, state: 'OPEN', isTrunk: false });
      expect(stack[3]).toMatchObject({ branch: 'feat-c', prNumber: 3, state: 'OPEN', isTrunk: false });
    });
  });

  describe('starting PR is bottom of stack (base is main, has children)', () => {
    it('should walk down only', async () => {
      const prA = makePR({ number: 1, base: 'main', head: 'feat-a' });
      const prB = makePR({ number: 2, base: 'feat-a', head: 'feat-b' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 1) {
          return { repository: { pullRequest: prA } };
        }
        if (vars.branch === 'feat-a' && query.includes('baseRefName')) {
          return { repository: { pullRequests: { nodes: [prB] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 1);

      expect(stack).toHaveLength(3);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
      expect(stack[2]).toMatchObject({ branch: 'feat-b', prNumber: 2 });
    });
  });

  describe('starting PR is top of stack (has parents, no children)', () => {
    it('should walk up only', async () => {
      const prA = makePR({ number: 1, base: 'main', head: 'feat-a' });
      const prB = makePR({ number: 2, base: 'feat-a', head: 'feat-b' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 2) {
          return { repository: { pullRequest: prB } };
        }
        // Walk UP: find PR whose head is feat-a
        if (vars.branch === 'feat-a' && query.includes('headRefName')) {
          return { repository: { pullRequests: { nodes: [prA] } } };
        }
        // Walk DOWN: no child of feat-b
        if (vars.branch === 'feat-b' && query.includes('baseRefName')) {
          return { repository: { pullRequests: { nodes: [] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 2);

      expect(stack).toHaveLength(3);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
      expect(stack[2]).toMatchObject({ branch: 'feat-b', prNumber: 2 });
    });
  });

  describe('single PR (not part of a stack)', () => {
    it('should return trunk + the single PR', async () => {
      const prA = makePR({ number: 42, base: 'main', head: 'fix-bug' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 42) {
          return { repository: { pullRequest: prA } };
        }
        // No children
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 42);

      expect(stack).toHaveLength(2);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'fix-bug', prNumber: 42 });
    });
  });

  describe('merged PR in the middle of chain', () => {
    it('should include merged PR in the stack', async () => {
      const prA = makePR({ number: 1, base: 'main', head: 'feat-a', state: 'MERGED' });
      const prB = makePR({ number: 2, base: 'feat-a', head: 'feat-b', state: 'MERGED' });
      const prC = makePR({ number: 3, base: 'feat-b', head: 'feat-c' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 3) {
          return { repository: { pullRequest: prC } };
        }
        if (vars.branch === 'feat-b' && query.includes('headRefName')) {
          return { repository: { pullRequests: { nodes: [prB] } } };
        }
        if (vars.branch === 'feat-a' && query.includes('headRefName')) {
          return { repository: { pullRequests: { nodes: [prA] } } };
        }
        if (vars.branch === 'feat-c' && query.includes('baseRefName')) {
          return { repository: { pullRequests: { nodes: [] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 3);

      expect(stack).toHaveLength(4);
      expect(stack[1]).toMatchObject({ state: 'MERGED', prNumber: 1 });
      expect(stack[2]).toMatchObject({ state: 'MERGED', prNumber: 2 });
      expect(stack[3]).toMatchObject({ state: 'OPEN', prNumber: 3 });
    });
  });

  describe('cycle detection', () => {
    it('should stop when a branch is visited twice during upward walk', async () => {
      // Cycle: feat-a -> feat-b -> feat-a (base of feat-b is feat-a, and
      // we find a PR whose head is feat-b pointing at feat-a as its base)
      const prA = makePR({ number: 1, base: 'feat-b', head: 'feat-a' });
      const prB = makePR({ number: 2, base: 'feat-a', head: 'feat-b' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 2) {
          return { repository: { pullRequest: prB } };
        }
        // Walk UP: find PR whose head is feat-a
        if (vars.branch === 'feat-a' && query.includes('headRefName')) {
          return { repository: { pullRequests: { nodes: [prA] } } };
        }
        // Walk UP: prA's base is feat-b, but feat-b is already visited -> cycle
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 2);

      // Should stop at cycle, not loop forever
      // trunk is feat-b (prA's base, which was detected as a cycle)
      // But since feat-b is visited (it's the starting PR's head), the upward
      // walk finds prA then tries prA.base=feat-b which is visited -> stops
      expect(stack.length).toBeGreaterThanOrEqual(2);
      // Verify it terminated (didn't loop forever) — finite number of calls
      expect(client.octokit.graphql.mock.calls.length).toBeLessThan(10);
    });

    it('should stop when a branch is visited twice during downward walk', async () => {
      const prA = makePR({ number: 1, base: 'main', head: 'feat-a' });
      // Child points back to feat-a (cycle)
      const prCyclic = makePR({ number: 99, base: 'feat-a', head: 'feat-a' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 1) {
          return { repository: { pullRequest: prA } };
        }
        if (vars.branch === 'feat-a' && query.includes('baseRefName')) {
          return { repository: { pullRequests: { nodes: [prCyclic] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 1);

      // feat-a is already visited from starting PR, so child cycle is detected
      expect(stack).toHaveLength(2);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
    });
  });

  describe('max depth cap', () => {
    it('should stop after 20 iterations walking up', async () => {
      // Build a chain of 25 PRs: main <- br-0 <- br-1 <- ... <- br-24
      // Start from the tip (br-24)
      const prs = [];
      for (let i = 0; i < 25; i++) {
        prs.push(makePR({
          number: i + 1,
          base: i === 0 ? 'main' : `br-${i - 1}`,
          head: `br-${i}`,
        }));
      }

      const client = createMockClient((query, vars) => {
        if (vars.number === 25) {
          return { repository: { pullRequest: prs[24] } };
        }
        // Walk UP: find PR by head branch name
        if (query.includes('headRefName')) {
          const pr = prs.find(p => p.headRefName === vars.branch);
          return { repository: { pullRequests: { nodes: pr ? [pr] : [] } } };
        }
        // Walk DOWN: no children from the tip
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 25);

      // Should have trunk + at most 20 parents + starting PR = 22
      // (walk cap prevents discovering all 24 parents)
      expect(stack.length).toBeLessThanOrEqual(22);
      // The first entry is always a trunk marker for the base of the topmost
      // discovered PR, even if we didn't actually reach main/master/develop.
      expect(stack[0].isTrunk).toBe(true);
      // Since we found 20 parents (br-24 start, walk up 20 = br-4), the trunk
      // marker is br-4's base = br-3
      expect(stack[0].branch).toBe(`br-${24 - 20 - 1}`);
    });

    it('should stop after 20 iterations walking down', async () => {
      // Build a chain: main <- br-0 <- br-1 <- ... <- br-24
      // Start from the bottom (br-0)
      const prs = [];
      for (let i = 0; i < 25; i++) {
        prs.push(makePR({
          number: i + 1,
          base: i === 0 ? 'main' : `br-${i - 1}`,
          head: `br-${i}`,
        }));
      }

      const client = createMockClient((query, vars) => {
        if (vars.number === 1) {
          return { repository: { pullRequest: prs[0] } };
        }
        // Walk DOWN: find PR by base branch name
        if (query.includes('baseRefName')) {
          const pr = prs.find(p => p.baseRefName === vars.branch);
          return { repository: { pullRequests: { nodes: pr ? [pr] : [] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 1);

      // trunk + starting PR + at most 20 children = 22
      expect(stack.length).toBeLessThanOrEqual(22);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'br-0', prNumber: 1 });
    });
  });

  describe('multiple PRs for same branch: prefers OPEN over MERGED', () => {
    it('should pick the OPEN PR when both OPEN and MERGED exist', async () => {
      const prStart = makePR({ number: 3, base: 'feat-a', head: 'feat-b' });
      const prMerged = makePR({ number: 1, base: 'main', head: 'feat-a', state: 'MERGED' });
      const prOpen = makePR({ number: 2, base: 'main', head: 'feat-a', state: 'OPEN' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 3) {
          return { repository: { pullRequest: prStart } };
        }
        // Walk UP: two PRs for feat-a, MERGED listed first
        if (vars.branch === 'feat-a' && query.includes('headRefName')) {
          return { repository: { pullRequests: { nodes: [prMerged, prOpen] } } };
        }
        // Walk DOWN
        if (vars.branch === 'feat-b' && query.includes('baseRefName')) {
          return { repository: { pullRequests: { nodes: [] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 3);

      // Should pick the OPEN PR (#2) over the MERGED one (#1)
      expect(stack[1]).toMatchObject({ prNumber: 2, state: 'OPEN', branch: 'feat-a' });
    });
  });

  describe('starting PR not found', () => {
    it('should throw a descriptive error', async () => {
      const client = createMockClient(() => {
        return { repository: { pullRequest: null } };
      });

      await expect(walkPRStack(client, 'owner', 'repo', 999))
        .rejects.toThrow('PR #999 not found in owner/repo');
    });
  });

  describe('GraphQL error mid-walk', () => {
    it('should return partial result when upward walk fails', async () => {
      // Stack: main <- feat-a (#1) <- feat-b (#2) <- feat-c (#3)
      // Error when trying to find parent of feat-a
      const prA = makePR({ number: 1, base: 'some-branch', head: 'feat-a' });
      const prB = makePR({ number: 2, base: 'feat-a', head: 'feat-b' });

      let callCount = 0;
      const client = createMockClient((query, vars) => {
        callCount++;
        if (vars.number === 2) {
          return { repository: { pullRequest: prB } };
        }
        // Walk UP: find PR whose head is feat-a
        if (vars.branch === 'feat-a' && query.includes('headRefName')) {
          return { repository: { pullRequests: { nodes: [prA] } } };
        }
        // Walk UP: error when querying for some-branch's parent
        if (vars.branch === 'some-branch' && query.includes('headRefName')) {
          throw new Error('GraphQL rate limit exceeded');
        }
        // Walk DOWN
        if (vars.branch === 'feat-b' && query.includes('baseRefName')) {
          return { repository: { pullRequests: { nodes: [] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 2);

      // Should return what we found before the error
      // trunk is some-branch (where the error stopped us)
      expect(stack[0]).toEqual({ branch: 'some-branch', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
      expect(stack[2]).toMatchObject({ branch: 'feat-b', prNumber: 2 });
    });

    it('should return partial result when downward walk fails', async () => {
      const prA = makePR({ number: 1, base: 'main', head: 'feat-a' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 1) {
          return { repository: { pullRequest: prA } };
        }
        // Walk DOWN: error
        if (vars.branch === 'feat-a' && query.includes('baseRefName')) {
          throw new Error('Network error');
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'owner', 'repo', 1);

      // Should have trunk + starting PR (no children discovered)
      expect(stack).toHaveLength(2);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
    });
  });

  describe('dependency injection', () => {
    it('should respect custom defaultBranches', async () => {
      // PR based on "develop" which is normally trunk, but we override
      const prA = makePR({ number: 1, base: 'develop', head: 'feat-a' });
      // A PR targeting develop
      const prDev = makePR({ number: 50, base: 'staging', head: 'develop' });

      const client = createMockClient((query, vars) => {
        if (vars.number === 1) {
          return { repository: { pullRequest: prA } };
        }
        // With custom trunk=['staging'], develop is NOT trunk, so we walk up
        if (vars.branch === 'develop' && query.includes('headRefName')) {
          return { repository: { pullRequests: { nodes: [prDev] } } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      // Only 'staging' is trunk
      const stack = await walkPRStack(client, 'owner', 'repo', 1, {
        defaultBranches: ['staging'],
      });

      expect(stack[0]).toEqual({ branch: 'staging', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'develop', prNumber: 50 });
      expect(stack[2]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
    });
  });

  describe('URL field passthrough', () => {
    it('should include url in returned entries', async () => {
      const prA = makePR({
        number: 7,
        base: 'main',
        head: 'feat-x',
        url: 'https://github.com/acme/widgets/pull/7',
      });

      const client = createMockClient((query, vars) => {
        if (vars.number === 7) {
          return { repository: { pullRequest: prA } };
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await walkPRStack(client, 'acme', 'widgets', 7);

      expect(stack[1].url).toBe('https://github.com/acme/widgets/pull/7');
    });
  });
});
