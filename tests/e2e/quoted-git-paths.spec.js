// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

// pair-review runs git with core.quotePath=false, but git still C-quotes a
// header path containing `"`, `\` or a control character, and diffs cached by
// older versions carry octal-escaped non-ASCII names. The server keys
// changed_files, comments and suggestions by the decoded name, so the browser
// must key the sidebar, the diff wrapper and inline anchoring the same way.
const FILE = 'src/quo"te.js';
const RENAMED = 'ñew dir/moved é.js';
const MODES = [
  { name: 'PR', path: '/pr/test-owner/test-repo/1', diff: '**/api/pr/*/*/*/diff' },
  { name: 'Local', path: '/local/2', diff: '**/api/local/2/diff' }
];

// CSS attribute-selector value for a path that may contain `"`
const attr = value => JSON.stringify(value);

// First file: verbatim `git -c core.quotePath=false diff` output. Second file:
// verbatim `git diff` output with git's default core.quotePath=true, as cached
// by an older version (the browser gets both until the review is refreshed).
const DIFF = [
  String.raw`diff --git "a/src/quo\"te.js" "b/src/quo\"te.js"`,
  'index 1111111..2222222 100644',
  String.raw`--- "a/src/quo\"te.js"`,
  String.raw`+++ "b/src/quo\"te.js"`,
  '@@ -1,4 +1,4 @@',
  ' const one = 1;',
  '-const two = 2;',
  '+const two = 22;',
  ' const three = 3;',
  ' const four = 4;',
  String.raw`diff --git a/lib/moved.js "b/\303\261ew dir/moved \303\251.js"`,
  'similarity index 80%',
  'rename from lib/moved.js',
  String.raw`rename to "\303\261ew dir/moved \303\251.js"`,
  'index 3333333..4444444 100644',
  '--- a/lib/moved.js',
  String.raw`+++ "b/\303\261ew dir/moved \303\251.js"` + '\t',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  ''
].join('\n');

const OLD_LINES = ['const one = 1;', 'const two = 2;', 'const three = 3;', 'const four = 4;'];
const NEW_LINES = ['const one = 1;', 'const two = 22;', 'const three = 3;', 'const four = 4;'];

function feedback(id, file, line, source) {
  return {
    id, source, file, line_start: line, line_end: line, side: 'RIGHT',
    body: `Feedback ${id}`, status: 'active', is_file_level: 0,
    ...(source === 'ai' ? { type: 'bug', title: `Suggestion ${id}`, ai_level: null } : {})
  };
}

async function setup(page, mode, state) {
  // The server's decoded changed_files (PR mode); Local mode derives the
  // file list from the diff headers alone.
  await page.route(mode.diff, route => route.fulfill({ json: {
    diff: DIFF,
    changed_files: [
      { file: FILE, insertions: 1, deletions: 1, changes: 2, binary: false },
      { file: RENAMED, insertions: 1, deletions: 1, changes: 2, binary: false, renamed: true, renamedFrom: 'lib/moved.js' }
    ],
    stats: { files_changed: 2, additions: 2, deletions: 2 }
  } }));
  await page.route('**/api/reviews/*/file-contents/**', route => {
    const requested = decodeURIComponent(new URL(route.request().url()).pathname.split('/file-contents/')[1]);
    state.contentRequests.push(requested);
    return route.fulfill({ json: requested === FILE
      ? { fileName: FILE, oldContents: OLD_LINES.join('\n'), newContents: NEW_LINES.join('\n') }
      : { fileName: requested, oldContents: 'keep\nold', newContents: 'keep\nnew' } });
  });
  await page.route('**/api/reviews/*/context-files',
    route => route.fulfill({ json: { contextFiles: [] } }));
  await page.route(/\/api\/reviews\/\d+\/comments(\?|$)/, route => {
    if (route.request().method() === 'POST') {
      state.posted.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true, commentId: 9990 + state.posted.length } });
    }
    return route.fulfill({ json: { comments: state.comments } });
  });
  await page.route(/\/api\/reviews\/\d+\/suggestions(\?|$)/,
    route => route.fulfill({ json: { suggestions: state.suggestions } }));
  await page.route('**/api/analyses/runs*',
    route => route.fulfill({ json: { runs: [] } }));
  await page.route('**/api/local/2/check-stale',
    route => route.fulfill({ json: { isStale: false } }));
  await page.goto(mode.path);
  await waitForDiffToRender(page);
  await page.waitForFunction(() => !!window.prManager?.analysisHistoryManager);
  await page.evaluate(() => window.prManager.loadAISuggestions());
}

for (const mode of MODES) {
  test.describe(`Quoted git paths (${mode.name})`, () => {
    test('sidebar, diff wrapper and inline feedback use the decoded path', async ({ page }) => {
      const state = {
        posted: [],
        contentRequests: [],
        comments: [feedback(9401, FILE, 2, 'user')],
        suggestions: [feedback(9402, FILE, 3, 'ai'), feedback(9403, RENAMED, 1, 'ai')]
      };
      await setup(page, mode, state);

      // One sidebar entry per file, spelled like the server.
      await expect(page.locator('.file-item')).toHaveCount(2);
      await expect(page.locator(`.file-item[data-path=${attr(FILE)}]`)).toHaveCount(1);
      await expect(page.locator(`.file-item[data-path=${attr(RENAMED)}]`)).toHaveCount(1);
      await expect(page.locator('.file-item[data-path*="\\\\303"]')).toHaveCount(0);
      await expect(page.locator('.file-item[data-path*="\\\\\\""]')).toHaveCount(0);

      // One diff wrapper per file, keyed by the decoded path and rendering
      // its patch.
      const wrapper = page.locator(`.d2h-file-wrapper[data-file-name=${attr(FILE)}]`);
      const renamedWrapper = page.locator(`.d2h-file-wrapper[data-file-name=${attr(RENAMED)}]`);
      await expect(page.locator('.d2h-file-wrapper[data-file-name]')).toHaveCount(2);
      await expect(wrapper).toHaveCount(1);
      await expect(renamedWrapper).toHaveCount(1);
      await expect(wrapper.locator('[data-column-number]').first()).toBeVisible();

      // Server feedback keyed by the decoded path anchors inline.
      await expect(wrapper.locator('.user-comment-row[data-comment-id="9401"]')).toBeVisible();
      await expect(wrapper.locator('.ai-suggestion[data-suggestion-id="9402"]')).toBeVisible();
      await expect(renamedWrapper.locator('.ai-suggestion[data-suggestion-id="9403"]')).toBeVisible();
      // Full-file contents are requested by the decoded path too.
      await expect.poll(() => state.contentRequests.includes(FILE)).toBe(true);
      expect(state.contentRequests.every(file => [FILE, RENAMED].includes(file))).toBe(true);

      // A comment written from the diff is saved against the decoded path.
      await wrapper.locator('[data-column-number]').first().hover();
      const addCommentBtn = wrapper.locator('.pierre-comment-btn').first();
      await addCommentBtn.waitFor({ state: 'visible', timeout: 5000 });
      await addCommentBtn.click();
      await page.locator('.user-comment-form textarea').fill('Decoded path comment');
      await page.locator('.save-comment-btn').click();
      await expect.poll(() => state.posted.length).toBe(1);
      expect(state.posted[0].file).toBe(FILE);
    });
  });
}
