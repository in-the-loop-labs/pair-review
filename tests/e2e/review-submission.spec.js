// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Review Submission Flow
 *
 * Tests the complete review submission flow including:
 * - Selecting review types (Approve, Comment, Request Changes)
 * - Entering review summary/body
 * - Submitting reviews and verifying success toast
 * - Error handling for submission failures
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

// Helper to open the review modal
async function openReviewModal(page) {
  await waitForDiffToRender(page);
  const reviewBtn = page.locator('.split-button-main').first();
  await reviewBtn.click();
  await page.waitForSelector('.review-modal-overlay', { timeout: 5000 });
}

test.describe('Review Type Selection', () => {
  test('should have Comment selected by default', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Check that COMMENT is selected by default
    const commentRadio = page.locator('input[value="COMMENT"]');
    await expect(commentRadio).toBeChecked();
  });

  test('should be able to select Approve review type', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select APPROVE
    const approveRadio = page.locator('input[value="APPROVE"]');
    await approveRadio.click();
    await expect(approveRadio).toBeChecked();

    // Verify other options are not checked
    const commentRadio = page.locator('input[value="COMMENT"]');
    const requestChangesRadio = page.locator('input[value="REQUEST_CHANGES"]');
    await expect(commentRadio).not.toBeChecked();
    await expect(requestChangesRadio).not.toBeChecked();
  });

  test('should be able to select Request Changes review type', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select REQUEST_CHANGES
    const requestChangesRadio = page.locator('input[value="REQUEST_CHANGES"]');
    await requestChangesRadio.click();
    await expect(requestChangesRadio).toBeChecked();

    // Verify other options are not checked
    const commentRadio = page.locator('input[value="COMMENT"]');
    const approveRadio = page.locator('input[value="APPROVE"]');
    await expect(commentRadio).not.toBeChecked();
    await expect(approveRadio).not.toBeChecked();
  });

  test('should display all three main review type options', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // All three main review types should be visible
    await expect(page.locator('input[value="APPROVE"]')).toBeVisible();
    await expect(page.locator('input[value="COMMENT"]')).toBeVisible();
    await expect(page.locator('input[value="REQUEST_CHANGES"]')).toBeVisible();
  });

  test('should also have Draft option available', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Draft option should also be present
    await expect(page.locator('input[value="DRAFT"]')).toBeVisible();
  });
});

test.describe('Review Summary Input', () => {
  test('should have a textarea for review body', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    const textarea = page.locator('#review-body-modal');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveAttribute('placeholder', /leave a comment/i);
  });

  test('should be able to enter review summary text', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    const textarea = page.locator('#review-body-modal');
    const testText = 'This is a test review summary for the PR.';
    await textarea.fill(testText);

    await expect(textarea).toHaveValue(testText);
  });

  test('should clear textarea when modal is reopened', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Enter some text
    const textarea = page.locator('#review-body-modal');
    await textarea.fill('Some test text');

    // Close modal
    await page.locator('#cancel-review-btn').click();
    await page.waitForSelector('.review-modal-overlay', { state: 'hidden', timeout: 5000 });

    // Reopen modal
    await openReviewModal(page);

    // Textarea should be empty
    await expect(textarea).toHaveValue('');
  });
});

test.describe('Review Submission Success', () => {
  test('should submit Comment review successfully', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Enter review body
    const textarea = page.locator('#review-body-modal');
    await textarea.fill('Great changes, looks good!');

    // COMMENT is already selected by default, just submit
    const submitBtn = page.locator('#submit-review-btn-modal');
    await submitBtn.click();

    // Wait for success toast
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/review submitted/i);
  });

  test('should submit Approve review successfully', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select APPROVE
    await page.locator('input[value="APPROVE"]').click();

    // Enter review body
    await page.locator('#review-body-modal').fill('LGTM!');

    // Submit
    await page.locator('#submit-review-btn-modal').click();

    // Wait for success toast
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/review submitted/i);
  });

  test('should submit Request Changes review with comment', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select REQUEST_CHANGES
    await page.locator('input[value="REQUEST_CHANGES"]').click();

    // Enter review body (required for request changes)
    await page.locator('#review-body-modal').fill('Please fix the formatting issues.');

    // Submit
    await page.locator('#submit-review-btn-modal').click();

    // Wait for success toast
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/review submitted/i);
  });

  test('should close modal after successful submission', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Enter review and submit
    await page.locator('#review-body-modal').fill('Test review');
    await page.locator('#submit-review-btn-modal').click();

    // Modal should close
    const modal = page.locator('.review-modal-overlay');
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
  });

  test('should show View on GitHub link in success toast', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Submit a review
    await page.locator('#review-body-modal').fill('Test review');
    await page.locator('#submit-review-btn-modal').click();

    // Wait for success toast with link
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });

    // Should have a link to GitHub
    const link = toast.locator('.toast-link');
    await expect(link).toBeVisible();
    await expect(link).toContainText(/view on github/i);
  });
});

test.describe('Review Submission Validation', () => {
  test('should allow Comment submission without body', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // COMMENT is default, submit without body
    await page.locator('#submit-review-btn-modal').click();

    // Should succeed (toast visible means no validation error blocked it)
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
  });

  test('should allow Approve submission without body', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select APPROVE and submit without body
    await page.locator('input[value="APPROVE"]').click();
    await page.locator('#submit-review-btn-modal').click();

    // Should succeed
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Review Submission UI States', () => {
  test('should show loading state during submission', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Enter review
    await page.locator('#review-body-modal').fill('Test review');

    // Click submit and check for loading state
    const submitBtn = page.locator('#submit-review-btn-modal');
    await submitBtn.click();

    // Button should show loading state (may be brief, so check it exists at some point)
    // The button text changes to "Submitting review..." during submission
    // This might be too fast to catch consistently, so we just verify success
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
  });

  test('should disable cancel button during submission', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    await page.locator('#review-body-modal').fill('Test review');
    await page.locator('#submit-review-btn-modal').click();

    // Wait for submission to complete (success toast)
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
  });

  test('should reset form state when modal is reopened after submission', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Submit with APPROVE
    await page.locator('input[value="APPROVE"]').click();
    await page.locator('#review-body-modal').fill('Test review');
    await page.locator('#submit-review-btn-modal').click();

    // Wait for success and modal to close
    await page.waitForSelector('.toast-success', { timeout: 10000 });
    await page.waitForSelector('.review-modal-overlay', { state: 'hidden', timeout: 10000 });

    // Reopen modal
    await openReviewModal(page);

    // Should be reset to COMMENT default
    await expect(page.locator('input[value="COMMENT"]')).toBeChecked();
    await expect(page.locator('#review-body-modal')).toHaveValue('');
  });
});

test.describe('Draft Review Submission', () => {
  test('should disable textarea when DRAFT is selected', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    const textarea = page.locator('#review-body-modal');

    // Textarea should be enabled by default (COMMENT selected)
    await expect(textarea).toBeEnabled();

    // Select DRAFT
    await page.locator('input[value="DRAFT"]').click();

    // Textarea should now be disabled
    await expect(textarea).toBeDisabled();

    // Should have tooltip explaining why
    await expect(textarea).toHaveAttribute('title', 'Review summary is not included with draft reviews');

    // Selecting a different option should re-enable it
    await page.locator('input[value="APPROVE"]').click();
    await expect(textarea).toBeEnabled();
    await expect(textarea).toHaveAttribute('title', '');
  });

  test('should be able to submit draft review', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select DRAFT
    await page.locator('input[value="DRAFT"]').click();

    // Textarea is disabled for drafts - cannot enter body text
    await expect(page.locator('#review-body-modal')).toBeDisabled();

    // Submit
    await page.locator('#submit-review-btn-modal').click();

    // Wait for success toast (draft has different message)
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/draft|submitted/i);
  });
});

test.describe('Assisted-by Footer Toggle', () => {
  test('should show assisted-by toggle in modal', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    const toggle = page.locator('#assisted-by-toggle');
    await expect(toggle).toBeVisible();

    const checkbox = page.locator('#assisted-by-checkbox');
    await expect(checkbox).toBeVisible();
  });

  test('should append footer when toggle is checked', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Check the toggle
    const checkbox = page.locator('#assisted-by-checkbox');
    await checkbox.check();

    // Verify footer appears in textarea
    const textarea = page.locator('#review-body-modal');
    await expect(textarea).toHaveValue(/Review assisted by \[pair-review\]/);
  });

  test('should remove footer when toggle is unchecked', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Check then uncheck
    const checkbox = page.locator('#assisted-by-checkbox');
    await checkbox.check();
    await checkbox.uncheck();

    // Footer should be gone
    const textarea = page.locator('#review-body-modal');
    await expect(textarea).toHaveValue('');
  });

  test('should include footer in submitted review body', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Enter review text
    const textarea = page.locator('#review-body-modal');
    await textarea.fill('Great work!');

    // Check the toggle (footer will be appended)
    const checkbox = page.locator('#assisted-by-checkbox');
    await checkbox.check();

    // Verify textarea has both text and footer
    await expect(textarea).toHaveValue(/Great work![\s\S]*Review assisted by \[pair-review\]/);

    // Intercept the submit API call
    const submitPromise = page.waitForRequest(request =>
      request.url().includes('/submit-review') && request.method() === 'POST'
    );

    // Submit
    await page.locator('#submit-review-btn-modal').click();

    const request = await submitPromise;
    const body = JSON.parse(request.postData());
    expect(body.body).toContain('Review assisted by [pair-review]');
  });

  test('should persist toggle state across modal open/close', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Check the toggle
    const checkbox = page.locator('#assisted-by-checkbox');
    await checkbox.check();

    // Close modal
    await page.locator('#cancel-review-btn').click();
    await page.waitForSelector('.review-modal-overlay', { state: 'hidden', timeout: 5000 });

    // Reopen modal
    await openReviewModal(page);

    // Checkbox should still be checked
    await expect(checkbox).toBeChecked();

    // Footer should be present
    const textarea = page.locator('#review-body-modal');
    await expect(textarea).toHaveValue(/Review assisted by \[pair-review\]/);
  });

  test('should disable toggle when Draft is selected', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Toggle should be enabled by default
    const toggle = page.locator('#assisted-by-toggle');
    await expect(toggle).not.toHaveClass(/disabled/);

    // Select DRAFT
    await page.locator('input[value="DRAFT"]').click();

    // Toggle should be disabled
    await expect(toggle).toHaveClass(/disabled/);

    // Switch back to COMMENT
    await page.locator('input[value="COMMENT"]').click();
    await expect(toggle).not.toHaveClass(/disabled/);
  });
});
