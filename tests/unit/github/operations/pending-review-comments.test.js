// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Dispatcher tests for the `pending_review_comments` area.
 *
 * Note: "rest" is *rejected* for this area at the dispatcher boundary —
 * see the plan Hazards section. GitHub REST cannot reliably attach
 * comments to a pending draft, so the only supported alt-host path is
 * the host extension (Phase 5).
 */

const operations = require('../../../../src/github/operations/pending-review-comments');

function makeOctokit(graphqlImpl) {
  return { graphql: vi.fn(graphqlImpl) };
}

describe('operations/pending-review-comments', () => {
  describe('addCommentsInBatches', () => {
    it('dispatches to the GraphQL impl when features.pending_review_comments is "graphql"', async () => {
      const octokit = makeOctokit(() => ({
        comment0: { thread: { id: 'thread-0' } }
      }));
      const result = await operations.addCommentsInBatches(
        octokit,
        { pending_review_comments: 'graphql' },
        'PR_xyz',
        'PRR_pending',
        [{ path: 'src/file.js', line: 1, side: 'RIGHT', body: 'comment' }]
      );
      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ successCount: 1, failed: false, failedDetails: [] });
    });

    it('returns an empty success result with no graphql calls when given zero comments', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      const result = await operations.addCommentsInBatches(
        octokit,
        { pending_review_comments: 'graphql' },
        'PR_xyz',
        'PRR_pending',
        []
      );
      expect(result).toEqual({ successCount: 0, failed: false, failedDetails: [] });
      expect(octokit.graphql).not.toHaveBeenCalled();
    });

    it('rejects "rest" with an explanatory error (no silent fallback)', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.addCommentsInBatches(
          octokit,
          { pending_review_comments: 'rest' },
          'PR_xyz',
          'PRR_pending',
          [{ path: 'src/file.js', line: 1, body: 'comment' }]
        )
      ).rejects.toThrow(
        /REST implementation for pending_review_comments is not supported/
      );
      expect(octokit.graphql).not.toHaveBeenCalled();
    });

    it('delegates to the host extension when features.pending_review_comments is "host"', async () => {
      // The host impl uses octokit.request (not octokit.graphql). The
      // dispatcher must wire prContext through so the host impl can
      // assemble the path-shaped endpoint URL.
      // The host endpoint is REST-shaped — the review id must be numeric
      // (the host extension rejects GraphQL node ids; see C2/C3 wiring).
      const requestMock = vi.fn(async () => ({ data: { added: 1, failed: [] } }));
      const octokit = { request: requestMock, graphql: vi.fn() };
      const result = await operations.addCommentsInBatches(
        octokit,
        { pending_review_comments: 'host' },
        'PR_xyz',
        42,
        [{ path: 'src/file.js', line: 1, side: 'RIGHT', body: 'comment' }],
        10,
        { owner: 'alice', repo: 'widgets', prNumber: 9, reviewId: 42 }
      );
      expect(requestMock).toHaveBeenCalledTimes(1);
      const [endpoint] = requestMock.mock.calls[0];
      expect(endpoint).toBe(
        'POST /repos/alice/widgets/pulls/9/reviews/42/comments'
      );
      expect(result).toEqual({ successCount: 1, failed: false, failedDetails: [] });
      expect(octokit.graphql).not.toHaveBeenCalled();
    });

    it('passes pending_review_comments_endpoint override through to the host impl', async () => {
      const requestMock = vi.fn(async () => ({ data: { added: 1, failed: [] } }));
      const octokit = { request: requestMock };
      await operations.addCommentsInBatches(
        octokit,
        {
          pending_review_comments: 'host',
          pending_review_comments_endpoint:
            '/api/v3/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/threads'
        },
        'PR_xyz',
        77,
        [{ path: 'src/file.js', line: 1, body: 'c' }],
        10,
        { owner: 'a', repo: 'b', prNumber: 2, reviewId: 77 }
      );
      const [endpoint] = requestMock.mock.calls[0];
      expect(endpoint).toBe('POST /api/v3/repos/a/b/pulls/2/reviews/77/threads');
    });

    it('throws for unknown feature values', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        operations.addCommentsInBatches(
          octokit,
          { pending_review_comments: 'weird' },
          'PR_xyz',
          'PRR_pending',
          [{ path: 'src/file.js', line: 1, body: 'comment' }]
        )
      ).rejects.toThrow(/Unknown features\.pending_review_comments value: "weird"/);
    });
  });
});
