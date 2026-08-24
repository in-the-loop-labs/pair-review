// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: host-aware repository links on the main dashboard
 *
 * Closes the producer/consumer loop for the dashboard row contract. The server
 * side (field names and values) is asserted in
 * tests/integration/github-collections.test.js and
 * tests/integration/worktree-pagination.test.js; these tests confirm the real
 * browser reads those exact fields and that a row's action icon and its click
 * resolve to the SAME system.
 *
 * `/api/github/review-requests` and `/api/worktrees/recent` are intercepted at
 * the Playwright network layer with the payload shape those integration tests
 * pin, because the test server has no `repos` configuration of its own.
 */

import { test, expect } from './fixtures.js';

const METEORITE_API = 'https://meteorite.example/api/v3';

/** Intercept the review-requests collection (cached GET + refresh POST). */
async function interceptReviewRequests(page, prs) {
  await page.route('**/api/github/review-requests**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, prs, fetched_at: new Date().toISOString() })
    });
  });
}

/** Open the dashboard and switch to the "My Review Requests" tab. */
async function openReviewRequestsTab(page) {
  await page.goto('/');
  await page.click('#unified-tab-bar [data-tab="review-requests-tab"]');
  return page.locator('#review-requests-tbody tr.collection-pr-row');
}

test.describe('Dashboard repository links', () => {
  test('a dual-host github.com row opens github for both its icon and its click', async ({ page }) => {
    await interceptReviewRequests(page, [{
      owner: 'shop',
      repo: 'world',
      number: 41,
      title: 'A github.com PR',
      author: 'alice',
      updated_at: new Date().toISOString(),
      html_url: 'https://github.com/shop/world/pull/41',
      state: 'open',
      host: null,
      // Server-resolved: a dual repo has a github.com binding, so the sentinel
      // is emitted and the alt-host external link is suppressed.
      setup_host: 'github',
      repo_links: { external: null, github: true, graphite: true }
    }]);

    const row = await openReviewRequestsTab(page);
    await expect(row).toHaveCount(1);

    // The row echoes the server's setup host verbatim.
    await expect(row).toHaveAttribute('data-host', 'github');

    // The action icon points at github.com, matching that binding.
    const action = row.locator('a.btn-github-link[title="Open on GitHub"]');
    await expect(action).toHaveAttribute('href', 'https://github.com/shop/world/pull/41');
    await expect(row.locator('a[title="Open on Meteorite"]')).toHaveCount(0);

    // Clicking the row navigates to the PR route carrying the same host.
    await row.click();
    await expect(page).toHaveURL(/\/pr\/shop\/world\/41\?host=github/);
  });

  test('an alt-host row opens the alt host for both its icon and its click', async ({ page }) => {
    await interceptReviewRequests(page, [{
      owner: 'shop',
      repo: 'world',
      number: 42,
      title: 'A Meteorite PR',
      author: 'alice',
      updated_at: new Date().toISOString(),
      html_url: 'https://meteorite.example/shop/world/pull/42',
      state: 'open',
      host: METEORITE_API,
      setup_host: METEORITE_API,
      repo_links: {
        external: {
          name: 'Meteorite',
          label: 'Open on Meteorite',
          url_template: 'https://meteorite.example/{owner}/{repo}/pull/{number}',
          icon: null
        },
        github: false,
        graphite: false
      }
    }]);

    const row = await openReviewRequestsTab(page);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-host', METEORITE_API);

    const external = row.locator('a[title="Open on Meteorite"]');
    await expect(external).toHaveAttribute('href', 'https://meteorite.example/shop/world/pull/42');
    await expect(row.locator('a[title="Open on GitHub"]')).toHaveCount(0);

    await row.click();
    await expect(page).toHaveURL(
      new RegExp('/pr/shop/world/42\\?host=' + encodeURIComponent(METEORITE_API).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });

  test('a hostile PR title cannot inject attributes into a dashboard row', async ({ page }) => {
    await interceptReviewRequests(page, [{
      owner: 'shop',
      repo: 'world',
      number: 43,
      title: 'Fix " onmouseover="window.__pwned = 1" crash',
      author: 'alice',
      updated_at: new Date().toISOString(),
      html_url: 'https://github.com/shop/world/pull/43',
      state: 'open',
      host: null,
      setup_host: 'github',
      repo_links: { external: null, github: true, graphite: true }
    }]);

    const row = await openReviewRequestsTab(page);
    const titleCell = row.locator('td.col-title');
    await expect(titleCell).toHaveCount(1);

    // The whole hostile string stays inside the title attribute...
    await expect(titleCell).toHaveAttribute(
      'title',
      'Fix " onmouseover="window.__pwned = 1" crash'
    );
    // ...and no event handler was created from it.
    expect(await titleCell.evaluate(el => el.getAttribute('onmouseover'))).toBeNull();
    await titleCell.hover();
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });
});
