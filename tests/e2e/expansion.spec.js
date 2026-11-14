// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: hidden context and the content upgrade (N12 of plans/codeview-virtualized-diff.md)
 *
 * A file renders from its patch first. Its contents are fetched afterwards
 * and the diff is upgraded with them; only then can hidden lines be expanded.
 * Characterization of main in both modes: no expand controls before the
 * upgrade and controls after it, expansion by step and to the end, a
 * full-width card staying full-width in split layout after an expansion, the
 * gutter button surviving a re-render under a parked pointer, a draft in an
 * open form surviving the upgrade, and the upgrade not landing under a parked
 * pointer.
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, setDiffView, seedComment, reloadComments, cleanupAllComments, holdFileContents
} from './helpers.js';
import { allCorpora, checkRows } from './fixtures/diffs.js';
import {
  fileWrapper, dumpFile, openLineCommentForm, expandControls, clickExpandControl, isLineVisible,
  waitForContentUpgrade, contentsApplied, framesWithoutUpgrade, annotationCell, gutterButtonsState, inlineComment,
  assertNoOrphanHosts, parkPointerOnLine, UPGRADE_WAITS_FOR_FOCUS
} from './diff-dom.js';

const { default: DEFAULT } = allCorpora();
const FILE = 'src/utils.js';

const focusedTag = (page) => page.evaluate(() => {
  const active = document.activeElement;
  return active ? active.tagName : null;
});

for (const mode of MODES) {
  test.describe(`Expansion and content upgrade (${mode.name})`, () => {
    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('hidden lines offer no expand control until the file contents arrive', async ({ page }) => {
      const contents = await holdFileContents(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      const wrapper = fileWrapper(page, FILE);

      // From the patch alone: the gap is announced and cannot be opened.
      const before = await dumpFile(page, FILE);
      expect(before.separators).toEqual(['45 unmodified lines']);
      expect(before.expandControls).toBe(0);
      await expect(expandControls(wrapper)).toHaveCount(0);
      expect(await isLineVisible(page, FILE, 30)).toBe(false);
      expect(checkRows(before, DEFAULT.files[FILE]).mismatches).toEqual([]);

      contents.release();
      await waitForContentUpgrade(page, FILE);
      await expect.poll(async () => expandControls(wrapper).count()).toBeGreaterThan(0);
      // Every patch row is still there after the upgrade.
      const after = await dumpFile(page, FILE);
      expect(checkRows(after, DEFAULT.files[FILE]).mismatches).toEqual([]);
      const key = (row) => `${row.type}:${row.line}:${row.text}`;
      const afterKeys = new Set(after.columns[0].rows.map(key));
      expect(before.columns[0].rows.filter((row) => row.type.startsWith('change')).map(key)
        .filter((k) => !afterKeys.has(k))).toEqual([]);
    });

    test('an expand control reveals a step of hidden lines, and again until the gap is gone', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, FILE);
      const wrapper = fileWrapper(page, FILE);
      const rowsBefore = (await dumpFile(page, FILE)).columns[0].rows.length;
      expect(await isLineVisible(page, FILE, 30)).toBe(false);

      await clickExpandControl(page, FILE, 0);
      await expect.poll(async () => (await dumpFile(page, FILE)).columns[0].rows.length).toBe(rowsBefore + 20);
      const stepped = await dumpFile(page, FILE);
      expect(checkRows(stepped, DEFAULT.files[FILE]).mismatches).toEqual([]);
      expect(stepped.separators).toHaveLength(1);
      expect(stepped.separators[0]).toMatch(/^20 unmodified lines/);

      await clickExpandControl(page, FILE, 0);
      await expect.poll(async () => (await dumpFile(page, FILE)).separators).toEqual([]);
      await expect(expandControls(wrapper)).toHaveCount(0);
      const whole = await dumpFile(page, FILE);
      expect(checkRows(whole, DEFAULT.files[FILE]).mismatches).toEqual([]);
      // The whole new file plus the two deleted lines.
      expect(whole.columns[0].rows.length).toBe(63 + 2);
      expect(await isLineVisible(page, FILE, 30)).toBe(true);
      await assertNoOrphanHosts(page);
    });

    test('a lone card stays stretched across both columns in split layout after an expansion', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      const body = `Stretch after expansion ${Date.now()}`;
      const id = await seedComment(page, mode.reviewId, { file: FILE, line: 3, body });
      await reloadComments(page);
      await expect(inlineComment(page, id)).toBeVisible();
      await setDiffView(page, 'split');
      await waitForContentUpgrade(page, FILE);

      const stretched = async () => {
        const cell = await annotationCell(page, FILE, body);
        return !!cell && cell.diffType === 'split' && cell.hasFullwidthClass && cell.cellWidth / cell.preWidth > 0.9;
      };
      await expect.poll(stretched).toBe(true);

      const rowsBefore = (await dumpFile(page, FILE)).columns.reduce((n, c) => n + c.rows.length, 0);
      await clickExpandControl(page, FILE, 0);
      await expect.poll(async () => (await dumpFile(page, FILE)).columns.reduce((n, c) => n + c.rows.length, 0))
        .toBeGreaterThan(rowsBefore);
      // The rows were re-created by the expansion; the card is stretched again.
      await expect.poll(stretched).toBe(true);
      await expect(inlineComment(page, id)).toBeVisible();
    });

    test('the gutter button stays on the hovered line when the file re-renders under a parked pointer', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, FILE);
      const pointer = await parkPointerOnLine(page, FILE, 5);
      await expect.poll(async () => (await gutterButtonsState(page, pointer)).some((b) => b.visible && !b.stale)).toBe(true);

      // A comment arrives below the hovered line: the file's rows are re-created. The mouse does not move.
      const id = await seedComment(page, mode.reviewId, { file: FILE, line: 6, body: 'Arrives under a parked pointer' });
      await reloadComments(page);
      await expect(inlineComment(page, id)).toBeVisible();
      await expect.poll(async () => {
        const state = await gutterButtonsState(page, pointer);
        return state.some((b) => b.visible && !b.stale) && !state.some((b) => b.stale);
      }).toBe(true);
    });

    test('the upgrade does not land while the pointer is parked on the file, and lands when it leaves', async ({ page }) => {
      // The first file of the diff: nothing above it can grow and push it
      // out from under the pointer when the other file is upgraded.
      const parked = 'src/main.js';
      const contents = await holdFileContents(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await parkPointerOnLine(page, parked, 12);
      const rowsBefore = (await dumpFile(page, parked)).columns[0].rows.length;

      contents.release();
      // 90 frames (about 1.5 s) with the contents available and the pointer still on the file.
      expect(await framesWithoutUpgrade(page, parked, 90)).toBe(90);
      expect((await dumpFile(page, parked)).columns[0].rows.length).toBe(rowsBefore);
      // The other file, which the pointer is not on, was not held back.
      await waitForContentUpgrade(page, FILE);

      await page.mouse.move(5, 500);
      await waitForContentUpgrade(page, parked);
      await expect.poll(async () => expandControls(fileWrapper(page, parked)).count()).toBeGreaterThan(0);
    });

    test('a draft typed before the upgrade is still in the form after it', async ({ page }) => {
      const contents = await holdFileContents(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      const wrapper = fileWrapper(page, FILE);
      await openLineCommentForm(page, { file: FILE, line: 4 });
      const textarea = wrapper.locator('.user-comment-form textarea');
      await textarea.click();
      await page.keyboard.type('half a thought');
      expect(await focusedTag(page)).toBe('TEXTAREA');

      // The pointer leaves the file (so the pointer gate is not what holds the upgrade), the contents arrive.
      await page.mouse.move(5, 500);
      contents.release();

      if (UPGRADE_WAITS_FOR_FOCUS) {
        // Typing is not interrupted: the upgrade waits for the focus to leave.
        expect(await framesWithoutUpgrade(page, FILE, 60)).toBe(60);
        expect(await focusedTag(page)).toBe('TEXTAREA');
        await page.keyboard.type(' finished');
        await expect(textarea).toHaveValue('half a thought finished');
        await page.locator('.diff-toolbar').click({ position: { x: 5, y: 5 } });
        await waitForContentUpgrade(page, FILE);
        await expect(textarea).toHaveValue('half a thought finished');
      } else {
        // Characterization of main: the upgrade lands, the rows are
        // re-created, the form and its text are kept, and the textarea is no
        // longer focused, so further keystrokes go nowhere until it is
        // clicked again.
        await waitForContentUpgrade(page, FILE);
        await expect(textarea).toHaveValue('half a thought');
        await expect.poll(() => focusedTag(page)).not.toBe('TEXTAREA');
        await textarea.click();
        await page.keyboard.press('End');
        await page.keyboard.type(' finished');
        await expect(textarea).toHaveValue('half a thought finished');
      }
      await expect(wrapper.locator('.user-comment-form')).toHaveCount(1);
      expect(await contentsApplied(page, FILE)).toBe(true);
    });
  });
}
