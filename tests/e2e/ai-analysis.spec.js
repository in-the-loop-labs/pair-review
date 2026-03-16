// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: AI Analysis Flow
 *
 * Tests the AI analysis functionality including:
 * - Triggering AI analysis
 * - Progress modal display
 * - AI suggestions appearing in the AIPanel
 * - Level filtering (L1/L2/L3/Final views)
 * - Adopt/edit/discard actions on suggestions
 * - SuggestionNavigator (next/prev navigation)
 * - Segment control (AI vs Comments tabs)
 *
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

// Helper to handle modals when triggering analysis
async function handleAnalysisModals(page) {
  // Handle config modal or confirm dialog that may appear
  const configModal = page.locator('#analysis-config-modal');
  const confirmDialog = page.locator('#confirm-dialog');

  try {
    // Try waiting for config modal first
    await configModal.waitFor({ state: 'visible', timeout: 2000 });
    await page.locator('#analysis-config-modal .btn-primary').first().click();
  } catch (error) {
    // Only swallow timeout errors - re-throw unexpected errors
    if (error.name !== 'TimeoutError' && !error.message?.includes('Timeout')) {
      throw error;
    }
    // If config modal didn't appear (timeout), check for confirm dialog (when re-running analysis)
    if (await confirmDialog.isVisible()) {
      await page.locator('#confirm-dialog .btn-danger, #confirm-dialog button:has-text("Continue")').first().click();
      // After confirm, config modal should appear
      await configModal.waitFor({ state: 'visible', timeout: 2000 });
      await page.locator('#analysis-config-modal .btn-primary').first().click();
    }
  }
}

// Helper to trigger AI analysis and wait for completion
async function triggerAnalysisAndWait(page) {
  // Click the analyze button
  const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
  await analyzeBtn.click();

  // Handle modal flow
  await handleAnalysisModals(page);

  // Wait for the progress modal to appear
  const progressModal = page.locator('#council-progress-modal');
  await progressModal.waitFor({ state: 'visible', timeout: 5000 });

  // Wait for analysis to complete by watching for modal to close
  await progressModal.waitFor({ state: 'hidden', timeout: 10000 });
}

// Helper to wait for the progress modal to be fully ready (visible + body populated)
async function waitForProgressModalReady(page, timeout = 5000) {
  const progressModal = page.locator('#council-progress-modal');
  await progressModal.waitFor({ state: 'visible', timeout });
  // Wait for the modal body to be populated with at least one level header
  await progressModal.locator('.council-level-header').first().waitFor({ state: 'attached', timeout });
  return progressModal;
}

// Helper to dismiss the progress modal if it's currently blocking interactions.
// This can happen when a previous test triggered an analysis that is still running
// (or completed but the modal wasn't closed), causing the page to auto-show it.
async function dismissProgressModalIfVisible(page) {
  const progressModal = page.locator('#council-progress-modal');
  const isVisible = await progressModal.isVisible();
  if (isVisible) {
    // Click the "Run in Background" button to hide the modal without cancelling
    const bgBtn = progressModal.locator('.council-bg-btn, button:has-text("Background")').first();
    const bgBtnVisible = await bgBtn.isVisible().catch(() => false);
    if (bgBtnVisible) {
      await bgBtn.click();
    } else {
      // Fallback: directly hide via JS
      await page.evaluate(() => {
        const modal = document.getElementById('council-progress-modal');
        if (modal) modal.style.display = 'none';
      });
    }
    await progressModal.waitFor({ state: 'hidden', timeout: 3000 });
  }
}

// Helper to pre-seed AI suggestions by calling the analyze endpoint directly
async function seedAISuggestions(page) {
  // Make a direct POST request to trigger analysis and verify success
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/pr/test-owner/test-repo/1/analyses', {
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

  // Wait for analysis to complete by polling the status endpoint
  await page.waitForFunction(
    async () => {
      const reviewId = window.prManager?.currentPR?.id;
      if (!reviewId) return false;
      const response = await fetch(`/api/reviews/${reviewId}/analyses/status`);
      const status = await response.json();
      return !status.running;
    },
    { timeout: 5000 }
  );

  // Reload suggestions and wait for them to appear in the DOM
  await page.evaluate(async () => {
    if (window.prManager?.loadAISuggestions) {
      await window.prManager.loadAISuggestions();
    }
  });

  // Wait for at least one AI suggestion to render
  await page.waitForSelector('.ai-suggestion, [data-suggestion-id]', { timeout: 5000 });

  // Dismiss the progress modal if it appeared (the POST triggers the modal via
  // the running-analysis check on the frontend, and it can linger long enough to
  // intercept pointer events on suggestion action buttons).
  await dismissProgressModalIfVisible(page);
}

test.describe('AI Analysis Button', () => {
  test('should show Analyze button in toolbar', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Should have an analyze button
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")');
    await expect(analyzeBtn.first()).toBeVisible();
  });

  test('should have AI-related UI elements visible', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Check for AI panel or segment control
    const pageContent = await page.textContent('body');
    const hasAIIndicator = pageContent.toLowerCase().includes('ai') ||
                           pageContent.toLowerCase().includes('analyze') ||
                           pageContent.toLowerCase().includes('suggestion');
    expect(hasAIIndicator).toBe(true);
  });
});

test.describe('Analysis Config Modal', () => {
  test('should trigger analysis with Cmd+Enter keyboard shortcut', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Click analyze button to open config modal
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
    await analyzeBtn.click();

    // Handle confirm dialog if it appears (for re-running analysis)
    const confirmDialog = page.locator('#confirm-dialog');
    if (await confirmDialog.isVisible().catch(() => false)) {
      await page.locator('#confirm-dialog .btn-danger, #confirm-dialog button:has-text("Continue")').first().click();
    }

    // Wait for config modal to appear
    const configModal = page.locator('#analysis-config-modal');
    await configModal.waitFor({ state: 'visible', timeout: 3000 });

    // Focus the custom instructions textarea and type something
    const textarea = page.locator('#custom-instructions');
    await textarea.focus();
    await textarea.fill('Test instructions');

    // Press Cmd+Enter (or Ctrl+Enter on non-Mac)
    const isMac = process.platform === 'darwin';
    await page.keyboard.press(isMac ? 'Meta+Enter' : 'Control+Enter');

    // Config modal should close and progress modal should appear
    await configModal.waitFor({ state: 'hidden', timeout: 3000 });
    const progressModal = page.locator('#council-progress-modal');
    await expect(progressModal).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Progress Modal', () => {
  test('should show progress modal when analysis starts', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Dismiss any progress modal left over from a previous test's analysis
    await dismissProgressModalIfVisible(page);

    // Click analyze button
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
    await analyzeBtn.click();

    // Handle config modal if it appears - wait and click start
    const configModal = page.locator('#analysis-config-modal');
    try {
      await configModal.waitFor({ state: 'visible', timeout: 2000 });
      await page.locator('#analysis-config-modal .btn-primary, #analysis-config-modal button:has-text("Start")').first().click();
    } catch {
      // Config modal may not appear if analysis was already triggered - handle confirm dialog
      const confirmDialog = page.locator('#confirm-dialog');
      if (await confirmDialog.isVisible()) {
        await page.locator('#confirm-dialog .btn-danger, #confirm-dialog button:has-text("Continue")').first().click();
        // Now wait for config modal
        await configModal.waitFor({ state: 'visible', timeout: 2000 });
        await page.locator('#analysis-config-modal .btn-primary').first().click();
      }
    }

    // Progress modal should appear with body populated
    await waitForProgressModalReady(page);
  });

  test('should show level progress indicators in modal', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Dismiss any progress modal left over from a previous test's analysis
    await dismissProgressModalIfVisible(page);

    // Click analyze button
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
    await analyzeBtn.click();

    // Handle config modal or confirm dialog
    const configModal = page.locator('#analysis-config-modal');
    try {
      await configModal.waitFor({ state: 'visible', timeout: 2000 });
      await page.locator('#analysis-config-modal .btn-primary').first().click();
    } catch {
      const confirmDialog = page.locator('#confirm-dialog');
      if (await confirmDialog.isVisible()) {
        await page.locator('#confirm-dialog .btn-danger, #confirm-dialog button:has-text("Continue")').first().click();
        await configModal.waitFor({ state: 'visible', timeout: 2000 });
        await page.locator('#analysis-config-modal .btn-primary').first().click();
      }
    }

    // Wait for progress modal with body fully populated
    const progressModal = await waitForProgressModalReady(page);

    // Should show level indicators (Level 1, Level 2, Level 3)
    const progressContent = await progressModal.textContent();
    expect(progressContent).toContain('Level 1');
    expect(progressContent).toContain('Level 2');
    expect(progressContent).toContain('Level 3');
  });

  test('should have cancel and background buttons', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Dismiss any progress modal left over from a previous test's analysis
    await dismissProgressModalIfVisible(page);

    // Click analyze button
    await page.locator('#analyze-btn, button:has-text("Analyze")').first().click();

    // Handle config modal or confirm dialog
    const configModal = page.locator('#analysis-config-modal');
    try {
      await configModal.waitFor({ state: 'visible', timeout: 2000 });
      await page.locator('#analysis-config-modal .btn-primary').first().click();
    } catch {
      const confirmDialog = page.locator('#confirm-dialog');
      if (await confirmDialog.isVisible()) {
        await page.locator('#confirm-dialog .btn-danger, #confirm-dialog button:has-text("Continue")').first().click();
        await configModal.waitFor({ state: 'visible', timeout: 2000 });
        await page.locator('#analysis-config-modal .btn-primary').first().click();
      }
    }

    // Wait for progress modal with body fully populated
    const progressModal = await waitForProgressModalReady(page);

    // Should have Run in Background button
    const backgroundBtn = progressModal.locator('.council-bg-btn, button:has-text("Background")');
    await expect(backgroundBtn.first()).toBeVisible();

    // Should have Cancel button
    const cancelBtn = progressModal.locator('.council-cancel-btn, button:has-text("Cancel")');
    await expect(cancelBtn.first()).toBeVisible();
  });
});

test.describe('AI Panel', () => {
  test('should show AI panel with segment control', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // AI panel should be visible
    const aiPanel = page.locator('#ai-panel, .ai-panel');
    await expect(aiPanel.first()).toBeVisible();

    // Segment control should exist
    const segmentControl = page.locator('#segment-control, .segment-control');
    await expect(segmentControl.first()).toBeVisible();
  });

  test('should have AI and Comments segment buttons', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Should have AI segment button
    const aiSegment = page.locator('.segment-btn[data-segment="ai"], button:has-text("AI")');
    await expect(aiSegment.first()).toBeVisible();

    // Should have Comments segment button
    const commentsSegment = page.locator('.segment-btn[data-segment="comments"], button:has-text("Comments")');
    await expect(commentsSegment.first()).toBeVisible();
  });

  test('should show findings list container', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Panel starts collapsed by default for new reviews; expand it first
    await page.evaluate(() => window.aiPanel?.expand());

    // Findings list container should exist
    const findingsList = page.locator('#findings-list, .findings-list');
    await expect(findingsList.first()).toBeVisible();
  });

  test('should display AI suggestions after analysis', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Findings should now be visible in the AI panel
    const findingItems = page.locator('.finding-item');
    await expect(findingItems.first()).toBeVisible({ timeout: 5000 });

    // Should have multiple findings
    const count = await findingItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should show suggestion titles in panel', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings to appear
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Check that suggestion titles are visible
    const panelContent = await page.locator('#ai-panel, .ai-panel').textContent();
    expect(panelContent).toContain('const');  // From our mock suggestion titles
  });
});

test.describe('Segment Control', () => {
  test('should switch between AI and Comments views', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Panel starts collapsed by default; expand it so segment buttons are interactable
    await page.evaluate(() => window.aiPanel?.expand());

    // Seed AI suggestions first
    await seedAISuggestions(page);

    // Click AI segment
    const aiSegment = page.locator('.segment-btn[data-segment="ai"]').first();
    await aiSegment.click();
    await expect(aiSegment).toHaveClass(/active/);

    // Click Comments segment
    const commentsSegment = page.locator('.segment-btn[data-segment="comments"]').first();
    await commentsSegment.click();
    await expect(commentsSegment).toHaveClass(/active/);

    // AI segment should no longer be active
    await expect(aiSegment).not.toHaveClass(/active/);
  });

  test('should show "All" segment option', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Should have All segment button
    const allSegment = page.locator('.segment-btn[data-segment="all"]');
    await expect(allSegment.first()).toBeVisible();
  });

  test('should update counts in segment buttons', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // AI segment should show count
    const aiCount = page.locator('.segment-btn[data-segment="ai"] .segment-count');
    const countText = await aiCount.textContent();

    // Should have a count in parentheses
    expect(countText).toMatch(/\(\d+\)/);
  });
});

test.describe('AI Suggestions Display', () => {
  test('should display suggestions inline with diff', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // AI suggestion rows should appear in the diff
    const suggestionRows = page.locator('.ai-suggestion-row, .ai-suggestion');
    await expect(suggestionRows.first()).toBeVisible({ timeout: 5000 });
  });

  test('should show suggestion type badges', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for suggestions to render
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // Should have type badges
    const badges = page.locator('.ai-suggestion-badge, .type-badge, .praise-badge');
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should show praise suggestions with star icon', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for suggestions
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // Should have praise badge (one of our mock suggestions is type 'praise')
    const praiseBadges = page.locator('.praise-badge');
    await expect(praiseBadges.first()).toBeVisible({ timeout: 3000 });
  });
});

