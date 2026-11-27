// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: what belongs on a line of a collapsed file (a viewed file, a
 * generated file, a collapsed context file) is placed on that line, in both
 * modes.
 *
 * A collapsed file draws no line, and the diff pane has two questions about
 * a line (ledger H178): "is it drawn now" (false for every line of a
 * collapsed file) and "is it part of the file's diff" (the same answer
 * without the collapse). What belongs on a line asks the second, and the
 * file's annotations are shown when the reader opens it:
 *
 *  - a GitHub review thread (PR mode; Local mode loads none) is drawn under
 *    its line, not in the file's comment zone with the styling of a thread
 *    whose line is gone, and it asks for no contents of its own (both
 *    modes: the same reveal runs for a user comment). The pane fetches the
 *    contents of every file it draws at load, collapsed or not; a reveal
 *    for a line of a collapsed file asked for them a second time;
 *  - a tour stop is mounted: the tour opens the file and closes it again on
 *    exit, decided from data, also when the file has no element then
 *    (ledger H179). Before, every stop in a collapsed file was skipped, and a
 *    tour of only such stops ended at once.
 *
 * The corpus is `reviewFixesCorpus` (tests/e2e/fixtures/diffs.js).
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, mockViewedStateApi, mockExternalComments, externalThread, mockAppConfig,
  mockHunkSummaries, mockTour, mockContextFilesApi, seedComment, cleanupAllComments, holdFileContents, expectResponse
} from './helpers.js';
import { reviewFixesCorpus, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, fileSelector, contextFileSelector, lineCards, waitForDiffSettled, rowBox, setViewedBox, contextFile, contextLine,
  scrollFileIntoView
} from './diff-dom.js';

const CORPUS = reviewFixesCorpus();
const GEN = 'gen/data.lock';
const ALPHA = 'src/alpha.js';
const BETA = 'src/beta.js';
const ZETA = 'src/zeta.js';
const CONTEXT = 'corpus-evict/context-long.js'; // 240 lines, registered with the test server

/** Every file-contents request the page makes from now on, by path. */
function watchContentRequests(page) {
  const paths = [];
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(/\/file-contents\/(.+)$/);
    if (match) paths.push(decodeURIComponent(match[1]));
  });
  return paths;
}

const isFileCollapsed = (page, file) => page.evaluate((f) => window.prManager.isFileCollapsed(f), file);

/** Top and bottom, in the viewport, of the row of `line` of a changed file or a context file; null when not drawn. */
async function rowEdges(page, file, line, { context = false } = {}) {
  if (!context) return rowBox(page, file, line);
  const box = await contextLine(page, file, line).first().boundingBox().catch(() => null);
  return box ? { top: box.y, bottom: box.y + box.height } : null;
}

/** The card is drawn under the row of `line` (and above the next row) of `file`. */
async function expectUnderLine(page, card, file, line, options = {}) {
  await expect(card).toBeVisible();
  await expect.poll(async () => {
    const row = await rowEdges(page, file, line, options);
    const next = await rowEdges(page, file, line + 1, options);
    const box = await card.boundingBox();
    if (!row || !next || !box) return 'not drawn';
    // Cards keep a small margin above them.
    const under = box.y >= row.bottom - 1 && box.y <= row.bottom + 12 && box.y + box.height <= next.top + 1;
    return under ? 'under its line' : `card at ${box.y}-${box.y + box.height}, row ends ${row.bottom}, next row ${next.top}`;
  }).toBe('under its line');
}

/**
 * Open the review, then mark BETA viewed and load the page again, so it
 * starts collapsed in both modes (PR mode keeps viewed files on the server,
 * mocked here by `viewedApi`; Local mode in the browser's storage).
 */
async function openWithBetaViewed(page, mode, viewedApi) {
  await routeDiff(page, CORPUS);
  await page.goto(mode.path);
  await waitForDiffToRender(page);
  await waitForDiffSettled(page);
  await scrollFileIntoView(page, BETA);
  await setViewedBox(fileWrapper(page, BETA));
  // The save has its answer before the page goes away.
  if (mode.reviewId === 1) await expect.poll(() => viewedApi.files).toContain(BETA);
  await page.reload();
  await waitForDiffToRender(page);
  await waitForDiffSettled(page);
  expect(await isFileCollapsed(page, GEN)).toBe(true);
  expect(await isFileCollapsed(page, BETA)).toBe(true);
}

test.describe('GitHub threads on collapsed files (PR mode)', () => {
  const mode = MODES[0];
  const thread = (page, id) => page.locator(`.external-comment-row[data-thread-id="${id}"]`);

  let viewedApi;
  test.beforeEach(async ({ page }) => {
    viewedApi = await mockViewedStateApi(page);
  });

  test('a thread on a changed line of a generated file and of a viewed file is drawn under its line when the file is opened, and asks for no contents of its own', async ({ page }) => {
    const external = await mockExternalComments(page, [
      externalThread({ id: 7101, file: GEN, line: 30, body: 'Thread on the generated file' }),
      externalThread({ id: 7201, file: BETA, line: 30, body: 'Thread on the viewed file' }),
      // Last: the threads are drawn one after the other, so this one on an
      // open file says the two before it have been placed.
      externalThread({ id: 7301, file: ALPHA, line: 12, body: 'Thread on an open file' }),
    ]);
    await openWithBetaViewed(page, mode, viewedApi);
    // The order is the test's (tests/CONVENTIONS.md): the threads arrive
    // while every file's contents are on their way, so a thread that asked
    // for its file's contents would be seen asking.
    const requested = watchContentRequests(page);
    const releaseThreads = external.holdLists();
    const contents = await holdFileContents(page);
    await page.reload();
    await waitForDiffToRender(page);
    // Every file the pane draws at load gets its contents, collapsed or not: one request each.
    await expect.poll(() => [GEN, BETA].every((file) => requested.includes(file))).toBe(true);
    releaseThreads();
    // Either the threads are drawn one after the other down to the last one
    // (on the open file), or one of them asks for a file's contents again
    // and waits for it.
    await Promise.race([
      expect(lineCards(page, '.external-comment-row[data-thread-id="7301"]', fileSelector(ALPHA))).toBeVisible({ timeout: 15000 }),
      expect.poll(() => requested.length, { timeout: 15000 }).toBeGreaterThan(new Set(requested).size),
    ]);
    contents.release();
    await expect(lineCards(page, '.external-comment-row[data-thread-id="7301"]', fileSelector(ALPHA))).toBeVisible();
    await waitForDiffSettled(page);

    // Placed on their lines, not in the file's comment zone as threads whose
    // line is gone; and no thread asked for its file's contents.
    expect(await page.evaluate(() => [7101, 7201].map((id) => {
      const card = window.externalCommentManager.findThreadCard(id);
      return card ? card.classList.contains('external-comment-row--file-fallback') : null;
    }))).toEqual([false, false]);
    expect(requested.filter((path) => path === GEN)).toEqual([GEN]);
    expect(requested.filter((path) => path === BETA)).toEqual([BETA]);

    for (const file of [GEN, BETA]) {
      const id = file === GEN ? 7101 : 7201;
      await scrollFileIntoView(page, file);
      await fileWrapper(page, file).locator('.file-collapse-toggle').click();
      await expect.poll(() => isFileCollapsed(page, file)).toBe(false);
      await expectUnderLine(page, lineCards(page, `.external-comment-row[data-thread-id="${id}"]`, fileSelector(file)), file, 30);
      await expect(thread(page, id)).not.toHaveClass(/file-fallback/);
    }

    // Collapsed and opened again: still on its line.
    await scrollFileIntoView(page, GEN);
    await fileWrapper(page, GEN).locator('.file-collapse-toggle').click();
    await expect(fileWrapper(page, GEN)).toHaveClass(/collapsed/);
    await fileWrapper(page, GEN).locator('.file-collapse-toggle').click();
    await expectUnderLine(page, lineCards(page, '.external-comment-row[data-thread-id="7101"]', fileSelector(GEN)), GEN, 30);
    await expect(page.locator('.external-comment-row--file-fallback')).toHaveCount(0);
  });

  test('a thread on a line the file does not have is in the file\'s comment zone with the fallback styling, collapsed or not', async ({ page }) => {
    const external = await mockExternalComments(page, [
      externalThread({ id: 7401, file: BETA, line: 500, body: 'Thread on a line beta does not have' }),
      externalThread({ id: 7501, file: ALPHA, line: 500, body: 'Thread on a line alpha does not have' }),
    ]);
    await openWithBetaViewed(page, mode, viewedApi);
    const release = external.holdLists();
    await page.reload();
    await waitForDiffToRender(page);
    await waitForDiffSettled(page);
    release();
    await expect(fileWrapper(page, ALPHA).locator('.file-comments-zone .external-comment-row--file-fallback[data-thread-id="7501"]')).toBeVisible();
    await scrollFileIntoView(page, BETA);
    await fileWrapper(page, BETA).locator('.file-collapse-toggle').click();
    await expect(fileWrapper(page, BETA).locator('.file-comments-zone .external-comment-row--file-fallback[data-thread-id="7401"]')).toBeVisible();
    await expect(lineCards(page, '.external-comment-row', '#diff-container')).toHaveCount(0);
  });
});

for (const mode of MODES) {
  test.describe(`A user comment on a collapsed file (${mode.name})`, () => {
    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('a comment on a changed line of a generated file asks for no contents of its own and is under its line when the file is opened', async ({ page }) => {
      await routeDiff(page, CORPUS);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      const id = await seedComment(page, mode.reviewId, { file: GEN, line: 30, body: 'On the generated file' });
      // The comments are loaded while every file's contents are on their
      // way (the order is the test's), so a comment that asked for its
      // file's contents would be seen asking.
      const requested = watchContentRequests(page);
      const contents = await holdFileContents(page);
      const commentsLoaded = expectResponse(page, (r) => /\/api\/reviews\/\d+\/comments(\?|$)/.test(r.url()) && r.request().method() === 'GET');
      await page.reload();
      await waitForDiffToRender(page);
      await commentsLoaded;
      // Every file the pane draws at load gets its contents, collapsed or not: one request.
      await expect.poll(() => requested.includes(GEN)).toBe(true);
      // Either the comment load is over, or it asked for the file's contents again and waits for them.
      await Promise.race([
        page.evaluate(() => window.prManager.loadUserComments()),
        expect.poll(() => requested.filter((path) => path === GEN).length, { timeout: 15000 }).toBeGreaterThan(1),
      ]);
      contents.release();
      await waitForDiffSettled(page);
      expect(await isFileCollapsed(page, GEN)).toBe(true);
      expect(requested.filter((path) => path === GEN)).toEqual([GEN]);

      await fileWrapper(page, GEN).locator('.file-collapse-toggle').click();
      await expectUnderLine(page, lineCards(page, `.user-comment-row[data-comment-id="${id}"]`, fileSelector(GEN)), GEN, 30);
    });
  });

  test.describe(`Tour stops in collapsed files (${mode.name})`, () => {
    const stop = (page, index) => page.locator(`.tour-annotation-row[data-stop-index="${index}"]`);
    const progress = (page) => page.locator('.tour-bar .tour-bar__progress');
    const stopAt = (file, line, title) => ({ file_path: file, side: 'RIGHT', line_start: line, line_end: line, title, description: `About ${file}:${line}.` });

    let viewedApi;
    test.beforeEach(async ({ page }) => {
      viewedApi = await mockViewedStateApi(page);
      await mockAppConfig(page, { tours: { enabled: true } });
      await mockHunkSummaries(page, []);
    });

    test('every stop in a generated or viewed file is mounted under its line and the file opened; on exit both are closed again, also with no element', async ({ page }) => {
      await mockTour(page, [
        stopAt(GEN, 30, 'In the generated file'),
        stopAt(BETA, 30, 'In the viewed file'),
        stopAt(ALPHA, 12, 'In an open file'),
        stopAt(ZETA, 1450, 'Far below'),
      ]);
      await openWithBetaViewed(page, mode, viewedApi);

      await page.locator('#tour-toggle-btn').click();
      await expect(progress(page)).toHaveText('Stop 1 of 4');
      await expect.poll(() => isFileCollapsed(page, GEN)).toBe(false);
      await expectUnderLine(page, lineCards(page, '.tour-annotation-row[data-stop-index="0"]', fileSelector(GEN)), GEN, 30);
      await expect(stop(page, 0).locator('.tour-annotation-title')).toHaveText('In the generated file');

      await page.locator('.tour-bar .tour-bar__next').click();
      await expect(progress(page)).toHaveText('Stop 2 of 4');
      await expect.poll(() => isFileCollapsed(page, BETA)).toBe(false);
      await expectUnderLine(page, lineCards(page, '.tour-annotation-row[data-stop-index="1"]', fileSelector(BETA)), BETA, 30);

      await page.locator('.tour-bar .tour-bar__next').click();
      await expect(progress(page)).toHaveText('Stop 3 of 4');
      await page.locator('.tour-bar .tour-bar__next').click();
      await expect(progress(page)).toHaveText('Stop 4 of 4');
      await expect(stop(page, 3)).toBeInViewport();
      // The two files the tour opened are far above now, with no element.
      await expect(fileWrapper(page, GEN)).toHaveCount(0);
      await expect(fileWrapper(page, BETA)).toHaveCount(0);

      await page.keyboard.press('Escape');
      await expect(page.locator('.tour-bar')).toHaveCount(0);
      await expect.poll(() => isFileCollapsed(page, GEN)).toBe(true);
      await expect.poll(() => isFileCollapsed(page, BETA)).toBe(true);
      await scrollFileIntoView(page, GEN);
      await expect(fileWrapper(page, GEN)).toHaveClass(/collapsed/);
      await expect(fileWrapper(page, BETA)).toHaveClass(/collapsed/);
      await expect(fileWrapper(page, BETA).locator('.file-viewed-checkbox')).toBeChecked();
    });

    test('a file the reader closes again during the tour stays closed on exit', async ({ page }) => {
      await mockTour(page, [stopAt(GEN, 30, 'In the generated file'), stopAt(ALPHA, 12, 'In an open file')]);
      await openWithBetaViewed(page, mode, viewedApi);
      await page.locator('#tour-toggle-btn').click();
      await expect(progress(page)).toHaveText('Stop 1 of 2');
      await expect(stop(page, 0)).toBeVisible();
      await expect.poll(() => isFileCollapsed(page, GEN)).toBe(false);

      await fileWrapper(page, GEN).locator('.file-collapse-toggle').click();
      await expect(fileWrapper(page, GEN)).toHaveClass(/collapsed/);
      await page.locator('.tour-bar .tour-bar__next').click();
      await expect(progress(page)).toHaveText('Stop 2 of 2');
      await page.keyboard.press('Escape');
      await expect(page.locator('.tour-bar')).toHaveCount(0);
      await expect.poll(() => isFileCollapsed(page, GEN)).toBe(true);
      await expect(fileWrapper(page, GEN)).toHaveClass(/collapsed/);
    });

    test('a tour whose one stop is in a collapsed context file mounts it under its line; on exit the file is closed again', async ({ page }) => {
      const api = await mockContextFilesApi(page, { diffFiles: CORPUS.order });
      api.add({ review_id: mode.reviewId, file: CONTEXT, line_start: 10, line_end: 40 });
      await mockTour(page, [stopAt(CONTEXT, 20, 'In the context file')]);
      await routeDiff(page, CORPUS);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForDiffSettled(page);
      await scrollFileIntoView(page, CONTEXT);
      await expect(contextLine(page, CONTEXT, 20).first()).toBeVisible();
      await contextFile(page, CONTEXT).locator('.file-collapse-toggle').click();
      await expect(contextFile(page, CONTEXT)).toHaveClass(/collapsed/);
      expect(await isFileCollapsed(page, CONTEXT)).toBe(true);

      await page.locator('#tour-toggle-btn').click();
      await expect(progress(page)).toHaveText('Stop 1 of 1');
      await expect.poll(() => isFileCollapsed(page, CONTEXT)).toBe(false);
      const card = lineCards(page, '.tour-annotation-row[data-stop-index="0"]', contextFileSelector(CONTEXT));
      await expectUnderLine(page, card, CONTEXT, 20, { context: true });

      await page.keyboard.press('Escape');
      await expect(page.locator('.tour-bar')).toHaveCount(0);
      await expect.poll(() => isFileCollapsed(page, CONTEXT)).toBe(true);
      await expect(contextFile(page, CONTEXT)).toHaveClass(/collapsed/);
    });
  });
}
