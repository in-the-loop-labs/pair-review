// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
const { installGitHubReviewMock } = require('../utils/github-review-mock');

const context = { owner: 'o', repo: 'r', prNumber: 1 };
function makeClient() {
  class Client {}
  installGitHubReviewMock(Client);
  return new Client();
}

describe('stateful E2E GitHub review mock', () => {
  it('keeps a draft pending, appends comments, and submits the same review', async () => {
    const client = makeClient();
    expect(await client.getPendingReviewForUser('o', 'r', 1)).toBeNull();
    const draft = await client.createDraftReviewGraphQL('PR_1', 'first body', [{ body: 'one' }], null, context);
    expect(await client.getPendingReviewForUser('o', 'r', 1)).toMatchObject({ id: draft.id, state: 'PENDING' });
    expect(await client.getPendingReviewForUser('o', 'r', 2)).toBeNull();
    const updated = await client.createDraftReviewGraphQL('PR_1', 'ignored body', [{ body: 'two' }], draft.id, context);
    expect(updated).toMatchObject({ id: draft.id, body: 'first body', comments: { totalCount: 2 }, comments_count: 1 });
    expect(updated.postedComments[0]).toMatchObject({ index: 0, github_comment_id: expect.any(String), github_comment_url: expect.any(String) });
    expect(updated.postedComments[0].github_comment_id).not.toBe(draft.postedComments[0].github_comment_id);
    const submitted = await client.createReviewGraphQL('PR_1', 'COMMENT', 'submitted body', [], draft.id, context);
    expect(submitted).toMatchObject({ id: draft.id, state: 'COMMENTED', body: 'submitted body', comments: { totalCount: 2 } });
    expect(await client.getPendingReviewForUser('o', 'r', 1)).toBeNull();
    expect(await client.getReviewById(draft.id)).toMatchObject({ state: 'COMMENTED' });
    expect(await client.getReviewById(draft.databaseId)).toMatchObject({ state: 'COMMENTED' });
    await expect(makeClient().getReviewById(draft.id)).resolves.toBeNull();
  });

  it('creates distinct subsequent submissions and maps the submitted event', async () => {
    const client = makeClient();
    const first = await client.createReviewGraphQL('PR_1', 'APPROVE', '', [], null, context);
    const second = await client.createReviewGraphQL('PR_1', 'REQUEST_CHANGES', '', [], null, context);
    expect(first.state).toBe('APPROVED');
    expect(second.state).toBe('CHANGES_REQUESTED');
    expect(first.id).not.toBe(second.id);
  });
});
