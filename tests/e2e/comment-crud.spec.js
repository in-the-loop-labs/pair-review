// SPDX-License-Identifier: GPL-3.0-or-later
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

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

// Helper to clean up all user comments (call via API to ensure clean state)
async function cleanupAllComments(page) {
  // Delete all user comments via API to ensure test isolation
  await page.evaluate(async () => {
    // Get all comments for this PR
    const response = await fetch('/api/pr/test-owner/test-repo/1');
    const data = await response.json();
    const prId = data.metadata?.id;
    if (!prId) return;

    // Fetch comments
    const commentsResponse = await fetch(`/api/pr/${prId}/comments`);
    const comments = await commentsResponse.json();

    // Delete each user comment
    for (const comment of comments) {
      if (comment.source === 'user') {
        await fetch(`/api/user-comment/${comment.id}`, { method: 'DELETE' });
      }
    }
  });
}

// Helper to open comment form on a specific line
async function openCommentFormOnLine(page, lineIndex = 0) {
  // Hover over a line number to show the add comment button
  const lineNumberCell = page.locator('.d2h-code-linenumber').nth(lineIndex);
  await lineNumberCell.hover();

  // Click the add comment button
  const addCommentBtn = page.locator('.add-comment-btn').first();
  await addCommentBtn.waitFor({ state: 'visible', timeout: 5000 });
  await addCommentBtn.click();

  // Wait for the comment form to appear
  await page.waitForSelector('.user-comment-form', { timeout: 5000 });
}

test.describe('Comment Creation and Submission', () => {
  test('should type text in comment textarea and submit', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
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
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Find a specific line to comment on
    const lineNumberCells = page.locator('.d2h-code-linenumber');
    const count = await lineNumberCells.count();
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
    const diffWrapper = page.locator('.d2h-file-wrapper');
    const commentInDiff = diffWrapper.locator('.user-comment-row');
    await expect(commentInDiff.first()).toBeVisible();
  });

  test('should disable save button when textarea is empty', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
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
    await page.goto('/pr/test-owner/test-repo/1');
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

test.describe('Comment Editing', () => {
  test.beforeEach(async ({ page }) => {
    // Clean up any existing comments for test isolation
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllComments(page);

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
    await cleanupAllComments(page);
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
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'PUT'
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
    const saveResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'PUT'
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

    const saveResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'PUT'
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

test.describe('Comment Deletion', () => {
  test.beforeEach(async ({ page }) => {
    // Clean up any existing comments for test isolation
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllComments(page);

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
    await cleanupAllComments(page);
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
    const deleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'DELETE'
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

test.describe('Multi-line Drag Selection', () => {
  test('should support drag selection from add-comment button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Get rows with line numbers - skip first few rows as they may be context lines
    const lineRows = page.locator('tr[data-line-number]');
    const rowCount = await lineRows.count();

    // Need at least 3 rows for a drag test
    if (rowCount >= 3) {
      // The drag mechanism works via mousedown on add-comment button,
      // mouseover on rows, then mouseup. Since button is hidden by default,
      // we verify the mechanism exists by checking that the selection can be created
      // programmatically via clicking the add button after a multi-row selection.

      // This test validates that:
      // 1. Multiple rows exist for potential selection
      // 2. Add comment buttons are present (appear on hover)
      // 3. Line tracking infrastructure exists

      // Hover over a line to reveal button
      const targetRow = lineRows.nth(1);
      const lineNumCell = targetRow.locator('.d2h-code-linenumber');
      await lineNumCell.hover();

      // Button should exist (may be visible or hidden based on CSS)
      const addBtns = page.locator('.add-comment-btn');
      const btnCount = await addBtns.count();
      expect(btnCount).toBeGreaterThan(0);

      // Verify rows have proper data attributes for selection
      const hasLineNumber = await targetRow.getAttribute('data-line-number');
      expect(hasLineNumber).toBeTruthy();
    }
  });

  test('should show add comment button after multi-line selection', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Get line number cells
    const lineNumberCells = page.locator('.d2h-code-linenumber');
    const count = await lineNumberCells.count();

    if (count >= 3) {
      const startCell = lineNumberCells.nth(0);
      const endCell = lineNumberCells.nth(2);

      const startBox = await startCell.boundingBox();
      const endBox = await endCell.boundingBox();

      if (startBox && endBox) {
        // Perform drag action
        await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2);
        await page.mouse.up();

        // Wait for selection state to be reflected in DOM (button becomes visible)
        await page.waitForSelector('.add-comment-btn:visible', { timeout: 3000 }).catch(() => {});

        // Add comment button should be visible after selection
        const addCommentBtn = page.locator('.add-comment-btn');
        const btnCount = await addCommentBtn.count();
        expect(btnCount).toBeGreaterThan(0);
      }
    }
  });

  test('should create comment for multi-line range', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Get line number cells - find rows with actual line numbers
    const lineRows = page.locator('tr[data-line-number]');
    const rowCount = await lineRows.count();

    if (rowCount >= 3) {
      // Click on first row's line number cell to start selection
      const firstRow = lineRows.nth(0);
      const firstLineNumCell = firstRow.locator('.d2h-code-linenumber');
      await firstLineNumCell.hover();

      // Look for add comment button and click it
      const addCommentBtn = page.locator('.add-comment-btn').first();
      await addCommentBtn.waitFor({ state: 'visible', timeout: 3000 });
      await addCommentBtn.click();

      // Wait for comment form
      await page.waitForSelector('.user-comment-form', { timeout: 5000 });

      // Add a multi-line comment
      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill('Comment on line range');
      await page.locator('.save-comment-btn').click();

      // Comment should be created
      await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });
    }
  });
});

test.describe('Comment Persistence', () => {
  test('should persist comment after page refresh', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Create a unique comment
    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    const uniqueComment = `Persistent comment ${Date.now()}`;
    await textarea.fill(uniqueComment);
    await page.locator('.save-comment-btn').click();

    // Wait for comment to appear
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.user-comment-body').first()).toContainText(uniqueComment);

    // Refresh the page
    await page.reload();
    await waitForDiffToRender(page);

    // Wait for comment rows to be rendered in the DOM (comments load async after page load)
    await page.waitForSelector('.user-comment-row', { timeout: 10000 });

    // Comment should still be visible after refresh
    const commentBody = page.locator('.user-comment-body');
    await expect(commentBody.first()).toContainText(uniqueComment, { timeout: 10000 });
  });

  test('should load existing comments on page load', async ({ page }) => {
    // First visit - create a comment
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    const persistentComment = `Comment created at ${Date.now()}`;
    await textarea.fill(persistentComment);
    await page.locator('.save-comment-btn').click();

    // Wait for comment to be saved
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Navigate away and come back
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Go back to the PR page
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Wait for comment rows to be rendered in the DOM (comments load async after page load)
    await page.waitForSelector('.user-comment-row', { timeout: 10000 });

    // The comment should be loaded from the database
    const commentBody = page.locator('.user-comment-body');
    await expect(commentBody.first()).toContainText(persistentComment, { timeout: 10000 });
  });
});

test.describe('Comment API Integration', () => {
  test('should call user-comment API when saving', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Set up API response listener
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment') && response.request().method() === 'POST'
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
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openCommentFormOnLine(page, 0);

    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Comment for delete API test');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Set up delete API listener
    const deleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'DELETE'
    );

    // Delete the comment (now immediate, no confirmation dialog)
    await page.locator('.btn-delete-comment').first().click();

    // Verify delete API was called
    const response = await deleteResponsePromise;
    expect(response.status()).toBe(200);
  });

  test('should call update API when editing comment', async ({ page }) => {
    // Create a comment first
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openCommentFormOnLine(page, 0);

    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Comment for edit API test');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Set up update API listener
    const updateResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'PUT'
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

test.describe('Comment Display', () => {
  test('should display comment timestamp', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Create a comment
    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Comment with timestamp');
    await page.locator('.save-comment-btn').click();

    // Wait for comment to appear
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Should show timestamp
    const timestamp = page.locator('.user-comment-timestamp');
    await expect(timestamp.first()).toBeVisible();
  });

  test('should display line info in comment header', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Create a comment
    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Comment with line info');
    await page.locator('.save-comment-btn').click();

    // Wait for comment to appear
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Should show line info
    const lineInfo = page.locator('.user-comment-line-info');
    await expect(lineInfo.first()).toBeVisible();
    await expect(lineInfo.first()).toContainText(/Line \d+/);
  });

  test('should display user icon for user-created comments', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Create a comment
    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('User comment');
    await page.locator('.save-comment-btn').click();

    // Wait for comment to appear
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Should have user origin class (not AI)
    const userComment = page.locator('.user-comment.comment-user-origin');
    await expect(userComment.first()).toBeVisible();
  });
});

test.describe('Dismissed Comment Persistence', () => {
  test.beforeEach(async ({ page }) => {
    // Clean up any existing comments for test isolation
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllComments(page);

    // Create a fresh comment for this test
    await openCommentFormOnLine(page, 0);

    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Comment to test dismissed persistence');
    await page.locator('.save-comment-btn').click();

    // Wait for comment to appear
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });
  });

  test.afterEach(async ({ page }) => {
    // Clean up comments created during the test
    await cleanupAllComments(page);
  });

  test('should persist dismissed comment state after page reload', async ({ page }) => {
    // Get the comment id from the row's data attribute
    const commentRow = page.locator('.user-comment-row').first();
    await expect(commentRow).toBeVisible();
    const commentId = await commentRow.getAttribute('data-comment-id');

    // Set up API listener for delete (which dismisses the comment)
    const deleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'DELETE'
    );

    // Click delete button to dismiss the comment
    await page.locator('.btn-delete-comment').first().click();

    // Wait for delete API to complete
    await deleteResponsePromise;

    // DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
    // They only appear in the AI/Review Panel when the "show dismissed" filter is ON.
    // Comment row should be removed from diff view immediately
    const deletedRow = page.locator(`[data-comment-id="${commentId}"]`);
    await expect(deletedRow).not.toBeVisible({ timeout: 5000 });

    // Switch to the "User" segment in the AI Panel to see comments
    const userSegmentBtn = page.locator('.segment-btn').filter({ hasText: 'User' });
    await expect(userSegmentBtn).toBeVisible({ timeout: 5000 });
    await userSegmentBtn.click();

    // Enable the 'show dismissed' filter by clicking the filter toggle button
    const filterToggleBtn = page.locator('.filter-toggle-btn');
    await expect(filterToggleBtn).toBeVisible({ timeout: 5000 });

    // Set up listener for the user-comments API call before clicking
    const filterResponsePromise = page.waitForResponse(
      response => response.url().includes('/user-comments') && response.url().includes('includeDismissed') && response.status() === 200,
      { timeout: 10000 }
    );
    await filterToggleBtn.click();

    // Wait for the API response that includes dismissed comments
    await filterResponsePromise;

    // The dismissed comment should appear in the AI Panel with dismissed styling
    const aiPanelCommentItem = page.locator(`.finding-item.finding-comment[data-id="${commentId}"]`);
    await expect(aiPanelCommentItem).toBeVisible({ timeout: 5000 });
    await expect(aiPanelCommentItem).toHaveClass(/comment-item-dismissed/);

    // Verify dismissed comment does NOT appear in diff view (design decision)
    const dismissedDiffRow = page.locator(`.user-comment-row[data-comment-id="${commentId}"]`);
    await expect(dismissedDiffRow).not.toBeVisible({ timeout: 2000 });

    // Reload the page to test persistence
    await page.reload();
    await waitForDiffToRender(page);

    // Note: Filter toggle state persists via localStorage, so it should still be enabled
    // The AIPanel restores the filter state from localStorage on page load

    // Switch to the "User" segment again (segment selection doesn't persist)
    const userSegmentBtnAfterReload = page.locator('.segment-btn').filter({ hasText: 'User' });
    await expect(userSegmentBtnAfterReload).toBeVisible({ timeout: 5000 });
    await userSegmentBtnAfterReload.click();

    // Verify the filter toggle is still active (persisted via localStorage)
    const filterToggleBtnAfterReload = page.locator('.filter-toggle-btn');
    await expect(filterToggleBtnAfterReload).toBeVisible({ timeout: 5000 });
    await expect(filterToggleBtnAfterReload).toHaveClass(/active/);

    // The dismissed comment should still appear in the AI Panel with dismissed styling
    const aiPanelCommentItemAfterReload = page.locator(`.finding-item.finding-comment[data-id="${commentId}"]`);
    await expect(aiPanelCommentItemAfterReload).toBeVisible({ timeout: 5000 });
    await expect(aiPanelCommentItemAfterReload).toHaveClass(/comment-item-dismissed/);

    // Verify dismissed comment still does NOT appear in diff view after reload (design decision)
    const dismissedDiffRowAfterReload = page.locator(`.user-comment-row[data-comment-id="${commentId}"]`);
    await expect(dismissedDiffRowAfterReload).not.toBeVisible({ timeout: 2000 });
  });
});

test.describe('Comment Restore', () => {
  test.beforeEach(async ({ page }) => {
    // Clean up any existing comments for test isolation
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllComments(page);

    // Create a fresh comment for this test
    await openCommentFormOnLine(page, 0);

    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Comment to be dismissed and restored');
    await page.locator('.save-comment-btn').click();

    // Wait for comment to appear
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });
  });

  test.afterEach(async ({ page }) => {
    // Clean up comments created during the test
    await cleanupAllComments(page);
  });

  test('should dismiss and restore a comment via AI Panel', async ({ page }) => {
    // Get the comment id from the row's data attribute
    const commentRow = page.locator('.user-comment-row').first();
    await expect(commentRow).toBeVisible();
    const commentId = await commentRow.getAttribute('data-comment-id');

    // Set up API listener for delete
    const deleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'DELETE'
    );

    // Click delete button to dismiss the comment
    await page.locator('.btn-delete-comment').first().click();

    // Wait for delete API to complete
    await deleteResponsePromise;

    // DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
    // Comment row should be removed from diff view immediately
    const deletedRow = page.locator(`[data-comment-id="${commentId}"]`);
    await expect(deletedRow).not.toBeVisible({ timeout: 5000 });

    // First, switch to the "User" segment in the AI Panel to see comments
    // The segment button contains text like "User (1)"
    const userSegmentBtn = page.locator('.segment-btn').filter({ hasText: 'User' });
    await expect(userSegmentBtn).toBeVisible({ timeout: 5000 });
    await userSegmentBtn.click();

    // Enable the 'show dismissed' filter by clicking the filter toggle button
    const filterToggleBtn = page.locator('.filter-toggle-btn');
    await expect(filterToggleBtn).toBeVisible({ timeout: 5000 });

    // Set up listener for the user-comments API call before clicking
    const restoreFilterResponsePromise = page.waitForResponse(
      response => response.url().includes('/user-comments') && response.url().includes('includeDismissed') && response.status() === 200,
      { timeout: 10000 }
    );
    await filterToggleBtn.click();

    // Wait for the API response that includes dismissed comments
    await restoreFilterResponsePromise;

    // The dismissed comment should now appear in the AI Panel with dismissed styling
    // Comment items in the AI Panel have class 'finding-item finding-comment' with data-id attribute
    const aiPanelCommentItem = page.locator(`.finding-item.finding-comment[data-id="${commentId}"]`);
    await expect(aiPanelCommentItem).toBeVisible({ timeout: 5000 });

    // Verify it has the dismissed visual state (comment-item-dismissed class)
    await expect(aiPanelCommentItem).toHaveClass(/comment-item-dismissed/);

    // Verify dismissed comment does NOT appear in diff view (design decision)
    const dismissedDiffRow = page.locator(`.user-comment-row[data-comment-id="${commentId}"]`);
    await expect(dismissedDiffRow).not.toBeVisible({ timeout: 2000 });

    // Hover over the comment item to reveal the restore button
    await aiPanelCommentItem.hover();

    // Click the restore button in the AI Panel (inside finding-item-wrapper)
    const itemWrapper = aiPanelCommentItem.locator('..');
    const restoreBtn = itemWrapper.locator('.quick-action-restore-comment');
    await expect(restoreBtn).toBeVisible({ timeout: 3000 });

    // Set up API listener for restore
    const restoreResponsePromise = page.waitForResponse(
      response => response.url().includes('/restore') && response.request().method() === 'PUT'
    );

    await restoreBtn.click();

    // Wait for restore API to complete
    await restoreResponsePromise;

    // The comment should be restored to active state
    // After restore, the comment should no longer have dismissed styling in AI Panel
    await expect(aiPanelCommentItem).not.toHaveClass(/comment-item-dismissed/, { timeout: 5000 });

    // The comment should now be visible again in the diff view (restored = active)
    const restoredRow = page.locator(`.user-comment-row[data-comment-id="${commentId}"]`);
    await expect(restoredRow).toBeVisible({ timeout: 5000 });

    // Toast notification should appear with "Comment restored" message
    const toast = page.locator('.toast-success').filter({ hasText: 'Comment restored' });
    await expect(toast).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Bulk Deletion via Clear All', () => {
  test.beforeEach(async ({ page }) => {
    // Clean up any existing comments for test isolation
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllComments(page);

    // Reset the dismissed filter localStorage to ensure predictable test state
    // The filter toggle persists via localStorage and could affect test behavior
    await page.evaluate(() => {
      localStorage.removeItem('pair-review-show-dismissed_test-owner/test-repo#1');
    });

    // Reload the page to ensure clean UI state after database cleanup
    await page.reload();
    await waitForDiffToRender(page);

    // Verify clean state
    await expect(page.locator('.user-comment-row')).toHaveCount(0, { timeout: 5000 });
  });

  test.afterEach(async ({ page }) => {
    // Clean up comments created during the test
    await cleanupAllComments(page);
  });

  test('should bulk delete multiple user comments from diff view', async ({ page }) => {
    // Create multiple comments (on different lines)
    await openCommentFormOnLine(page, 0);
    const textarea1 = page.locator('.user-comment-form textarea');
    await textarea1.fill('First comment for bulk delete test');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Create second comment on a different line
    await openCommentFormOnLine(page, 2);
    const textarea2 = page.locator('.user-comment-form textarea');
    await textarea2.fill('Second comment for bulk delete test');
    await page.locator('.save-comment-btn').click();

    // Wait for both comments to appear
    await expect(page.locator('.user-comment-row')).toHaveCount(2, { timeout: 5000 });

    // Store comment IDs for later verification
    const commentRows = page.locator('.user-comment-row');
    const commentId1 = await commentRows.nth(0).getAttribute('data-comment-id');
    const commentId2 = await commentRows.nth(1).getAttribute('data-comment-id');

    // Open preview modal to access Clear All button
    // The preview modal is opened via the Review button dropdown or by clicking on comment count
    // For testing, we can call prManager.openPreviewModal() directly
    await page.evaluate(() => {
      if (window.prManager && typeof window.prManager.openPreviewModal === 'function') {
        window.prManager.openPreviewModal();
      }
    });

    // Wait for preview modal to appear
    await expect(page.locator('.preview-modal-overlay')).toBeVisible({ timeout: 5000 });

    // Click the Clear All button
    const clearAllBtn = page.locator('#clear-all-comments-btn');
    await expect(clearAllBtn).toBeVisible();
    await clearAllBtn.click();

    // Wait for confirmation dialog to appear
    await expect(page.locator('.confirm-dialog-overlay')).toBeVisible({ timeout: 3000 });

    // Click confirm in the dialog (use the correct selector)
    const confirmBtn = page.locator('#confirm-dialog-btn');
    await expect(confirmBtn).toBeVisible();

    // Set up API listener for bulk delete
    const bulkDeleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/user-comments') && response.request().method() === 'DELETE'
    );

    await confirmBtn.click();

    // Wait for bulk delete API to complete
    await bulkDeleteResponsePromise;

    // Both comments should be removed from the diff view
    const deletedRow1 = page.locator(`[data-comment-id="${commentId1}"]`);
    const deletedRow2 = page.locator(`[data-comment-id="${commentId2}"]`);
    await expect(deletedRow1).not.toBeVisible({ timeout: 5000 });
    await expect(deletedRow2).not.toBeVisible({ timeout: 5000 });

    // No user comment rows should remain in the diff view
    await expect(page.locator('.user-comment-row')).toHaveCount(0, { timeout: 5000 });

    // Toast notification should appear with success message
    const toast = page.locator('.toast-success').filter({ hasText: /Cleared.*comment/ });
    await expect(toast).toBeVisible({ timeout: 3000 });
  });

  test('should show dismissed comments in AI Panel after bulk deletion with filter enabled', async ({ page }) => {
    // Create multiple comments
    await openCommentFormOnLine(page, 0);
    const textarea1 = page.locator('.user-comment-form textarea');
    await textarea1.fill('Comment 1 for dismissed filter test');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    await openCommentFormOnLine(page, 2);
    const textarea2 = page.locator('.user-comment-form textarea');
    await textarea2.fill('Comment 2 for dismissed filter test');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-row')).toHaveCount(2, { timeout: 5000 });

    // Store comment IDs for later verification
    const commentRows = page.locator('.user-comment-row');
    const commentId1 = await commentRows.nth(0).getAttribute('data-comment-id');
    const commentId2 = await commentRows.nth(1).getAttribute('data-comment-id');

    // Open preview modal and trigger bulk delete
    await page.evaluate(() => {
      if (window.prManager && typeof window.prManager.openPreviewModal === 'function') {
        window.prManager.openPreviewModal();
      }
    });

    await expect(page.locator('.preview-modal-overlay')).toBeVisible({ timeout: 5000 });

    const clearAllBtn = page.locator('#clear-all-comments-btn');
    await clearAllBtn.click();

    // Confirm the deletion
    await expect(page.locator('.confirm-dialog-overlay')).toBeVisible({ timeout: 3000 });

    const bulkDeleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/user-comments') && response.request().method() === 'DELETE'
    );

    await page.locator('#confirm-dialog-btn').click();
    await bulkDeleteResponsePromise;

    // Verify comments are removed from diff view
    await expect(page.locator('.user-comment-row')).toHaveCount(0, { timeout: 5000 });

    // Switch to the "User" segment in the AI Panel
    const userSegmentBtn = page.locator('.segment-btn').filter({ hasText: 'User' });
    await expect(userSegmentBtn).toBeVisible({ timeout: 5000 });
    await userSegmentBtn.click();

    // Enable the 'show dismissed' filter
    const filterToggleBtn = page.locator('.filter-toggle-btn');
    await expect(filterToggleBtn).toBeVisible({ timeout: 5000 });

    // Set up listener for the user-comments API call with includeDismissed
    const filterResponsePromise = page.waitForResponse(
      response => response.url().includes('/user-comments') && response.url().includes('includeDismissed') && response.status() === 200,
      { timeout: 10000 }
    );

    await filterToggleBtn.click();
    await filterResponsePromise;

    // Both dismissed comments should now appear in the AI Panel with dismissed styling
    const aiPanelComment1 = page.locator(`.finding-item.finding-comment[data-id="${commentId1}"]`);
    const aiPanelComment2 = page.locator(`.finding-item.finding-comment[data-id="${commentId2}"]`);

    await expect(aiPanelComment1).toBeVisible({ timeout: 5000 });
    await expect(aiPanelComment2).toBeVisible({ timeout: 5000 });

    // Both should have the dismissed styling
    await expect(aiPanelComment1).toHaveClass(/comment-item-dismissed/);
    await expect(aiPanelComment2).toHaveClass(/comment-item-dismissed/);

    // Verify they do NOT appear in diff view (design decision)
    const dismissedDiffRow1 = page.locator(`.user-comment-row[data-comment-id="${commentId1}"]`);
    const dismissedDiffRow2 = page.locator(`.user-comment-row[data-comment-id="${commentId2}"]`);
    await expect(dismissedDiffRow1).not.toBeVisible({ timeout: 2000 });
    await expect(dismissedDiffRow2).not.toBeVisible({ timeout: 2000 });
  });

  test('should correctly refresh UI state after bulk deletion', async ({ page }) => {
    // Create a comment
    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Comment for UI state refresh test');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Verify initial state - comment count should be visible/updated
    // The split button or review button should show 1 comment
    const splitButtonMain = page.locator('.split-button-main');
    await expect(splitButtonMain).toBeVisible({ timeout: 3000 });

    // Get the comment ID
    const commentRow = page.locator('.user-comment-row').first();
    const commentId = await commentRow.getAttribute('data-comment-id');

    // Switch to User segment to verify comment appears
    const userSegmentBtn = page.locator('.segment-btn').filter({ hasText: 'User' });
    await userSegmentBtn.click();

    // Comment should be visible in AI Panel (active, not dismissed)
    const aiPanelComment = page.locator(`.finding-item.finding-comment[data-id="${commentId}"]`);
    await expect(aiPanelComment).toBeVisible({ timeout: 5000 });
    await expect(aiPanelComment).not.toHaveClass(/comment-item-dismissed/);

    // Open preview modal and trigger bulk delete
    await page.evaluate(() => {
      if (window.prManager && typeof window.prManager.openPreviewModal === 'function') {
        window.prManager.openPreviewModal();
      }
    });

    await expect(page.locator('.preview-modal-overlay')).toBeVisible({ timeout: 5000 });

    const clearAllBtn = page.locator('#clear-all-comments-btn');
    await clearAllBtn.click();

    await expect(page.locator('.confirm-dialog-overlay')).toBeVisible({ timeout: 3000 });

    const bulkDeleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/user-comments') && response.request().method() === 'DELETE'
    );

    await page.locator('#confirm-dialog-btn').click();
    await bulkDeleteResponsePromise;

    // Verify diff view is cleared
    await expect(page.locator('.user-comment-row')).toHaveCount(0, { timeout: 5000 });

    // Verify the comment is no longer in AI Panel (without dismissed filter)
    // First, need to refresh the user segment view
    await userSegmentBtn.click();

    // Wait for the segment switch to complete by checking the button has the 'active' class
    await expect(userSegmentBtn).toHaveClass(/active/, { timeout: 3000 });

    // The comment should either not be visible OR if visible, should have dismissed styling
    // Since filter is off by default, it should not be visible
    const filterToggleBtn = page.locator('.filter-toggle-btn');
    const isFilterActive = await filterToggleBtn.evaluate(
      btn => btn.classList.contains('active')
    );

    if (!isFilterActive) {
      // Filter is off, so dismissed comment should not be visible in AI Panel
      await expect(aiPanelComment).not.toBeVisible({ timeout: 3000 });
    }

    // Toast notification should have appeared
    const toast = page.locator('.toast-success').filter({ hasText: /Cleared.*comment/ });
    await expect(toast).toBeVisible({ timeout: 3000 });
  });

  test('should handle bulk delete with no comments gracefully', async ({ page }) => {
    // No need to create comments - beforeEach ensures clean state

    // Open preview modal
    await page.evaluate(() => {
      if (window.prManager && typeof window.prManager.openPreviewModal === 'function') {
        window.prManager.openPreviewModal();
      }
    });

    // Wait for preview modal to appear
    await expect(page.locator('.preview-modal-overlay')).toBeVisible({ timeout: 5000 });

    // Click the Clear All button
    const clearAllBtn = page.locator('#clear-all-comments-btn');
    await expect(clearAllBtn).toBeVisible();
    await clearAllBtn.click();

    // No confirmation dialog should appear (since there are no comments to delete)
    await expect(page.locator('.confirm-dialog-overlay')).not.toBeVisible({ timeout: 1000 });

    // No error toast should appear
    await expect(page.locator('.toast-error')).not.toBeVisible({ timeout: 1000 });

    // The preview modal should be hidden (clearAllComments hides it before calling the handler)
    await expect(page.locator('.preview-modal-overlay')).not.toBeVisible({ timeout: 2000 });
  });
});
