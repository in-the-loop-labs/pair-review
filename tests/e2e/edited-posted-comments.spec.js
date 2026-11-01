// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Editing a comment already posted to GitHub updates that GitHub comment in
 * place; pair-review never posts a second copy. Covers the "Edited since
 * posted" note and "Update on GitHub" action (success and failure), the
 * submit dialog's "Also update N edited comments", the review history
 * modal, and their absence in local mode.
 */
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

const PR_URL = '/pr/test-owner/test-repo/1';

async function openFreshPR(page, testServer) {
  await page.goto(PR_URL);
  await waitForDiffToRender(page);
  const reviewId = await page.evaluate(() => window.prManager.currentPR.id);
  // The per-worker DB is shared by this worker's specs: start without user comments.
  testServer.db.prepare("UPDATE comments SET status = 'inactive' WHERE review_id = ? AND source = 'user'").run(reviewId);
  return reviewId;
}

async function createFileComment(page, reviewId, body) {
  const response = await page.request.post(`/api/reviews/${reviewId}/comments`, { data: { file: 'src/utils.js', body } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).commentId;
}

async function submit(page, event = 'COMMENT') {
  const response = await page.request.post('/api/pr/test-owner/test-repo/1/submit-review', { data: { event, body: 'Review body' } });
  expect(response.ok()).toBeTruthy();
}

function postings(testServer, commentId) {
  return testServer.db.prepare('SELECT kind, body FROM comment_postings WHERE comment_id = ? ORDER BY id').all(commentId);
}

async function reload(page) {
  await page.reload();
  await waitForDiffToRender(page);
}

test.describe('edited posted comments (PR mode)', () => {
  test('editing a posted comment offers Update on GitHub, which edits the GitHub comment in place', async ({ page, testServer }) => {
    const reviewId = await openFreshPR(page, testServer);
    const id = await createFileComment(page, reviewId, 'Posted once');
    await submit(page);
    await reload(page);

    const card = page.locator(`.file-comment-card[data-comment-id="${id}"]`);
    await expect(card.locator('a.posted-comment-icon')).toBeVisible();
    await expect(card.locator('.posted-comment-edited')).toHaveCount(0);

    // Edit in the UI: the note appears without a reload
    await card.locator('.btn-edit-comment').click();
    await card.locator('.file-comment-textarea').fill('Posted once, then edited');
    await card.locator('.save-edit-btn').click();
    const note = card.locator('.posted-comment-edited');
    await expect(note).toContainText('Edited since posted');
    expect(await page.evaluate(() => window.prManager.getPendingCommentCount())).toBe(0);

    await note.getByRole('button', { name: 'Update on GitHub' }).click();
    await expect(card.locator('.posted-comment-edited')).toHaveCount(0);
    await expect(card.locator('.user-comment-body')).toContainText('Posted once, then edited');
    const rows = postings(testServer, id);
    expect(rows.map(r => r.kind)).toEqual(['post', 'update']);
    expect(rows[1].body).toContain('Posted once, then edited');

    // Still clear after a reload: the server agrees nothing changed since
    await reload(page);
    await expect(card.locator('.user-comment-body')).toContainText('Posted once, then edited');
    await expect(card.locator('.posted-comment-edited')).toHaveCount(0);
  });

  test('a failed update shows the error, keeps the comment edited and posts nothing', async ({ page, testServer }) => {
    const reviewId = await openFreshPR(page, testServer);
    const id = await createFileComment(page, reviewId, 'Will be deleted on GitHub');
    await submit(page);
    // The E2E GitHub mock answers 404 for this marker, as for a comment deleted on GitHub
    expect((await page.request.put(`/api/reviews/${reviewId}/comments/${id}`, { data: { body: 'E2E_FAIL_UPDATE_404 edit' } })).ok()).toBeTruthy();
    await reload(page);

    const card = page.locator(`.file-comment-card[data-comment-id="${id}"]`);
    const button = card.getByRole('button', { name: 'Update on GitHub' });
    await button.click();
    const error = card.locator('.posted-comment-update-error');
    await expect(error).toBeVisible();
    await expect(error).not.toBeEmpty();
    await expect(card.locator('.posted-comment-edited-label')).toHaveText('Edited since posted');
    await expect(button).toBeEnabled();
    expect(postings(testServer, id).map(r => r.kind)).toEqual(['post']);
    expect(await page.evaluate(() => window.prManager.getPendingCommentCount())).toBe(0);
  });

  test('the submit dialog updates edited comments after the review, never counting them as new', async ({ page, testServer }) => {
    const reviewId = await openFreshPR(page, testServer);
    const editedId = await createFileComment(page, reviewId, 'First version');
    await submit(page);
    expect((await page.request.put(`/api/reviews/${reviewId}/comments/${editedId}`, { data: { body: 'Second version' } })).ok()).toBeTruthy();
    const newId = await createFileComment(page, reviewId, 'A brand new comment');
    await reload(page);

    await page.evaluate(() => window.prManager.openReviewModal());
    const modal = page.locator('#review-modal');
    await expect(modal.locator('.review-comment-count')).toContainText('1 comment will be submitted');
    const option = modal.locator('.update-edited-comments-option');
    await expect(option).toContainText('Also update 1 edited comment on GitHub');
    await expect(option.locator('input')).toBeChecked();
    await modal.locator('#submit-review-btn-modal').click();
    await expect(modal).toBeHidden();

    await expect.poll(() => postings(testServer, editedId).map(r => r.kind)).toEqual(['post', 'update']);
    expect(postings(testServer, newId).map(r => r.kind)).toEqual(['post']);
    await expect(page.locator(`.file-comment-card[data-comment-id="${editedId}"] .posted-comment-edited`)).toHaveCount(0);
  });

  test('review history lists submissions with their comments and edits, and jumps to a comment', async ({ page, testServer }) => {
    const reviewId = await openFreshPR(page, testServer);
    const id = await createFileComment(page, reviewId, 'History original');
    await submit(page, 'APPROVE');
    expect((await page.request.put(`/api/reviews/${reviewId}/comments/${id}`, { data: { body: 'History edited' } })).ok()).toBeTruthy();
    const update = await page.request.post(`/api/reviews/${reviewId}/comments/${id}/update-on-github`);
    expect(update.ok()).toBeTruthy();
    await reload(page);

    await page.locator('#split-button-dropdown-toggle').click();
    await page.getByRole('menuitem', { name: 'Review history' }).click();
    const modal = page.locator('#review-history-modal');
    await expect(modal).toBeVisible();
    const submission = modal.locator('.review-history-submission').filter({ hasText: 'History original' });
    await expect(submission.locator('.review-history-chip').first()).toHaveText('Approved');
    await expect(submission.locator('.review-history-link').first()).toHaveAttribute('href', /pullrequestreview-/);
    const editedItem = submission.locator('.review-history-comment[data-posting-kind="update"]');
    await expect(editedItem).toContainText('History edited');
    await expect(editedItem.locator('.review-history-chip-edited')).toHaveText('edited');

    await editedItem.locator('.review-history-comment-body').click();
    await expect(modal).toBeHidden();
    await expect(page.locator(`.file-comment-card[data-comment-id="${id}"]`)).toBeInViewport();
  });
});

test.describe('local mode', () => {
  test('has no update action and no review history entry', async ({ page, testServer }) => {
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    const reviewId = await page.evaluate(() => window.prManager.currentPR?.id);
    expect(reviewId).toBeTruthy();
    const files = await page.evaluate(() => [...document.querySelectorAll('[data-file-name]')].map(el => el.dataset.fileName).filter(Boolean));
    const response = await page.request.post(`/api/reviews/${reviewId}/comments`, { data: { file: files[0], body: 'Local comment' } });
    expect(response.ok()).toBeTruthy();
    const id = (await response.json()).commentId;
    // Even a comment that somehow carries a posting must not offer an update locally
    testServer.db.prepare("INSERT INTO comment_postings (comment_id, comment_body, body, file, is_file_level) VALUES (?, 'old', 'old', ?, 1)").run(id, files[0]);
    await reload(page);

    await expect(page.locator(`[data-comment-id="${id}"]`).first()).toBeVisible();
    await expect(page.locator('.btn-update-on-host')).toHaveCount(0);
    await page.locator('#split-button-dropdown-toggle').click();
    await expect(page.locator('.split-button-menu-item[data-action="preview"]')).toBeVisible();
    await expect(page.locator('.split-button-menu-item[data-action="history"]')).toHaveCount(0);
  });
});
