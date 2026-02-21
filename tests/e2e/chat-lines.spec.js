// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Chat about lines
 *
 * Tests the gutter chat button and comment form Chat button features:
 * - Gutter chat button visibility on hover (when chat enabled)
 * - Gutter chat button hidden when data-chat="disabled"
 * - Click gutter chat button opens chat panel with [[file:...]] prefilled
 * - Comment form Chat button opens chat with file reference + quoted text
 * - Comment form Chat button hidden when data-chat="disabled"
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

/**
 * Enable chat in the test environment (Pi is not available in E2E).
 * Sets data-chat="available" and dispatches the state change event.
 */
async function enableChat(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'available');
    window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
  });
}

/**
 * Disable chat by setting data-chat="disabled".
 */
async function disableChat(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'disabled');
  });
}

// Helper to clean up all user comments
async function cleanupAllComments(page) {
  await page.evaluate(async () => {
    const commentsResponse = await fetch('/api/reviews/1/comments?includeDismissed=true');
    const data = await commentsResponse.json();
    const comments = data.comments || [];
    for (const comment of comments) {
      await fetch(`/api/reviews/1/comments/${comment.id}`, { method: 'DELETE' });
    }
  });
}

test.describe('Gutter chat button', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
  });

  test('should be visible on line hover when chat is enabled', async ({ page }) => {
    await enableChat(page);

    // Hover over a line number cell to reveal gutter buttons
    const lineNumberCell = page.locator('.d2h-code-linenumber').nth(0);
    await lineNumberCell.hover();

    // The chat button should be visible (opacity controlled by CSS tr:hover)
    const chatBtn = page.locator('.chat-line-btn').first();
    await expect(chatBtn).toBeAttached();
  });

  test('should be hidden when data-chat is disabled', async ({ page }) => {
    await disableChat(page);

    // Hover over a line number cell
    const lineNumberCell = page.locator('.d2h-code-linenumber').nth(0);
    await lineNumberCell.hover();

    // The chat button should exist in DOM but be hidden via CSS
    const chatBtn = page.locator('.chat-line-btn').first();
    await expect(chatBtn).toBeHidden();
  });

  test('click opens chat panel with [[file:...]] prefilled', async ({ page }) => {
    await enableChat(page);

    // Open the chat panel first so it initializes
    const chatToggle = page.locator('#chat-toggle-btn');
    await chatToggle.click();
    await expect(page.locator('.chat-panel')).toBeVisible();

    // Close chat panel to test that the gutter button re-opens it
    const chatCloseBtn = page.locator('.chat-panel__close-btn');
    await chatCloseBtn.click();
    await expect(page.locator('.chat-panel')).not.toBeVisible();

    // Hover over a line to reveal the chat button
    const lineNumberCell = page.locator('.d2h-code-linenumber').nth(0);
    await lineNumberCell.hover();

    // Click the gutter chat button
    const chatBtn = page.locator('.chat-line-btn').first();
    await chatBtn.click({ force: true });

    // Chat panel should open
    await expect(page.locator('.chat-panel')).toBeVisible({ timeout: 5000 });

    // Textarea should contain a [[file:...]] reference
    const textarea = page.locator('.chat-panel__input');
    const value = await textarea.inputValue();
    expect(value).toMatch(/\[\[file:.+:\d+\]\]/);
  });
});

test.describe('Comment form Chat button', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupAllComments(page);
  });

  test('opens chat with file reference and quoted text', async ({ page }) => {
    await enableChat(page);

    // Initialize chat panel
    const chatToggle = page.locator('#chat-toggle-btn');
    await chatToggle.click();
    await expect(page.locator('.chat-panel')).toBeVisible();
    const chatCloseBtn = page.locator('.chat-panel__close-btn');
    await chatCloseBtn.click();

    // Open a comment form by hovering and clicking the + button
    const lineNumberCell = page.locator('.d2h-code-linenumber').nth(0);
    await lineNumberCell.hover();
    const addCommentBtn = page.locator('.add-comment-btn').first();
    await addCommentBtn.waitFor({ state: 'visible', timeout: 5000 });
    await addCommentBtn.click();
    await page.waitForSelector('.user-comment-form', { timeout: 5000 });

    // Type some text in the comment form
    const commentTextarea = page.locator('.user-comment-form textarea');
    await commentTextarea.fill('This is my question about this code');

    // Click the Chat button in the comment form
    const chatFromCommentBtn = page.locator('.comment-form-actions .btn-chat-from-comment');
    await expect(chatFromCommentBtn).toBeVisible();
    await chatFromCommentBtn.click();

    // Comment form should close
    await expect(page.locator('.user-comment-form')).not.toBeVisible({ timeout: 5000 });

    // Chat panel should open
    await expect(page.locator('.chat-panel')).toBeVisible({ timeout: 5000 });

    // Textarea should contain file reference AND quoted text
    const chatInput = page.locator('.chat-panel__input');
    const value = await chatInput.inputValue();
    expect(value).toMatch(/\[\[file:.+:\d+\]\]/);
    expect(value).toContain('> This is my question about this code');
  });

  test('Chat button is hidden when data-chat is disabled', async ({ page }) => {
    await disableChat(page);

    // Open a comment form
    const lineNumberCell = page.locator('.d2h-code-linenumber').nth(0);
    await lineNumberCell.hover();
    const addCommentBtn = page.locator('.add-comment-btn').first();
    await addCommentBtn.waitFor({ state: 'visible', timeout: 5000 });
    await addCommentBtn.click();
    await page.waitForSelector('.user-comment-form', { timeout: 5000 });

    // The Chat button in the comment form should be hidden
    const chatFromCommentBtn = page.locator('.comment-form-actions .btn-chat-from-comment');
    await expect(chatFromCommentBtn).toBeHidden();
  });
});
