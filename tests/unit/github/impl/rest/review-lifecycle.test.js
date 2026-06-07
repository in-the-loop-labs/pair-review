// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the REST implementation of the review-lifecycle area.
 * Each test stubs Octokit's REST methods and verifies that the
 * normalised return shape matches the GraphQL implementation.
 */

const restImpl = require('../../../../../src/github/impl/rest/review-lifecycle');

function makeOctokit(handlers = {}) {
  return {
    rest: {
      pulls: {
        createReview: vi.fn(handlers.createReview || (async () => ({ data: null }))),
        submitReview: vi.fn(handlers.submitReview || (async () => ({ data: null }))),
        deletePendingReview: vi.fn(handlers.deletePendingReview || (async () => ({ data: null })))
      }
    }
  };
}

const PR_CTX = { owner: 'o', repo: 'r', prNumber: 1 };

describe('impl/rest/review-lifecycle', () => {
  describe('addPullRequestReview (no body)', () => {
    it('throws when prContext is missing', async () => {
      const octokit = makeOctokit();
      await expect(restImpl.addPullRequestReview(octokit, 'PR_xyz')).rejects.toThrow(/prContext=\{owner, repo, prNumber\}/);
    });

    it('calls createReview without an event and returns { id, databaseId }', async () => {
      const octokit = makeOctokit({
        createReview: async (args) => {
          expect(args).toEqual({ owner: 'o', repo: 'r', pull_number: 1, body: '' });
          // No `event` -> the review stays PENDING.
          expect(args.event).toBeUndefined();
          return { data: { id: 555, node_id: 'PRR_new', html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-555', state: 'PENDING' } };
        }
      });
      const result = await restImpl.addPullRequestReview(octokit, 'PR_xyz', PR_CTX);
      expect(result).toEqual({ id: 'PRR_new', databaseId: 555 });
    });

    it('sends an explicit empty body so strict alt-hosts do not reject an empty request body (regression)', async () => {
      // Regression guard: without an explicit `body`, Octokit serializes a
      // POST with an empty HTTP body. github.com tolerates this, but strict
      // GitHub-compatible alt-hosts reject it with HTTP 400
      // `{ message: "request body is empty" }`. The body MUST be present.
      let captured;
      const octokit = makeOctokit({
        createReview: async (args) => {
          captured = args;
          return { data: { id: 1, node_id: 'PRR_b', html_url: 'u', state: 'PENDING' } };
        }
      });
      await restImpl.addPullRequestReview(octokit, 'PR_xyz', PR_CTX);
      expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(captured).toHaveProperty('body');
      expect(captured.body).toBe('');
      // The serialized HTTP body must be non-empty.
      expect(JSON.stringify(captured)).not.toBe('{}');
    });

    it('returns databaseId: null when REST response omits the numeric id', async () => {
      const octokit = makeOctokit({
        createReview: async () => ({ data: { node_id: 'PRR_only_node' } })
      });
      const result = await restImpl.addPullRequestReview(octokit, 'PR_xyz', PR_CTX);
      expect(result).toEqual({ id: 'PRR_only_node', databaseId: null });
    });

    it('falls back to stringified numeric id when node_id is absent (Fix #7)', async () => {
      // Alt-hosts that do not surface node_id consistently still
      // provide the numeric `id`. The mapper must derive an id from
      // it so downstream lookups (review-by-id, comment append) can
      // still identify the review.
      const octokit = makeOctokit({
        createReview: async () => ({ data: { id: 314 } })
      });
      const result = await restImpl.addPullRequestReview(octokit, 'PR_xyz', PR_CTX);
      expect(result).toEqual({ id: '314', databaseId: 314 });
    });

    it('returns id: null only when neither node_id nor numeric id is present', async () => {
      const octokit = makeOctokit({
        createReview: async () => ({ data: { state: 'PENDING' } })
      });
      const result = await restImpl.addPullRequestReview(octokit, 'PR_xyz', PR_CTX);
      expect(result).toEqual({ id: null, databaseId: null });
    });
  });

  describe('addPullRequestReviewWithBody', () => {
    it('returns { id, databaseId, url } matching the GraphQL shape', async () => {
      const octokit = makeOctokit({
        createReview: async (args) => {
          expect(args).toMatchObject({ owner: 'o', repo: 'r', pull_number: 1, body: 'summary' });
          return { data: { id: 42, node_id: 'PRR_new', html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-42', state: 'PENDING' } };
        }
      });
      const result = await restImpl.addPullRequestReviewWithBody(octokit, 'PR_xyz', 'summary', PR_CTX);
      expect(result).toEqual({
        id: 'PRR_new',
        databaseId: 42,
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-42'
      });
    });

    it('coerces a null body to empty string', async () => {
      const octokit = makeOctokit({
        createReview: async (args) => {
          expect(args.body).toBe('');
          return { data: { id: 1, node_id: 'PRR_a', html_url: 'u', state: 'PENDING' } };
        }
      });
      await restImpl.addPullRequestReviewWithBody(octokit, 'PR_xyz', null, PR_CTX);
    });

    it('throws when prContext is missing', async () => {
      const octokit = makeOctokit();
      await expect(restImpl.addPullRequestReviewWithBody(octokit, 'PR_xyz', 'b')).rejects.toThrow(/prContext=\{owner, repo, prNumber\}/);
    });
  });

  describe('submitPullRequestReview', () => {
    it('throws when prContext is missing', async () => {
      const octokit = makeOctokit();
      await expect(restImpl.submitPullRequestReview(octokit, 99, 'APPROVE', 'b')).rejects.toThrow(/prContext=\{owner, repo, prNumber\}/);
    });

    it('throws when no numeric review id can be resolved', async () => {
      const octokit = makeOctokit();
      await expect(
        restImpl.submitPullRequestReview(octokit, 'PRR_xyz', 'APPROVE', 'b', PR_CTX)
      ).rejects.toThrow(/needs a numeric review id/);
    });

    it('calls submitReview with event/body and returns the normalised shape', async () => {
      const octokit = makeOctokit({
        submitReview: async (args) => {
          expect(args).toMatchObject({ owner: 'o', repo: 'r', pull_number: 1, review_id: 77, event: 'APPROVE', body: 'lgtm' });
          return { data: { id: 77, node_id: 'PRR_done', html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-77', state: 'APPROVED' } };
        }
      });
      const result = await restImpl.submitPullRequestReview(
        octokit, 'PRR_done', 'APPROVE', 'lgtm', { ...PR_CTX, reviewId: 77 }
      );
      expect(result).toEqual({
        id: 'PRR_done',
        databaseId: 77,
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-77',
        state: 'APPROVED'
      });
    });

    it('accepts a numeric reviewId argument when prContext.reviewId is absent', async () => {
      const octokit = makeOctokit({
        submitReview: async (args) => {
          expect(args.review_id).toBe(88);
          return { data: { id: 88, node_id: 'PRR_x', html_url: 'u', state: 'COMMENTED' } };
        }
      });
      await restImpl.submitPullRequestReview(octokit, 88, 'COMMENT', 'b', PR_CTX);
    });

    it('falls back to stringified numeric id when node_id missing on submit response (Fix #7)', async () => {
      const octokit = makeOctokit({
        submitReview: async () => ({
          data: { id: 88, html_url: 'u', state: 'APPROVED' }
        })
      });
      const result = await restImpl.submitPullRequestReview(
        octokit, 88, 'APPROVE', 'lgtm', { ...PR_CTX, reviewId: 88 }
      );
      expect(result.id).toBe('88');
      expect(result.databaseId).toBe(88);
    });
  });

  describe('deletePullRequestReview', () => {
    it('returns true on success', async () => {
      const octokit = makeOctokit({
        deletePendingReview: async (args) => {
          expect(args).toMatchObject({ owner: 'o', repo: 'r', pull_number: 1, review_id: 99 });
          return { data: {} };
        }
      });
      const result = await restImpl.deletePullRequestReview(octokit, 99, { ...PR_CTX, reviewId: 99 });
      expect(result).toBe(true);
    });

    it('returns false on REST error rather than throwing', async () => {
      const octokit = makeOctokit({
        deletePendingReview: async () => { throw new Error('boom'); }
      });
      const result = await restImpl.deletePullRequestReview(octokit, 99, { ...PR_CTX, reviewId: 99 });
      expect(result).toBe(false);
    });

    it('returns false when called without a numeric review id', async () => {
      const octokit = makeOctokit();
      const result = await restImpl.deletePullRequestReview(octokit, 'PRR_abc', PR_CTX);
      expect(result).toBe(false);
      expect(octokit.rest.pulls.deletePendingReview).not.toHaveBeenCalled();
    });

    it('returns false when prContext is missing (matches GraphQL impl which swallows errors)', async () => {
      const octokit = makeOctokit();
      const result = await restImpl.deletePullRequestReview(octokit, 99);
      expect(result).toBe(false);
    });
  });

  describe('_internals.resolveNumericReviewId', () => {
    it('prefers prContext.reviewId over the reviewId argument', () => {
      const id = restImpl._internals.resolveNumericReviewId('999', { reviewId: 7 });
      expect(id).toBe(7);
    });

    it('returns null when neither source is numeric', () => {
      const id = restImpl._internals.resolveNumericReviewId('PRR_xyz', {});
      expect(id).toBeNull();
    });

    it('coerces a numeric-string reviewId argument', () => {
      const id = restImpl._internals.resolveNumericReviewId('42', {});
      expect(id).toBe(42);
    });
  });
});
