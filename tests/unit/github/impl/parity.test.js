// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Parity tests: drive a canonical input through both the GraphQL and
 * REST implementations of each Phase-4 area and assert the returned
 * shape is byte-identical. The REST impl is allowed to fill in
 * additional fields the GraphQL response does not expose; for these
 * tests we only compare the fields the GraphQL response provides — any
 * extra REST-only fields would be flagged as a deviation in the task
 * report.
 *
 * If the shapes diverge, the consumer code in `client.js` would break,
 * so this is the primary regression guard for Phase 4.
 */

const graphqlPending = require('../../../../src/github/impl/graphql/pending-review');
const restPending = require('../../../../src/github/impl/rest/pending-review');

const graphqlStack = require('../../../../src/github/impl/graphql/stack-walker');
const restStack = require('../../../../src/github/impl/rest/stack-walker');

const graphqlLifecycle = require('../../../../src/github/impl/graphql/review-lifecycle');
const restLifecycle = require('../../../../src/github/impl/rest/review-lifecycle');

const PR_CTX = { owner: 'o', repo: 'r', prNumber: 1 };

function gqlOctokit(handler) {
  return { graphql: vi.fn(handler) };
}

function restOctokit(handlers) {
  return {
    rest: {
      users: { getAuthenticated: vi.fn(handlers.getAuthenticated || (async () => ({ data: { id: 42 } }))) },
      pulls: {
        get: vi.fn(handlers.get || (async () => ({ data: null }))),
        list: vi.fn(handlers.list || (async () => ({ data: [] }))),
        listReviews: vi.fn(handlers.listReviews || (async () => ({ data: [] }))),
        listReviewComments: vi.fn(handlers.listReviewComments || (async () => ({ data: [] }))),
        listCommentsForReview: vi.fn(handlers.listCommentsForReview || (async () => ({ data: [] }))),
        getReview: vi.fn(handlers.getReview || (async () => ({ data: null }))),
        createReview: vi.fn(handlers.createReview || (async () => ({ data: null }))),
        submitReview: vi.fn(handlers.submitReview || (async () => ({ data: null }))),
        deletePendingReview: vi.fn(handlers.deletePendingReview || (async () => ({ data: null })))
      }
    },
    paginate: vi.fn(async (method, opts) => {
      const { data } = await method(opts);
      return data || [];
    })
  };
}

describe('parity: GraphQL vs REST', () => {
  describe('pending_review_check', () => {
    it('getPendingReviewForUser returns the same shape from both transports', async () => {
      // GraphQL canonical response
      const gqlResp = {
        repository: {
          pullRequest: {
            reviews: {
              nodes: [{
                id: 'PRR_abc',
                databaseId: 101,
                body: 'draft',
                url: 'https://althost.example/o/r/pull/1#pullrequestreview-101',
                state: 'PENDING',
                createdAt: '2026-05-19T00:00:00Z',
                viewerDidAuthor: true,
                comments: { totalCount: 2 }
              }]
            }
          }
        }
      };
      const gql = await graphqlPending.getPendingReviewForUser(
        gqlOctokit(async () => gqlResp), 'o', 'r', 1
      );

      // Matching REST response
      const rest = await restPending.getPendingReviewForUser(restOctokit({
        getAuthenticated: async () => ({ data: { id: 42 } }),
        listReviews: async () => ({ data: [
          {
            id: 101,
            node_id: 'PRR_abc',
            state: 'PENDING',
            user: { id: 42 },
            body: 'draft',
            html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-101',
            submitted_at: '2026-05-19T00:00:00Z'
          }
        ] }),
        listCommentsForReview: async () => ({ data: [
          { id: 1 },
          { id: 2 }
        ] })
      }), 'o', 'r', 1);

      // The GraphQL response carries a real `createdAt`; the REST API
      // does not expose any created-at timestamp for a review and
      // `submitted_at` is null while pending, so the REST shape must
      // surface `createdAt: null`. All other fields stay identical.
      expect(rest).toEqual({ ...gql, createdAt: null });
    });

    it('getReviewById returns the same shape from both transports', async () => {
      const gql = await graphqlPending.getReviewById(gqlOctokit(async () => ({
        node: {
          id: 'PRR_def',
          state: 'APPROVED',
          submittedAt: '2026-05-19T01:00:00Z',
          url: 'https://althost.example/o/r/pull/1#pullrequestreview-77'
        }
      })), 'PRR_def');

      const rest = await restPending.getReviewById(restOctokit({
        getReview: async () => ({ data: {
          id: 77,
          node_id: 'PRR_def',
          state: 'APPROVED',
          submitted_at: '2026-05-19T01:00:00Z',
          html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-77'
        } })
      }), 'PRR_def', { ...PR_CTX, reviewId: 77 });

      expect(rest).toEqual(gql);
    });
  });

  describe('stack_walker', () => {
    it('walkPRStack returns the same stack shape from both transports', async () => {
      const sharedNodes = {
        prA: { number: 1, title: 'A', baseRefName: 'main', headRefName: 'feat-a', state: 'MERGED', url: 'https://althost.example/o/r/pull/1', headRefOid: 'sha-1' },
        prB: { number: 2, title: 'B', baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN', url: 'https://althost.example/o/r/pull/2', headRefOid: 'sha-2' },
        prC: { number: 3, title: 'C', baseRefName: 'feat-b', headRefName: 'feat-c', state: 'OPEN', url: 'https://althost.example/o/r/pull/3', headRefOid: 'sha-3' }
      };

      // --- GraphQL ---
      const gqlStack = await graphqlStack.walkPRStack(
        gqlOctokit(async (query, vars) => {
          if (vars.number === 2) return { repository: { pullRequest: sharedNodes.prB } };
          if (vars.branch === 'feat-a' && query.includes('headRefName')) {
            return { repository: { pullRequests: { nodes: [sharedNodes.prA] } } };
          }
          if (vars.branch === 'feat-b' && query.includes('baseRefName')) {
            return { repository: { pullRequests: { nodes: [sharedNodes.prC] } } };
          }
          return { repository: { pullRequests: { nodes: [] } } };
        }),
        'o', 'r', 2
      );

      // --- REST ---
      const restPRForNumber = {
        1: { number: 1, title: 'A', base: { ref: 'main' }, head: { ref: 'feat-a', sha: 'sha-1' }, state: 'closed', merged_at: '2026-01-01', html_url: 'https://althost.example/o/r/pull/1' },
        2: { number: 2, title: 'B', base: { ref: 'feat-a' }, head: { ref: 'feat-b', sha: 'sha-2' }, state: 'open', merged_at: null, html_url: 'https://althost.example/o/r/pull/2' },
        3: { number: 3, title: 'C', base: { ref: 'feat-b' }, head: { ref: 'feat-c', sha: 'sha-3' }, state: 'open', merged_at: null, html_url: 'https://althost.example/o/r/pull/3' }
      };
      const restStackResult = await restStack.walkPRStack(
        restOctokit({
          get: async ({ pull_number }) => ({ data: restPRForNumber[pull_number] || null }),
          list: async ({ head, base }) => {
            if (head === 'o:feat-a') return { data: [restPRForNumber[1]] };
            if (base === 'feat-b') return { data: [restPRForNumber[3]] };
            return { data: [] };
          }
        }),
        'o', 'r', 2
      );

      expect(restStackResult).toEqual(gqlStack);
    });
  });

  describe('review_lifecycle', () => {
    it('addPullRequestReview returns the same { id, databaseId } from both transports', async () => {
      const gql = await graphqlLifecycle.addPullRequestReview(
        gqlOctokit(async () => ({ addPullRequestReview: { pullRequestReview: { id: 'PRR_new', databaseId: 555 } } })),
        'PR_xyz'
      );
      const rest = await restLifecycle.addPullRequestReview(
        restOctokit({ createReview: async () => ({ data: { id: 555, node_id: 'PRR_new', html_url: 'u', state: 'PENDING' } }) }),
        'PR_xyz',
        PR_CTX
      );
      expect(rest).toEqual(gql);
      // Surface the numeric id explicitly — downstream REST/host paths
      // depend on it.
      expect(rest.databaseId).toBe(555);
      expect(gql.databaseId).toBe(555);
    });

    it('addPullRequestReviewWithBody returns the same { id, databaseId, url } from both transports', async () => {
      const gql = await graphqlLifecycle.addPullRequestReviewWithBody(
        gqlOctokit(async () => ({
          addPullRequestReview: {
            pullRequestReview: {
              id: 'PRR_new',
              databaseId: 42,
              url: 'https://althost.example/o/r/pull/1#pullrequestreview-42'
            }
          }
        })),
        'PR_xyz',
        'summary'
      );
      const rest = await restLifecycle.addPullRequestReviewWithBody(
        restOctokit({ createReview: async () => ({ data: {
          id: 42,
          node_id: 'PRR_new',
          html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-42',
          state: 'PENDING'
        } }) }),
        'PR_xyz',
        'summary',
        PR_CTX
      );
      expect(rest).toEqual(gql);
    });

    it('submitPullRequestReview returns the same { id, databaseId, url, state } from both transports', async () => {
      const gql = await graphqlLifecycle.submitPullRequestReview(
        gqlOctokit(async () => ({
          submitPullRequestReview: {
            pullRequestReview: {
              id: 'PRR_done',
              databaseId: 99,
              url: 'https://althost.example/o/r/pull/1#pullrequestreview-99',
              state: 'COMMENTED'
            }
          }
        })),
        'PRR_done',
        'COMMENT',
        'lgtm'
      );
      const rest = await restLifecycle.submitPullRequestReview(
        restOctokit({ submitReview: async () => ({ data: {
          id: 99,
          node_id: 'PRR_done',
          html_url: 'https://althost.example/o/r/pull/1#pullrequestreview-99',
          state: 'COMMENTED'
        } }) }),
        'PRR_done',
        'COMMENT',
        'lgtm',
        { ...PR_CTX, reviewId: 99 }
      );
      expect(rest).toEqual(gql);
    });

    it('deletePullRequestReview returns identical boolean shape', async () => {
      const gql = await graphqlLifecycle.deletePullRequestReview(
        gqlOctokit(async () => ({ deletePullRequestReview: { pullRequestReview: { id: 'PRR_gone' } } })),
        'PRR_gone'
      );
      const rest = await restLifecycle.deletePullRequestReview(
        restOctokit({ deletePendingReview: async () => ({ data: {} }) }),
        'PRR_gone',
        { ...PR_CTX, reviewId: 99 }
      );
      expect(rest).toEqual(gql);
    });
  });
});
