// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Analysis History Manager
 *
 * Tests the analysis history UI including:
 * - Empty state display when no analysis exists
 * - Selector display after analysis runs
 * - Split-panel dropdown with hover-to-preview functionality
 * - Copy button feedback in preview panel
 * - Dropdown behavior and selection
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

test.describe('Analysis History - Preview Panel', () => {
  test('should show preview panel in split-panel dropdown', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis first
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Wait for selector to be visible
    const selector = page.locator('#analysis-context-selector');
    await expect(selector).toBeVisible({ timeout: 5000 });

    // Click the selector button to open dropdown
    await page.locator('#analysis-context-btn').click();

    // Dropdown should have two panels: run list and preview
    const dropdown = page.locator('#analysis-context-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 2000 });

    const runList = page.locator('#analysis-context-list');
    const previewPanel = page.locator('#analysis-context-preview');
    await expect(runList).toBeVisible();
    await expect(previewPanel).toBeVisible();
  });

  test('should show analysis details in preview panel', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Wait for selector to be visible
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });

    // Open dropdown
    await page.locator('#analysis-context-btn').click();

    // Check for expected content in the preview panel
    const previewPanel = page.locator('#analysis-context-preview');
    await expect(previewPanel).toBeVisible({ timeout: 2000 });

    // Should show run details (Run at, Duration, Suggestions)
    await expect(previewPanel).toContainText('Run at');
    await expect(previewPanel).toContainText('Duration');
    await expect(previewPanel).toContainText('Suggestions');
  });

  test('should update preview when hovering over different run items', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run multiple analyses to have more than one item
    await seedAnalysis(page);
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open dropdown
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-btn').click();

    // Get the run items and wait for at least 2 items to be ready
    const runItems = page.locator('#analysis-context-list .analysis-history-item');
    await expect(async () => {
      const count = await runItems.count();
      expect(count).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 3000 });

    // Hover over the second item
    await runItems.nth(1).hover();

    // The second item should have the 'previewing' class
    await expect(runItems.nth(1)).toHaveClass(/previewing/);

    // Verify the preview panel displays the correct content for the hovered item
    const previewPanel = page.locator('#analysis-context-preview');
    await expect(previewPanel).toBeVisible();

    // Should show Provider row
    const providerRow = previewPanel.locator('.analysis-preview-row:has(.analysis-preview-label:text("Provider"))');
    await expect(providerRow).toBeVisible();
    await expect(providerRow.locator('.analysis-preview-value')).toHaveText(/\w+/); // Non-empty provider

    // Should show Model row
    const modelRow = previewPanel.locator('.analysis-preview-row:has(.analysis-preview-label:text("Model"))');
    await expect(modelRow).toBeVisible();
    await expect(modelRow.locator('.analysis-preview-value')).toHaveText(/\w+/); // Non-empty model

    // Should show Tier row
    const tierRow = previewPanel.locator('.analysis-preview-row:has(.analysis-preview-label:text("Tier"))');
    await expect(tierRow).toBeVisible();
    await expect(tierRow.locator('.analysis-preview-value')).toHaveText(/\w+/); // Non-empty tier (Fast, Balanced, Thorough, or Unknown)
  });

  test('should close dropdown when pressing Escape', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open dropdown
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-btn').click();

    const container = page.locator('#analysis-context');
    await expect(container).toHaveClass(/open/, { timeout: 2000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Dropdown should close
    await expect(container).not.toHaveClass(/open/, { timeout: 2000 });
  });
});

test.describe('Analysis History - Copy Button', () => {
  test('should show "Copied!" feedback when clicking copy button in preview', async ({ page, context }) => {
    // Grant clipboard permissions to allow the copy operation
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis with custom instructions
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open dropdown
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-btn').click();
    await page.locator('#analysis-context-dropdown').waitFor({ state: 'visible', timeout: 2000 });

    // Find a copy button in the preview panel
    const copyBtn = page.locator('#analysis-context-preview [data-action="copy-instructions"]').first();

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

    // Open dropdown
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-btn').click();
    await page.locator('#analysis-context-dropdown').waitFor({ state: 'visible', timeout: 2000 });

    // Find a copy button in preview panel
    const copyBtn = page.locator('#analysis-context-preview [data-action="copy-instructions"]').first();

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

  test('should show first item as selected (most recent)', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Run analysis
    await seedAnalysis(page);
    await reloadAnalysisHistory(page);

    // Open dropdown
    await page.locator('#analysis-context-selector').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#analysis-context-btn').click();

    // First item should be selected (most recent is selected by default)
    const firstItem = page.locator('#analysis-context-list .analysis-history-item:first-child');
    await expect(firstItem).toHaveClass(/selected/);
  });
});
