// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: where navigation lands (N4 of plans/codeview-virtualized-diff.md)
 *
 * Characterization of main in both modes, on a 60-file diff: a sidebar jump
 * and an AI-panel click land on the first try and stay there while the file's
 * contents load; file positions do not wander between scroll passes; what the
 * unified/split toggle keeps in place; what collapsing the file being read
 * does to the view.
 *
 * Landings are judged the way a reader does: relative to the toolbar pinned
 * above the diff (`headerLanding`), never by a scroll offset. CSS transitions
 * are on, and navigation scrolls smoothly: every landing is polled for.
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, setDiffView, seedSuggestions, cleanupAllComments, mockViewedStateApi
} from './helpers.js';
import { allCorpora, changedLines, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, filesInPane, firstFileBelowToolbar, firstVisibleRow, headerLanding, inlineSuggestion, rowBox, scrollDiffTo,
  scrollDiffToEdge, scrollState, waitForFileRendered, waitForFileSettled, assertNoOrphanHosts,
  scrollThroughDiff, LAYOUT_TOGGLE_KEEPS
} from './diff-dom.js';

const { many: MANY } = allCorpora();
const { first, middle, last } = MANY.roles;
const sidebarItem = (page, file) => page.locator(`.file-item[data-path="${file}"]`);

/** Poll until `file`'s header is flush under the toolbar. */
async function expectHeaderFlush(page, file) {
  await expect.poll(async () => Math.abs((await headerLanding(page, file))?.belowPinned ?? 999), { timeout: 10000 })
    .toBeLessThan(2);
}

/** Wait until the diff has stopped scrolling (a smooth scroll in flight keeps moving it). */
async function scrollSettled(page) {
  let last = null;
  await expect.poll(async () => {
    const now = (await scrollState(page)).top;
    const still = now === last;
    last = now;
    return still;
  }, { intervals: [150, 150, 150, 250] }).toBe(true);
  return last;
}

/** Every file's top edge in document coordinates (independent of the scroll position). */
async function fileTops(page) {
  const state = await scrollState(page);
  return Object.fromEntries((await filesInPane(page)).map((f) => [f.file, Math.round(f.top + state.top)]));
}

for (const mode of MODES) {
  test.describe(`Scroll landing (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('a sidebar jump to a file far away lands its header under the toolbar and it stays there', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      // The file renders and is upgraded with its contents after landing;
      // neither moves it.
      await waitForFileRendered(page, middle);
      await waitForFileSettled(page, middle);
      await scrollSettled(page);
      expect(Math.abs((await headerLanding(page, middle)).belowPinned)).toBeLessThan(2);
      await assertNoOrphanHosts(page);
    });

    test('a second jump straight after the first lands on the second file', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await sidebarItem(page, MANY.order[45]).click();
      await expectHeaderFlush(page, MANY.order[45]);
      await scrollSettled(page);
      expect(Math.abs((await headerLanding(page, MANY.order[45])).belowPinned)).toBeLessThan(2);
    });

    test('a sidebar jump lands the same way in split layout', async ({ page }) => {
      await setDiffView(page, 'split');
      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      await waitForFileRendered(page, middle);
      await waitForFileSettled(page, middle);
      await scrollSettled(page);
      expect(Math.abs((await headerLanding(page, middle)).belowPinned)).toBeLessThan(2);
    });

    test('a sidebar jump to a collapsed file lands on its header and leaves it collapsed', async ({ page }) => {
      // Collapse the target while it is on screen, go away, come back.
      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      await waitForFileRendered(page, middle);
      await fileWrapper(page, middle).locator('.file-collapse-toggle').click();
      await expect(fileWrapper(page, middle)).toHaveClass(/collapsed/);
      await sidebarItem(page, first).click();
      await expectHeaderFlush(page, first);

      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      await expect(fileWrapper(page, middle)).toHaveClass(/collapsed/);
    });

    test('file positions and the scroll extent do not change between one scroll pass and the next', async ({ page }) => {
      // The first pass renders everything; from then on nothing may wander.
      await scrollThroughDiff(page);
      await scrollThroughDiff(page);
      const topsA = await fileTops(page);
      const extentA = (await scrollState(page)).height;
      await scrollThroughDiff(page);
      const topsB = await fileTops(page);
      const extentB = (await scrollState(page)).height;
      const moved = Object.keys(topsA).filter((file) => Math.abs(topsA[file] - topsB[file]) > 1);
      expect(moved).toEqual([]);
      expect(Math.abs(extentA - extentB)).toBeLessThanOrEqual(1);
      expect(Object.keys(topsB)).toHaveLength(MANY.order.length);
    });

    test('an AI-panel click on a finding in a file far away shows its card under the toolbar', async ({ page }) => {
      const line = changedLines(MANY, last).additions[0];
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: last, line_start: line, title: 'Far finding', body: 'A finding in the last file.' }
      ]);
      await page.evaluate(() => window.aiPanel?.expand());
      const item = page.locator(`.finding-item[data-id="${id}"]`);
      await expect(item).toBeVisible();
      await scrollDiffToEdge(page, 'top');

      await item.click();
      const card = inlineSuggestion(page, id);
      await expect(card).toBeVisible();
      // Below the toolbar, in the upper half of what is left of the viewport.
      const landing = async () => {
        const toolbar = await page.locator('.diff-toolbar').boundingBox();
        const box = await card.boundingBox();
        if (!toolbar || !box) return null;
        return { below: box.y - (toolbar.y + toolbar.height), viewport: page.viewportSize().height - (toolbar.y + toolbar.height) };
      };
      await expect.poll(async () => {
        const at = await landing();
        return !!at && at.below >= 0 && at.below < at.viewport / 2;
      }, { timeout: 10000 }).toBe(true);
      // And it is still there once the file's contents have arrived.
      await waitForFileSettled(page, last);
      await scrollSettled(page);
      const settled = await landing();
      expect(settled.below).toBeGreaterThanOrEqual(0);
      expect(settled.below).toBeLessThan(settled.viewport / 2);
    });

    test('an AI-panel click on a finding in a collapsed file expands the file and shows the card', async ({ page }) => {
      const line = changedLines(MANY, middle).additions[0];
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: middle, line_start: line, title: 'Finding in a collapsed file', body: 'Body.' }
      ]);
      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      await expect(inlineSuggestion(page, id)).toBeVisible();
      await fileWrapper(page, middle).locator('.file-collapse-toggle').click();
      await expect(fileWrapper(page, middle)).toHaveClass(/collapsed/);
      await scrollDiffToEdge(page, 'top');

      await page.evaluate(() => window.aiPanel?.expand());
      await page.locator(`.finding-item[data-id="${id}"]`).click();
      await expect(fileWrapper(page, middle)).not.toHaveClass(/collapsed/);
      await expect(inlineSuggestion(page, id)).toBeInViewport();
    });

    test('switching between unified and split keeps the reader\'s place', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      await waitForFileRendered(page, middle);
      await waitForFileSettled(page, middle);
      await scrollSettled(page);
      // Read a little way into the file.
      await scrollDiffTo(page, (await scrollState(page)).top + 230);
      const before = await firstVisibleRow(page);
      const offsetBefore = (await scrollState(page)).top;
      expect(before.file).toBe(middle);

      await setDiffView(page, 'split');
      await scrollSettled(page);

      if (LAYOUT_TOGGLE_KEEPS === 'first-visible-line') {
        const side = before.type === 'change-deletion' ? 'deletions' : 'additions';
        await expect.poll(async () => {
          const now = await rowBox(page, before.file, before.line, side);
          return now ? Math.abs(now.top - before.top) : 999;
        }).toBeLessThan(2);
      } else {
        // Characterization of main: the pixel offset is restored, and the
        // rows above have other heights in the other layout, so the line that
        // was at the top is no longer there.
        expect(Math.abs((await scrollState(page)).top - offsetBefore)).toBeLessThan(2);
      }
      // Either way the diff was not thrown back to its start.
      expect((await scrollState(page)).top).toBeGreaterThan(1000);
      await assertNoOrphanHosts(page);
    });

    test('collapsing the file being read keeps the scroll position; what follows moves up into view', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      await waitForFileRendered(page, middle);
      await waitForFileSettled(page, middle);
      await scrollSettled(page);
      // Scroll 300 px into the file; its header stays pinned under the toolbar.
      await scrollDiffTo(page, (await scrollState(page)).top + 300);
      const inside = await scrollSettled(page);
      const wrapper = fileWrapper(page, middle);
      await expect(wrapper.locator('.d2h-file-header')).toBeInViewport();

      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).toHaveClass(/collapsed/);
      // Characterization of main (ledger H48): nothing scrolls. The collapsed
      // header is left above the viewport, about as far as the reader had
      // scrolled into the file (measured: 359 px above the toolbar's bottom
      // edge, the 300 scrolled plus the toolbar's own height), and a later
      // file is on screen.
      await scrollSettled(page);
      expect(Math.abs((await scrollState(page)).top - inside)).toBeLessThan(2);
      const landing = await headerLanding(page, middle);
      expect(landing.belowPinned).toBeLessThan(-250);
      expect(landing.belowPinned).toBeGreaterThan(-400);
      const top = await firstFileBelowToolbar(page);
      expect(MANY.order.indexOf(top)).toBeGreaterThan(MANY.order.indexOf(middle));
    });
  });
}
