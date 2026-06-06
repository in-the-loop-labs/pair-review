// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Numeric review id propagation tests (integration findings C2/C3/L1/L2/L4).
 *
 * These tests exercise the orchestration in `src/github/client.js`'s
 * `createReviewGraphQL` / `createDraftReviewGraphQL` when one or more
 * areas dispatch through REST or the host extension (i.e. the alt-host
 * case). The key invariant: a brand-new draft must propagate
 * `databaseId` (the numeric REST review id) from `addPullRequestReview`
 * through `addCommentsInBatches`, `submitPullRequestReview`, and
 * `deletePullRequestReview` so the REST/host paths can address the
 * review without throwing.
 *
 * Tests stub `client.octokit` wholesale rather than relying on the
 * real Octokit network stack, so they exercise pure orchestration
 * behaviour without making real HTTP calls.
 */

const { GitHubClient, DEFAULT_FEATURES } = require('../../../src/github/client');
const { GRAPHQL_DEFAULT_AREAS, FEATURE_AREAS } = require('../../../src/config');
const hostImpl = require('../../../src/github/impl/host/pending-review-comments');
const restPending = require('../../../src/github/impl/rest/pending-review');
const restLifecycle = require('../../../src/github/impl/rest/review-lifecycle');

/**
 * Build an alt-host binding whose feature flags dispatch the review
 * lifecycle through the REST impl. `pending_review_comments` is left as
 * graphql by default; individual tests override as needed.
 */
function altHostBinding(features = {}) {
  return {
    token: 'tok',
    apiHost: 'https://althost.example/api/v3',
    features: {
      pending_review_check: 'rest',
      stack_walker: 'rest',
      review_lifecycle: 'rest',
      pending_review_comments: 'graphql',
      ...features
    }
  };
}

/**
 * Replace the client's Octokit with a small stub exposing only the
 * methods our orchestration touches. The real Octokit's `.request` has
 * a `.defaults` method; some Octokit internals invoke it. We don't
 * exercise those code paths, so a bare function is sufficient.
 */
function stubOctokit(client, methods) {
  client.octokit = {
    rest: {
      pulls: {
        createReview: methods.createReview || (async () => ({ data: null })),
        submitReview: methods.submitReview || (async () => ({ data: null })),
        deletePendingReview: methods.deletePendingReview || (async () => ({ data: null })),
        getReview: methods.getReview || (async () => ({ data: null })),
        listReviews: methods.listReviews || (async () => ({ data: [] })),
        listReviewComments: methods.listReviewComments || (async () => ({ data: [] })),
        listCommentsForReview: methods.listCommentsForReview || (async () => ({ data: [] }))
      },
      users: {
        getAuthenticated: methods.getAuthenticated || (async () => ({ data: { id: 42 } }))
      }
    },
    graphql: methods.graphql || vi.fn(async () => ({})),
    request: methods.request || vi.fn(async () => ({ data: {} })),
    paginate: methods.paginate || (async (method, opts) => {
      const { data } = await method(opts);
      return data || [];
    })
  };
}

describe('numeric review id propagation', () => {
  describe('C2: REST addPullRequestReview returns databaseId', () => {
    it('returns { id, databaseId } from the REST impl with the numeric id', async () => {
      const octokit = {
        rest: {
          pulls: {
            createReview: vi.fn(async () => ({
              data: { id: 12345, node_id: 'PRR_new', html_url: 'u', state: 'PENDING' }
            }))
          }
        }
      };
      const result = await restLifecycle.addPullRequestReview(
        octokit, 'PR_xyz', { owner: 'o', repo: 'r', prNumber: 1 }
      );
      expect(result).toEqual({ id: 'PRR_new', databaseId: 12345 });
    });

    it('returns null databaseId only when the response omits the numeric id', async () => {
      const octokit = {
        rest: {
          pulls: {
            createReview: vi.fn(async () => ({
              data: { node_id: 'PRR_new', html_url: 'u', state: 'PENDING' }
            }))
          }
        }
      };
      const result = await restLifecycle.addPullRequestReview(
        octokit, 'PR_xyz', { owner: 'o', repo: 'r', prNumber: 1 }
      );
      expect(result.databaseId).toBeNull();
    });
  });

  describe('C3: createReviewGraphQL propagates databaseId from a new draft', () => {
    it('propagates numeric databaseId to addCommentsInBatches and submitPullRequestReview when there is no existing draft', async () => {
      const client = new GitHubClient(altHostBinding({
        pending_review_comments: 'graphql'
      }));

      const createReviewMock = vi.fn(async () => ({
        data: { id: 12345, node_id: 'PRR_new', html_url: 'u', state: 'PENDING' }
      }));
      const submitReviewMock = vi.fn(async (args) => ({
        data: { id: args.review_id, node_id: 'PRR_done', html_url: 'u', state: 'COMMENTED' }
      }));
      // GraphQL is still used for adding comments to the pending review
      // (review_lifecycle is REST; pending_review_comments stays graphql).
      const graphqlMock = vi.fn(async () => ({
        comment0: { thread: { id: 'th0' } }
      }));
      stubOctokit(client, {
        createReview: createReviewMock,
        submitReview: submitReviewMock,
        graphql: graphqlMock
      });

      const result = await client.createReviewGraphQL(
        'PR_xyz',
        'COMMENT',
        'body',
        [{ path: 'a.js', line: 1, body: 'hi' }],
        null,
        { owner: 'o', repo: 'r', prNumber: 1 }
      );

      // addPullRequestReview (REST) was called with PR coordinates.
      expect(createReviewMock).toHaveBeenCalledTimes(1);
      expect(createReviewMock.mock.calls[0][0]).toMatchObject({
        owner: 'o', repo: 'r', pull_number: 1
      });

      // submitPullRequestReview (REST) MUST be called with the numeric
      // review id (12345), not the GraphQL node id ("PRR_new").
      expect(submitReviewMock).toHaveBeenCalledTimes(1);
      expect(submitReviewMock.mock.calls[0][0]).toMatchObject({
        owner: 'o', repo: 'r', pull_number: 1, review_id: 12345,
        event: 'COMMENT'
      });

      expect(result).toMatchObject({
        id: 'PRR_done',
        databaseId: 12345,
        state: 'COMMENTED'
      });
    });

    it('propagates numeric databaseId on cleanup when comment batching fails', async () => {
      const client = new GitHubClient(altHostBinding({
        pending_review_comments: 'graphql'
      }));

      const createReviewMock = vi.fn(async () => ({
        data: { id: 9999, node_id: 'PRR_doomed', html_url: 'u', state: 'PENDING' }
      }));
      const deleteReviewMock = vi.fn(async () => ({ data: {} }));
      // GraphQL comment batch fails so we exercise the cleanup path.
      const graphqlMock = vi.fn(async () => { throw new Error('comment failed'); });

      stubOctokit(client, {
        createReview: createReviewMock,
        deletePendingReview: deleteReviewMock,
        graphql: graphqlMock
      });

      await expect(client.createReviewGraphQL(
        'PR_xyz',
        'COMMENT',
        'body',
        [{ path: 'a.js', line: 1, body: 'hi' }],
        null,
        { owner: 'o', repo: 'r', prNumber: 1 }
      )).rejects.toThrow();

      // deletePendingReview (REST cleanup) must address the review by
      // its numeric id, not a node id, otherwise the cleanup 404s and
      // the draft is leaked.
      expect(deleteReviewMock).toHaveBeenCalled();
      expect(deleteReviewMock.mock.calls[0][0]).toMatchObject({
        owner: 'o', repo: 'r', pull_number: 1, review_id: 9999
      });
    });

    it('uses existingDraft.databaseId from prContext when an existing draft is supplied', async () => {
      // Existing-draft path (L1): caller passes `existingReviewId` (a
      // node id) and `prContext.reviewId = existingDraft.databaseId`.
      // Subsequent REST calls MUST use the numeric id.
      const client = new GitHubClient(altHostBinding({
        pending_review_comments: 'graphql'
      }));
      const submitReviewMock = vi.fn(async (args) => ({
        data: { id: args.review_id, node_id: 'PRR_existing', html_url: 'u', state: 'COMMENTED' }
      }));
      // createReview must NOT be called when an existing draft is reused.
      const createReviewMock = vi.fn(() => {
        throw new Error('should not create a new review when reusing an existing draft');
      });
      const graphqlMock = vi.fn(async () => ({ comment0: { thread: { id: 't' } } }));

      stubOctokit(client, {
        createReview: createReviewMock,
        submitReview: submitReviewMock,
        graphql: graphqlMock
      });

      await client.createReviewGraphQL(
        'PR_xyz',
        'COMMENT',
        'body',
        [{ path: 'a.js', line: 1, body: 'hi' }],
        'PRR_existing',                                  // existingReviewId (node id)
        { owner: 'o', repo: 'r', prNumber: 1, reviewId: 777 } // numeric id from existingDraft.databaseId
      );

      expect(submitReviewMock).toHaveBeenCalledTimes(1);
      expect(submitReviewMock.mock.calls[0][0]).toMatchObject({
        review_id: 777
      });
      expect(createReviewMock).not.toHaveBeenCalled();
    });
  });

  describe('C3+host: addCommentsInBatches in host mode receives numeric id', () => {
    it('posts comments to the host endpoint using the numeric review id from addPullRequestReview', async () => {
      const client = new GitHubClient(altHostBinding({
        // Use host mode for the comments path — the orchestration must
        // give the host impl a numeric review id (not the node id).
        pending_review_comments: 'host'
      }));

      const createReviewMock = vi.fn(async () => ({
        data: { id: 8888, node_id: 'PRR_new', html_url: 'u', state: 'PENDING' }
      }));
      const submitReviewMock = vi.fn(async (args) => ({
        data: { id: args.review_id, node_id: 'PRR_new', html_url: 'u', state: 'COMMENTED' }
      }));
      // The host impl uses octokit.request, not graphql.
      const requestMock = vi.fn(async () => ({ data: { added: 1, failed: [] } }));

      stubOctokit(client, {
        createReview: createReviewMock,
        submitReview: submitReviewMock,
        request: requestMock
      });

      await client.createReviewGraphQL(
        'PR_xyz',
        'COMMENT',
        'body',
        [{ path: 'a.js', line: 1, body: 'hi' }],
        null,
        { owner: 'o', repo: 'r', prNumber: 1 }
      );

      expect(requestMock).toHaveBeenCalledTimes(1);
      const [endpoint] = requestMock.mock.calls[0];
      // Host endpoint must include the numeric review id (8888), not
      // the GraphQL node id ('PRR_new').
      expect(endpoint).toBe('POST /repos/o/r/pulls/1/reviews/8888/comments');
    });
  });

  describe('host extension numeric-id assertion', () => {
    it('throws with a clear message when only a non-numeric review id is supplied', async () => {
      const octokit = { request: vi.fn() };
      await expect(hostImpl.addCommentsInBatches(
        octokit, {},
        { owner: 'o', repo: 'r', prNumber: 1 },
        'PRR_nodeid', // non-numeric — no prContext.reviewId either
        [{ path: 'a.js', line: 1, body: 'hi' }]
      )).rejects.toThrow(
        /requires a numeric review id; received "PRR_nodeid"/
      );
      expect(octokit.request).not.toHaveBeenCalled();
    });

    it('prefers prContext.reviewId over the positional reviewId argument when both are present', async () => {
      const octokit = { request: vi.fn(async () => ({ data: { added: 1, failed: [] } })) };
      await hostImpl.addCommentsInBatches(
        octokit, {},
        { owner: 'o', repo: 'r', prNumber: 1, reviewId: 999 },
        // Positional reviewId is a node id; the host impl should ignore
        // it because prContext.reviewId is numeric.
        'PRR_nodeid',
        [{ path: 'a.js', line: 1, body: 'hi' }]
      );
      const [endpoint] = octokit.request.mock.calls[0];
      expect(endpoint).toBe('POST /repos/o/r/pulls/1/reviews/999/comments');
    });
  });

  describe('L2: getReviewById invoked with numeric id', () => {
    it('passes the numeric review id from prContext through to the REST endpoint', async () => {
      const client = new GitHubClient(altHostBinding());
      const getReviewMock = vi.fn(async (args) => ({
        data: {
          id: args.review_id,
          node_id: 'PRR_xyz',
          state: 'APPROVED',
          submitted_at: '2026-05-19T00:00:00Z',
          html_url: 'u'
        }
      }));
      stubOctokit(client, { getReview: getReviewMock });

      // Reset the per-instance authenticated-user cache used by REST
      // pending-review to avoid cross-test contamination.
      restPending._resetAuthenticatedUserCache(client.octokit);

      const result = await client.getReviewById(
        'PRR_xyz', { owner: 'o', repo: 'r', prNumber: 1, reviewId: 12345 }
      );
      expect(getReviewMock).toHaveBeenCalledTimes(1);
      expect(getReviewMock.mock.calls[0][0]).toMatchObject({
        owner: 'o', repo: 'r', pull_number: 1, review_id: 12345
      });
      expect(result).toEqual({
        id: 'PRR_xyz',
        state: 'APPROVED',
        submittedAt: '2026-05-19T00:00:00Z',
        url: 'u'
      });
    });
  });

  describe('L4: DEFAULT_FEATURES mirrors GRAPHQL_DEFAULT_AREAS in config.js', () => {
    it('lists every area named in FEATURE_AREAS', () => {
      const defaultKeys = new Set(Object.keys(DEFAULT_FEATURES));
      for (const area of FEATURE_AREAS) {
        expect(defaultKeys.has(area)).toBe(true);
      }
    });

    it('defaults each GRAPHQL_DEFAULT_AREA to "graphql" and everything else to "rest"', () => {
      for (const area of FEATURE_AREAS) {
        const expected = GRAPHQL_DEFAULT_AREAS.has(area) ? 'graphql' : 'rest';
        expect(DEFAULT_FEATURES[area]).toBe(expected);
      }
    });

    it('matches when constructed from a bare token string', () => {
      const client = new GitHubClient('tok');
      for (const area of FEATURE_AREAS) {
        const expected = GRAPHQL_DEFAULT_AREAS.has(area) ? 'graphql' : 'rest';
        expect(client.features[area]).toBe(expected);
      }
      // Confirm there are no extra areas that drifted out of config.js.
      const featureKeys = new Set(Object.keys(client.features));
      for (const key of featureKeys) {
        expect(FEATURE_AREAS).toContain(key);
      }
    });
  });
});
