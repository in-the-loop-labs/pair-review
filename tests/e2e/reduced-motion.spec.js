// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: the diff pane with the system setting "Reduce motion" on
 * (`prefers-reduced-motion: reduce`), in both modes.
 *
 * pr.css answers the setting with a blanket rule that shortens every
 * transition and animation of the page to 0.01 ms. Applied to the diff
 * pane's viewer, which places what it draws with the `top`, `bottom` and
 * `height` of two elements of its own, it made each move of the viewer's
 * window a transition whose first frame was drawn with the old values: a
 * header drawn 656 px from its place in the frame after a collapse, and
 * holes in the pane while wheeling (ledger H177). The viewer is exempt from
 * the rule; real transitions elsewhere are still shortened.
 *
 * The scenarios are those of collapse-landing.spec.js (the thirty-first of
 * sixty files, from 300 px inside it) and a reader's wheel down the review.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, mockViewedStateApi } from './helpers.js';
import { allCorpora, routeDiff } from './fixtures/diffs.js';
import {
  waitForFileRendered, waitForFileSettled, waitForDiffSettled, scrollState, entryPlace, scrollPaneToEntry,
  watchEntryHeader, watchPaneHoles, ensureContentUpgrades
} from './diff-dom.js';

const { many: MANY } = allCorpora();
const { middle } = MANY.roles;
const entrySelector = (file) => `.d2h-file-wrapper:not(.context-file)[data-file-name="${file}"]`;

/** The pane has stopped moving: two reads 150 ms or more apart give the same scroll position and height. */
async function paneAtRest(page) {
  let seen = null;
  await expect.poll(async () => {
    const now = await scrollState(page);
    const still = !!seen && now.top === seen.top && now.height === seen.height;
    seen = now;
    return still;
  }, { intervals: [150, 150, 150, 250], timeout: 15000 }).toBe(true);
}

/** As collapse-landing.spec.js: the file's header under the toolbar, the files above it with their contents, the reader 300 px inside it. */
async function readInside(page, file) {
  const entry = entrySelector(file);
  await page.evaluate((f) => window.prManager.scrollToFile(f), file);
  await expect.poll(async () => Math.abs((await entryPlace(page, entry)).headerTop ?? 999), { timeout: 10000 }).toBeLessThan(2);
  await waitForFileRendered(page, file);
  await waitForFileSettled(page, file);
  await paneAtRest(page);
  await ensureContentUpgrades(page, MANY.order.slice(0, MANY.order.indexOf(file)));
  await scrollPaneToEntry(page, entry, { inside: 300 });
  await paneAtRest(page);
  await waitForDiffSettled(page);
  await paneAtRest(page);
}

for (const mode of MODES) {
  test.describe(`The diff pane with "Reduce motion" on (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    });

    test('collapsing the thirty-first of sixty files from 300 px inside it keeps its header where it was stuck in every frame drawn', async ({ page }) => {
      const entry = entrySelector(middle);
      await readInside(page, middle);
      const before = await entryPlace(page, entry);
      expect(before.stuck).toBe(true);
      const stopWatching = await watchEntryHeader(page, entry);

      await page.locator(entry).locator('.file-collapse-toggle').click();

      await expect(page.locator(entry)).toHaveClass(/collapsed/);
      await paneAtRest(page);
      await waitForDiffSettled(page);
      await paneAtRest(page);
      const frames = await stopWatching();
      expect(frames.length).toBeGreaterThan(2);
      expect(frames.filter((top) => top === null)).toEqual([]);
      // Before the exemption, one frame drawn right after the click had the
      // header 656 px below the toolbar.
      expect(Math.max(...frames.map((top) => Math.abs(top - before.headerTop)))).toBeLessThan(0.5);
    });

    test('a wheel down the review draws no frame with a hole in the pane', async ({ page }) => {
      await waitForDiffSettled(page);
      await page.locator('.diff-toolbar').click({ position: { x: 5, y: 5 } });
      const box = await page.locator('#diff-container').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300));
      const stopWatching = await watchPaneHoles(page);
      // Sixty steps of 400 px, each given two frames, as a notched wheel turned steadily.
      for (let step = 0; step < 60; step++) {
        await page.mouse.wheel(0, 400);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      const watched = await stopWatching();
      expect((await scrollState(page)).top).toBeGreaterThan(20000);
      expect(watched.frames).toBeGreaterThan(100);
      // Before the exemption, 14 or 15 of about 210 frames.
      expect(watched.holes).toBe(0);
    });

    test('a transition of the page outside the pane is still shortened to nothing', async ({ page }) => {
      // The review panel animates its width and opacity (0.2 s each); the
      // blanket rule makes that one duration of 0.01 ms.
      const transition = await page.locator('.ai-panel').evaluate((panel) => {
        const style = getComputedStyle(panel);
        return { property: style.transitionProperty, duration: style.transitionDuration };
      });
      expect(transition.property).toBe('width, opacity');
      expect(transition.duration.split(',').map((d) => parseFloat(d))).toEqual([0.00001]);
    });
  });
}
