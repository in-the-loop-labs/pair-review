// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';
import { customCorpus, routeDiff } from './fixtures/diffs.js';

// Inside a hunk, a removed `-- x` line (SQL/Lua comment) is emitted as `--- x`
// and an added `++ x` line as `+++ x`. Local mode counts its file stats in the
// browser from the diff; those lines must count as the changes they are.
// PR mode takes its counts from the server's changed_files, which the server
// derives from the same diff with its own parser; both are asserted.
// Verbatim `git diff` output.
const DIFF = [
  'diff --git a/a.js b/a.js',
  'index 489ce0f..3e5126c 100644',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1 +1 @@',
  '-old',
  '\\ No newline at end of file',
  '+new',
  '\\ No newline at end of file',
  'diff --git a/img.bin b/img.bin',
  'index bdc955b..8835708 100644',
  'Binary files a/img.bin and b/img.bin differ',
  'diff --git a/q.sql b/q.sql',
  'index 9ef5139..7d58919 100644',
  '--- a/q.sql',
  '+++ b/q.sql',
  '@@ -1,4 +1,4 @@',
  ' select 1;',
  '--- legacy comment',
  '-drop table t;',
  '+++ new comment',
  '+++x',
  ' select 2;',
  ''
].join('\n');

// The contents the patch was taken from. The frontend upgrades each rendered
// file with its full contents; contents that do not belong to the patch make
// the vendor report a mismatch (the test used to answer '' for every file).
const CORPUS = customCorpus({
  name: 'header-lookalikes',
  diff: DIFF,
  files: {
    'a.js': { old: 'old', new: 'new' },
    'img.bin': { binary: true },
    'q.sql': {
      old: 'select 1;\n-- legacy comment\ndrop table t;\nselect 2;\n',
      new: 'select 1;\n++ new comment\n++x\nselect 2;\n'
    }
  }
});

const MODES = [
  { name: 'PR', path: '/pr/test-owner/test-repo/1' },
  { name: 'Local', path: '/local/2' }
];

for (const mode of MODES) {
  test.describe(`Diff lines that look like file headers (${mode.name})`, () => {
    test('toolbar totals and sidebar counts include them', async ({ page }) => {
      await routeDiff(page, CORPUS);
      await page.route('**/api/reviews/*/context-files',
        route => route.fulfill({ json: { contextFiles: [] } }));

      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Local mode counts in the browser from the diff. PR mode shows the
      // pull request's own totals in the toolbar (from the fixture's metadata,
      // not from this diff), so only Local asserts the toolbar.
      if (mode.name === 'Local') {
        await expect(page.locator('#pr-additions')).toHaveText('+3');
        await expect(page.locator('#pr-deletions')).toHaveText('-3');
      }

      // Before the fix q.sql counted +0 -1 and was badged as deleted.
      const sql = page.locator('.file-item[data-path="q.sql"]');
      await expect(sql).toHaveAttribute('data-status', 'modified');
      await expect(sql.locator('.file-additions')).toHaveText('+2');
      await expect(sql.locator('.file-deletions')).toHaveText('-2');

      // Real headers, `\\ No newline` markers and binary sections stay uncounted.
      const js = page.locator('.file-item[data-path="a.js"]');
      await expect(js.locator('.file-additions')).toHaveText('+1');
      await expect(js.locator('.file-deletions')).toHaveText('-1');
      // The binary section is not counted in either mode. The modes label it
      // differently: PR mode gets `binary: true` from the server's
      // changed_files and shows "BIN"; Local mode builds its file list in the
      // browser and never sets the flag, so it shows nothing (a pre-existing
      // Local gap, recorded in plans/codeview-virtualized-diff.md).
      await expect(page.locator('.file-item[data-path="img.bin"] .file-changes'))
        .toHaveText(mode.name === 'PR' ? 'BIN' : '');
    });
  });
}
