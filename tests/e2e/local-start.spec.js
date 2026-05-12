// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';

test.describe('Local Review Start', () => {
  test('rejects URL input immediately without navigating', async ({ page }) => {
    await page.goto('/');
    await page.click('#unified-tab-bar [data-tab="local-tab"]');

    const input = page.locator('#local-path-input');
    const error = page.locator('#start-review-error-local');
    await input.fill('https://github.com/test-owner/test-repo/pull/1');

    await expect(error).toBeVisible();
    await expect(error).toContainText('filesystem path');

    const currentUrl = page.url();
    await page.click('#start-local-btn');

    await expect(page).toHaveURL(currentUrl);
    await expect(error).toContainText('filesystem path');
  });
});
