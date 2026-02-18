// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Panel Resize Functionality
 *
 * Tests the drag-to-resize functionality for the sidebar and AI panel.
 * Verifies that widths can be changed via drag and persist to localStorage.
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender, dragResizeHandle } from './helpers.js';

test.describe('Panel Resize - PR Mode', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test
    await page.goto('/pr/test-owner/test-repo/1');
    await page.evaluate(() => {
      localStorage.removeItem('sidebar-width');
      localStorage.removeItem('ai-panel-width');
    });
    // Reload to apply cleared state
    await page.reload();
    await waitForDiffToRender(page);
  });

  test.describe('Sidebar Resize', () => {
    test('should have a resize handle on the sidebar', async ({ page }) => {
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');
      await expect(resizeHandle).toBeVisible();
    });

    test('should change sidebar width when dragging the resize handle', async ({ page }) => {
      const sidebar = page.locator('#files-sidebar');
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');

      // Get initial width
      const initialWidth = await sidebar.evaluate(el => el.offsetWidth);

      // Get handle position
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).not.toBeNull();

      // Drag the handle 50px to the right
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 50, handleBox.y + handleBox.height / 2);
      await page.mouse.up();

      // Verify width changed
      const newWidth = await sidebar.evaluate(el => el.offsetWidth);
      expect(newWidth).toBeGreaterThan(initialWidth);
      expect(newWidth).toBeCloseTo(initialWidth + 50, -1); // Allow some tolerance
    });

    test('should persist sidebar width to localStorage', async ({ page }) => {
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');

      // Get handle position
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).not.toBeNull();

      // Drag the handle 30px to the right
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 30, handleBox.y + handleBox.height / 2);
      await page.mouse.up();

      // Check localStorage
      const savedWidth = await page.evaluate(() => localStorage.getItem('sidebar-width'));
      expect(savedWidth).not.toBeNull();
      const widthValue = parseInt(savedWidth, 10);
      expect(widthValue).toBeGreaterThan(260); // Default is 260px
    });

    test('should respect minimum sidebar width constraint', async ({ page }) => {
      const sidebar = page.locator('#files-sidebar');
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');

      // Get handle position
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).not.toBeNull();

      // Drag the handle 200px to the left (way past minimum)
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x - 200, handleBox.y + handleBox.height / 2);
      await page.mouse.up();

      // Verify width is at minimum (150px)
      const newWidth = await sidebar.evaluate(el => el.offsetWidth);
      expect(newWidth).toBeGreaterThanOrEqual(150);
    });

    test('should respect maximum sidebar width constraint', async ({ page }) => {
      const sidebar = page.locator('#files-sidebar');
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');

      // Get handle position
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).not.toBeNull();

      // Drag the handle 300px to the right (way past maximum)
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 300, handleBox.y + handleBox.height / 2);
      await page.mouse.up();

      // Verify width is at maximum (400px)
      const newWidth = await sidebar.evaluate(el => el.offsetWidth);
      expect(newWidth).toBeLessThanOrEqual(400);
    });

    test('should restore saved sidebar width on page reload', async ({ page }) => {
      const sidebar = page.locator('#files-sidebar');
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');

      // Drag to set a new width
      const handleBox = await resizeHandle.boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 40, handleBox.y + handleBox.height / 2);
      await page.mouse.up();

      // Get the new width
      const widthBeforeReload = await sidebar.evaluate(el => el.offsetWidth);

      // Reload page
      await page.reload();
      await waitForDiffToRender(page);

      // Verify width is restored
      const widthAfterReload = await sidebar.evaluate(el => el.offsetWidth);
      expect(widthAfterReload).toBeCloseTo(widthBeforeReload, -1);
    });
  });

  test.describe('AI Panel Resize', () => {
    test('should have a resize handle on the AI panel', async ({ page }) => {
      const resizeHandle = page.locator('.resize-handle[data-panel="ai-panel"]');
      await expect(resizeHandle).toBeVisible();
    });

    test('should change AI panel width when dragging the resize handle', async ({ page }) => {
      const aiPanel = page.locator('#ai-panel');
      const resizeHandle = page.locator('.resize-handle[data-panel="ai-panel"]');

      // Get initial width
      const initialWidth = await aiPanel.evaluate(el => el.offsetWidth);

      // Drag the handle 100px to the left (increases AI panel width)
      // For AI panel (right side), dragging left increases width
      await dragResizeHandle(page, resizeHandle, -100);

      // Verify width increased
      const newWidth = await aiPanel.evaluate(el => el.offsetWidth);
      expect(newWidth).toBeGreaterThan(initialWidth);
    });

    test('should persist AI panel width to localStorage', async ({ page }) => {
      const aiPanel = page.locator('#ai-panel');
      const resizeHandle = page.locator('.resize-handle[data-panel="ai-panel"]');

      // Get initial width (may vary based on viewport/media queries)
      const initialWidth = await aiPanel.evaluate(el => el.offsetWidth);

      // Drag the handle 30px to the left (increase width)
      await dragResizeHandle(page, resizeHandle, -30);

      // Check localStorage
      const savedWidth = await page.evaluate(() => localStorage.getItem('ai-panel-width'));
      expect(savedWidth).not.toBeNull();
      const widthValue = parseInt(savedWidth, 10);
      expect(widthValue).toBeGreaterThan(initialWidth); // Should be larger than initial
    });

    test('should respect minimum AI panel width constraint', async ({ page }) => {
      const aiPanel = page.locator('#ai-panel');
      const resizeHandle = page.locator('.resize-handle[data-panel="ai-panel"]');

      // Drag the handle 200px to the right (way past minimum)
      await dragResizeHandle(page, resizeHandle, 200);

      // Verify width is at minimum (200px)
      const newWidth = await aiPanel.evaluate(el => el.offsetWidth);
      expect(newWidth).toBeGreaterThanOrEqual(200);
    });

    test('should respect maximum AI panel width constraint', async ({ page }) => {
      const aiPanel = page.locator('#ai-panel');
      const resizeHandle = page.locator('.resize-handle[data-panel="ai-panel"]');

      // Drag the handle 400px to the left (way past maximum)
      await dragResizeHandle(page, resizeHandle, -400);

      // Verify width is at maximum (600px)
      const newWidth = await aiPanel.evaluate(el => el.offsetWidth);
      expect(newWidth).toBeLessThanOrEqual(600);
    });
  });

  test.describe('Visual Feedback', () => {
    test('should show col-resize cursor on resize handle hover', async ({ page }) => {
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');

      // Verify the CSS cursor property
      const cursor = await resizeHandle.evaluate(el => getComputedStyle(el).cursor);
      expect(cursor).toBe('col-resize');
    });

    test('should add resizing class to body during drag', async ({ page }) => {
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');
      const body = page.locator('body');

      // Get handle position
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).not.toBeNull();

      // Start drag
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();

      // Move a bit
      await page.mouse.move(handleBox.x + 10, handleBox.y + handleBox.height / 2);

      // Check for resizing class
      const hasResizingClass = await body.evaluate(el => el.classList.contains('resizing'));
      expect(hasResizingClass).toBe(true);

      // End drag
      await page.mouse.up();

      // Class should be removed
      const stillHasClass = await body.evaluate(el => el.classList.contains('resizing'));
      expect(stillHasClass).toBe(false);
    });
  });

  test.describe('Collapsed Panel Behavior', () => {
    test('should not resize when sidebar is collapsed', async ({ page }) => {
      const sidebar = page.locator('#files-sidebar');
      const collapseBtn = page.locator('#sidebar-collapse-btn');
      const resizeHandle = page.locator('.resize-handle[data-panel="sidebar"]');

      // Get handle position while sidebar is expanded
      const handleBoxExpanded = await resizeHandle.boundingBox();
      expect(handleBoxExpanded).not.toBeNull();

      // Collapse the sidebar
      await collapseBtn.click();
      await expect(sidebar).toHaveClass(/collapsed/);

      // Wait a moment for the collapse animation
      await page.waitForTimeout(100);

      // Try to drag where the handle was - should not cause any resize
      // because the JS code checks for collapsed class
      await page.mouse.move(handleBoxExpanded.x + handleBoxExpanded.width / 2, handleBoxExpanded.y + 100);
      await page.mouse.down();
      await page.mouse.move(handleBoxExpanded.x + 50, handleBoxExpanded.y + 100);
      await page.mouse.up();

      // Sidebar should still be collapsed (width 0)
      const sidebarWidth = await sidebar.evaluate(el => el.offsetWidth);
      expect(sidebarWidth).toBe(0);
    });
  });
});

test.describe('Panel Resize - Local Mode', () => {
  // Note: Full resize testing requires a local review to be set up.
  // These tests verify that the resize infrastructure is present in local.html.
  // The actual resize functionality is shared code tested in PR Mode above.

  test('should have resize handles in local mode HTML', async ({ page }) => {
    // Navigate to the local mode index page
    await page.goto('/local');
    await page.waitForLoadState('networkidle');

    // Check if there's a local review we can navigate to
    const reviewLink = page.locator('a[href^="/local/"]').first();
    if (await reviewLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Navigate to the review page
      await reviewLink.click();
      await page.waitForLoadState('networkidle');

      // Verify resize handles exist
      const sidebarHandle = page.locator('.resize-handle[data-panel="sidebar"]');
      const aiPanelHandle = page.locator('.resize-handle[data-panel="ai-panel"]');

      await expect(sidebarHandle).toBeVisible();
      await expect(aiPanelHandle).toBeVisible();

      // Verify PanelResizer is initialized (check that CSS variables can be read)
      const sidebarWidth = await page.evaluate(() => {
        return getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width');
      });
      expect(sidebarWidth).toBeTruthy();
    } else {
      // No local review exists - skip this test
      test.skip();
    }
  });

  test('should share localStorage between PR and local modes', async ({ page }) => {
    // Set a sidebar width in PR mode
    await page.goto('/pr/test-owner/test-repo/1');
    await page.waitForLoadState('networkidle');

    // Set a custom width via localStorage
    await page.evaluate(() => {
      localStorage.setItem('sidebar-width', '350');
    });

    // Navigate to local mode index
    await page.goto('/local');
    await page.waitForLoadState('networkidle');

    // Verify localStorage is shared (same origin)
    const savedWidth = await page.evaluate(() => {
      return localStorage.getItem('sidebar-width');
    });
    expect(savedWidth).toBe('350');
  });
});
