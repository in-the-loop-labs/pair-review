// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: the last file collapsed at the pane's end, with the files above
 * it still to get their contents (ledger H174)
 *
 * collapse-landing.spec.js states where a collapse at the pane's end lands,
 * on files whose contents never arrive. This spec is about what arrives
 * afterwards. The viewer draws only the files near the viewport, so a file
 * that a collapse brings into view above the collapsed header is drawn from
 * its patch, is given its contents a moment later (ten seconds later while
 * the pointer rests on it, which is where the pointer is after a click on a
 * header that was stuck at the pane's top) and grows. The pane is held at its
 * end through that: the collapsed header stays where the collapse put it, in
 * view.
 *
 * Every scenario keeps the contents back until the collapse is on screen, so
 * that they arrive after it, and waits for the file above to show them
 * before it reads the pane:
 *
 *  - the last changed file of sixty, by its chevron and by "Viewed", with the
 *    pointer taken away and with the pointer left where the click was;
 *  - a context file as the last item of the pane, by both controls;
 *  - the reader scrolls up after the collapse, by the wheel or a key: the
 *    pane is theirs, and stays where they put it;
 *  - a collapse that does not leave the pane at its end: nothing is held.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, mockViewedStateApi, holdFileContents } from './helpers.js';
import { allCorpora, routeDiff } from './fixtures/diffs.js';
import {
  waitForFileRendered, waitForFileSettled, waitForDiffSettled, waitForContentUpgrade, contentsApplied,
  scrollState, entryPlace, scrollPaneToEntry, watchEntryHeader, ensureContentUpgrades, setViewedBox
} from './diff-dom.js';

const { many: MANY } = allCorpora();
const { middle, last: LAST } = MANY.roles;
const ABOVE_LAST = MANY.order[MANY.order.length - 2];
// Sorts after every file of the corpus: the last item of the pane.
const CONTEXT_FILE = 'zz-context/last.js';
const CONTEXT_LINES = 200;

/** Selector of a changed file's entry (never a context entry of the same path). */
const diffEntry = (file) => `.d2h-file-wrapper:not(.context-file)[data-file-name="${file}"]`;
/** Selector of a context file's entry. */
const contextEntry = (file) => `.d2h-file-wrapper.context-file[data-file-name="${file}"]`;
/** Where an entry is, as a reader sees it (entryPlace in diff-dom.js). */
const place = entryPlace;
/** How far the pane is from its end, in px. */
const shortOfEnd = (state) => state.maxScrollTop - state.scrollTop;

/** Wait until the pane neither scrolls nor changes its height. */
async function paneAtRest(page) {
  let seen = null;
  await expect.poll(async () => {
    const now = await scrollState(page);
    const still = !!seen && now.top === seen.top && now.height === seen.height;
    seen = now;
    return still;
  }, { intervals: [150, 150, 150, 250], timeout: 15000 }).toBe(true);
}

/** The height of an entry's element, in px. */
async function entryHeight(page, selector) {
  return page.locator(selector).evaluate((element) => element.getBoundingClientRect().height);
}

/**
 * The reader's own scroll to the end of the pane, by the wheel, and the pane
 * at rest there with the last item showing what it is going to show.
 * @param {import('@playwright/test').Page} page
 * @param {string} lastSelector - the entry of the pane's last item
 * @param {string|null} lastChanged - that item's path when it is a changed file (it gets contents)
 */
async function readToTheEnd(page, lastSelector, lastChanged) {
  const box = await page.locator('#diff-container').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height, 600) / 2);
  await expect(async () => {
    await page.mouse.wheel(0, 200000);
    await expect.poll(async () => {
      const state = await scrollState(page);
      return state.height - state.client - state.top;
    }, { timeout: 2000 }).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 20000 });
  // Off the pane: a pointer that rests on a file keeps that file's contents
  // back for ten seconds, and the last file is to have its own before the
  // collapse. (The click that collapses it brings the pointer back.)
  await page.mouse.move(5, 5);
  await expect(page.locator(lastSelector).locator('.d2h-file-header')).toBeAttached();
  if (lastChanged) await waitForFileRendered(page, lastChanged);
  await paneAtRest(page);
  await waitForDiffSettled(page);
  await paneAtRest(page);
}

/** Collapse an entry with one of its header's two controls. */
async function collapseWith(page, selector, control) {
  if (control === 'its chevron') await page.locator(selector).locator('.file-collapse-toggle').click();
  else await setViewedBox(page.locator(selector));
  await expect(page.locator(selector)).toHaveClass(/collapsed/);
}

/**
 * The state the scenarios start from, asserted: the collapse is on screen at
 * the pane's end with its header in view, and the file above it is drawn
 * from its patch, its contents still to come.
 * @returns {Promise<{landed: Object, aboveHeight: number}>}
 */
async function collapsedAtTheEnd(page, selector, aboveFile) {
  const landed = await place(page, selector);
  expect(shortOfEnd(landed)).toBeLessThanOrEqual(1);
  expect(landed.headerTop).toBeGreaterThan(0);
  expect(landed.headerBottomInViewport).toBe(true);
  await expect(page.locator(diffEntry(aboveFile)).locator('.d2h-file-header')).toBeAttached();
  expect(await contentsApplied(page, aboveFile)).toBe(false);
  return { landed, aboveHeight: await entryHeight(page, diffEntry(aboveFile)) };
}

/** Wait until a file shows its contents and the pane has come to rest after that. */
async function contentsShown(page, file, { timeout = 15000 } = {}) {
  await waitForContentUpgrade(page, file, { timeout });
  await waitForDiffSettled(page, { timeout });
  await paneAtRest(page);
}

/**
 * Serve one context file of CONTEXT_LINES lines, shown whole, that sorts
 * after every changed file.
 * @param {import('@playwright/test').Page} page
 */
async function mockLastContextFile(page) {
  await page.route('**/api/reviews/*/context-files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        contextFiles: [{ id: 1, file: CONTEXT_FILE, line_start: 1, line_end: CONTEXT_LINES }]
      })
    });
  });
  await page.route('**/api/reviews/*/file-content/**', (route) => {
    const lines = Array.from({ length: CONTEXT_LINES }, (_, i) => `const context${i} = ${i};`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ lines }) });
  });
}

for (const mode of MODES) {
  test.describe(`The last file collapsed at the pane's end, the files above still to get their contents (${mode.name})`, () => {
    const entry = diffEntry(LAST);

    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    for (const control of ['its chevron', '"Viewed"']) {
      for (const pointer of ['taken away', 'left where the click was']) {
        test(`collapsed with ${control}, the pointer ${pointer}: when the file above has its contents the header is where the collapse put it and the pane is at its end`, async ({ page }) => {
          // With the pointer resting on the file above, the application holds
          // that file's contents back for ten seconds.
          if (pointer !== 'taken away') test.slow();
          await readToTheEnd(page, entry, LAST);
          const before = await place(page, entry);
          expect(before.stuck).toBe(true);
          // The file above has never been near the viewport.
          expect((await place(page, diffEntry(ABOVE_LAST))).mounted).toBe(false);
          const contents = await holdFileContents(page);

          await collapseWith(page, entry, control);

          const { landed, aboveHeight } = await collapsedAtTheEnd(page, entry, ABOVE_LAST);
          if (pointer === 'taken away') {
            await page.mouse.move(5, 5);
          } else {
            // It is over the file that came up under it.
            await expect.poll(() => page.locator(diffEntry(ABOVE_LAST)).evaluate((element) => element.matches(':hover'))).toBe(true);
          }
          const headerFrames = await watchEntryHeader(page, entry);
          contents.release();
          await contentsShown(page, ABOVE_LAST, { timeout: 25000 });

          // The file above grew; it did not push the collapsed header out.
          expect(await entryHeight(page, diffEntry(ABOVE_LAST))).toBeGreaterThan(aboveHeight + 50);
          const rested = await place(page, entry);
          expect(shortOfEnd(rested)).toBeLessThanOrEqual(1);
          expect(Math.abs(rested.headerTop - landed.headerTop)).toBeLessThanOrEqual(1);
          expect(rested.headerBottomInViewport).toBe(true);
          // And in no frame drawn on the way was it anywhere else.
          const frames = await headerFrames();
          expect(frames.length).toBeGreaterThan(0);
          expect(frames.filter((top) => top === null || Math.abs(top - landed.headerTop) > 1)).toEqual([]);
        });
      }
    }

    for (const input of ['the wheel', 'the Page Up key']) {
      test(`the reader scrolls up with ${input} after the collapse: the pane stays theirs when the file above gets its contents`, async ({ page }) => {
        await readToTheEnd(page, entry, LAST);
        const contents = await holdFileContents(page);
        await collapseWith(page, entry, 'its chevron');
        await collapsedAtTheEnd(page, entry, ABOVE_LAST);

        if (input === 'the wheel') {
          await page.mouse.wheel(0, -240);
        } else {
          await page.locator('#diff-container').evaluate((pane) => { pane.tabIndex = -1; pane.focus({ preventScroll: true }); });
          await page.keyboard.press('PageUp');
        }
        await expect.poll(async () => shortOfEnd(await place(page, entry))).toBeGreaterThan(100);
        await paneAtRest(page);
        const moved = await place(page, entry);

        // The pointer leaves the pane (no input to it): the file above gets
        // its contents at once and not after the ten seconds of a resting pointer.
        await page.mouse.move(5, 5);
        contents.release();
        await contentsShown(page, ABOVE_LAST);

        // Not taken back to the end: at least as far from it as the reader
        // went, and the collapsed header no higher in the pane than they
        // left it. (The file above grew under them; the viewer keeps the
        // line at the pane's top where it is, and what is below moves down.)
        const rested = await place(page, entry);
        expect(shortOfEnd(rested)).toBeGreaterThanOrEqual(shortOfEnd(moved) - 1);
        if (moved.mounted && rested.mounted) expect(rested.headerTop).toBeGreaterThanOrEqual(moved.headerTop - 1);
      });
    }

    test('a collapse that does not leave the pane at its end holds nothing: the pane is where the collapse put it when the files that came into view have their contents', async ({ page }) => {
      const middleEntry = diffEntry(middle);
      await page.evaluate((f) => window.prManager.scrollToFile(f), middle);
      await expect.poll(async () => Math.abs((await place(page, middleEntry)).headerTop ?? 999), { timeout: 10000 }).toBeLessThan(2);
      await waitForFileRendered(page, middle);
      await waitForFileSettled(page, middle);
      await paneAtRest(page);
      // Every file above holds its contents: where a collapse lands, to half
      // a pixel, is not left to which of them the navigation happened to
      // draw (readFile in collapse-landing.spec.js has the arithmetic).
      await ensureContentUpgrades(page, MANY.order.slice(0, MANY.order.indexOf(middle)));
      await scrollPaneToEntry(page, middleEntry, { inside: 300 });
      await paneAtRest(page);
      await waitForDiffSettled(page);
      await paneAtRest(page);
      const before = await place(page, middleEntry);
      expect(before.stuck).toBe(true);
      const contents = await holdFileContents(page);

      await collapseWith(page, middleEntry, 'its chevron');

      const landed = await place(page, middleEntry);
      expect(landed.headerTop).toBeCloseTo(before.headerTop, 0);
      expect(shortOfEnd(landed)).toBeGreaterThan(1000);
      contents.release();
      await waitForDiffSettled(page);
      await paneAtRest(page);

      const rested = await place(page, middleEntry);
      expect(rested.scrollTop).toBe(landed.scrollTop);
      expect(rested.headerTop).toBeCloseTo(landed.headerTop, 0);
    });
  });

  test.describe(`A context file as the last item, collapsed at the pane's end, the file above still to get its contents (${mode.name})`, () => {
    const entry = contextEntry(CONTEXT_FILE);

    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await mockLastContextFile(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    for (const control of ['its chevron', '"Viewed"']) {
      test(`collapsed with ${control}: when the changed file above has its contents the header is where the collapse put it and the pane is at its end`, async ({ page }) => {
        await readToTheEnd(page, entry, null);
        const before = await place(page, entry);
        expect(before.stuck).toBe(true);
        expect((await place(page, diffEntry(LAST))).mounted).toBe(false);
        const contents = await holdFileContents(page);

        await collapseWith(page, entry, control);

        const { landed, aboveHeight } = await collapsedAtTheEnd(page, entry, LAST);
        await page.mouse.move(5, 5);
        const headerFrames = await watchEntryHeader(page, entry);
        contents.release();
        await contentsShown(page, LAST);

        expect(await entryHeight(page, diffEntry(LAST))).toBeGreaterThan(aboveHeight + 50);
        const rested = await place(page, entry);
        expect(shortOfEnd(rested)).toBeLessThanOrEqual(1);
        expect(Math.abs(rested.headerTop - landed.headerTop)).toBeLessThanOrEqual(1);
        expect(rested.headerBottomInViewport).toBe(true);
        const frames = await headerFrames();
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.filter((top) => top === null || Math.abs(top - landed.headerTop) > 1)).toEqual([]);
      });
    }
  });
}
