// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Stale PR Badge
 *
 * Tests the header badge that indicates when local PR data is outdated
 * compared to GitHub, and the auto-refresh / manual-refresh behaviors.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

test.describe('Stale PR Badge', () => {
  test('badge is hidden when PR is not stale', async ({ page }) => {
    // Default mock returns isStale: false — badge should stay hidden
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const badge = page.locator('#stale-badge');
    await expect(badge).toBeHidden();
  });

  test('badge appears when PR is stale and session has data', async ({ page }) => {
    // Override check-stale to return stale
    await page.route('**/api/pr/test-owner/test-repo/1/check-stale', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isStale: true, prState: 'open', merged: false })
      });
    });

    // Override suggestions/check to indicate analysis has run (session data exists)
    await page.route('**/api/reviews/*/suggestions/check', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hasSuggestions: true, analysisHasRun: true })
      });
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const badge = page.locator('#stale-badge');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.stale-badge-text')).toHaveText('STALE');
  });

  test('auto-refreshes silently when stale and no session data', async ({ page }) => {
    let refreshCalled = false;

    // Override check-stale to return stale
    await page.route('**/api/pr/test-owner/test-repo/1/check-stale', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isStale: true, prState: 'open', merged: false })
      });
    });

    // Override suggestions/check to indicate no analysis (no session data)
    await page.route('**/api/reviews/*/suggestions/check', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hasSuggestions: false, analysisHasRun: false })
      });
    });

    // Override comments to return empty (no user comments)
    await page.route('**/api/reviews/*/comments', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, comments: [] })
      });
    });

    // Track refresh calls
    await page.route('**/api/pr/test-owner/test-repo/1/refresh', route => {
      refreshCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { owner: 'test-owner', repo: 'test-repo', number: 1, title: 'Test PR for E2E', id: 1 } })
      });
    });

    const refreshPromise = page.waitForRequest("**/api/pr/test-owner/test-repo/1/refresh");
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await refreshPromise;

    // Badge should NOT appear (silent refresh)
    const badge = page.locator('#stale-badge');
    await expect(badge).toBeHidden();

    // Refresh should have been triggered
    expect(refreshCalled).toBe(true);
  });

  test('shows MERGED badge for merged PR', async ({ page }) => {
    await page.route('**/api/pr/test-owner/test-repo/1/check-stale', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isStale: false, prState: 'closed', merged: true })
      });
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const badge = page.locator('#stale-badge');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.stale-badge-text')).toHaveText('MERGED');
    await expect(badge).toHaveClass(/pr-merged/);
  });

  test('shows CLOSED badge for closed PR', async ({ page }) => {
    await page.route('**/api/pr/test-owner/test-repo/1/check-stale', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isStale: false, prState: 'closed', merged: false })
      });
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const badge = page.locator('#stale-badge');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.stale-badge-text')).toHaveText('CLOSED');
    await expect(badge).toHaveClass(/pr-closed/);
  });
});
