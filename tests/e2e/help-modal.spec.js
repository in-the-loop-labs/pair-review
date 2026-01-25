// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Help Modal
 *
 * Tests the help modal functionality on the home page including
 * opening, closing, and content display.
 */

import { test, expect } from '@playwright/test';

test.describe('Help Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should open modal when help button is clicked', async ({ page }) => {
    // Find the help button
    const helpBtn = page.locator('#help-btn');
    await expect(helpBtn).toBeVisible();

    // Click the help button
    await helpBtn.click();

    // Verify the modal overlay becomes visible
    const overlay = page.locator('#help-modal-overlay');
    await expect(overlay).toHaveClass(/visible/);

    // Verify the modal itself is visible
    const modal = page.locator('#help-modal');
    await expect(modal).toBeVisible();
  });

  test('should close modal when X button is clicked', async ({ page }) => {
    // Open the modal
    const helpBtn = page.locator('#help-btn');
    await helpBtn.click();

    // Verify modal is open
    const overlay = page.locator('#help-modal-overlay');
    await expect(overlay).toHaveClass(/visible/);

    // Click the close button
    const closeBtn = page.locator('#help-modal-close');
    await closeBtn.click();

    // Verify the modal is closed (overlay should not have visible class)
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test('should close modal when Escape key is pressed', async ({ page }) => {
    // Open the modal
    const helpBtn = page.locator('#help-btn');
    await helpBtn.click();

    // Verify modal is open
    const overlay = page.locator('#help-modal-overlay');
    await expect(overlay).toHaveClass(/visible/);

    // Press Escape key
    await page.keyboard.press('Escape');

    // Verify the modal is closed
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test('should close modal when clicking the overlay (outside the modal)', async ({ page }) => {
    // Open the modal
    const helpBtn = page.locator('#help-btn');
    await helpBtn.click();

    // Verify modal is open
    const overlay = page.locator('#help-modal-overlay');
    await expect(overlay).toHaveClass(/visible/);

    // Click on the overlay (outside the modal)
    // The overlay is the parent, so we click on its edge
    await overlay.click({ position: { x: 10, y: 10 } });

    // Verify the modal is closed
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test('should display command examples in the modal', async ({ page }) => {
    // Open the modal
    const helpBtn = page.locator('#help-btn');
    await helpBtn.click();

    // Verify modal is open
    const modal = page.locator('#help-modal');
    await expect(modal).toBeVisible();

    // Verify command examples are present
    const cmdExamples = page.locator('.help-modal-content .cmd-example');
    const count = await cmdExamples.count();
    expect(count).toBeGreaterThan(0);

    // Verify at least one command example has content
    const firstExample = cmdExamples.first();
    const content = await firstExample.textContent();
    expect(content).toBeTruthy();
    // The command should contain 'pair-review' (either npx or direct)
    expect(content).toMatch(/pair-review/);
  });

  test('should not close modal when clicking inside the modal', async ({ page }) => {
    // Open the modal
    const helpBtn = page.locator('#help-btn');
    await helpBtn.click();

    // Verify modal is open
    const overlay = page.locator('#help-modal-overlay');
    await expect(overlay).toHaveClass(/visible/);

    // Click inside the modal content area
    const modalContent = page.locator('.help-modal-content');
    await modalContent.click();

    // Modal should still be open
    await expect(overlay).toHaveClass(/visible/);
  });

  test('should have proper ARIA attributes for accessibility', async ({ page }) => {
    // Open the modal
    const helpBtn = page.locator('#help-btn');
    await helpBtn.click();

    // Verify the modal has proper ARIA attributes
    const modal = page.locator('#help-modal');
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-labelledby', 'help-modal-title');
    await expect(modal).toHaveAttribute('aria-modal', 'true');

    // Verify the title has the proper id
    const title = page.locator('#help-modal-title');
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Getting Started');
  });

  test('help button should have aria-label', async ({ page }) => {
    const helpBtn = page.locator('#help-btn');
    await expect(helpBtn).toHaveAttribute('aria-label', 'Open help modal');
  });
});
