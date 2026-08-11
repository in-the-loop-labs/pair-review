// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: comment data-integrity across CodeView virtualization remounts.
 *
 * Regression coverage for two remount bugs the integration review found (Task
 * #14) that the existing comment specs structurally could not catch: NO spec
 * scrolled a file OUT of the virtualization window and back after mutating a
 * comment, so a delete/edit that only updated the DOM (not the item's
 * annotation data) shipped past a green suite — the file rebuilds from data on
 * remount, resurrecting a deleted comment or reverting an edit.
 *
 * These tests force a real eviction: main.js is made huge so utils.js is
 * virtualized OUT below it, then scrolled in (mount), mutated, evicted
 * (unmount), and scrolled back (remount-from-data). Both PR and Local mode
 * (CLAUDE.md parity), fully deterministic (scrollFileIntoView / scrollFileOutOfView
 * / waitForAnnotationsSlotted, no fixed sleeps).
 */

import { test, expect } from './fixtures.js';
import {
  waitForDiffToRender,
  scrollFileIntoView,
  scrollFileOutOfView,
  waitForAnnotationsSlotted,
  expectResponse,
  cleanupComments,
  evictionDiff,
} from './helpers.js';

const UTILS = 'src/utils.js';
// utils.js additions land on NEW lines 2-4; comment on line 3.
const COMMENT_LINE = 3;

// The shared evictionDiff() fixture (helpers.js) makes main.js large enough that
// utils.js is virtualized OUT of the render window and only mounts when scrolled
// to — the precondition for exercising a remount. utils.js carries a few
// additions so a line comment has somewhere to anchor.

const MODES = [
  {
    name: 'PR mode',
    path: '/pr/test-owner/test-repo/1',
    async mockDiff(page) {
      await page.route('**/api/pr/*/*/*/diff', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            diff: evictionDiff(),
            changed_files: [
              { file: 'src/main.js', additions: 20100, deletions: 0 },
              { file: 'src/utils.js', additions: 3, deletions: 0 },
            ],
          }),
        })
      );
    },
  },
  {
    name: 'Local mode',
    path: '/local/2',
    async mockDiff(page) {
      // local.js fetches the diff from /api/local/:id/diff ({ diff, stats }).
      await page.route('**/api/local/*/diff', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            diff: evictionDiff(),
            stats: { files_changed: 2, additions: 20103, deletions: 0 },
          }),
        })
      );
    },
  },
];

/** The SplitButton's active user-comment count. */
function commentCount(page) {
  return page.evaluate(() => window.prManager?.splitButton?.getCommentCount?.() ?? -1);
}

/**
 * Assert the SplitButton (review submission button) reflects the comment count.
 * Its main label reads "Submit Review (N)" when N > 0 (SplitButton.getActionText),
 * driven by the same data-backed `_countActiveUserComments` that feeds the
 * REQUEST_CHANGES guard the reviewer's misfire came from — so a stale count
 * after delete would show the wrong "(N)" here.
 */
async function expectReviewCount(page, n) {
  const main = page.locator('#split-button-main');
  if (n > 0) {
    await expect(main).toContainText(`(${n})`, { timeout: 5000 });
  } else {
    await expect(main).not.toContainText('(', { timeout: 5000 });
  }
}

/**
 * Seed line comments on utils.js through the API, then reload and bring the file
 * back into the render window.
 *
 * WHY not the UI for these: tests below need TWO comments before they can start,
 * and the second gutter interaction is the least reliable step in the whole suite
 * — the vendor reveals the +/chat button only while its row is hovered, and the
 * first comment's annotation re-render rebuilds the rows underneath the pointer
 * (observed: the reveal never landing inside a 3×5s retry budget at full
 * workers). The behaviour these tests exist for is delete/edit + remount, not
 * comment creation — which is covered interactively by comment-crud and
 * file-comments — so the arrange step goes through the API and the acted-on
 * interaction stays in the UI.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<{line: number, body: string}>} specs
 * @returns {Promise<Record<number, string>>} comment id by line
 */
async function seedUtilsComments(page, specs) {
  const ids = await page.evaluate(async ({ file, entries }) => {
    const reviewId = window.prManager.currentPR.id;
    const out = {};
    for (const { line, body } of entries) {
      const resp = await fetch(`/api/reviews/${reviewId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file,
          line_start: line,
          line_end: line,
          side: 'RIGHT',
          diff_position: line,
          body,
        }),
      });
      if (!resp.ok) throw new Error(`seed comment failed: ${resp.status}`);
      const data = await resp.json();
      out[line] = String(data.commentId);
    }
    return out;
  }, { file: UTILS, entries: specs });

  await page.reload();
  await waitForDiffToRender(page, 25000);
  await scrollFileIntoView(page, UTILS);
  await waitForAnnotationsSlotted(page, UTILS);
  const host = page.locator(`diffs-container[data-file-name="${UTILS}"]`);
  for (const { line } of specs) {
    await expect(host.locator(`.user-comment-row[data-line-start="${line}"]`)).toHaveCount(1, { timeout: 10000 });
  }
  return ids;
}

for (const mode of MODES) {
  test.describe(`Comment remount integrity (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await mode.mockDiff(page);
      await page.goto(mode.path);
      // The 20k-line eviction fixture takes real time to parse + first-paint;
      // the helper's 10s default is not enough when the suite runs at full
      // workers (observed: the CodeView root not yet stamped at 10s).
      await waitForDiffToRender(page, 25000);
      await cleanupComments(page);
    });

    test.afterEach(async ({ page }) => {
      await cleanupComments(page);
    });

    test('a deleted comment does not resurrect after the file is evicted and remounted; the survivor persists and the count/review-state decrement', async ({ page }) => {
      // Heavy 20k-line eviction diff plus an evict/remount round trip — needs
      // timeout headroom when the suite runs at full workers.
      test.slow();
      // Two comments so the remount also proves the SURVIVOR stays intact (not
      // just that the deleted one is gone). Seeded via the API — see
      // seedUtilsComments for why the arrange step avoids the gutter.
      await seedUtilsComments(page, [
        { line: 3, body: 'Delete me' },
        { line: 4, body: 'Keep me' },
      ]);
      const host = page.locator(`diffs-container[data-file-name="${UTILS}"]`);
      await expect.poll(() => commentCount(page), { timeout: 10000 }).toBe(2);
      await expectReviewCount(page, 2);

      // Delete the line-3 comment specifically; the line-4 one must remain.
      const deleteResponse = expectResponse(page,
        (r) => r.url().includes('/comments/') && r.request().method() === 'DELETE'
      );
      await host.locator('.user-comment-row[data-line-start="3"] .btn-delete-comment').first().click();
      await deleteResponse;
      await expect(host.locator('.user-comment-row[data-line-start="3"]')).toHaveCount(0, { timeout: 5000 });
      await expect(host.locator('.user-comment-row[data-line-start="4"]')).toHaveCount(1);
      // Count + review-button state decrement immediately (data-backed), no reload.
      await expect.poll(() => commentCount(page), { timeout: 10000 }).toBe(1);
      await expectReviewCount(page, 1);

      // Evict utils.js from the render window, then bring it back — the item
      // rebuilds from its annotation data.
      await scrollFileOutOfView(page, UTILS);
      await scrollFileIntoView(page, UTILS);
      await waitForAnnotationsSlotted(page, UTILS);

      // The SURVIVOR first: its row reappearing is the sentinel that the item has
      // finished rebuilding from data (`waitForAnnotationsSlotted` is a bounded
      // best-effort, so on a loaded machine the slot can land after it returns).
      // Only once the rebuild is observably done does "the deleted one is absent"
      // mean anything — asserted the other way round it passes on an empty host.
      await expect(host.locator('.user-comment-row[data-line-start="4"]')).toHaveCount(1, { timeout: 15000 });
      await expect(host.locator('.user-comment-row[data-line-start="4"] .user-comment-body')).toContainText('Keep me');
      await expect(host.locator('.user-comment-row[data-line-start="3"]')).toHaveCount(0);
      expect(await commentCount(page)).toBe(1);
      await expectReviewCount(page, 1);
    });

    test('an edited comment keeps its edited text after the file is evicted and remounted', async ({ page }) => {
      test.slow(); // heavy 20k-line fixture + an evict/remount round trip
      await seedUtilsComments(page, [{ line: COMMENT_LINE, body: 'Original remount text' }]);

      // Edit the comment to new text. Retry the whole click→form-appears as one
      // bounded loop: Local mode's post-load diff refresh rebuilds the comment row,
      // and when that lands between the click and the form it swallows the edit
      // (observed under full-worker load — "element(s) not found" on the textarea).
      // Re-clicking a rebuilt Edit button is what a user does; the bound means a
      // genuinely broken edit button still fails loudly.
      const host = page.locator(`diffs-container[data-file-name="${UTILS}"]`);
      const editTextarea = page.locator('.comment-edit-textarea, .user-comment-edit-form textarea').first();
      let editErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await host.locator('.btn-edit-comment').first().click({ timeout: 5000 });
          await expect(editTextarea).toBeVisible({ timeout: 5000 });
          editErr = null;
          break;
        } catch (err) {
          editErr = err;
        }
      }
      if (editErr) throw editErr;
      await editTextarea.fill('Edited remount text');
      // Save via Cmd/Ctrl+Enter (pr.js wires it to the edit form's Save) rather
      // than clicking .save-edit-btn: with utils.js far down the huge diff the
      // Save button can sit below the fold, and Playwright's scroll-to-click
      // fights the virtualized container. Keyboard save is genuine user input.
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await editTextarea.press(`${modifier}+Enter`);
      await expect(page.locator('.user-comment-edit-form')).not.toBeVisible({ timeout: 5000 });
      await expect(host.locator('.user-comment-body').first()).toContainText('Edited remount text');
      await waitForAnnotationsSlotted(page, UTILS);

      // Evict + remount: the rebuilt item must show the EDITED body, not the
      // original.
      await scrollFileOutOfView(page, UTILS);
      await scrollFileIntoView(page, UTILS);
      await waitForAnnotationsSlotted(page, UTILS);

      const body = page.locator(`diffs-container[data-file-name="${UTILS}"] .user-comment-body`).first();
      // Generous: the rebuilt row is the sentinel for "the item finished
      // rebuilding", and the annotation slot can land after the bounded
      // waitForAnnotationsSlotted returns on a loaded machine.
      await expect(body).toBeVisible({ timeout: 15000 });
      await expect(body).toContainText('Edited remount text');
      await expect(body).not.toContainText('Original remount text');
    });

    test('deleting from the AI panel while the file is virtualized OUT still decrements the count', async ({ page }) => {
      // The count/review-state repaint used to live inside the branches that
      // removed the comment's DOM row. With the file virtualized out there is no
      // row to remove, so those branches never ran and the toolbar kept counting a
      // comment the user had just deleted.
      test.slow();
      const seeded = await seedUtilsComments(page, [
        { line: 3, body: 'Delete me from the panel' },
        { line: 4, body: 'Keep me' },
      ]);
      await expect.poll(() => commentCount(page), { timeout: 10000 }).toBe(2);
      await expectReviewCount(page, 2);

      const targetId = seeded[3];
      expect(targetId).toBeTruthy();

      // Open the panel on the User segment BEFORE evicting: expanding it resizes
      // the diff column and re-renders, which could remount the target file.
      await page.evaluate(() => window.aiPanel?.expand());
      await page.locator('.segment-btn').filter({ hasText: 'User' }).click();
      const item = page.locator(`.finding-item.finding-comment[data-id="${targetId}"]`);
      await expect(item).toBeVisible({ timeout: 5000 });

      // Now evict the file, so the delete lands with NO comment row in the DOM.
      await scrollFileOutOfView(page, UTILS);
      await expect(page.locator(`diffs-container[data-file-name="${UTILS}"]`)).toHaveCount(0);

      const deleteResponse = expectResponse(page,
        (r) => r.url().includes(`/comments/${targetId}`) && r.request().method() === 'DELETE'
      );
      // The dismiss button is revealed by hovering its finding item.
      await item.hover();
      const dismissBtn = page.locator(`.quick-action-dismiss-comment[data-comment-id="${targetId}"]`);
      await expect(dismissBtn).toBeVisible({ timeout: 5000 });
      await dismissBtn.click();
      await deleteResponse;

      // The count and the review button decrement even though no row was removed.
      await expect.poll(() => commentCount(page), { timeout: 10000 }).toBe(1);
      await expectReviewCount(page, 1);

      // And the deleted comment stays gone when the file comes back. Survivor
      // first — it is the sentinel proving the item rebuilt, without which the
      // "deleted row is absent" check would pass on a not-yet-rebuilt host.
      await scrollFileIntoView(page, UTILS);
      await waitForAnnotationsSlotted(page, UTILS);
      const remounted = page.locator(`diffs-container[data-file-name="${UTILS}"]`);
      await expect(remounted.locator('.user-comment-row[data-line-start="4"]')).toHaveCount(1, { timeout: 15000 });
      await expect(remounted.locator(`.user-comment-row[data-comment-id="${targetId}"]`)).toHaveCount(0);
      expect(await commentCount(page)).toBe(1);
    });

    test('Clear All works while the commented file is virtualized OUT (no false "No comments to clear")', async ({ page }) => {
      // Regression: clearAllUserComments guarded on a document.querySelectorAll
      // count. With the commented file evicted there are ZERO comment elements
      // in the DOM, so it toasted "No comments to clear" and bailed while two
      // comments existed. The guard (and the dialog message) is data-backed now.
      test.slow();
      await seedUtilsComments(page, [
        { line: 3, body: 'Clear-all target one' },
        { line: 4, body: 'Clear-all target two' },
      ]);
      await expect.poll(() => commentCount(page), { timeout: 10000 }).toBe(2);
      await expectReviewCount(page, 2);

      // Evict utils.js — the regression's exact precondition: comments exist in
      // data, but nothing comment-shaped is mounted in the DOM.
      await scrollFileOutOfView(page, UTILS);
      await expect(page.locator(`diffs-container[data-file-name="${UTILS}"]`)).toHaveCount(0);
      await expect(page.locator('.user-comment-row')).toHaveCount(0);

      // Trigger Clear All through the SplitButton dropdown (the real UI path,
      // same as comment-crud-advanced's Clear All coverage).
      const dropdownToggle = page.locator('#split-button-dropdown-toggle');
      await expect(dropdownToggle).toBeVisible({ timeout: 5000 });
      await dropdownToggle.click();
      const dropdown = page.locator('#split-button-dropdown');
      await expect(dropdown).toBeVisible({ timeout: 2000 });
      const clearAllOption = dropdown.locator('[data-action="clear"]');
      await expect(clearAllOption).toBeVisible();
      await expect(clearAllOption).toBeEnabled();
      await clearAllOption.click();

      // The confirm dialog appearing IS the sentinel that the guard passed: the
      // guard's two branches (info toast vs dialog) are mutually exclusive, so
      // once the dialog is up, "No comments to clear" cannot also have fired.
      const overlay = page.locator('.confirm-dialog-overlay');
      await expect(overlay).toBeVisible({ timeout: 5000 });
      // The message uses the data-backed count too: "…dismiss all 2 comments…".
      await expect(overlay).toContainText('2 comments');
      await expect(page.locator('.toast-info').filter({ hasText: 'No comments to clear' })).toHaveCount(0);

      const bulkDelete = expectResponse(page,
        (r) => r.url().includes('/comments') && r.request().method() === 'DELETE'
      );
      await page.locator('#confirm-dialog-btn').click();
      await bulkDelete;

      // Success: toast, count and review-button state all reach zero.
      await expect(page.locator('.toast-success').filter({ hasText: /Cleared.*comment/ })).toBeVisible({ timeout: 5000 });
      await expect.poll(() => commentCount(page), { timeout: 10000 }).toBe(0);
      await expectReviewCount(page, 0);
      await expect(page.locator('.toast-info').filter({ hasText: 'No comments to clear' })).toHaveCount(0);

      // And when the file remounts, it rebuilds from data with no comment rows.
      await scrollFileIntoView(page, UTILS);
      await waitForAnnotationsSlotted(page, UTILS);
      const remounted = page.locator(`diffs-container[data-file-name="${UTILS}"]`);
      await expect(remounted).toHaveCount(1, { timeout: 15000 });
      await expect(remounted.locator('.user-comment-row')).toHaveCount(0);
    });
  });
}
