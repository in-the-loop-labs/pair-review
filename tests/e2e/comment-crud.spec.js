// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Comment CRUD Operations
 *
 * Tests the full comment lifecycle including:
 * - Creating comments (typing text and submitting)
 * - Comments appearing inline in the diff
 * - Editing existing comments
 * - Deleting comments
 * - Multi-line drag selection for comments
 * - Comment persistence across page refresh
 *
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, openCommentFormOnLine, hoverDiffLine, expectResponse, cleanupAllComments } from './helpers.js';
import { fileWrapper, lineNumberCells, lineNumberCell, selectLineRange, lineSelection } from './diff-dom.js';

for (const mode of MODES) {
  test.describe(`Comment Creation and Submission (${mode.name})`, () => {
    test.afterEach(async ({ page }) => {
      // Clean up comments created during the test to avoid state pollution
      await cleanupAllComments(page, mode.reviewId);
    });

    test('should type text in comment textarea and submit', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Open comment form
      await openCommentFormOnLine(page, 0);

      // Type a comment
      const textarea = page.locator('.user-comment-form textarea');
      await expect(textarea).toBeVisible();
      const testComment = 'This is a test comment for e2e testing';
      await textarea.fill(testComment);

      // Verify text was entered
      await expect(textarea).toHaveValue(testComment);

      // Save button should be enabled now
      const saveBtn = page.locator('.save-comment-btn');
      await expect(saveBtn).toBeEnabled();

      // Click save
      await saveBtn.click();

      // Wait for form to close and comment to appear
      await expect(page.locator('.user-comment-form')).not.toBeVisible({ timeout: 5000 });

      // Comment should now be displayed inline
      const userComment = page.locator('.user-comment-row');
      await expect(userComment.first()).toBeVisible({ timeout: 5000 });

      // Verify comment text is displayed
      const commentBody = page.locator('.user-comment-body');
      await expect(commentBody.first()).toContainText(testComment);
    });

    test('should show comment inline in the diff after submission', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Find a specific line to comment on
      const count = await lineNumberCells(page).count();
      expect(count).toBeGreaterThan(0);

      // Open comment form on first line
      await openCommentFormOnLine(page, 0);

      // Submit a comment
      const textarea = page.locator('.user-comment-form textarea');
      const uniqueComment = `Inline comment test ${Date.now()}`;
      await textarea.fill(uniqueComment);

      await page.locator('.save-comment-btn').click();

      // Wait for the form to close
      await expect(page.locator('.user-comment-form')).not.toBeVisible({ timeout: 5000 });

      // The comment row should be inserted in the diff table
      const commentRow = page.locator('.user-comment-row');
      await expect(commentRow.first()).toBeVisible({ timeout: 5000 });

      // Verify the comment is within a diff file wrapper
      const diffWrapper = page.locator('[data-file-name]');
      const commentInDiff = diffWrapper.locator('.user-comment-row');
      await expect(commentInDiff.first()).toBeVisible();
    });

    test('should disable save button when textarea is empty', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      await openCommentFormOnLine(page, 0);

      // Save button should be disabled initially
      const saveBtn = page.locator('.save-comment-btn');
      await expect(saveBtn).toBeDisabled();

      // Type some text
      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill('Some text');
      await expect(saveBtn).toBeEnabled();

      // Clear the text
      await textarea.fill('');
      await expect(saveBtn).toBeDisabled();
    });

    test('should use keyboard shortcut Cmd/Ctrl+Enter to save comment', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      await openCommentFormOnLine(page, 0);

      // Type a comment
      const textarea = page.locator('.user-comment-form textarea');
      const testComment = 'Comment saved with keyboard shortcut';
      await textarea.fill(testComment);

      // Use keyboard shortcut to save (Cmd+Enter on Mac, Ctrl+Enter on others)
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await textarea.press(`${modifier}+Enter`);

      // Wait for form to close
      await expect(page.locator('.user-comment-form')).not.toBeVisible({ timeout: 5000 });

      // Comment should be saved
      const commentBody = page.locator('.user-comment-body');
      await expect(commentBody.first()).toContainText(testComment);
    });
  });

  test.describe(`Comment Editing (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      // Clean up any existing comments for test isolation
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);

      // Create a fresh comment for this test
      await openCommentFormOnLine(page, 0);

      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill('Original comment text');
      await page.locator('.save-comment-btn').click();

      // Wait for comment to appear
      await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });
    });

    test.afterEach(async ({ page }) => {
      // Clean up comments created during the test
      await cleanupAllComments(page, mode.reviewId);
    });

    test('should show edit button on user comments', async ({ page }) => {
      // Look for edit button in the comment
      const editBtn = page.locator('.btn-edit-comment');
      await expect(editBtn.first()).toBeVisible();
    });

    test('should enter edit mode when edit button is clicked', async ({ page }) => {
      // Click edit button
      const editBtn = page.locator('.btn-edit-comment').first();
      await editBtn.click();

      // Should show edit form (textarea for editing)
      const editTextarea = page.locator('.comment-edit-textarea, .user-comment-edit-form textarea');
      await expect(editTextarea.first()).toBeVisible({ timeout: 5000 });

      // Original text should be in the textarea
      await expect(editTextarea.first()).toHaveValue('Original comment text');
    });

    test('should save edited comment', async ({ page }) => {
      // Get the specific comment row we just created in beforeEach
      const commentRow = page.locator('.user-comment-row').first();
      const commentId = await commentRow.getAttribute('data-comment-id');

      // Click edit button on this specific comment
      await commentRow.locator('.btn-edit-comment').click();

      // Wait for edit mode - use the specific textarea ID
      const editTextarea = page.locator(`#edit-comment-${commentId}`);
      await expect(editTextarea).toBeVisible({ timeout: 5000 });

      // Clear and type new text
      await editTextarea.fill('');
      await editTextarea.fill('Edited comment text');

      // Wait for API call to complete
      const responsePromise = expectResponse(page,
        response => response.url().includes('/comments/') && response.request().method() === 'PUT'
      );

      // Save the edit
      const saveEditBtn = page.locator('.save-edit-btn');
      await saveEditBtn.click();

      // Wait for API response
      await responsePromise;

      // Wait for edit form to be removed from DOM
      await expect(page.locator('.user-comment-edit-form')).not.toBeVisible({ timeout: 5000 });

      // Get the same comment row again and check its body text
      const updatedRow = page.locator(`[data-comment-id="${commentId}"]`);
      const commentBody = updatedRow.locator('.user-comment-body');
      await expect(commentBody).toBeVisible({ timeout: 5000 });
      await expect(commentBody).toContainText('Edited comment text', { timeout: 5000 });
    });

    test('should cancel edit and restore original text', async ({ page }) => {
      // Click edit button
      await page.locator('.btn-edit-comment').first().click();

      // Wait for edit mode
      const editTextarea = page.locator('.comment-edit-textarea, .user-comment-edit-form textarea').first();
      await expect(editTextarea).toBeVisible({ timeout: 5000 });

      // Type different text
      await editTextarea.fill('This should be discarded');

      // Cancel the edit
      const cancelEditBtn = page.locator('.cancel-edit-btn');
      await cancelEditBtn.click();

      // Edit mode should close
      await expect(editTextarea).not.toBeVisible({ timeout: 5000 });

      // Comment should still show original text
      const commentBody = page.locator('.user-comment-body');
      await expect(commentBody.first()).toContainText('Original comment text');
    });

    test('should correctly edit comments containing double quotes', async ({ page }) => {
      // This test verifies the fix for the quote escaping bug where comments
      // with double quotes would get truncated when edited.
      // Note: markdown-it with typographer enabled converts " to "smart quotes" in rendered output,
      // but the raw markdown should preserve the original straight quotes.

      // Get the comment row and update it with text containing quotes
      const commentRow = page.locator('.user-comment-row').first();
      const commentId = await commentRow.getAttribute('data-comment-id');

      // Click edit button
      await commentRow.locator('.btn-edit-comment').click();

      // Wait for edit mode
      const editTextarea = page.locator(`#edit-comment-${commentId}`);
      await expect(editTextarea).toBeVisible({ timeout: 5000 });

      // Enter text with double quotes - this was the bug trigger
      const textWithQuotes = 'Check the "variable" assignment and "function" call';
      await editTextarea.fill(textWithQuotes);

      // Wait for API call to complete
      const saveResponsePromise = expectResponse(page,
        response => response.url().includes('/comments/') && response.request().method() === 'PUT'
      );

      // Save the edit
      await page.locator('.save-edit-btn').click();
      await saveResponsePromise;

      // Wait for edit form to close
      await expect(page.locator('.user-comment-edit-form')).not.toBeVisible({ timeout: 5000 });

      // Verify the comment displays - use partial match for key words since markdown-it
      // converts straight quotes to smart quotes in rendered output
      const updatedRow = page.locator(`[data-comment-id="${commentId}"]`);
      const commentBody = updatedRow.locator('.user-comment-body');
      await expect(commentBody).toContainText('variable', { timeout: 5000 });
      await expect(commentBody).toContainText('assignment', { timeout: 5000 });
      await expect(commentBody).toContainText('function', { timeout: 5000 });

      // Now edit again - this is where the bug would manifest (truncated text)
      await updatedRow.locator('.btn-edit-comment').click();

      // The textarea should contain the FULL text, not truncated
      const editTextarea2 = page.locator(`#edit-comment-${commentId}`);
      await expect(editTextarea2).toBeVisible({ timeout: 5000 });

      // This is the critical assertion - previously the text would be truncated at the first quote
      // The raw markdown should preserve straight quotes even if rendered output has smart quotes
      await expect(editTextarea2).toHaveValue(textWithQuotes);

      // Cancel to clean up
      await page.locator('.cancel-edit-btn').click();
    });

    test('should correctly edit comments containing single quotes', async ({ page }) => {
      // Test single quotes as well to ensure full coverage
      const commentRow = page.locator('.user-comment-row').first();
      const commentId = await commentRow.getAttribute('data-comment-id');

      // Click edit button
      await commentRow.locator('.btn-edit-comment').click();

      const editTextarea = page.locator(`#edit-comment-${commentId}`);
      await expect(editTextarea).toBeVisible({ timeout: 5000 });

      // Enter text with single quotes
      const textWithQuotes = "It's important to check the value's type";
      await editTextarea.fill(textWithQuotes);

      const saveResponsePromise = expectResponse(page,
        response => response.url().includes('/comments/') && response.request().method() === 'PUT'
      );

      await page.locator('.save-edit-btn').click();
      await saveResponsePromise;

      await expect(page.locator('.user-comment-edit-form')).not.toBeVisible({ timeout: 5000 });

      // Edit again and verify full text is preserved
      const updatedRow = page.locator(`[data-comment-id="${commentId}"]`);
      await updatedRow.locator('.btn-edit-comment').click();

      const editTextarea2 = page.locator(`#edit-comment-${commentId}`);
      await expect(editTextarea2).toBeVisible({ timeout: 5000 });
      await expect(editTextarea2).toHaveValue(textWithQuotes);

      await page.locator('.cancel-edit-btn').click();
    });
  });

  test.describe(`Comment Deletion (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      // Clean up any existing comments for test isolation
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);

      // Create a fresh comment for this test
      await openCommentFormOnLine(page, 0);

      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill('Comment to be deleted');
      await page.locator('.save-comment-btn').click();

      // Wait for comment to appear
      await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });
    });

    test.afterEach(async ({ page }) => {
      // Clean up comments created during the test
      await cleanupAllComments(page, mode.reviewId);
    });

    test('should show delete button on user comments', async ({ page }) => {
      const deleteBtn = page.locator('.btn-delete-comment');
      await expect(deleteBtn.first()).toBeVisible();
    });

    test('should immediately dismiss (soft-delete) comment when delete is clicked', async ({ page }) => {
      // Get the comment id from the row's data attribute
      const commentRow = page.locator('.user-comment-row').first();
      await expect(commentRow).toBeVisible();
      const commentId = await commentRow.getAttribute('data-comment-id');

      // Set up API listener before deletion
      const deleteResponsePromise = expectResponse(page,
        response => response.url().includes('/comments/') && response.request().method() === 'DELETE'
      );

      // Click delete button - should immediately dismiss (no confirmation dialog)
      await page.locator('.btn-delete-comment').first().click();

      // Wait for delete API to complete
      await deleteResponsePromise;

      // The specific comment row should be removed from DOM (soft-delete removes from view)
      const deletedRow = page.locator(`[data-comment-id="${commentId}"]`);
      await expect(deletedRow).not.toBeVisible({ timeout: 5000 });

      // Toast notification should appear
      const toast = page.locator('.toast-success, .toast');
      await expect(toast).toBeVisible({ timeout: 3000 });
    });
  });

  test.describe(`Multi-line Selection (${mode.name})`, () => {
    test('should reveal the gutter comment button on line hover', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      const count = await lineNumberCells(page).count();
      expect(count).toBeGreaterThan(2);

      await hoverDiffLine(page, 1);

      const commentBtn = page.locator('.pierre-comment-btn').first();
      await expect(commentBtn).toBeVisible({ timeout: 3000 });
    });

    test('should keep the gutter comment button available after a multi-line selection', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Select three lines of the first file with a real drag down the
      // line-number column, the way a user does.
      await selectLineRange(page, { file: 'src/main.js', start: 11, end: 13, side: 'additions' });

      await hoverDiffLine(page, 2);
      const commentBtn = page.locator('.pierre-comment-btn').first();
      await expect(commentBtn).toBeVisible({ timeout: 3000 });
    });

    test('should create a comment for a multi-line range', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Target utils.js where the first hunk has additions on lines 2-7.
      // Select new lines 3-5 with a real drag down the line-number column.
      const utilsWrapper = fileWrapper(page, 'src/utils.js');
      await expect(utilsWrapper).toBeVisible({ timeout: 5000 });
      await selectLineRange(page, { file: 'src/utils.js', start: 3, end: 5, side: 'additions' });
      expect(await lineSelection(page, 'src/utils.js')).toEqual({ start: 3, end: 5, side: 'RIGHT' });

      // Hover an additions-side line number inside the selected range so the
      // click resolves against it. New line 4 is an addition in the first hunk.
      await lineNumberCell(utilsWrapper, 4, { side: 'additions' }).first().hover();

      // Click the gutter comment button — resolveClickTarget should consume the
      // multi-line selection and produce a range target.
      const commentBtn = utilsWrapper.locator('.pierre-comment-btn').first();
      await expect(commentBtn).toBeVisible({ timeout: 3000 });
      await commentBtn.click();
      await page.waitForSelector('.user-comment-form', { timeout: 5000 });

      // The form header should show the range label
      const rangeLabel = page.locator('.line-range-indicator');
      await expect(rangeLabel).toHaveText('Lines 3-5');

      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill('Comment on line range');
      await page.locator('.save-comment-btn').click();

      await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

      // Verify the saved comment has distinct line_start and line_end via API
      const { comments } = await page.evaluate(async (reviewId) => {
        const resp = await fetch(`/api/reviews/${reviewId}/comments`);
        return resp.json();
      }, mode.reviewId);
      const rangeComment = comments.find(c => c.body === 'Comment on line range');
      expect(rangeComment).toBeTruthy();
      expect(rangeComment.line_start).not.toEqual(rangeComment.line_end);
    });
  });

  test.describe(`Comment Persistence (${mode.name})`, () => {
    test('should persist comment after page refresh', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Create a unique comment
      await openCommentFormOnLine(page, 0);
      const textarea = page.locator('.user-comment-form textarea');
      const uniqueComment = `Persistent comment ${Date.now()}`;
      await textarea.fill(uniqueComment);
      await page.locator('.save-comment-btn').click();

      // Wait for comment to appear
      await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });
      await expect(page.locator('.user-comment-body', { hasText: uniqueComment })).toBeVisible();

      // Refresh the page
      await page.reload();
      await waitForDiffToRender(page);

      // Wait for comment rows to be rendered in the DOM (comments load async after page load)
      await page.waitForSelector('.user-comment-row', { timeout: 10000 });

      // Comment should still be visible after refresh
      await expect(page.locator('.user-comment-body', { hasText: uniqueComment })).toBeVisible({ timeout: 10000 });
    });

    test('should load existing comments on page load', async ({ page }) => {
      // First visit - create a comment
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      await openCommentFormOnLine(page, 0);
      const textarea = page.locator('.user-comment-form textarea');
      const persistentComment = `Comment created at ${Date.now()}`;
      await textarea.fill(persistentComment);
      await page.locator('.save-comment-btn').click();

      // Wait for THIS comment to be saved. Waiting for "a comment row" passes on
      // any row already on the page, and the navigation below then aborts the
      // save while it is in flight.
      await expect(page.locator('.user-comment-body', { hasText: persistentComment })).toBeVisible({ timeout: 5000 });

      // Navigate away and come back
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      // Go back to the PR page
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Wait for comment rows to be rendered in the DOM (comments load async after page load)
      await page.waitForSelector('.user-comment-row', { timeout: 10000 });

      // The comment should be loaded from the database
      await expect(page.locator('.user-comment-body', { hasText: persistentComment })).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe(`Comment API Integration (${mode.name})`, () => {
    test('should call user-comment API when saving', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Set up API response listener
      const responsePromise = expectResponse(page,
        response => response.url().includes('/comments') && response.request().method() === 'POST'
      );

      // Create and save a comment
      await openCommentFormOnLine(page, 0);
      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill('API test comment');
      await page.locator('.save-comment-btn').click();

      // Verify API was called
      const response = await responsePromise;
      expect(response.status()).toBe(200);

      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.commentId).toBeDefined();
    });

    test('should call delete API when deleting comment', async ({ page }) => {
      // Create a comment first
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await openCommentFormOnLine(page, 0);

      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill('Comment for delete API test');
      await page.locator('.save-comment-btn').click();
      await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

      // Set up delete API listener
      const deleteResponsePromise = expectResponse(page,
        response => response.url().includes('/comments/') && response.request().method() === 'DELETE'
      );

      // Delete the comment (now immediate, no confirmation dialog)
      await page.locator('.btn-delete-comment').first().click();

      // Verify delete API was called
      const response = await deleteResponsePromise;
      expect(response.status()).toBe(200);
    });

    test('should call update API when editing comment', async ({ page }) => {
      // Create a comment first
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await openCommentFormOnLine(page, 0);

      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill('Comment for edit API test');
      await page.locator('.save-comment-btn').click();
      await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

      // Set up update API listener
      const updateResponsePromise = expectResponse(page,
        response => response.url().includes('/comments/') && response.request().method() === 'PUT'
      );

      // Edit the comment
      await page.locator('.btn-edit-comment').first().click();
      const editTextarea = page.locator('.comment-edit-textarea, .user-comment-edit-form textarea').first();
      await expect(editTextarea).toBeVisible({ timeout: 5000 });
      await editTextarea.fill('Updated comment text');
      await page.locator('.save-edit-btn').click();

      // Verify update API was called
      const response = await updateResponsePromise;
      expect(response.status()).toBe(200);
    });
  });
}
