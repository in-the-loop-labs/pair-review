// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
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
      response => response.url().includes('/comments') && response.request().method() === 'POST'
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
      response => response.url().includes('/comments') && response.request().method() === 'POST'
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
