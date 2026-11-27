// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: one comment form per range, and one save per click of Save, in
 * both modes.
 *
 *  - A form's identity is its file, first line, last line and side (ledger
 *    H182). A form on line 11 and a form on the range 11-13 are two forms,
 *    and each saves its own range; a second + on a line whose form is open,
 *    or a second Edit on a suggestion whose edit form is open, gives the
 *    reader that form back (with what they typed) and adds nothing. Before,
 *    the id had no last line: the range form was the line form, and saved
 *    11-11; two annotations shared one element.
 *  - Save stays disabled while its save is on its way (ledger H183): a
 *    double click or Cmd/Ctrl+Enter twice posts once. A save that fails
 *    while the file is scrolled out of the viewer's mounted window leaves a
 *    form that can be saved again when the reader comes back.
 *
 * The corpus is `reviewFixesCorpus` (tests/e2e/fixtures/diffs.js).
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, seedSuggestions, cleanupAllComments, expectResponse
} from './helpers.js';
import { reviewFixesCorpus, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, openLineCommentForm, selectLineRange, inlineSuggestion, waitForContentUpgrade, waitForDiffSettled,
  lineNumberCell, scrollFileIntoView, scrollFileOutOfView, scrollState
} from './diff-dom.js';

const CORPUS = reviewFixesCorpus();
const ALPHA = 'src/alpha.js';
const BETA = 'src/beta.js';

const savedComments = (page, reviewId) => page.evaluate(async (rid) => {
  const response = await fetch(`/api/reviews/${rid}/comments`);
  return (await response.json()).comments || [];
}, reviewId);

const forms = (page, file) => fileWrapper(page, file).locator('.user-comment-form');

/**
 * Hold every POST of a new comment (or of an edited suggestion) until
 * `release()`, and count them. `postsBefore()` answers how many had reached
 * the network when a sentinel request, made by the page after the gesture,
 * reached it: requests leave the page in the order it makes them, so a
 * second save made by the gesture is counted by then.
 */
async function holdSaves(page, pattern) {
  const state = { posts: 0, failNext: false };
  let release;
  let held = new Promise((resolve) => { release = resolve; });
  state.release = () => release();
  state.rearm = () => { held = new Promise((resolve) => { release = resolve; }); };
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.posts++;
    await held;
    if (state.failNext) {
      state.failNext = false;
      return route.fulfill({ status: 500, json: { error: 'The test server refused this save' } });
    }
    return route.fallback();
  });
  state.postsBefore = async () => {
    let seen = null;
    await page.route('**/e2e-sentinel', (route) => { seen = state.posts; return route.fulfill({ json: {} }); });
    await page.evaluate(() => fetch('/e2e-sentinel').then((r) => r.json()));
    return seen;
  };
  return state;
}

for (const mode of MODES) {
  test.describe(`Comment form identity and Save (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await routeDiff(page, CORPUS);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await waitForContentUpgrade(page, ALPHA);
      await waitForDiffSettled(page);
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('a form on a line and a form on a range starting there are two forms, and the range form saves the whole range', async ({ page }) => {
      await openLineCommentForm(page, { file: ALPHA, line: 11 });
      await expect(forms(page, ALPHA)).toHaveCount(1);
      await selectLineRange(page, { file: ALPHA, start: 11, end: 13 });
      // The + of a line inside the selection comments the selection.
      await openLineCommentForm(page, { file: ALPHA, line: 13 });
      await expect(forms(page, ALPHA)).toHaveCount(2);

      const range = forms(page, ALPHA).filter({ has: page.locator('.line-range-indicator', { hasText: 'Lines 11-13' }) });
      await expect(range).toHaveCount(1);
      const body = `Range comment ${Date.now()}`;
      await range.locator('textarea').fill(body);
      const saved = expectResponse(page, (r) => /\/comments$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
      await range.locator('.save-comment-btn').click();
      expect((await saved).request().postDataJSON()).toMatchObject({ file: ALPHA, line_start: 11, line_end: 13, side: 'RIGHT' });

      const card = fileWrapper(page, ALPHA).locator('.user-comment-row', { hasText: body });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Lines 11-13');
      expect((await savedComments(page, mode.reviewId)).find((c) => c.body === body))
        .toMatchObject({ file: ALPHA, line_start: 11, line_end: 13, side: 'RIGHT' });
      // The line form is still open, on its own line.
      await expect(forms(page, ALPHA)).toHaveCount(1);
      expect(await forms(page, ALPHA).locator('textarea').evaluate((textarea) => [textarea.dataset.line, textarea.dataset.lineEnd]))
        .toEqual(['11', '11']);
    });

    test('a second + on a line whose form is open gives that form back with its text, and adds nothing', async ({ page }) => {
      await openLineCommentForm(page, { file: BETA, line: 30 });
      const form = forms(page, BETA);
      await form.locator('textarea').fill('A draft');
      const height = async () => (await fileWrapper(page, BETA).boundingBox()).height;
      const before = await height();
      await page.locator('.diff-toolbar').click({ position: { x: 5, y: 5 } });

      // The same gesture again, on the same line.
      const cell = lineNumberCell(fileWrapper(page, BETA), 30, { side: 'additions' }).first();
      await cell.hover();
      await expect(fileWrapper(page, BETA).locator('.pierre-comment-btn').first()).toBeVisible();
      await fileWrapper(page, BETA).locator('.pierre-comment-btn').first().click();

      await expect(form.locator('textarea')).toBeFocused();
      await expect(form).toHaveCount(1);
      await expect(form.locator('textarea')).toHaveValue('A draft');
      await waitForDiffSettled(page);
      expect(await height()).toBe(before);

      // One Cancel closes it, and nothing of it is left.
      await form.locator('.cancel-comment-btn').click();
      await expect(form).toHaveCount(0);
      await waitForDiffSettled(page);
      await openLineCommentForm(page, { file: BETA, line: 30 });
      await expect(forms(page, BETA).locator('textarea')).toHaveValue('');
    });

    test('a second Edit on a suggestion whose edit form is open gives that form back with its text', async ({ page }) => {
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: ALPHA, line_start: 12, type: 'improvement', title: 'Double it', body: 'Original suggestion body' }
      ]);
      const card = inlineSuggestion(page, id);
      await expect(card).toBeVisible();
      await card.locator('.ai-action-edit').click();
      const form = forms(page, ALPHA);
      await expect(form).toHaveCount(1);
      await form.locator('textarea').fill('Edited once');
      await page.locator('.diff-toolbar').click({ position: { x: 5, y: 5 } });

      await card.locator('.ai-action-edit').click();
      await expect(form.locator('textarea')).toBeFocused();
      await expect(form).toHaveCount(1);
      await expect(form.locator('textarea')).toHaveValue('Edited once');
    });

    for (const gesture of ['a double click on Save', 'Cmd/Ctrl+Enter twice']) {
      test(`${gesture} while the save is on its way posts the comment once`, async ({ page }) => {
        const saves = await holdSaves(page, /\/api\/reviews\/\d+\/comments$/);
        await openLineCommentForm(page, { file: ALPHA, line: 12 });
        const form = forms(page, ALPHA);
        const body = `Saved once ${Date.now()}`;
        await form.locator('textarea').fill(body);
        if (gesture === 'a double click on Save') {
          await form.locator('.save-comment-btn').dblclick();
        } else {
          await form.locator('textarea').press('ControlOrMeta+Enter');
          await form.locator('textarea').press('ControlOrMeta+Enter');
        }
        await expect(form.locator('.save-comment-btn')).toBeDisabled();
        expect(await saves.postsBefore()).toBe(1);

        saves.release();
        await expect(fileWrapper(page, ALPHA).locator('.user-comment-row', { hasText: body })).toHaveCount(1);
        await expect(page.locator('.user-comment-form')).toHaveCount(0);
        expect((await savedComments(page, mode.reviewId)).filter((c) => c.body === body)).toHaveLength(1);
        expect(await saves.postsBefore()).toBe(1);
      });
    }

    test('a double click on Save of a suggestion\'s edit form adopts it once', async ({ page }) => {
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: ALPHA, line_start: 12, type: 'improvement', title: 'Double it', body: 'Original suggestion body' }
      ]);
      await inlineSuggestion(page, id).locator('.ai-action-edit').click();
      const form = forms(page, ALPHA);
      await form.locator('textarea').fill('Edited by the reviewer');
      const saves = await holdSaves(page, new RegExp(`/suggestions/${id}/edit$`));
      await form.locator('.save-comment-btn').dblclick();
      await expect(form.locator('.save-comment-btn')).toBeDisabled();
      expect(await saves.postsBefore()).toBe(1);
      saves.release();
      await expect(fileWrapper(page, ALPHA).locator('.user-comment-row', { hasText: 'Edited by the reviewer' })).toHaveCount(1);
      expect((await savedComments(page, mode.reviewId)).filter((c) => c.body === 'Edited by the reviewer')).toHaveLength(1);
      expect(await saves.postsBefore()).toBe(1);
    });

    test.describe(() => {
      // The refused save: the browser reports the status; the page shows nothing (as on main).
      test.use({ expectedConsoleErrors: [/Failed to load resource: the server responded with a status of 500/] });

      test('a save that fails while the file is scrolled away leaves the form, with its text, ready to save again', async ({ page }) => {
        const saves = await holdSaves(page, /\/api\/reviews\/\d+\/comments$/);
        saves.failNext = true;
        await openLineCommentForm(page, { file: ALPHA, line: 12 });
        const body = `Saved on the second try ${Date.now()}`;
        await forms(page, ALPHA).locator('textarea').fill(body);
        await forms(page, ALPHA).locator('.save-comment-btn').click();
        await expect.poll(() => saves.posts).toBe(1);

        // The reader scrolls far away before the answer comes: the file has no element.
        await scrollFileOutOfView(page, ALPHA);
        await expect(fileWrapper(page, ALPHA)).toHaveCount(0);
        const refused = expectResponse(page, (r) => /\/comments$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
        saves.release();
        expect((await refused).status()).toBe(500);

        await scrollFileIntoView(page, ALPHA);
        const form = forms(page, ALPHA);
        await expect(form.locator('textarea')).toHaveValue(body);
        await expect(form.locator('.save-comment-btn')).toBeEnabled();
        saves.rearm();
        const saved = expectResponse(page, (r) => /\/comments$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
        await form.locator('.save-comment-btn').click();
        saves.release();
        expect((await saved).status()).toBe(200);
        await expect(fileWrapper(page, ALPHA).locator('.user-comment-row', { hasText: body })).toBeVisible();
        expect((await savedComments(page, mode.reviewId)).filter((c) => c.body === body)).toHaveLength(1);
      });
    });

    test('putting the caret back in an open form does not move the pane when the form is outside it', async ({ page }) => {
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: ALPHA, line_start: 12, type: 'improvement', title: 'Double it', body: `A long suggestion.\n\n${'A line of reasoning.\n\n'.repeat(30)}` }
      ]);
      const card = inlineSuggestion(page, id);
      await expect(card).toBeVisible();
      await card.locator('.ai-action-edit').click();
      const form = forms(page, ALPHA);
      await expect(form).toHaveCount(1);
      await form.locator('textarea').fill('Edited once');
      await page.locator('.diff-toolbar').click({ position: { x: 5, y: 5 } });
      // The Edit button at the bottom of the pane, the form (above the card) out of the pane at its top.
      const edit = card.locator('.ai-action-edit');
      await edit.evaluate((button) => button.scrollIntoView({ block: 'end' }));
      await waitForDiffSettled(page);
      const view = await page.locator('#diff-container').boundingBox();
      await expect.poll(async () => {
        const box = await form.boundingBox();
        return !!box && (box.y + box.height < view.y || box.y > view.y + view.height);
      }).toBe(true);
      await expect(edit).toBeInViewport();
      const before = (await scrollState(page)).top;

      // Clicked from the page: Playwright scrolls a control it clicks into view itself.
      await edit.evaluate((button) => button.click());
      await expect(form.locator('textarea')).toBeFocused();
      await waitForDiffSettled(page);
      expect((await scrollState(page)).top).toBe(before);
    });
  });
}
