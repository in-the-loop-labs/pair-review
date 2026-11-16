// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: per-file controls (N3 of plans/codeview-virtualized-diff.md)
 *
 * Characterization of main in both modes: collapse and expand, the Viewed
 * checkbox and its persistence, the sidebar (click to scroll, the active
 * entry, no scroll-spy) and the header chat button.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, enableChat, mockViewedStateApi } from './helpers.js';
import { allCorpora, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, rowCount, waitForFileRendered, waitForContentUpgrade, headerLanding, scrollDiffToEdge,
  scrollState, assertNoOrphanHosts, redrawFile, waitForDiffSettled
} from './diff-dom.js';

const { many: MANY } = allCorpora();
const UTILS = 'src/utils.js';
const MAIN = 'src/main.js';
const sidebarItem = (page, file) => page.locator(`.file-item[data-path="${file}"]`);

// ─── Press, draw, release: with a mouse, a pen and a touch ──────────

/** A spot of the page that is nobody's control: the bottom right corner of the window. */
const SENTINEL_POINT = (page) => {
  const { width, height } = page.viewportSize();
  return { x: width - 12, y: height - 12 };
};

/**
 * Record every `click` that reaches the document, whoever it is sent to and
 * whoever sent it, and put a small element of the test's own in the corner
 * of the window (SENTINEL_POINT): a click on it is the sentinel of
 * clicksOfPressDrawRelease.
 */
async function watchClicks(page) {
  await page.evaluate(() => {
    const sentinel = document.createElement('div');
    sentinel.id = 'e2e-click-sentinel';
    sentinel.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 24px; height: 24px; z-index: 2147483647;';
    document.body.appendChild(sentinel);
    window.__clicksSeen = [];
    document.addEventListener('click', (event) => {
      window.__clicksSeen.push(event.composedPath()[0] === sentinel ? 'sentinel' : 'click');
    }, true);
  });
}

/**
 * One press and release at `at` with a kind of pointer, as the browser
 * receives them from the device; `whileDown` runs between the two.
 *   mouse  a mouse button
 *   pen    a pen the platform reports the way it reports a mouse
 *   touch  one finger (the context needs `hasTouch`)
 */
async function gesture(page, pointer, at, whileDown = async () => {}) {
  if (pointer === 'mouse') {
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await whileDown();
    await page.mouse.up();
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    if (pointer === 'touch') {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
      await whileDown();
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      const event = { x: at.x, y: at.y, pointerType: 'pen', button: 'left', clickCount: 1 };
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, pointerType: 'pen' });
      await session.send('Input.dispatchMouseEvent', { ...event, type: 'mousePressed', buttons: 1 });
      await whileDown();
      await session.send('Input.dispatchMouseEvent', { ...event, type: 'mouseReleased', buttons: 0 });
    }
  } finally {
    await session.detach();
  }
}

/**
 * Press on the middle of `control`, draw the file again, release. Answers
 * how many clicks that made, on anything.
 *
 * "No second click" is not waited for. A second gesture of the same kind is
 * made on the sentinel: the browser delivers what gestures produce in their
 * order, so when the sentinel's click is there, the browser's own click of
 * the first gesture, if it sent one, is there too; and a timer set after
 * that runs after every timer the release of the first gesture set.
 */
async function clicksOfPressDrawRelease(page, pointer, control) {
  const box = await control.boundingBox();
  await page.evaluate(() => { window.__clicksSeen.length = 0; });
  await gesture(page, pointer, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }, () => redrawFile(page, UTILS));
  return clicksBehindSentinel(page, pointer);
}

/**
 * How many clicks the gestures made since `window.__clicksSeen` was emptied
 * have produced, on anything: a gesture on the sentinel, and what was seen
 * by the time its click and a timer set after it have run (see
 * clicksOfPressDrawRelease).
 */
async function clicksBehindSentinel(page, pointer) {
  await gesture(page, pointer, SENTINEL_POINT(page));
  await expect.poll(() => page.evaluate(() => window.__clicksSeen.includes('sentinel'))).toBe(true);
  const seen = await page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve(window.__clicksSeen.slice()), 0)));
  expect(seen.filter((entry) => entry === 'sentinel')).toHaveLength(1);
  return seen.filter((entry) => entry === 'click').length;
}

/** The middle of a control, in whole pixels. */
async function centreOf(control) {
  const box = await control.boundingBox();
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

for (const mode of MODES) {
  test.describe(`File controls (${mode.name})`, () => {
    let viewedApi;

    test.beforeEach(async ({ page }) => {
      viewedApi = await mockViewedStateApi(page);
    });

    async function open(page) {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, UTILS);
      await waitForContentUpgrade(page, MAIN);
    }

    test('the chevron collapses a file to its header and expands it again, leaving other files alone', async ({ page }) => {
      await open(page);
      const wrapper = fileWrapper(page, UTILS);
      const rowsBefore = await rowCount(page, UTILS);
      const otherRows = await rowCount(page, MAIN);
      expect(rowsBefore).toBeGreaterThan(0);

      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).toHaveClass(/collapsed/);
      await expect(wrapper.locator('.file-collapse-toggle')).toHaveAttribute('title', 'Expand file');
      await expect.poll(() => rowCount(page, UTILS)).toBe(0);
      await expect(wrapper.locator('.d2h-file-header')).toBeVisible();
      await expect(fileWrapper(page, MAIN)).not.toHaveClass(/collapsed/);
      expect(await rowCount(page, MAIN)).toBe(otherRows);

      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).not.toHaveClass(/collapsed/);
      await expect(wrapper.locator('.file-collapse-toggle')).toHaveAttribute('title', 'Collapse file');
      await expect.poll(() => rowCount(page, UTILS)).toBe(rowsBefore);
      await assertNoOrphanHosts(page);
    });

    test('clicking the header itself toggles the file too', async ({ page }) => {
      await open(page);
      const wrapper = fileWrapper(page, MAIN);
      await wrapper.locator('.d2h-file-name').click();
      await expect(wrapper).toHaveClass(/collapsed/);
      await expect.poll(() => rowCount(page, MAIN)).toBe(0);
      await wrapper.locator('.d2h-file-name').click();
      await expect(wrapper).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, MAIN);
    });

    test('Viewed collapses the file, marks it in the sidebar, and survives a reload', async ({ page }) => {
      await open(page);
      const wrapper = fileWrapper(page, UTILS);
      await wrapper.locator('.file-viewed-checkbox').check();
      await expect(wrapper).toHaveClass(/collapsed/);
      await expect.poll(() => rowCount(page, UTILS)).toBe(0);
      await expect(sidebarItem(page, UTILS)).toHaveClass(/viewed/);
      await expect(sidebarItem(page, MAIN)).not.toHaveClass(/viewed/);
      // PR mode saves through the API (wait for the save, or the reload
      // aborts it); Local mode writes localStorage.
      if (!mode.local) await expect.poll(() => viewedApi.files).toEqual([UTILS]);

      await page.reload();
      await waitForDiffToRender(page);
      const reloaded = fileWrapper(page, UTILS);
      await expect(reloaded).toHaveClass(/collapsed/);
      await expect(reloaded.locator('.file-viewed-checkbox')).toBeChecked();
      await expect(sidebarItem(page, UTILS)).toHaveClass(/viewed/);
      expect(await rowCount(page, UTILS)).toBe(0);
      await expect(fileWrapper(page, MAIN)).not.toHaveClass(/collapsed/);

      // Un-viewing expands it and shows its rows.
      await reloaded.locator('.file-viewed-checkbox').uncheck();
      await expect(reloaded).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, UTILS);
      await expect(sidebarItem(page, UTILS)).not.toHaveClass(/viewed/);
      if (!mode.local) await expect.poll(() => viewedApi.files).toEqual([]);
    });

    test('a viewed file can be expanded to read without un-viewing it', async ({ page }) => {
      await open(page);
      const wrapper = fileWrapper(page, UTILS);
      await wrapper.locator('.file-viewed-checkbox').check();
      await expect(wrapper).toHaveClass(/collapsed/);
      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, UTILS);
      await expect(wrapper.locator('.file-viewed-checkbox')).toBeChecked();
    });

    test('the header chat button opens the chat panel', async ({ page }) => {
      await open(page);
      await enableChat(page);
      const button = fileWrapper(page, UTILS).locator('.file-header-chat-btn');
      await expect(button).toBeVisible();
      await button.click();
      await expect(page.locator('.chat-panel')).toBeVisible();
      // Opening chat does not collapse or re-render the file away.
      await expect(fileWrapper(page, UTILS)).not.toHaveClass(/collapsed/);
      expect(await rowCount(page, UTILS)).toBeGreaterThan(0);
    });
  });

  test.describe(`A header control pressed while its file is drawn again (${mode.name})`, () => {
    // A file on screen is drawn again whenever something is published on
    // it: its contents arriving, a comment reload, a suggestion that lands.
    // A reader's press and release take long enough for one of those to
    // fall between them. The control must act all the same, and once (a
    // second activation would undo the first on a toggle).
    //
    // With each kind of pointer, because a browser makes the click of a
    // mouse press and the click of a tap in two different ways: for a mouse
    // (and a pen it reports as one) it remembers what was pressed and sends
    // no click if that left the document before the release; for a touch it
    // recognizes the tap after the release and clicks what is under the
    // point then, a few milliseconds later.
    for (const pointer of ['mouse', 'pen', 'touch']) {
      test.describe(`with a ${pointer}`, () => {
        if (pointer === 'touch') test.use({ hasTouch: true });

        test.beforeEach(async ({ page }) => {
          await mockViewedStateApi(page);
          await page.goto(mode.path);
          await waitForDiffToRender(page);
          await waitForContentUpgrade(page, UTILS);
          await waitForContentUpgrade(page, MAIN);
          // Nothing of the page's own is left to draw: the one draw between
          // the press and the release is the test's.
          await waitForDiffSettled(page);
          await watchClicks(page);
          // Not the first gesture of the page: a browser delivers the click
          // of the first tap after a load in the task of the release, and
          // of every later one some milliseconds after it.
          await gesture(page, pointer, SENTINEL_POINT(page));
          await expect.poll(() => page.evaluate(() => window.__clicksSeen.length)).toBe(1);
        });

        test('the chevron: the file collapses, and a plain click expands it again', async ({ page }) => {
          const wrapper = fileWrapper(page, UTILS);
          const chevron = wrapper.locator('.file-collapse-toggle');
          expect(await clicksOfPressDrawRelease(page, pointer, chevron)).toBe(1);
          await expect(wrapper).toHaveClass(/collapsed/);
          await expect(chevron).toHaveAttribute('title', 'Expand file');

          await chevron.click();
          await expect(wrapper).not.toHaveClass(/collapsed/);
          await waitForFileRendered(page, UTILS);

          // And the other way round, on the collapsed file.
          await chevron.click();
          await expect(wrapper).toHaveClass(/collapsed/);
          await assertNoOrphanHosts(page);
        });

        test('the chevron three times, the file drawn in each: collapsed, expanded, collapsed', async ({ page }) => {
          const wrapper = fileWrapper(page, UTILS);
          const chevron = wrapper.locator('.file-collapse-toggle');
          const collapsed = () => page.evaluate((file) => window.prManager.isFileCollapsed(file) === true, UTILS);
          const seen = [];
          for (let press = 0; press < 3; press++) {
            const clicks = await clicksOfPressDrawRelease(page, pointer, chevron);
            seen.push({ clicks, collapsed: await collapsed() });
            if (press === 1) await waitForFileRendered(page, UTILS);
            await waitForDiffSettled(page);
          }
          expect(seen).toEqual([{ clicks: 1, collapsed: true }, { clicks: 1, collapsed: false }, { clicks: 1, collapsed: true }]);
        });

        test('the Viewed checkbox: the file is marked viewed, once', async ({ page }) => {
          const wrapper = fileWrapper(page, UTILS);
          const checkbox = wrapper.locator('.file-viewed-checkbox');
          expect(await clicksOfPressDrawRelease(page, pointer, checkbox)).toBe(1);
          await expect(checkbox).toBeChecked();
          await expect(wrapper).toHaveClass(/collapsed/);
          await expect(sidebarItem(page, UTILS)).toHaveClass(/viewed/);
        });

        test('the file comment button: one form opens in the file', async ({ page }) => {
          const wrapper = fileWrapper(page, UTILS);
          expect(await clicksOfPressDrawRelease(page, pointer, wrapper.locator('.file-header-comment-btn'))).toBe(1);
          await expect(page.locator('#diff-container .file-comment-form')).toHaveCount(1);
          await expect(page.locator('#diff-container .file-comment-form')).toBeVisible();
        });

        test('a click on the header itself: the file collapses', async ({ page }) => {
          const wrapper = fileWrapper(page, UTILS);
          expect(await clicksOfPressDrawRelease(page, pointer, wrapper.locator('.d2h-file-name'))).toBe(1);
          await expect(wrapper).toHaveClass(/collapsed/);
        });

        if (pointer === 'mouse') {
          test('two presses on the chevron with no pause between them, the file drawn in each: two clicks, and the file is as it was', async ({ page }) => {
            // The click that is made up for the first press arrives when the
            // second press is already in progress, and must not be taken for
            // the second press's own.
            const chevron = fileWrapper(page, UTILS).locator('.file-collapse-toggle');
            const at = await centreOf(chevron);
            await page.evaluate(() => { window.__clicksSeen.length = 0; });
            await page.mouse.move(at.x, at.y);
            for (const clickCount of [1, 2]) {
              await page.mouse.down({ clickCount });
              await redrawFile(page, UTILS);
              await page.mouse.up({ clickCount });
            }
            expect(await clicksBehindSentinel(page, pointer)).toBe(2);
            // Collapsed by the first, expanded by the second.
            expect(await page.evaluate((file) => window.prManager.isFileCollapsed(file), UTILS)).toBe(false);
            await expect(chevron).toHaveAttribute('title', 'Collapse file');
          });

          test('a press that opens the context menu acts as it does without a draw: Control held, and the secondary button', async ({ page }) => {
            // With Control held a primary-button press is the context-menu
            // gesture on macOS and a plain click elsewhere; the secondary
            // button never clicks. Whatever the browser makes of each press,
            // a draw of the file between press and release must not change it.
            const chevron = fileWrapper(page, UTILS).locator('.file-collapse-toggle');
            const collapsed = () => page.evaluate((file) => window.prManager.isFileCollapsed(file) === true, UTILS);
            const session = await page.context().newCDPSession(page);
            const press = async (button, modifiers, draw) => {
              const at = await centreOf(chevron);
              const before = await collapsed();
              await page.evaluate(() => { window.__clicksSeen.length = 0; });
              const event = { x: at.x, y: at.y, button, clickCount: 1, modifiers };
              await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
              await session.send('Input.dispatchMouseEvent', { ...event, type: 'mousePressed', buttons: button === 'left' ? 1 : 2 });
              if (draw) await redrawFile(page, UTILS);
              await session.send('Input.dispatchMouseEvent', { ...event, type: 'mouseReleased', buttons: 0 });
              const clicks = await clicksBehindSentinel(page, pointer);
              const toggled = (await collapsed()) !== before;
              await waitForDiffSettled(page);
              return { clicks, toggled };
            };
            try {
              const CONTROL = 2;
              const controlPlain = await press('left', CONTROL, false);
              // One click toggles, none does not: the page did what the browser sent.
              expect(controlPlain.toggled).toBe(controlPlain.clicks === 1);
              expect(await press('left', CONTROL, true)).toEqual(controlPlain);
              expect(await press('right', 0, false)).toEqual({ clicks: 0, toggled: false });
              expect(await press('right', 0, true)).toEqual({ clicks: 0, toggled: false });
            } finally {
              await session.detach();
            }
          });
        }
      });
    }
  });

  test.describe(`Sidebar navigation (${mode.name})`, () => {
    const { first, middle, last } = MANY.roles;

    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test('a click scrolls the file to the top of the diff and marks its entry active', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await expect.poll(async () => Math.abs((await headerLanding(page, middle))?.belowPinned ?? 999)).toBeLessThan(2);
      await expect(sidebarItem(page, middle)).toHaveClass(/active/);
      await expect(page.locator('.file-item.active')).toHaveCount(1);
      await waitForFileRendered(page, middle);

      // Another click moves both.
      await sidebarItem(page, first).click();
      await expect.poll(async () => Math.abs((await headerLanding(page, first))?.belowPinned ?? 999)).toBeLessThan(2);
      await expect(sidebarItem(page, first)).toHaveClass(/active/);
      await expect(sidebarItem(page, middle)).not.toHaveClass(/active/);
    });

    test('the last file is reachable: its entry scrolls it into view and renders it', async ({ page }) => {
      await sidebarItem(page, last).click();
      await waitForFileRendered(page, last);
      await expect.poll(async () => (await headerLanding(page, last))?.inViewport).toBe(true);
      await expect(sidebarItem(page, last)).toHaveClass(/active/);
    });

    test('there is no scroll-spy: scrolling the diff does not move the active entry', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await expect(sidebarItem(page, middle)).toHaveClass(/active/);
      await expect.poll(async () => Math.abs((await headerLanding(page, middle))?.belowPinned ?? 999)).toBeLessThan(2);

      await scrollDiffToEdge(page, 'top');
      await expect.poll(async () => (await scrollState(page)).top).toBe(0);
      await expect.poll(async () => (await headerLanding(page, first))?.inViewport).toBe(true);
      // Two frames for anything that would react to the scroll.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect(sidebarItem(page, middle)).toHaveClass(/active/);
      await expect(sidebarItem(page, first)).not.toHaveClass(/active/);
    });
  });
}
