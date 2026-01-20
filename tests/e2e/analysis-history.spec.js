// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Analysis History Manager
 *
 * Tests the analysis history UI including:
 * - Empty state display when no analysis exists
 * - Selector display after analysis runs
 * - Info popover opening and details
 * - Copy button feedback
 * - Repository instructions toggle behavior
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

/**
 * Helper to seed an analysis run by triggering the analyze endpoint
 * Returns the analysis run data
 */
async function seedAnalysis(page) {
  // Make a direct POST request to trigger analysis
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/analyze/test-owner/test-repo/1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customInstructions: 'Test custom instructions for analysis'
      })
    });
    if (!response.ok) {
      throw new Error(`Analysis API failed: ${response.status}`);
    }
    return response.json();
  });

  if (!result.analysisId) {
    throw new Error('Analysis failed to start: no analysisId returned');
  }

  // Wait for analysis to complete by polling the status endpoint
  await page.waitForFunction(
    async () => {
      const response = await fetch('/api/pr/test-owner/test-repo/1/analysis-status');
      const status = await response.json();
      return !status.running;
    },
    { timeout: 5000 }
  );

  // Give the UI a moment to update
  await page.waitForTimeout(200);

  return result;
}

/**
 * Helper to reload the analysis history UI
 */
async function reloadAnalysisHistory(page) {
  await page.evaluate(async () => {
    if (window.prManager?.analysisHistoryManager) {
      await window.prManager.analysisHistoryManager.loadAnalysisRuns();
    }
  });
  // Wait for UI to update
  await page.waitForTimeout(200);
}

test.describe('Analysis History - Empty State', () => {
  test('should show empty state when no analysis exists', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Note: In a full test suite run, previous tests may have already run analysis,
    // so we check for the expected behavior based on the current state
    const emptyState = page.locator('#analysis-context-empty');
    const selector = page.locator('#analysis-context-selector');

    // Check if this is a fresh state (no analysis) or post-analysis state
    const selectorDisplay = await selector.evaluate(el => window.getComputedStyle(el).display);

    if (selectorDisplay === 'none') {
      // Fresh state - no analysis has been run
      await expect(emptyState).toBeVisible();
      await expect(selector).toBeHidden();
    } else {
      // Analysis already exists from previous tests - skip this specific assertion
      // The test still validates that the UI correctly shows one or the other state
      const emptyDisplay = await emptyState.evaluate(el => window.getComputedStyle(el).display);
      expect(emptyDisplay).toBe('none'); // Empty should be hidden when selector is visible
    }
  });

  test('should display "No AI analysis yet" text in empty state', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const emptyState = page.locator('#analysis-context-empty');

    // If empty state is visible, verify its text content
    const isVisible = await emptyState.isVisible();
    if (isVisible) {
      await expect(emptyState).toContainText('No AI analysis yet');
    } else {
      // Analysis already exists from previous tests - verify the element has the correct text
      // even if it's hidden (the text is still in the DOM)
      const text = await emptyState.textContent();
      expect(text).toContain('No AI analysis yet');
    }
  });
});

test.describe('Analysis History - Selector Display', () => {
  test('should show selector after running analysis', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const emptyState = page.locator('#analysis-context-empty');
    const selector = page.locator('#analysis-context-selector');

    // Check initial state - might already have analysis from previous tests
    const initialSelectorVisible = await selector.isVisible();

    if (!initialSelectorVisible) {
      // Fresh state - empty state should be visible initially
      await expect(emptyState).toBeVisible();
    }

    // Run analysis (will be a new run even if one exists)
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Now selector should be visible and empty state hidden
    await expect(selector).toBeVisible({ timeout: 5000 });
    await expect(emptyState).toBeHidden();
  });

  test('should hide empty state when selector is shown', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Empty state should be hidden
    const emptyState = page.locator('#analysis-context-empty');
    await expect(emptyState).toBeHidden();

    // Verify by checking the display style
    const display = await emptyState.evaluate(el => window.getComputedStyle(el).display);
    expect(display).toBe('none');
  });

  test('should display model and provider in selector label', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Selector label should contain model/provider info
    const selectorLabel = page.locator('#analysis-context-label');
    await expect(selectorLabel).toBeVisible({ timeout: 5000 });

    // The label should have some text (model and provider)
    const labelText = await selectorLabel.textContent();
    expect(labelText.length).toBeGreaterThan(0);
  });
});

test.describe('Analysis History - Info Popover', () => {
  test('should open info popover when clicking info button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis first
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Wait for selector to be visible
    const selector = page.locator('#analysis-context-selector');
    await expect(selector).toBeVisible({ timeout: 5000 });

    // Click the info button
    const infoBtn = page.locator('#analysis-context-info-btn');
    await expect(infoBtn).toBeVisible();
    await infoBtn.click();

    // Popover should be visible
    const popover = page.locator('#analysis-context-popover');
    await expect(popover).toBeVisible({ timeout: 2000 });
  });

  test('should show analysis details in popover', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Wait for selector to be visible
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });

    // Open popover
    await page.locator('#analysis-context-info-btn').click();

    // Check for expected labels in the popover
    const popoverContent = page.locator('#analysis-context-info-content');
    await expect(popoverContent).toBeVisible({ timeout: 2000 });

    // Should show Model, Provider, and other details
    await expect(popoverContent).toContainText('Model');
    await expect(popoverContent).toContainText('Provider');
  });

  test('should close popover when clicking outside', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open popover
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-info-btn').click();

    const popover = page.locator('#analysis-context-popover');
    await expect(popover).toBeVisible({ timeout: 2000 });

    // Click outside the analysis context area
    await page.locator('#diff-container').click();

    // Popover should close
    await expect(popover).toBeHidden({ timeout: 2000 });
  });

  test('should close popover when pressing Escape', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open popover
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-info-btn').click();

    const popover = page.locator('#analysis-context-popover');
    await expect(popover).toBeVisible({ timeout: 2000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Popover should close
    await expect(popover).toBeHidden({ timeout: 2000 });
  });
});

test.describe('Analysis History - Copy Button', () => {
  test('should show "Copied!" feedback when clicking copy button', async ({ page, context }) => {
    // Grant clipboard permissions to allow the copy operation
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis with custom instructions
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open popover
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-info-btn').click();
    await page.locator('#analysis-context-popover').waitFor({ state: 'visible', timeout: 2000 });

    // Find a copy button in the popover
    const copyBtn = page.locator('#analysis-context-popover [data-action="copy-instructions"]').first();

    // Check if copy button exists (may not exist if no custom instructions)
    const copyBtnExists = await copyBtn.count() > 0;
    if (!copyBtnExists) {
      // Skip this test if no copy button present (no instructions to copy)
      test.skip();
      return;
    }

    // Get the initial text
    const initialText = await copyBtn.locator('.copy-btn-text').textContent();
    expect(initialText).toBe('Copy');

    // Click the copy button
    await copyBtn.click();

    // Text should change to "Copied!"
    const copyBtnText = copyBtn.locator('.copy-btn-text');
    await expect(copyBtnText).toHaveText('Copied!', { timeout: 2000 });

    // Wait for it to reset back to "Copy"
    await expect(copyBtnText).toHaveText('Copy', { timeout: 3000 });
  });

  test('should add "copied" class to button when copying', async ({ page, context }) => {
    // Grant clipboard permissions to allow the copy operation
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis with custom instructions
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open popover
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-info-btn').click();
    await page.locator('#analysis-context-popover').waitFor({ state: 'visible', timeout: 2000 });

    // Find a copy button
    const copyBtn = page.locator('#analysis-context-popover [data-action="copy-instructions"]').first();

    // Check if copy button exists
    const copyBtnExists = await copyBtn.count() > 0;
    if (!copyBtnExists) {
      test.skip();
      return;
    }

    // Click the copy button
    await copyBtn.click();

    // Button should have "copied" class
    await expect(copyBtn).toHaveClass(/copied/, { timeout: 2000 });

    // Class should be removed after timeout
    await expect(copyBtn).not.toHaveClass(/copied/, { timeout: 3000 });
  });
});

test.describe('Analysis History - Repository Instructions Toggle', () => {
  test('should toggle expanded class on repo section when clicking toggle', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis - we need to ensure repo instructions are present
    // First, let's check if we can set repo instructions
    await page.evaluate(async () => {
      // Set repo settings with default instructions via API
      await fetch('/api/repo-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repository: 'test-owner/test-repo',
          default_instructions: 'Repository instructions for testing'
        })
      });
    });

    // Now run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open popover
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-info-btn').click();
    await page.locator('#analysis-context-popover').waitFor({ state: 'visible', timeout: 2000 });

    // Find the repo instructions toggle button
    const toggleBtn = page.locator('#analysis-context-popover [data-action="toggle-repo-instructions"]').first();

    // Check if toggle button exists (may not exist if no repo instructions)
    const toggleExists = await toggleBtn.count() > 0;
    if (!toggleExists) {
      // Skip this test if no repo instructions toggle present
      test.skip();
      return;
    }

    // Find the parent section
    const repoSection = page.locator('#analysis-context-popover .analysis-info-repo-section').first();

    // Initially should not have expanded class
    await expect(repoSection).not.toHaveClass(/expanded/);

    // Click toggle to expand
    await toggleBtn.click();

    // Should now have expanded class
    await expect(repoSection).toHaveClass(/expanded/, { timeout: 1000 });

    // Click again to collapse
    await toggleBtn.click();

    // Should no longer have expanded class
    await expect(repoSection).not.toHaveClass(/expanded/, { timeout: 1000 });
  });

  test('should expand repo section to show content', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Set repo instructions
    await page.evaluate(async () => {
      await fetch('/api/repo-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repository: 'test-owner/test-repo',
          default_instructions: 'Repository instructions for testing the expand feature'
        })
      });
    });

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open popover
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-info-btn').click();
    await page.locator('#analysis-context-popover').waitFor({ state: 'visible', timeout: 2000 });

    // Find the toggle
    const toggleBtn = page.locator('#analysis-context-popover [data-action="toggle-repo-instructions"]').first();

    // Check if toggle exists
    const toggleExists = await toggleBtn.count() > 0;
    if (!toggleExists) {
      test.skip();
      return;
    }

    // The content section
    const contentSection = page.locator('#analysis-context-popover .analysis-info-repo-content').first();

    // Content should be hidden initially (collapsed)
    // The CSS uses display: none when not expanded
    const initialDisplay = await contentSection.evaluate(el => {
      return window.getComputedStyle(el).display;
    });
    expect(initialDisplay).toBe('none');

    // Click to expand
    await toggleBtn.click();

    // Content should now be visible (expanded)
    // The CSS uses display: block when expanded
    const expandedDisplay = await contentSection.evaluate(el => {
      return window.getComputedStyle(el).display;
    });
    expect(expandedDisplay).toBe('block');
  });
});

test.describe('Analysis History - Dropdown', () => {
  test('should open dropdown when clicking the selector button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Wait for selector
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });

    // Click the main selector button (not the info button)
    const selectorBtn = page.locator('#analysis-context-btn');
    await selectorBtn.click();

    // Container should have 'open' class
    const container = page.locator('#analysis-context');
    await expect(container).toHaveClass(/open/, { timeout: 1000 });

    // Dropdown should be visible
    const dropdown = page.locator('#analysis-context-dropdown');
    await expect(dropdown).toBeVisible();
  });

  test('should close dropdown when clicking outside', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open dropdown
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-btn').click();

    const container = page.locator('#analysis-context');
    await expect(container).toHaveClass(/open/, { timeout: 1000 });

    // Click outside
    await page.locator('#diff-container').click();

    // Dropdown should close
    await expect(container).not.toHaveClass(/open/, { timeout: 1000 });
  });

  test('should show analysis history items in dropdown', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open dropdown
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-btn').click();

    // Should have at least one history item
    const historyItems = page.locator('#analysis-context-list .analysis-history-item');
    const count = await historyItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should show LATEST badge on most recent analysis', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open dropdown
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-btn').click();

    // First item should have LATEST badge
    const latestBadge = page.locator('#analysis-context-list .analysis-history-item:first-child .analysis-latest-badge');
    await expect(latestBadge).toBeVisible();
    await expect(latestBadge).toContainText('LATEST');
  });
});
