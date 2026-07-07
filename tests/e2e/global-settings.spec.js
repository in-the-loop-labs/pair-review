// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Global Settings Page
 *
 * Covers the /settings page:
 * - Loads and shows a setting with a `default` (not-explicitly-set) badge
 * - Toggling a boolean persists across reload with an `in-app` badge
 * - Reset reverts the badge back to `default`
 * - A configured repository appears in the Repositories section and navigates
 * - The landing-page gear button navigates to /settings
 *
 * NOTE: These tests require the global settings backend to be wired into the
 * per-worker E2E server (tests/e2e/test-server.js): the `global_settings`
 * table in the shared schema, the `src/routes/settings.js` router mounted, and
 * the `GET /settings` HTML page route. They will fail until the backend agent's
 * work is present and the E2E server mounts it.
 */

import { test, expect } from './fixtures.js';

// A boolean setting that ships disabled by default (source = default) and is
// dynamic/editable, so we can toggle it and reset it deterministically.
const BOOLEAN_KEY = 'summaries.enabled';

/**
 * Seed a repository with user-facing DB settings via the existing repo
 * settings endpoint so it shows up as "configured" in the Repositories list.
 */
async function seedConfiguredRepo(page, owner = 'test-owner', repo = 'test-repo') {
  await page.goto('/');
  const ok = await page.evaluate(async ({ owner, repo }) => {
    const response = await fetch(`/api/repos/${owner}/${repo}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_instructions: 'Seeded for global settings e2e' })
    });
    return response.ok;
  }, { owner, repo });
  expect(ok).toBe(true);
}

test.describe('Global Settings - Page load', () => {
  test('loads and shows a setting with a default badge', async ({ page }) => {
    await page.goto('/settings');

    const row = page.locator(`.setting-row[data-key="${BOOLEAN_KEY}"]`);
    await expect(row).toBeVisible({ timeout: 5000 });

    // Not explicitly set anywhere → default badge.
    const badge = row.locator('[data-role="badge"]');
    await expect(badge).toHaveText('default');
    await expect(badge).toHaveClass(/source-badge--default/);

    // No reset button when the value comes from a default.
    await expect(row.locator('[data-role="reset"]')).toBeHidden();
  });
});

test.describe('Global Settings - Toggle + persist + reset', () => {
  test('toggling a boolean persists after reload with an in-app badge', async ({ page }) => {
    await page.goto('/settings');

    const row = page.locator(`.setting-row[data-key="${BOOLEAN_KEY}"]`);
    await expect(row).toBeVisible({ timeout: 5000 });

    const toggle = row.locator('[data-role="control"]');
    await expect(toggle).not.toBeChecked();

    // Toggle on → immediate PUT. The checkbox is visually hidden behind a
    // custom slider, so click the label to flip it.
    await row.locator('.toggle').click();

    // Badge should flip to in-app once the PUT response comes back.
    const badge = row.locator('[data-role="badge"]');
    await expect(badge).toHaveText('in-app', { timeout: 5000 });
    await expect(row.locator('[data-role="reset"]')).toBeVisible();

    // Reload — the override persists in the DB.
    await page.reload();
    const rowAfter = page.locator(`.setting-row[data-key="${BOOLEAN_KEY}"]`);
    await expect(rowAfter).toBeVisible({ timeout: 5000 });
    await expect(rowAfter.locator('[data-role="control"]')).toBeChecked();
    await expect(rowAfter.locator('[data-role="badge"]')).toHaveText('in-app');
  });

  test('reset returns the badge to default', async ({ page }) => {
    await page.goto('/settings');

    const row = page.locator(`.setting-row[data-key="${BOOLEAN_KEY}"]`);
    await expect(row).toBeVisible({ timeout: 5000 });

    // Ensure there is an in-app override to reset (idempotent if already set).
    const toggle = row.locator('[data-role="control"]');
    if (!(await toggle.isChecked())) {
      await row.locator('.toggle').click();
      await expect(row.locator('[data-role="badge"]')).toHaveText('in-app', { timeout: 5000 });
    }

    // Reset clears the override.
    await row.locator('[data-role="reset"]').click();

    await expect(row.locator('[data-role="badge"]')).toHaveText('default', { timeout: 5000 });
    await expect(row.locator('[data-role="control"]')).not.toBeChecked();
    await expect(row.locator('[data-role="reset"]')).toBeHidden();
  });
});

test.describe('Global Settings - Repositories', () => {
  test('lists a configured repo and navigates to its settings page', async ({ page }) => {
    await seedConfiguredRepo(page, 'test-owner', 'test-repo');

    await page.goto('/settings');

    const reposSection = page.locator('#repos-section');
    await expect(reposSection).toBeVisible({ timeout: 5000 });

    const repoRow = page.locator('.repo-row', { hasText: 'test-owner/test-repo' });
    await expect(repoRow).toBeVisible();
    await expect(repoRow.locator('.repo-badge--configured')).toBeVisible();

    await repoRow.click();
    await expect(page).toHaveURL(/\/settings\/test-owner\/test-repo$/);
  });
});

test.describe('Global Settings - Section navigation', () => {
  test('sidebar lists the rendered sections plus Repositories', async ({ page }) => {
    await page.goto('/settings');

    const navList = page.locator('#settings-nav-list');
    // Nav is built after settings + repos load.
    await expect(navList.locator('.settings-nav-item').first()).toBeVisible({ timeout: 5000 });

    // Known-present setting groups + the Repositories section.
    await expect(navList.locator('.settings-nav-item', { hasText: 'General' })).toBeVisible();
    await expect(navList.locator('.settings-nav-item', { hasText: 'Summaries' })).toBeVisible();
    await expect(navList.locator(`.settings-nav-item[data-target="repos-section"]`)).toBeVisible();

    // Every nav item points at a section that exists on the page.
    const targets = await navList.locator('.settings-nav-item').evaluateAll(
      els => els.map(el => el.dataset.target)
    );
    expect(targets.length).toBeGreaterThan(1);
    for (const id of targets) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }
  });

  test('first item is active on load', async ({ page }) => {
    await page.goto('/settings');
    const firstItem = page.locator('#settings-nav-list .settings-nav-item').first();
    await expect(firstItem).toBeVisible({ timeout: 5000 });
    await expect(firstItem).toHaveClass(/is-active/);
  });

  test('clicking a nav item scrolls its section into view and activates it', async ({ page }) => {
    await page.goto('/settings');

    // Repositories is the last section, so scrolling to it is an unambiguous move.
    const reposItem = page.locator('#settings-nav-list .settings-nav-item[data-target="repos-section"]');
    await expect(reposItem).toBeVisible({ timeout: 5000 });

    // Not in view at the top of a long page.
    await expect(page.locator('#repos-section')).not.toBeInViewport();

    await reposItem.click();

    await expect(page.locator('#repos-section')).toBeInViewport({ timeout: 5000 });
    await expect(reposItem).toHaveClass(/is-active/);

    // Exactly one active item at a time.
    await expect(page.locator('#settings-nav-list .settings-nav-item.is-active')).toHaveCount(1);
  });

  test('scrollspy activates the section scrolled into view', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('#settings-nav-list .settings-nav-item').first()).toBeVisible({ timeout: 5000 });

    // Scroll to the bottom; the last nav item (Repositories) should become active
    // via the bottom guard.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    const reposItem = page.locator('#settings-nav-list .settings-nav-item[data-target="repos-section"]');
    await expect(reposItem).toHaveClass(/is-active/, { timeout: 5000 });
    await expect(page.locator('#settings-nav-list .settings-nav-item.is-active')).toHaveCount(1);
  });
});

test.describe('Global Settings - Sidebar stickiness', () => {
  // Regression: the section nav used position:sticky but an ancestor scroll/clip
  // container (overflow-x:hidden on <body>) made it scroll away with the page.
  // On desktop widths the sidebar must stay fully inside the viewport at every
  // scroll position.
  test('sidebar stays fully in the viewport when scrolled to the last section', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/settings');

    const sidebar = page.locator('.settings-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#settings-nav-list .settings-nav-item').first()).toBeVisible({ timeout: 5000 });

    // Scroll all the way to the last section (Repositories).
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    // The sidebar's box must be fully within the viewport (poll on geometry so
    // this is deterministic without fixed sleeps).
    await expect.poll(async () => {
      const box = await sidebar.boundingBox();
      const winH = await page.evaluate(() => window.innerHeight);
      return box && box.y >= 0 && box.y + box.height <= winH;
    }, { timeout: 5000 }).toBe(true);

    // The active nav item must be on-screen too, not clipped above the fold.
    const active = page.locator('#settings-nav-list .settings-nav-item.is-active');
    await expect(active).toHaveCount(1);
    await expect(active).toBeInViewport();
  });

  test('chip bar stays sticky below the two-column threshold', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto('/settings');

    const sidebar = page.locator('.settings-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#settings-nav-list .settings-nav-item').first()).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    // The chip bar must remain pinned near the top of the viewport (below the
    // sticky header), not scroll off with the content.
    await expect.poll(async () => {
      const box = await sidebar.boundingBox();
      const winH = await page.evaluate(() => window.innerHeight);
      return box && box.y >= 0 && box.y < winH / 2;
    }, { timeout: 5000 }).toBe(true);
  });
});

test.describe('Global Settings - Feature badges', () => {
  test('tours section shows a Beta badge in its header and sidebar nav', async ({ page }) => {
    await page.goto('/settings');

    // Header badge on the Tours section.
    const headerBadge = page.locator('#section-tours .section-header h2 .feature-badge');
    await expect(headerBadge).toBeVisible({ timeout: 5000 });
    await expect(headerBadge).toHaveText(/beta/i);

    // Matching badge on the Tours sidebar nav item.
    const navBadge = page.locator(
      '#settings-nav-list .settings-nav-item[data-target="section-tours"] .feature-badge'
    );
    await expect(navBadge).toBeVisible();
    await expect(navBadge).toHaveText(/beta/i);
  });
});

test.describe('Global Settings - Navigation', () => {
  test('landing-page gear navigates to /settings', async ({ page }) => {
    await page.goto('/');

    const gear = page.locator('#settings-btn');
    await expect(gear).toBeVisible();
    await gear.click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('.page-header h1')).toHaveText('Global Settings');
  });
});
