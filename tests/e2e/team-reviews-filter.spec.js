// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Team Review Requests team filter
 *
 * Tests the team filter on the "Team Review Requests" tab of the home page.
 * The home page makes real GitHub-backed calls to /api/github/team-reviews
 * (GET) and /api/github/team-reviews/refresh (POST), which the test server
 * does not stub. We intercept both with page.route() to (a) avoid real
 * GitHub calls and (b) capture request URLs so we can assert whether the
 * `?team=` query parameter is present.
 */

import { test, expect } from './fixtures.js';

const MOCK_BODY = JSON.stringify({ success: true, prs: [], fetched_at: null });

/**
 * Register interception for the team-reviews GET + refresh endpoints, pushing
 * each captured URL into `urls`. Must be called BEFORE navigation/tab-click.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} urls - array to collect intercepted request URLs into
 */
async function interceptTeamReviews(page, urls) {
  await page.route('**/api/github/team-reviews**', route => {
    urls.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: MOCK_BODY
    });
  });
}

test.describe('Team Review Requests team filter', () => {
  test('valid team is applied to fetches and reveals the Clear button', async ({ page }) => {
    const urls = [];
    await interceptTeamReviews(page, urls);

    await page.goto('/');
    // Switching to the tab fires an initial GET + refresh (no team yet).
    await page.click('#unified-tab-bar [data-tab="team-reviews-tab"]');

    const input = page.locator('#team-reviews-team-input');
    await expect(input).toBeVisible();

    // The tab switch fires an initial GET + refresh (no team yet). Wait for
    // both before clearing so they cannot leak into the post-submit assertion.
    await expect.poll(() => urls.length).toBeGreaterThanOrEqual(2);
    urls.length = 0;

    await input.fill('org/platform');
    await page.click('#team-reviews-filter-apply');

    // Filtering fires both a cached GET and a refresh POST. Wait for both before
    // asserting, so a regression that drops `team` from the refresh POST (the
    // request that actually hits GitHub) can't slip through after only the GET
    // has been captured.
    await expect.poll(() => urls.length).toBeGreaterThanOrEqual(2);

    // Every captured request after submit must carry the encoded team slug.
    for (const url of urls) {
      expect(url).toContain('team=org%2Fplatform');
    }

    // Clear button becomes visible once a team is applied.
    await expect(page.locator('#team-reviews-filter-clear')).toBeVisible();
  });

  test('invalid value shows the hint and fires no team-reviews request', async ({ page }) => {
    const urls = [];
    await interceptTeamReviews(page, urls);

    await page.goto('/');
    await page.click('#unified-tab-bar [data-tab="team-reviews-tab"]');

    const input = page.locator('#team-reviews-team-input');
    await expect(input).toBeVisible();

    // The tab switch fires an initial GET + refresh. Wait for both to be
    // captured (they fire asynchronously) before clearing, so a late-arriving
    // initial call cannot pollute the post-submit assertion below.
    await expect.poll(() => urls.length).toBeGreaterThanOrEqual(2);
    urls.length = 0;

    await input.fill('foo');
    await page.click('#team-reviews-filter-apply');

    // The inline hint must become visible.
    await expect(page.locator('#team-reviews-filter-hint')).toBeVisible();
    // Input is flagged invalid.
    await expect(input).toHaveClass(/invalid/);

    // Give any (erroneous) fetch a chance to fire, then assert none did.
    await page.waitForTimeout(500);
    expect(urls).toHaveLength(0);

    // Typing again clears the invalid state and re-hides the hint.
    await input.fill('foob');
    await expect(input).not.toHaveClass(/invalid/);
    await expect(page.locator('#team-reviews-filter-hint')).toBeHidden();
  });

  test('valid team persists across reload and restores the input value', async ({ page }) => {
    const urls = [];
    await interceptTeamReviews(page, urls);

    await page.goto('/');
    await page.click('#unified-tab-bar [data-tab="team-reviews-tab"]');

    const input = page.locator('#team-reviews-team-input');
    await expect(input).toBeVisible();
    await input.fill('org/platform');
    await page.click('#team-reviews-filter-apply');

    // Confirm it was persisted before reloading.
    await expect.poll(() =>
      page.evaluate(() => localStorage.getItem('github-collection-team:team-reviews'))
    ).toBe('org/platform');

    await page.reload();

    // The team-reviews tab is restored (persisted tab choice), and the input
    // is repopulated from localStorage with the Clear button visible.
    const reloadedInput = page.locator('#team-reviews-team-input');
    await expect(reloadedInput).toHaveValue('org/platform');
    await expect(page.locator('#team-reviews-filter-clear')).toBeVisible();
  });

  test('a slow earlier team response does not overwrite a newer selection', async ({ page }) => {
    // Regression test for the async race: multiple in-flight team-reviews
    // requests write into the same state and render into the same container.
    // Without a request token, completion order alone decides which dataset
    // wins, so a slow earlier filter (org/alpha) could repaint the table after
    // a newer one (org/beta). We delay every org/alpha response so it resolves
    // last, then assert the newer org/beta selection still wins.
    const bodyFor = (number, repo, title) => JSON.stringify({
      success: true,
      fetched_at: '2025-03-0' + number + 'T00:00:00Z',
      prs: [{
        owner: 'org', repo, number, title, author: 'octocat',
        updated_at: '2025-03-0' + number + 'T00:00:00Z',
        html_url: 'https://github.com/org/' + repo + '/pull/' + number,
        state: 'open'
      }]
    });
    const ALPHA = bodyFor(1, 'alpha-repo', 'Alpha team PR');
    const BETA = bodyFor(2, 'beta-repo', 'Beta team PR');

    // Count how many org/alpha responses have actually been fulfilled (the
    // cached GET and the chained refresh POST = 2) so we can wait for the race
    // window to close deterministically instead of guessing a timeout.
    const alphaFulfilled = [];
    await page.route('**/api/github/team-reviews**', async route => {
      const url = route.request().url();
      if (url.includes('team=org%2Falpha')) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({ status: 200, contentType: 'application/json', body: ALPHA });
        alphaFulfilled.push(url);
        return;
      }
      const body = url.includes('team=org%2Fbeta') ? BETA : MOCK_BODY;
      await route.fulfill({ status: 200, contentType: 'application/json', body });
    });

    await page.goto('/');
    await page.click('#unified-tab-bar [data-tab="team-reviews-tab"]');

    const input = page.locator('#team-reviews-team-input');
    await expect(input).toBeVisible();

    // Apply the slow team first, then immediately switch to the fast team.
    await input.fill('org/alpha');
    await page.click('#team-reviews-filter-apply');
    await input.fill('org/beta');
    await page.click('#team-reviews-filter-apply');

    // The newer selection (beta) renders.
    const container = page.locator('#team-reviews-container');
    await expect(container).toContainText('Beta team PR');

    // Wait until both delayed org/alpha responses (GET + chained POST) have
    // resolved, i.e. the race window has fully closed.
    await expect.poll(() => alphaFulfilled.length).toBeGreaterThanOrEqual(2);

    // The stale alpha responses must not have clobbered the beta view.
    await expect(container).toContainText('Beta team PR');
    await expect(container).not.toContainText('Alpha team PR');
  });

  test('unapplied draft text is discarded on tab re-entry; the applied team reloads', async ({ page }) => {
    // Regression test: switchTab only toggles `.active` — it does not rebuild
    // the Team Reviews DOM — so unapplied draft text typed into the input
    // survives a tab switch. The reload path keys its fetch off the persisted
    // filter, not the live input, so without a resync the input could advertise
    // one team while the queue, row clicks, and bulk actions operate on another.
    const urls = [];
    await interceptTeamReviews(page, urls);

    await page.goto('/');
    await page.click('#unified-tab-bar [data-tab="team-reviews-tab"]');

    const input = page.locator('#team-reviews-team-input');
    await expect(input).toBeVisible();

    // Apply a valid team so it becomes the persisted/active filter.
    await input.fill('org/platform');
    await page.click('#team-reviews-filter-apply');
    // Wait for both apply fetches (cached GET + refresh POST) so none remain
    // in flight to pollute the post-re-entry assertion.
    await expect.poll(() => urls.filter(u => u.includes('team=org%2Fplatform')).length).toBeGreaterThanOrEqual(2);

    // Type draft text the user never confirms via Apply, then tab away.
    await input.fill('org/decoy');
    await page.click('#unified-tab-bar [data-tab="pr-tab"]');

    // Only inspect the re-entry fetches.
    urls.length = 0;
    await page.click('#unified-tab-bar [data-tab="team-reviews-tab"]');

    // The input is resynced to the applied filter, NOT the abandoned draft.
    await expect(input).toHaveValue('org/platform');
    await expect(page.locator('#team-reviews-filter-clear')).toBeVisible();

    // Re-entry fetches must carry the applied team and never the discarded draft.
    await expect.poll(() => urls.length).toBeGreaterThanOrEqual(1);
    for (const url of urls) {
      expect(url).toContain('team=org%2Fplatform');
      expect(url).not.toContain('decoy');
    }
  });

  test('unapplied draft text is discarded on manual refresh; the applied team reloads', async ({ page }) => {
    // Regression test for the input-vs-stored split on the manual Refresh path:
    // refresh fetches the persisted filter, so the visible input must be
    // resynced to it rather than left showing unapplied draft text.
    const urls = [];
    await interceptTeamReviews(page, urls);

    await page.goto('/');
    await page.click('#unified-tab-bar [data-tab="team-reviews-tab"]');

    const input = page.locator('#team-reviews-team-input');
    await expect(input).toBeVisible();

    await input.fill('org/platform');
    await page.click('#team-reviews-filter-apply');
    await expect.poll(() => urls.filter(u => u.includes('team=org%2Fplatform')).length).toBeGreaterThanOrEqual(2);

    // Type draft text, then hit the manual Refresh button without applying it.
    await input.fill('org/decoy');
    urls.length = 0;
    await page.click('#refresh-team-reviews');

    // Input resyncs to the applied filter; the refresh fetch uses it.
    await expect(input).toHaveValue('org/platform');
    await expect.poll(() => urls.length).toBeGreaterThanOrEqual(1);
    for (const url of urls) {
      expect(url).toContain('team=org%2Fplatform');
      expect(url).not.toContain('decoy');
    }
  });
});
