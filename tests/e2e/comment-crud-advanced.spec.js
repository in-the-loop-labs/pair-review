// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Comment Advanced Operations
 *
 * Tests advanced comment functionality including:
 * - Comment display and formatting
 * - Dismissed comment persistence
 * - Comment restore from AI Panel
 * - Bulk deletion via Clear All
 * - SplitButton dropdown Clear All
 *
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

// Helper to clean up all user comments (call via API to ensure clean state)
async function cleanupAllComments(page) {
  // Delete all user comments via API to ensure test isolation
  await page.evaluate(async () => {
    // Fetch all user comments (including dismissed ones) using the correct API
    const commentsResponse = await fetch('/api/reviews/1/comments?includeDismissed=true');
    const data = await commentsResponse.json();
    const comments = data.comments || [];

    // Delete each user comment (this performs a hard delete for inactive/dismissed comments)
    for (const comment of comments) {
      await fetch(`/api/reviews/1/comments/${comment.id}`, { method: 'DELETE' });
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


test.describe('Comment Display', () => {
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
      response => response.url().includes('/comments/') && response.request().method() === 'DELETE'
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

    // Panel starts collapsed by default; expand it so segment buttons are interactable
    await page.evaluate(() => window.aiPanel?.expand());

    // Switch to the "User" segment in the AI Panel to see comments
    const userSegmentBtn = page.locator('.segment-btn').filter({ hasText: 'User' });
    await expect(userSegmentBtn).toBeVisible({ timeout: 5000 });
    await userSegmentBtn.click();

    // Enable the 'show dismissed' filter by clicking the filter toggle button
    const filterToggleBtn = page.locator('.filter-toggle-btn');
    await expect(filterToggleBtn).toBeVisible({ timeout: 5000 });

    // Set up listener for the user-comments API call before clicking
    const filterResponsePromise = page.waitForResponse(
      response => response.url().includes('/comments') && response.url().includes('includeDismissed') && response.status() === 200,
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

    // Panel starts collapsed again after reload; expand it
    await page.evaluate(() => window.aiPanel?.expand());

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
      response => response.url().includes('/comments/') && response.request().method() === 'DELETE'
    );

    // Click delete button to dismiss the comment
    await page.locator('.btn-delete-comment').first().click();

    // Wait for delete API to complete
    await deleteResponsePromise;

    // DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
    // Comment row should be removed from diff view immediately
    const deletedRow = page.locator(`[data-comment-id="${commentId}"]`);
    await expect(deletedRow).not.toBeVisible({ timeout: 5000 });

    // Panel starts collapsed by default; expand it so segment buttons are interactable
    await page.evaluate(() => window.aiPanel?.expand());

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
      response => response.url().includes('/comments') && response.url().includes('includeDismissed') && response.status() === 200,
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
      response => response.url().includes('/comments') && response.request().method() === 'DELETE'
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
      response => response.url().includes('/comments') && response.request().method() === 'DELETE'
    );

    await page.locator('#confirm-dialog-btn').click();
    await bulkDeleteResponsePromise;

    // Verify comments are removed from diff view
    await expect(page.locator('.user-comment-row')).toHaveCount(0, { timeout: 5000 });

    // Panel starts collapsed by default; expand it so segment buttons are interactable
    await page.evaluate(() => window.aiPanel?.expand());

    // Switch to the "User" segment in the AI Panel
    const userSegmentBtn = page.locator('.segment-btn').filter({ hasText: 'User' });
    await expect(userSegmentBtn).toBeVisible({ timeout: 5000 });
    await userSegmentBtn.click();

    // Enable the 'show dismissed' filter
    const filterToggleBtn = page.locator('.filter-toggle-btn');
    await expect(filterToggleBtn).toBeVisible({ timeout: 5000 });

    // Set up listener for the user-comments API call with includeDismissed
    const filterResponsePromise = page.waitForResponse(
      response => response.url().includes('/comments') && response.url().includes('includeDismissed') && response.status() === 200,
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

    // Panel starts collapsed by default; expand it so segment buttons are interactable
    await page.evaluate(() => window.aiPanel?.expand());

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
      response => response.url().includes('/comments') && response.request().method() === 'DELETE'
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

test.describe('SplitButton Dropdown Clear All', () => {
  // This test suite specifically tests the Clear All option in the SplitButton dropdown menu.
  // Regression test for pair_review-4oyn: The Clear All button was unreliable because
  // updateDropdownMenu() replaced the DOM while the dropdown was open, orphaning event listeners.

  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await cleanupAllComments(page);
    await page.reload();
    await waitForDiffToRender(page);
    await expect(page.locator('.user-comment-row')).toHaveCount(0, { timeout: 5000 });
  });

  test.afterEach(async ({ page }) => {
    await cleanupAllComments(page);
  });

  test('should clear all comments via SplitButton dropdown Clear All option', async ({ page }) => {
    // Create a comment first
    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Test comment for SplitButton Clear All');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Open the SplitButton dropdown
    const dropdownToggle = page.locator('#split-button-dropdown-toggle');
    await expect(dropdownToggle).toBeVisible({ timeout: 3000 });
    await dropdownToggle.click();

    // Wait for dropdown to be visible
    const dropdown = page.locator('#split-button-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 2000 });

    // Click the Clear All option
    const clearAllOption = dropdown.locator('[data-action="clear"]');
    await expect(clearAllOption).toBeVisible();
    await expect(clearAllOption).toBeEnabled();
    await clearAllOption.click();

    // Wait for confirmation dialog
    await expect(page.locator('.confirm-dialog-overlay')).toBeVisible({ timeout: 3000 });

    // Confirm the deletion
    const confirmBtn = page.locator('#confirm-dialog-btn');
    await confirmBtn.click();

    // Comment should be removed
    await expect(page.locator('.user-comment-row')).toHaveCount(0, { timeout: 5000 });
  });

  test('should still work after dropdown is replaced during async operation', async ({ page }) => {
    // This is the key regression test for pair_review-4oyn
    // The bug was that updateDropdownMenu() replaced innerHTML while dropdown was open,
    // causing event listeners to be attached to orphaned DOM elements

    // Create a comment
    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Test comment for dropdown replacement test');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Open the SplitButton dropdown
    const dropdownToggle = page.locator('#split-button-dropdown-toggle');
    await dropdownToggle.click();

    const dropdown = page.locator('#split-button-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 2000 });

    // Simulate the bug condition: trigger updateCommentCount while dropdown is open
    // This calls updateDropdownMenu() which replaces all the menu items
    await page.evaluate(() => {
      if (window.prManager && window.prManager.splitButton) {
        // Force dropdown menu update (simulating what happens during async operations)
        window.prManager.splitButton.updateCommentCount(
          window.prManager.splitButton.getCommentCount()
        );
      }
    });

    // The Clear All option should still work even after the DOM was replaced
    const clearAllOption = dropdown.locator('[data-action="clear"]');
    await expect(clearAllOption).toBeVisible();
    await expect(clearAllOption).toBeEnabled();

    // This click would fail without the event delegation fix
    await clearAllOption.click();

    // Wait for confirmation dialog - proves the click handler worked
    await expect(page.locator('.confirm-dialog-overlay')).toBeVisible({ timeout: 3000 });

    // Confirm and verify deletion completes
    const confirmBtn = page.locator('#confirm-dialog-btn');
    await confirmBtn.click();

    await expect(page.locator('.user-comment-row')).toHaveCount(0, { timeout: 5000 });
  });

  test('should have Clear All disabled when no comments exist', async ({ page }) => {
    // No comments, so Clear All should be disabled
    const dropdownToggle = page.locator('#split-button-dropdown-toggle');
    await expect(dropdownToggle).toBeVisible({ timeout: 3000 });
    await dropdownToggle.click();

    const dropdown = page.locator('#split-button-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 2000 });

    const clearAllOption = dropdown.locator('[data-action="clear"]');
    await expect(clearAllOption).toBeVisible();
    await expect(clearAllOption).toBeDisabled();
  });
});
