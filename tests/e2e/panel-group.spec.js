// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Panel Group Layout
 *
 * Tests the panel group layout feature including chat toggle,
 * popover layout picker, persistence, and panel coordination.
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

test.describe('Panel Group - PR Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await page.evaluate(() => {
      localStorage.removeItem('panel-group-layout');
      localStorage.removeItem('panel-group-chat-visible');
      localStorage.removeItem('chat-panel-width');
      localStorage.removeItem('panel-group-last-h');
      localStorage.removeItem('panel-group-last-v');
    });
    await page.reload();
    await waitForDiffToRender(page);
  });

  test('should have right-panel-group containing AI panel', async ({ page }) => {
    const group = page.locator('#right-panel-group');
    await expect(group).toBeVisible();
    const aiPanel = group.locator('#ai-panel');
    await expect(aiPanel).toBeVisible();
  });

  test('should have chat-panel-container inside right-panel-group', async ({ page }) => {
    const group = page.locator('#right-panel-group');
    const chatContainer = group.locator('#chat-panel-container');
    await expect(chatContainer).toBeAttached();
  });

  test('chat button toggles chat panel visibility', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const chatPanel = page.locator('.chat-panel');
    const chatCloseBtn = page.locator('.chat-panel__close-btn');

    // Chat panel should be hidden initially
    await expect(chatPanel).not.toBeVisible();

    // Click chat button to open
    await chatBtn.click();
    await expect(chatPanel).toBeVisible();

    // Toggle button is hidden when chat is open; use close button instead
    await chatCloseBtn.click();
    await expect(chatPanel).not.toBeVisible();
  });

  test('chat button shows active state when chat is open', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const chatCloseBtn = page.locator('.chat-panel__close-btn');

    // Should not be active initially
    await expect(chatBtn).not.toHaveClass(/active/);

    // Open chat
    await chatBtn.click();
    await expect(chatBtn).toHaveClass(/active/);

    // Toggle button is hidden when chat is open; use close button instead
    await chatCloseBtn.click();
    await expect(chatBtn).not.toHaveClass(/active/);
  });

  test('layout toggle button hidden when only review panel visible', async ({ page }) => {
    const layoutBtn = page.locator('#panel-layout-toggle');
    // Only review panel is visible, layout toggle should be hidden
    await expect(layoutBtn).not.toBeVisible();
  });

  test('layout toggle button visible when both panels are open', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const layoutBtn = page.locator('#panel-layout-toggle');

    // Open chat panel
    await chatBtn.click();

    // Layout toggle should now be visible
    await expect(layoutBtn).toBeVisible();
  });

  test('popover opens on layout toggle click and selects layout', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const layoutBtn = page.locator('#panel-layout-toggle');
    const group = page.locator('#right-panel-group');
    const popover = page.locator('#layout-popover');

    // Open chat panel
    await chatBtn.click();
    await expect(layoutBtn).toBeVisible();

    // Default layout should be h-review-chat
    await expect(group).toHaveClass(/layout-h-review-chat/);

    // Click layout toggle to open popover
    await layoutBtn.click();
    await expect(popover).toHaveClass(/layout-popover--visible/);

    // Verify 4 thumbnail buttons exist
    const thumbs = popover.locator('.layout-popover__thumb');
    await expect(thumbs).toHaveCount(4);

    // First thumb should be active (h-review-chat)
    await expect(thumbs.nth(0)).toHaveClass(/layout-popover__thumb--active/);

    // Click the second thumbnail (h-chat-review)
    await thumbs.nth(1).click();
    await expect(group).toHaveClass(/layout-h-chat-review/);

    // Popover should close after selection
    await expect(popover).not.toHaveClass(/layout-popover--visible/);
  });

  test('popover selects all four layouts correctly', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const layoutBtn = page.locator('#panel-layout-toggle');
    const group = page.locator('#right-panel-group');
    const popover = page.locator('#layout-popover');

    // Open chat panel
    await chatBtn.click();

    // Test each layout via popover
    const expectedLayouts = ['h-review-chat', 'h-chat-review', 'v-review-chat', 'v-chat-review'];

    for (let i = 0; i < expectedLayouts.length; i++) {
      await layoutBtn.click();
      await expect(popover).toHaveClass(/layout-popover--visible/);

      const thumbs = popover.locator('.layout-popover__thumb');
      await thumbs.nth(i).click();
      await expect(group).toHaveClass(new RegExp(`layout-${expectedLayouts[i]}`));
      await expect(popover).not.toHaveClass(/layout-popover--visible/);
    }
  });

  test('popover closes on click outside', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const layoutBtn = page.locator('#panel-layout-toggle');
    const popover = page.locator('#layout-popover');

    // Open chat panel and popover
    await chatBtn.click();
    await layoutBtn.click();
    await expect(popover).toHaveClass(/layout-popover--visible/);

    // Click outside the popover
    await page.locator('#diff-container').click();
    await expect(popover).not.toHaveClass(/layout-popover--visible/);
  });

  test('layout persists on reload', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const layoutBtn = page.locator('#panel-layout-toggle');
    const group = page.locator('#right-panel-group');
    const popover = page.locator('#layout-popover');

    // Open chat and select h-chat-review via popover
    await chatBtn.click();
    await layoutBtn.click();
    await expect(popover).toHaveClass(/layout-popover--visible/);
    await popover.locator('.layout-popover__thumb').nth(1).click();
    await expect(group).toHaveClass(/layout-h-chat-review/);

    // Reload
    await page.reload();
    await waitForDiffToRender(page);

    // Layout should persist (group element keeps the class)
    const groupAfter = page.locator('#right-panel-group');
    await expect(groupAfter).toHaveClass(/layout-h-chat-review/);
  });

  test('both panels hidden: group collapses', async ({ page }) => {
    const group = page.locator('#right-panel-group');
    const aiPanelClose = page.locator('#ai-panel-close');

    // Close the AI panel
    await aiPanelClose.click();

    // Chat is not open, AI is closed — group should be collapsed
    await expect(group).toHaveClass(/group-collapsed/);
  });

  test('group not collapsed when at least one panel is visible', async ({ page }) => {
    const group = page.locator('#right-panel-group');

    // AI panel is visible by default, group should not be collapsed
    await expect(group).not.toHaveClass(/group-collapsed/);
  });

  test('chat panel visibility persists on reload', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const chatPanel = page.locator('.chat-panel');

    // Open chat
    await chatBtn.click();
    await expect(chatPanel).toBeVisible();

    // Reload
    await page.reload();
    await waitForDiffToRender(page);

    // Chat should still be visible
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expect(page.locator('#chat-toggle-btn')).toHaveClass(/active/);
  });
});

test.describe('Panel Group - Local Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/local/2');
    await page.evaluate(() => {
      localStorage.removeItem('panel-group-layout');
      localStorage.removeItem('panel-group-chat-visible');
      localStorage.removeItem('chat-panel-width');
      localStorage.removeItem('panel-group-last-h');
      localStorage.removeItem('panel-group-last-v');
    });
    await page.reload();
    await waitForDiffToRender(page);
  });

  test('should have right-panel-group containing AI panel', async ({ page }) => {
    const group = page.locator('#right-panel-group');
    await expect(group).toBeVisible();
    const aiPanel = group.locator('#ai-panel');
    await expect(aiPanel).toBeVisible();
  });

  test('chat button toggles chat panel visibility', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const chatPanel = page.locator('.chat-panel');
    const chatCloseBtn = page.locator('.chat-panel__close-btn');

    // Chat panel should be hidden initially
    await expect(chatPanel).not.toBeVisible();

    // Click chat button to open
    await chatBtn.click();
    await expect(chatPanel).toBeVisible();

    // Toggle button is hidden when chat is open; use close button instead
    await chatCloseBtn.click();
    await expect(chatPanel).not.toBeVisible();
  });

  test('popover opens and selects layouts in local mode', async ({ page }) => {
    const chatBtn = page.locator('#chat-toggle-btn');
    const layoutBtn = page.locator('#panel-layout-toggle');
    const group = page.locator('#right-panel-group');
    const popover = page.locator('#layout-popover');

    // Open chat panel
    await chatBtn.click();
    await expect(layoutBtn).toBeVisible();

    // Default layout should be h-review-chat
    await expect(group).toHaveClass(/layout-h-review-chat/);

    // Open popover and select h-chat-review
    await layoutBtn.click();
    await expect(popover).toHaveClass(/layout-popover--visible/);
    await popover.locator('.layout-popover__thumb').nth(1).click();
    await expect(group).toHaveClass(/layout-h-chat-review/);

    // Open popover and select v-review-chat
    await layoutBtn.click();
    await popover.locator('.layout-popover__thumb').nth(2).click();
    await expect(group).toHaveClass(/layout-v-review-chat/);

    // Open popover and select v-chat-review
    await layoutBtn.click();
    await popover.locator('.layout-popover__thumb').nth(3).click();
    await expect(group).toHaveClass(/layout-v-chat-review/);

    // Open popover and select back to h-review-chat
    await layoutBtn.click();
    await popover.locator('.layout-popover__thumb').nth(0).click();
    await expect(group).toHaveClass(/layout-h-review-chat/);
  });
});
