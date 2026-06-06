// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the REST implementation of the pending-review-check
 * area. Each test stubs Octokit's REST methods and verifies the
 * normalised return shape matches what the GraphQL impl would return.
 */

const restImpl = require('../../../../../src/github/impl/rest/pending-review');

/**
 * Build a mock Octokit instance whose REST methods are controllable
 * via the `handlers` map. `octokit.paginate(method, args)` simulates
 * pagination by collecting all values; the mocked method returns a
 * single page.
 */
function makeOctokit(handlers = {}) {
  const octokit = {
    rest: {
      users: {
        getAuthenticated: vi.fn(handlers.getAuthenticated || (async () => ({ data: { id: 1, login: 'u' } })))
      },
      pulls: {
        listReviews: vi.fn(handlers.listReviews || (async () => ({ data: [] }))),
        listReviewComments: vi.fn(handlers.listReviewComments || (async () => ({ data: [] }))),
        listCommentsForReview: vi.fn(handlers.listCommentsForReview || (async () => ({ data: [] }))),
        getReview: vi.fn(handlers.getReview || (async () => ({ data: null })))
      }
    },
    paginate: vi.fn(async (method, opts) => {
      const { data } = await method(opts);
      return data || [];
    })
  };
  return octokit;
}

describe('impl/rest/pending-review', () => {
  describe('getPendingReviewForUser', () => {
    beforeEach(() => {
      // No global state to reset.
    });

    it('returns the pending review for the authenticated user with comment count', async () => {
      const octokit = makeOctokit({
        getAuthenticated: async () => ({ data: { id: 42, login: 'me' } }),
        listReviews: async () => ({
          data: [
            { id: 100, node_id: 'PRR_other', state: 'APPROVED', user: { id: 99 }, submitted_at: '2026-05-18T00:00:00Z', body: '', html_url: 'u' },
            { id: 101, node_id: 'PRR_pending', state: 'PENDING', user: { id: 42 }, submitted_at: null, body: 'draft', html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-101' }
          ]
        }),
        listCommentsForReview: async (args) => {
          // The new totalCount derivation calls
          // pulls.listCommentsForReview with the pending review id,
          // which already scopes the response to that review.
          expect(args.review_id).toBe(101);
          return { data: [
            { id: 1 },
            { id: 2 }
          ] };
        }
      });

      const result = await restImpl.getPendingReviewForUser(octokit, 'o', 'r', 1);
      expect(result).toEqual({
        id: 'PRR_pending',
        databaseId: 101,
        body: 'draft',
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-101',
        state: 'PENDING',
        createdAt: null,
        comments: { totalCount: 2 }
      });
      // Authenticated user must be queried.
      expect(octokit.rest.users.getAuthenticated).toHaveBeenCalled();
      // And the new endpoint must have been used (not the broad
      // listReviewComments + filter approach).
      expect(octokit.rest.pulls.listCommentsForReview).toHaveBeenCalled();
      expect(octokit.rest.pulls.listReviewComments).not.toHaveBeenCalled();
    });

    it('returns null when no pending review exists for the user', async () => {
      const octokit = makeOctokit({
        getAuthenticated: async () => ({ data: { id: 42 } }),
        listReviews: async () => ({ data: [
          { id: 1, node_id: 'PRR_a', state: 'APPROVED', user: { id: 42 } }
        ] })
      });
      const result = await restImpl.getPendingReviewForUser(octokit, 'o', 'r', 1);
      expect(result).toBeNull();
    });

    it('filters out pending reviews authored by other users', async () => {
      const octokit = makeOctokit({
        getAuthenticated: async () => ({ data: { id: 42 } }),
        listReviews: async () => ({ data: [
          { id: 1, node_id: 'PRR_x', state: 'PENDING', user: { id: 7 } }
        ] })
      });
      const result = await restImpl.getPendingReviewForUser(octokit, 'o', 'r', 1);
      expect(result).toBeNull();
    });

    it('caches the authenticated user lookup per Octokit instance', async () => {
      const octokit = makeOctokit({
        getAuthenticated: async () => ({ data: { id: 42 } }),
        listReviews: async () => ({ data: [] })
      });
      restImpl._resetAuthenticatedUserCache(octokit);
      await restImpl.getPendingReviewForUser(octokit, 'o', 'r', 1);
      await restImpl.getPendingReviewForUser(octokit, 'o', 'r', 2);
      expect(octokit.rest.users.getAuthenticated).toHaveBeenCalledTimes(1);
      // Cleanup so other tests see a fresh cache.
      restImpl._resetAuthenticatedUserCache(octokit);
    });

    it('translates 401 into GitHubApiError', async () => {
      const octokit = makeOctokit({
        getAuthenticated: async () => {
          const err = new Error('unauth');
          err.status = 401;
          throw err;
        }
      });
      await expect(restImpl.getPendingReviewForUser(octokit, 'o', 'r', 1))
        .rejects.toMatchObject({ status: 401 });
    });

    it('translates 404 into GitHubApiError', async () => {
      const octokit = makeOctokit({
        getAuthenticated: async () => ({ data: { id: 42 } }),
        listReviews: async () => {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
      });
      await expect(restImpl.getPendingReviewForUser(octokit, 'o', 'r', 9999))
        .rejects.toMatchObject({ status: 404 });
    });

    it('always returns createdAt: null for REST pending reviews, even if submitted_at has a value (Fix #6)', async () => {
      // Realistic alt-host fixture: REST's `pulls.listReviews` only ever
      // returns null for `submitted_at` on a PENDING review (by
      // definition). The mapper must NOT reuse `submitted_at` as a
      // proxy for createdAt — alt-hosts have been seen to backfill
      // submitted_at on the wire with a non-null value, and any code
      // that later compares this against a real GraphQL createdAt
      // would derive incorrect age. Hard-pin to null and document why.
      const octokit = makeOctokit({
        getAuthenticated: async () => ({ data: { id: 42 } }),
        listReviews: async () => ({ data: [
          {
            id: 555,
            node_id: 'PRR_w',
            state: 'PENDING',
            user: { id: 42 },
            body: 'draft',
            html_url: 'u',
            // Spec says null, but assert we still return null even when
            // a misbehaving host returns a value.
            submitted_at: '2026-05-19T00:00:00Z'
          }
        ] }),
        listCommentsForReview: async () => ({ data: [] })
      });
      const result = await restImpl.getPendingReviewForUser(octokit, 'o', 'r', 1);
      expect(result.createdAt).toBeNull();
    });

    it('falls back to stringified numeric id when node_id is missing from pending review (Fix #7)', async () => {
      const octokit = makeOctokit({
        getAuthenticated: async () => ({ data: { id: 42 } }),
        listReviews: async () => ({ data: [
          {
            id: 200,
            // No node_id (alt-host that does not surface it)
            state: 'PENDING',
            user: { id: 42 },
            body: '',
            html_url: 'u',
            submitted_at: null
          }
        ] }),
        listCommentsForReview: async () => ({ data: [] })
      });
      const result = await restImpl.getPendingReviewForUser(octokit, 'o', 'r', 1);
      expect(result.id).toBe('200');
      expect(result.databaseId).toBe(200);
    });

    it('does not throw when comment-counting fails; defaults totalCount to 0', async () => {
      const octokit = makeOctokit({
        getAuthenticated: async () => ({ data: { id: 42 } }),
        listReviews: async () => ({ data: [
          { id: 200, node_id: 'PRR_p', state: 'PENDING', user: { id: 42 }, body: '', html_url: 'u', submitted_at: null }
        ] }),
        listCommentsForReview: async () => { throw new Error('comments fetch failed'); }
      });
      const result = await restImpl.getPendingReviewForUser(octokit, 'o', 'r', 1);
      expect(result.comments).toEqual({ totalCount: 0 });
    });
  });

  describe('getReviewById', () => {
    it('throws when prContext is missing', async () => {
      const octokit = makeOctokit();
      await expect(restImpl.getReviewById(octokit, 123)).rejects.toThrow(/prContext=\{owner, repo, prNumber\}/);
    });

    it('uses prContext.reviewId when provided and returns the normalised shape', async () => {
      const octokit = makeOctokit({
        getReview: async (args) => ({
          data: {
            id: args.review_id,
            node_id: 'PRR_xyz',
            state: 'APPROVED',
            submitted_at: '2026-05-19T01:00:00Z',
            html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-77'
          }
        })
      });
      const result = await restImpl.getReviewById(
        octokit,
        'PRR_xyz',
        { owner: 'o', repo: 'r', prNumber: 1, reviewId: 77 }
      );
      expect(octokit.rest.pulls.getReview).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', pull_number: 1, review_id: 77
      });
      expect(result).toEqual({
        id: 'PRR_xyz',
        state: 'APPROVED',
        submittedAt: '2026-05-19T01:00:00Z',
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-77'
      });
    });

    it('falls back to a numeric nodeId argument when prContext.reviewId is missing', async () => {
      const octokit = makeOctokit({
        getReview: async (args) => ({
          data: { id: args.review_id, node_id: 'PRR_z', state: 'COMMENTED', submitted_at: null, html_url: 'u' }
        })
      });
      const result = await restImpl.getReviewById(
        octokit,
        '42',
        { owner: 'o', repo: 'r', prNumber: 1 }
      );
      expect(octokit.rest.pulls.getReview).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', pull_number: 1, review_id: 42
      });
      expect(result.id).toBe('PRR_z');
    });

    it('returns null when given a GraphQL node id with no resolvable numeric id', async () => {
      const octokit = makeOctokit();
      const result = await restImpl.getReviewById(
        octokit,
        'PRR_abc',
        { owner: 'o', repo: 'r', prNumber: 1 }
      );
      expect(result).toBeNull();
      expect(octokit.rest.pulls.getReview).not.toHaveBeenCalled();
    });

    it('returns null on a 404 from the REST endpoint', async () => {
      const octokit = makeOctokit({
        getReview: async () => {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
      });
      const result = await restImpl.getReviewById(
        octokit, 99, { owner: 'o', repo: 'r', prNumber: 1, reviewId: 99 }
      );
      expect(result).toBeNull();
    });
  });
});
