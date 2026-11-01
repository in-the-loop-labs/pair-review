// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const graphql = require('../../../../src/github/impl/graphql/pending-review-comments');
const host = require('../../../../src/github/impl/host/pending-review-comments');
const comments = Array.from({ length: 3 }, (_, i) => ({ path: `${i}.js`, line: i + 1, body: `note ${i}` }));
const ctx = { owner: 'test', repo: 'repo', prNumber: 1 };
const posting = (index, id = null, nodeId = null, url = null) => ({
  index, github_comment_id: id, github_comment_node_id: nodeId, github_comment_url: url
});
const thread = (id) => ({ thread: { id: `thread-${id}`, comments: { nodes: [{
  id: `node-${id}`, fullDatabaseId: id, url: `https://github.com/comment/${id}`
}] } } });

describe('per-comment transport results', () => {
  it('tracks original indexes across GraphQL batches and stringifies fullDatabaseId', async () => {
    const octokit = { graphql: vi.fn()
      .mockResolvedValueOnce({ comment0: thread('9007199254740993'), comment1: { thread: { id: 't' } } })
      .mockResolvedValueOnce({ comment0: thread(12) }) };
    const result = await graphql.addCommentsInBatches(octokit, 'pr', 'review', comments, 2);
    expect(result.posted).toEqual([
      posting(0, '9007199254740993', 'node-9007199254740993', 'https://github.com/comment/9007199254740993'),
      posting(1), posting(2, '12', 'node-12', 'https://github.com/comment/12')
    ]);
    expect(result.successCount).toBe(3);
    expect(octokit.graphql.mock.calls[0][0]).toContain('nodes { id fullDatabaseId url }');
    expect(graphql.buildBatchMutation([{ path: 'a', body: 'file' }])).toContain('nodes { id fullDatabaseId url }');
  });

  it('falls back only after pure fullDatabaseId schema validation, before any mutation executed', async () => {
    const octokit = { graphql: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('schema validation'), { errors: [{
        message: "Field 'fullDatabaseId' doesn't exist on type 'PullRequestReviewComment'",
        extensions: { code: 'undefinedField', fieldName: 'fullDatabaseId' }
      }] }))
      .mockResolvedValueOnce({ comment0: { thread: { id: 't0' } }, comment1: { thread: { id: 't1' } } })
      .mockResolvedValueOnce({ comment0: { thread: { id: 't2' } } }) };
    const result = await graphql.addCommentsInBatches(octokit, 'pr', 'review', comments, 2);
    expect(result.posted).toEqual([posting(0), posting(1), posting(2)]);
    expect(result.failed).toBe(false);
    expect(octokit.graphql).toHaveBeenCalledTimes(3);
    expect(octokit.graphql.mock.calls[0][0]).toContain('fullDatabaseId');
    expect(octokit.graphql.mock.calls[1][0]).not.toContain('comments(first:');
    expect(octokit.graphql.mock.calls[2][0]).not.toContain('comments(first:');
  });

  it('never metadata-fallback retries a response that already includes partial successes', async () => {
    const octokit = { graphql: vi.fn().mockRejectedValue(Object.assign(new Error('partial'), {
      data: { comment0: thread(1) }, errors: [{ message: "Cannot query field 'fullDatabaseId' on type 'PullRequestReviewComment'" }]
    })) };
    const result = await graphql.addCommentsInBatches(octokit, 'pr', 'review', comments);
    expect(result.failed).toBe(true);
    expect(result.posted.map(p => p.index)).toEqual([0]);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it.each(['invalid line', 'Query has complexity exceeding the maximum'])('does not replay successful aliases on partial error: %s', async (message) => {
    const error = Object.assign(new Error(message), {
      data: { comment0: thread(1), comment1: null },
      errors: [{ path: ['comment1'], message }]
    });
    const octokit = { graphql: vi.fn()
      .mockResolvedValueOnce({ comment0: thread(0), comment1: thread(2) })
      .mockRejectedValueOnce(error) };
    // Real retry loop: fake timers flush any accidentally scheduled retry.
    vi.useFakeTimers();
    try {
      const work = graphql.addCommentsInBatches(octokit, 'pr', 'review', [...comments, comments[0]], 2);
      await vi.runAllTimersAsync();
      const result = await work;
      expect(result.failed).toBe(true);
      expect(result.successCount).toBe(3);
      expect(result.posted.map(p => p.index)).toEqual([0, 1, 2]);
      expect(octokit.graphql).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns known successes when every alias succeeded despite an error envelope', async () => {
    const octokit = { graphql: vi.fn().mockRejectedValue(Object.assign(new Error('other error'), {
      data: { comment0: thread(0) }, errors: [{ message: 'other error' }]
    })) };
    const result = await graphql.addCommentsInBatches(octokit, 'pr', 'review', comments.slice(0, 1));
    expect(result.failed).toBe(false);
    expect(result.posted.map(p => p.index)).toEqual([0]);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it('tracks singular host successes around a 422 and preserves returned ids', async () => {
    const octokit = { request: vi.fn()
      .mockResolvedValueOnce({ data: { id: 10, node_id: 'node', html_url: 'https://host/comment/10' } })
      .mockRejectedValueOnce(Object.assign(new Error('invalid'), { status: 422 }))
      .mockResolvedValueOnce({ data: {} }) };
    const result = await host.addCommentsInBatches(octokit, { pending_review_comments_batch: false }, ctx, 1, comments);
    expect(result.posted).toEqual([posting(0, '10', 'node', 'https://host/comment/10'), posting(2)]);
    expect(result.successCount).toBe(2);
    expect(result.failed).toBe(true);
  });

  it('uses only complete consistent host batch accounting to derive successful indexes', async () => {
    const octokit = { request: vi.fn().mockResolvedValue({ data: { added: 2, failed: [{ index: 1 }] } }) };
    const result = await host.addCommentsInBatches(octokit, {}, ctx, 1, comments);
    expect(result.posted).toEqual([posting(0), posting(2)]);
  });

  it.each([
    { added: 0, failed: [] }, { added: 1, failed: [] }, { failed: [] },
    { added: 2, failed: [{}] }, { added: 1, failed: [{ index: 0 }, { index: 0 }] },
    { added: 2, failed: [{ index: 4 }] }, { added: 2, failed: [{ index: 0.5 }] },
    { added: 2, failed: [null] }, { added: -1, failed: [] }
  ])('reports an unknown subset for ambiguous host accounting: %j', async (data) => {
    const result = await host.addCommentsInBatches({ request: vi.fn().mockResolvedValue({ data }) }, {}, ctx, 1, comments);
    expect(result.posted).toBeNull();
  });

  it('reports every host batch index on full explicit success', async () => {
    const result = await host.addCommentsInBatches({ request: vi.fn().mockResolvedValue({ data: { added: 3, failed: [] } }) }, {}, ctx, 1, comments);
    expect(result.posted).toEqual([posting(0), posting(1), posting(2)]);
  });

  it('reports unknown on a lost host response', async () => {
    const result = await host.addCommentsInBatches({ request: vi.fn().mockRejectedValue(new Error('connection lost')) }, {}, ctx, 1, comments);
    expect(result.posted).toBeNull();
    expect(result.failed).toBe(true);
  });
});
