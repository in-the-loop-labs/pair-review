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
  MODES, waitForDiffToRender, setDiffView, seedSuggestions, cleanupAllComments, mockViewedStateApi,
  expandReviewPanel
} from './helpers.js';
import { allCorpora, changedLines, customCorpus, routeDiff, wrappingFilesCorpus } from './fixtures/diffs.js';
import {
  fileWrapper, filesInPane, firstFileBelowToolbar, firstVisibleRow, headerLanding, inlineSuggestion, rowBox, rowCount, scrollDiffTo,
  scrollDiffToEdge, scrollState, waitForFileRendered, waitForFileSettled, assertNoOrphanHosts, clickExpandControl,
  scrollThroughDiff, ensureMounted, lineNumberCell, waitForPaneSettledInPlace
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

/**
 * Watch the pane's `scroll` and `scrollend` events from now on. The function
 * returned waits until no scroll of the pane is in flight: its last
 * `scrollend` is not older than its last `scroll`, for two frames.
 *
 * What a test waits for before it presses a key that scrolls. Chromium drops
 * a scroll key that arrives while the smooth scroll of the key before it is
 * finishing (measured on a page with nothing of the application: 28 of 30
 * Page Ups pressed in the frame the End key's scroll arrived did nothing; 30
 * of 30 pressed after the `scrollend` moved the pane), and a position that
 * has not changed between two looks does not say that scroll is over.
 */
async function watchPaneScrolls(page) {
  const pane = page.locator('#diff-container');
  await pane.evaluate((element) => {
    const seen = { scroll: 0, end: 0 };
    element.addEventListener('scroll', () => { seen.scroll = performance.now(); }, { passive: true });
    element.addEventListener('scrollend', () => { seen.end = performance.now(); });
    window.__paneScrolls = seen;
  });
  return () => pane.evaluate(async () => {
    const seen = window.__paneScrolls;
    for (let quiet = 0; quiet < 2;) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      quiet = seen.end >= seen.scroll ? quiet + 1 : 0;
    }
  });
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
      // Three passes over 60 files are processor-bound (19 s of the default
      // 30 in a full eight-worker run): see chat-file-links.spec.js.
      test.slow();
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
      await expandReviewPanel(page);
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

      await expandReviewPanel(page);
      await page.locator(`.finding-item[data-id="${id}"]`).click();
      await expect(fileWrapper(page, middle)).not.toHaveClass(/collapsed/);
      await expect(inlineSuggestion(page, id)).toBeInViewport();
    });

    test('an AI-panel click on a finding that names its file in another form expands the collapsed file completely', async ({ page }) => {
      // The server keeps a finding's path as the model wrote it and accepts
      // './<path>' for <path>. Such a finding has no card in the diff; its
      // click still opens the file, and must open all of it: the code, and
      // the state behind the header's chevron.
      const line = changedLines(MANY, middle).additions[0];
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: `./${middle}`, line_start: line, title: 'Finding that names its file with a leading dot', body: 'Body.' }
      ]);
      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      await waitForFileRendered(page, middle);
      // The count is compared with the one after the file is opened again:
      // it is taken of the file as it stays, with its contents loaded.
      await waitForFileSettled(page, middle);
      const rowsShown = await rowCount(page, middle);
      expect(rowsShown).toBeGreaterThan(0);
      const toggle = fileWrapper(page, middle).locator('.file-collapse-toggle');
      await toggle.click();
      await expect(fileWrapper(page, middle)).toHaveClass(/collapsed/);
      await expect.poll(() => rowCount(page, middle)).toBe(0);
      await scrollDiffToEdge(page, 'top');

      await expandReviewPanel(page);
      await page.locator(`.finding-item[data-id="${id}"]`).click();
      // The finding has no card, so nothing scrolls to the file: it is opened
      // where it is, 30 files below. What follows needs its element.
      await expect.poll(() => page.evaluate((f) => window.prManager.isFileCollapsed(f), middle)).toBe(false);
      await ensureMounted(page, middle);
      await expect(fileWrapper(page, middle)).not.toHaveClass(/collapsed/);
      await expect.poll(() => rowCount(page, middle)).toBe(rowsShown);
      await expect(toggle).toHaveAttribute('title', 'Collapse file');

      // The file is open for the diff engine too, not only in the page's
      // markup: the next re-render of the file (here the reader expands a
      // gap) draws its code, with the lines of the gap added. An engine
      // still told "collapsed" draws no line at all.
      await waitForFileSettled(page, middle);
      await clickExpandControl(page, middle, 0);
      await expect.poll(() => rowCount(page, middle)).toBeGreaterThan(rowsShown);
      const rowsExpanded = await rowCount(page, middle);

      // And the header agrees with what is shown: one click collapses the
      // file, and the next one shows its code again.
      await toggle.click();
      await expect(fileWrapper(page, middle)).toHaveClass(/collapsed/);
      await expect.poll(() => rowCount(page, middle)).toBe(0);
      await toggle.click();
      await expect(fileWrapper(page, middle)).not.toHaveClass(/collapsed/);
      await expect.poll(() => rowCount(page, middle)).toBe(rowsExpanded);
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
      expect(before.file).toBe(middle);

      await setDiffView(page, 'split');
      await scrollSettled(page);

      const side = before.type === 'change-deletion' ? 'deletions' : 'additions';
      await expect.poll(async () => {
        const now = await rowBox(page, before.file, before.line, side);
        return now ? Math.abs(now.top - before.top) : 999;
      }).toBeLessThan(2);
      // Either way the diff was not thrown back to its start.
      expect((await scrollState(page)).top).toBeGreaterThan(1000);
      await assertNoOrphanHosts(page);
    });

    test('collapsing the file being read: what follows moves up into view', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await expectHeaderFlush(page, middle);
      await waitForFileRendered(page, middle);
      await waitForFileSettled(page, middle);
      await scrollSettled(page);
      // Scroll 300 px into the file; its header stays pinned under the toolbar.
      await scrollDiffTo(page, (await scrollState(page)).top + 300);
      await scrollSettled(page);
      const wrapper = fileWrapper(page, middle);
      await expect(wrapper.locator('.d2h-file-header')).toBeInViewport();

      await wrapper.locator('.file-collapse-toggle').click();
      const next = MANY.order[MANY.order.indexOf(middle) + 1];
      // The header of the file that was collapsed is where it was stuck,
      // flush under the toolbar, and the next file follows it (main's
      // behaviour since v5.4.3; collapse-scroll-anchor.spec.js and
      // collapse-landing.spec.js hold it to the half pixel).
      await expect(wrapper).toHaveClass(/collapsed/);
      await scrollSettled(page);
      const landing = await headerLanding(page, middle);
      expect(Math.abs(landing.belowPinned)).toBeLessThan(2);
      expect(landing.inViewport).toBe(true);
      expect(await firstFileBelowToolbar(page)).toBe(middle);
      const following = await headerLanding(page, next);
      expect(following.inViewport).toBe(true);
      // The collapsed header (53 px) and the 24 px between two files.
      expect(following.belowPinned).toBeGreaterThan(60);
      expect(following.belowPinned).toBeLessThan(100);
    });
  });
}

/** Eight added files whose heights are estimates until the reader gets to them (ledger H163). */
const WRAPPING = wrappingFilesCorpus('wrapping-files');

for (const mode of MODES) {
  test.describe(`The end of the pane (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, WRAPPING.corpus);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    for (const gesture of ['the wheel', 'the End key']) {
      test(`one scroll to the end with ${gesture} ends at the end, with the last line of the last file in view`, async ({ page }) => {
        const before = await scrollState(page);
        const box = await page.locator('#diff-container').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        if (gesture === 'the wheel') {
          await page.mouse.wheel(0, 10000000);
        } else {
          await page.locator('#diff-container').evaluate((pane) => { pane.tabIndex = -1; pane.focus({ preventScroll: true }); });
          await page.keyboard.press('End');
        }
        const top = await scrollSettled(page);
        const after = await scrollState(page);
        // The files at the end were measured after the scroll: the pane is taller than it was estimated...
        expect(after.height).toBeGreaterThan(before.height + 500);
        // ...and the reader is at its end, not where the end was estimated to be.
        expect(Math.round(after.height - after.client - top)).toBeLessThanOrEqual(1);
        await expect(fileWrapper(page, WRAPPING.last)).toBeVisible();
        await expect(lineNumberCell(fileWrapper(page, WRAPPING.last), 600).first()).toBeInViewport();
        await assertNoOrphanHosts(page);
      });
    }

    for (const moment of ['as soon as the End key\'s scroll is over', 'when the pane has come to rest']) {
      test(`a Page Up pressed ${moment} after the End key took the reader to the end is not undone`, async ({ page }) => {
        const before = await scrollState(page);
        const box = await page.locator('#diff-container').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const scrollOver = await watchPaneScrolls(page);
        await page.locator('#diff-container').evaluate((pane) => { pane.tabIndex = -1; pane.focus({ preventScroll: true }); });
        await page.keyboard.press('End');
        // The files at the end were measured, and the reader was kept at the end.
        await expect.poll(async () => {
          const now = await scrollState(page);
          return now.height > before.height + 500 && Math.round(now.height - now.client - now.top) <= 1;
        }, { intervals: [50] }).toBe(true);
        // The browser's own scroll for the End key must be over before the
        // next key (scrollOver; ledger H163). That moment is inside the time
        // the pane is kept at its end; or wait for a full rest.
        await scrollOver();
        if (moment === 'when the pane has come to rest') {
          await scrollSettled(page);
          await scrollOver();
        }
        const short = async () => { const now = await scrollState(page); return Math.round(now.height - now.client - now.top); };
        await page.keyboard.press('PageUp');
        // The scroll of a key begins when the browser gets to it (on a busy
        // machine, later than one look at the position): wait for the move,
        // then for its end, then judge. Judged by the distance from the end
        // and by what is in view: files above may still be measured, which
        // moves the position and not what the reader sees.
        await expect.poll(short, { timeout: 10000 }).toBeGreaterThan(300);
        await scrollOver();
        await scrollSettled(page);
        // The reader went up and stays up: the end of the pane is no longer theirs.
        const first = await short();
        expect(first).toBeGreaterThan(300);
        await expect(lineNumberCell(fileWrapper(page, WRAPPING.last), 600).first()).not.toBeInViewport();
        await scrollOver();
        await page.keyboard.press('PageUp');
        await expect.poll(short, { timeout: 10000 }).toBeGreaterThan(first + 300);
        await scrollOver();
        await scrollSettled(page);
        expect(await short()).toBeGreaterThan(first + 300);
        await assertNoOrphanHosts(page);
      });
    }
  });
}

/**
 * A press on the pane itself at its right edge, where a scrollbar would be.
 * The browser of these tests draws none (a scrollbar with no width of its
 * own, as one drawn over the content has none): what is there is the pane's
 * padding, and a press on it holds nothing. Let go at the pane's bottom edge
 * it was taken for a scrollbar pulled to the end of its track, and the reader
 * was sent to the end of the review (ledger H163; found by the phase-9
 * verifier). tests/e2e/scrollbar-drag.spec.js drags a real thumb.
 */
for (const mode of MODES) {
  test.describe(`A press on the pane's edge that holds no scrollbar (${mode.name})`, () => {
    let pane;
    let box;
    let from;

    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      pane = page.locator('#diff-container');
      // The reader is somewhere in the middle of the review.
      await pane.evaluate((element) => { element.scrollTop = 3000; });
      await expect.poll(async () => (await scrollState(page)).top).toBeGreaterThan(2000);
      // The files drawn there get their contents, and the one the reader is
      // in grows above their line: the position moves once more, by itself.
      await waitForPaneSettledInPlace(page);
      from = await scrollSettled(page);
      box = await pane.boundingBox();
      expect(await pane.evaluate((element) => element.offsetWidth - element.clientWidth)).toBe(0);
      // The pane's position at the release, read in the release's own event.
      await pane.evaluate((element) => {
        window.__paneAtRelease = null;
        window.addEventListener('pointerup', () => { window.__paneAtRelease = element.scrollTop; }, { capture: true, once: true });
      });
    });

    /** Press 5 px inside the pane's right edge and drag to `endX` at the pane's bottom edge, in eight moves a frame apart. */
    async function pressAndDrag(page, endX) {
      const x = box.x + box.width - 5;
      const y = box.y + 200;
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x, y })).toBe('diff-container');
      const endY = box.y + box.height - 0.5;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(x + ((endX - x) * step) / 8, y + ((endY - y) * step) / 8);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      }
    }

    test('dragged straight down to the pane\'s bottom edge and let go, the reader is where they were', async ({ page }) => {
      await pressAndDrag(page, box.x + box.width - 5);
      // Nothing was held: the pane has not moved under the press.
      expect((await scrollState(page)).top).toBe(from);
      await page.mouse.up();
      expect(await page.evaluate(() => window.__paneAtRelease)).toBe(from);
      // A release taken for the scrollbar's writes the end of the pane in its own task.
      expect(await scrollSettled(page)).toBe(from);
      const after = await scrollState(page);
      expect(Math.round(after.height - after.client - after.top)).toBeGreaterThan(10000);
      await assertNoOrphanHosts(page);
    });

    test('dragged down and into the code (a text selection) and let go at the pane\'s bottom edge, the reader is not sent to the end', async ({ page }) => {
      await pressAndDrag(page, box.x + box.width - 400);
      await page.mouse.up();
      const atRelease = await page.evaluate(() => window.__paneAtRelease);
      const top = await scrollSettled(page);
      // The browser scrolls the pane under a selection dragged to its edge,
      // a few lines; at the release that is over, and nothing else moves it.
      expect(Math.abs(top - atRelease)).toBeLessThanOrEqual(120);
      expect(top).toBeLessThan(from + 2000);
      const after = await scrollState(page);
      expect(Math.round(after.height - after.client - after.top)).toBeGreaterThan(10000);
      expect(await page.evaluate(() => String(window.getSelection()).length)).toBeGreaterThan(0);
      await assertNoOrphanHosts(page);
    });
  });
}
