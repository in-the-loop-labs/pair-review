// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Chat multi-tab support
 *
 * Phase 1/2 introduced multi-tab chat sessions. Three flows we want to lock
 * down end-to-end (UI-level — message streaming uses a real bridge, which is
 * mocked out in E2E):
 *
 *   1. Open multiple tabs from the "+" button; close them with "x".
 *   2. Persistence across page reload — open tabs are restored, focus is
 *      restored, and the persisted localStorage entry uses the documented
 *      shape.
 *   3. History dropdown marks open sessions with --open and clicking an
 *      open-elsewhere entry focuses the existing tab rather than swapping.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

/**
 * Force chat into "available" state so the toggle button is interactive.
 * Pi isn't installed in the E2E environment, so we need to bypass the
 * data-chat availability gate.
 */
async function enableChat(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'available');
    window.__pairReview = window.__pairReview || {};
    // Provide a single available provider so the "+" / new-tab path can
    // POST to /api/chat/session without 400'ing on missing provider.
    window.__pairReview.chatProvider = 'pi';
    window.__pairReview.chatProviders = [
      { id: 'pi', name: 'Pi', type: 'pi', available: true },
    ];
    window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
  });
}

test.describe('Chat multi-tab UI', () => {
  test.beforeEach(async ({ page }) => {
    // Wipe persisted chat tab state BEFORE booting the chat panel. We use a
    // bounce-through-the-origin-root pattern: index.html doesn't include
    // ChatPanel, so we can safely touch localStorage there without racing the
    // panel's restore logic. Wiping after the real /pr goto would race with
    // the panel boot reading localStorage on DOMContentLoaded.
    await page.goto('/');
    await page.evaluate(() => {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('pair-review:chat-tabs:'))
          .forEach((k) => localStorage.removeItem(k));
      } catch { /* noop */ }
    });
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await enableChat(page);
  });

  test('opens a new tab via the + button and closes it via x', async ({ page }) => {
    // Open the chat panel — restores existing session 1 as the first tab.
    await page.locator('#chat-toggle-btn').click();
    await expect(page.locator('.chat-panel')).toBeVisible();

    // Wait for the initial tab (loaded from the seeded session 1) to render.
    const tabs = page.locator('.chat-panel__tab');
    await expect(tabs).toHaveCount(1, { timeout: 5000 });

    // Click "+" to open a second tab.
    await page.locator('.chat-panel__tab-new-btn').click();
    await expect(tabs).toHaveCount(2, { timeout: 5000 });

    // The newest tab is focused (rightmost active).
    await expect(tabs.last()).toHaveClass(/chat-panel__tab--active/);

    // Close the focused tab. The previously-active tab becomes active.
    await tabs.last().locator('.chat-panel__tab-close').click();
    await expect(tabs).toHaveCount(1, { timeout: 5000 });

    // Close the remaining tab. Empty state should appear.
    await tabs.first().locator('.chat-panel__tab-close').click();
    await expect(tabs).toHaveCount(0);
    await expect(page.locator('.chat-panel__empty--no-tabs')).toBeVisible();
  });

  test('persists open tabs and focus across a page reload', async ({ page }) => {
    await page.locator('#chat-toggle-btn').click();
    await expect(page.locator('.chat-panel')).toBeVisible();

    const tabs = page.locator('.chat-panel__tab');
    await expect(tabs).toHaveCount(1, { timeout: 5000 });

    // Open a second tab so there are at least two distinct sessions to persist.
    await page.locator('.chat-panel__tab-new-btn').click();
    await expect(tabs).toHaveCount(2, { timeout: 5000 });

    // Sessions are lazily created on first message — send one in the active
    // (second) tab so its sessionId materializes and persistence kicks in.
    await page.locator('.chat-panel__input').fill('hello from tab 2');
    await page.locator('.chat-panel__send-btn').click();
    await expect.poll(async () => {
      return page.evaluate(() => {
        if (!window.chatPanel) return null;
        return window.chatPanel.tabs.every(t => t.sessionId != null);
      });
    }, { timeout: 5000 }).toBe(true);

    // Poll for the persisted entry to materialise with the expected shape
    // rather than sleeping. The persistence write is debounced 100ms.
    await expect.poll(async () => {
      return page.evaluate(() => {
        const raw = localStorage.getItem('pair-review:chat-tabs:1');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
      });
    }, { timeout: 5000 }).toMatchObject({
      version: 1,
      tabs: expect.any(Array),
      activeSessionId: expect.any(Number),
    });

    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem('pair-review:chat-tabs:1');
      return raw ? JSON.parse(raw) : null;
    });
    expect(persisted.tabs.length).toBe(2);
    expect(typeof persisted.activeSessionId).toBe('number');

    // The active (right-most) tab should be the second session.
    const activeBefore = persisted.activeSessionId;

    // Reload — the chat panel should restore the persisted tabs/focus.
    await page.reload();
    await waitForDiffToRender(page);
    await enableChat(page);
    // The panel may already be open via PanelGroup restoration. If not, click
    // the toggle. Either way, .chat-panel should be visible afterward.
    const panel = page.locator('.chat-panel');
    if (!(await panel.isVisible())) {
      const toggle = page.locator('#chat-toggle-btn');
      // Wait until the toggle is interactive.
      await toggle.waitFor({ state: 'visible', timeout: 5000 });
      await toggle.click();
    }
    await expect(panel).toBeVisible();

    const tabsAfter = page.locator('.chat-panel__tab');
    await expect(tabsAfter).toHaveCount(2, { timeout: 5000 });

    // Verify the same activeSessionId is still in localStorage (the restore
    // path rewrites the entry to prune stale ids — confirm shape is preserved).
    const persistedAfter = await page.evaluate(() => {
      const raw = localStorage.getItem('pair-review:chat-tabs:1');
      return raw ? JSON.parse(raw) : null;
    });
    expect(persistedAfter).not.toBeNull();
    expect(persistedAfter.tabs).toEqual(persisted.tabs);
    expect(persistedAfter.activeSessionId).toBe(activeBefore);
  });

  test('history dropdown marks open sessions and clicking one focuses the existing tab', async ({ page }) => {
    await page.locator('#chat-toggle-btn').click();
    await expect(page.locator('.chat-panel')).toBeVisible();

    const tabs = page.locator('.chat-panel__tab');
    await expect(tabs).toHaveCount(1, { timeout: 5000 });

    // Open a second tab so two sessions show up as "open" in the history.
    await page.locator('.chat-panel__tab-new-btn').click();
    await expect(tabs).toHaveCount(2, { timeout: 5000 });

    // Sessions are lazy now — send a message so the new tab gets its sessionId
    // and history dropdown can mark it as "open". The first tab inherits its
    // sessionId from the seeded MRU session.
    await page.locator('.chat-panel__input').fill('seed second session');
    await page.locator('.chat-panel__send-btn').click();
    await expect.poll(async () => {
      return page.evaluate(() => {
        if (!window.chatPanel) return null;
        return window.chatPanel.tabs.every(t => t.sessionId != null);
      });
    }, { timeout: 5000 }).toBe(true);

    // Open the history dropdown.
    await page.locator('.chat-panel__history-btn').click();
    const dropdown = page.locator('.chat-panel__session-dropdown');
    await expect(dropdown).toBeVisible();

    // Both rows show the "open" tag.
    const openTags = dropdown.locator('.chat-panel__session-open-tag');
    await expect(openTags).toHaveCount(2);

    // Capture the session id of the row we're about to click so we can assert
    // that the matching tab becomes active (rather than asserting on a count).
    const openElsewhere = dropdown.locator('.chat-panel__session-item--open').first();
    const targetSessionId = await openElsewhere.getAttribute('data-session-id');
    expect(targetSessionId).toBeTruthy();

    await openElsewhere.click();

    // Tab count is unchanged — focus simply swapped.
    await expect(tabs).toHaveCount(2);
    // The tab with the clicked session id is now active.
    await expect(
      page.locator(`.chat-panel__tab[data-session-id="${targetSessionId}"]`)
    ).toHaveClass(/chat-panel__tab--active/);
  });

  test('messages sent in one tab do not appear in another', async ({ page }) => {
    await page.locator('#chat-toggle-btn').click();
    await expect(page.locator('.chat-panel')).toBeVisible();

    const tabs = page.locator('.chat-panel__tab');
    await expect(tabs).toHaveCount(1, { timeout: 5000 });

    // Tab 1 is the restored MRU session — its sessionId is already populated.
    // Focus tab A (index 0) and send its message first.
    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/chat-panel__tab--active/);

    await page.locator('.chat-panel__input').fill('message for tab A');
    await page.locator('.chat-panel__send-btn').click();

    // Open the second tab AFTER tab A has its content — that way both tabs
    // get their sessionId before we cross-check.
    await page.locator('.chat-panel__tab-new-btn').click();
    await expect(tabs).toHaveCount(2, { timeout: 5000 });

    // Wait for tab A (index 0) to contain its user message.
    await expect.poll(async () => {
      return page.evaluate(() => {
        const tab = window.chatPanel.tabs[0];
        return tab ? tab.messages.map(m => m.content) : [];
      });
    }, { timeout: 5000 }).toContain('message for tab A');

    // Switch to tab B (index 1) and send a different message. Tab B has no
    // sessionId until it sends its first message, so click by position.
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveClass(/chat-panel__tab--active/);

    await page.locator('.chat-panel__input').fill('message for tab B');
    await page.locator('.chat-panel__send-btn').click();

    await expect.poll(async () => {
      return page.evaluate(() => {
        const tab = window.chatPanel.tabs[1];
        return tab ? tab.messages.map(m => m.content) : [];
      });
    }, { timeout: 5000 }).toContain('message for tab B');

    // Both tabs now have sessionIds — wait for the second one to materialize.
    await expect.poll(async () => {
      return page.evaluate(() => window.chatPanel.tabs.every(t => t.sessionId != null));
    }, { timeout: 5000 }).toBe(true);

    // Tab A still has only its own message — no cross-tab bleed (in-memory).
    const aContents = await page.evaluate(() => {
      const tab = window.chatPanel.tabs[0];
      return tab ? tab.messages.map(m => m.content) : [];
    });
    expect(aContents).toContain('message for tab A');
    expect(aContents).not.toContain('message for tab B');

    // DOM assertion: the per-tab messages container for tab A contains its
    // own message, not tab B's. Each per-tab container carries data-tab-key
    // matching the tab's sessionId once a session is bound.
    const tabAKey = await page.evaluate(() => window.chatPanel.tabs[0].sessionId);
    const tabBKey = await page.evaluate(() => window.chatPanel.tabs[1].sessionId);
    const tabAMessagesEl = page.locator(`.chat-panel__messages[data-tab-key="${tabAKey}"]`);
    const tabBMessagesEl = page.locator(`.chat-panel__messages[data-tab-key="${tabBKey}"]`);
    await expect(tabAMessagesEl).toContainText('message for tab A');
    // Tab A's container must NOT contain tab B's message text.
    await expect(tabAMessagesEl).not.toContainText('message for tab B');
    // Tab B's container must contain tab B's message text.
    await expect(tabBMessagesEl).toContainText('message for tab B');

    // Switch back to tab A and verify the active container contains tab A's
    // message text. We don't constrain to "first" because tests share a DB
    // across the worker and tab A's session may already have older messages
    // from prior tests in the suite.
    await page.locator(`.chat-panel__tab[data-session-id="${tabAKey}"]`).click();
    await expect(tabs.first()).toHaveClass(/chat-panel__tab--active/);
    const activeContainer = page.locator('.chat-panel__messages:not([style*="display: none"])');
    await expect(activeContainer).toContainText('message for tab A');
    // And the active container must NOT contain tab B's content.
    await expect(activeContainer).not.toContainText('message for tab B');
  });
});
