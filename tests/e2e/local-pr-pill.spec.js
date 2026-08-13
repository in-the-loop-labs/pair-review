// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';

/**
 * Associated-PR header pill in local mode.
 *
 * These assertions are deliberately computed-style based (`toBeHidden` /
 * `toBeVisible`) rather than attribute based. The pill's first shipped bug was
 * that `hidden` had no visual effect at all: `.local-header-info .info-item
 * { display: flex }` is author-origin and beats the UA's `[hidden] { display:
 * none }` regardless of specificity, so an empty pill rendered for every local
 * review. A DOM unit test asserting `hasAttribute('hidden')` passes against
 * that bug — only a computed-style check catches it.
 *
 * The seeded local review (id=2) has no associated PR, so the association
 * cases patch the metadata response rather than reshaping the fixture DB.
 */

const REVIEW_PATH = '/api/local/2';

/** Patch the local-review metadata response, leaving every other field intact. */
async function patchReviewMetadata(page, patch) {
  await page.route(
    (url) => new URL(url).pathname === REVIEW_PATH,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, ...patch } });
    }
  );
}

const OPEN_PR = {
  prNumber: 7,
  repository: 'test-owner/test-repo',
  title: 'Add the widget',
  author: 'octocat',
  url: 'https://github.com/test-owner/test-repo/pull/7',
  state: 'open',
  merged: false,
  head_sha: 'abc123',
};

const CAPS = {
  hasAssociatedPR: true,
  hasGitHubToken: true,
  canShowPRMetadata: true,
  canViewPRComments: false,
  canCheckStaleVsPR: false,
  canSyncDrafts: false,
  canSubmitToGitHub: false,
};

test.describe('Local mode associated-PR pill', () => {
  test('is not visible on a local review with no associated PR', async ({ page }) => {
    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await expect(page.locator('#local-pr-info')).toBeHidden();
  });

  test('renders the PR number, title and author when metadata is available', async ({ page }) => {
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });

    await page.goto('/local/2');

    const pill = page.locator('#local-pr-info');
    await expect(pill).toBeVisible();
    await expect(page.locator('#local-pr-number')).toHaveText('#7');
    await expect(page.locator('#local-pr-title')).toHaveText('Add the widget');
    await expect(page.locator('#local-pr-author')).toHaveText('by octocat');
    await expect(page.locator('#local-pr-link')).toHaveAttribute(
      'href', 'https://github.com/test-owner/test-repo/pull/7'
    );
  });

  test('renders merged styling and a merged tooltip for a merged PR', async ({ page }) => {
    // GitHub reports a merged PR as state 'closed' plus a separate `merged`
    // boolean. Dropping `merged` made .state-merged unreachable and showed
    // merged PRs as closed.
    await patchReviewMetadata(page, {
      capabilities: CAPS,
      associatedPR: { ...OPEN_PR, state: 'closed', merged: true },
    });

    await page.goto('/local/2');

    const link = page.locator('#local-pr-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveClass(/state-merged/);
    await expect(link).not.toHaveClass(/state-closed/);
    await expect(link).toHaveAttribute('title', /\(merged\)/);
  });

  test('appears without a page reload when the metadata cache is cold', async ({ page }) => {
    // The main GET never blocks on GitHub, so a first load can arrive with
    // canShowPRMetadata false. Nothing else re-renders this header in-session,
    // so the pill must come from the blocking /pr-metadata endpoint.
    await patchReviewMetadata(page, {
      capabilities: { ...CAPS, canShowPRMetadata: false },
      associatedPR: { prNumber: 7, repository: 'test-owner/test-repo' },
    });

    let warmUpCalls = 0;
    await page.route('**/api/local/2/pr-metadata', async (route) => {
      warmUpCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: CAPS, associatedPR: OPEN_PR }),
      });
    });

    await page.goto('/local/2');

    await expect(page.locator('#local-pr-info')).toBeVisible();
    await expect(page.locator('#local-pr-number')).toHaveText('#7');
    expect(warmUpCalls).toBe(1);
  });

  test('stays hidden when the cold-cache warm-up yields no metadata', async ({ page }) => {
    await patchReviewMetadata(page, {
      capabilities: { ...CAPS, canShowPRMetadata: false },
      associatedPR: { prNumber: 7, repository: 'test-owner/test-repo' },
    });
    await page.route('**/api/local/2/pr-metadata', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          capabilities: { ...CAPS, canShowPRMetadata: false },
          associatedPR: { prNumber: 7, repository: 'test-owner/test-repo' },
        }),
      });
    });

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await expect(page.locator('#local-pr-info')).toBeHidden();
  });
});
