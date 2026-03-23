// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: File-Level Comments (Edit, Delete, Persistence)
 *
 * Tests file-level comment functionality including:
 * - Editing file-level comments
 * - Deleting file-level comments
 * - Empty state restoration after deletion
 * - File comment persistence across page refresh
 *
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from './fixtures.js';
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
    const commentsResponse = await fetch(`/api/reviews/${prId}/comments`);
    const commentsData = await commentsResponse.json();
    const comments = commentsData.comments || [];

    // Delete each file-level user comment
    for (const comment of comments) {
      if (comment.source === 'user' && comment.is_file_level === 1) {
        await fetch(`/api/reviews/${prId}/comments/${comment.id}`, { method: 'DELETE' });
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
    response => response.url().includes('/comments') && response.request().method() === 'POST'
  );

  await saveBtn.click();

  const response = await responsePromise;
  const responseData = await response.json();

  // Wait for card to appear
  await page.locator(`[data-comment-id="${responseData.commentId}"]`).waitFor({ state: 'visible', timeout: 5000 });

  return responseData.commentId;
}

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
      response => response.url().includes('/comments/') && response.request().method() === 'PUT'
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
      response => response.url().includes('/comments/') && response.request().method() === 'PUT'
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
      response => response.url().includes('/comments/') && response.request().method() === 'PUT'
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

  test('should delete comment immediately when clicking delete', async ({ page }) => {
    const card = page.locator(`[data-comment-id="${commentId}"]`);

    // Set up API listener
    const deleteResponsePromise = page.waitForResponse(
      response => response.url().includes('/comments/') && response.request().method() === 'DELETE'
    );

    // Click delete - deletion happens immediately without confirmation dialog
    const deleteBtn = card.locator('.btn-delete-comment');
    await deleteBtn.click();

    // Wait for delete API
    await deleteResponsePromise;

    // Card should be removed
    await expect(card).not.toBeVisible({ timeout: 5000 });
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

    // Delete the comment - deletion happens immediately without confirmation dialog
    const deleteBtn = card.locator('.btn-delete-comment');
    await deleteBtn.click();

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
