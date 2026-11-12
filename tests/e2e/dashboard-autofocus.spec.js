// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Dashboard input autofocus
 *
 * On load, the dashboard focuses the input of the restored tab so a review can
 * be started by pasting and pressing Enter, in both PR mode (PR URL input) and
 * Local mode (directory path input).
 */

import { test, expect } from './fixtures.js';

/** Serve an empty review list so the first-time help modal opens on load. */
async function interceptEmptyRecentReviews(page) {
  await page.route('**/api/worktrees/recent**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, reviews: [], hasMore: false })
  }));
}

test.describe('Dashboard autofocus', () => {
  test('focuses the PR URL input on load when the Pull Requests tab is active', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('#pr-url-input')).toBeFocused();
  });

  test('focuses the directory path input on load when the Local Reviews tab is restored', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pair-review-active-tab', 'local-tab');
    });

    await page.goto('/');

    await expect(page.locator('#local-path-input')).toBeFocused();
  });

  test('keeps focus on an element the user focused while the page was loading', async ({ page }) => {
    let releaseConfig;
    const configHeld = new Promise((resolve) => { releaseConfig = resolve; });
    const tabButton = page.locator('#unified-tab-bar [data-tab="my-prs-tab"]');

    await page.route('**/api/config', async (route) => {
      await configHeld;
      await route.continue();
    });
    await page.goto('/');
    await tabButton.focus();

    // Recent reviews are requested right after the restored tab is focused.
    const recentReviewsRequested = page.waitForRequest('**/api/worktrees/recent**');
    releaseConfig();
    await recentReviewsRequested;

    await expect(tabButton).toBeFocused();
  });

  test('moves focus into the help modal when it opens for a first-time user', async ({ page }) => {
    await interceptEmptyRecentReviews(page);

    await page.goto('/');

    await expect(page.locator('#help-modal-overlay')).toHaveClass(/visible/);
    await expect(page.locator('#help-modal-close')).toBeFocused();
  });

  test('returns focus to the PR URL input when the first-time help modal closes', async ({ page }) => {
    await interceptEmptyRecentReviews(page);
    await page.goto('/');
    await expect(page.locator('#help-modal-close')).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.locator('#help-modal-overlay')).not.toHaveClass(/visible/);
    await expect(page.locator('#pr-url-input')).toBeFocused();
  });
});
