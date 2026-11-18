// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: syntax highlighting and theme (N2 of plans/codeview-virtualized-diff.md)
 *
 * In both modes: code rows carry syntax tokens, a theme switch re-colours
 * them without re-fetching anything, a worker script that cannot load does
 * not cost the user the diff, and nothing is asked of the CDN that served
 * the highlighter of the renderer the viewer replaced.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender } from './helpers.js';
import { dumpFile, rowCount, syntaxTokens, waitForContentUpgrade, WORKER_LOAD_FAILURE_ERROR } from './diff-dom.js';

const FILE = 'src/main.js';

/** Click the theme toggle (light → dark → system) until the page is in `theme`. */
async function switchTheme(page, theme) {
  const current = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (let clicks = 0; clicks < 3 && (await current()) !== theme; clicks++) {
    await page.locator('#theme-toggle').click();
  }
  expect(await current()).toBe(theme);
}

/**
 * The highlighting of FILE once it has stopped changing. Rows are re-created
 * when the file's contents arrive and when annotations change, and a
 * re-created row is plain for a moment, so one read can catch it bare.
 */
async function highlighted(page) {
  let last = null;
  await expect.poll(async () => {
    const now = await syntaxTokens(page, FILE);
    const settled = now.highlightedRows > 0 && now.colors.length > 1 && JSON.stringify(now) === JSON.stringify(last);
    last = now;
    return settled;
  }).toBe(true);
  return last;
}

/**
 * True when the tokens on screen are drawn in another palette than `before`:
 * still highlighted, and most colours are new. (Not all: the two GitHub
 * palettes use the same grey for comments.)
 */
async function recoloured(page, before) {
  const now = await syntaxTokens(page, FILE);
  const fresh = now.colors.filter((color) => !before.colors.includes(color));
  return now.highlightedRows > 0 && fresh.length >= 3 && fresh.length >= now.colors.length - 1;
}

for (const mode of MODES) {
  test.describe(`Syntax highlighting and theme (${mode.name})`, () => {
    // "system" resolves to this; pin it so the toggle cycle is known.
    test.use({ colorScheme: 'light' });

    test('code rows are highlighted with more than one token colour', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, FILE);
      const tokens = await highlighted(page);
      expect(tokens.colors.length).toBeGreaterThan(1);
      // Highlighting does not change what the rows say.
      const dump = await dumpFile(page, FILE);
      expect(dump.columns[0].rows.some((row) => row.text.includes('function log(message) {'))).toBe(true);
    });

    test('switching the theme re-colours the tokens and keeps the rows', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, FILE);
      const light = await highlighted(page);
      const rowsBefore = (await dumpFile(page, FILE)).columns[0].rows.map((row) => `${row.line}:${row.text}`);

      await switchTheme(page, 'dark');
      await expect.poll(() => recoloured(page, light)).toBe(true);
      expect((await dumpFile(page, FILE)).columns[0].rows.map((row) => `${row.line}:${row.text}`)).toEqual(rowsBefore);

      // And back.
      await switchTheme(page, 'light');
      await expect.poll(async () => (await syntaxTokens(page, FILE)).colors).toEqual(light.colors);
    });

    test('the theme a reader chose is the one the diff is drawn in after a reload', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      const light = await highlighted(page);
      await switchTheme(page, 'dark');

      await page.reload();
      await waitForDiffToRender(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(() => recoloured(page, light)).toBe(true);
    });
  });

  test.describe(`Highlighting without its worker (${mode.name})`, () => {
    // The vendor reports the worker it could not start.
    test.use({ expectedConsoleErrors: [WORKER_LOAD_FAILURE_ERROR] });

    test('the diff still renders, highlighted, when the worker script cannot load', async ({ page }) => {
      let blocked = 0;
      await page.route(/\/js\/vendor\/pierre-diffs-worker\.js/, (route) => {
        blocked++;
        return route.abort();
      });
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      expect(blocked).toBeGreaterThan(0);
      expect(await rowCount(page, FILE)).toBeGreaterThan(0);
      await expect.poll(async () => (await syntaxTokens(page, FILE)).highlightedRows, { timeout: 30000 })
        .toBeGreaterThan(0);
      // The rest of the page works: the other file rendered too.
      expect(await rowCount(page, 'src/utils.js')).toBeGreaterThan(0);
    });
  });

  test.describe(`Highlighting needs nothing from cdnjs (${mode.name})`, () => {
    test.use({ colorScheme: 'light' });

    test('code rows are highlighted with that host out of reach, and the page asks it for nothing', async ({ page }) => {
      // The application's own renderer of context lines used to take a
      // highlighter and its stylesheets from cdnjs. Every line of the pane is
      // now coloured by the viewer's bundle, which the application serves.
      const asked = [];
      await page.route(/^https?:\/\/cdnjs\.cloudflare\.com\//, (route) => {
        asked.push(route.request().url());
        return route.abort();
      });
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, FILE);
      const tokens = await highlighted(page);
      expect(tokens.highlightedRows).toBeGreaterThan(0);
      expect(tokens.colors.length).toBeGreaterThan(1);
      expect(asked).toEqual([]);
    });
  });
}
