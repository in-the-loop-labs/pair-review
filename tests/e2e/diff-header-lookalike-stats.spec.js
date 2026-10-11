// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

// Inside a hunk, a removed `-- x` line (SQL/Lua comment) is emitted as `--- x`
// and an added `++ x` line as `+++ x`. Local mode counts its file stats in the
// browser from the diff; those lines must count as the changes they are.
// (PR mode takes its counts from the server's changed_files.)
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

test.describe('Diff lines that look like file headers (Local)', () => {
  test('toolbar totals and sidebar counts include them', async ({ page }) => {
    await page.route('**/api/local/2/diff', route => route.fulfill({ json: {
      diff: DIFF,
      stats: { files_changed: 3, additions: 3, deletions: 3 }
    } }));
    await page.route('**/api/reviews/*/file-contents/**', route => route.fulfill({ json: {
      fileName: 'q.sql', oldContents: '', newContents: ''
    } }));
    await page.route('**/api/reviews/*/context-files',
      route => route.fulfill({ json: { contextFiles: [] } }));
    await page.route('**/api/local/2/check-stale',
      route => route.fulfill({ json: { isStale: false } }));

    await page.goto('/local/2');
    await waitForDiffToRender(page);

    await expect(page.locator('#pr-additions')).toHaveText('+3');
    await expect(page.locator('#pr-deletions')).toHaveText('-3');

    // Before the fix q.sql counted +0 -1 and was badged as deleted.
    const sql = page.locator('.file-item[data-path="q.sql"]');
    await expect(sql).toHaveAttribute('data-status', 'modified');
    await expect(sql.locator('.file-additions')).toHaveText('+2');
    await expect(sql.locator('.file-deletions')).toHaveText('-2');

    // Real headers, `\ No newline` markers and binary sections stay uncounted.
    const js = page.locator('.file-item[data-path="a.js"]');
    await expect(js.locator('.file-additions')).toHaveText('+1');
    await expect(js.locator('.file-deletions')).toHaveText('-1');
    await expect(page.locator('.file-item[data-path="img.bin"] .file-changes')).toHaveText('');
  });
});
