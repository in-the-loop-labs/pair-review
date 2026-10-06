// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/** Chat file references must be temporary until the reviewer explicitly keeps them. */
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';
import database from '../../src/database.js';

const { ContextFileRepository } = database;
const FILE = 'src/helpers/compute-value.js';
const LINES = [
  '// Shared value computation used by the review changes.',
  '',
  'const DEFAULT_VALUE = 0;',
  '',
  'function normalize(value) {',
  '  return Number.isFinite(value) ? value : DEFAULT_VALUE;',
  '}',
  '',
  '/** Compute a stable result from the latest input. */',
  'export function computeValue(input) {',
  '  const current = input?.current;',
  '  const previous = input?.previous;',
  '',
  '  if (current == null) {',
  '    return normalize(previous);',
  '  }',
  '',
  '  return normalize(current);',
  '}',
  '',
  'export function hasValue(input) {',
  '  return input?.current != null;',
  '}',
];
const MODES = [
  { name: 'PR', path: '/pr/test-owner/test-repo/1', id: 1, source: 'Review head', revision: '2a91c7de4f68b013e9a2d5c608f34b719d8e0c65' },
  { name: 'Local', path: '/local/2', id: 2, source: 'Working tree', revision: null },
];

function previewData(mode) {
  return { fileName: FILE, lines: LINES, totalLines: LINES.length, source: mode.source, revision: mode.revision };
}

async function openChat(page, mode) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/reviews/*/code-preview/**', route => route.fulfill({ json: previewData(mode) }));
  if (mode.name === 'PR') {
    await page.route('**/api/pr/test-owner/test-repo/1', async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.head_sha = mode.revision;
      await route.fulfill({ response, json: body });
    });
  } else {
    // Keep metadata and staleness checks independent of a real local Git repo.
    await page.route('**/api/local/2', route => route.fulfill({ json: {
      id: 2, localPath: '/tmp/test-local-repo', localHeadSha: 'abc123localhead',
      repository: 'test-repo', branch: 'feature-test', reviewType: 'local', status: 'draft',
      localMode: 'uncommitted', scopeStart: 'unstaged', scopeEnd: 'untracked',
      branchAvailable: false, shaAbbrevLength: 7,
    } }));
    await page.route('**/api/local/2/check-stale', route => route.fulfill({ json: { isStale: false } }));
  }
  await page.goto(mode.path);
  await waitForDiffToRender(page);
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'available');
    window.__pairReview.chatProvider = 'pi';
    window.__pairReview.chatProviders = [{ id: 'pi', name: 'Pi', type: 'pi', available: true }];
    window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
    const open = window.chatPanel.open.bind(window.chatPanel);
    window.chatPanel.open = (...args) => {
      window.__previewChatOpened = open(...args);
      return window.__previewChatOpened;
    };
  });
  await page.locator('#chat-toggle-btn').click();
  // Await the real open path, including any restored message history.
  await page.evaluate(() => window.__previewChatOpened);
  await expect(page.locator('.chat-panel')).toBeVisible();
  await expect(page.locator('.chat-panel__input')).toBeVisible();
  await page.evaluate(file => {
    window.chatPanel.addMessage('assistant',
      `The new helper calls computeValue(). Its fallback lives in [[file:${file}:12-17]], outside this diff. Open that range to check how a missing value behaves.`);
    window.chatPanel.addMessage('assistant', 'The caller is [[file:src/utils.js:3-5]].');
  }, FILE);
  await page.locator('.chat-panel__input').fill('Should this also handle a missing value?');
}

function fileLink(page, file = FILE) {
  return page.locator(`.chat-file-link[data-file="${file}"]`).last();
}

async function contextFiles(page, reviewId) {
  return page.evaluate(async id => {
    const response = await fetch(`/api/reviews/${id}/context-files`);
    return (await response.json()).contextFiles;
  }, reviewId);
}

for (const mode of MODES) {
  test.describe(`Chat code preview (${mode.name})`, () => {
    test.beforeEach(async ({ testServer }) => {
      testServer.db.prepare('DELETE FROM context_files WHERE review_id = ? AND file = ?').run(mode.id, FILE);
    });

    test.afterEach(async ({ testServer }) => {
      testServer.db.prepare('DELETE FROM context_files WHERE review_id = ? AND file = ?').run(mode.id, FILE);
    });

    test('opens a read-only cited range and restores the original review and chat', async ({ page }, testInfo) => {
      await openChat(page, mode);
      const contextPosts = [];
      page.on('request', request => {
        if (request.method() === 'POST' && request.url().endsWith(`/api/reviews/${mode.id}/context-files`)) {
          contextPosts.push(request);
        }
      });
      const fileCount = await page.locator('#pr-files-count').textContent();
      const messages = await page.locator('.chat-panel__message').count();
      const tabs = await page.locator('.chat-panel__tab').count();
      const savedScroll = await page.evaluate(() => {
        const scroll = document.querySelector('.diff-view');
        scroll.scrollTop = 180;
        window.__previewOriginalDiff = document.getElementById('diff-container');
        return scroll.scrollTop;
      });
      expect(savedScroll).toBeGreaterThan(0);

      // Click the link rendered by ChatPanel, not the preview API directly.
      await fileLink(page).click();
      const preview = page.getByRole('region', { name: 'Code preview' });
      await expect(preview).toBeVisible();
      await expect(preview.locator('[data-preview-file]')).toHaveText(FILE);
      await expect(preview.locator('[data-preview-source]')).toContainText(mode.source);
      if (mode.revision) await expect(preview.locator('[data-preview-source]')).toContainText(mode.revision.slice(0, 8));
      await expect(preview.locator('.code-preview__badge')).toHaveText('Outside changes · Read only');
      await expect(preview.locator('.code-preview__highlight')).toHaveCount(6);
      await expect(preview.locator('[data-preview-line="14"] code')).toHaveText('  if (current == null) {');
      await expect(preview.locator('textarea, input, [contenteditable="true"], .pierre-comment-btn')).toHaveCount(0);
      await expect(page.locator('#diff-container')).toBeHidden();
      await expect(page.locator('.chat-panel')).toBeVisible();
      await expect(page.locator('.chat-panel__input')).toHaveValue('Should this also handle a missing value?');
      await expect(page.locator('.chat-panel__message')).toHaveCount(messages);
      await expect(page.locator('.chat-panel__tab')).toHaveCount(tabs);
      await expect(page.locator('#pr-files-count')).toHaveText(fileCount);

      // This completed read is the sentinel; no observation-window sleep.
      expect(await contextFiles(page, mode.id)).toEqual([]);
      expect(contextPosts).toEqual([]);
      if (mode.name === 'PR') await page.screenshot({ path: testInfo.outputPath('code-preview.png') });

      await preview.getByRole('button', { name: 'Back to review' }).click();
      await expect(preview).toHaveCount(0);
      await expect(page.locator('#diff-container')).toBeVisible();
      expect(await page.evaluate(() => document.getElementById('diff-container') === window.__previewOriginalDiff)).toBe(true);
      expect(await page.locator('.diff-view').evaluate(element => element.scrollTop)).toBe(savedScroll);
      await expect(fileLink(page)).toBeFocused();
      await expect(page.locator('.chat-panel__input')).toHaveValue('Should this also handle a missing value?');
    });

    test('keeps the file only on explicit request and renders the persisted context', async ({ page, testServer }) => {
      const posted = [];
      // The fixture has no Git repository. Persist through the real repository
      // class, then let the production GET and context renderer read that row.
      await page.route(`**/api/reviews/${mode.id}/context-files`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const body = route.request().postDataJSON();
        posted.push(body);
        const record = await new ContextFileRepository(testServer.db).add(
          mode.id, body.file, body.line_start, body.line_end);
        await route.fulfill({ status: 201, json: { success: true, contextFile: record } });
      });
      await openChat(page, mode);
      const fileCount = await page.locator('#pr-files-count').textContent();
      await fileLink(page).click();
      const preview = page.getByRole('region', { name: 'Code preview' });
      await expect(preview.locator('[data-preview-keep]')).toBeEnabled();
      expect(await contextFiles(page, mode.id)).toEqual([]);
      expect(posted).toEqual([]);

      await preview.getByRole('button', { name: 'Keep in review' }).click();
      await expect(preview.getByRole('button', { name: 'Kept in review' })).toBeDisabled();
      await expect(preview.locator('.code-preview__status')).toHaveText('Context file saved.');
      expect(posted).toEqual([{ file: FILE, line_start: 12, line_end: 17 }]);
      expect(await contextFiles(page, mode.id)).toEqual([
        expect.objectContaining({ file: FILE, line_start: 12, line_end: 17 }),
      ]);
      await expect(page.locator('#pr-files-count')).toHaveText(fileCount);
      await expect(page.locator('.chat-panel__input')).toHaveValue('Should this also handle a missing value?');

      await preview.getByRole('button', { name: 'Back to review' }).click();
      const context = page.locator(`.context-file[data-file-name="${FILE}"]`);
      await expect(context).toBeVisible();
      await expect(context).toContainText('if (current == null)');
      // Clicking a kept context link follows the existing review navigation.
      await fileLink(page).click();
      await expect(page.locator('.code-preview')).toHaveCount(0);
      expect(posted).toHaveLength(1);
    });

    test('shows a load error and retries the same cited range', async ({ page }) => {
      await openChat(page, mode);
      let attempts = 0;
      await page.route('**/api/reviews/*/code-preview/**', route => {
        attempts += 1;
        return route.fulfill(attempts === 1
          ? { status: 404, json: { error: 'File is absent from this review revision.' } }
          : { json: previewData(mode) });
      });
      await fileLink(page).click();
      const preview = page.getByRole('region', { name: 'Code preview' });
      await expect(preview.locator('.code-preview__status')).toHaveText('File is absent from this review revision.');
      await expect(preview.getByRole('button', { name: 'Keep in review' })).toBeDisabled();
      await expect(preview.locator('[data-preview-line]')).toHaveCount(0);
      await preview.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(preview.locator('.code-preview__highlight')).toHaveCount(6);
      await expect(preview.getByRole('button', { name: 'Keep in review' })).toBeEnabled();
      expect(attempts).toBe(2);
      expect(await contextFiles(page, mode.id)).toEqual([]);
      await expect(page.locator('.chat-panel__input')).toHaveValue('Should this also handle a missing value?');
    });

    test('an existing diff reference exits preview and navigates to the cited lines', async ({ page }) => {
      await openChat(page, mode);
      await fileLink(page).click();
      await expect(page.locator('.code-preview__highlight')).toHaveCount(6);

      await fileLink(page, 'src/utils.js').click();
      await expect(page.locator('.code-preview')).toHaveCount(0);
      await expect(page.locator('#diff-container')).toBeVisible();
      const wrapper = page.locator('.d2h-file-wrapper[data-file-name="src/utils.js"]');
      await expect(wrapper.locator('.pierre-line-highlight')).toHaveCount(3);
      expect(await contextFiles(page, mode.id)).toEqual([]);
      await expect(page.locator('.chat-panel')).toBeVisible();
    });

    test('Escape from the Back control closes only the preview and preserves chat', async ({ page }) => {
      await openChat(page, mode);
      const messages = await page.locator('.chat-panel__message').count();
      await fileLink(page).click();
      const preview = page.getByRole('region', { name: 'Code preview' });
      await expect(preview.locator('.code-preview__highlight')).toHaveCount(6);
      const back = preview.getByRole('button', { name: 'Back to review' });
      await expect(back).toBeFocused();

      await back.press('Escape');
      await expect(preview).toHaveCount(0);
      await expect(page.locator('#diff-container')).toBeVisible();
      await expect(page.locator('.chat-panel')).toBeVisible();
      await expect(page.locator('.chat-panel__message')).toHaveCount(messages);
      await expect(page.locator('.chat-panel__input')).toHaveValue('Should this also handle a missing value?');
      await expect(fileLink(page)).toBeFocused();
    });

    test('a leading ./ diff reference navigates directly without a preview request', async ({ page }) => {
      await openChat(page, mode);
      await page.evaluate(() => {
        window.chatPanel.addMessage('assistant', 'Check the caller at [[file:./src/utils.js:3-5]].');
      });
      const previewRequests = [];
      page.on('request', request => {
        if (request.url().includes('/code-preview/')) previewRequests.push(request);
      });

      await fileLink(page, './src/utils.js').click();
      const wrapper = page.locator('.d2h-file-wrapper[data-file-name="src/utils.js"]');
      await expect(wrapper.locator('.pierre-line-highlight')).toHaveCount(3);
      await expect(page.locator('.code-preview')).toHaveCount(0);
      await expect(page.locator('#diff-container')).toBeVisible();
      // Complete the ordered read before asserting the absence of a preview.
      expect(await contextFiles(page, mode.id)).toEqual([]);
      expect(previewRequests).toEqual([]);
      await expect(page.locator('.chat-panel')).toBeVisible();
      await expect(page.locator('.chat-panel__input')).toHaveValue('Should this also handle a missing value?');
    });
  });
}
