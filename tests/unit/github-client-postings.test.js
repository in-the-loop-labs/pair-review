// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest';
const { GitHubClient } = require('../../src/github/client');

const comments = [{ path: 'a.js', line: 1, body: 'one' }, { path: 'a.js', line: 2, body: 'two' }];
const posted = [{ index: 0, github_comment_id: '10', github_comment_node_id: 'n10', github_comment_url: 'https://github.com/c/10' }];
const draft = { id: 'review', databaseId: 42, url: 'https://github.com/review/42' };
const created = { addPullRequestReview: { pullRequestReview: draft } };

// The two public entry points share the result/error contract, including
// failures after a transport result and failures thrown before returning it.
describe.each(['submit', 'draft'])('client posting metadata: %s', (mode) => {
  afterEach(() => vi.restoreAllMocks());
  const call = (client, existing = null) => mode === 'submit'
    ? client.createReviewGraphQL('pr', 'COMMENT', 'body', comments, existing, { reviewId: 42 })
    : client.createDraftReviewGraphQL('pr', 'body', comments, existing, { reviewId: 42 });

  it('returns per-comment results on success', async () => {
    const client = new GitHubClient('test-token');
    client.octokit.graphql = vi.fn().mockResolvedValueOnce(created).mockResolvedValueOnce({
      submitPullRequestReview: { pullRequestReview: { ...draft, state: 'COMMENTED' } }
    });
    vi.spyOn(client, 'addCommentsInBatches').mockResolvedValue({ successCount: 2, failed: false, failedDetails: [], posted });
    const result = await call(client);
    expect(result.postedComments).toEqual(posted);
  });

  it('keeps the exact subset for a retained existing draft through the outer rewrap', async () => {
    const client = new GitHubClient('test-token');
    vi.spyOn(client, 'addCommentsInBatches').mockResolvedValue({ successCount: 1, failed: true, failedDetails: ['invalid line'], posted });
    const cleanup = vi.spyOn(client, 'deletePendingReview');
    await expect(call(client, 'existing')).rejects.toMatchObject({
      postedComments: posted, reviewRetained: true, pendingReview: { id: 'existing', databaseId: 42 }
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it.each([true, false])('reports whether cleanup removed a newly-created review: %s', async (cleaned) => {
    const client = new GitHubClient('test-token');
    client.octokit.graphql = vi.fn().mockResolvedValue(created);
    vi.spyOn(client, 'addCommentsInBatches').mockResolvedValue({ successCount: 1, failed: true, failedDetails: [], posted });
    vi.spyOn(client, 'deletePendingReview').mockResolvedValue(cleaned);
    await expect(call(client)).rejects.toMatchObject({
      postedComments: posted, reviewRetained: !cleaned, pendingReview: { id: 'review', databaseId: 42 }
    });
  });

  it('preserves a known subset on thrown batch errors through both rewraps', async () => {
    const client = new GitHubClient('test-token');
    vi.spyOn(client, 'addCommentsInBatches').mockRejectedValue(Object.assign(new Error('batch failed'), { postedComments: posted }));
    await expect(call(client, 'existing')).rejects.toMatchObject({
      postedComments: posted, reviewRetained: true, pendingReview: { id: 'existing', databaseId: 42 }
    });
  });

  it('preserves explicit unknown subsets rather than guessing all comments', async () => {
    const client = new GitHubClient('test-token');
    vi.spyOn(client, 'addCommentsInBatches').mockResolvedValue({ successCount: 1, failed: true, failedDetails: [], posted: null });
    await expect(call(client, 'existing')).rejects.toMatchObject({ postedComments: null, reviewRetained: true });
  });

  it('keeps explicit unknown on legacy host success without complete accounting', async () => {
    const client = new GitHubClient('test-token');
    client.octokit.graphql = vi.fn().mockResolvedValue({ submitPullRequestReview: { pullRequestReview: draft } });
    vi.spyOn(client, 'addCommentsInBatches').mockResolvedValue({ successCount: 2, failed: false, failedDetails: [], posted: null });
    expect((await call(client, 'existing')).postedComments).toBeNull();
  });

  it('reports unknown on a batch throw with no results', async () => {
    const client = new GitHubClient('test-token');
    vi.spyOn(client, 'addCommentsInBatches').mockRejectedValue(new Error('unexpected failure'));
    await expect(call(client, 'existing')).rejects.toMatchObject({ postedComments: null, reviewRetained: true });
  });
});

describe('step-3 submit failure', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([false, true])('retains known postings and review identity through GraphQL error rewrap: %s', async (graphqlEnvelope) => {
    const client = new GitHubClient('test-token');
    const error = new Error('submit failed');
    if (graphqlEnvelope) error.errors = [{ message: 'submit rejected' }];
    client.octokit.graphql = vi.fn().mockResolvedValueOnce(created).mockRejectedValueOnce(error);
    vi.spyOn(client, 'addCommentsInBatches').mockResolvedValue({ successCount: 2, failed: false, failedDetails: [], posted });
    const cleanup = vi.spyOn(client, 'deletePendingReview');
    await expect(client.createReviewGraphQL('pr', 'COMMENT', 'body', comments)).rejects.toMatchObject({
      postedComments: posted, reviewRetained: true, pendingReview: { id: 'review', databaseId: 42 }
    });
    expect(cleanup).not.toHaveBeenCalled();
  });
});
