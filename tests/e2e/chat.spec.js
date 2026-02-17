// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Chat with AI Feature
 *
 * Tests the chat panel functionality including:
 * - Opening chat from AI suggestions
 * - Sending messages and receiving streamed responses
 * - Chat context card display
 * - Adopt with AI edits button
 * - Chat history indicator dots
 * - Chat panel open/close
 *
 * The test server is started via global-setup.js with pre-seeded test data
 * and a mocked AI provider that returns canned responses.
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

// Helper to pre-seed AI suggestions (same as ai-analysis.spec.js)
async function seedAISuggestions(page) {
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
    { timeout: 5000 }
  );

  // Reload suggestions
  await page.evaluate(async () => {
    if (window.prManager?.loadAISuggestions) {
      await window.prManager.loadAISuggestions();
    }
  });

  // Wait for at least one AI suggestion to render
  await page.waitForSelector('.ai-suggestion', { timeout: 5000 });
}

// Helper to open chat panel from the first AI suggestion
async function openChatFromSuggestion(page) {
  const chatBtn = page.locator('.ai-action-chat').first();
  await chatBtn.waitFor({ state: 'visible', timeout: 5000 });
  // Wait for any layout animations to settle before clicking
  await page.waitForTimeout(300);
  await chatBtn.click();

  // Wait for chat panel to expand
  await expect(page.locator('#chat-panel.expanded')).toBeVisible({ timeout: 5000 });
}

test.describe('Chat Panel Opening', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await seedAISuggestions(page);
  });

  test('should show chat button on AI suggestions', async ({ page }) => {
    // AI suggestions should have a chat button
    const chatBtn = page.locator('.ai-action-chat').first();
    await expect(chatBtn).toBeVisible();
  });

  test('should open chat panel when clicking chat button on suggestion', async ({ page }) => {
    // Chat panel should not be expanded initially (may not exist in DOM yet)
    const chatPanel = page.locator('#chat-panel.expanded');
    await expect(chatPanel).toHaveCount(0);

    // Click chat button on first suggestion
    await openChatFromSuggestion(page);

    // Panel should now be expanded
    await expect(page.locator('#chat-panel')).toHaveClass(/expanded/);

    // Body should have chat-panel-open class for layout shift
    await expect(page.locator('body')).toHaveClass(/chat-panel-open/);
  });

  test('should close chat panel when clicking close button', async ({ page }) => {
    await openChatFromSuggestion(page);

    // Panel should be open
    await expect(page.locator('#chat-panel.expanded')).toBeVisible();

    // Click close button
    await page.locator('.chat-close-btn').click();

    // Panel should be collapsed
    await expect(page.locator('#chat-panel')).not.toHaveClass(/expanded/);
  });

  test('should display context card with suggestion info', async ({ page }) => {
    await openChatFromSuggestion(page);

    // Context card should show file path
    const filePath = page.locator('.chat-context-file-path');
    await expect(filePath).toBeVisible();
    await expect(filePath).toContainText('src/');

    // Context card should show line badge
    const lineBadge = page.locator('.chat-context-line-badge');
    await expect(lineBadge).toBeVisible();
    await expect(lineBadge).toContainText(/L\d+/);

    // Context card should show type badge
    const typeBadge = page.locator('.chat-context-badge');
    await expect(typeBadge).toBeVisible();

    // Context card should show source
    const source = page.locator('.chat-context-source');
    await expect(source).toBeVisible();
  });
});

test.describe('Chat Messaging', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await seedAISuggestions(page);
    await openChatFromSuggestion(page);
  });

  test('should have message input and send button', async ({ page }) => {
    const input = page.locator('.chat-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', /Ask a follow-up/i);

    const sendBtn = page.locator('.chat-send-btn');
    await expect(sendBtn).toBeVisible();
  });

  test('should send a message and receive AI response', async ({ page }) => {
    // Type a message
    const input = page.locator('.chat-input');
    await input.fill('Can you explain this issue in more detail?');

    // Set up response listener for the POST message endpoint
    const messageResponsePromise = page.waitForResponse(
      response => response.url().includes('/message') && response.request().method() === 'POST',
      { timeout: 15000 }
    );

    // Click send
    await page.locator('.chat-send-btn').click();

    // User message should appear
    const userMessage = page.locator('.chat-message.user');
    await expect(userMessage.first()).toBeVisible({ timeout: 5000 });
    await expect(userMessage.first().locator('.chat-message-content')).toContainText('Can you explain');

    // Wait for the POST response (AI processing complete)
    await messageResponsePromise;

    // AI response should appear (streamed via SSE, then finalized)
    const assistantMessage = page.locator('.chat-message.assistant');
    await expect(assistantMessage.first()).toBeVisible({ timeout: 10000 });

    // Response should contain the mock AI text
    await expect(assistantMessage.first().locator('.chat-message-content')).toContainText('mock AI response', { timeout: 10000 });
  });

  test('should send message with Cmd+Enter keyboard shortcut', async ({ page }) => {
    const input = page.locator('.chat-input');
    await input.fill('Keyboard shortcut test');

    // Set up response listener
    const messageResponsePromise = page.waitForResponse(
      response => response.url().includes('/message') && response.request().method() === 'POST',
      { timeout: 15000 }
    );

    // Use keyboard shortcut
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await input.press(`${modifier}+Enter`);

    // User message should appear
    const userMessage = page.locator('.chat-message.user');
    await expect(userMessage.first()).toBeVisible({ timeout: 5000 });

    // Wait for AI response
    await messageResponsePromise;

    const assistantMessage = page.locator('.chat-message.assistant');
    await expect(assistantMessage.first()).toBeVisible({ timeout: 10000 });
  });

  test('should disable send button while message is being sent', async ({ page }) => {
    const input = page.locator('.chat-input');
    await input.fill('Test disabled state');

    // Click send and immediately check button state
    await page.locator('.chat-send-btn').click();

    // Button should be disabled while processing
    const sendBtn = page.locator('.chat-send-btn');
    // The button text changes to "Sending..." or "Thinking..." while disabled
    await expect(sendBtn).toBeDisabled({ timeout: 2000 });

    // Wait for response to complete
    const assistantMessage = page.locator('.chat-message.assistant');
    await expect(assistantMessage.first()).toBeVisible({ timeout: 15000 });

    // Button should be re-enabled after response
    await expect(sendBtn).toBeEnabled({ timeout: 5000 });
  });

  test('should clear input after sending message', async ({ page }) => {
    const input = page.locator('.chat-input');
    await input.fill('Message to be cleared');

    await page.locator('.chat-send-btn').click();

    // Input should be cleared after sending
    await expect(input).toHaveValue('', { timeout: 5000 });
  });
});

test.describe('Adopt with AI Edits', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await seedAISuggestions(page);
    await openChatFromSuggestion(page);
  });

  test('should show adopt button in chat actions', async ({ page }) => {
    // The adopt button should exist (may be hidden until conversation has messages)
    const adoptBtn = page.locator('.chat-adopt-btn');
    const count = await adoptBtn.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should enable adopt button after a chat message exchange', async ({ page }) => {
    // Send a message first
    const input = page.locator('.chat-input');
    await input.fill('What do you suggest for fixing this?');

    const messageResponsePromise = page.waitForResponse(
      response => response.url().includes('/message') && response.request().method() === 'POST',
      { timeout: 15000 }
    );

    await page.locator('.chat-send-btn').click();
    await messageResponsePromise;

    // Wait for AI response to appear
    const assistantMessage = page.locator('.chat-message.assistant');
    await expect(assistantMessage.first()).toBeVisible({ timeout: 10000 });

    // Adopt button should now be visible in the actions bar
    const adoptBtn = page.locator('.chat-adopt-btn');
    await expect(adoptBtn).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Chat History Indicators', () => {
  test('should show chat history indicator after chatting with a suggestion', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await seedAISuggestions(page);

    // Open chat and send a message to create history
    await openChatFromSuggestion(page);

    const input = page.locator('.chat-input');
    await input.fill('Test chat history indicator');

    const messageResponsePromise = page.waitForResponse(
      response => response.url().includes('/message') && response.request().method() === 'POST',
      { timeout: 15000 }
    );

    await page.locator('.chat-send-btn').click();
    await messageResponsePromise;

    // Wait for AI response
    const assistantMessage = page.locator('.chat-message.assistant');
    await expect(assistantMessage.first()).toBeVisible({ timeout: 10000 });

    // Close the chat panel
    await page.locator('.chat-close-btn').click();
    await expect(page.locator('#chat-panel')).not.toHaveClass(/expanded/);

    // Reload the page to trigger loadChatIndicators
    await page.reload();
    await waitForDiffToRender(page);

    // Reload suggestions
    await page.evaluate(async () => {
      if (window.prManager?.loadAISuggestions) {
        await window.prManager.loadAISuggestions();
      }
    });
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // At least one chat button should have the has-chat-history class (blue dot indicator)
    const chatBtnsWithHistory = page.locator('.has-chat-history');
    await expect(chatBtnsWithHistory.first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Chat Panel UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await seedAISuggestions(page);
  });

  test('should show chat header with suggestion title', async ({ page }) => {
    await openChatFromSuggestion(page);

    const headerTitle = page.locator('.chat-header-title');
    await expect(headerTitle).toBeVisible();
    // The header shows the suggestion/comment title, not "Chat"
    const text = await headerTitle.textContent();
    expect(text.length).toBeGreaterThan(0);
  });

  test('should show keyboard shortcut hint', async ({ page }) => {
    await openChatFromSuggestion(page);

    const hint = page.locator('.chat-input-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Enter');
  });

  test('should have messages container', async ({ page }) => {
    await openChatFromSuggestion(page);

    const messagesContainer = page.locator('.chat-messages');
    await expect(messagesContainer).toBeVisible();
  });
});
