// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Hunk Summary UI (Phase 5)
 *
 * Verifies the inline natural-language hunk-summary feature end-to-end:
 *   - The toolbar toggle button is hidden when summaries.enabled=false
 *   - When enabled, summaries fetched from the API render inline
 *   - WebSocket-style review:hunk_summaries_ready CustomEvents render new
 *     summaries without a reload
 *   - Toolbar toggle hides/shows every summary at once
 *   - Per-file toggle in the file header hides/shows that file's summaries
 *     and persists across reload
 *
 * Tests run in BOTH PR mode and Local mode (CLAUDE.md parity requirement).
 * The /api/config and /api/reviews/:id/hunk-summaries endpoints are mocked
 * via page.route() — we don't need to seed the test DB for those.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, whenReviewEventsBound } from './helpers.js';
import { waitForFileRendered, waitForDiffSettled, scrollFileIntoView, fileWrapper } from './diff-dom.js';
import { allCorpora, routeDiff } from './fixtures/diffs.js';

// A file at the top, a 4,000-line file and a file at the bottom: far enough
// apart for the viewer to unmount the first while the last is on screen.
const { eviction: EVICTION } = allCorpora();

const PR_REVIEW_ID = 1;
const PR_PATH = '/pr/test-owner/test-repo/1';
const LOCAL_REVIEW_ID = 2;
const LOCAL_PATH = '/local/2';

const MODES = [
  { name: 'PR mode', path: PR_PATH, reviewId: PR_REVIEW_ID },
  { name: 'Local mode', path: LOCAL_PATH, reviewId: LOCAL_REVIEW_ID }
];

/**
 * Mock the global app config to flip the summaries feature on.
 * @param {import('@playwright/test').Page} page
 */
async function enableSummariesConfig(page) {
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
        tours: { enabled: false }
      })
    });
  });
}

/**
 * Read the canonical content hash of a file's FIRST hunk, waiting until the
 * hunk anchors have been wired for that file.
 *
 * The hash comes from the server-computed `hunk_hashes` (canonical,
 * whitespace-stable), which `_registerPierreHunkAnchorsForFile` records in
 * `prManager._summaryAnchorsByHash` in hunk order when the file's body is
 * rendered. The first key is the first hunk's hash — the value a
 * `review:hunk_summaries_ready` event carries as `content_hash` to mount a
 * summary against that hunk.
 * @param {import('@playwright/test').Page} page
 * @param {string} fileName
 */
async function readFirstHunkHash(page, fileName) {
  // The file's body is rendered (what the spec waited for before the diff
  // helpers existed, by asking the engine whether it had the file)...
  await waitForFileRendered(page, fileName);
  // ...and its anchors are registered.
  await page.waitForFunction(
    (file) => {
      const pm = window.prManager;
      const anchors = pm && pm._summaryAnchorsByHash && pm._summaryAnchorsByHash.get(file);
      return !!(anchors && anchors.size > 0);
    },
    fileName,
    { timeout: 5000 }
  );
  return page.evaluate((file) => {
    const anchors = window.prManager._summaryAnchorsByHash.get(file);
    return anchors.keys().next().value;
  }, fileName);
}

/**
 * Dispatch a `review:hunk_summaries_ready` CustomEvent against the page —
 * mirrors what ChatPanel does when the WebSocket relays the same payload.
 */
async function dispatchSummariesReady(page, payload) {
  await whenReviewEventsBound(page);
  await page.evaluate(({ payload: detail }) => {
    document.dispatchEvent(new CustomEvent('review:hunk_summaries_ready', { detail }));
  }, { payload });
}

/**
 * Dispatch a `review:background_job_finished` CustomEvent — mirrors what the
 * WebSocket relay does when the queue finishes a job. With
 * `hasActiveForType: false` this clears the toolbar's pulsing "generating"
 * state so a subsequent click toggles visibility instead of opening the
 * cancel dialog.
 */
async function dispatchJobFinished(page, { reviewId, jobType, hasActiveForType = false }) {
  await whenReviewEventsBound(page);
  await page.evaluate(({ reviewId: rid, jobType: jt, hasActiveForType: active }) => {
    document.dispatchEvent(new CustomEvent('review:background_job_finished', {
      detail: { reviewId: rid, jobType: jt, hasActiveForType: active }
    }));
  }, { reviewId, jobType, hasActiveForType });
}

for (const mode of MODES) {
  test.describe(`Hunk Summary UI (${mode.name})`, () => {
    test.beforeEach(async ({ page, context }) => {
      // Clear storage state once per test (NOT via addInitScript — that fires
      // on every navigation, including reloads, and would wipe the per-file
      // toggle state that the persistence test relies on across reload).
      await context.clearCookies();
      await page.goto('about:blank');
      await page.evaluate(() => {
        try { window.localStorage.clear(); } catch {}
      });
    });

    test('toolbar summary toggle is hidden when summaries are disabled', async ({ page }) => {
      // Default config (no summaries.enabled) → button stays display:none
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      const btn = page.locator('#summary-toggle-btn');
      await expect(btn).toBeHidden();
    });

    test('renders summary inline after WS event and toggle works', async ({ page }) => {
      await enableSummariesConfig(page);
      // Initial fetch returns no summaries; we'll deliver them via the WS path.
      await page.route('**/api/reviews/*/hunk-summaries', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ summaries: [], generating: false })
        });
      });

      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Toolbar toggle becomes visible once /api/config resolves
      const toggle = page.locator('#summary-toggle-btn');
      await expect(toggle).toBeVisible();

      const hash = await readFirstHunkHash(page, 'src/utils.js');

      await dispatchSummariesReady(page, {
        reviewId: mode.reviewId,
        filePath: 'src/utils.js',
        summaries: [
          { content_hash: hash, summary_text: 'Adds whitespace and inlines computeValue helper.' }
        ]
      });

      const annotation = page.locator(`.hunk-summary-row[data-content-hash="${hash}"]`);
      await expect(annotation).toBeVisible();
      await expect(annotation.locator('.hunk-summary-text'))
        .toHaveText('Adds whitespace and inlines computeValue helper.');

      // The hunk_summaries_ready event puts the toolbar button into its
      // pulsing "generating" state (cleared only by background_job_finished).
      // While pulsing, a click opens the cancel dialog instead of toggling
      // visibility, so simulate job completion first — matching the real SSE
      // lifecycle — before exercising the visibility toggle.
      await dispatchJobFinished(page, {
        reviewId: mode.reviewId, jobType: 'summaries', hasActiveForType: false
      });
      await expect(toggle).not.toHaveClass(/generating/);

      // Review-level toggle hides everything
      await toggle.click();
      await expect(annotation).toBeHidden();

      // Toggling again restores visibility
      await toggle.click();
      await expect(annotation).toBeVisible();
    });

    test('per-file toggle hides/shows that file\'s summaries and persists across reload', async ({ page }) => {
      await enableSummariesConfig(page);
      // Make the file-level fetch deliver the summary on initial load so the
      // per-file toggle can become enabled.
      let summariesPayload = { summaries: [] };
      await page.route('**/api/reviews/*/hunk-summaries', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(summariesPayload)
        });
      });

      await page.goto(mode.path);
      await waitForDiffToRender(page);
      const hash = await readFirstHunkHash(page, 'src/utils.js');

      // Now serve the real summary for this hash and re-render.
      summariesPayload = {
        summaries: [
          { file_path: 'src/utils.js', content_hash: hash, summary_text: 'Refactors helper.' }
        ]
      };
      // Trigger a fresh fetch via the WS-style event to avoid a full reload.
      await dispatchSummariesReady(page, {
        reviewId: mode.reviewId,
        filePath: 'src/utils.js',
        summaries: [
          { content_hash: hash, summary_text: 'Refactors helper.' }
        ]
      });

      const annotation = page.locator(`.hunk-summary-row[data-content-hash="${hash}"]`);
      await expect(annotation).toBeVisible();

      const fileWrapper = page.locator('.d2h-file-wrapper[data-file-name="src/utils.js"]');
      const fileToggle = fileWrapper.locator('.file-header-summary-toggle');
      await expect(fileToggle).toBeVisible();
      await expect(fileToggle).toBeEnabled();

      // Hide via the per-file toggle.
      await fileToggle.click();
      await expect(fileWrapper).toHaveClass(/summaries-hidden-file/);
      await expect(annotation).toBeHidden();

      // Persistence: reload and assert state is restored.
      // The hidden state is applied during _kickOffHunkSummaries which fetches
      // /api/reviews/:id/hunk-summaries. We wait on the assertion (web-first
      // retry) rather than a fixed timeout so it isn't racing the renderer.
      await page.reload();
      await waitForDiffToRender(page);
      const fileWrapperAfterReload = page.locator('.d2h-file-wrapper[data-file-name="src/utils.js"]');
      await expect(fileWrapperAfterReload).toHaveClass(/summaries-hidden-file/, { timeout: 5000 });

      // Re-show by clicking the toggle again.
      const fileToggleAfterReload = fileWrapperAfterReload.locator('.file-header-summary-toggle');
      await fileToggleAfterReload.click();
      await expect(fileWrapperAfterReload).not.toHaveClass(/summaries-hidden-file/);
    });

    test('a file whose summaries were hidden in an earlier session: the mark is on that file only, also after it has left the screen', async ({ page }) => {
      // The viewer reuses a file's element for another file. A class the
      // page writes on the element itself goes with it to the next file
      // (ledger H108): that file's summaries are then hidden while its own
      // toggle says they are shown.
      const { target, tail } = EVICTION.roles;
      // The stored choice is read when the page's configuration has been
      // answered. That answer is held here until the first files are drawn,
      // which is the order in which the mark was written from outside.
      let releaseConfig;
      const configHeld = new Promise((resolve) => { releaseConfig = resolve; });
      await enableSummariesConfig(page);
      await page.route('**/api/config', async (route) => {
        await configHeld;
        return route.fallback();
      });
      await page.route('**/api/reviews/*/hunk-summaries', (route) => route.fulfill({ json: { summaries: [] } }));
      await routeDiff(page, EVICTION);
      await page.addInitScript(({ id, file }) => {
        window.localStorage.setItem(`pair-review:summaries-hidden-files:${id}`, JSON.stringify([file]));
      }, { id: mode.reviewId, file: target });

      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForFileRendered(page, target);
      // Every file has been drawn with its contents: nothing draws the first
      // file again after this.
      await waitForDiffSettled(page);
      await expect(fileWrapper(page, target)).not.toHaveClass(/summaries-hidden-file/);
      releaseConfig();
      await expect(fileWrapper(page, target)).toHaveClass(/summaries-hidden-file/);

      const marked = () => page.evaluate(() => [...document.querySelectorAll('#diff-container .d2h-file-wrapper.summaries-hidden-file')]
        .map((host) => host.dataset.fileName));
      expect(await marked()).toEqual([target]);

      // The last file of the pane: the first one is unmounted and its element is used again.
      await scrollFileIntoView(page, tail);
      await expect(fileWrapper(page, target)).toHaveCount(0);
      await expect(fileWrapper(page, tail)).toBeVisible();
      expect(await marked()).toEqual([]);

      // Back at the first file the mark is there again, from data.
      await scrollFileIntoView(page, target);
      await expect(fileWrapper(page, target)).toHaveClass(/summaries-hidden-file/);
      expect(await marked()).toEqual([target]);
    });

    test('shows generating pulse when job is in flight, clears on finish', async ({ page }) => {
      await enableSummariesConfig(page);
      await page.route('**/api/reviews/*/hunk-summaries', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ summaries: [], generating: true })
        });
      });

      await page.goto(mode.path);
      await waitForDiffToRender(page);

      const toggle = page.locator('#summary-toggle-btn');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveClass(/generating/);

      // Backend signals the summary job has finished — pulse should clear.
      // The page starts listening for pushes after the diff has rendered and
      // the button is already pulsing; an event dispatched before that is
      // heard by nobody and the pulse never clears.
      await whenReviewEventsBound(page);
      await page.evaluate((reviewId) => {
        document.dispatchEvent(new CustomEvent('review:background_job_finished', {
          detail: { reviewId, jobType: 'summaries:abc123', ok: true }
        }));
      }, mode.reviewId);

      await expect(toggle).not.toHaveClass(/generating/);
    });

    test('renders summaries fetched on initial load', async ({ page }) => {
      await enableSummariesConfig(page);

      // We don't know the hash up front, so resolve it from the DOM, then return
      // it on the *next* request. Simpler: prime an empty response, read the
      // hash, prime the real response, reload.
      let summariesPayload = { summaries: [] };
      await page.route('**/api/reviews/*/hunk-summaries', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(summariesPayload)
        });
      });

      await page.goto(mode.path);
      await waitForDiffToRender(page);
      const hash = await readFirstHunkHash(page, 'src/utils.js');

      summariesPayload = {
        summaries: [
          { file_path: 'src/utils.js', content_hash: hash, summary_text: 'Refactors helper to return computeValue.' }
        ]
      };
      await page.reload();
      await waitForDiffToRender(page);

      const annotation = page.locator(`.hunk-summary-row[data-content-hash="${hash}"]`);
      await expect(annotation).toBeVisible();
      await expect(annotation.locator('.hunk-summary-text'))
        .toHaveText('Refactors helper to return computeValue.');
    });
  });
}
