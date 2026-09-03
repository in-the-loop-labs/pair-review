// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';

/**
 * Phase 5 of plans/bridge-local-and-pr-modes.md — submitting a local review to
 * its associated GitHub PR.
 *
 * What only a real browser can answer here:
 *   - whether the Submit action is actually REACHABLE. `SplitButton` reads
 *     `canSubmitToGitHub` in its constructor and, when the answer is false,
 *     both hides the menu item AND falls back to Preview as the main action —
 *     two separate pieces of state a unit assertion on `hideSubmit` does not
 *     prove;
 *   - whether the shared `ReviewModal`, written for PR mode, POSTs to the
 *     LOCAL endpoint once the manager is patched;
 *   - whether a refusal from that endpoint reaches the user.
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
// warm-up never fires. canSyncDrafts stays false so nothing POSTs to the draft
// endpoint during these cases.
const CAPS = {
  hasAssociatedPR: true,
  hasGitHubToken: true,
  canShowPRMetadata: true,
  canViewPRComments: false,
  canCheckStaleVsPR: false,
  canSyncDrafts: false,
  canSubmitToGitHub: true,
};

const MERGED_PR = { ...OPEN_PR, state: 'closed', merged: true };

/**
 * Answer the blocking metadata endpoint. This is the LATE-FLIP path: on a
 * cold cache (`canShowPRMetadata: false`) the hidden PR pill drives
 * `_maybeWarmPRMetadata`, which hits this endpoint and applies whatever
 * capabilities it returns — the only way `canSubmitToGitHub` flips
 * mid-session.
 */
async function routePRMetadata(page, { capabilities, associatedPR }) {
  await page.route('**/api/local/2/pr-metadata*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ capabilities, associatedPR }),
    });
  });
}

/** Intercept the local submit endpoint. Records what the client sent. */
async function routeSubmit(page, { status = 200, body } = {}) {
  const state = { calls: [] };
  await page.route('**/api/local/2/submit-review', async (route) => {
    state.calls.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body || {
        success: true,
        message: 'Review submitted successfully to GitHub',
        github_url: 'https://github.com/test-owner/test-repo/pull/7#pullrequestreview-1',
        comments_submitted: 0,
        event: 'COMMENT',
      }),
    });
  });
  return state;
}

test.describe('Local mode review submission', () => {
  test('offers no Submit action on a local review with no associated PR', async ({ page }) => {
    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    // Preview takes over as the main action, and Submit is absent from the menu.
    await expect(page.locator('#split-button-text')).toContainText('Preview');
    await page.locator('#split-button-dropdown-toggle').click();
    await expect(page.locator('.split-button-menu-item[data-action="submit"]')).toHaveCount(0);
    await expect(page.locator('.split-button-menu-item[data-action="preview"]')).toBeVisible();
  });

  test('offers Submit when the branch has an associated PR', async ({ page }) => {
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await expect(page.locator('#split-button-text')).toContainText('Submit Review');
    await page.locator('#split-button-dropdown-toggle').click();
    await expect(page.locator('.split-button-menu-item[data-action="submit"]')).toBeVisible();
  });

  test('submits through the LOCAL endpoint and reports success', async ({ page }) => {
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });
    const submit = await routeSubmit(page);

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await page.locator('#split-button-main').click();
    const modal = page.locator('#review-modal');
    await expect(modal).toBeVisible();

    await modal.locator('#review-body-modal').fill('Looks good to me');
    await modal.locator('#submit-review-btn-modal').click();

    await expect(modal).toBeHidden();
    expect(submit.calls).toHaveLength(1);
    expect(submit.calls[0].event).toBe('COMMENT');
    expect(submit.calls[0].body).toContain('Looks good to me');
  });

  test('shows the drift refusal in the modal and keeps it open', async ({ page }) => {
    // The 409 a reviewer will actually hit: they committed since the PR was
    // pushed. The message tells them how to reconcile, so it has to be read.
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });
    await routeSubmit(page, {
      status: 409,
      body: {
        error: 'Your local HEAD (aaaaaaa) is not the head commit of pull request #7 (bbbbbbb). '
          + 'Push or pull so the two match, then submit again.',
        code: 'head_drift',
      },
    });

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await page.locator('#split-button-main').click();
    const modal = page.locator('#review-modal');
    await expect(modal).toBeVisible();
    await modal.locator('#submit-review-btn-modal').click();

    const error = modal.locator('#review-error-message');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Push or pull so the two match');
    await expect(modal).toBeVisible();
  });

  test('a late capability flip reveals Submit without promoting it over Preview', async ({ page }) => {
    // Only a real browser proves this. The page loads with the association
    // already resolved but NOT submittable, so the toolbar is constructed
    // showing Preview; the flip then arrives from the metadata endpoint, which
    // is exactly what happens on a dirty tree where the association is
    // backfilled after the page-load GET has answered.
    await patchReviewMetadata(page, {
      capabilities: { ...CAPS, canSubmitToGitHub: false },
      associatedPR: OPEN_PR,
    });
    await routePRMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();
    await expect(page.locator('#split-button-text')).toContainText('Preview');

    // The one call that can flip `canSubmitToGitHub` mid-session.
    await page.evaluate(() => window.localManager._refreshPRMetadata({ force: true }));

    // Submit became REACHABLE...
    await page.locator('#split-button-dropdown-toggle').click();
    await expect(page.locator('.split-button-menu-item[data-action="submit"]')).toBeVisible();

    // ...but it did NOT take over the main button under the user's cursor.
    await expect(page.locator('#split-button-text')).toContainText('Preview');
  });

  test('a capability LOST mid-session retracts Submit and demotes the main action', async ({ page }) => {
    // A force-push to unrelated history clears the association. A Submit
    // control left behind would POST to a PR this session is no longer tied to.
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });
    await routePRMetadata(page, {
      capabilities: { ...CAPS, hasAssociatedPR: false, canSubmitToGitHub: false },
      associatedPR: null,
    });

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();
    await expect(page.locator('#split-button-text')).toContainText('Submit Review');

    await page.evaluate(() => window.localManager._refreshPRMetadata({ force: true }));

    await expect(page.locator('#split-button-text')).toContainText('Preview');
    await page.locator('#split-button-dropdown-toggle').click();
    await expect(page.locator('.split-button-menu-item[data-action="submit"]')).toHaveCount(0);
  });

  test('a merged pull request leaves only Comment available, and says why', async ({ page }) => {
    // NEW POLICY (src/providers/review-submit.js): a merged or closed PR still
    // accepts a COMMENT review but refuses APPROVE / REQUEST_CHANGES / DRAFT.
    // The modal must not offer what the backend will reject.
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: MERGED_PR });

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await page.locator('#split-button-main').click();
    const modal = page.locator('#review-modal');
    await expect(modal).toBeVisible();

    await expect(modal.locator('input[name="review-event"][value="COMMENT"]')).toBeEnabled();
    await expect(modal.locator('input[name="review-event"][value="COMMENT"]')).toBeChecked();
    await expect(modal.locator('input[name="review-event"][value="APPROVE"]')).toBeDisabled();
    await expect(modal.locator('input[name="review-event"][value="REQUEST_CHANGES"]')).toBeDisabled();
    await expect(modal.locator('input[name="review-event"][value="DRAFT"]')).toBeDisabled();

    // Disabled WITH an explanation, never silently missing.
    const warning = modal.locator('#review-lifecycle-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('has been merged');
  });

  test('a lifecycle refusal narrows the options of the modal already on screen', async ({ page }) => {
    // The state race: the PR merged between the metadata these options were
    // built from and the submit. Leaving them stale invites the same failure.
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });
    await routePRMetadata(page, { capabilities: CAPS, associatedPR: MERGED_PR });
    await routeSubmit(page, {
      status: 410,
      body: {
        error: 'Pull request #7 has been merged, so it can no longer be approved, '
          + 'have changes requested, or hold a new draft review.',
        code: 'pr_merged',
      },
    });

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await page.locator('#split-button-main').click();
    const modal = page.locator('#review-modal');
    await expect(modal).toBeVisible();

    // Approve is offered, because as far as this page knows the PR is open.
    const approve = modal.locator('input[name="review-event"][value="APPROVE"]');
    await expect(approve).toBeEnabled();
    await approve.check();
    await modal.locator('#submit-review-btn-modal').click();

    await expect(modal.locator('#review-error-message')).toContainText('has been merged');
    await expect(modal).toBeVisible();
    await expect(approve).toBeDisabled();
    await expect(modal.locator('input[name="review-event"][value="COMMENT"]')).toBeChecked();
    await expect(modal.locator('#review-lifecycle-warning')).toBeVisible();
  });

  test('the preview modal offers Submit for the same session', async ({ page }) => {
    // Preview and the toolbar must agree — they used to disagree, because
    // PreviewModal gated on `window.PAIR_REVIEW_LOCAL_MODE` while SplitButton
    // had already moved to the capability.
    await patchReviewMetadata(page, { capabilities: CAPS, associatedPR: OPEN_PR });

    await page.goto('/local/2');
    await expect(page.locator('#local-branch-text')).toBeVisible();

    await page.locator('#split-button-dropdown-toggle').click();
    await page.locator('.split-button-menu-item[data-action="preview"]').click();

    await expect(page.locator('#preview-modal')).toBeVisible();
    await expect(page.locator('#preview-modal #submit-review-btn')).toBeVisible();
  });
});
