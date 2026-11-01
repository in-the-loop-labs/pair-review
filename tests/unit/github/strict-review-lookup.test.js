// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const { GitHubClient } = require('../../../src/github/client');

// Exercise the public client, dispatcher, and real adapters; only Octokit is stubbed.
function clientFor(mode, handler) {
  return {
    features: { pending_review_check: mode },
    octokit: mode === 'graphql'
      ? { graphql: vi.fn(handler) }
      : { rest: { pulls: { getReview: vi.fn(handler) } } },
    getReviewById: GitHubClient.prototype.getReviewById
  };
}
const context = { owner: 'o', repo: 'r', prNumber: 1, reviewId: '123' };

for (const mode of ['graphql', 'rest']) {
  describe(`strict review lookup (${mode})`, () => {
    it('returns submitted review data through the real adapter', async () => {
      const client = clientFor(mode, async () => mode === 'graphql'
        ? { node: { id: 'PRR_123', state: 'COMMENTED', submittedAt: '2026-10-30T00:00:00Z', url: 'review-url' } }
        : { data: { node_id: 'PRR_123', id: 123, state: 'COMMENTED', submitted_at: '2026-10-30T00:00:00Z', html_url: 'review-url' } });
      expect(await client.getReviewById('PRR_123', context, { strict: true }))
        .toMatchObject({ state: 'COMMENTED', submittedAt: '2026-10-30T00:00:00Z', url: 'review-url' });
    });

    it.each([403, 429, 503])('propagates HTTP %i in strict mode but preserves legacy null', async status => {
      const error = Object.assign(new Error('lookup failed'), { status });
      const client = clientFor(mode, async () => { throw error; });
      await expect(client.getReviewById('PRR_123', context, { strict: true })).rejects.toBe(error);
      await expect(client.getReviewById('PRR_123', context)).resolves.toBeNull();
    });

    it('propagates network errors', async () => {
      const error = new Error('connection reset');
      const client = clientFor(mode, async () => { throw error; });
      await expect(client.getReviewById('PRR_123', context, { strict: true })).rejects.toBe(error);
    });

    it('returns null for a confirmed 404', async () => {
      const client = clientFor(mode, async () => { throw Object.assign(new Error('missing'), { status: 404 }); });
      await expect(client.getReviewById('PRR_123', context, { strict: true })).resolves.toBeNull();
    });
  });
}

describe('strict GraphQL review lookup', () => {
  it('returns null for a null node or NOT_FOUND errors', async () => {
    const client = clientFor('graphql', async () => ({ node: null }));
    await expect(client.getReviewById('PRR_missing', null, { strict: true })).resolves.toBeNull();
    client.octokit.graphql.mockRejectedValue({ errors: [{ type: 'NOT_FOUND' }] });
    await expect(client.getReviewById('PRR_missing', null, { strict: true })).resolves.toBeNull();
  });

  it('does not treat a schema error mentioning not found as a missing review', async () => {
    const error = { errors: [{ message: 'Field not found in schema' }] };
    const client = clientFor('graphql', async () => { throw error; });
    await expect(client.getReviewById('PRR_missing', null, { strict: true })).rejects.toBe(error);
  });

  it('does not treat mixed GraphQL errors as confirmed absence', async () => {
    const error = { errors: [{ type: 'NOT_FOUND' }, { type: 'INTERNAL' }] };
    const client = clientFor('graphql', async () => { throw error; });
    await expect(client.getReviewById('PRR_missing', null, { strict: true })).rejects.toBe(error);
  });
});

it('strict REST lookup rejects an unusable review identity rather than reporting absence', async () => {
  const client = clientFor('rest', vi.fn());
  await expect(client.getReviewById('PRR_no_numeric_id', { owner: 'o', repo: 'r', prNumber: 1 }, { strict: true }))
    .rejects.toThrow('non-numeric id');
  expect(client.octokit.rest.pulls.getReview).not.toHaveBeenCalled();
});
