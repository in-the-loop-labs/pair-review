// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

test('shows exact transformed text and sends the preview token only after review', async ({ page }) => {
  const requests = [];
  await page.route('**/submit-review', async route => {
    const request = route.request().postDataJSON();
    requests.push(request);
    await route.fulfill({ json: request.publicationToken
      ? { success: true, github_url: 'https://github.com/test-owner/test-repo/pull/1#review', comments_submitted: 1 }
      : { previewRequired: true, publicationToken: 'preview-token',
          target: { repository: 'test-owner/test-repo', number: 1 },
          headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), event: request.event,
          body: 'Public summary', comments: [{ id: 1, path: 'src/a.js', line: 2, side: 'RIGHT', body: 'Public finding <img src=x onerror=alert(1)>' }],
          omittedComments: 1 } });
  });
  await page.goto('/pr/test-owner/test-repo/1');
  await waitForDiffToRender(page);
  await page.evaluate(() => window.reviewModal.show());
  await page.locator('#review-body-modal').fill('Private working summary');
  await page.locator('#submit-review-btn-modal').click();
  await expect(page.locator('#publication-preview')).toBeVisible();
  await expect(page.locator('#publication-text')).toContainText('Public finding');
  await expect(page.locator('#publication-text')).not.toContainText('Private');
  await expect(page.locator('#publication-text img')).toHaveCount(0);
  await expect(page.locator('#publication-omitted')).toContainText('1 comment(s) omitted');
  expect(requests).toHaveLength(1);
  expect(requests[0].publicationToken).toBeUndefined();
  await page.getByRole('button', { name: 'Publish reviewed comments' }).click();
  await expect(page.locator('#review-modal')).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[1].publicationToken).toBe('preview-token');
});

test('editing the summary invalidates the preview and requires preparation again', async ({ page }) => {
  const requests = [];
  await page.route('**/submit-review', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { previewRequired: true, publicationToken: 'preview-token',
      target: { repository: 'test-owner/test-repo', number: 1 }, headSha: 'a'.repeat(40), event: 'COMMENT',
      body: 'Public summary', comments: [], omittedComments: 0 } });
  });
  await page.goto('/pr/test-owner/test-repo/1');
  await waitForDiffToRender(page);
  await page.evaluate(() => window.reviewModal.show());
  await page.locator('#review-body-modal').fill('First draft');
  await page.locator('#submit-review-btn-modal').click();
  await expect(page.locator('#publication-preview')).toBeVisible();
  await page.locator('#review-body-modal').fill('Edited draft');
  await expect(page.locator('#publication-preview')).toBeHidden();
  await page.locator('#submit-review-btn-modal').click();
  await expect(page.locator('#publication-preview')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1].publicationToken).toBeUndefined();
});
