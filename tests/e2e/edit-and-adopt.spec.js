// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: edit-and-adopt of an AI suggestion (N7 of plans/codeview-virtualized-diff.md)
 *
 * Characterization of main in both modes: "Edit" on a suggestion opens a
 * form holding the suggestion's text; saving adopts the suggestion with the
 * edited text as a user comment; cancelling changes nothing. Also records
 * that the "show original suggestion" toggle is not reachable on main.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, seedSuggestions, cleanupAllComments, expectResponse } from './helpers.js';
import { fileWrapper, inlineSuggestion, waitForContentUpgrade } from './diff-dom.js';

const FILE = 'src/utils.js';

const fetchJson = (page, url) => page.evaluate(async (u) => (await fetch(u)).json(), url);

for (const mode of MODES) {
  test.describe(`Edit and adopt (${mode.name})`, () => {
    let suggestionId;

    test.beforeEach(async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      // The page loaded before the cleanup: drop what it drew of anything a
      // test that ran earlier in this worker left behind.
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await waitForContentUpgrade(page, FILE);
      [suggestionId] = await seedSuggestions(page, mode.reviewId, [
        { file: FILE, line_start: 5, type: 'improvement', title: 'Name the value', body: 'Original suggestion body' }
      ]);
      await expect(inlineSuggestion(page, suggestionId)).toBeVisible();
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('Edit opens a form with the suggestion text; saving adopts it as the edited comment', async ({ page }) => {
      await inlineSuggestion(page, suggestionId).locator('.ai-action-edit').click();
      const form = fileWrapper(page, FILE).locator('.user-comment-form');
      await expect(form).toBeVisible();
      await expect(form).toContainText('Edit suggestion');
      const textarea = form.locator('textarea');
      await expect(textarea).toHaveValue(/Original suggestion body/);

      await textarea.fill('Edited by the reviewer');
      const adopted = expectResponse(page, (r) => r.url().includes(`/suggestions/${suggestionId}/edit`));
      await form.locator('.save-comment-btn').click();
      expect((await adopted).status()).toBe(200);

      // The form is replaced by a user comment with the edited text.
      await expect(page.locator('.user-comment-form')).toHaveCount(0);
      const comment = fileWrapper(page, FILE).locator('.user-comment-row', { hasText: 'Edited by the reviewer' });
      await expect(comment).toBeVisible();

      // Stored: a user comment whose parent is the suggestion, and the suggestion adopted.
      const { comments } = await fetchJson(page, `/api/reviews/${mode.reviewId}/comments`);
      expect(comments.find((c) => c.body === 'Edited by the reviewer'))
        .toMatchObject({ file: FILE, line_start: 5, parent_id: suggestionId });
      const { suggestions } = await fetchJson(page, `/api/reviews/${mode.reviewId}/suggestions`);
      expect(suggestions.find((s) => s.id === suggestionId).status).toBe('adopted');

      // Characterization: main has a handler for a "show original suggestion"
      // toggle on the adopted comment (PRManager.toggleOriginalSuggestion) and
      // renders no control that reaches it.
      await expect(page.locator('.btn-toggle-original')).toHaveCount(0);

      // After a reload the adopted comment is there and the suggestion is not offered again as active.
      await page.reload();
      await waitForDiffToRender(page);
      await expect(fileWrapper(page, FILE).locator('.user-comment-row', { hasText: 'Edited by the reviewer' })).toBeVisible();
    });

    test('Cancel leaves the suggestion as it was and saves nothing', async ({ page }) => {
      await inlineSuggestion(page, suggestionId).locator('.ai-action-edit').click();
      const form = fileWrapper(page, FILE).locator('.user-comment-form');
      await expect(form).toBeVisible();
      await form.locator('textarea').fill('Thrown away');
      await form.locator('.cancel-comment-btn').click();

      await expect(page.locator('.user-comment-form')).toHaveCount(0);
      await expect(page.locator('.user-comment-row')).toHaveCount(0);
      await expect(inlineSuggestion(page, suggestionId)).toBeVisible();
      await expect(inlineSuggestion(page, suggestionId).locator('.ai-action-adopt')).toBeVisible();
      const { comments } = await fetchJson(page, `/api/reviews/${mode.reviewId}/comments`);
      expect(comments).toEqual([]);
      const { suggestions } = await fetchJson(page, `/api/reviews/${mode.reviewId}/suggestions`);
      expect(suggestions.find((s) => s.id === suggestionId).status).toBe('active');
    });
  });
}
