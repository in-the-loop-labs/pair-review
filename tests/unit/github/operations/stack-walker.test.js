// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Dispatcher tests for the `stack_walker` area.
 * Covers:
 *   - new-signature dispatch (octokit, features, ...) -> graphql impl
 *   - legacy-signature dispatch (client, ...) -> graphql impl
 *   - "rest" delegation
 *   - "host" not-yet-available
 */

const operations = require('../../../../src/github/operations/stack-walker');
const restImpl = require('../../../../src/github/impl/rest/stack-walker');

function makeOctokit(graphqlImpl) {
  return { graphql: vi.fn(graphqlImpl) };
}

function makeStartResponse(pr) {
  return { repository: { pullRequest: pr } };
}

function makePR({ number, title, base, head, state = 'OPEN' }) {
  return {
    number,
    title: title || `PR #${number}`,
    baseRefName: base,
    headRefName: head,
    state,
    url: `https://althost.example/o/r/pull/${number}`,
    headRefOid: `sha-${number}`
  };
}

describe('operations/stack-walker', () => {
  describe('dispatch: graphql (default)', () => {
    it('routes through the GraphQL impl when called with new (octokit, features, ...) signature', async () => {
      const startPR = makePR({ number: 1, base: 'main', head: 'feat-a' });
      const octokit = makeOctokit((query, vars) => {
        if (vars.number === 1) {
          return makeStartResponse(startPR);
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const stack = await operations.walkPRStack(
        octokit,
        { stack_walker: 'graphql' },
        'o',
        'r',
        1
      );
      expect(stack).toHaveLength(2);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
    });

    it('routes through the GraphQL impl when called with legacy (client, ...) signature', async () => {
      const startPR = makePR({ number: 2, base: 'main', head: 'feat-b' });
      const octokit = makeOctokit((query, vars) => {
        if (vars.number === 2) {
          return makeStartResponse(startPR);
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });

      const client = { octokit };
      const stack = await operations.walkPRStack(client, 'o', 'r', 2);
      expect(stack).toHaveLength(2);
      expect(stack[1]).toMatchObject({ prNumber: 2, branch: 'feat-b' });
    });

    it('defaults to graphql dispatch when features is missing', async () => {
      const startPR = makePR({ number: 3, base: 'main', head: 'feat-c' });
      const octokit = makeOctokit((query, vars) => {
        if (vars.number === 3) {
          return makeStartResponse(startPR);
        }
        return { repository: { pullRequests: { nodes: [] } } };
      });
      const stack = await operations.walkPRStack(octokit, undefined, 'o', 'r', 3);
      expect(stack[1].prNumber).toBe(3);
    });
  });

  describe('dispatch: rest', () => {
    it('delegates to REST impl when features.stack_walker is "rest"', async () => {
      const fakeStack = [
        { branch: 'main', isTrunk: true },
        { branch: 'feat-x', isTrunk: false, prNumber: 7, state: 'OPEN', headSha: 'sha-7', title: 'PR #7', url: 'u' }
      ];
      const restSpy = vi.spyOn(restImpl, 'walkPRStack').mockResolvedValue(fakeStack);
      try {
        const octokit = makeOctokit(() => { throw new Error('GraphQL should not be called in rest mode'); });
        const stack = await operations.walkPRStack(
          octokit,
          { stack_walker: 'rest' },
          'o', 'r', 7
        );
        expect(restSpy).toHaveBeenCalledWith(octokit, 'o', 'r', 7, undefined);
        expect(stack).toBe(fakeStack);
        expect(octokit.graphql).not.toHaveBeenCalled();
      } finally {
        restSpy.mockRestore();
      }
    });

    it('routes rest mode through the legacy client.binding shape', async () => {
      const restSpy = vi.spyOn(restImpl, 'walkPRStack').mockResolvedValue([]);
      try {
        const octokit = makeOctokit(() => { throw new Error('should not be called'); });
        const client = { octokit, binding: { features: { stack_walker: 'rest' } } };
        await operations.walkPRStack(client, 'o', 'r', 1);
        expect(restSpy).toHaveBeenCalledWith(octokit, 'o', 'r', 1, undefined);
      } finally {
        restSpy.mockRestore();
      }
    });
  });

  describe('dispatch: host', () => {
    it('throws the Phase-5 not-yet-available error when features.stack_walker is "host"', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.walkPRStack(octokit, { stack_walker: 'host' }, 'o', 'r', 1)
      ).rejects.toThrow(/Host implementation for stack_walker not yet available \(Phase 5\)/);
    });
  });

  describe('unknown feature value', () => {
    it('throws a clear error', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.walkPRStack(octokit, { stack_walker: 'nonsense' }, 'o', 'r', 1)
      ).rejects.toThrow(/Unknown features\.stack_walker value: "nonsense"/);
    });
  });
});
