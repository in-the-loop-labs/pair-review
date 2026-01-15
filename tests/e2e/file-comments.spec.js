// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: File-Level Comments
 *
 * Tests file-level comment functionality including:
 * - File comment button visibility in file headers
 * - Minimal empty state (no visible text, border, or background when empty)
 * - Opening the file comment form
 * - Creating file-level comments
 * - Editing file-level comments
 * - Deleting file-level comments
 * - Empty state restoration after deletion
 *
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

// Helper to clean up all file comments for test isolation
async function cleanupAllFileComments(page) {
  await page.evaluate(async () => {
    // Get PR data
    const response = await fetch('/api/pr/test-owner/test-repo/1');
    const data = await response.json();
    const prId = data.metadata?.id;
    if (!prId) return;

    // Fetch comments
    const commentsResponse = await fetch(`/api/pr/${prId}/comments`);
    const comments = await commentsResponse.json();

    // Delete each file-level user comment
    for (const comment of comments) {
      if (comment.source === 'user' && comment.is_file_level === 1) {
        await fetch(`/api/user-comment/${comment.id}`, { method: 'DELETE' });
      }
    }
  });
}

// Helper to get the first file comments zone
async function getFirstFileCommentsZone(page) {
  return page.locator('.file-comments-zone').first();
}

// Helper to get the file comment button from a file header
async function getFileCommentButton(page) {
  return page.locator('.file-header-comment-btn').first();
}

// Helper to create a file comment and return its ID
async function createFileComment(page, text) {
  const fileCommentBtn = await getFileCommentButton(page);
  await fileCommentBtn.click();

  const form = page.locator('.file-comment-form').first();
  await expect(form).toBeVisible({ timeout: 5000 });

  const textarea = form.locator('.file-comment-textarea');
  await textarea.fill(text);
  const saveBtn = form.locator('.submit-btn');

  // Wait for API response to get comment ID
  const responsePromise = page.waitForResponse(
    response => response.url().includes('/api/file-comment') && response.request().method() === 'POST'
  );

  await saveBtn.click();

  const response = await responsePromise;
  const responseData = await response.json();

  // Wait for card to appear
  await page.locator(`[data-comment-id="${responseData.commentId}"]`).waitFor({ state: 'visible', timeout: 5000 });

  return responseData.commentId;
}

test.describe('File Comment Button Visibility', () => {
  test('should have file comment button in file headers', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // File comment button should exist in file headers
    const fileCommentBtn = page.locator('.file-header-comment-btn');
    const count = await fileCommentBtn.count();
    expect(count).toBeGreaterThan(0);

    // Button should be visible
    await expect(fileCommentBtn.first()).toBeVisible();
  });

  test('should have correct button attributes', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Button should have a title attribute
    const fileCommentBtn = page.locator('.file-header-comment-btn').first();
    await expect(fileCommentBtn).toBeVisible();

    const title = await fileCommentBtn.getAttribute('title');
    expect(title).toBeTruthy();
  });
});

test.describe('File Comments Zone Empty State', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllFileComments(page);
    // Reload the page to ensure clean state
    await page.reload();
    await waitForDiffToRender(page);
  });

  test('should have file comments zone element', async ({ page }) => {
    // Zone element should exist
    const zone = await getFirstFileCommentsZone(page);
    await expect(zone).toBeAttached();
  });

  test('should have minimal styling when empty (no visible border/background)', async ({ page }) => {
    const zone = await getFirstFileCommentsZone(page);

    // Zone should exist
    await expect(zone).toBeAttached();

    // Zone should not have any file comment cards when empty
    const cards = zone.locator('.file-comment-card');
    await expect(cards).toHaveCount(0);

    // Zone should not have any visible "No comments" text
    const zoneText = await zone.textContent();
    expect(zoneText).not.toContain('No file-level comments');
    expect(zoneText).not.toContain('No comments');
  });

  test('should not display file comment form by default', async ({ page }) => {
    const zone = await getFirstFileCommentsZone(page);

    // Form should not be visible by default
    const form = zone.locator('.file-comment-form');
    await expect(form).toHaveCount(0);
  });
});

test.describe('Opening File Comment Form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllFileComments(page);
    await page.reload();
    await waitForDiffToRender(page);
  });

  test('should open comment form when clicking file comment button', async ({ page }) => {
    // Click the file comment button
    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    // Form should appear
    const form = page.locator('.file-comment-form');
    await expect(form.first()).toBeVisible({ timeout: 5000 });

    // Form should have textarea
    const textarea = form.locator('.file-comment-textarea');
    await expect(textarea.first()).toBeVisible();
  });

  test('should focus textarea when form opens', async ({ page }) => {
    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    // Wait for form to appear
    const form = page.locator('.file-comment-form');
    await expect(form.first()).toBeVisible({ timeout: 5000 });

    // Textarea should be focused (allow a moment for focus)
    await page.waitForTimeout(100);
    const textarea = form.locator('.file-comment-textarea').first();
    await expect(textarea).toBeFocused();
  });

  test('should have save and cancel buttons in form', async ({ page }) => {
    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    const form = page.locator('.file-comment-form').first();
    await expect(form).toBeVisible({ timeout: 5000 });

    // Should have save and cancel buttons
    const saveBtn = form.locator('.submit-btn');
    const cancelBtn = form.locator('.cancel-btn');

    await expect(saveBtn).toBeVisible();
    await expect(cancelBtn).toBeVisible();
  });

  test('should close form when clicking cancel', async ({ page }) => {
    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    const form = page.locator('.file-comment-form').first();
    await expect(form).toBeVisible({ timeout: 5000 });

    // Click cancel
    const cancelBtn = form.locator('.cancel-btn');
    await cancelBtn.click();

    // Form should be hidden
    await expect(form).not.toBeVisible({ timeout: 5000 });
  });

  test('should close form when pressing Escape', async ({ page }) => {
    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    const form = page.locator('.file-comment-form').first();
    await expect(form).toBeVisible({ timeout: 5000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Form should be hidden
    await expect(form).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('Creating File Comments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllFileComments(page);
    await page.reload();
    await waitForDiffToRender(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupAllFileComments(page);
  });

  test('should disable save button when textarea is empty', async ({ page }) => {
    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    const form = page.locator('.file-comment-form').first();
    await expect(form).toBeVisible({ timeout: 5000 });

    // Save button should be disabled initially
    const saveBtn = form.locator('.submit-btn');
    await expect(saveBtn).toBeDisabled();
  });

  test('should enable save button when textarea has content', async ({ page }) => {
    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    const form = page.locator('.file-comment-form').first();
    await expect(form).toBeVisible({ timeout: 5000 });

    // Type in textarea
    const textarea = form.locator('.file-comment-textarea');
    await textarea.fill('Test file comment');

    // Save button should be enabled
    const saveBtn = form.locator('.submit-btn');
    await expect(saveBtn).toBeEnabled();
  });

  test('should create file comment when clicking save', async ({ page }) => {
    // Type comment
    const testComment = `File comment test ${Date.now()}`;
    const commentId = await createFileComment(page, testComment);

    // Comment card should have the text
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const cardBody = card.locator('.user-comment-body');
    await expect(cardBody).toContainText(testComment);
  });

  test('should create file comment using Ctrl+Enter', async ({ page }) => {
    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    const form = page.locator('.file-comment-form').first();
    await expect(form).toBeVisible({ timeout: 5000 });

    // Type comment
    const testComment = `Keyboard shortcut file comment ${Date.now()}`;
    const textarea = form.locator('.file-comment-textarea');
    await textarea.fill(testComment);

    // Set up API listener to get the comment ID
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/file-comment') && response.request().method() === 'POST'
    );

    // Use keyboard shortcut
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await textarea.press(`${modifier}+Enter`);

    // Wait for API response and get comment ID
    const response = await responsePromise;
    const responseData = await response.json();

    // Form should close
    await expect(form).not.toBeVisible({ timeout: 5000 });

    // Comment card should appear with the text (use specific ID)
    const card = page.locator(`[data-comment-id="${responseData.commentId}"]`);
    await expect(card.locator('.user-comment-body')).toContainText(testComment, { timeout: 5000 });
  });

  test('should show file comment badge on comment card', async ({ page }) => {
    const commentId = await createFileComment(page, 'File comment with badge');

    const card = page.locator(`[data-comment-id="${commentId}"]`);

    // Should have file comment badge
    const badge = card.locator('.file-comment-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('File comment');
  });

  test('should call API when saving file comment', async ({ page }) => {
    // Set up API response listener
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/file-comment') && response.request().method() === 'POST'
    );

    const fileCommentBtn = await getFileCommentButton(page);
    await fileCommentBtn.click();

    const form = page.locator('.file-comment-form').first();
    await expect(form).toBeVisible({ timeout: 5000 });

    // Create comment
    const textarea = form.locator('.file-comment-textarea');
    await textarea.fill('API test file comment');
    const saveBtn = form.locator('.submit-btn');
    await saveBtn.click();

    // Verify API was called
    const response = await responsePromise;
    expect(response.status()).toBe(200);

    const responseData = await response.json();
    expect(responseData.success).toBe(true);
    expect(responseData.commentId).toBeDefined();
  });
});

test.describe('Editing File Comments', () => {
  let commentId;

  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllFileComments(page);
    await page.reload();
    await waitForDiffToRender(page);

    // Create a file comment for editing tests
    commentId = await createFileComment(page, 'Original file comment');
  });

  test.afterEach(async ({ page }) => {
    await cleanupAllFileComments(page);
  });

  test('should show edit button on file comment card', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const editBtn = card.locator('.btn-edit-comment');
    await expect(editBtn).toBeVisible();
  });

  test('should show edit form when clicking edit button', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const editBtn = card.locator('.btn-edit-comment');
    await editBtn.click();

    // Edit textarea should appear within the card body
    const editTextarea = card.locator('.file-comment-textarea');
    await expect(editTextarea).toBeVisible({ timeout: 5000 });

    // Should contain original text
    await expect(editTextarea).toHaveValue('Original file comment');
  });

  test('should save edited comment', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const editBtn = card.locator('.btn-edit-comment');
    await editBtn.click();

    // Wait for edit form
    const editTextarea = card.locator('.file-comment-textarea');
    await expect(editTextarea).toBeVisible({ timeout: 5000 });

    // Set up API listener
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'PUT'
    );

    // Clear and type new text
    await editTextarea.fill('');
    await editTextarea.fill('Edited file comment');

    // Save the edit
    const saveEditBtn = card.locator('.save-edit-btn');
    await saveEditBtn.click();

    // Wait for API response
    await responsePromise;

    // Edit form should close
    await expect(editTextarea).not.toBeVisible({ timeout: 5000 });

    // Card should show updated text
    const cardBody = card.locator('.user-comment-body');
    await expect(cardBody).toContainText('Edited file comment', { timeout: 5000 });
  });

  test('should cancel edit and restore original text', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const editBtn = card.locator('.btn-edit-comment');
    await editBtn.click();

    // Wait for edit form
    const editTextarea = card.locator('.file-comment-textarea');
    await expect(editTextarea).toBeVisible({ timeout: 5000 });

    // Type different text
    await editTextarea.fill('This should be discarded');

    // Cancel the edit
    const cancelEditBtn = card.locator('.cancel-edit-btn');
    await cancelEditBtn.click();

    // Edit form should close
    await expect(editTextarea).not.toBeVisible({ timeout: 5000 });

    // Card should still show original text
    const cardBody = card.locator('.user-comment-body');
    await expect(cardBody).toContainText('Original file comment');
  });

  test('should correctly edit file comments containing double quotes', async ({ page }) => {
    // This test verifies the fix for the quote escaping bug where comments
    // with double quotes would get truncated when edited.
    // Note: markdown-it with typographer enabled converts " to "smart quotes" in rendered output,
    // but the raw markdown should preserve the original straight quotes.

    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const editBtn = card.locator('.btn-edit-comment');
    await editBtn.click();

    // Wait for edit form
    const editTextarea = card.locator('.file-comment-textarea');
    await expect(editTextarea).toBeVisible({ timeout: 5000 });

    // Enter text with double quotes - this was the bug trigger
    const textWithQuotes = 'This file has a "config" issue and "settings" problem';
    await editTextarea.fill(textWithQuotes);

    // Set up API listener
    const saveResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'PUT'
    );

    // Save the edit
    const saveEditBtn = card.locator('.save-edit-btn');
    await saveEditBtn.click();
    await saveResponsePromise;

    // Wait for edit form to close
    await expect(editTextarea).not.toBeVisible({ timeout: 5000 });

    // Verify the comment displays - use partial match for key words since markdown-it
    // converts straight quotes to smart quotes in rendered output
    const cardBody = card.locator('.user-comment-body');
    await expect(cardBody).toContainText('config', { timeout: 5000 });
    await expect(cardBody).toContainText('settings', { timeout: 5000 });

    // Now edit again - this is where the bug would manifest (truncated text)
    await editBtn.click();

    // The textarea should contain the FULL text, not truncated
    const editTextarea2 = card.locator('.file-comment-textarea');
    await expect(editTextarea2).toBeVisible({ timeout: 5000 });

    // This is the critical assertion - previously the text would be truncated at the first quote
    // The raw markdown should preserve straight quotes even if rendered output has smart quotes
    await expect(editTextarea2).toHaveValue(textWithQuotes);

    // Cancel to clean up
    const cancelEditBtn = card.locator('.cancel-edit-btn');
    await cancelEditBtn.click();
  });

  test('should correctly edit file comments containing single quotes', async ({ page }) => {
    // Test single quotes as well to ensure full coverage
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const editBtn = card.locator('.btn-edit-comment');
    await editBtn.click();

    const editTextarea = card.locator('.file-comment-textarea');
    await expect(editTextarea).toBeVisible({ timeout: 5000 });

    // Enter text with single quotes
    const textWithQuotes = "This file's structure doesn't follow the team's conventions";
    await editTextarea.fill(textWithQuotes);

    const saveResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'PUT'
    );

    const saveEditBtn = card.locator('.save-edit-btn');
    await saveEditBtn.click();
    await saveResponsePromise;

    await expect(editTextarea).not.toBeVisible({ timeout: 5000 });

    // Edit again and verify full text is preserved
    await editBtn.click();

    const editTextarea2 = card.locator('.file-comment-textarea');
    await expect(editTextarea2).toBeVisible({ timeout: 5000 });
    await expect(editTextarea2).toHaveValue(textWithQuotes);

    const cancelEditBtn = card.locator('.cancel-edit-btn');
    await cancelEditBtn.click();
  });
});

test.describe('Deleting File Comments', () => {
  let commentId;

  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllFileComments(page);
    await page.reload();
    await waitForDiffToRender(page);

    // Create a file comment for deletion tests
    commentId = await createFileComment(page, 'Comment to be deleted');
  });

  test.afterEach(async ({ page }) => {
    await cleanupAllFileComments(page);
  });

  test('should show delete button on file comment card', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const deleteBtn = card.locator('.btn-delete-comment');
    await expect(deleteBtn).toBeVisible();
  });

  test('should show confirmation dialog when clicking delete', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    const deleteBtn = card.locator('.btn-delete-comment');
    await deleteBtn.click();

    // Confirmation dialog should appear
    const confirmDialog = page.locator('.confirm-dialog, .confirm-dialog-overlay');
    await expect(confirmDialog.first()).toBeVisible({ timeout: 5000 });

    // Should have confirm and cancel buttons
    const confirmBtn = page.locator('.confirm-dialog button:has-text("Delete"), .btn-danger:has-text("Delete")');
    const cancelBtn = page.locator('.confirm-dialog button:has-text("Cancel"), .btn-secondary:has-text("Cancel")');

    await expect(confirmBtn.first()).toBeVisible();
    await expect(cancelBtn.first()).toBeVisible();
  });

  test('should delete comment when confirmed', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);

    // Set up API listener
    const deleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/user-comment/') && response.request().method() === 'DELETE'
    );

    // Click delete
    const deleteBtn = card.locator('.btn-delete-comment');
    await deleteBtn.click();

    // Wait for confirmation dialog
    await page.waitForSelector('.confirm-dialog, .confirm-dialog-overlay', { timeout: 5000 });

    // Confirm deletion
    const confirmBtn = page.locator('.confirm-dialog button:has-text("Delete"), .btn-danger:has-text("Delete")').first();
    await confirmBtn.click();

    // Wait for delete API
    await deleteResponsePromise;

    // Card should be removed
    await expect(card).not.toBeVisible({ timeout: 5000 });
  });

  test('should keep comment when deletion is cancelled', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);

    // Click delete
    const deleteBtn = card.locator('.btn-delete-comment');
    await deleteBtn.click();

    // Wait for confirmation dialog
    await page.waitForSelector('.confirm-dialog, .confirm-dialog-overlay', { timeout: 5000 });

    // Cancel deletion
    const cancelBtn = page.locator('.confirm-dialog button:has-text("Cancel"), .btn-secondary:has-text("Cancel")').first();
    await cancelBtn.click();

    // Wait for dialog to close
    await expect(page.locator('.confirm-dialog, .confirm-dialog-overlay').first()).not.toBeVisible({ timeout: 5000 });

    // Card should still be visible with original text
    await expect(card).toBeVisible();
    const cardBody = card.locator('.user-comment-body');
    await expect(cardBody).toContainText('Comment to be deleted');
  });
});

test.describe('Empty State After Deletion', () => {
  test('should return to minimal state after deleting last comment', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllFileComments(page);
    await page.reload();
    await waitForDiffToRender(page);

    // Count existing user file comments before we start
    const zone = await getFirstFileCommentsZone(page);
    const initialUserCards = zone.locator('.file-comment-card.user-comment');
    const initialCount = await initialUserCards.count();

    // Create a file comment
    const commentId = await createFileComment(page, 'Temporary comment');
    const card = page.locator(`[data-comment-id="${commentId}"]`);

    // Verify count increased by 1
    await expect(zone.locator('.file-comment-card.user-comment')).toHaveCount(initialCount + 1, { timeout: 5000 });

    // Delete the comment
    const deleteBtn = card.locator('.btn-delete-comment');
    await deleteBtn.click();

    await page.waitForSelector('.confirm-dialog, .confirm-dialog-overlay', { timeout: 5000 });
    const confirmBtn = page.locator('.confirm-dialog button:has-text("Delete"), .btn-danger:has-text("Delete")').first();
    await confirmBtn.click();

    // Wait for card to be removed
    await expect(card).not.toBeVisible({ timeout: 5000 });

    // Zone should return to the initial state (same count as before we created the comment)
    await expect(zone.locator('.file-comment-card.user-comment')).toHaveCount(initialCount, { timeout: 5000 });

    // Should not have any "no comments" placeholder text
    const zoneText = await zone.textContent();
    expect(zoneText).not.toContain('No file-level comments');
    expect(zoneText).not.toContain('No comments');
  });
});

test.describe('File Comment Persistence', () => {
  test('should persist file comment after page refresh', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllFileComments(page);
    await page.reload();
    await waitForDiffToRender(page);

    // Create a unique comment
    const uniqueComment = `Persistent file comment ${Date.now()}`;
    const commentId = await createFileComment(page, uniqueComment);

    // Verify the comment appears
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    await expect(card.locator('.user-comment-body')).toContainText(uniqueComment);

    // Refresh the page
    await page.reload();
    await waitForDiffToRender(page);

    // Wait for comments to load
    await page.waitForTimeout(1000);

    // Comment should still be visible (same ID persists)
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator('.user-comment-body')).toContainText(uniqueComment);

    // Cleanup
    await cleanupAllFileComments(page);
  });
});
