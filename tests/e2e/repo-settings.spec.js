// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Repository Settings Page
 *
 * Covers the /settings/:owner/:repo page:
 * - The page's own toasts (repo-settings.css, revealed with `.show`) become
 *   opaque and slide fully on-screen. Toast.js's shared rules in toast.css
 *   (`.toast { opacity: 0 }`, centered container) must not reach this page.
 */

import { test, expect } from './fixtures.js';

test.describe('Repo Settings - Toast', () => {
  // The provider load this test makes fail: the browser reports the 500 and
  // the page logs the failure it then shows as the toast.
  test.use({ expectedConsoleErrors: [
    /\[console\.error\] (Failed to load resource: the server responded with a status of 500 .*\/api\/providers|Error loading providers: Error: Failed to fetch providers)/
  ] });

  test('error toast slides fully on-screen and is opaque', async ({ page }) => {
    // A failed provider load is the one toast the page raises on its own
    // during startup, with no writes to the shared worker database.
    await page.route('**/api/providers', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'boom' })
    }));

    await page.goto('/settings/test-owner/test-repo');

    const toast = page.locator('#toast-container .toast.error');
    await expect(toast).toContainText('Failed to load AI providers');

    // toBeVisible() passes at opacity 0 and off-screen, so check both.
    await expect.poll(() => toast.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const viewport = page.viewportSize();
    await expect.poll(async () => {
      const box = await toast.boundingBox();
      return box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0;
    }).toBe(true);
  });
});
