// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: comment panel filter menu (issue #610)
 *
 * The funnel at the right of the segment row opens labeled "Show dismissed"
 * and "Show posted" options; a notice at the end of the user comment list
 * counts the comments they hide and can turn them on.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

const COMMENTS_URL = /\/api\/reviews\/\d+\/comments(\?|$)/;

/**
 * Serve the given user comments for the review (GETs only). Mocked rather than
 * seeded because the per-worker DB is shared across tests, and a posted
 * comment can only be made by submitting a review to GitHub.
 */
async function mockUserComments(page, comments) {
  await page.route(COMMENTS_URL, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, comments })
    });
  });
}

function fileComment(id, status, body) {
  return { id, status: status === 'submitted' ? 'active' : status,
    publication: status === 'submitted' ? { state: 'posted' } : null,
    body, file: 'src/utils.js', is_file_level: 1, line_start: null, side: 'RIGHT', type: 'comment' };
}

async function openUserSegment(page) {
  await page.evaluate(() => window.aiPanel?.expand());
  const userSegment = page.locator('.segment-btn[data-segment="comments"]');
  await userSegment.click();
  await expect(userSegment).toHaveClass(/active/);
}

const panelItem = (page, id) => page.locator(`.finding-item.finding-comment[data-id="${id}"]`);
const notice = (page) => page.locator('.hidden-comments-notice');

test.describe('Comment filter menu (PR mode)', () => {
  test('notice counts dismissed comments; Show and the menu toggle them', async ({ page }) => {
    await mockUserComments(page, [
      fileComment(9001, 'active', 'Still pending'),
      fileComment(9002, 'inactive', 'Dismissed earlier')
    ]);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openUserSegment(page);

    const funnel = page.locator('.comment-filter-btn');
    await expect(funnel).toBeVisible();
    await expect(funnel).not.toHaveClass(/has-active-filter/);
    await expect(panelItem(page, 9001)).toBeVisible();
    await expect(panelItem(page, 9002)).toHaveCount(0);
    await expect(notice(page)).toHaveText(/1 dismissed hidden\s*—\s*Show/);

    // Show turns on "Show dismissed"
    await notice(page).getByRole('button', { name: 'Show hidden user comments' }).click();
    await expect(panelItem(page, 9002)).toBeVisible();
    await expect(panelItem(page, 9002)).toHaveClass(/comment-item-dismissed/);
    await expect(notice(page)).toHaveCount(0);
    await expect(funnel).toHaveClass(/has-active-filter/);

    // The menu turns it off again
    await funnel.click();
    await expect(funnel).toHaveAttribute('aria-expanded', 'true');
    const showDismissed = page.getByRole('checkbox', { name: 'Show dismissed' });
    await expect(showDismissed).toBeChecked();
    await showDismissed.uncheck();
    await expect(panelItem(page, 9002)).toHaveCount(0);
    await expect(notice(page)).toBeVisible();
    await expect(funnel).not.toHaveClass(/has-active-filter/);

    // Escape closes the menu and returns focus to the funnel
    await page.keyboard.press('Escape');
    await expect(page.locator('.comment-filter-menu')).toBeHidden();
    await expect(funnel).toHaveAttribute('aria-expanded', 'false');
    await expect(funnel).toBeFocused();
  });

  test('Show dismissed reveals a dismissed posted comment without also enabling Show posted', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pair-review-hide-posted-comments', 'true'));
    await mockUserComments(page, [{ ...fileComment(9051, 'inactive', 'Dismissed after posting'), publication: { state: 'posted' } }]);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openUserSegment(page);
    await expect(notice(page)).toHaveText(/1 dismissed hidden/);
    await expect(notice(page)).not.toContainText('posted hidden');
    await page.locator('.comment-filter-btn').click();
    await page.getByRole('checkbox', { name: 'Show dismissed' }).check();
    await expect(page.getByRole('checkbox', { name: 'Show posted' })).not.toBeChecked();
    await expect(panelItem(page, 9051)).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });

  test('"Show posted" overrides the hide-after-posting preference for this review only', async ({ page }) => {
    await page.addInitScript(() => {
      // Only on the first load: the test checks what the page writes
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('pair-review-hide-posted-comments', 'true');
        sessionStorage.setItem('seeded', '1');
      }
    });
    await mockUserComments(page, [
      fileComment(9101, 'active', 'Pending'),
      fileComment(9102, 'submitted', 'Posted already')
    ]);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openUserSegment(page);

    await expect(panelItem(page, 9102)).toHaveCount(0);
    await expect(notice(page)).toHaveText(/1 posted hidden/);

    await page.locator('.comment-filter-btn').click();
    const showPosted = page.getByRole('checkbox', { name: 'Show posted' });
    await expect(showPosted).not.toBeChecked();
    await showPosted.check();
    await expect(panelItem(page, 9102)).toBeVisible();
    await expect(page.locator('.file-comment-card[data-comment-id="9102"]')).toBeVisible();
    await expect(notice(page)).toHaveCount(0);

    const storage = await page.evaluate(() => ({
      global: localStorage.getItem('pair-review-hide-posted-comments'),
      review: Object.keys(localStorage).filter(k => k.startsWith('pair-review-show-posted_'))
        .map(k => localStorage.getItem(k))
    }));
    expect(storage).toEqual({ global: 'true', review: ['true'] });

    // The override survives a reload
    await page.reload();
    await waitForDiffToRender(page);
    await openUserSegment(page);
    await expect(panelItem(page, 9102)).toBeVisible();
  });

  test('outside click closes the menu', async ({ page }) => {
    await mockUserComments(page, []);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openUserSegment(page);

    await page.locator('.comment-filter-btn').click();
    await expect(page.locator('.comment-filter-menu')).toBeVisible();
    await page.locator('#findings-list').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.comment-filter-menu')).toBeHidden();
  });
});

test.describe('Comment filter menu (Local mode)', () => {
  test('has "Show dismissed" but no "Show posted"', async ({ page }) => {
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    await page.evaluate(() => window.aiPanel?.expand());

    await page.locator('.comment-filter-btn').click();
    await expect(page.getByRole('checkbox', { name: 'Show dismissed' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Show posted' })).toHaveCount(0);
  });
});
