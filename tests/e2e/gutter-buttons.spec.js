// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: fallback-positioned gutter buttons must not go stale.
 *
 * PierreBridge's fallback gutter positioning pins the +/chat buttons with
 * position:fixed (viewport coordinates). Regression coverage for buttons
 * left floating over unrelated content when:
 *   - the pointer moves off the diff entirely (teardown used to rely on a
 *     pointerleave listener bound to the shadow ROOT, which never fires),
 *   - the page scrolls (fixed coordinates detach from the hovered line),
 *   - the diff view toggles unified/split (rerender moves every line).
 *
 * Split mode is used to arm the fallback positioner because split gutter
 * hover reliably routes through it (see pierre-bridge.js fallback tracking).
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, setDiffView, hoverSplitDiffLine, waitForDiffType, analysesUrl } from './helpers.js';
import {
  gutterButtonsState, additionsContentPoint, scrollDiffUnderPointer
} from './diff-dom.js';

const FILE = 'src/utils.js';

// Gutter buttons are positioned by the shared PierreBridge/PRManager render
// path, exercised identically by PR and Local mode. The per-worker test
// server seeds the SAME src/utils.js diff for review 1 (PR) and review 2
// (Local) — see tests/e2e/test-server.js — so the same line/side fixtures work
// in both. Run the whole suite against each mode for parity coverage.
const MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1', reviewId: 1 },
  { name: 'Local mode', path: '/local/2', reviewId: 2 }
];

// Where the test last put the mouse (viewport coordinates), or null when it
// is parked outside the diff. gutterButtonsState judges a visible button
// against the row under this point.
let pointer = null;

async function movePointer(page, x, y) {
  await page.mouse.move(x, y);
  pointer = { x, y };
}

/** Hover a split-layout line and show the gutter buttons on it. */
async function armGutterButtons(page) {
  await setDiffView(page, 'split');
  const cell = await hoverSplitDiffLine(page, { fileName: FILE, line: 4, side: 'additions' });
  const box = await cell.boundingBox();
  pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await expect.poll(async () => {
    const state = await gutterButtonsState(page, pointer);
    return state.some((s) => s.visible);
  }, { timeout: 5000 }).toBe(true);
}

/** No gutter button is showing anywhere. */
async function expectNoButtons(page) {
  await expect.poll(async () => {
    const state = await gutterButtonsState(page, pointer);
    return state.every((s) => !s.visible);
  }, { timeout: 5000 }).toBe(true);
}

/**
 * No gutter button is showing anywhere except on the row under the pointer.
 * A button re-shown on the line the pointer is still over is correct; one
 * left where the line used to be is the regression.
 */
async function expectNoStaleButtons(page) {
  await expect.poll(async () => {
    const state = await gutterButtonsState(page, pointer);
    return state.every((s) => !s.stale);
  }, { timeout: 5000 }).toBe(true);
}

for (const mode of MODES) {
  test.describe(`Gutter buttons — no stale buttons (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 700 });
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test('clear when the pointer leaves the diff', async ({ page }) => {
      await armGutterButtons(page);

      // Park the pointer on the page header, well outside the file wrapper.
      await page.mouse.move(700, 20);
      pointer = null;
      await expectNoStaleButtons(page);
    });

    /**
     * The same gesture on a review that holds the suggestions of an
     * analysis when the page loads. Before the migration to the virtualized
     * viewer the button then stayed where it was (a defect of the fallback
     * positioner that went with the per-file renderer; ledger H66 of
     * plans/codeview-virtualized-diff.md has the measurements). The viewer's
     * own buttons leave with the pointer, whatever the review holds.
     */
    test('after the pointer leaves the diff, with the suggestions of an analysis on the review', async ({ page }) => {
      const started = await page.request.post(analysesUrl(mode.reviewId), { data: {} });
      expect(started.ok()).toBe(true);
      await expect.poll(async () => {
        const status = await page.request.get(`/api/reviews/${mode.reviewId}/analyses/status`);
        return (await status.json()).running;
      }).toBe(false);
      // The state under test is a page that LOADS with those rows.
      await page.reload();
      await waitForDiffToRender(page);
      await expect(page.locator('.ai-suggestion').first()).toBeVisible();

      await armGutterButtons(page);
      await page.mouse.move(700, 20);
      pointer = null;

      await expectNoStaleButtons(page);
    });

    test('clear when the page scrolls under a parked pointer', async ({ page }) => {
      await armGutterButtons(page);

      // Park the pointer deep in the additions CONTENT track: X to the right of
      // the line-number gutter, any row. This matters for determinism. After a
      // scroll the application re-derives hover from the parked pointer; a
      // point over a line-NUMBER cell would legitimately show a button on
      // whatever row scrolled under it. A point in the content track never
      // resolves to a number cell, so nothing can re-show. (The centre of the
      // FIRST content cell is unsafe: the first added line is blank, its cell
      // is near-zero width and its centre sits over the gutter.)
      const park = await additionsContentPoint(page, FILE);
      expect(park, 'additions content track should be resolvable in split').not.toBeNull();
      await movePointer(page, park.x, park.y);

      // Scroll the diff's own scroll container WITHOUT moving the pointer.
      // Driving the container directly (rather than a wheel gesture, whose
      // delivery depends on what is under the pointer being scrollable) fires
      // the same scroll event deterministically. A button pinned to the
      // viewport would stay where it was while the diff moves under it.
      // Scroll toward whichever direction has room: in the shared-DB full
      // suite the container may already sit at the bottom.
      const scrolled = await scrollDiffUnderPointer(page);
      expect(scrolled, 'the diff should have a scroll container that moved').toBe(true);

      // A button re-shown on the line still under the pointer is fine; the
      // regression is a button that stayed where the old line was.
      await expectNoStaleButtons(page);
    });

    test('clear when the diff view toggles back to unified', async ({ page }) => {
      await armGutterButtons(page);

      // Toggle programmatically (no pointer movement) so this exercises the
      // layout change itself, not a pointer-move sweep. The re-render must not
      // leave a button where the split-layout line was; a button re-shown on
      // the line under the pointer in the new layout is fine.
      await page.evaluate(() => window.prManager.handleDiffViewChange('unified'));
      await waitForDiffType(page, 'single', 5000, { fileName: FILE });
      await expectNoStaleButtons(page);
    });
  });
}
