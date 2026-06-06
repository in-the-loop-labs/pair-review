// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the REST implementation of the stack-walker area.
 * Verifies the normalised PR shape, state-uppercase mapping (`open` ->
 * `OPEN`, merged_at -> `MERGED`), and the head/base filter ordering
 * matches the GraphQL impl's behaviour.
 */

const restImpl = require('../../../../../src/github/impl/rest/stack-walker');
const { _internals } = restImpl;

function restPR({ number, title, base, head, sha, state = 'open', merged_at = null }) {
  return {
    number,
    title: title || `PR #${number}`,
    base: { ref: base },
    head: { ref: head, sha: sha || `sha-${number}` },
    state,
    merged_at,
    html_url: `https://althost.example/o/r/pull/${number}`
  };
}

function makeOctokit({ getHandler, listHandler } = {}) {
  return {
    rest: {
      pulls: {
        get: vi.fn(getHandler || (async () => ({ data: null }))),
        list: vi.fn(listHandler || (async () => ({ data: [] })))
      }
    }
  };
}

describe('impl/rest/stack-walker', () => {
  describe('normalisePR', () => {
    it('uppercases lowercase open -> OPEN', () => {
      const pr = _internals.normalisePR(restPR({ number: 1, base: 'main', head: 'a' }));
      expect(pr.state).toBe('OPEN');
    });

    it('maps merged_at present -> MERGED regardless of state', () => {
      const pr = _internals.normalisePR(restPR({ number: 1, base: 'main', head: 'a', state: 'closed', merged_at: '2026-01-01T00:00:00Z' }));
      expect(pr.state).toBe('MERGED');
    });

    it('uppercases closed-without-merge -> CLOSED', () => {
      const pr = _internals.normalisePR(restPR({ number: 1, base: 'main', head: 'a', state: 'closed' }));
      expect(pr.state).toBe('CLOSED');
    });

    it('produces the GraphQL-shaped fields used by the walker', () => {
      const pr = _internals.normalisePR(restPR({ number: 5, title: 't', base: 'main', head: 'feat-x', sha: 'abc' }));
      expect(pr).toEqual({
        number: 5,
        title: 't',
        baseRefName: 'main',
        headRefName: 'feat-x',
        headRefOid: 'abc',
        state: 'OPEN',
        url: 'https://althost.example/o/r/pull/5'
      });
    });
  });

  describe('happy path: 3-PR stack', () => {
    it('walks up and down via REST', async () => {
      const prA = restPR({ number: 1, base: 'main', head: 'feat-a', state: 'closed', merged_at: '2026-01-01' });
      const prB = restPR({ number: 2, base: 'feat-a', head: 'feat-b' });
      const prC = restPR({ number: 3, base: 'feat-b', head: 'feat-c' });

      const octokit = makeOctokit({
        getHandler: async ({ pull_number }) => {
          if (pull_number === 2) return { data: prB };
          return { data: null };
        },
        listHandler: async ({ head, base }) => {
          if (head === 'o:feat-a') return { data: [prA] };
          if (base === 'feat-b') return { data: [prC] };
          return { data: [] };
        }
      });

      const stack = await restImpl.walkPRStack(octokit, 'o', 'r', 2);

      expect(stack).toHaveLength(4);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1, state: 'MERGED' });
      expect(stack[2]).toMatchObject({ branch: 'feat-b', prNumber: 2, state: 'OPEN' });
      expect(stack[3]).toMatchObject({ branch: 'feat-c', prNumber: 3, state: 'OPEN' });
    });
  });

  describe('findPRsByHead ordering and filtering', () => {
    it('passes the documented REST options for newest-first ordering and filters out plain CLOSED', async () => {
      const octokit = makeOctokit({
        listHandler: async (opts) => {
          expect(opts).toMatchObject({
            owner: 'o',
            repo: 'r',
            head: 'o:feat-a',
            state: 'all',
            sort: 'updated',
            direction: 'desc',
            per_page: 5
          });
          return {
            data: [
              restPR({ number: 10, base: 'main', head: 'feat-a', state: 'open' }),
              restPR({ number: 11, base: 'main', head: 'feat-a', state: 'closed' }), // dropped: CLOSED without merge
              restPR({ number: 12, base: 'main', head: 'feat-a', state: 'closed', merged_at: '2026-01-01' })
            ]
          };
        }
      });
      const found = await _internals.findPRsByHead(octokit, 'o', 'r', 'feat-a');
      expect(found.map(p => p.state)).toEqual(['OPEN', 'MERGED']);
    });
  });

  describe('findPRsByBase', () => {
    it('passes state=open and the documented sort', async () => {
      const octokit = makeOctokit({
        listHandler: async (opts) => {
          expect(opts).toMatchObject({
            base: 'feat-b',
            state: 'open',
            sort: 'updated',
            direction: 'desc',
            per_page: 5
          });
          return { data: [restPR({ number: 20, base: 'feat-b', head: 'feat-c' })] };
        }
      });
      const found = await _internals.findPRsByBase(octokit, 'o', 'r', 'feat-b');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ number: 20, headRefName: 'feat-c', state: 'OPEN' });
    });
  });

  describe('starting PR not found', () => {
    it('throws a descriptive error', async () => {
      const octokit = makeOctokit({
        getHandler: async () => {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
      });
      await expect(restImpl.walkPRStack(octokit, 'o', 'r', 999))
        .rejects.toThrow('PR #999 not found in o/r');
    });
  });

  describe('REST error mid-walk returns partial', () => {
    it('returns what was found before an upward-walk error', async () => {
      const prA = restPR({ number: 1, base: 'some-branch', head: 'feat-a' });
      const prB = restPR({ number: 2, base: 'feat-a', head: 'feat-b' });

      const octokit = makeOctokit({
        getHandler: async ({ pull_number }) => pull_number === 2 ? { data: prB } : { data: null },
        listHandler: async ({ head, base }) => {
          if (head === 'o:feat-a') return { data: [prA] };
          if (head === 'o:some-branch') throw new Error('rate limit');
          if (base === 'feat-b') return { data: [] };
          return { data: [] };
        }
      });

      const stack = await restImpl.walkPRStack(octokit, 'o', 'r', 2);
      expect(stack[0]).toEqual({ branch: 'some-branch', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
      expect(stack[2]).toMatchObject({ branch: 'feat-b', prNumber: 2 });
    });
  });

  describe('cycle detection', () => {
    it('stops a downward walk when a branch is re-visited', async () => {
      const prA = restPR({ number: 1, base: 'main', head: 'feat-a' });
      const prCyclic = restPR({ number: 99, base: 'feat-a', head: 'feat-a' });
      const octokit = makeOctokit({
        getHandler: async ({ pull_number }) => pull_number === 1 ? { data: prA } : { data: null },
        listHandler: async ({ base }) => {
          if (base === 'feat-a') return { data: [prCyclic] };
          return { data: [] };
        }
      });
      const stack = await restImpl.walkPRStack(octokit, 'o', 'r', 1);
      expect(stack).toHaveLength(2);
      expect(stack[0]).toEqual({ branch: 'main', isTrunk: true });
      expect(stack[1]).toMatchObject({ branch: 'feat-a', prNumber: 1 });
    });
  });

  describe('pickBestPR ordering', () => {
    it('prefers OPEN over MERGED when both are present', async () => {
      const merged = _internals.normalisePR(restPR({ number: 1, base: 'main', head: 'feat-a', state: 'closed', merged_at: '2026-01-01' }));
      const open = _internals.normalisePR(restPR({ number: 2, base: 'main', head: 'feat-a', state: 'open' }));
      const best = _internals.pickBestPR([merged, open]);
      expect(best.number).toBe(2);
      expect(best.state).toBe('OPEN');
    });

    it('returns the first candidate when no OPEN exists', async () => {
      const merged1 = _internals.normalisePR(restPR({ number: 1, base: 'main', head: 'feat-a', state: 'closed', merged_at: '2026-01-01' }));
      const merged2 = _internals.normalisePR(restPR({ number: 2, base: 'main', head: 'feat-a', state: 'closed', merged_at: '2026-02-01' }));
      const best = _internals.pickBestPR([merged1, merged2]);
      expect(best.number).toBe(1);
    });
  });
});
