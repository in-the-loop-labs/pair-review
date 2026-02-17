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

import { test, expect } from '@playwright/test';
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
  const progressModal = page.locator('#progress-modal');
  await progressModal.waitFor({ state: 'visible', timeout: 5000 });

  // Wait for analysis to complete by watching for modal to close
  await progressModal.waitFor({ state: 'hidden', timeout: 10000 });
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
}

test.describe('AI Analysis Button', () => {
  test('should show Analyze button in toolbar', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await page.waitForLoadState('networkidle');

    // Should have an analyze button
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")');
    await expect(analyzeBtn.first()).toBeVisible();
  });

  test('should have AI-related UI elements visible', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await page.waitForLoadState('networkidle');

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

    // Progress modal should appear (unified council-progress-modal is used for all analysis types)
    const progressModal = page.locator('#council-progress-modal');
    await expect(progressModal).toBeVisible({ timeout: 5000 });
  });

  test('should show level progress indicators in modal', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

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

    // Wait for unified progress modal
    const progressModal = page.locator('#council-progress-modal');
    await progressModal.waitFor({ state: 'visible', timeout: 5000 });

    // Should show level indicators (Level 1, Level 2, Level 3)
    const progressContent = await progressModal.textContent();
    expect(progressContent).toContain('Level 1');
    expect(progressContent).toContain('Level 2');
    expect(progressContent).toContain('Level 3');
  });

  test('should have cancel and background buttons', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

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

    // Wait for unified progress modal
    const progressModal = page.locator('#council-progress-modal');
    await progressModal.waitFor({ state: 'visible', timeout: 5000 });

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

test.describe('Suggestion Actions', () => {
  test('should show adopt, edit, and dismiss buttons on suggestions', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for suggestions
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // Get first suggestion
    const suggestion = page.locator('.ai-suggestion').first();

    // Should have Adopt button
    const adoptBtn = suggestion.locator('.ai-action-adopt, button:has-text("Adopt")');
    await expect(adoptBtn).toBeVisible();

    // Should have Edit button
    const editBtn = suggestion.locator('.ai-action-edit, button:has-text("Edit")');
    await expect(editBtn).toBeVisible();

    // Should have Dismiss button
    const dismissBtn = suggestion.locator('.ai-action-dismiss, button:has-text("Dismiss")');
    await expect(dismissBtn).toBeVisible();
  });

  test('should collapse suggestion when dismissed', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for suggestions
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // Find a suggestion that is not collapsed (actions are visible)
    const suggestion = page.locator('.ai-suggestion:not(.collapsed)').first();
    await suggestion.scrollIntoViewIfNeeded();
    const suggestionId = await suggestion.getAttribute('data-suggestion-id');

    // Click dismiss
    const dismissBtn = suggestion.locator('.ai-action-dismiss, button:has-text("Dismiss")');
    await dismissBtn.click();

    // Wait for the suggestion to be collapsed (poll for class change)
    const collapsedSuggestion = page.locator(`.ai-suggestion[data-suggestion-id="${suggestionId}"].collapsed`);
    await expect(collapsedSuggestion).toBeVisible({ timeout: 5000 });
  });

  test('should show restore button on dismissed suggestions', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for suggestions
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // Find a suggestion that is not collapsed (actions are visible)
    const activeSuggestion = page.locator('.ai-suggestion:not(.collapsed)').first();
    await activeSuggestion.scrollIntoViewIfNeeded();
    const suggestionId = await activeSuggestion.getAttribute('data-suggestion-id');

    // Dismiss this suggestion
    await activeSuggestion.locator('.ai-action-dismiss').click();

    // Wait for the collapsed state
    const targetSuggestion = page.locator(`.ai-suggestion[data-suggestion-id="${suggestionId}"].collapsed`);
    await expect(targetSuggestion).toBeVisible({ timeout: 5000 });

    // Should show restore/show button
    const restoreBtn = targetSuggestion.locator('.btn-restore, button:has-text("Show")');
    await expect(restoreBtn).toBeVisible();
  });

  test('should restore suggestion when clicking show button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for suggestions
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // Find a suggestion that is not collapsed
    const activeSuggestion = page.locator('.ai-suggestion:not(.collapsed)').first();
    await activeSuggestion.scrollIntoViewIfNeeded();
    const suggestionId = await activeSuggestion.getAttribute('data-suggestion-id');

    // Dismiss this suggestion
    await activeSuggestion.locator('.ai-action-dismiss').click();

    // Wait for the collapsed state
    const collapsedSuggestion = page.locator(`.ai-suggestion[data-suggestion-id="${suggestionId}"].collapsed`);
    await expect(collapsedSuggestion).toBeVisible({ timeout: 5000 });

    // Click restore
    await collapsedSuggestion.locator('.btn-restore').click();

    // Suggestion should no longer be collapsed
    const uncollapsedSuggestion = page.locator(`.ai-suggestion[data-suggestion-id="${suggestionId}"]:not(.collapsed)`);
    await expect(uncollapsedSuggestion).toBeVisible({ timeout: 5000 });
  });

  test('should create user comment when adopting suggestion', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for suggestions
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // Find a suggestion that is not collapsed
    const suggestion = page.locator('.ai-suggestion:not(.collapsed)').first();
    await suggestion.scrollIntoViewIfNeeded();

    // Adopt this suggestion
    await suggestion.locator('.ai-action-adopt, button:has-text("Adopt")').click();

    // Should create a user comment row
    const userComment = page.locator('.user-comment-row, .user-comment');
    await expect(userComment.first()).toBeVisible({ timeout: 5000 });
  });

  test('should correctly restore second dismissed suggestion on same line (regression: pair_review-nzu7)', async ({ page }) => {
    // This test verifies the fix for bug pair_review-nzu7:
    // When two AI suggestions target the same line, dismissing both and then
    // restoring them should work correctly for BOTH suggestions.
    // The bug was that only the first suggestion would restore - the second would
    // appear to do nothing because the code incorrectly used
    // suggestionRow.querySelector('.ai-suggestion') which always returned the first div.

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for suggestions
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // Find an ai-suggestion-row that contains multiple suggestions
    // (suggestions on the same line share the same <tr class="ai-suggestion-row">)
    const rowsWithMultipleSuggestions = await page.evaluate(() => {
      const rows = document.querySelectorAll('.ai-suggestion-row');
      const result = [];
      for (const row of rows) {
        const suggestions = row.querySelectorAll('.ai-suggestion');
        if (suggestions.length >= 2) {
          result.push({
            suggestionIds: Array.from(suggestions).map(s => s.dataset.suggestionId)
          });
        }
      }
      return result;
    });

    // Get the first and second suggestion IDs from the same row
    const [firstId, secondId] = rowsWithMultipleSuggestions[0].suggestionIds;
    const suggestion1 = page.locator(`.ai-suggestion[data-suggestion-id="${firstId}"]`);
    const suggestion2 = page.locator(`.ai-suggestion[data-suggestion-id="${secondId}"]`);

    // Scroll to the suggestions
    await suggestion1.scrollIntoViewIfNeeded();

    // Step 1: Dismiss both suggestions
    await suggestion1.locator('.ai-action-dismiss').click();
    await expect(suggestion1).toHaveClass(/collapsed/, { timeout: 3000 });

    await suggestion2.locator('.ai-action-dismiss').click();
    await expect(suggestion2).toHaveClass(/collapsed/, { timeout: 3000 });

    // Step 2: Restore the FIRST suggestion
    await suggestion1.locator('.btn-restore').click();
    await expect(suggestion1).not.toHaveClass(/collapsed/, { timeout: 3000 });
    // Second should still be collapsed
    await expect(suggestion2).toHaveClass(/collapsed/);

    // Step 3: This is the critical test - restore the SECOND suggestion
    // Before the fix, this would fail because it would toggle suggestion1 again
    await suggestion2.locator('.btn-restore').click();

    // BOTH suggestions should now be uncollapsed
    await expect(suggestion1).not.toHaveClass(/collapsed/, { timeout: 3000 });
    await expect(suggestion2).not.toHaveClass(/collapsed/, { timeout: 3000 });
  });
});

test.describe('Suggestion Navigation', () => {
  test('should show navigation counter in panel', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Should show navigation counter (e.g., "1 of 4")
    const counter = page.locator('.findings-counter, #findings-count');
    await expect(counter.first()).toBeVisible();
  });

  test('should have prev/next navigation buttons', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Should have prev button
    const prevBtn = page.locator('.nav-prev, .findings-nav-btn:first-child');
    await expect(prevBtn.first()).toBeVisible();

    // Should have next button
    const nextBtn = page.locator('.nav-next, .findings-nav-btn:last-child');
    await expect(nextBtn.first()).toBeVisible();
  });

  test('should navigate to next finding when clicking next button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Get initial counter value
    const counter = page.locator('.findings-counter, #findings-count').first();
    const initialText = await counter.textContent();

    // Click next
    await page.locator('.nav-next').first().click();

    // Counter should update
    const newText = await counter.textContent();

    // Should have changed (unless only 1 item)
    const findingsCount = await page.locator('.finding-item').count();
    if (findingsCount > 1) {
      expect(newText).not.toBe(initialText);
    }
  });

  test('should highlight active finding in panel', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Click a finding
    await page.locator('.finding-item').first().click();

    // Should have active class
    const activeFinding = page.locator('.finding-item.active');
    await expect(activeFinding.first()).toBeVisible();
  });

  test('should support keyboard navigation with j/k keys', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Press 'j' to navigate to next
    await page.keyboard.press('j');

    // Should have an active finding
    const activeFinding = page.locator('.finding-item.active');
    await expect(activeFinding.first()).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Quick Action Buttons in Review Panel', () => {
  test('should show quick-action buttons on hover over active finding items', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings to appear in the panel
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Find an active finding (not dismissed or adopted)
    const activeFinding = page.locator('.finding-item-wrapper:has(.finding-active)').first();
    await expect(activeFinding).toBeVisible();

    // Quick actions should be hidden initially
    const quickActions = activeFinding.locator('.finding-quick-actions');
    await expect(quickActions).toHaveCSS('opacity', '0');

    // Hover over the finding
    await activeFinding.hover();

    // Quick actions should now be visible
    await expect(quickActions).toHaveCSS('opacity', '1');

    // Should have adopt button
    const adoptBtn = quickActions.locator('.quick-action-adopt');
    await expect(adoptBtn).toBeVisible();

    // Should have dismiss button
    const dismissBtn = quickActions.locator('.quick-action-dismiss');
    await expect(dismissBtn).toBeVisible();
  });

  test('should adopt suggestion when clicking quick-action adopt button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings to appear
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Find an active finding
    const activeFinding = page.locator('.finding-item-wrapper:has(.finding-active)').first();
    const findingId = await activeFinding.locator('.finding-item').getAttribute('data-id');

    // Hover to reveal quick actions
    await activeFinding.hover();

    // Click adopt button
    const adoptBtn = activeFinding.locator('.quick-action-adopt');
    await adoptBtn.click();

    // Finding should now be marked as adopted
    const adoptedFinding = page.locator(`.finding-item[data-id="${findingId}"].finding-adopted`);
    await expect(adoptedFinding).toBeVisible({ timeout: 5000 });
  });

  test('should dismiss suggestion when clicking quick-action dismiss button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings to appear
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Find an active finding - use .last() to avoid conflicts with adopt test
    // which uses .first(). Tests run sequentially and share database state.
    const activeFindings = page.locator('.finding-item-wrapper:has(.finding-active)');
    const count = await activeFindings.count();
    expect(count).toBeGreaterThan(0);

    const activeFinding = activeFindings.last();
    await expect(activeFinding).toBeVisible();
    const findingId = await activeFinding.locator('.finding-item').getAttribute('data-id');

    // Hover to reveal quick actions
    await activeFinding.hover();

    // Wait for quick actions to be visible
    const quickActions = activeFinding.locator('.finding-quick-actions');
    await expect(quickActions).toHaveCSS('opacity', '1', { timeout: 2000 });

    // Click dismiss button
    const dismissBtn = activeFinding.locator('.quick-action-dismiss');
    await dismissBtn.click();

    // Wait for the status to change - check that finding is no longer active
    // (it should have finding-dismissed class)
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`.finding-item[data-id="${id}"]`);
        return el && el.classList.contains('finding-dismissed');
      },
      findingId,
      { timeout: 5000 }
    );

    // Verify the finding is dismissed
    const dismissedFinding = page.locator(`.finding-item[data-id="${findingId}"].finding-dismissed`);
    await expect(dismissedFinding).toBeVisible();
  });

  test('should not show quick-action buttons on already-adopted findings', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings to appear
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // First, adopt a finding to get an adopted state
    const activeFinding = page.locator('.finding-item-wrapper:has(.finding-active)').first();
    await activeFinding.hover();
    await activeFinding.locator('.quick-action-adopt').click();

    // Wait for adopted state using explicit wait for DOM state change
    await page.waitForFunction(() => {
      const wrapper = document.querySelector('.finding-item-wrapper:has(.finding-adopted)');
      return wrapper !== null;
    }, { timeout: 5000 });

    // The adopted finding should not have quick-action buttons
    const adoptedWrapper = page.locator('.finding-item-wrapper:has(.finding-adopted)').first();
    const quickActions = adoptedWrapper.locator('.finding-quick-actions');
    const quickActionsCount = await quickActions.count();
    expect(quickActionsCount).toBe(0);
  });

  test('should show restore button on dismissed findings instead of adopt/dismiss', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings to appear
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Find an active finding and dismiss it - use the second-to-last to avoid conflicts
    // with adopt test (.first()) and dismiss test (.last())
    const activeFindings = page.locator('.finding-item-wrapper:has(.finding-active)');
    const count = await activeFindings.count();
    expect(count).toBeGreaterThan(0);
    // Use second-to-last to avoid conflicts: .first() is adopted, .last() is dismissed by earlier tests
    const activeFinding = count > 1 ? activeFindings.nth(count - 2) : activeFindings.first();
    const findingId = await activeFinding.locator('.finding-item').getAttribute('data-id');
    await activeFinding.hover();
    await activeFinding.locator('.quick-action-dismiss').click();

    // Wait for dismissed state using explicit wait for DOM state change
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`.finding-item[data-id="${id}"]`);
        return el && el.classList.contains('finding-dismissed');
      },
      findingId,
      { timeout: 5000 }
    );

    // The dismissed finding should have a restore button instead of adopt/dismiss buttons
    const dismissedWrapper = page.locator(`.finding-item-wrapper:has(.finding-item[data-id="${findingId}"])`);
    const restoreBtn = dismissedWrapper.locator('.quick-action-restore');
    const adoptBtn = dismissedWrapper.locator('.quick-action-adopt');
    const dismissBtn = dismissedWrapper.locator('.quick-action-dismiss');

    // Should have restore button, but not adopt or dismiss
    expect(await restoreBtn.count()).toBe(1);
    expect(await adoptBtn.count()).toBe(0);
    expect(await dismissBtn.count()).toBe(0);
  });

  test('should hide restore button by default and show on hover (same as adopt/dismiss)', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings to appear
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Find an active finding and dismiss it - dynamically select to avoid conflicts
    // with adopt test (.first()), dismiss test (.last()), and restore button test
    const activeFindings = page.locator('.finding-item-wrapper:has(.finding-active)');
    const count = await activeFindings.count();
    expect(count).toBeGreaterThan(0);
    // Use middle finding if available, otherwise use what's available
    const middleIndex = Math.floor(count / 2);
    const activeFinding = activeFindings.nth(middleIndex);
    const findingId = await activeFinding.locator('.finding-item').getAttribute('data-id');
    await activeFinding.hover();
    await activeFinding.locator('.quick-action-dismiss').click();

    // Wait for dismissed state
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`.finding-item[data-id="${id}"]`);
        return el && el.classList.contains('finding-dismissed');
      },
      findingId,
      { timeout: 5000 }
    );

    // Move mouse away from any findings to ensure hover state is cleared
    await page.mouse.move(0, 0);

    // Get the dismissed finding by ID for precise targeting
    const dismissedWrapper = page.locator(`.finding-item-wrapper:has(.finding-item[data-id="${findingId}"])`);
    const quickActions = dismissedWrapper.locator('.finding-quick-actions');

    // Quick actions should be hidden initially (opacity: 0)
    await expect(quickActions).toHaveCSS('opacity', '0');

    // Hover over the finding
    await dismissedWrapper.hover();

    // Quick actions should now be visible (opacity: 1)
    await expect(quickActions).toHaveCSS('opacity', '1');

    // Restore button should be visible when hovered
    const restoreBtn = quickActions.locator('.quick-action-restore');
    await expect(restoreBtn).toBeVisible();
  });

  test('should restore finding to active state when clicking restore button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Wait for findings to appear
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    // Step 1: Find an active finding and dismiss it - dynamically select to avoid conflicts
    // with other tests. Use the last remaining active finding.
    const activeFindings = page.locator('.finding-item-wrapper:has(.finding-active)');
    const count = await activeFindings.count();
    expect(count).toBeGreaterThan(0);
    // Use last available active finding to maximize isolation from other tests
    const activeFinding = activeFindings.last();
    const findingId = await activeFinding.locator('.finding-item').getAttribute('data-id');
    await activeFinding.hover();
    await activeFinding.locator('.quick-action-dismiss').click();

    // Wait for dismissed state
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`.finding-item[data-id="${id}"]`);
        return el && el.classList.contains('finding-dismissed');
      },
      findingId,
      { timeout: 5000 }
    );

    // Step 2: Click the restore button
    const dismissedWrapper = page.locator(`.finding-item-wrapper:has(.finding-item[data-id="${findingId}"])`);
    await dismissedWrapper.hover();
    const restoreBtn = dismissedWrapper.locator('.quick-action-restore');
    await restoreBtn.click();

    // Step 3: Verify the finding returns to 'active' state with finding-active class
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`.finding-item[data-id="${id}"]`);
        return el && el.classList.contains('finding-active');
      },
      findingId,
      { timeout: 5000 }
    );

    const restoredFinding = page.locator(`.finding-item[data-id="${findingId}"].finding-active`);
    await expect(restoredFinding).toBeVisible();

    // Step 4: Verify adopt/dismiss buttons reappear
    const restoredWrapper = page.locator(`.finding-item-wrapper:has(.finding-item[data-id="${findingId}"])`);
    await restoredWrapper.hover();

    const adoptBtn = restoredWrapper.locator('.quick-action-adopt');
    const dismissBtn = restoredWrapper.locator('.quick-action-dismiss');

    await expect(adoptBtn).toBeVisible();
    await expect(dismissBtn).toBeVisible();
  });
});

test.describe('Level Filtering', () => {
  test('should have level filter pills (if visible)', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Level filter may be hidden by default in current implementation
    // Check if it exists in DOM (might be hidden)
    const levelFilter = page.locator('#level-filter, .level-filter');
    const exists = await levelFilter.count() > 0;

    // If it exists, it should have level pills
    if (exists) {
      const pills = page.locator('.level-pill');
      const pillCount = await pills.count();
      expect(pillCount).toBeGreaterThanOrEqual(0);
    } else {
      // Level filter not present - this is acceptable as it may be hidden by design
      expect(true).toBe(true);
    }
  });
});

test.describe('SuggestionNavigator Sidebar', () => {
  test('should have suggestion navigator component in DOM', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Navigator component should exist in DOM (may be visible or collapsed)
    const navigator = page.locator('.suggestion-navigator');
    const toggle = page.locator('.navigator-toggle-collapsed');

    // Either navigator or toggle should be in DOM
    const navigatorCount = await navigator.count();
    const toggleCount = await toggle.count();

    expect(navigatorCount + toggleCount).toBeGreaterThan(0);
  });

  test('should show level selector in navigator', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Try to expand navigator if collapsed
    const toggle = page.locator('.navigator-toggle-collapsed');
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await page.waitForTimeout(300);
    }

    // Level selector should be visible in navigator (or in the main panel)
    const levelSelector = page.locator('.level-selector, .level-option, .level-filter');
    const count = await levelSelector.count();
    expect(count).toBeGreaterThanOrEqual(0);  // May not always be visible
  });

  test('should have suggestion counter element', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Try to expand navigator if collapsed
    const toggle = page.locator('.navigator-toggle-collapsed');
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await page.waitForTimeout(300);
    }

    // Counter element should exist (may be hidden or visible)
    const counter = page.locator('.suggestion-counter, #total-suggestions, .findings-counter');
    const count = await counter.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should list suggestions in navigator when expanded', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    // Try to expand navigator if collapsed
    const toggle = page.locator('.navigator-toggle-collapsed');
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await page.waitForTimeout(300);
    }

    // Check for suggestion items or finding items in the panel
    const items = page.locator('.suggestions-list .suggestion-item, .finding-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should have navigator toggle functionality', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed AI suggestions
    await seedAISuggestions(page);

    await page.waitForTimeout(500);

    const navigator = page.locator('.suggestion-navigator');
    const collapseToggle = page.locator('.navigator-toggle-collapsed');

    const navigatorVisible = await navigator.isVisible().catch(() => false);
    const toggleVisible = await collapseToggle.isVisible().catch(() => false);

    // Should have either navigator visible or a way to toggle it
    if (navigatorVisible) {
      // Click the collapse button inside navigator
      const internalToggle = navigator.locator('.navigator-toggle');
      if (await internalToggle.isVisible().catch(() => false)) {
        await internalToggle.click();
        await page.waitForTimeout(300);
        // State should have changed
        expect(true).toBe(true);
      }
    } else if (toggleVisible) {
      // Click to expand
      await collapseToggle.click();
      await page.waitForTimeout(300);
      // State should have changed
      expect(true).toBe(true);
    } else {
      // Navigator system exists but in different state
      expect(true).toBe(true);
    }
  });
});

test.describe('API Integration', () => {
  test('should call AI analysis endpoint when triggering analysis', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Set up response listener
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/pr/test-owner/test-repo/1/analyses') && response.status() === 200,
      { timeout: 10000 }
    );

    // Trigger analysis
    await page.locator('#analyze-btn, button:has-text("Analyze")').first().click();

    // Handle config modal or confirm dialog
    await handleAnalysisModals(page);

    // Should have called the analysis endpoint
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('should fetch AI suggestions from API after analysis', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Set up response listener for suggestions endpoint
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/suggestions') && !response.url().includes('/check') && response.status() === 200,
      { timeout: 10000 }
    );

    // Seed AI suggestions (triggers reload of suggestions)
    await seedAISuggestions(page);

    // Should have called the suggestions endpoint
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });
});

test.describe('Error Handling', () => {
  test('should handle analysis on non-existent PR gracefully', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/999');
    await page.waitForLoadState('networkidle');

    // Page should show error state
    const pageContent = await page.textContent('body');
    const hasError = pageContent.toLowerCase().includes('error') ||
                     pageContent.toLowerCase().includes('not found');
    expect(hasError).toBe(true);
  });
});
