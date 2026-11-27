// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: a path in another form names the same file wherever the reader
 * is, in both modes.
 *
 * A finding, a thread or a chat link may carry a path as a model or a host
 * wrote it ('./src/index.js'). The pane resolves it to one of its files
 * from data only (ledger H180): the exact path, then the normalized path,
 * then a suffix match. Before, a suffix match over the files that had an
 * element came first, so with `packages/x/src/index.js` on screen and
 * `src/index.js` scrolled away, './src/index.js' named the file on screen;
 * and a context file's alias named nothing once the file was scrolled away.
 *
 * The scenario is a click in the review panel on a finding whose path is in
 * another form, for a collapsed file that is scrolled away: the navigation
 * opens the file the path names. (Such a finding has no card in the diff:
 * the suggestions are drawn by exact path, on main too; the navigation
 * then goes nowhere further. Ledger H180.)
 *
 * The corpus is `sharedSuffixCorpus` (tests/e2e/fixtures/diffs.js): the two
 * index files with 1,500 added lines between them.
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, seedSuggestions, cleanupAllComments, expandReviewPanel, mockContextFilesApi
} from './helpers.js';
import { sharedSuffixCorpus, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, contextFileSelector, waitForDiffSettled, scrollDiffToEdge, scrollFileIntoView
} from './diff-dom.js';

const CORPUS = sharedSuffixCorpus();
const NESTED = 'packages/x/src/index.js';
const TOP = 'src/index.js';
const CONTEXT = 'corpus-evict/context-long.js'; // 240 lines, registered with the test server; sorts first

const isFileCollapsed = (page, file) => page.evaluate((f) => window.prManager.isFileCollapsed(f), file);

for (const mode of MODES) {
  test.describe(`A path in another form (${mode.name})`, () => {
    let contextApi;

    test.beforeEach(async ({ page }) => {
      contextApi = await mockContextFilesApi(page, { diffFiles: CORPUS.order });
      await routeDiff(page, CORPUS);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await waitForDiffSettled(page);
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('a click on a finding on \'./src/index.js\' opens src/index.js when it is collapsed, and leaves packages/x/src/index.js alone', async ({ page }) => {
      await scrollFileIntoView(page, TOP);
      await fileWrapper(page, TOP).locator('.file-collapse-toggle').click();
      await expect(fileWrapper(page, TOP)).toHaveClass(/collapsed/);
      await scrollDiffToEdge(page, 'top');
      await expect(fileWrapper(page, TOP)).toHaveCount(0);

      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: './src/index.js', line_start: 20, title: 'Finding on the top-level index', body: 'Body of the finding.' }
      ]);
      await expandReviewPanel(page);
      await page.locator(`.finding-item[data-id="${id}"]`).click();

      await expect.poll(() => isFileCollapsed(page, TOP)).toBe(false);
      expect(await isFileCollapsed(page, NESTED)).toBe(false);
      await scrollFileIntoView(page, TOP);
      await expect(fileWrapper(page, TOP)).not.toHaveClass(/collapsed/);
    });

    test('a click on a finding on a context file in another form opens the file while it is scrolled far away', async ({ page }) => {
      contextApi.add({ review_id: mode.reviewId, file: CONTEXT, line_start: 10, line_end: 40 });
      await page.reload();
      await waitForDiffToRender(page);
      await waitForDiffSettled(page);
      await scrollFileIntoView(page, CONTEXT);
      await page.locator(contextFileSelector(CONTEXT)).locator('.file-collapse-toggle').click();
      await expect.poll(() => isFileCollapsed(page, CONTEXT)).toBe(true);
      await scrollDiffToEdge(page, 'bottom');
      await expect(page.locator(contextFileSelector(CONTEXT))).toHaveCount(0);

      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: `./${CONTEXT}`, line_start: 20, title: 'Finding on the context file', body: 'Body of the finding.' }
      ]);
      await expandReviewPanel(page);
      await page.locator(`.finding-item[data-id="${id}"]`).click();
      await expect.poll(() => isFileCollapsed(page, CONTEXT)).toBe(false);
      await scrollFileIntoView(page, CONTEXT);
      await expect(page.locator(contextFileSelector(CONTEXT))).not.toHaveClass(/collapsed/);
    });
  });
}
