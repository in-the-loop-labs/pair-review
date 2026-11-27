// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: the block the suggestion button inserts holds every line of the
 * comment's range, one line each, or the button refuses; in both modes.
 *
 * The block is built from the diff's data (ledger H181): a line in a hunk
 * from the hunk, a line between hunks that the file draws (lines expanded
 * by hand, a small gap of a context file drawn in full) from the file's
 * contents. Each line loses its line ending before the lines are joined
 * (vendor fact F32: parsed lines keep theirs). Before, a block of three
 * lines had an empty line after each (on main too), and a range across
 * drawn lines outside the hunks lost them. A range with a line the diff
 * does not show (a drag across a separator; a comment saved over a gap)
 * gets no block: a warning, and the text is left as it was. Before, it got
 * the lines of the hunks only: applied on GitHub, the block deleted the
 * others.
 *
 * The corpus is `reviewFixesCorpus` (tests/e2e/fixtures/diffs.js), and a
 * registered context file.
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, seedComment, reloadComments, cleanupAllComments, expectResponse, mockContextFilesApi
} from './helpers.js';
import { reviewFixesCorpus, routeDiff, fileLinesFor } from './fixtures/diffs.js';
import {
  fileWrapper, fileSelector, contextFileSelector, lineCards, openLineCommentForm, selectLineRange,
  waitForContentUpgrade, waitForDiffSettled, expandHunkBy, isLineVisible, scrollFileIntoView
} from './diff-dom.js';

const CORPUS = reviewFixesCorpus();
const ALPHA = 'src/alpha.js';
const CONTEXT = 'corpus-evict/context-long.js'; // 240 lines, registered with the test server
const contextLines = fileLinesFor(CONTEXT);

/** The new text of line n of src/alpha.js. */
const alpha = (n) => ([11, 12, 13, 81].includes(n) ? `const alpha${n} = ${n} * 2;` : `const alpha${n} = ${n};`);
const block = (lines) => `\`\`\`suggestion\n${lines.join('\n')}\n\`\`\``;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const REFUSAL = (from, to) => `Cannot insert a suggestion for lines ${from}-${to}: the diff does not show the text of every line of the range. Expand the hidden lines first.`;

const savedComments = (page, reviewId) => page.evaluate(async (rid) => {
  const response = await fetch(`/api/reviews/${rid}/comments`);
  return (await response.json()).comments || [];
}, reviewId);

/** Open the edit form of a user comment card; returns the form. */
async function editComment(page, card) {
  await card.locator('.btn-edit-comment').click();
  const form = card.locator('.user-comment-edit-form');
  await expect(form).toBeVisible();
  return form;
}

for (const mode of MODES) {
  test.describe(`The suggestion block (${mode.name})`, () => {
    let contextApi;

    test.beforeEach(async ({ page }) => {
      contextApi = await mockContextFilesApi(page, { diffFiles: CORPUS.order });
      await routeDiff(page, CORPUS);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await waitForContentUpgrade(page, ALPHA);
      await waitForDiffSettled(page);
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('three selected lines of a hunk give a block of exactly those three lines, and that is what is saved', async ({ page }) => {
      await selectLineRange(page, { file: ALPHA, start: 11, end: 13 });
      await openLineCommentForm(page, { file: ALPHA, line: 12 });
      const form = fileWrapper(page, ALPHA).locator('.user-comment-form');
      await expect(form.locator('.line-range-indicator')).toHaveText('Lines 11-13');
      await form.locator('.suggestion-btn').click();
      const expected = block([alpha(11), alpha(12), alpha(13)]);
      await expect(form.locator('textarea')).toHaveValue(expected);

      // The reader writes a line after the block (Save waits for typed text).
      await form.locator('textarea').evaluate((textarea) => textarea.setSelectionRange(textarea.value.length, textarea.value.length));
      await form.locator('textarea').pressSequentially('\nPlease apply.');
      const saved = expectResponse(page, (r) => /\/comments$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
      await form.locator('.save-comment-btn').click();
      expect((await saved).request().postDataJSON().body).toBe(`${expected}\nPlease apply.`);
      await expect(fileWrapper(page, ALPHA).locator('.user-comment-row')).toHaveCount(1);
      expect((await savedComments(page, mode.reviewId)).map((c) => c.body)).toEqual([`${expected}\nPlease apply.`]);
    });

    test('a range from a hunk into lines expanded by hand gives a block with every line of it', async ({ page }) => {
      // The five hidden lines just above the second hunk (72-76; its first line is 77 once the file has its contents).
      expect(await isLineVisible(page, ALPHA, 72)).toBe(false);
      await expandHunkBy(page, ALPHA, { hunkIndex: 1, direction: 'down', lines: 5 });
      await expect.poll(() => isLineVisible(page, ALPHA, 72)).toBe(true);
      expect(await isLineVisible(page, ALPHA, 71)).toBe(false);
      await selectLineRange(page, { file: ALPHA, start: 72, end: 77 });
      await openLineCommentForm(page, { file: ALPHA, line: 77 });
      const form = fileWrapper(page, ALPHA).locator('.user-comment-form');
      await expect(form.locator('.line-range-indicator')).toHaveText('Lines 72-77');
      await form.locator('.suggestion-btn').click();
      await expect(form.locator('textarea')).toHaveValue(block(range(72, 77).map(alpha)));
    });

    test('a range dragged across a separator gets no block: a warning, and the form as it was', async ({ page }) => {
      // The drag crosses the hidden lines 18-76 (on main a drag stopped at a separator).
      await selectLineRange(page, { file: ALPHA, start: 15, end: 79 });
      await openLineCommentForm(page, { file: ALPHA, line: 79 });
      const form = fileWrapper(page, ALPHA).locator('.user-comment-form');
      await expect(form.locator('.line-range-indicator')).toHaveText('Lines 15-79');
      await form.locator('textarea').fill('Typed first');
      await form.locator('.suggestion-btn').click();
      await expect(page.locator('.toast-warning')).toHaveText(REFUSAL(15, 79));
      await expect(form.locator('textarea')).toHaveValue('Typed first');
      await expect(form.locator('.suggestion-btn')).toBeEnabled();
    });

    test('a comment over lines the diff does not show gets no block from its edit form: a warning, and the text as it was', async ({ page }) => {
      // 15-16 and 78-80 are in the hunks; 18-76 are hidden.
      const id = await seedComment(page, mode.reviewId, { file: ALPHA, line: 15, lineEnd: 80, body: 'Over a gap' });
      await reloadComments(page);
      const card = lineCards(page, `.user-comment-row[data-comment-id="${id}"]`, fileSelector(ALPHA));
      await expect(card).toBeVisible();
      expect(await isLineVisible(page, ALPHA, 40)).toBe(false);
      const form = await editComment(page, card);
      await form.locator('.suggestion-btn').click();
      await expect(page.locator('.toast-warning')).toHaveText(REFUSAL(15, 80));
      await expect(form.locator('textarea')).toHaveValue('Over a gap');
      await expect(form.locator('.suggestion-btn')).toBeEnabled();
    });

    test.describe('on a context file', () => {
      async function openWithRanges(page, ranges) {
        for (const [start, end] of ranges) contextApi.add({ review_id: mode.reviewId, file: CONTEXT, line_start: start, line_end: end });
        await page.reload();
        await waitForDiffToRender(page);
        await waitForDiffSettled(page);
      }

      test('a comment across a small gap the file draws in full gets a block with every line of it', async ({ page }) => {
        // 21-23 is a gap of three lines: drawn.
        await openWithRanges(page, [[10, 20], [24, 40]]);
        const id = await seedComment(page, mode.reviewId, { file: CONTEXT, line: 18, lineEnd: 26, body: 'Across the small gap' });
        await reloadComments(page);
        await scrollFileIntoView(page, CONTEXT);
        const card = lineCards(page, `.user-comment-row[data-comment-id="${id}"]`, contextFileSelector(CONTEXT));
        await expect(card).toBeVisible();
        const form = await editComment(page, card);
        await form.locator('textarea').fill('');
        await form.locator('.suggestion-btn').click();
        await expect(form.locator('textarea')).toHaveValue(block(range(18, 26).map((n) => contextLines[n - 1])));
      });

      test('a comment over lines the file does not show gets no block: a warning, and the text as it was', async ({ page }) => {
        // 21-27 is a gap of seven lines: hidden.
        await openWithRanges(page, [[10, 20], [28, 40]]);
        const id = await seedComment(page, mode.reviewId, { file: CONTEXT, line: 18, lineEnd: 30, body: 'Over the hidden gap' });
        await reloadComments(page);
        await scrollFileIntoView(page, CONTEXT);
        const card = lineCards(page, `.user-comment-row[data-comment-id="${id}"]`, contextFileSelector(CONTEXT));
        await expect(card).toBeVisible();
        const form = await editComment(page, card);
        await form.locator('.suggestion-btn').click();
        await expect(page.locator('.toast-warning')).toHaveText(REFUSAL(18, 30));
        await expect(form.locator('textarea')).toHaveValue('Over the hidden gap');
      });
    });
  });
}
