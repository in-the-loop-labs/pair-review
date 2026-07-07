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

  // The receiving end of single-port delegation: the CLI carries --scope/--base
  // on /local?path=...; setup.html must relay them into the /api/setup/local POST.
  // We intercept the POST (fulfilling it) so this exercises the real page code
  // without needing a backend git repo.
  test('forwards delegated scope and base into the setup POST body', async ({ page }) => {
    let resolveBody;
    const bodyPromise = new Promise((r) => { resolveBody = r; });
    await page.route('**/api/setup/local', async (route) => {
      resolveBody(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ existing: false, setupId: 'e2e-setup-id' })
      });
    });

    const repoPath = '/tmp/e2e-scope-project';
    await page.goto(`/local?path=${encodeURIComponent(repoPath)}&scope=branch..untracked&base=develop`);

    const body = await bodyPromise;
    expect(body.path).toBe(repoPath);
    expect(body.scope).toBe('branch..untracked');
    expect(body.base).toBe('develop');
  });

  test('omits scope/base from the setup POST when the URL has none', async ({ page }) => {
    let resolveBody;
    const bodyPromise = new Promise((r) => { resolveBody = r; });
    await page.route('**/api/setup/local', async (route) => {
      resolveBody(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ existing: false, setupId: 'e2e-setup-id' })
      });
    });

    const repoPath = '/tmp/e2e-scope-project';
    await page.goto(`/local?path=${encodeURIComponent(repoPath)}`);

    const body = await bodyPromise;
    expect(body.path).toBe(repoPath);
    expect(body.scope).toBeUndefined();
    expect(body.base).toBeUndefined();
  });
});
