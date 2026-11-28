// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: a line selection never holds a line the diff does not show, in
 * both modes, in unified and split layout (ledger H184).
 *
 * A drag on the line numbers that reaches a "N unmodified lines" separator
 * stops at it: the selection is cut back to the run of shown lines that
 * holds the line the drag started on. Before, the drag crossed the separator
 * in both directions and the comment form posted the hidden lines too (15
 * down to 79 posted 15-79). On main a drag downward across a separator
 * selected nothing and one upward stopped below it.
 *
 * What each test checks is what a reader sees and gets: the selection the
 * application reports with the pointer held and after the release, the rows
 * highlighted at every moment of the drag (none on the far side of the
 * separator, in no frame), where the gutter's + sits, the form the + opens
 * and what Save posts.
 *
 * The corpus is `reviewFixesCorpus` (tests/e2e/fixtures/diffs.js):
 * src/alpha.js shows lines 7-17 and 77-85 once its contents are loaded and
 * hides 18-76 behind a separator (its patch: 8-16 and 78-84). Old and new
 * numbers are the same in it, so a drag in the left column of the split
 * layout has the same lines. Its deleted rows are old 11-13 and 81.
 *
 * A cut end is a row the viewer can put the + on, named in the numbers of
 * the side the drag started on: in unified layout an unchanged row is an
 * additions row, so a drag let go on a deleted row past the separator still
 * has the + on the last row above it (before this was settled the file had
 * no + at all while such a selection lasted), and where old and new numbers
 * differ (shiftedCorpus) the form names the lines that are highlighted.
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, cleanupAllComments, expectResponse, openDiffOptions, mockContextFilesApi, holdFileContents
} from './helpers.js';
import { reviewFixesCorpus, customCorpus, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, contextFile, waitForContentUpgrade, waitForDiffSettled, waitForDiffType, scrollFileIntoView, expandHunkBy,
  isLineVisible, lineSelection, dragLineNumbers, shiftClickLineNumber, dragFromCommentButton, watchSelectedRows,
  selectedRowsWatched, gutterButtonsLine, holdWorkerResults, revealOffHunkLine, upgradeAwaitingDisplay, contentsApplied,
  waitForHighlightedDisplay
} from './diff-dom.js';

const CORPUS = reviewFixesCorpus();
const ALPHA = 'src/alpha.js';
const CONTEXT = 'corpus-evict/context-long.js'; // 240 lines, registered with the test server

const SHIFT = 'src/shift.js';

/**
 * One changed file whose old and new numbers differ: three lines added
 * after old line 11, old line 60 changed (new 63). Its patch shows new 8-17
 * and 60-66 (old 8-14 and 57-63).
 */
function shiftedCorpus() {
  const oldLines = Array.from({ length: 120 }, (_, i) => `const s${i + 1} = ${i + 1};`);
  const added = ['const added1 = 1;', 'const added2 = 2;', 'const added3 = 3;'];
  const newLines = [...oldLines.slice(0, 11), ...added, ...oldLines.slice(11)];
  newLines[62] = 'const s60 = 60 * 2;';
  const context = (lines) => lines.map((line) => ` ${line}`);
  const diff = [
    `diff --git a/${SHIFT} b/${SHIFT}`, 'index 1111111..2222222 100644', `--- a/${SHIFT}`, `+++ b/${SHIFT}`,
    '@@ -8,7 +8,10 @@', ...context(oldLines.slice(7, 11)), ...added.map((line) => `+${line}`), ...context(oldLines.slice(11, 14)),
    '@@ -57,7 +60,7 @@', ...context(oldLines.slice(56, 59)), `-${oldLines[59]}`, `+${newLines[62]}`, ...context(oldLines.slice(60, 63)),
    '',
  ].join('\n');
  return customCorpus({ name: 'line-selection-shift', diff, files: { [SHIFT]: { old: `${oldLines.join('\n')}\n`, new: `${newLines.join('\n')}\n` } } });
}

const RIGHT = (start, end = start) => ({ start, end, side: 'RIGHT' });
const LEFT = (start, end = start) => ({ start, end, side: 'LEFT' });

/**
 * The highlighted states (selectedRowsWatched) that hold rows on both sides
 * of the hidden lines, or a hidden line: `last` is the last line shown above
 * them, `first` the first shown below.
 */
function crossing(states, { last = 17, first = 77 } = {}) {
  return states.filter((state) => (state.some((row) => row.line <= last) && state.some((row) => row.line >= first))
    || state.some((row) => row.line > last && row.line < first));
}

const posted = (page) => expectResponse(page, (r) => /\/comments$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');

/** Click the + of `scope` (where the selection put it) and return the form it opened. */
async function openFormWithPlus(page, scope) {
  const forms = scope.locator('.user-comment-form');
  const before = await forms.count();
  await scope.locator('.pierre-comment-btn').first().click();
  await expect(forms).toHaveCount(before + 1);
  return forms.last();
}

/** What a comment form is for, as it says of itself: first and last line, side. */
const formRange = (form) => form.locator('textarea').evaluate((textarea) => ({
  start: Number(textarea.dataset.line), end: Number(textarea.dataset.lineEnd || textarea.dataset.line), side: textarea.dataset.side,
}));

/** Type into the form, Save, and return what was posted. */
async function save(page, form, text) {
  await form.locator('textarea').fill(text);
  const response = posted(page);
  await form.locator('.save-comment-btn').click();
  const body = (await response).request().postDataJSON();
  await expect(form).toHaveCount(0);
  return { line_start: body.line_start, line_end: body.line_end, side: body.side };
}

async function useSplitLayout(page, fileName = ALPHA) {
  await openDiffOptions(page);
  await page.locator('.diff-view-option[data-diff-view="split"]').click();
  await page.keyboard.press('Escape');
  await waitForDiffType(page, 'split', 5000, { fileName });
  await waitForDiffSettled(page);
}

async function toggleWhitespace(page) {
  await openDiffOptions(page);
  const box = page.locator('.diff-options-popover label', { hasText: 'Hide whitespace changes' }).locator('input[type="checkbox"]');
  const answered = page.waitForResponse((r) => /\/diff$/.test(new URL(r.url()).pathname));
  if (await box.isChecked()) await box.uncheck(); else await box.check();
  await answered;
  await page.keyboard.press('Escape');
  await waitForDiffSettled(page);
}

for (const mode of MODES) {
  test.describe(`A line selection stops at hidden lines (${mode.name})`, () => {
    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test.describe('in a changed file', () => {
      test.beforeEach(async ({ page }) => {
        await routeDiff(page, CORPUS);
        await page.goto(mode.path);
        await waitForDiffToRender(page);
        await cleanupAllComments(page, mode.reviewId);
        await waitForContentUpgrade(page, ALPHA);
        await waitForDiffSettled(page);
        await scrollFileIntoView(page, ALPHA);
        await waitForDiffSettled(page);
      });

      for (const layout of ['unified', 'split']) {
        // In split layout, the same drags in each column (old numbers on the left).
        const columns = layout === 'split' ? ['additions', 'deletions'] : ['additions'];
        test.describe(`${layout} layout`, () => {
          test.beforeEach(async ({ page }) => {
            if (layout === 'split') await useSplitLayout(page);
          });

          for (const column of columns) {
            const S = column === 'deletions' ? LEFT : RIGHT;
            const sideName = column === 'deletions' ? 'LEFT' : 'RIGHT';
            const where = layout === 'split' ? ` (${column === 'deletions' ? 'left' : 'right'} column)` : '';

            test(`15 down to 79${where}: selected, highlighted, commented and posted are 15-17`, async ({ page }) => {
              await watchSelectedRows(page, ALPHA);
              const drag = await dragLineNumbers(page, { file: ALPHA, from: 15, to: 79, side: column });
              const states = await selectedRowsWatched(page);
              expect(drag.held).toEqual(S(15, 17));
              expect(drag.released).toEqual(S(15, 17));
              expect(crossing(states)).toEqual([]);
              expect(states.at(-1).filter((row) => row.side === sideName).map((row) => row.line)).toEqual([15, 16, 17]);
              // The + sits on the selection's last row and opens the range's form.
              expect(await gutterButtonsLine(page, ALPHA)).toEqual({ line: 17, side: sideName });
              const form = await openFormWithPlus(page, fileWrapper(page, ALPHA));
              await expect(form.locator('.line-range-indicator')).toHaveText('Lines 15-17');
              expect(await save(page, form, 'Down to the separator')).toEqual({ line_start: 15, line_end: 17, side: sideName });
            });

            test(`79 up to 15${where}: selected, highlighted, commented and posted are 77-79`, async ({ page }) => {
              await watchSelectedRows(page, ALPHA);
              const drag = await dragLineNumbers(page, { file: ALPHA, from: 79, to: 15, side: column });
              const states = await selectedRowsWatched(page);
              expect(drag.held).toEqual(S(77, 79));
              expect(drag.released).toEqual(S(77, 79));
              expect(crossing(states)).toEqual([]);
              expect(await gutterButtonsLine(page, ALPHA)).toEqual({ line: 79, side: sideName });
              const form = await openFormWithPlus(page, fileWrapper(page, ALPHA));
              await expect(form.locator('.line-range-indicator')).toHaveText('Lines 77-79');
              expect(await save(page, form, 'Up to the separator')).toEqual({ line_start: 77, line_end: 79, side: sideName });
            });
          }

          test('from the line next to the separator across it, either way: the one line the drag started on, and a one-line form', async ({ page }) => {
            for (const [from, to] of [[17, 77], [77, 17]]) {
              await watchSelectedRows(page, ALPHA);
              const drag = await dragLineNumbers(page, { file: ALPHA, from, to });
              const states = await selectedRowsWatched(page);
              expect(drag.held, `${from} to ${to}`).toEqual(RIGHT(from));
              expect(drag.released, `${from} to ${to}`).toEqual(RIGHT(from));
              expect(crossing(states)).toEqual([]);
              const form = await openFormWithPlus(page, fileWrapper(page, ALPHA));
              await expect(form.locator('.line-range-indicator')).toHaveCount(0);
              expect(await formRange(form)).toEqual(RIGHT(from));
              await form.locator('.cancel-comment-btn').click();
              await expect(form).toHaveCount(0);
            }
          });

          test('inside one hunk the selection is the lines dragged over (11 to 13)', async ({ page }) => {
            const drag = await dragLineNumbers(page, { file: ALPHA, from: 11, to: 13 });
            expect(drag.released).toEqual(RIGHT(11, 13));
          });

          if (layout === 'split') {
            test('from one column into the other across the separator: the selection ends at the last row above it in the column it started in', async ({ page }) => {
              for (const [side, toSide, S, sideName] of [['deletions', 'additions', LEFT, 'LEFT'], ['additions', 'deletions', RIGHT, 'RIGHT']]) {
                await watchSelectedRows(page, ALPHA);
                const drag = await dragLineNumbers(page, { file: ALPHA, from: 15, side, to: 79, toSide });
                const states = await selectedRowsWatched(page);
                // The cut end is named in the start's column, so that one
                // side's numbers name the whole range (H184).
                expect(drag.released, side).toEqual(S(15, 17));
                expect(crossing(states)).toEqual([]);
                expect(await gutterButtonsLine(page, ALPHA), side).toEqual({ line: 17, side: sideName });
                const form = await openFormWithPlus(page, fileWrapper(page, ALPHA));
                await expect(form.locator('.line-range-indicator')).toHaveText('Lines 15-17');
                expect(await formRange(form), side).toEqual(S(15, 17));
                await form.locator('.cancel-comment-btn').click();
                await expect(form).toHaveCount(0);
              }
            });
          }
        });
      }

      test.describe('unified layout, other gestures', () => {
        test('from a deleted row down past the separator: the selection ends at the last line above it', async ({ page }) => {
          // Let go on line 79, and on the deleted row 81.
          for (const [to, toSide] of [[79, 'additions'], [81, 'deletions']]) {
            await watchSelectedRows(page, ALPHA);
            const drag = await dragLineNumbers(page, { file: ALPHA, from: 12, side: 'deletions', to, toSide });
            const states = await selectedRowsWatched(page);
            expect(drag.released, `to ${to}`).toEqual(LEFT(12, 17));
            expect(crossing(states)).toEqual([]);
            // The + on the last row, as for a release on 17 itself: a range
            // from a deleted row to an unchanged one opens the + row's
            // one-line form (as on main, measured on 8e3c7a0e).
            expect(await gutterButtonsLine(page, ALPHA), `to ${to}`).toEqual({ line: 17, side: 'RIGHT' });
            const form = await openFormWithPlus(page, fileWrapper(page, ALPHA));
            expect(await formRange(form), `to ${to}`).toEqual(RIGHT(17));
            await form.locator('.cancel-comment-btn').click();
            await expect(form).toHaveCount(0);
          }
        });

        test('a drag that ends on a deleted row past the separator: the + on the last row above it, which opens the range\'s form', async ({ page }) => {
          for (const from of [15, 8]) {
            await watchSelectedRows(page, ALPHA);
            const drag = await dragLineNumbers(page, { file: ALPHA, from, to: 81, toSide: 'deletions' });
            const states = await selectedRowsWatched(page);
            expect(drag.held, `from ${from}`).toEqual(RIGHT(from, 17));
            expect(drag.released, `from ${from}`).toEqual(RIGHT(from, 17));
            expect(crossing(states)).toEqual([]);
            expect(await gutterButtonsLine(page, ALPHA), `from ${from}`).toEqual({ line: 17, side: 'RIGHT' });
            const form = await openFormWithPlus(page, fileWrapper(page, ALPHA));
            await expect(form.locator('.line-range-indicator')).toHaveText(`Lines ${from}-17`);
            expect(await save(page, form, `From ${from} to the deleted row past the separator`))
              .toEqual({ line_start: from, line_end: 17, side: 'RIGHT' });
          }
        });

        test('a shift-click on a deleted row past the separator: the + on the last row above it, which opens the range\'s form', async ({ page }) => {
          expect((await dragLineNumbers(page, { file: ALPHA, from: 14, to: 15 })).released).toEqual(RIGHT(14, 15));
          await watchSelectedRows(page, ALPHA);
          expect(await shiftClickLineNumber(page, { file: ALPHA, line: 81, side: 'deletions' })).toEqual(RIGHT(14, 17));
          expect(crossing(await selectedRowsWatched(page))).toEqual([]);
          expect(await gutterButtonsLine(page, ALPHA)).toEqual({ line: 17, side: 'RIGHT' });
          const form = await openFormWithPlus(page, fileWrapper(page, ALPHA));
          await expect(form.locator('.line-range-indicator')).toHaveText('Lines 14-17');
          expect(await save(page, form, 'Shift-click on the deleted row past the separator')).toEqual({ line_start: 14, line_end: 17, side: 'RIGHT' });
        });

        test('into lines expanded by hand: as far as they go, and from below the separator up to the first of them', async ({ page }) => {
          // The five hidden lines just above the second hunk (72-76).
          await expandHunkBy(page, ALPHA, { hunkIndex: 1, direction: 'down', lines: 5 });
          await expect.poll(() => isLineVisible(page, ALPHA, 72)).toBe(true);
          expect(await isLineVisible(page, ALPHA, 71)).toBe(false);
          expect((await dragLineNumbers(page, { file: ALPHA, from: 72, to: 77 })).released).toEqual(RIGHT(72, 77));
          await watchSelectedRows(page, ALPHA);
          const drag = await dragLineNumbers(page, { file: ALPHA, from: 79, to: 15 });
          const states = await selectedRowsWatched(page);
          expect(drag.released).toEqual(RIGHT(72, 79));
          expect(crossing(states, { last: 17, first: 72 })).toEqual([]);
        });

        test('a shift-click below the separator extends the selection as far as the separator', async ({ page }) => {
          expect((await dragLineNumbers(page, { file: ALPHA, from: 14, to: 15 })).released).toEqual(RIGHT(14, 15));
          await watchSelectedRows(page, ALPHA);
          expect(await shiftClickLineNumber(page, { file: ALPHA, line: 79 })).toEqual(RIGHT(14, 17));
          expect(crossing(await selectedRowsWatched(page))).toEqual([]);
        });

        test('a drag from the + button across the separator holds no line on the far side, either way', async ({ page }) => {
          await watchSelectedRows(page, ALPHA);
          const down = await dragFromCommentButton(page, { file: ALPHA, from: 16, to: 79 });
          const up = await dragFromCommentButton(page, { file: ALPHA, from: 77, to: 15 });
          const states = await selectedRowsWatched(page);
          // Two lines at most (the vendor's limit, ledger H130), and never the far side.
          expect(down.released).toEqual(RIGHT(16, 17));
          expect(up.released).toEqual(RIGHT(77));
          expect(crossing(states)).toEqual([]);
        });

        test('the whitespace toggle puts back only the shown part of a selection over lines expanded by hand', async ({ page }) => {
          // Started below the separator: what is put back ends where it ended, and starts at a shown line.
          await expandHunkBy(page, ALPHA, { hunkIndex: 1, direction: 'down', lines: 5 });
          await expect.poll(() => isLineVisible(page, ALPHA, 72)).toBe(true);
          expect((await dragLineNumbers(page, { file: ALPHA, from: 79, to: 72 })).released).toEqual(RIGHT(72, 79));
          await toggleWhitespace(page);
          // The pane is rebuilt from the new answer: a list write, whose diff has no expanded lines.
          await expect.poll(() => isLineVisible(page, ALPHA, 72)).toBe(false);
          const kept = await lineSelection(page, ALPHA);
          expect(kept).not.toBeNull();
          expect(kept.end).toBe(79);
          for (let line = kept.start; line <= kept.end; line++) expect(await isLineVisible(page, ALPHA, line), `line ${line}`).toBe(true);

          // Started on an expanded line: nothing of it is put back.
          await expandHunkBy(page, ALPHA, { hunkIndex: 1, direction: 'down', lines: 5 });
          await expect.poll(() => isLineVisible(page, ALPHA, 72)).toBe(true);
          expect((await dragLineNumbers(page, { file: ALPHA, from: 72, to: 79 })).released).toEqual(RIGHT(72, 79));
          await toggleWhitespace(page);
          await expect.poll(() => isLineVisible(page, ALPHA, 72)).toBe(false);
          expect(await lineSelection(page, ALPHA)).toBeNull();
        });
      });
    });

    test.describe('where old and new numbers differ', () => {
      // src/shift.js: three lines added after old line 11 (new 12-14), old
      // line 60 changed (new 63). With its contents: new 8-18 and 59-67 are
      // old 8-15 and 56-64, the lines between hidden.
      test.beforeEach(async ({ page }) => {
        await routeDiff(page, shiftedCorpus());
        await page.goto(mode.path);
        await waitForDiffToRender(page);
        await cleanupAllComments(page, mode.reviewId);
        await waitForContentUpgrade(page, SHIFT);
        await waitForDiffSettled(page);
        await scrollFileIntoView(page, SHIFT);
        await waitForDiffSettled(page);
      });

      /** Drag, then check the selection, the + and the form against `expected` (S(start, end)) and `plus`. */
      async function dragAndOpen(page, gesture, expected, plus) {
        await watchSelectedRows(page, SHIFT);
        const drag = await dragLineNumbers(page, { file: SHIFT, ...gesture });
        const states = await selectedRowsWatched(page);
        const name = JSON.stringify(gesture);
        expect(drag.released, name).toEqual(expected);
        expect(crossing(states, { last: 18, first: 56 }), name).toEqual([]);
        expect(await gutterButtonsLine(page, SHIFT), name).toEqual(plus);
        const form = await openFormWithPlus(page, fileWrapper(page, SHIFT));
        await expect(form.locator('.line-range-indicator')).toHaveText(`Lines ${expected.start}-${expected.end}`);
        expect(await formRange(form), name).toEqual(expected);
        await form.locator('.cancel-comment-btn').click();
        await expect(form).toHaveCount(0);
      }

      test('unified layout: a range cut at the separator is in the numbers of the side it started on', async ({ page }) => {
        // Down from new 12 to the deleted old 60: the last row above is new 18 (old 15).
        await dragAndOpen(page, { from: 12, to: 60, toSide: 'deletions' }, RIGHT(12, 18), { line: 18, side: 'RIGHT' });
        // Up from the deleted old 60 to new 12: the first row below is old 56 (new 59).
        await dragAndOpen(page, { from: 60, side: 'deletions', to: 12, toSide: 'additions' }, LEFT(56, 60), { line: 60, side: 'LEFT' });
      });

      test('split layout: a drag from one column into the other is cut in the column it started in', async ({ page }) => {
        await useSplitLayout(page, SHIFT);
        await dragAndOpen(page, { from: 12, to: 61, toSide: 'deletions' }, RIGHT(12, 18), { line: 18, side: 'RIGHT' });
        await dragAndOpen(page, { from: 64, to: 10, toSide: 'deletions' }, RIGHT(59, 64), { line: 64, side: 'RIGHT' });
        await dragAndOpen(page, { from: 10, side: 'deletions', to: 64, toSide: 'additions' }, LEFT(10, 15), { line: 15, side: 'LEFT' });
        await dragAndOpen(page, { from: 61, side: 'deletions', to: 12, toSide: 'additions' }, LEFT(56, 61), { line: 61, side: 'LEFT' });
      });
    });

    test.describe('in a context file', () => {
      test('a drag across the gap between two ranges stops at it, both ways', async ({ page }) => {
        const contextApi = await mockContextFilesApi(page, { diffFiles: CORPUS.order });
        contextApi.add({ review_id: mode.reviewId, file: CONTEXT, line_start: 10, line_end: 20 });
        contextApi.add({ review_id: mode.reviewId, file: CONTEXT, line_start: 28, line_end: 40 });
        await routeDiff(page, CORPUS);
        await page.goto(mode.path);
        await waitForDiffToRender(page);
        await cleanupAllComments(page, mode.reviewId);
        await waitForDiffSettled(page);
        await scrollFileIntoView(page, CONTEXT);
        await waitForDiffSettled(page);

        await watchSelectedRows(page, CONTEXT);
        const down = await dragLineNumbers(page, { file: CONTEXT, from: 15, to: 35, context: true });
        const states = await selectedRowsWatched(page);
        expect(down.released).toEqual(RIGHT(15, 20));
        expect(crossing(states, { last: 20, first: 28 })).toEqual([]);
        const form = await openFormWithPlus(page, contextFile(page, CONTEXT));
        await expect(form.locator('.line-range-indicator')).toHaveText('Lines 15-20');
        expect(await save(page, form, 'Down to the gap')).toEqual({ line_start: 15, line_end: 20, side: 'RIGHT' });

        const up = await dragLineNumbers(page, { file: CONTEXT, from: 35, to: 15, context: true });
        expect(up.released).toEqual(RIGHT(28, 35));
      });
    });

    test.describe('while the file still draws the diff before its new one', () => {
      test('a drag is cut at what is drawn, and the selection is right once the new diff is drawn', async ({ page }) => {
        await routeDiff(page, CORPUS);
        const contents = await holdFileContents(page);
        await page.goto(mode.path);
        await waitForDiffToRender(page);
        await cleanupAllComments(page, mode.reviewId);
        await scrollFileIntoView(page, ALPHA);
        // The patch's diff (8-16 and 78-84) is drawn and highlighted; its contents are held.
        await waitForHighlightedDisplay(page, ALPHA);
        const workers = await holdWorkerResults(page);
        // A reveal of the whole gap loads the contents first; the new diff then waits for its highlight.
        const revealed = revealOffHunkLine(page, ALPHA, 18, { lineEnd: 76 });
        contents.release();
        await revealed;
        expect(await contentsApplied(page, ALPHA)).toBe(true);
        expect(await isLineVisible(page, ALPHA, 40)).toBe(true);
        expect(await upgradeAwaitingDisplay(page, ALPHA)).toBe(true);

        await watchSelectedRows(page, ALPHA);
        const drag = await dragLineNumbers(page, { file: ALPHA, from: 15, to: 79, waitForUpgrade: false });
        const states = await selectedRowsWatched(page);
        // Still the patch's diff on screen, its separator between 16 and 78.
        expect(await upgradeAwaitingDisplay(page, ALPHA)).toBe(true);
        expect(drag.held).toEqual(RIGHT(15, 16));
        expect(drag.released).toEqual(RIGHT(15, 16));
        expect(crossing(states, { last: 16, first: 78 })).toEqual([]);
        expect(await gutterButtonsLine(page, ALPHA)).toEqual({ line: 16, side: 'RIGHT' });

        await workers.release();
        await waitForHighlightedDisplay(page, ALPHA);
        await expect.poll(() => upgradeAwaitingDisplay(page, ALPHA)).toBe(false);
        expect(await lineSelection(page, ALPHA)).toEqual(RIGHT(15, 16));
      });
    });
  });
}
