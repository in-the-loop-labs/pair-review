// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: where the pane is after a file is collapsed or expanded
 *
 * collapse-scroll-anchor.spec.js states the behaviour on three long files: a
 * file collapsed from its stuck header keeps the header where it was stuck,
 * with the next file directly below it; a header that was not stuck does not
 * move; an expand is not anchored. This spec holds the pane to the same
 * behaviour where it is harder to keep:
 *
 *  - in a review of sixty files, from 300 px inside the thirty-first, where
 *    the files below the one being read have no element and no measured
 *    height when it collapses, by the chevron and by "Viewed", in the page
 *    task of the collapse, in every frame drawn after the click and after
 *    the files below have been drawn;
 *  - a header that the last rows of its file have pushed partly above the
 *    toolbar keeps that place too;
 *  - a header that is not stuck: the pane's scroll position is the same number;
 *  - an expand leaves the pane's scroll position alone, also when the
 *    collapsed header was partly covered (it then drops to the toolbar);
 *  - the last file collapsed at the very end of the pane, while the reader's
 *    own scroll to that end is still being followed and after it: the pane
 *    ends at its new end and stays there;
 *  - a context file between two changed files: not stuck, and expanded again.
 *
 * Everything it measures comes from the "collapse landings" block of
 * tests/e2e/diff-dom.js, which uses only what that module has offered since
 * before the pane became a virtualized viewer (the scroll container, the file
 * wrappers, the pinned toolbar). So this file, with that block, runs against
 * the application the behaviour comes from, and passes there.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, mockViewedStateApi } from './helpers.js';
import { allCorpora, customCorpus, routeDiff } from './fixtures/diffs.js';
import {
  waitForFileRendered, waitForFileSettled, waitForDiffSettled, scrollState, scrollDiffTo,
  entryPlace, scrollPaneToEntry, watchEntryHeader, toggleCollapseAndPlaceInOneTask
} from './diff-dom.js';

const { many: MANY } = allCorpora();
const { middle } = MANY.roles;

const LINES_PER_FILE = 200;
const THREE = ['src/first.js', 'src/second.js', 'src/third.js'];
// Sorts between the first and the second changed file.
const CONTEXT_FILE = 'src/gamma.js';

function addedFilePatch(file) {
  const lines = [];
  for (let i = 0; i < LINES_PER_FILE; i++) lines.push(`+const line${i} = ${i};`);
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${LINES_PER_FILE} @@`,
    ...lines
  ].join('\n');
}

const THREE_LONG = customCorpus({
  name: 'collapse-landing-three',
  diff: `${THREE.map(addedFilePatch).join('\n')}\n`,
  files: Object.fromEntries(THREE.map((file) => [
    file,
    { old: null, new: `${Array.from({ length: LINES_PER_FILE }, (_, i) => `const line${i} = ${i};`).join('\n')}\n` }
  ]))
});

/** Selector of a changed file's entry (never a context entry of the same path). */
const diffEntry = (file) => `.d2h-file-wrapper:not(.context-file)[data-file-name="${file}"]`;
/** Selector of a context file's entry. */
const contextEntry = (file) => `.d2h-file-wrapper.context-file[data-file-name="${file}"]`;

/**
 * Serve one context file of LINES_PER_FILE lines, shown whole.
 * @param {import('@playwright/test').Page} page
 */
async function mockContextFile(page) {
  await page.route('**/api/reviews/*/context-files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        contextFiles: [{ id: 1, file: CONTEXT_FILE, line_start: 1, line_end: LINES_PER_FILE }]
      })
    });
  });
  await page.route('**/api/reviews/*/file-content/**', (route) => {
    const lines = Array.from({ length: LINES_PER_FILE }, (_, i) => `const context${i} = ${i};`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ lines }) });
  });
}

/** Where an entry is, as a reader sees it (entryPlace in diff-dom.js). */
const place = entryPlace;

/** Wait until the pane neither scrolls nor changes its height, and return its scroll position. */
async function paneAtRest(page) {
  let seen = null;
  let top = null;
  await expect.poll(async () => {
    const now = await scrollState(page);
    const still = !!seen && now.top === seen.top && now.height === seen.height;
    seen = now;
    top = now.top;
    return still;
  }, { intervals: [150, 150, 150, 250], timeout: 15000 }).toBe(true);
  return top;
}

/**
 * Bring a file's header under the toolbar through the application's own
 * navigation, wait for the file to show what it is going to show, then put
 * the pane where the scenario wants the reader:
 *   { inside: n }      n px into the file (its header is stuck)
 *   { fromBottom: n }  the file ends n px below the toolbar (its last rows push the header up)
 *   { headerAt: n }    the file's header is n px below the toolbar (not stuck)
 */
async function readFile(page, file, selector, where) {
  await page.evaluate((f) => window.prManager.scrollToFile(f), file);
  await expect.poll(async () => Math.abs((await place(page, selector)).headerTop ?? 999), { timeout: 10000 }).toBeLessThan(2);
  await waitForFileRendered(page, file);
  await waitForFileSettled(page, file);
  await paneAtRest(page);
  await scrollPaneToEntry(page, selector, where);
  await paneAtRest(page);
  await waitForDiffSettled(page);
  await paneAtRest(page);
}

for (const mode of MODES) {
  test.describe(`Collapsing a file in a long review: where the pane is afterwards (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    for (const control of ['chevron', 'Viewed']) {
      test(`collapsing the thirty-first of sixty files from 300 px inside it with ${control === 'chevron' ? 'its chevron' : '"Viewed"'} keeps its header where it was stuck, in every frame and after the files below are drawn`, async ({ page }) => {
        const entry = diffEntry(middle);
        await readFile(page, middle, entry, { inside: 300 });
        const before = await place(page, entry);
        expect(before.stuck).toBe(true);
        const stuckTop = before.headerTop;
        const stopWatching = await watchEntryHeader(page, entry);

        if (control === 'chevron') await page.locator(entry).locator('.file-collapse-toggle').click();
        else await page.locator(entry).locator('.file-viewed-checkbox').check();

        await expect(page.locator(entry)).toHaveClass(/collapsed/);
        const landed = await place(page, entry);
        expect(landed.headerTop).toBeCloseTo(stuckTop, 0);
        expect(landed.spacing).toBeGreaterThan(0);
        expect(landed.gapBelow).toBeCloseTo(landed.spacing, 0);

        // The files that have come into view below it are drawn and measured.
        await paneAtRest(page);
        await waitForDiffSettled(page);
        await paneAtRest(page);
        const frames = await stopWatching();
        expect(frames.length).toBeGreaterThan(2);
        expect(frames.filter((top) => top === null)).toEqual([]);
        expect(Math.max(...frames.map((top) => Math.abs(top - stuckTop)))).toBeLessThan(0.5);
        const rested = await place(page, entry);
        expect(rested.headerTop).toBeCloseTo(stuckTop, 0);
        expect(rested.gapBelow).toBeCloseTo(rested.spacing, 0);
      });
    }

    test('the collapsed header is where it was stuck in the page task that collapsed the file, before a frame is drawn', async ({ page }) => {
      const entry = diffEntry(middle);
      await readFile(page, middle, entry, { inside: 300 });
      const before = await place(page, entry);
      expect(before.stuck).toBe(true);

      const sameTask = await toggleCollapseAndPlaceInOneTask(page, middle, entry);

      expect(sameTask.mounted).toBe(true);
      expect(sameTask.collapsed).toBe(true);
      expect(sameTask.headerTop).toBeCloseTo(before.headerTop, 0);
    });

    test('a header that the last rows of its file have pushed partly above the toolbar keeps that place when the file collapses', async ({ page }) => {
      const entry = diffEntry(middle);
      await readFile(page, middle, entry, { fromBottom: 30 });
      const before = await place(page, entry);
      expect(before.stuck).toBe(true);
      // Partly covered: its top is above the toolbar's bottom edge, its bottom below it.
      expect(before.headerTop).toBeLessThan(-1);
      expect(before.headerTop).toBeGreaterThan(-60);

      // What the chevron calls; the chevron itself is under the toolbar here.
      await page.evaluate((f) => window.prManager.toggleFileCollapse(f), middle);

      await expect(page.locator(entry)).toHaveClass(/collapsed/);
      const landed = await place(page, entry);
      expect(landed.headerTop).toBeCloseTo(before.headerTop, 0);
      expect(landed.gapBelow).toBeCloseTo(landed.spacing, 0);
      await paneAtRest(page);
      await waitForDiffSettled(page);
      expect((await place(page, entry)).headerTop).toBeCloseTo(before.headerTop, 0);
    });

    test('collapsing a file whose header is not stuck leaves the pane where it was', async ({ page }) => {
      const entry = diffEntry(middle);
      await readFile(page, middle, entry, { headerAt: 200 });
      const before = await place(page, entry);
      expect(before.stuck).toBe(false);
      expect(before.headerTop).toBeCloseTo(200, 0);

      await page.locator(entry).locator('.file-collapse-toggle').click();

      await expect(page.locator(entry)).toHaveClass(/collapsed/);
      const landed = await place(page, entry);
      expect(landed.scrollTop).toBe(before.scrollTop);
      expect(landed.headerTop).toBeCloseTo(before.headerTop, 0);
      expect(landed.gapBelow).toBeCloseTo(landed.spacing, 0);
      expect(await paneAtRest(page)).toBe(before.scrollTop);
    });

    test('expanding a file leaves the pane\'s scroll position alone, from a stuck place and from a partly covered one', async ({ page }) => {
      const entry = diffEntry(middle);
      // Collapsed from its stuck header: the header is under the toolbar.
      await readFile(page, middle, entry, { inside: 300 });
      await page.locator(entry).locator('.file-collapse-toggle').click();
      await expect(page.locator(entry)).toHaveClass(/collapsed/);
      await waitForDiffSettled(page);
      const collapsedAt = await paneAtRest(page);

      await page.locator(entry).locator('.file-collapse-toggle').click();

      await expect(page.locator(entry)).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, middle);
      expect((await place(page, entry)).scrollTop).toBe(collapsedAt);
      await waitForDiffSettled(page);
      expect(await paneAtRest(page)).toBe(collapsedAt);
      expect((await place(page, entry)).headerTop).toBeCloseTo(0, 0);

      // Collapsed while its header was partly covered: it stays partly
      // covered; expanded, it drops to the toolbar and the pane's scroll
      // position is not corrected for that.
      await readFile(page, middle, entry, { fromBottom: 30 });
      await page.evaluate((f) => window.prManager.toggleFileCollapse(f), middle);
      await expect(page.locator(entry)).toHaveClass(/collapsed/);
      await waitForDiffSettled(page);
      const coveredAt = await paneAtRest(page);
      expect((await place(page, entry)).headerTop).toBeLessThan(-1);

      await page.evaluate((f) => window.prManager.toggleFileCollapse(f), middle);

      await expect(page.locator(entry)).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, middle);
      expect((await place(page, entry)).scrollTop).toBe(coveredAt);
      await waitForDiffSettled(page);
      expect(await paneAtRest(page)).toBe(coveredAt);
      expect((await place(page, entry)).headerTop).toBeCloseTo(0, 0);
    });
  });

  test.describe(`Collapsing the last file at the end of the pane (${mode.name})`, () => {
    const entry = diffEntry(THREE[2]);

    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, THREE_LONG);
      // No file gets its full contents later: what the pane does here is
      // the collapse alone. (Contents that arrive in a file above the
      // collapsed header make that file taller a second or more afterwards,
      // which moves what is below it, on any pane.)
      await page.route('**/api/reviews/*/file-contents/**', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tooLarge: true }) })
      );
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    /** The reader's own scroll to the end of the pane, by the wheel; resolves in the page task that sees the pane there. */
    async function wheelToEnd(page) {
      const box = await page.locator('#diff-container').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height, 600) / 2);
      await expect(async () => {
        await page.mouse.wheel(0, 200000);
        await expect.poll(async () => {
          const state = await scrollState(page);
          return state.height - state.client - state.top;
        }, { timeout: 2000 }).toBeLessThanOrEqual(1);
      }).toPass({ timeout: 20000 });
    }

    for (const moment of ['while that scroll is still being followed', 'once the pane has come to rest']) {
      test(`collapsing it after the reader's scroll to the end, ${moment}, ends at the pane's new end and stays there`, async ({ page }) => {
        await wheelToEnd(page);
        if (moment !== 'while that scroll is still being followed') {
          await waitForFileRendered(page, THREE[2]);
          await paneAtRest(page);
          await waitForDiffSettled(page);
          await paneAtRest(page);
        }
        const before = await place(page, entry);
        expect(before.stuck).toBe(true);

        await page.locator(entry).locator('.file-collapse-toggle').click();

        await expect(page.locator(entry)).toHaveClass(/collapsed/);
        const landed = await place(page, entry);
        // The pane is shorter: it is at its new end, with the collapsed header in view.
        expect(landed.maxScrollTop - landed.scrollTop).toBeLessThanOrEqual(1);
        expect(landed.headerTop).toBeGreaterThan(0);
        expect(landed.headerBottomInViewport).toBe(true);
        expect(landed.gapBelow).toBe(null);
        // Nothing takes it elsewhere afterwards.
        const restedAt = await paneAtRest(page);
        await waitForDiffSettled(page);
        expect(await paneAtRest(page)).toBe(restedAt);
        const rested = await place(page, entry);
        expect(rested.maxScrollTop - rested.scrollTop).toBeLessThanOrEqual(1);
        expect(rested.headerTop).toBeCloseTo(landed.headerTop, 0);
      });
    }
  });

  test.describe(`Collapsing a context file between two changed files (${mode.name})`, () => {
    const entry = contextEntry(CONTEXT_FILE);

    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, THREE_LONG);
      await mockContextFile(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    /** Put the pane so that the context file's header is `headerAt` px below the toolbar, or `inside` px above it. */
    async function readContextFile(page, where) {
      // The context file is below the first changed file: bring it near.
      await expect(async () => {
        const state = await place(page, entry);
        if (!state.mounted) {
          const pane = await scrollState(page);
          await scrollDiffTo(page, pane.top + pane.client);
          throw new Error('the context file is not near the viewport yet');
        }
      }).toPass({ timeout: 15000 });
      await expect(page.locator(entry).locator('.d2h-file-header')).toBeAttached();
      await paneAtRest(page);
      await scrollPaneToEntry(page, entry, where);
      await paneAtRest(page);
      await waitForDiffSettled(page);
      await paneAtRest(page);
    }

    test('marking a context file viewed leaves the pane where it was when its header was not stuck, and so does unmarking it', async ({ page }) => {
      await readContextFile(page, { headerAt: 200 });
      const before = await place(page, entry);
      expect(before.stuck).toBe(false);
      expect(before.scrollTop).toBeGreaterThan(0);

      await page.locator(entry).locator('.file-viewed-checkbox').check();

      await expect(page.locator(entry)).toHaveClass(/collapsed/);
      const landed = await place(page, entry);
      expect(landed.scrollTop).toBe(before.scrollTop);
      expect(landed.headerTop).toBeCloseTo(before.headerTop, 0);
      expect(landed.gapBelow).toBeCloseTo(landed.spacing, 0);
      expect(await paneAtRest(page)).toBe(before.scrollTop);

      // Unmarking expands it again; an expand is not anchored.
      await page.locator(entry).locator('.file-viewed-checkbox').uncheck();

      await expect(page.locator(entry)).not.toHaveClass(/collapsed/);
      expect(await paneAtRest(page)).toBe(before.scrollTop);
      expect((await place(page, entry)).headerTop).toBeCloseTo(before.headerTop, 0);
    });

    test('expanding a context file that was collapsed from its stuck header leaves the pane\'s scroll position alone', async ({ page }) => {
      await readContextFile(page, { inside: 300 });
      const before = await place(page, entry);
      expect(before.stuck).toBe(true);

      await page.locator(entry).locator('.file-collapse-toggle').click();

      await expect(page.locator(entry)).toHaveClass(/collapsed/);
      const landed = await place(page, entry);
      expect(landed.headerTop).toBeCloseTo(before.headerTop, 0);
      expect(landed.gapBelow).toBeCloseTo(landed.spacing, 0);
      const collapsedAt = await paneAtRest(page);

      await page.locator(entry).locator('.file-collapse-toggle').click();

      await expect(page.locator(entry)).not.toHaveClass(/collapsed/);
      expect(await paneAtRest(page)).toBe(collapsedAt);
      expect((await place(page, entry)).headerTop).toBeCloseTo(before.headerTop, 0);
    });
  });
}
