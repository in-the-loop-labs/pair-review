// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: file links in chat messages (N8 of plans/codeview-virtualized-diff.md)
 *
 * A chat message can name a file and lines (`[[file:path:start-end]]`); the
 * chat panel turns that into a link, and a click takes the reader there.
 * Characterization of main in both modes: a link to a visible line, to a line
 * hidden between two hunks (revealed first), to a range, to a file without a
 * line, to a file far away, to a file outside the diff (which becomes a
 * context file), and to a line of an existing context file.
 *
 * There is no chat provider in E2E. The link is produced by the chat panel's
 * own linkifier from message text placed in its message list, and clicked
 * there, so the click runs the panel's real handler.
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, setDiffView, enableChat, mockContextFilesApi, mockViewedStateApi
} from './helpers.js';
import { allCorpora, changedLines, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, contextFile, contextFileState, contextLine, flashedLines, headerLanding, isLineVisible,
  lineNumberCell, scrollDiffToEdge, scrollThroughDiff, scrollState, waitForContentUpgrade,
  expectedPaneOrder, filesInPane, CHAT_LINK_REACHES_UNRENDERED_FILE, REVEALED_LINE_KEEPS_FLASH
} from './diff-dom.js';

const { many: MANY } = allCorpora();
const UTILS = 'src/utils.js';
const MAIN = 'src/main.js';
const CONTEXT = 'corpus-evict/context-long.js'; // 240 lines, not in any diff

/** Open the chat panel and put a message holding `token` in it; returns the link the panel made of it. */
async function chatLink(page, token) {
  await enableChat(page);
  await page.waitForFunction(() => !!window.chatPanel);
  await page.evaluate(() => window.chatPanel.open());
  await expect(page.locator('.chat-panel')).toBeVisible();
  await page.evaluate((text) => {
    const panel = window.chatPanel;
    const message = document.createElement('div');
    message.className = 'chat-panel__message chat-panel__message--assistant';
    message.textContent = `See ${text} for details.`;
    panel.messagesStackEl.appendChild(message);
    panel._linkifyFileReferences(message);
  }, token);
  const link = page.locator('.chat-file-link').last();
  await expect(link).toBeVisible();
  return link;
}

const lineCell = (page, file, line) => lineNumberCell(fileWrapper(page, file), line, { side: 'additions' }).first();

/**
 * Click a link and expect exactly `lines` of `file` to be flashed. The flash
 * is a class on the rows, and a file's rows are re-created whenever its
 * annotations change (nothing signals the last of those after a load); a
 * flash that went with replaced rows is asked for again, as a reader would.
 */
async function clickAndExpectFlash(page, link, file, lines) {
  await expect(async () => {
    await link.click();
    await expect.poll(() => flashedLines(page, file), { timeout: 1500 }).toEqual(lines);
  }).toPass({ timeout: 15000 });
}

/** Wait until the diff has stopped scrolling (navigation scrolls smoothly and then corrects itself). */
async function scrollSettled(page) {
  let last = null;
  await expect.poll(async () => {
    const now = (await scrollState(page)).top;
    const still = now === last;
    last = now;
    return still;
  }, { intervals: [150, 150, 150, 250] }).toBe(true);
}

for (const mode of MODES) {
  test.describe(`Chat file links (${mode.name})`, () => {
    let contextApi;

    test.beforeEach(async ({ page }) => {
      contextApi = await mockContextFilesApi(page, { diffFiles: [MAIN, UTILS] });
      await mockViewedStateApi(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, UTILS);
      await waitForContentUpgrade(page, MAIN);
    });

    test('a link to a line on screen flashes that line', async ({ page }) => {
      const link = await chatLink(page, `[[file:${MAIN}:12]]`);
      await expect(link).toContainText('main.js');
      await clickAndExpectFlash(page, link, MAIN, [12]);
      await expect(lineCell(page, MAIN, 12)).toBeInViewport();
      expect(contextApi.requests.filter((r) => r.method === 'POST')).toEqual([]);
    });

    test('a link to a line hidden between two hunks reveals it, scrolls to it and flashes it', async ({ page }) => {
      expect(await isLineVisible(page, UTILS, 30)).toBe(false);
      const link = await chatLink(page, `[[file:${UTILS}:30]]`);
      await link.click();
      await expect.poll(() => isLineVisible(page, UTILS, 30)).toBe(true);
      await expect(lineCell(page, UTILS, 30)).toBeInViewport();
      // Once the revealed lines are what is drawn:
      await waitForContentUpgrade(page, UTILS);
      await expect(lineCell(page, UTILS, 30)).toBeInViewport();
      if (REVEALED_LINE_KEEPS_FLASH) {
        await expect.poll(() => flashedLines(page, UTILS)).toEqual([30]);
      } else {
        // Characterization of a defect on main (see diff-dom.js): the flash
        // went with the rows that were replaced.
        expect(await flashedLines(page, UTILS)).toEqual([]);
      }
    });

    test('a link to a range flashes every line of it', async ({ page }) => {
      const link = await chatLink(page, `[[file:${UTILS}:4-6]]`);
      await clickAndExpectFlash(page, link, UTILS, [4, 5, 6]);
      await expect(lineCell(page, UTILS, 4)).toBeInViewport();
    });

    test('a link to a file without a line scrolls to the file', async ({ page }) => {
      const link = await chatLink(page, `[[file:${UTILS}]]`);
      await scrollDiffToEdge(page, 'top');
      await link.click();
      await expect.poll(async () => (await headerLanding(page, UTILS))?.inViewport).toBe(true);
      expect(await flashedLines(page, UTILS)).toEqual([]);
    });

    test('a link to a file outside the diff adds it as a context file and shows the range', async ({ page }) => {
      const link = await chatLink(page, `[[file:${CONTEXT}:100-120]]`);
      await link.click();
      await expect(contextFile(page, CONTEXT)).toBeVisible();
      expect((await contextFileState(page, CONTEXT)).ranges).toEqual([{ start: 100, end: 120 }]);
      expect(contextApi.requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
        { file: CONTEXT, line_start: 100, line_end: 120 }
      ]);
      // Where it sits among the changed files is the placement decision (D2).
      expect((await filesInPane(page)).map(({ file, kind }) => ({ file, kind })))
        .toEqual(expectedPaneOrder([MAIN, UTILS], [CONTEXT]));
      await expect(contextLine(page, CONTEXT, 100)).toBeInViewport();
      await expect(page.locator(`.file-item.context-file-item[data-path="${CONTEXT}"]`)).toBeVisible();

      // The same link again goes to the range that is already there: no second request.
      await scrollDiffToEdge(page, 'bottom');
      await link.click();
      await expect(contextLine(page, CONTEXT, 100)).toBeInViewport();
      await expect.poll(() => flashedLines(page, CONTEXT)).toContain(100);
      expect(contextApi.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    });

    test('a link to a line outside the shown range of a context file adds that range to it', async ({ page }) => {
      await (await chatLink(page, `[[file:${CONTEXT}:100-120]]`)).click();
      await expect(contextFile(page, CONTEXT)).toBeVisible();
      const second = await chatLink(page, `[[file:${CONTEXT}:200-210]]`);
      await second.click();
      await expect.poll(async () => (await contextFileState(page, CONTEXT)).ranges)
        .toEqual([{ start: 100, end: 120 }, { start: 200, end: 210 }]);
      await expect(contextLine(page, CONTEXT, 200)).toBeInViewport();
      // One wrapper, two ranges.
      await expect(contextFile(page, CONTEXT)).toHaveCount(1);
    });
  });

  test.describe(`Chat file links in a long diff (${mode.name})`, () => {
    const { middle, last } = MANY.roles;

    test.beforeEach(async ({ page }) => {
      await mockContextFilesApi(page, { diffFiles: MANY.order });
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    /**
     * Read the whole diff once, then go back to its start. On the current
     * engine a file is rendered when it first comes near the viewport and its
     * height is an estimate until then, so a smooth scroll across files that
     * have not rendered yet lands off its target; after one pass every
     * position is final.
     */
    async function readThroughThenReturn(page) {
      await scrollThroughDiff(page);
      await scrollThroughDiff(page);
      await scrollDiffToEdge(page, 'top');
      await scrollSettled(page);
    }

    test('a link to a line in a file the reader has seen and scrolled far away from scrolls back to it and flashes it', async ({ page }) => {
      const line = changedLines(MANY, last).additions[0];
      await readThroughThenReturn(page);
      const link = await chatLink(page, `[[file:${last}:${line}]]`);
      await clickAndExpectFlash(page, link, last, [line]);
      await expect(lineCell(page, last, line)).toBeInViewport();
    });

    test('the same in split layout', async ({ page }) => {
      const line = changedLines(MANY, middle).additions[0];
      await setDiffView(page, 'split');
      await readThroughThenReturn(page);
      const link = await chatLink(page, `[[file:${middle}:${line}]]`);
      await clickAndExpectFlash(page, link, middle, [line]);
      await expect(lineCell(page, middle, line)).toBeInViewport();
    });

    test('a link to a line in a file that has never been on screen', async ({ page }) => {
      const line = changedLines(MANY, last).additions[0];
      const link = await chatLink(page, `[[file:${last}:${line}]]`);
      await link.click();
      if (CHAT_LINK_REACHES_UNRENDERED_FILE) {
        await expect(lineCell(page, last, line)).toBeInViewport();
        await expect.poll(() => flashedLines(page, last)).toEqual([line]);
      } else {
        // Characterization of a defect on main (see diff-dom.js): the diff
        // scrolls toward the file once, usually stopping short of it (in 9 of
        // 10 runs the line was not on screen), and the line is never
        // flashed. No error is shown either.
        await expect(link).not.toHaveClass(/chat-file-link--loading/);
        await expect.poll(async () => (await scrollState(page)).top).toBeGreaterThan(10000);
        await scrollSettled(page);
        expect(await flashedLines(page, last)).toEqual([]);
        await expect(page.locator('.toast-error')).toHaveCount(0);
      }
    });
  });
}
