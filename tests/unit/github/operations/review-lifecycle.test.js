// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Dispatcher tests for the `review_lifecycle` area.
 * Covers GraphQL dispatch shape, REST delegation, and "host" not-yet-available.
 */

const operations = require('../../../../src/github/operations/review-lifecycle');
const restImpl = require('../../../../src/github/impl/rest/review-lifecycle');

function makeOctokit(graphqlImpl) {
  return { graphql: vi.fn(graphqlImpl) };
}

const PR_CTX = { owner: 'o', repo: 'r', prNumber: 1 };

describe('operations/review-lifecycle', () => {
  describe('addPullRequestReview (no body)', () => {
    it('dispatches to GraphQL when features.review_lifecycle is "graphql"', async () => {
      const octokit = makeOctokit(() => ({
        addPullRequestReview: { pullRequestReview: { id: 'PRR_new', databaseId: 555 } }
      }));
      const result = await operations.addPullRequestReview(
        octokit,
        { review_lifecycle: 'graphql' },
        'PR_xyz'
      );
      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'PRR_new', databaseId: 555 });
    });

    it('delegates to REST impl in rest mode and forwards prContext', async () => {
      const restSpy = vi.spyOn(restImpl, 'addPullRequestReview').mockResolvedValue({ id: 'PRR_new', databaseId: 555 });
      try {
        const octokit = makeOctokit(() => { throw new Error('should not be called'); });
        const result = await operations.addPullRequestReview(
          octokit,
          { review_lifecycle: 'rest' },
          'PR_xyz',
          PR_CTX
        );
        expect(restSpy).toHaveBeenCalledWith(octokit, 'PR_xyz', PR_CTX);
        expect(result).toEqual({ id: 'PRR_new', databaseId: 555 });
      } finally {
        restSpy.mockRestore();
      }
    });

    it('rejects "host" with the not-yet-available error', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.addPullRequestReview(octokit, { review_lifecycle: 'host' }, 'PR_xyz')
      ).rejects.toThrow(/Host implementation for review_lifecycle not yet available \(Phase 5\)/);
    });
  });

  describe('addPullRequestReviewWithBody', () => {
    it('dispatches to GraphQL and returns id/databaseId/url', async () => {
      const octokit = makeOctokit(() => ({
        addPullRequestReview: {
          pullRequestReview: {
            id: 'PRR_new',
            databaseId: 42,
            url: 'https://althost.example/o/r/pull/1#pullrequestreview-42'
          }
        }
      }));
      const result = await operations.addPullRequestReviewWithBody(
        octokit,
        { review_lifecycle: 'graphql' },
        'PR_xyz',
        'summary'
      );
      expect(result).toEqual({
        id: 'PRR_new',
        databaseId: 42,
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-42'
      });
    });

    it('delegates to REST impl in rest mode and forwards body + prContext', async () => {
      const restSpy = vi.spyOn(restImpl, 'addPullRequestReviewWithBody').mockResolvedValue({
        id: 'PRR_new',
        databaseId: 42,
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-42'
      });
      try {
        const octokit = makeOctokit(() => { throw new Error('should not be called'); });
        const result = await operations.addPullRequestReviewWithBody(
          octokit,
          { review_lifecycle: 'rest' },
          'PR_xyz',
          'summary',
          PR_CTX
        );
        expect(restSpy).toHaveBeenCalledWith(octokit, 'PR_xyz', 'summary', PR_CTX);
        expect(result.databaseId).toBe(42);
      } finally {
        restSpy.mockRestore();
      }
    });

    it('rejects "host" with the not-yet-available error', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.addPullRequestReviewWithBody(octokit, { review_lifecycle: 'host' }, 'PR_xyz', 'body')
      ).rejects.toThrow(/Host implementation for review_lifecycle not yet available \(Phase 5\)/);
    });
  });

  describe('submitPullRequestReview', () => {
    it('dispatches to GraphQL when features.review_lifecycle is "graphql"', async () => {
      const octokit = makeOctokit(() => ({
        submitPullRequestReview: {
          pullRequestReview: {
            id: 'PRR_done',
            databaseId: 99,
            url: 'https://althost.example/o/r/pull/1#pullrequestreview-99',
            state: 'COMMENTED'
          }
        }
      }));
      const result = await operations.submitPullRequestReview(
        octokit,
        { review_lifecycle: 'graphql' },
        'PRR_done',
        'COMMENT',
        'body'
      );
      expect(result).toEqual({
        id: 'PRR_done',
        databaseId: 99,
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-99',
        state: 'COMMENTED'
      });
    });

    it('delegates to REST impl in rest mode and forwards prContext', async () => {
      const restSpy = vi.spyOn(restImpl, 'submitPullRequestReview').mockResolvedValue({
        id: 'PRR_done',
        databaseId: 99,
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-99',
        state: 'COMMENTED'
      });
      try {
        const octokit = makeOctokit(() => { throw new Error('should not be called'); });
        const ctx = { ...PR_CTX, reviewId: 99 };
        const result = await operations.submitPullRequestReview(
          octokit,
          { review_lifecycle: 'rest' },
          'PRR_done',
          'COMMENT',
          'body',
          ctx
        );
        expect(restSpy).toHaveBeenCalledWith(octokit, 'PRR_done', 'COMMENT', 'body', ctx);
        expect(result.state).toBe('COMMENTED');
      } finally {
        restSpy.mockRestore();
      }
    });

    it('rejects "host" with the not-yet-available error', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.submitPullRequestReview(octokit, { review_lifecycle: 'host' }, 'PRR_x', 'COMMENT', 'body')
      ).rejects.toThrow(/Host implementation for review_lifecycle not yet available \(Phase 5\)/);
    });
  });

  describe('deletePullRequestReview', () => {
    it('dispatches to GraphQL and returns true on success', async () => {
      const octokit = makeOctokit(() => ({
        deletePullRequestReview: { pullRequestReview: { id: 'PRR_gone' } }
      }));
      const result = await operations.deletePullRequestReview(
        octokit,
        { review_lifecycle: 'graphql' },
        'PRR_gone'
      );
      expect(result).toBe(true);
    });

    it('returns false when the GraphQL call throws', async () => {
      const octokit = makeOctokit(() => { throw new Error('boom'); });
      const result = await operations.deletePullRequestReview(
        octokit,
        { review_lifecycle: 'graphql' },
        'PRR_gone'
      );
      expect(result).toBe(false);
    });

    it('delegates to REST impl in rest mode and forwards prContext', async () => {
      const restSpy = vi.spyOn(restImpl, 'deletePullRequestReview').mockResolvedValue(true);
      try {
        const octokit = makeOctokit(() => { throw new Error('should not be called'); });
        const ctx = { ...PR_CTX, reviewId: 99 };
        const result = await operations.deletePullRequestReview(
          octokit,
          { review_lifecycle: 'rest' },
          'PRR_gone',
          ctx
        );
        expect(restSpy).toHaveBeenCalledWith(octokit, 'PRR_gone', ctx);
        expect(result).toBe(true);
      } finally {
        restSpy.mockRestore();
      }
    });

    it('rejects "host" with the not-yet-available error', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.deletePullRequestReview(octokit, { review_lifecycle: 'host' }, 'PRR_x')
      ).rejects.toThrow(/Host implementation for review_lifecycle not yet available \(Phase 5\)/);
    });
  });
});
