// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: collapsing a file from its stuck header keeps the header in place
 *
 * When a reader is partway through a long file, its header is stuck to the
 * top of the diff pane. Collapsing that file shrinks it to just the header,
 * which would otherwise leave the header far above the viewport and drop the
 * reader somewhere further down the diff. Like GitHub, the diff pane scrolls
 * so the collapsed header sits exactly where it was stuck, with the next file
 * directly below it.
 *
 * The pane is a virtualized viewer: its scroll container, the files that
 * have an element and the space between two files are asked of diff-dom.js.
 * What is asserted, and how closely, is as the spec was written.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';
import {
  scrollState, ensureMounted, filesInPane, waitForDiffSettled, gapBelowFile, spacingBelowFile, scrollPaneToEntry, setViewedBox
} from './diff-dom.js';

const MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1' },
  { name: 'Local mode', path: '/local/2' }
];
const FIRST_FILE = 'src/first.js';
const SECOND_FILE = 'src/second.js';
const THIRD_FILE = 'src/third.js';
const CONTEXT_FILE = 'src/context.js';
const LINES_PER_FILE = 200;

function addedFilePatch(file) {
  const lines = [];
  for (let i = 0; i < LINES_PER_FILE; i++) lines.push(`+const line${i} = ${i};`);
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${LINES_PER_FILE} @@`,
    ...lines
  ].join('\n');
}

/**
 * Serve a diff of three long files and isolate the page from shared per-worker
 * state (viewed files saved by other tests) and the full-contents upgrade.
 * @param {import('@playwright/test').Page} page
 */
async function mockLongFiles(page) {
  const files = [FIRST_FILE, SECOND_FILE, THIRD_FILE];
  const diff = `${files.map(addedFilePatch).join('\n')}\n`;
  const changedFiles = files.map((file) => ({ file, additions: LINES_PER_FILE, deletions: 0 }));
  await page.route('**/api/pr/*/*/*/diff', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ diff, changed_files: changedFiles })
    })
  );
  await page.route('**/api/local/*/diff', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        diff,
        stats: { files_changed: files.length, additions: files.length * LINES_PER_FILE, deletions: 0 }
      })
    })
  );
  await page.route('**/api/local/*/check-stale', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ isStale: false }) })
  );
  await page.route('**/api/pr/*/*/*/files/viewed', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ files: [] }) });
  });
  await page.route('**/api/reviews/*/file-contents/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tooLarge: true }) })
  );
}

/**
 * Serve one long context entry. It sorts before the diff files, so there is
 * a file directly below it.
 * @param {import('@playwright/test').Page} page
 */
async function mockLongContextFile(page) {
  await page.route('**/api/reviews/*/context-files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        contextFiles: [{ id: 1, file: CONTEXT_FILE, line_start: 1, line_end: LINES_PER_FILE }]
      })
    });
  });
  await page.route('**/api/reviews/*/file-content/**', (route) => {
    const lines = Array.from({ length: LINES_PER_FILE }, (_, i) => `const context${i} = ${i};`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ lines }) });
  });
}

/**
 * Selector for a file's diff entry (never its context entry).
 * @param {string} file
 */
function diffEntry(file) {
  return `.d2h-file-wrapper:not(.context-file)[data-file-name="${file}"]`;
}

const CONTEXT_ENTRY = `.d2h-file-wrapper.context-file[data-file-name="${CONTEXT_FILE}"]`;

/**
 * Scroll the diff pane halfway into a file so its header is stuck, and return
 * the stuck header's viewport top once the position has settled.
 * @param {import('@playwright/test').Page} page
 * @param {string} wrapperSelector
 * @returns {Promise<number>}
 */
async function scrollPartwayInto(page, wrapperSelector) {
  await scrollPaneToEntry(page, wrapperSelector, { halfway: true });

  await expect.poll(() => headerIsStuck(page, wrapperSelector)).toBe(true);
  return headerTop(page, wrapperSelector);
}

function headerIsStuck(page, wrapperSelector) {
  return page.evaluate((selector) => {
    const wrapper = document.querySelector(selector);
    const header = wrapper.querySelector('.d2h-file-header');
    return wrapper.getBoundingClientRect().top < header.getBoundingClientRect().top;
  }, wrapperSelector);
}

function headerTop(page, wrapperSelector) {
  return page.evaluate((selector) => {
    const wrapper = document.querySelector(selector);
    return wrapper.querySelector('.d2h-file-header').getBoundingClientRect().top;
  }, wrapperSelector);
}

/**
 * Gap between the bottom of a collapsed file and the top of the file after it.
 * @param {import('@playwright/test').Page} page
 * @param {string} wrapperSelector
 */
function gapToNextFile(page, wrapperSelector) {
  return gapBelowFile(page, wrapperSelector);
}

for (const mode of MODES) {
  test.describe(`Collapsing a file from its stuck header (${mode.name})`, () => {
    const FIRST_ENTRY = diffEntry(FIRST_FILE);

    test.beforeEach(async ({ page }) => {
      await mockLongFiles(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test('marking a file viewed keeps its collapsed header where it was stuck', async ({ page }) => {
      const stuckTop = await scrollPartwayInto(page, FIRST_ENTRY);

      await setViewedBox(page.locator(FIRST_ENTRY));

      await expect(page.locator(FIRST_ENTRY)).toHaveClass(/collapsed/);
      expect(await headerTop(page, FIRST_ENTRY)).toBeCloseTo(stuckTop, 0);
      const wrapperMargin = await spacingBelowFile(page, FIRST_ENTRY);
      expect(wrapperMargin).toBeGreaterThan(0);
      expect(await gapToNextFile(page, FIRST_ENTRY)).toBeCloseTo(wrapperMargin, 0);
    });

    test('collapsing a file with its chevron keeps its collapsed header where it was stuck', async ({ page }) => {
      const stuckTop = await scrollPartwayInto(page, FIRST_ENTRY);

      await page.locator(FIRST_ENTRY).locator('.file-collapse-toggle').click();

      await expect(page.locator(FIRST_ENTRY)).toHaveClass(/collapsed/);
      expect(await headerTop(page, FIRST_ENTRY)).toBeCloseTo(stuckTop, 0);
    });

    test('marking a file viewed leaves the pane where it was when the header was not stuck', async ({ page }) => {
      const secondEntry = diffEntry(SECOND_FILE);
      // The second file has an element once the viewer has it near the viewport.
      await ensureMounted(page, SECOND_FILE);
      await scrollPaneToEntry(page, secondEntry, { headerMidPane: true });
      await waitForDiffSettled(page);
      expect(await headerIsStuck(page, secondEntry)).toBe(false);
      const scrollTopBefore = (await scrollState(page)).top;

      await setViewedBox(page.locator(secondEntry));

      await expect(page.locator(secondEntry)).toHaveClass(/collapsed/);
      expect((await scrollState(page)).top).toBe(scrollTopBefore);
    });
  });

  test.describe(`Collapsing a context entry from its stuck header (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await mockLongFiles(page);
      await mockLongContextFile(page);
      await page.goto(mode.path);
      // The context entry fills the viewport, so the diff files below it
      // may have no element; wait for the entries themselves instead.
      await expect(page.locator(CONTEXT_ENTRY).locator('.d2h-file-header')).toBeVisible();
      await expect.poll(async () => (await filesInPane(page)).map((entry) => entry.file)).toContain(FIRST_FILE);
    });

    test('marking a context entry viewed keeps its collapsed header where it was stuck', async ({ page }) => {
      const stuckTop = await scrollPartwayInto(page, CONTEXT_ENTRY);

      await setViewedBox(page.locator(CONTEXT_ENTRY));

      await expect(page.locator(CONTEXT_ENTRY)).toHaveClass(/collapsed/);
      expect(await headerTop(page, CONTEXT_ENTRY)).toBeCloseTo(stuckTop, 0);
    });

    test('collapsing a context entry with its chevron keeps its collapsed header where it was stuck', async ({ page }) => {
      const stuckTop = await scrollPartwayInto(page, CONTEXT_ENTRY);

      await page.locator(CONTEXT_ENTRY).locator('.file-collapse-toggle').click();

      await expect(page.locator(CONTEXT_ENTRY)).toHaveClass(/collapsed/);
      expect(await headerTop(page, CONTEXT_ENTRY)).toBeCloseTo(stuckTop, 0);
    });
  });
}
