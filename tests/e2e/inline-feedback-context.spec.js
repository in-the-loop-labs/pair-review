// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

const FILE = 'src/main.js';
const MODES = [
  { name: 'PR', path: '/pr/test-owner/test-repo/1', diff: '**/api/pr/*/*/*/diff' },
  { name: 'Local', path: '/local/2', diff: '**/api/local/2/diff' }
];

function feedback(id, line, source = 'user', end = line) {
  return {
    id, source, file: FILE, line_start: line, line_end: end, side: 'RIGHT',
    body: `Feedback ${id}`, status: 'active', is_file_level: 0,
    ...(source === 'ai' ? { type: 'bug', title: `Suggestion ${id}`, ai_level: null } : {})
  };
}

async function setup(page, mode, state) {
  const oldLines = Array.from({ length: 200 }, (_, index) => `// line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[99] = '// changed line 100';
  const diff = [
    `diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`,
    '@@ -97,7 +97,7 @@',
    ...oldLines.slice(96, 99).map(line => ` ${line}`),
    `-${oldLines[99]}`, `+${newLines[99]}`,
    ...oldLines.slice(100, 103).map(line => ` ${line}`), ''
  ].join('\n');

  await page.route(mode.diff, route => route.fulfill({ json: {
    diff, changed_files: [{ file: FILE, additions: 1, deletions: 1 }],
    stats: { files_changed: 1, additions: 1, deletions: 1 }
  } }));
  await page.route('**/api/reviews/*/file-contents/**', route => route.fulfill({ json: {
    fileName: FILE, oldContents: oldLines.join('\n'), newContents: newLines.join('\n')
  } }));
  await page.route(/\/api\/reviews\/\d+\/comments(\?|$)/,
    route => route.fulfill({ json: { comments: state.comments } }));
  await page.route(/\/api\/reviews\/\d+\/suggestions(\?|$)/,
    route => route.fulfill({ json: { suggestions: state.suggestions } }));
  // An empty analysis history prevents the page from starting its own
  // suggestion load, so the explicit refresh below is the only writer.
  await page.route('**/api/analyses/runs*',
    route => route.fulfill({ json: { runs: [] } }));
  await page.route('**/api/local/2/check-stale',
    route => route.fulfill({ json: { isStale: false } }));
  await page.goto(mode.path);
  await waitForDiffToRender(page);
  // The history manager is created after the panel and initial comments load.
  await page.waitForFunction(() => !!window.prManager?.analysisHistoryManager);
  await page.evaluate(() => window.prManager.loadAISuggestions());
}

function inlineComment(page, id) {
  return page.locator(`.pierre-diff-body .user-comment-row[data-comment-id="${id}"]`);
}

function inlineSuggestion(page, id) {
  return page.locator(`.pierre-diff-body .ai-suggestion[data-suggestion-id="${id}"]`);
}

for (const mode of MODES) {
  test.describe(`Inline feedback context (${mode.name})`, () => {
    test('off-hunk comments remain visible when suggestions are refreshed', async ({ page }) => {
      const state = { comments: [feedback(9101, 20)], suggestions: [] };
      await setup(page, mode, state);
      await expect(inlineComment(page, 9101)).toBeVisible();

      state.suggestions = [feedback(9201, 180, 'ai')];
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9201)).toBeVisible();
      await expect(inlineComment(page, 9101)).toBeVisible();

      // A second refresh must preserve the same two anchors without duplicates.
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9201)).toHaveCount(1);
      await expect(inlineComment(page, 9101)).toBeVisible();
    });

    test('comments on manually expanded lines survive another off-hunk anchor', async ({ page }) => {
      const state = { comments: [], suggestions: [] };
      await setup(page, mode, state);
      await page.evaluate(async file => {
        await window.prManager._ensurePierreContentUpgrade(file);
        const { instance } = window.prManager.pierreBridge.files.get(file);
        instance.expandHunk(0, 'up', 85);
        instance.rerender();
      }, FILE);
      await expect.poll(() => page.evaluate(file =>
        window.prManager.pierreBridge.isLineVisible(file, 85, 'RIGHT'), FILE)).toBe(true);

      state.comments = [feedback(9102, 85), feedback(9103, 180)];
      await page.evaluate(() => window.prManager.loadUserComments());
      await expect(inlineComment(page, 9102)).toBeVisible();
      await expect(inlineComment(page, 9103)).toBeVisible();
    });

    test('expanding a preceding gap does not hide a suggestion after the hunk', async ({ page }) => {
      const state = { comments: [], suggestions: [] };
      await setup(page, mode, state);
      const target = await page.evaluate(async file => {
        const manager = window.prManager;
        await manager._ensurePierreContentUpgrade(file);
        const instance = manager.pierreBridge.files.get(file).instance;
        const index = instance.fileDiff.hunks.findIndex(hunk =>
          hunk.additionStart <= 100 && hunk.additionStart + hunk.additionCount > 100);
        const hunk = instance.fileDiff.hunks[index];
        // Pierre's "down" direction reveals the END of the preceding gap.
        // It must not make lines following this hunk count as already visible.
        manager.pierreBridge.expandHunk(file, index, 'down', 5);
        return hunk.additionStart + hunk.additionCount + 1;
      }, FILE);

      state.suggestions = [feedback(9203, target, 'ai')];
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9203)).toBeVisible();
      await page.evaluate(() => window.aiPanel.expand());
      await page.locator('.ai-panel .finding-item[data-id="9203"]').click();
      await expect(inlineSuggestion(page, 9203)).toBeInViewport();
    });

    test('suggestions spanning a visible hunk and hidden endpoint render and navigate', async ({ page }) => {
      const state = { comments: [], suggestions: [feedback(9202, 100, 'ai', 150)] };
      await setup(page, mode, state);
      const suggestion = inlineSuggestion(page, 9202);
      await expect(suggestion).toBeVisible();
      await expect.poll(() => page.evaluate(file =>
        window.prManager.pierreBridge.isLineVisible(file, 150, 'RIGHT'), FILE)).toBe(true);

      // Rebuild from base metadata while retaining the annotation and durable
      // context ranges. Navigation must check the rows actually rendered.
      await page.evaluate(file => {
        const bridge = window.prManager.pierreBridge;
        const fileState = bridge.files.get(file);
        bridge._renderWithFileDiff(fileState, fileState.baseMetadata);
      }, FILE);
      await expect.poll(() => page.evaluate(file =>
        window.prManager.pierreBridge.isLineVisible(file, 150, 'RIGHT'), FILE)).toBe(false);
      await expect(suggestion).toBeHidden();

      // Collapse the file through the UI, then navigate to its range from
      // the sidebar to reveal the card again.
      const fileWrapper = page.locator(`.d2h-file-wrapper[data-file-name="${FILE}"]`);
      await fileWrapper.locator('.d2h-file-header').click();
      await expect(fileWrapper).toHaveClass(/collapsed/);
      await expect(suggestion).toBeHidden();
      // Use the actual sidebar click path to reveal the collapsed target again.
      await page.evaluate(() => window.aiPanel.expand());
      await page.locator('.ai-panel .finding-item[data-id="9202"]').click();
      await expect(fileWrapper).not.toHaveClass(/collapsed/);
      await expect(suggestion).toBeInViewport();
    });
  });
}
