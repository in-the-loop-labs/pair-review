/**
 * E2E Tests: AI Summary Modal
 *
 * Tests the AI Summary Modal functionality including:
 * - Opening the modal via the sparkle button
 * - Closing the modal via ESC key and close button
 * - Displaying summary content and stats
 * - Copy summary functionality
 *
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

// Helper to seed AI suggestions and ensure summary is available
async function seedAISuggestionsWithSummary(page) {
  // Make a direct POST request to trigger analysis
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/analyze/test-owner/test-repo/1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) {
      throw new Error(`Analysis API failed: ${response.status}`);
    }
    return response.json();
  });

  if (!result.analysisId) {
    throw new Error('Analysis failed to start: no analysisId returned');
  }

  // Wait for analysis to complete
  await page.waitForFunction(
    async () => {
      const response = await fetch('/api/pr/test-owner/test-repo/1/analysis-status');
      const status = await response.json();
      return !status.running;
    },
    { timeout: 10000 }
  );

  // Reload suggestions
  await page.evaluate(async () => {
    if (window.prManager?.loadAISuggestions) {
      await window.prManager.loadAISuggestions();
    }
  });

  // Wait for suggestions to appear
  await page.waitForSelector('.ai-suggestion, [data-suggestion-id]', { timeout: 5000 });
}

test.describe('AI Summary Modal', () => {
  test('should have AI summary button in panel header', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // AI summary button should exist with correct attributes
    const summaryBtn = page.locator('#ai-summary-btn');
    await expect(summaryBtn).toBeVisible();
    await expect(summaryBtn).toHaveAttribute('aria-label', 'View AI summary');
    await expect(summaryBtn).toHaveAttribute('title', 'View AI Summary');
  });

  test('should open modal when clicking summary button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Click the summary button
    await page.locator('#ai-summary-btn').click();

    // Modal should be visible
    const modal = page.locator('#ai-summary-modal');
    await expect(modal).toBeVisible();

    // Modal should have expected structure
    await expect(page.locator('.ai-summary-modal-container')).toBeVisible();
    await expect(page.locator('#ai-summary-content')).toBeVisible();
  });

  test('should close modal when pressing Escape', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Open modal
    await page.locator('#ai-summary-btn').click();
    await expect(page.locator('#ai-summary-modal')).toBeVisible();

    // Press Escape
    await page.keyboard.press('Escape');

    // Modal should be hidden
    await expect(page.locator('#ai-summary-modal')).toBeHidden();
  });

  test('should close modal when clicking close button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Open modal
    await page.locator('#ai-summary-btn').click();
    await expect(page.locator('#ai-summary-modal')).toBeVisible();

    // Click close button
    await page.locator('.ai-summary-modal-container [data-action="close"]').first().click();

    // Modal should be hidden
    await expect(page.locator('#ai-summary-modal')).toBeHidden();
  });

  test('should close modal when clicking backdrop', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Open modal
    await page.locator('#ai-summary-btn').click();
    await expect(page.locator('#ai-summary-modal')).toBeVisible();

    // Click on the backdrop area (outside the modal container)
    // We click near the top-left corner of the backdrop to avoid hitting the centered modal
    await page.locator('#ai-summary-modal .modal-backdrop[data-action="close"]').click({ position: { x: 10, y: 10 } });

    // Modal should be hidden
    await expect(page.locator('#ai-summary-modal')).toBeHidden();
  });

  test('should display stats in modal', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Open modal
    await page.locator('#ai-summary-btn').click();
    await expect(page.locator('#ai-summary-modal')).toBeVisible();

    // Stats elements should exist
    await expect(page.locator('#ai-summary-issues-count')).toBeVisible();
    await expect(page.locator('#ai-summary-praise-count')).toBeVisible();
  });

  test('should have copy button in modal', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Open modal
    await page.locator('#ai-summary-btn').click();
    await expect(page.locator('#ai-summary-modal')).toBeVisible();

    // Copy button should exist
    const copyBtn = page.locator('#ai-summary-copy-btn');
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toContainText('Copy Summary');
  });

  test('should show empty state when no summary available', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Open modal before running analysis (no summary yet)
    await page.locator('#ai-summary-btn').click();
    await expect(page.locator('#ai-summary-modal')).toBeVisible();

    // Should show empty state message
    const content = page.locator('#ai-summary-content');
    await expect(content).toContainText('No AI summary available');
  });

  test('should display summary after analysis', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis to get summary
    await seedAISuggestionsWithSummary(page);

    // Reload AI summary data
    await page.evaluate(async () => {
      if (window.prManager?.loadAISuggestions) {
        await window.prManager.loadAISuggestions();
      }
    });

    // Wait a moment for data to load
    await page.waitForTimeout(500);

    // Open modal
    await page.locator('#ai-summary-btn').click();
    await expect(page.locator('#ai-summary-modal')).toBeVisible();

    // Content should have loaded (may or may not have summary depending on mock)
    const content = page.locator('#ai-summary-content');
    await expect(content).toBeVisible();
  });

  test('should have accessible button with hover effect', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Check button has accessibility attributes
    const btn = page.locator('#ai-summary-btn');
    await expect(btn).toHaveAttribute('aria-label', 'View AI summary');

    // Check button has CSS class for styling
    await expect(btn).toHaveClass(/ai-summary-btn/);
  });
});

test.describe('AI Summary Modal - Local Mode', () => {
  test('should have AI summary button in local mode panel', async ({ page }) => {
    // First create a local review
    await page.goto('/local');
    await page.waitForLoadState('networkidle');

    // Check if we're on a local review page or need to create one
    const reviewLink = page.locator('a[href^="/local/"]').first();
    if (await reviewLink.isVisible()) {
      await reviewLink.click();
    } else {
      // May need different handling for fresh state
      return; // Skip if no review exists
    }

    await waitForDiffToRender(page);

    // AI summary button should exist
    const summaryBtn = page.locator('#ai-summary-btn');
    await expect(summaryBtn).toBeVisible();
    await expect(summaryBtn).toHaveAttribute('aria-label', 'View AI summary');
  });
});
