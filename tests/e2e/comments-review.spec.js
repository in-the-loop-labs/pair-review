// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Comments and Review Submission
 *
 * Tests the comment creation, management, and review submission flows.
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

test.describe('Comment Creation', () => {
  test('should show comment form when add comment button is clicked', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Hover over a line number to show the add comment button
    const lineNumberCell = page.locator('.d2h-code-linenumber').first();
    await lineNumberCell.hover();

    // Click the add comment button
    const addCommentBtn = page.locator('.add-comment-btn').first();
    await addCommentBtn.click();

    // The comment form should appear (.user-comment-form is the actual class)
    const commentForm = page.locator('.user-comment-form, .comment-form-row');
    await expect(commentForm.first()).toBeVisible({ timeout: 5000 });
  });

  test('should have textarea for comment input', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Hover and click add comment
    const lineNumberCell = page.locator('.d2h-code-linenumber').first();
    await lineNumberCell.hover();
    await page.locator('.add-comment-btn').first().click();

    // Should have a textarea for comment input
    const textarea = page.locator('.user-comment-form textarea, .comment-textarea');
    await expect(textarea.first()).toBeVisible({ timeout: 5000 });
  });

  test('should have submit and cancel buttons in comment form', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Hover and click add comment
    const lineNumberCell = page.locator('.d2h-code-linenumber').first();
    await lineNumberCell.hover();
    await page.locator('.add-comment-btn').first().click();

    // Wait for form to appear
    await page.waitForSelector('.user-comment-form', { timeout: 5000 });

    // Should have submit button (uses btn-primary or Add Comment text)
    const submitBtn = page.locator('.comment-form-actions button.btn-primary, button:has-text("Add Comment")');
    await expect(submitBtn.first()).toBeVisible();

    // Should have cancel button
    const cancelBtn = page.locator('.comment-form-actions button:has-text("Cancel"), .btn-cancel');
    await expect(cancelBtn.first()).toBeVisible();
  });

  test('should close comment form on cancel', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Hover and click add comment
    const lineNumberCell = page.locator('.d2h-code-linenumber').first();
    await lineNumberCell.hover();
    await page.locator('.add-comment-btn').first().click();

    // Wait for form
    const form = page.locator('.user-comment-form');
    await expect(form.first()).toBeVisible({ timeout: 5000 });

    // Click cancel button
    const cancelBtn = page.locator('.comment-form-actions button:has-text("Cancel")');
    await cancelBtn.first().click();

    // Form should close
    await expect(form.first()).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('Review Modal', () => {
  test('should show review button in toolbar', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Should have a submit review button (SplitButton with Review text)
    const reviewBtn = page.locator('button:has-text("Review"), .split-button-main:has-text("Submit"), #submit-review-btn');
    const count = await reviewBtn.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should open review modal when clicking review button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Click the submit review button
    const reviewBtn = page.locator('button:has-text("Review"), .split-button-main, #submit-review-btn').first();
    await reviewBtn.click();

    // Modal should appear (review modal specifically, not progress modal)
    const modal = page.locator('.review-modal-overlay, .review-modal-container');
    await expect(modal.first()).toBeVisible({ timeout: 5000 });
  });

  test('should have review event options (Approve, Comment, Request Changes)', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Open review modal
    await page.locator('button:has-text("Review"), .split-button-main, #submit-review-btn').first().click();

    // Wait for review modal specifically
    await page.waitForSelector('.review-modal-overlay, .review-modal-container', { timeout: 5000 });

    // Should have review type options (radio buttons with APPROVE, COMMENT, REQUEST_CHANGES values)
    const approveRadio = page.locator('input[value="APPROVE"]');
    const commentRadio = page.locator('input[value="COMMENT"]');
    const requestChangesRadio = page.locator('input[value="REQUEST_CHANGES"]');

    // All three review event options should be visible
    await expect(approveRadio).toBeVisible();
    await expect(commentRadio).toBeVisible();
    await expect(requestChangesRadio).toBeVisible();
  });

  test('should close review modal on cancel', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Open review modal
    await page.locator('.split-button-main').click();

    const modal = page.locator('.review-modal-overlay');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click cancel
    await page.locator('#cancel-review-btn').click();

    // Wait for modal to be hidden (handles animations)
    await modal.waitFor({ state: 'hidden', timeout: 5000 });
  });
});

test.describe('API Integration', () => {
  test('should fetch PR data from API on page load', async ({ page }) => {
    // Set up response listener before navigation
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/pr/') && response.status() === 200
    );

    await page.goto('/pr/test-owner/test-repo/1');

    // Should have made API call for PR data
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('should fetch diff data from API', async ({ page }) => {
    // Set up response listener
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/diff') && response.status() === 200,
      { timeout: 15000 }
    );

    await page.goto('/pr/test-owner/test-repo/1');

    // Should have made API call for diff
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('should handle API errors gracefully', async ({ page }) => {
    // Try to load a PR that doesn't exist
    await page.goto('/pr/nonexistent/repo/999');
    await page.waitForLoadState('domcontentloaded');

    // Page should still load without crashing
    const pageContent = await page.textContent('body');
    expect(pageContent.length).toBeGreaterThan(0);

    // Should show some kind of error indication
    const hasError = pageContent.toLowerCase().includes('error') ||
                     pageContent.toLowerCase().includes('not found');
    expect(hasError).toBe(true);
  });
});

test.describe('UI State Management', () => {
  test('should update UI after data loads', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // After loading, the PR title should be visible
    const pageContent = await page.textContent('body');
    expect(pageContent).toContain('Test PR for E2E');

    // File list should be populated
    const fileItems = page.locator('.file-item');
    const count = await fileItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should maintain file selection state', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Click on a file to set active state
    const firstFile = page.locator('.file-item').first();
    await firstFile.click();

    // Verify file is highlighted
    await expect(firstFile).toHaveClass(/active/);

    // Click a different file
    const secondFile = page.locator('.file-item').nth(1);
    if (await secondFile.count() > 0) {
      await secondFile.click();

      // Second file should now be active
      await expect(secondFile).toHaveClass(/active/);
    }
  });
});

test.describe('Accessibility', () => {
  test('should have proper heading structure', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Should have at least one heading
    const headings = page.locator('h1, h2, h3');
    const count = await headings.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should have accessible buttons', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Test specific known buttons that must have accessible names
    // These are the key interactive elements in the PR page

    // Analyze button should have accessible text
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
    await expect(analyzeBtn).toBeVisible();
    const analyzeText = await analyzeBtn.textContent();
    expect(analyzeText?.trim().length).toBeGreaterThan(0);

    // Review/Submit button should have accessible text
    const reviewBtn = page.locator('button:has-text("Review"), .split-button-main').first();
    await expect(reviewBtn).toBeVisible();
    const reviewText = await reviewBtn.textContent();
    const reviewAriaLabel = await reviewBtn.getAttribute('aria-label');
    expect(reviewText?.trim().length || reviewAriaLabel?.length).toBeGreaterThan(0);

    // Theme toggle (if visible) should have accessible name via aria-label or title
    const themeToggle = page.locator('#theme-toggle');
    if (await themeToggle.isVisible()) {
      const themeAriaLabel = await themeToggle.getAttribute('aria-label');
      const themeTitle = await themeToggle.getAttribute('title');
      expect(themeAriaLabel || themeTitle).toBeTruthy();
    }
  });

  test('should support keyboard navigation', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Tab should move focus to an interactive element
    await page.keyboard.press('Tab');

    // Focus should be on a meaningful interactive element (button, link, input, etc.)
    const focusedInfo = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tagName: el?.tagName,
        isInteractive: ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el?.tagName || ''),
        hasTabIndex: el?.getAttribute('tabindex') !== null,
        role: el?.getAttribute('role')
      };
    });

    // Verify focus moved to a focusable interactive element
    const isValidFocusTarget = focusedInfo.isInteractive ||
                                focusedInfo.hasTabIndex ||
                                focusedInfo.role === 'button' ||
                                focusedInfo.role === 'link';
    expect(isValidFocusTarget).toBe(true);
  });
});
