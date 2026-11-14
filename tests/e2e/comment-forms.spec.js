// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: the line comment form (N6 of plans/codeview-virtualized-diff.md)
 *
 * Characterization of main in both modes: Cancel and Escape, several open
 * forms keeping their text while the diff re-renders around them, the
 * suggestion-block button, and range comments made with a real pointer drag
 * (in split layout, and on the deletion side).
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, setDiffView, seedComment, reloadComments, cleanupAllComments, expectResponse
} from './helpers.js';
import { allCorpora, changedLines, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, openLineCommentForm, selectLineRange, lineSelection, inlineComment, expectAnnotationInColumn,
  scrollFileIntoView, waitForContentUpgrade, waitForFileRendered
} from './diff-dom.js';

const { eviction: EVICTION } = allCorpora();
const UTILS = 'src/utils.js';
const MAIN = 'src/main.js';

/** Open a comment form on a line of a file (see `openLineCommentForm`); returns the form. */
async function openFormOn(page, file, line, side = 'additions') {
  await openLineCommentForm(page, { file, line, side });
  return fileWrapper(page, file).locator('.user-comment-form').last();
}

const savedComments = (page, reviewId) => page.evaluate(async (rid) => {
  const response = await fetch(`/api/reviews/${rid}/comments`);
  return (await response.json()).comments || [];
}, reviewId);

for (const mode of MODES) {
  test.describe(`Line comment form (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      // The page loaded before the cleanup: drop what it drew of anything a
      // test that ran earlier in this worker left behind.
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await waitForContentUpgrade(page, UTILS);
      await waitForContentUpgrade(page, MAIN);
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('Cancel closes the form and saves nothing', async ({ page }) => {
      const form = await openFormOn(page, MAIN, 12);
      await form.locator('textarea').fill('Never saved');
      await form.locator('.cancel-comment-btn').click();
      await expect(page.locator('.user-comment-form')).toHaveCount(0);
      await expect(page.locator('.user-comment-row')).toHaveCount(0);
      expect(await savedComments(page, mode.reviewId)).toEqual([]);
      // The line takes a new form afterwards.
      await openFormOn(page, MAIN, 12);
    });

    test('Escape in the textarea closes the form and saves nothing', async ({ page }) => {
      const form = await openFormOn(page, MAIN, 12);
      const textarea = form.locator('textarea');
      await textarea.fill('Never saved either');
      await textarea.press('Escape');
      await expect(page.locator('.user-comment-form')).toHaveCount(0);
      expect(await savedComments(page, mode.reviewId)).toEqual([]);
    });

    test('two open forms keep their text while the diff re-renders around them', async ({ page }) => {
      const formA = await openFormOn(page, UTILS, 4);
      await formA.locator('textarea').fill('Draft in utils');
      const formB = await openFormOn(page, MAIN, 12);
      await formB.locator('textarea').fill('Draft in main');
      const drafts = async () => [
        await fileWrapper(page, UTILS).locator('.user-comment-form textarea').inputValue(),
        await fileWrapper(page, MAIN).locator('.user-comment-form textarea').inputValue()
      ];

      // A comment arrives on one of the files: its annotations change and its rows are re-created.
      const id = await seedComment(page, mode.reviewId, { file: UTILS, line: 6, body: 'Arrived while drafting' });
      await reloadComments(page);
      await expect(inlineComment(page, id)).toBeVisible();
      expect(await drafts()).toEqual(['Draft in utils', 'Draft in main']);

      // Every file is re-rendered in the other layout, and back.
      await setDiffView(page, 'split');
      await expect(page.locator('.user-comment-form')).toHaveCount(2);
      expect(await drafts()).toEqual(['Draft in utils', 'Draft in main']);
      await setDiffView(page, 'unified');
      await expect(page.locator('.user-comment-form')).toHaveCount(2);
      expect(await drafts()).toEqual(['Draft in utils', 'Draft in main']);

      // Saving one leaves the other open with its text.
      const saved = expectResponse(page, (r) => r.url().includes('/comments') && r.request().method() === 'POST');
      await fileWrapper(page, UTILS).locator('.user-comment-form .save-comment-btn').click();
      await saved;
      await expect(page.locator('.user-comment-body', { hasText: 'Draft in utils' })).toBeVisible();
      await expect(page.locator('.user-comment-form')).toHaveCount(1);
      await expect(fileWrapper(page, MAIN).locator('.user-comment-form textarea')).toHaveValue('Draft in main');
    });

    test('the suggestion button inserts a suggestion block holding the line', async ({ page }) => {
      const form = await openFormOn(page, MAIN, 12);
      await form.locator('.suggestion-btn').click();
      const value = await form.locator('textarea').inputValue();
      // Characterization: on main the block holds the line followed by an
      // empty line (the row's text ends in a newline and the block adds its
      // own; ledger H52). The extra line is tolerated here, not required.
      expect(value).toMatch(/```suggestion\nfunction log\(message\) \{\n{1,2}```/);
    });

    test('a range dragged on the additions side in split layout becomes a range comment in that column', async ({ page }) => {
      await setDiffView(page, 'split');
      await selectLineRange(page, { file: UTILS, start: 4, end: 6, side: 'additions' });
      expect(await lineSelection(page, UTILS)).toEqual({ start: 4, end: 6, side: 'RIGHT' });

      const form = await openFormOn(page, UTILS, 5, 'additions');
      await expect(form.locator('.line-range-indicator')).toHaveText('Lines 4-6');
      const body = `Split range ${Date.now()}`;
      await form.locator('textarea').fill(body);
      await form.locator('.save-comment-btn').click();
      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();
      await expectAnnotationInColumn(page, { text: body, column: 'additions' });

      const comment = (await savedComments(page, mode.reviewId)).find((c) => c.body === body);
      expect(comment).toMatchObject({ file: UTILS, line_start: 4, line_end: 6, side: 'RIGHT' });
      // The selection is spent.
      expect(await lineSelection(page, UTILS)).toBeNull();
    });
  });

  test.describe(`Line comment form: deletion-side range (${mode.name})`, () => {
    const file = EVICTION.roles.target;
    // Two consecutive deleted lines of the old file (the second hunk).
    const deletions = changedLines(EVICTION, file).deletions;
    const start = deletions.find((line, i) => deletions[i + 1] === line + 1);

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('a range dragged over deleted lines is saved against the old side', async ({ page }) => {
      await routeDiff(page, EVICTION);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await scrollFileIntoView(page, file);
      await waitForFileRendered(page, file);

      await selectLineRange(page, { file, start, end: start + 1, side: 'deletions' });
      expect(await lineSelection(page, file)).toEqual({ start, end: start + 1, side: 'LEFT' });

      const form = await openFormOn(page, file, start, 'deletions');
      await expect(form.locator('.line-range-indicator')).toHaveText(`Lines ${start}-${start + 1}`);
      const body = `Deleted range ${Date.now()}`;
      await form.locator('textarea').fill(body);
      await form.locator('.save-comment-btn').click();
      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();

      const comment = (await savedComments(page, mode.reviewId)).find((c) => c.body === body);
      expect(comment).toMatchObject({ file, line_start: start, line_end: start + 1, side: 'LEFT' });
    });
  });
}
