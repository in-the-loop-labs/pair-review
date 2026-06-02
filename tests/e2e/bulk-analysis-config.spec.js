// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';

const collectionPrs = [
  {
    owner: 'test-owner',
    repo: 'test-repo',
    number: 1,
    title: 'First review request',
    author: 'alice',
    updated_at: new Date().toISOString(),
    html_url: 'https://github.com/test-owner/test-repo/pull/1'
  },
  {
    owner: 'test-owner',
    repo: 'test-repo',
    number: 2,
    title: 'Second review request',
    author: 'bob',
    updated_at: new Date().toISOString(),
    html_url: 'https://github.com/test-owner/test-repo/pull/2'
  }
];

test('bulk Analyze opens analysis config modal and applies the config to all selected PRs', async ({ page }) => {
  let storedConfigBody = null;
  let bulkOpenBody = null;

  await page.route('**/api/github/review-requests**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prs: collectionPrs, fetched_at: new Date().toISOString() })
    });
  });

  await page.route('**/api/bulk-analysis-configs', async route => {
    storedConfigBody = route.request().postDataJSON();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, id: 'bulk-config-id', expiresInMs: 1800000 })
    });
  });

  await page.route('**/api/bulk-open', async route => {
    bulkOpenBody = route.request().postDataJSON();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, opened: 2 })
    });
  });

  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');

  await page.click('#unified-tab-bar [data-tab="review-requests-tab"]');
  await expect(page.locator('#review-requests-tbody .collection-pr-row')).toHaveCount(2);

  await page.click('[data-selection-tab="review-requests-tab"]');
  await page.check('#review-requests-container .select-all-checkbox');
  await page.click('.btn-bulk-analyze');

  await expect(page.locator('#analysis-config-modal')).toBeVisible();
  await page.fill('#custom-instructions', 'Use this prompt for every selected PR.');
  await page.click('#analysis-config-modal [data-action="submit"]');

  await expect.poll(() => storedConfigBody).not.toBeNull();
  expect(storedConfigBody.analysisConfig).toMatchObject({
    provider: 'claude',
    model: 'sonnet',
    customInstructions: 'Use this prompt for every selected PR.'
  });

  await expect.poll(() => bulkOpenBody).not.toBeNull();
  expect(bulkOpenBody.urls).toEqual([
    '/pr/test-owner/test-repo/1?analyze=true&analysisConfigId=bulk-config-id',
    '/pr/test-owner/test-repo/2?analyze=true&analysisConfigId=bulk-config-id'
  ]);
});
