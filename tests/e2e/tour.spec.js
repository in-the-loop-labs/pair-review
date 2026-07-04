// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Guided Tour UI (Phase 8)
 *
 * Verifies the inline tour-stop annotations + sticky top tour bar end to end:
 *   - Toolbar tour button stays hidden when tours.enabled=false
 *   - When `tours.enabled` is true, the button becomes visible
 *     (visibility is decoupled from `summaries.enabled` on the client;
 *     the server still gates tour generation on the summaries dependency)
 *   - Clicking the button mounts the bar and the first stop annotation
 *   - Next/Prev (button or keyboard) advance / rewind the active stop
 *   - Advancing past the last stop flips the bar into Restart/Close chrome
 *   - Escape exits the tour and restores summary visibility
 *
 * Tests run in BOTH PR mode and Local mode (CLAUDE.md parity requirement).
 * /api/config and /api/reviews/:id/tour are mocked via page.route(); the
 * test DB is not modified.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

const PR_REVIEW_ID = 1;
const PR_PATH = '/pr/test-owner/test-repo/1';
const LOCAL_REVIEW_ID = 2;
const LOCAL_PATH = '/local/2';

const MODES = [
  { name: 'PR mode', path: PR_PATH, reviewId: PR_REVIEW_ID },
  { name: 'Local mode', path: LOCAL_PATH, reviewId: LOCAL_REVIEW_ID },
];

/**
 * Three stops anchored at line numbers we know exist in the fixture diff
 * (see tests/e2e/global-setup.js `generateUnifiedDiff`):
 *   - utils.js line 4 (NEW side / RIGHT) — `// Improved implementation`
 *   - utils.js line 56 (NEW side / RIGHT) — `return JSON.stringify(data);`
 *   - main.js line 12 (NEW side / RIGHT) — `// New feature: logging`
 */
const FIXED_STOPS = [
  {
    file_path: 'src/utils.js',
    side: 'RIGHT',
    line_start: 4,
    line_end: 4,
    title: 'Inline computeValue helper',
    description: 'Replaces the null-returning placeholder with a real value via computeValue().',
  },
  {
    file_path: 'src/utils.js',
    side: 'RIGHT',
    line_start: 56,
    line_end: 56,
    title: 'Serialize exported data',
    description: 'Wraps the returned data in JSON.stringify so callers always receive text.',
  },
  {
    file_path: 'src/main.js',
    side: 'RIGHT',
    line_start: 12,
    line_end: 12,
    title: 'Add log helper',
    description: 'Introduces a tagged console.log wrapper for app-level diagnostics.',
  },
];

/**
 * Mock the global app config to flip tours on. The client gates the
 * toolbar button on `tours.enabled` alone (decoupled from
 * `summaries.enabled`), but we send both flags here to mirror a typical
 * production config response.
 * @param {import('@playwright/test').Page} page
 */
async function enableToursConfig(page) {
  await page.route('**/api/config', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        theme: 'light',
        comment_button_action: 'submit',
        is_running_via_npx: false,
        enable_chat: true,
        chat_provider: 'pi',
        chat_providers: [],
        pi_available: false,
        summaries: { enabled: true },
        tours: { enabled: true },
      }),
    });
  });
}

/**
 * Mock the tour endpoint to return our fixed 3-stop tour. Empty summaries
 * are still mocked so the page doesn't try to render anything else.
 */
async function mockTourEndpoint(page, stops = FIXED_STOPS, generating = false) {
  await page.route('**/api/reviews/*/tour', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        tour: stops
          ? {
              stops,
              diff_hash: 'mock-hash',
              stale: false,
              provider: 'mock',
              model: 'mock',
              created_at: new Date().toISOString(),
            }
          : null,
        generating,
      }),
    });
  });
  await page.route('**/api/reviews/*/hunk-summaries', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ summaries: [], generating: false }),
    });
  });
}

for (const mode of MODES) {
  test.describe(`Guided Tour UI (${mode.name})`, () => {
    test.beforeEach(async ({ page, context }) => {
      await context.clearCookies();
      await page.goto('about:blank');
      await page.evaluate(() => {
        try { window.localStorage.clear(); } catch {}
      });
    });

    test('tour toggle is hidden when tours are disabled', async ({ page }) => {
      // Default config (no tours.enabled) → button stays display:none.
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await expect(page.locator('#tour-toggle-btn')).toBeHidden();
    });

    test('opens the tour bar with "Stop 1 of 3" and mounts the first stop', async ({ page }) => {
      await enableToursConfig(page);
      await mockTourEndpoint(page);

      await page.goto(mode.path);
      await waitForDiffToRender(page);

      const toggle = page.locator('#tour-toggle-btn');
      await expect(toggle).toBeVisible();
      await toggle.click();

      // Bar appears, progress shows "Stop 1 of 3".
      const bar = page.locator('.tour-bar');
      await expect(bar).toBeVisible();
      await expect(bar.locator('.tour-bar__progress')).toHaveText('Stop 1 of 3');

      // First stop annotation is mounted in the right file.
      const stopRow = page.locator('.tour-annotation-row[data-stop-index="0"]');
      await expect(stopRow).toBeVisible();
      await expect(stopRow.locator('.tour-annotation-title'))
        .toHaveText(FIXED_STOPS[0].title);
      await expect(stopRow.locator('.tour-annotation-description'))
        .toHaveText(FIXED_STOPS[0].description);

      // body.tour-active is set.
      await expect(page.locator('body')).toHaveClass(/tour-active/);
    });

    test('Next button advances to stop 2', async ({ page }) => {
      await enableToursConfig(page);
      await mockTourEndpoint(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await page.locator('#tour-toggle-btn').click();

      const bar = page.locator('.tour-bar');
      await expect(bar.locator('.tour-bar__progress')).toHaveText('Stop 1 of 3');

      await bar.locator('.tour-bar__next').click();
      await expect(bar.locator('.tour-bar__progress')).toHaveText('Stop 2 of 3');

      const stop2 = page.locator('.tour-annotation-row[data-stop-index="1"]');
      await expect(stop2).toBeVisible();
      await expect(stop2).toHaveClass(/active-stop/);
    });

    test('ArrowRight key advances to the next stop', async ({ page }) => {
      await enableToursConfig(page);
      await mockTourEndpoint(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await page.locator('#tour-toggle-btn').click();

      // Click resolves before startOrToggleTour's async chain finishes
      // registering the keyboard handler. Wait for the bar to be in its
      // open state ("Stop 1 of 3") before pressing keys.
      const bar = page.locator('.tour-bar');
      await expect(bar.locator('.tour-bar__progress')).toHaveText('Stop 1 of 3');

      await page.keyboard.press('ArrowRight');
      await expect(bar.locator('.tour-bar__progress')).toHaveText('Stop 2 of 3');
      await page.keyboard.press('ArrowRight');
      await expect(bar.locator('.tour-bar__progress')).toHaveText('Stop 3 of 3');
    });

    test('past last stop the bar shows Restart/Close (completion state)', async ({ page }) => {
      await enableToursConfig(page);
      await mockTourEndpoint(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await page.locator('#tour-toggle-btn').click();

      const bar = page.locator('.tour-bar');
      // Wait for bar to fully open before driving Next clicks.
      await expect(bar.locator('.tour-bar__progress')).toHaveText('Stop 1 of 3');

      // Three stops -> press Next three times to land in completion state.
      await bar.locator('.tour-bar__next').click(); // 2/3
      await bar.locator('.tour-bar__next').click(); // 3/3
      await bar.locator('.tour-bar__next').click(); // completion

      await expect(bar.locator('.tour-bar__restart')).toBeVisible();
      await expect(bar.locator('.tour-bar__close')).toBeVisible();
      await expect(bar.locator('.tour-bar__next')).toBeHidden();
      await expect(bar.locator('.tour-bar__progress')).toContainText('complete');
    });

    test('long description shows a Show more toggle that expands and collapses', async ({ page }) => {
      await enableToursConfig(page);
      // Build a stop with a deliberately long description so the
      // line-clamp triggers the overflow probe. ~700 chars is well past
      // what fits in the 3-line clamp at the annotation's font size.
      const LONG_DESC =
        'This stop deserves a longer explanation because the surrounding code carries a lot of subtle invariants that only become visible when you read through every branch carefully and consider what would happen if a caller passes unexpected inputs. ' +
        'The reviewer should pay particular attention to the error-handling path, where a silent swallow could mask a real upstream bug. ' +
        'The change touches both the happy path and the rollback path, so make sure each is exercised by a test before approving. ' +
        'Extra context follows so the description actually overflows the three-line clamp regardless of viewport width.';
      const longStops = [
        {
          ...FIXED_STOPS[0],
          description: LONG_DESC,
        },
        FIXED_STOPS[1],
        FIXED_STOPS[2],
      ];
      await mockTourEndpoint(page, longStops);

      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await page.locator('#tour-toggle-btn').click();

      const stopRow = page.locator('.tour-annotation-row[data-stop-index="0"]');
      await expect(stopRow).toBeVisible();

      const wrap = stopRow.locator('.tour-annotation-description-wrap');
      const btn = stopRow.locator('.tour-annotation-show-more-btn');

      // The overflow probe runs on the next rAF after mount; allow Playwright's
      // auto-waiting to find the button once it appears.
      await expect(btn).toBeVisible();
      await expect(btn).toHaveText('Show more');
      await expect(wrap).not.toHaveClass(/expanded/);

      // Expand.
      await btn.click();
      await expect(wrap).toHaveClass(/expanded/);
      await expect(btn).toHaveText('Show less');

      // Collapse again.
      await btn.click();
      await expect(wrap).not.toHaveClass(/expanded/);
      await expect(btn).toHaveText('Show more');
    });

    test('Escape exits the tour and restores normal view', async ({ page }) => {
      await enableToursConfig(page);
      await mockTourEndpoint(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await page.locator('#tour-toggle-btn').click();

      // Wait for the bar to fully open (handler registration is part of
      // the same async chain).
      const bar = page.locator('.tour-bar');
      await expect(bar.locator('.tour-bar__progress')).toHaveText('Stop 1 of 3');
      await expect(page.locator('body')).toHaveClass(/tour-active/);

      await page.keyboard.press('Escape');

      await expect(page.locator('.tour-bar')).toHaveCount(0);
      await expect(page.locator('.tour-annotation-row')).toHaveCount(0);
      await expect(page.locator('body')).not.toHaveClass(/tour-active/);
    });
  });
}
