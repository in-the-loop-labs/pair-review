// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Dispatcher tests for the `pending_review_check` area.
 * Covers graphql (default) dispatch shape, REST delegation,
 * and "host" not-yet-available.
 */

const operations = require('../../../../src/github/operations/pending-review');
const restImpl = require('../../../../src/github/impl/rest/pending-review');

function makeOctokit(graphqlImpl) {
  return { graphql: vi.fn(graphqlImpl) };
}

describe('operations/pending-review', () => {
  describe('getPendingReviewForUser', () => {
    it('dispatches to GraphQL when features.pending_review_check is "graphql"', async () => {
      const octokit = makeOctokit(() => ({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [{
                id: 'PRR_abc',
                databaseId: 1234,
                body: 'pending body',
                url: 'https://althost.example/o/r/pull/1#pullrequestreview-1234',
                state: 'PENDING',
                createdAt: '2026-05-19T00:00:00Z',
                viewerDidAuthor: true,
                comments: { totalCount: 2 }
              }]
            }
          }
        }
      }));

      const result = await operations.getPendingReviewForUser(
        octokit,
        { pending_review_check: 'graphql' },
        'owner',
        'repo',
        7
      );

      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        id: 'PRR_abc',
        databaseId: 1234,
        body: 'pending body',
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-1234',
        state: 'PENDING',
        createdAt: '2026-05-19T00:00:00Z',
        comments: { totalCount: 2 }
      });
    });

    it('defaults to graphql dispatch when features is missing', async () => {
      const octokit = makeOctokit(() => ({ repository: { pullRequest: { reviews: { nodes: [] } } } }));
      const result = await operations.getPendingReviewForUser(octokit, undefined, 'o', 'r', 1);
      expect(result).toBeNull();
      expect(octokit.graphql).toHaveBeenCalledTimes(1);
    });

    it('delegates to REST impl when features.pending_review_check is "rest"', async () => {
      const restSpy = vi.spyOn(restImpl, 'getPendingReviewForUser').mockResolvedValue({
        id: 'PRR_abc',
        databaseId: 1234,
        body: 'b',
        url: 'https://althost.example/o/r/pull/1',
        state: 'PENDING',
        createdAt: null,
        comments: { totalCount: 0 }
      });
      try {
        const octokit = makeOctokit(() => { throw new Error('GraphQL should not be called in rest mode'); });
        const result = await operations.getPendingReviewForUser(
          octokit,
          { pending_review_check: 'rest' },
          'o', 'r', 1
        );
        expect(restSpy).toHaveBeenCalledWith(octokit, 'o', 'r', 1);
        expect(result.id).toBe('PRR_abc');
        expect(octokit.graphql).not.toHaveBeenCalled();
      } finally {
        restSpy.mockRestore();
      }
    });

    it('throws not-yet-available when features.pending_review_check is "host"', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.getPendingReviewForUser(
          octokit,
          { pending_review_check: 'host' },
          'o', 'r', 1
        )
      ).rejects.toThrow(/Host implementation for pending_review_check not yet available \(Phase 5\)/);
      expect(octokit.graphql).not.toHaveBeenCalled();
    });

    it('throws for unknown feature values', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.getPendingReviewForUser(
          octokit,
          { pending_review_check: 'bogus' },
          'o', 'r', 1
        )
      ).rejects.toThrow(/Unknown features\.pending_review_check value: "bogus"/);
    });
  });

  describe('getReviewById', () => {
    it('dispatches to GraphQL when features.pending_review_check is "graphql"', async () => {
      const octokit = makeOctokit(() => ({
        node: {
          id: 'PRR_def',
          state: 'APPROVED',
          submittedAt: '2026-05-19T01:00:00Z',
          url: 'https://althost.example/o/r/pull/1#pullrequestreview-9999'
        }
      }));

      const result = await operations.getReviewById(
        octokit,
        { pending_review_check: 'graphql' },
        'PRR_def'
      );

      expect(result).toEqual({
        id: 'PRR_def',
        state: 'APPROVED',
        submittedAt: '2026-05-19T01:00:00Z',
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-9999'
      });
    });

    it('delegates to REST impl when features.pending_review_check is "rest" and forwards prContext', async () => {
      const restSpy = vi.spyOn(restImpl, 'getReviewById').mockResolvedValue({
        id: 'PRR_def',
        state: 'APPROVED',
        submittedAt: '2026-05-19T01:00:00Z',
        url: 'https://althost.example/o/r/pull/1#pullrequestreview-9999'
      });
      try {
        const octokit = makeOctokit(() => { throw new Error('GraphQL should not be called in rest mode'); });
        const prContext = { owner: 'o', repo: 'r', prNumber: 1, reviewId: 9999 };
        const result = await operations.getReviewById(
          octokit,
          { pending_review_check: 'rest' },
          'PRR_def',
          prContext
        );
        expect(restSpy).toHaveBeenCalledWith(octokit, 'PRR_def', prContext);
        expect(result.state).toBe('APPROVED');
      } finally {
        restSpy.mockRestore();
      }
    });

    it('rejects "host" with the not-yet-available error', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.getReviewById(octokit, { pending_review_check: 'host' }, 'PRR_x')
      ).rejects.toThrow(/Host implementation for pending_review_check not yet available \(Phase 5\)/);
    });
  });
});
