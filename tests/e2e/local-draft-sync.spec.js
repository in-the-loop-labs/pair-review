// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';

/**
 * Phase 4 of plans/bridge-local-and-pr-modes.md — the local-mode draft sync.
 *
 * Two things only a real browser can answer, and both have already shipped
 * broken elsewhere in this feature:
 *   - whether the button is actually VISIBLE. It is hidden with an inline
 *     `display`, because `.btn` sets an author-origin `display` that beats the
 *     UA's `[hidden] { display: none }` rule — an attribute assertion passes
 *     against that bug.
 *   - whether `PRManager.updatePendingDraftIndicator`, written for PR mode,
 *     finds its `#toolbar-meta` / `#pr-commit` anchors in local.html at all.
 *
 * The seeded local review (id=2) has no associated PR, so these cases patch
 * the metadata response rather than reshaping the fixture DB.
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

// canShowPRMetadata is true so the header pill renders and the cold-cache
// warm-up never fires — this spec is about the draft affordance, not the pill.
const CAPS = {
  hasAssociatedPR: true,
  hasGitHubToken: true,
  canShowPRMetadata: true,
  canViewPRComments: false,
  canCheckStaleVsPR: false,
  canSyncDrafts: true,
  canSubmitToGitHub: false,
};

const PENDING_DRAFT = {
  id: 3,
  github_review_id: '987654',
  github_node_id: 'PRR_localnode',
  github_url: 'https://github.com/test-owner/test-repo/pull/7#pullrequestreview-987654',
  comments_count: 2,
  created_at: '2026-01-01T00:00:00Z',
};

/**
 * Intercept the sync endpoint. Returns a counter object so a test can assert
 * how many times the client asked.
 */
async function routeSyncDrafts(page, body) {
  const state = { calls: 0 };
  await page.route('**/api/local/2/sync-drafts', async (route) => {
    state.calls++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return state;
}

test.describe('Local mode GitHub draft sync', () => {
  test('the button is not visible on a local review with no associated PR', async ({ page }) => {
    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await expect(page.locator('#local-sync-drafts-btn')).toBeHidden();
    await expect(page.locator('#pending-draft-indicator')).toHaveCount(0);
  });

  test('syncs on load and shows the draft indicator when a PR is associated', async ({ page }) => {
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });
    const sync = await routeSyncDrafts(page, { pendingDraft: PENDING_DRAFT, allGithubReviews: [] });

    await page.goto('/local/2');

    await expect(page.locator('#local-sync-drafts-btn')).toBeVisible();
    const indicator = page.locator('#pending-draft-indicator');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('2 comments');
    // No external link is configured for this fixture repo, so the shared
    // resolver falls back to the draft's own URL.
    await expect(indicator).toHaveAttribute('href', PENDING_DRAFT.github_url);
    expect(sync.calls).toBe(1);
  });

  test('shows the button but no indicator when GitHub has no draft', async ({ page }) => {
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });
    await routeSyncDrafts(page, { pendingDraft: null, allGithubReviews: [] });

    await page.goto('/local/2');

    await expect(page.locator('#local-sync-drafts-btn')).toBeVisible();
    await expect(page.locator('#pending-draft-indicator')).toHaveCount(0);
  });

  test('the button re-asks GitHub and picks up a draft started since page load', async ({ page }) => {
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });

    // First answer (the automatic load-time sync): nothing yet. Second answer
    // (the click): the user has since started a draft in the GitHub UI.
    let calls = 0;
    await page.route('**/api/local/2/sync-drafts', async (route) => {
      calls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          calls === 1
            ? { pendingDraft: null, allGithubReviews: [] }
            : { pendingDraft: PENDING_DRAFT, allGithubReviews: [] }
        ),
      });
    });

    await page.goto('/local/2');
    const button = page.locator('#local-sync-drafts-btn');
    await expect(button).toBeVisible();

    // Wait for the AUTOMATIC sync to have happened, not merely for the button
    // to exist: `_updateDraftSyncAffordance` reveals it early in the load,
    // while the load-time sync fires from the tail. Clicking in that window
    // makes the MANUAL request take answer #1 (null), and the tail then JOINS
    // the in-flight promise, inherits that null, and never asks again — so the
    // indicator would never render and this would fail intermittently under
    // load. Counting requests is also what proves the claim in the name: the
    // click asks GitHub a second time.
    await expect.poll(() => calls).toBe(1);
    await expect(button).toBeEnabled();

    await button.click();

    await expect.poll(() => calls).toBe(2);
    await expect(page.locator('#pending-draft-indicator')).toBeVisible();
    await expect(page.locator('#pending-draft-indicator')).toContainText('2 comments');
  });

  test('surfaces a server refusal without breaking the page', async ({ page }) => {
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });
    await page.route('**/api/local/2/sync-drafts', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'This local review has no associated pull request' }),
      });
    });

    await page.goto('/local/2');
    const button = page.locator('#local-sync-drafts-btn');
    await expect(button).toBeVisible();

    await button.click();

    // The diff and header are still there; the button is usable again.
    await expect(page.locator('#local-branch-text')).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(page.locator('#pending-draft-indicator')).toHaveCount(0);
  });
});
