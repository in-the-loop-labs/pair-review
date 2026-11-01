// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';
import githubClientModule from '../../src/github/client.js';

test('posting links, restore without repost, pending-only Clear All, and GitHub draft reconciliation', async ({ page, testServer }) => {
  await page.goto('/pr/test-owner/test-repo/1');
  await waitForDiffToRender(page);
  const reviewId = await page.evaluate(() => window.prManager.currentPR.id);
  const api = `/api/reviews/${reviewId}/comments`;
  // Per-worker DB is private, but earlier specs may have left user comments.
  testServer.db.prepare("UPDATE comments SET status = 'inactive' WHERE review_id = ? AND source = 'user'").run(reviewId);
  const create = async body => {
    const response = await page.request.post(api, { data: { file: 'src/utils.js', body } });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).commentId;
  };
  const postedId = await create('Publication regression posted comment');
  const submit = async event => {
    const response = await page.request.post('/api/pr/test-owner/test-repo/1/submit-review', { data: { event, body: event === 'DRAFT' ? '' : 'Review body' } });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  await submit('COMMENT');
  await page.reload();
  await waitForDiffToRender(page);
  const card = page.locator(`.file-comment-card[data-comment-id="${postedId}"]`);
  await expect(card.locator('a.posted-comment-icon')).toHaveAttribute('href', /-comment-/);
  await expect(card.locator('a.posted-comment-icon')).toHaveAttribute('title', 'Posted comment');

  expect((await page.request.delete(`${api}/${postedId}`)).ok()).toBeTruthy();
  const restore = await page.request.put(`${api}/${postedId}/restore`);
  expect((await restore.json()).comment.publication.state).toBe('posted');
  await submit('APPROVE');
  expect(testServer.db.prepare('SELECT COUNT(*) n FROM comment_postings WHERE comment_id = ?').get(postedId).n).toBe(1);

  const pendingId = await create('Only this pending comment is cleared');
  await page.reload();
  await waitForDiffToRender(page);
  expect(await page.evaluate(() => window.prManager.getPendingCommentCount())).toBe(1);
  await page.evaluate(() => { window.prManager.clearAllUserComments(); });
  const dialog = page.locator('.confirm-dialog-overlay');
  await expect(dialog).toContainText('1 pending comment');
  await expect(dialog).toContainText('Posted comments are kept.');
  await dialog.getByRole('button', { name: 'Clear All', exact: true }).click();
  await expect(page.locator(`.file-comment-card[data-comment-id="${pendingId}"]`)).toHaveCount(0);
  await expect(card).toBeVisible();

  const draftId = await create('Draft submitted directly on GitHub');
  await submit('DRAFT');
  await page.reload();
  await waitForDiffToRender(page);
  const draftCard = page.locator(`.file-comment-card[data-comment-id="${draftId}"]`);
  await expect(draftCard.locator('a.posted-comment-icon')).toHaveAttribute('title', 'In pending draft review');
  const draft = testServer.db.prepare("SELECT * FROM github_reviews WHERE review_id = ? AND state = 'pending' ORDER BY id DESC LIMIT 1").get(reviewId);
  // Simulate submission on GitHub, bypassing pair-review's bookkeeping. Only
  // the installed fake transport changes; the reload uses real reconciliation.
  await githubClientModule.GitHubClient.prototype.createReviewGraphQL(null, 'COMMENT', 'Submitted elsewhere', [], draft.github_node_id,
    { owner: 'test-owner', repo: 'test-repo', prNumber: 1 });
  await page.reload();
  await waitForDiffToRender(page);
  await expect(draftCard.locator('a.posted-comment-icon')).toHaveAttribute('title', 'Posted comment');
  expect(await page.evaluate(() => window.prManager.getPendingCommentCount())).toBe(0);
});
