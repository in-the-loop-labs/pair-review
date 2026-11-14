// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: what the diff pane renders (N1 of plans/codeview-virtualized-diff.md)
 *
 * A characterization of main, in both modes, written before the diff engine
 * changes: file order, rows and their line numbers and types, separators,
 * wrapping, and every unusual file shape (binary, mode-only, empty added,
 * renames, added, deleted, generated, CRLF, no newline at end of file,
 * non-ASCII, a quoted path), the per-file plain-text cap and the empty diff.
 *
 * Nothing here names how a row is drawn: every read goes through
 * tests/e2e/diff-dom.js. Rows are compared with the file contents the patch
 * was generated from (tests/e2e/fixtures/diffs.js), so "the number in the
 * gutter is the line it shows" is checked for every row on screen.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender } from './helpers.js';
import { allCorpora, checkRows, customCorpus, routeDiff } from './fixtures/diffs.js';
import {
  filesInPane, fileWrapper, dumpFile, rowCount, scrollFileIntoView, waitForFileRendered,
  waitForFileSettled, waitForContentUpgrade, wrapInfo, syntaxTokens, assertNoOrphanHosts
} from './diff-dom.js';

const { default: DEFAULT, edge: EDGE, eviction: EVICTION } = allCorpora();

const bare = (text) => text.replace(/[\r\n]+$/, '');

/** Every row on screen shows the line its number names (see `checkRows`); returns how many rows were checked. */
function expectRowsMatchContents(dump, corpusFile) {
  const { checked, mismatches } = checkRows(dump, corpusFile);
  expect(mismatches).toEqual([]);
  return checked;
}

const rowsOfType = (dump, type) => dump.columns.flatMap((c) => c.rows)
  .filter((row) => row.type === type)
  .map((row) => [Number(row.line), bare(row.text)]);

/** Bring a file to the top of the diff and wait until it shows what it is going to show. */
async function show(page, file, { hasRows = true } = {}) {
  await scrollFileIntoView(page, file);
  if (hasRows) await waitForFileRendered(page, file);
  await waitForFileSettled(page, file);
}

for (const mode of MODES) {
  test.describe(`Diff render: the default fixture (${mode.name})`, () => {
    test('files are in path order and every row shows the line its number names', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, 'src/main.js');
      await waitForContentUpgrade(page, 'src/utils.js');

      expect((await filesInPane(page)).map((f) => f.file)).toEqual(['src/main.js', 'src/utils.js']);

      const utils = await dumpFile(page, 'src/utils.js');
      expect(utils.columns.map((c) => c.name)).toEqual(['unified']);
      expect(expectRowsMatchContents(utils, DEFAULT.files['src/utils.js'])).toBeGreaterThan(10);
      // The changed rows are exactly the patch's, numbered on their own side.
      expect(rowsOfType(utils, 'change-deletion')).toEqual([
        [3, '  return null;'],
        [52, '  return data;']
      ]);
      expect(rowsOfType(utils, 'change-addition')).toEqual([
        [2, ''],
        [4, '  // Improved implementation'],
        [5, '  const result = computeValue();'],
        [6, '  return result;'],
        [55, '  return JSON.stringify(data);']
      ]);
      // Context rows carry both numbers: new line 7 is old line 4.
      const closingBrace = utils.columns[0].rows.find((row) => row.line === '7');
      expect(closingBrace).toMatchObject({ type: 'context', alt: '4', text: expect.stringContaining('}') });

      const main = await dumpFile(page, 'src/main.js');
      expectRowsMatchContents(main, DEFAULT.files['src/main.js']);
      expect(rowsOfType(main, 'change-deletion')).toEqual([]);
      expect(rowsOfType(main, 'change-addition').map(([line]) => line)).toEqual([11, 12, 13, 14, 15]);
      await assertNoOrphanHosts(page);
    });

    test('hidden lines between two hunks are one separator that says how many, with expand controls', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, 'src/utils.js');

      const utils = await dumpFile(page, 'src/utils.js');
      expect(utils.separators).toHaveLength(1);
      expect(utils.separators[0]).toMatch(/^\d+ unmodified lines/);
      expect(utils.expandControls).toBeGreaterThan(0);
      // The separator sits between the two hunks: no row of the hidden range is on screen.
      const hidden = Number(/^(\d+)/.exec(utils.separators[0])[1]);
      const shown = utils.columns[0].rows.filter((row) => row.type !== 'change-deletion').map((row) => Number(row.line));
      const firstAfterGap = shown.find((line, i) => i > 0 && line - shown[i - 1] > 1);
      const lastBeforeGap = shown[shown.indexOf(firstAfterGap) - 1];
      expect(firstAfterGap - lastBeforeGap - 1).toBe(hidden);
    });
  });

  test.describe(`Diff render: unusual files (${mode.name})`, () => {
    const R = EDGE.roles;

    test.beforeEach(async ({ page }) => {
      await routeDiff(page, EDGE);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test('every file is listed, in path order, in the pane and in the sidebar', async ({ page }) => {
      expect((await filesInPane(page)).map((f) => f.file)).toEqual(EDGE.order);
      const sidebar = await page.locator('.file-item[data-path]')
        .evaluateAll((items) => items.map((item) => item.dataset.path));
      expect(sidebar).toEqual(EDGE.order);
      await assertNoOrphanHosts(page);
    });

    test('an added file is all additions and a deleted file all deletions', async ({ page }) => {
      await show(page, R.added);
      const added = await dumpFile(page, R.added);
      expect([...new Set(added.columns.flatMap((c) => c.rows).map((row) => row.type))]).toEqual(['change-addition']);
      expect(expectRowsMatchContents(added, EDGE.files[R.added])).toBe(40);
      expect(added.separators).toEqual([]);

      await show(page, R.deleted);
      const deleted = await dumpFile(page, R.deleted);
      expect([...new Set(deleted.columns.flatMap((c) => c.rows).map((row) => row.type))]).toEqual(['change-deletion']);
      expect(expectRowsMatchContents(deleted, EDGE.files[R.deleted])).toBe(30);
    });

    for (const role of ['binary', 'modeOnly', 'emptyAdded', 'renamePure']) {
      test(`a file with no lines to show is its header and nothing else: ${role}`, async ({ page }) => {
        const file = R[role];
        await show(page, file, { hasRows: false });
        const wrapper = fileWrapper(page, file);
        await expect(wrapper.locator('.d2h-file-header')).toBeVisible();
        await expect(wrapper.locator('.d2h-file-name')).toContainText(file.split('/').pop());
        expect(await rowCount(page, file)).toBe(0);
        const dump = await dumpFile(page, file);
        // Main shows no message for any of these (ledger H47).
        expect(dump.notices).toEqual([]);
        expect(dump.separators).toEqual([]);
        expect(dump.collapsed).toBe(false);
        // The file after it is still rendered below it.
        const next = EDGE.order[EDGE.order.indexOf(file) + 1];
        if (next) await expect(fileWrapper(page, next).locator('.d2h-file-header')).toBeAttached();
      });
    }

    test('a generated file starts collapsed with its badge, and shows its rows once expanded', async ({ page }) => {
      const file = R.generated;
      await scrollFileIntoView(page, file);
      const wrapper = fileWrapper(page, file);
      await expect(wrapper).toHaveClass(/collapsed/);
      await expect(wrapper).toHaveClass(/generated-file/);
      await expect(wrapper.locator('.generated-badge')).toHaveText('Generated file');
      expect(await rowCount(page, file)).toBe(0);
      await expect(page.locator(`.file-item[data-path="${file}"]`)).toHaveClass(/generated/);

      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, file);
      await waitForFileSettled(page, file);
      expectRowsMatchContents(await dumpFile(page, file), EDGE.files[file]);
    });

    test('a very long line wraps: nothing scrolls sideways', async ({ page }) => {
      const file = R.longLine;
      await show(page, file);
      const info = await wrapInfo(page, file);
      expect(info.overflow).toBe(0);
      // A 2,400-character line takes many times the height of a short one.
      expect(info.maxRowHeight).toBeGreaterThan(info.minRowHeight * 5);
      expectRowsMatchContents(await dumpFile(page, file), EDGE.files[file]);
    });

    for (const [role, changed] of [
      ['crlf', 'crlf changed line'],
      ['noNewline', '// no newline follows'],
      ['unicode', "const greeting = 'grüße, мир — 日本語 ✓✓';"],
      ['quoted', '  const quotedPathChange = true; /* changed */']
    ]) {
      test(`renders its changed line and truthful rows: ${role}`, async ({ page }) => {
        const file = R[role];
        await show(page, file);
        const dump = await dumpFile(page, file);
        expect(dump.header.name).toContain(file);
        expectRowsMatchContents(dump, EDGE.files[file]);
        expect(rowsOfType(dump, 'change-addition').some(([, text]) => text.includes(changed))).toBe(true);
        expect(rowsOfType(dump, 'change-deletion').length).toBeGreaterThan(0);
      });
    }

    test('a renamed file with changes shows its rows under the new path', async ({ page }) => {
      const file = R.renameChanged;
      await show(page, file);
      const dump = await dumpFile(page, file);
      expectRowsMatchContents(dump, EDGE.files[file]);
      expect(rowsOfType(dump, 'change-addition')).toEqual([[41, '  const renamedAndChanged = true;']]);
      expect(dump.header.name).toContain(file);
      // Characterization: PR mode names the old path too ("old → new"); Local
      // mode never learns a file was renamed (its file list carries no
      // `renamed` flag) and shows the new path alone.
      if (mode.local) {
        expect(dump.header.name).not.toContain(EDGE.files[file].oldName);
      } else {
        expect(dump.header.name).toContain(EDGE.files[file].oldName);
      }
    });
  });

  test.describe(`Diff render: limits and the empty diff (${mode.name})`, () => {
    test('a file over the per-file cap is shown as plain text while its neighbours are highlighted', async ({ page }) => {
      const { target, big, tail } = EVICTION.roles;
      await routeDiff(page, EVICTION);
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      await show(page, target);
      await expect.poll(async () => (await syntaxTokens(page, target)).highlightedRows).toBeGreaterThan(0);

      // The big file (4,000 lines; the cap is 3,000) renders its rows ...
      await show(page, big);
      expect(await rowCount(page, big)).toBeGreaterThan(0);
      // ... and the file after it is highlighted, which proves the highlighter
      // has got past the big file's turn ...
      await show(page, tail);
      await expect.poll(async () => (await syntaxTokens(page, tail)).highlightedRows).toBeGreaterThan(0);
      // ... while the big file's rows are still plain.
      await show(page, big);
      const tokens = await syntaxTokens(page, big);
      expect(tokens.rows).toBeGreaterThan(0);
      expect(tokens.highlightedRows).toBe(0);
    });

    test('a diff with no files says so', async ({ page }) => {
      await routeDiff(page, customCorpus({ name: 'empty', diff: '', files: {} }));
      await page.goto(mode.path);
      // Characterization: each mode has its own wording.
      await expect(page.locator('#diff-container')).toContainText(
        mode.local ? /No changes in .+ scope/ : 'No files changed'
      );
      expect(await filesInPane(page)).toEqual([]);
      await expect(page.locator('.file-item[data-path]')).toHaveCount(0);
    });
  });
}
