// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: selecting and copying text (N10 of plans/codeview-virtualized-diff.md)
 *
 * Characterization of main in both modes: code text and comment text can be
 * selected with the pointer and copied, and selecting text is not mistaken
 * for a line selection (no range is selected, no comment form opens).
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, seedComment, reloadComments, cleanupAllComments } from './helpers.js';
import { inlineComment, lineSelection, rowBox, selectedText, waitForContentUpgrade, waitForHighlightedDisplay } from './diff-dom.js';

const FILE = 'src/main.js';
const LINE = 12;
const LINE_TEXT = 'function log(message) {';

const clipboardText = (page) => page.evaluate(() => navigator.clipboard.readText());

/**
 * Make a selection gesture and check its result, again if needed. The rows of
 * a file are re-created whenever its annotations change (comments and
 * suggestions arrive after the diff, and nothing signals the last of them),
 * and a selection in rows that were replaced is gone. A reader would select
 * again; what must hold is that the gesture selects text and that the copy
 * made of that selection is that text. The copy is part of the attempt: a
 * selection lost between the gesture and the copy copies nothing.
 *
 * A drag whose rows are re-created under it leaves a selection behind that
 * reaches from the pressed row to the file's comment zone. A press inside a
 * selection drags that selection instead of starting a new one: at once in
 * Chromium on Linux, and on macOS only when the press is held a moment before
 * the pointer moves (measured: no drag at 0 ms, a drag at 200 ms), which a
 * test's press is not. So an attempt starts with no selection, as a reader's
 * would after a click; the first attempt has none to clear.
 */
async function gesture(page, attempt) {
  await expect(async () => {
    await page.evaluate(() => document.getSelection().removeAllRanges());
    await attempt();
  }).toPass({ timeout: 15000 });
}

for (const mode of MODES) {
  test.describe(`Text selection and copy (${mode.name})`, () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

    test.beforeEach(async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, FILE);
      // The upgraded rows are drawn again when their highlight arrives; a
      // drag made across that draw loses the row it was made on.
      await waitForHighlightedDisplay(page, FILE);
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('a word of code can be selected by double-click and copied', async ({ page }) => {
      await gesture(page, async () => {
        const row = await rowBox(page, FILE, LINE);
        expect(row.text).toContain(LINE_TEXT);
        // Inside the first word of the line ("function").
        await page.mouse.dblclick(row.left + 20, row.top + row.height / 2);
        expect(await selectedText(page)).toBe('function');
        await page.keyboard.press('ControlOrMeta+C');
        expect(await clipboardText(page)).toBe('function');
      });
      // Not a line selection, and nothing opened.
      expect(await lineSelection(page, FILE)).toBeNull();
      await expect(page.locator('.user-comment-form')).toHaveCount(0);
    });

    test('a drag across a line of code selects its text, not the line', async ({ page }) => {
      let selected = '';
      await gesture(page, async () => {
        const row = await rowBox(page, FILE, LINE);
        const y = row.top + row.height / 2;
        // Press on the text itself (a press in the padding before it selects nothing).
        await page.mouse.move(row.left + 30, y);
        await page.mouse.down();
        try {
          await page.mouse.move(row.left + 150, y, { steps: 12 });
        } finally {
          await page.mouse.up();
        }
        selected = await selectedText(page);
        expect(selected.length).toBeGreaterThan(3);
        expect(LINE_TEXT).toContain(selected);
        await page.keyboard.press('ControlOrMeta+C');
        expect(await clipboardText(page)).toBe(selected);
      });
      expect(await lineSelection(page, FILE)).toBeNull();
      await expect(page.locator('.user-comment-form')).toHaveCount(0);
    });

    test('the text of a comment card can be selected and copied', async ({ page }) => {
      const body = 'Selectable comment text';
      const id = await seedComment(page, mode.reviewId, { file: FILE, line: LINE, body });
      await reloadComments(page);
      const text = inlineComment(page, id).locator('.user-comment-body');
      await expect(text).toBeVisible();

      await gesture(page, async () => {
        const box = await text.boundingBox();
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + 1, y);
        await page.mouse.down();
        try {
          await page.mouse.move(box.x + box.width - 4, y, { steps: 12 });
        } finally {
          await page.mouse.up();
        }
        expect((await selectedText(page)).trim()).toBe(body);
        await page.keyboard.press('ControlOrMeta+C');
        expect((await clipboardText(page)).trim()).toBe(body);
      });
      // The card is still a card: selecting its text did not open an editor.
      await expect(page.locator('.user-comment-form')).toHaveCount(0);
      await expect(inlineComment(page, id)).toBeVisible();
    });
  });
}
