// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: the page without the diff viewer's bundle (N13 of
 * plans/codeview-virtualized-diff.md)
 *
 * The bundle is built at install time and served from the application's own
 * files, so a page without it is a broken installation or a failed request.
 * What the diff pane then shows is a decision of the migration (D1) and is
 * asked through `MISSING_VIEWER_BUNDLE`: the table renderer today, a message
 * in place of the diff on the virtualized viewer. Either way nothing throws
 * and the rest of the page works.
 */

import { test, expect } from './fixtures.js';
import { MODES } from './helpers.js';
import { diffStatus, fileWrapper, filesInPane, MISSING_VIEWER_BUNDLE } from './diff-dom.js';

const FILES = ['src/main.js', 'src/utils.js'];

for (const mode of MODES) {
  test.describe(`Without the diff viewer's bundle (${mode.name})`, () => {
    // The browser reports the script it could not load.
    test.use({ expectedConsoleErrors: [/\[console\.error\] Failed to load resource: net::ERR_FAILED .*\/js\/vendor\/pierre-diffs\.js/] });

    test('the diff pane says so or falls back, nothing throws, and the rest of the page works', async ({ page }) => {
      let blocked = 0;
      await page.route(/\/js\/vendor\/pierre-diffs\.js(\?.*)?$/, (route) => {
        blocked++;
        return route.abort();
      });
      await page.goto(mode.path);
      // The review loaded: the sidebar lists its files.
      await expect(page.locator('.file-item[data-path]')).toHaveCount(FILES.length);
      expect(blocked).toBe(1);

      if (MISSING_VIEWER_BUNDLE === 'message') {
        await expect(diffStatus(page)).toBeVisible();
        await expect(diffStatus(page)).toContainText('The diff viewer could not be loaded');
        // Nothing of a diff is drawn under the message.
        await expect(page.locator('#diff-container')).toBeHidden();
        expect(await filesInPane(page)).toEqual([]);
      } else {
        // Every file is drawn, by the application's own table renderer.
        await expect(diffStatus(page)).toBeHidden();
        for (const file of FILES) {
          await expect(fileWrapper(page, file)).toBeVisible();
        }
        await expect(fileWrapper(page, FILES[0]).locator('.d2h-diff-table tr').first()).toBeVisible();
      }

      // The rest of the page works: navigation does not throw, the panels
      // open, the theme switches. (An error anywhere fails the console guard.)
      await page.locator(`.file-item[data-path="${FILES[1]}"]`).click();
      await expect(page.locator(`.file-item[data-path="${FILES[1]}"]`)).toHaveClass(/active/);
      // The toggle cycles light, dark, system: within three clicks the page is dark.
      const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      for (let clicks = 0; clicks < 3 && (await theme()) !== 'dark'; clicks++) {
        await page.locator('#theme-toggle').click();
      }
      expect(await theme()).toBe('dark');
      await expect(page.locator('.diff-toolbar')).toBeVisible();
    });
  });
}
