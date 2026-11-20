// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: the diff pane's own scrollbar, pressed and dragged with the mouse
 * (ledger H163 of plans/codeview-virtualized-diff.md).
 *
 * The pane's height is an estimate for every file the viewer has not drawn,
 * and grows when the reader arrives at such a file. While the reader holds the
 * scrollbar's thumb the position is the thumb's: the browser computes it from
 * where the pointer is on the track at every pointer move. Nothing of the
 * application's may write the position during the drag (a write is put back
 * at the next move: the pane jumps there and back), and a thumb dragged up
 * from the bottom must stay where the reader put it.
 *
 * A thumb taken to the end of its track says where the reader is going. The
 * files down there are measured when the thumb arrives, or on its way, which
 * slides the thumb back up under the pointer: held, the reader sees where
 * the thumb is, and when they let go the pane is put at its end (main, whose
 * pane grows by a quarter as much on this review, ends at the end).
 *
 * Headless Chromium hides scrollbars; this file runs with them shown, and
 * gives the pane a classic scrollbar of a known width so the thumb is where
 * the test presses on every platform.
 *
 * And what is not the scrollbar: a press on the pane's padding beside it
 * holds nothing, and its release moves nothing (the last describe, with the
 * scrollbar the application's own style sheet gives the pane; a scrollbar
 * with no width of its own is in tests/e2e/scroll-landing.spec.js).
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, mockViewedStateApi } from './helpers.js';
import { routeDiff, wrappingFilesCorpus } from './fixtures/diffs.js';
import { scrollState, assertNoOrphanHosts, fileWrapper, lineNumberCell } from './diff-dom.js';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const WRAPPING = wrappingFilesCorpus('wrapping-files-scrollbar');
const SCROLLBAR_WIDTH = 16;
const SCROLLBAR_CSS = `
  #diff-container::-webkit-scrollbar { width: ${SCROLLBAR_WIDTH}px; background: #ddd; }
  #diff-container::-webkit-scrollbar-thumb { background: #555; min-height: 40px; }
`;

const short = (state) => Math.round(state.height - state.client - state.top);

/** Wait until the pane has not moved between two looks. */
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
 * Record the pane's position in every frame from now on.
 * `stop` returns how many frames had the pane above where the frame before had it.
 */
async function recordPosition(page) {
  await page.locator('#diff-container').evaluate((pane) => {
    const trace = { tops: [], running: true };
    const tick = () => {
      trace.tops.push(pane.scrollTop);
      if (trace.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__scrollbarDragTrace = trace;
  });
  return () => page.evaluate(() => {
    const trace = window.__scrollbarDragTrace;
    trace.running = false;
    let backward = 0;
    for (let i = 1; i < trace.tops.length; i++) if (trace.tops[i] < trace.tops[i - 1] - 1) backward++;
    return { frames: trace.tops.length, backward };
  });
}

for (const mode of MODES) {
  test.describe(`The pane's scrollbar (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, WRAPPING.corpus);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await page.addStyleTag({ content: SCROLLBAR_CSS });
      await expect.poll(() => page.locator('#diff-container').evaluate((pane) => pane.offsetWidth - pane.clientWidth)).toBe(SCROLLBAR_WIDTH);
    });

    test('the thumb dragged down to the bottom of its track never jumps back, and dragged up from there it stays up', async ({ page }) => {
      const before = await scrollState(page);
      const box = await page.locator('#diff-container').boundingBox();
      const x = box.x + box.width - SCROLLBAR_WIDTH / 2;
      const top = box.y + 10;
      const bottom = box.y + box.height - 3;

      // The press is on the scrollbar: its target is the pane itself.
      await page.locator('#diff-container').evaluate((pane) => {
        pane.addEventListener('pointerdown', (event) => { window.__scrollbarPressTarget = event.target === pane ? 'pane' : event.target.tagName; }, { capture: true, once: true });
      });
      await page.mouse.move(x, top);
      await page.mouse.down();
      expect(await page.evaluate(() => window.__scrollbarPressTarget)).toBe('pane');

      const stop = await recordPosition(page);
      for (let step = 1; step <= 40; step++) {
        await page.mouse.move(x, top + ((bottom - top) * step) / 40);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      }
      // The files down there were drawn and measured on the way: the pane grew under the thumb.
      await expect.poll(async () => (await scrollState(page)).height, { intervals: [50] }).toBeGreaterThan(before.height + 500);
      await scrollSettled(page);
      // A last move at the bottom of the track, as a hand makes, and a rest.
      await page.mouse.move(x, bottom + 1);
      await scrollSettled(page);
      const trace = await stop();
      expect(trace.frames).toBeGreaterThan(40);
      expect(trace.backward).toBe(0);

      // Dragged up, still held: the reader goes up and stays there.
      const down = await scrollState(page);
      for (let step = 1; step <= 6; step++) await page.mouse.move(x, bottom - 4 * step);
      const up = await scrollSettled(page);
      expect(up).toBeLessThan(down.top - 300);
      await page.mouse.up();
      expect(await scrollSettled(page)).toBe(up);
      expect(short(await scrollState(page))).toBeGreaterThan(300);
      await assertNoOrphanHosts(page);
    });

    test('the thumb taken to the bottom of its track in one pull and let go ends at the end of the pane', async ({ page }) => {
      const before = await scrollState(page);
      const box = await page.locator('#diff-container').boundingBox();
      const x = box.x + box.width - SCROLLBAR_WIDTH / 2;
      await page.mouse.move(x, box.y + 10);
      await page.mouse.down();
      // One move: the thumb is at the end of its track before any file down
      // there is drawn, and the pointer two pixels further than the thumb can go.
      const thumb = 40;
      await page.mouse.move(x, box.y + 10 + (box.height - thumb) + 2);
      await expect.poll(async () => (await scrollState(page)).height, { intervals: [50] }).toBeGreaterThan(before.height + 500);
      await scrollSettled(page);
      // Held: the files at the end were measured under the thumb, which slid
      // back up by more than the pointer is ahead of it. The position is the thumb's.
      expect(short(await scrollState(page))).toBeGreaterThan(500);
      await page.mouse.up();
      // Let go: the end of the pane, with the last line of the last file in view.
      await expect.poll(async () => short(await scrollState(page))).toBeLessThanOrEqual(1);
      await scrollSettled(page);
      expect(short(await scrollState(page))).toBeLessThanOrEqual(1);
      await expect(lineNumberCell(fileWrapper(page, WRAPPING.last), 600).first()).toBeInViewport();
      await assertNoOrphanHosts(page);
    });

    test('the thumb dragged down while the pane grows under it, the pointer pulled to the pane\'s bottom edge and let go, ends at the end of the pane', async ({ page }) => {
      const before = await scrollState(page);
      const box = await page.locator('#diff-container').boundingBox();
      const x = box.x + box.width - SCROLLBAR_WIDTH / 2;
      const top = box.y + 10;
      const bottom = box.y + box.height;
      await page.mouse.move(x, top);
      await page.mouse.down();
      const stop = await recordPosition(page);
      for (let step = 1; step <= 40; step++) {
        await page.mouse.move(x, top + ((bottom - top) * step) / 40);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      }
      await expect.poll(async () => (await scrollState(page)).height, { intervals: [50] }).toBeGreaterThan(before.height + 500);
      await scrollSettled(page);
      // Held at the bottom of the track: nothing was written, the position is
      // the thumb's, and the thumb is behind the pointer by what the pane grew.
      const trace = await stop();
      expect(trace.backward).toBe(0);
      expect(short(await scrollState(page))).toBeGreaterThan(500);
      await page.mouse.up();
      await expect.poll(async () => short(await scrollState(page))).toBeLessThanOrEqual(1);
      await scrollSettled(page);
      expect(short(await scrollState(page))).toBeLessThanOrEqual(1);
      await expect(lineNumberCell(fileWrapper(page, WRAPPING.last), 600).first()).toBeInViewport();
      await assertNoOrphanHosts(page);
    });
  });
}

for (const mode of MODES) {
  test.describe(`Beside the pane's scrollbar (${mode.name})`, () => {
    // The scrollbar as the application styles it (public/css/pr.css): 8 px
    // wide, beside the content. The pane's padding begins where it ends.
    const APP_SCROLLBAR_WIDTH = 8;

    test('a press on the pane\'s padding beside the scrollbar, dragged down to the pane\'s bottom edge and let go, leaves the reader where they were', async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, WRAPPING.corpus);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      const pane = page.locator('#diff-container');
      await expect.poll(() => pane.evaluate((element) => element.offsetWidth - element.clientWidth)).toBe(APP_SCROLLBAR_WIDTH);
      await pane.evaluate((element) => { element.scrollTop = 3000; });
      await expect.poll(async () => (await scrollState(page)).top).toBeGreaterThan(2000);
      const from = await scrollSettled(page);
      const box = await pane.boundingBox();
      // 4 px into the padding: not the scrollbar, and the pane itself.
      const x = box.x + box.width - APP_SCROLLBAR_WIDTH - 4;
      const y = box.y + 200;
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x, y })).toBe('diff-container');
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(x, y + ((box.y + box.height - 0.5 - y) * step) / 8);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      }
      // Nothing was held: the pane has not moved under the press.
      expect((await scrollState(page)).top).toBe(from);
      await page.mouse.up();
      // A release taken for the scrollbar's writes the end of the pane in its own task.
      expect(await scrollSettled(page)).toBe(from);
      expect(short(await scrollState(page))).toBeGreaterThan(10000);
      await assertNoOrphanHosts(page);
    });
  });
}
