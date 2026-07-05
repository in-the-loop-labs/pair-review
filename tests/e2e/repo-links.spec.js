// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Per-repo header link customisation (Phase 7 alt-host support)
 *
 * Verifies the frontend correctly:
 *   - Inserts an "external" anchor in the header when one is configured
 *   - Substitutes whitelisted placeholders in the URL template
 *   - Hides #github-link when links.github === false
 *   - Hides #graphite-link when links.graphite === false
 *   - Leaves default behaviour intact when no `links` block is present
 *
 * The /api/repos/:owner/:repo/links endpoint is intercepted at the
 * Playwright network layer so the test does not depend on the test
 * server having `repos` configured. The route glob ends in `links**`
 * (not just `links`) because PR mode appends a `?number=<n>` query so the
 * server can resolve the link set against the PR's host for dual-host repos.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

test.describe('Repo Links UI', () => {
  test('inserts external link with substituted URL and hides built-in links', async ({ page }) => {
    // Capture the URL the browser hits so we can assert later that the
    // owner/repo match what the page is showing.
    let fetchedUrl = null;

    await page.route('**/api/repos/*/*/links**', (route) => {
      fetchedUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: 'test-owner/test-repo',
          links: {
            external: {
              label: 'Open on AltHost',
              url_template: 'https://althost.example/{owner}/{repo}/pull/{number}',
              icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h14v14H1z" data-test-icon="external"/></svg>',
            },
            github: false,
            graphite: false,
          },
        }),
      });
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // The endpoint should have been called with the test-owner/test-repo.
    expect(fetchedUrl).toContain('/api/repos/test-owner/test-repo/links');

    // External link is inserted with the expected attributes.
    const external = page.locator('#external-link');
    await expect(external).toHaveCount(1);
    await expect(external).toHaveAttribute(
      'href',
      'https://althost.example/test-owner/test-repo/pull/1'
    );
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', /noopener/);
    await expect(external).toHaveAttribute('title', 'Open on AltHost');
    await expect(external).toHaveAttribute('aria-label', 'Open on AltHost');

    // The custom icon is rendered as a real SVG element (not innerHTML).
    const icon = external.locator('svg path[data-test-icon="external"]');
    await expect(icon).toHaveCount(1);

    // Built-in links are hidden when configured off.
    const githubLink = page.locator('#github-link');
    await expect(githubLink).toBeHidden();

    const graphiteLink = page.locator('#graphite-link');
    await expect(graphiteLink).toBeHidden();
  });

  test('hides the github link without removing other header buttons', async ({ page }) => {
    await page.route('**/api/repos/*/*/links**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: 'test-owner/test-repo',
          links: { external: null, github: false, graphite: true },
        }),
      });
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    await expect(page.locator('#github-link')).toBeHidden();
    // Settings and refresh remain visible — only the GitHub link is suppressed.
    await expect(page.locator('#settings-link')).toBeVisible();
    await expect(page.locator('#refresh-pr')).toBeVisible();
    // No external link is created when none is configured.
    await expect(page.locator('#external-link')).toHaveCount(0);
  });

  test('preserves default behaviour when the API returns the empty config', async ({ page }) => {
    await page.route('**/api/repos/*/*/links**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: 'test-owner/test-repo',
          links: { external: null, github: true, graphite: true },
        }),
      });
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // The default GitHub link stays visible.
    await expect(page.locator('#github-link')).toBeVisible();
    // No external link is inserted.
    await expect(page.locator('#external-link')).toHaveCount(0);
  });

  test('drops the external link when the URL template lacks a required placeholder', async ({ page }) => {
    await page.route('**/api/repos/*/*/links**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repository: 'test-owner/test-repo',
          links: {
            external: {
              label: 'Broken',
              // {missing} is not a whitelisted placeholder; without
              // substitution the URL retains a literal `{missing}` and
              // would have been a broken link. The frontend should
              // still render it because the URL starts with https://
              // — but if a *required* placeholder fails substitution
              // we drop the link. Use a guaranteed-missing whitelisted
              // placeholder to assert the drop behaviour.
              url_template: 'https://althost.example/x/{head_sha}/y',
              icon: null,
            },
            github: true,
            graphite: true,
          },
        }),
      });
    });

    // Override the PR fetch so head_sha comes back empty, forcing the
    // template substitution to fail.
    await page.route('**/api/pr/test-owner/test-repo/1', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (json && json.data) {
        json.data.head_sha = '';
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // No external link should have been inserted.
    await expect(page.locator('#external-link')).toHaveCount(0);
    // GitHub link remains since it wasn't suppressed.
    await expect(page.locator('#github-link')).toBeVisible();
  });
});
