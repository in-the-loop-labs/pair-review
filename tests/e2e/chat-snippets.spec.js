// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Chat prompt snippets
 *
 * The prompt-snippets feature adds a reusable-prompt library, insertable from a
 * new button in the chat input (to the left of send), plus a shared editor
 * reachable from the picker's gear AND the global settings page. Flows locked
 * down here:
 *
 *   1. Picker button renders left of send; empty state offers a "Manage" way in.
 *   2. Gear opens the manage modal; adding a snippet makes it appear in the
 *      picker dropdown.
 *   3. Clicking a snippet inserts its body into the input and enables send
 *      (WITHOUT sending — plain click never submits).
 *   4. Inserting a snippet touches its MRU timestamp so it sorts first on reopen.
 *   5. The core insert flow works in BOTH PR mode and local mode (ChatPanel is a
 *      single shared component, but parity is verified end-to-end).
 *   6. The settings page exposes a "Chat Snippets" section + nav item with a
 *      full add/edit/delete round-trip in the inline editor.
 *
 * Snippets are stored globally in the per-worker E2E DB, which is shared across
 * tests in a worker. Only this spec touches /api/snippets, so each test wipes
 * the table first (clearSnippets) to stay isolated and order-independent.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

/**
 * Force chat into "available" state so the toggle button is interactive. Pi
 * isn't installed in E2E, so we bypass the data-chat availability gate — same
 * shim used by chat-tabs.spec.js.
 */
async function enableChat(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'available');
    window.__pairReview = window.__pairReview || {};
    window.__pairReview.chatProvider = 'pi';
    window.__pairReview.chatProviders = [
      { id: 'pi', name: 'Pi', type: 'pi', available: true },
    ];
    window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
  });
}

/** Delete every snippet so a test starts from a known-empty library. */
async function clearSnippets(page) {
  const res = await page.request.get('/api/snippets');
  if (!res.ok()) return;
  const data = await res.json();
  for (const s of (data.snippets || [])) {
    await page.request.delete(`/api/snippets/${s.id}`);
  }
}

/** Create a snippet via the API and return its id. */
async function seedSnippet(page, body) {
  const res = await page.request.post('/api/snippets', { data: { body } });
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  return data.snippet.id;
}

/** Open the chat panel via its toggle and wait for it to be visible. */
async function openChatPanel(page) {
  await page.locator('#chat-toggle-btn').click();
  await expect(page.locator('.chat-panel')).toBeVisible();
}

/** Open the snippet picker dropdown and wait for it to render. */
async function openSnippetDropdown(page) {
  await page.locator('.chat-panel__snippet-picker-btn').click();
  await expect(page.locator('.chat-panel__snippet-dropdown')).toBeVisible();
}

// ─── PR mode ──────────────────────────────────────────────────────────────

test.describe('Chat prompt snippets (PR mode)', () => {
  test.beforeEach(async ({ page }) => {
    // Wipe persisted chat-tab state before booting the panel (bounce through the
    // origin root, which doesn't mount ChatPanel) — same pattern as chat-tabs.
    await page.goto('/');
    await page.evaluate(() => {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('pair-review:chat-tabs:'))
          .forEach((k) => localStorage.removeItem(k));
      } catch { /* noop */ }
    });
    await clearSnippets(page);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await enableChat(page);
  });

  test('picker button sits left of send; empty state offers a manage affordance', async ({ page }) => {
    await openChatPanel(page);

    const pickerBtn = page.locator('.chat-panel__snippet-picker-btn');
    const sendBtn = page.locator('.chat-panel__send-btn');
    await expect(pickerBtn).toBeVisible();
    await expect(sendBtn).toBeVisible();

    // Geometry: the picker is to the LEFT of the send button.
    const pickerBox = await pickerBtn.boundingBox();
    const sendBox = await sendBtn.boundingBox();
    expect(pickerBox.x).toBeLessThan(sendBox.x);

    // Empty library → dropdown shows the empty state with a "Manage" way in.
    await openSnippetDropdown(page);
    const empty = page.locator('.chat-panel__snippet-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No snippets yet');
    await expect(page.locator('.chat-panel__snippet-manage-empty-btn')).toBeVisible();
    // The header gear is present even in the empty state.
    await expect(page.locator('.chat-panel__snippet-manage-btn')).toBeVisible();
  });

  test('dropdown with long previews stays inside the chat panel', async ({ page }) => {
    // Regression: the dropdown used to size to its longest nowrap preview and
    // grow leftward out of the panel, sliding under the file navigator.
    await seedSnippet(
      page,
      'This is a deliberately long snippet body that would previously force the dropdown to grow far wider than the chat panel itself'
    );
    await openChatPanel(page);
    await openSnippetDropdown(page);

    const panelBox = await page.locator('.chat-panel').boundingBox();
    const dropBox = await page.locator('.chat-panel__snippet-dropdown').boundingBox();
    expect(dropBox.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(dropBox.x + dropBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);

    // The long preview ellipsizes rather than widening the item.
    const itemBox = await page.locator('.chat-panel__snippet-item').first().boundingBox();
    expect(itemBox.width).toBeLessThanOrEqual(dropBox.width);
  });

  test('gear opens the manage modal; adding a snippet lists it in the dropdown', async ({ page }) => {
    await openChatPanel(page);
    await openSnippetDropdown(page);

    // Gear → manage modal.
    await page.locator('.chat-panel__snippet-manage-btn').click();
    const modal = page.locator('.snippet-manager-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.snippet-manager-modal__header')).toContainText('Manage snippets');

    // Add a snippet through the inline editor inside the modal.
    await modal.locator('.snippet-manager__add-btn').click();
    const textarea = modal.locator('.snippet-manager__textarea');
    await textarea.fill('Explain this diff like I am five');
    await modal.locator('.snippet-manager__save-btn').click();

    // Row appears in the modal list.
    await expect(modal.locator('.snippet-manager__row')).toHaveCount(1);
    await expect(modal.locator('.snippet-manager__preview'))
      .toContainText('Explain this diff like I am five');

    // Close the modal and reopen the dropdown — it now lists the new snippet.
    await modal.locator('.snippet-manager-modal__close').click();
    await expect(modal).toHaveCount(0);

    await openSnippetDropdown(page);
    const items = page.locator('.chat-panel__snippet-item');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Explain this diff like I am five');
  });

  test('clicking a snippet inserts its body and enables send without sending', async ({ page }) => {
    await seedSnippet(page, 'Review this for security issues');
    await openChatPanel(page);
    await openSnippetDropdown(page);

    const input = page.locator('.chat-panel__input');
    const sendBtn = page.locator('.chat-panel__send-btn');
    await expect(sendBtn).toBeDisabled();

    await page.locator('.chat-panel__snippet-item').first().click();

    // Text landed in the textarea and send is now enabled.
    await expect(input).toHaveValue('Review this for security issues');
    await expect(sendBtn).toBeEnabled();

    // Plain click must NOT send: sendMessage() clears the input on submit, so the
    // text surviving in the textarea proves nothing was sent.
    await expect(input).toHaveValue('Review this for security issues');

    // Dropdown closes after an insert.
    await expect(page.locator('.chat-panel__snippet-dropdown')).toBeHidden();
  });

  test('Cmd/Ctrl+click a snippet inserts AND sends it', async ({ page }) => {
    // Unique body so the assertion can't match a message restored from the
    // shared per-worker session.
    const body = 'Cmd-click send snippet marker 4f2a';
    await seedSnippet(page, body);
    await openChatPanel(page);
    await openSnippetDropdown(page);

    const input = page.locator('.chat-panel__input');
    await expect(input).toHaveValue('');

    // Modifier-click sends: _insertPromptSnippet(id, { send: true }) → sendMessage().
    // The mock chat session manager in test-server.js persists the send and the
    // panel renders it optimistically as a user bubble.
    await page.locator('.chat-panel__snippet-item').first().click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });

    // The snippet body shows as a sent user message, and the input was cleared
    // by sendMessage() — together these prove it sent (a plain insert would keep
    // the text in the input and render no message).
    await expect(page.locator('.chat-panel__message--user', { hasText: body })).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(page.locator('.chat-panel__snippet-dropdown')).toBeHidden();
  });

  test('inserting a snippet bumps it to the top of the MRU order', async ({ page }) => {
    // Both start unused; touching one via insert gives it a real last_used_at
    // that definitively wins the MRU ordering regardless of the initial order.
    const idA = await seedSnippet(page, 'Alpha snippet body');
    await seedSnippet(page, 'Beta snippet body');

    await openChatPanel(page);
    await openSnippetDropdown(page);

    const items = page.locator('.chat-panel__snippet-item');
    await expect(items).toHaveCount(2);

    // Insert Alpha. Wait for the fire-and-forget touch to land so the reopened
    // dropdown reflects the new order deterministically.
    const touchResp = page.waitForResponse(
      (r) => /\/api\/snippets\/\d+\/touch$/.test(r.url()) && r.request().method() === 'POST'
    );
    await items.getByText('Alpha snippet body').click();
    await touchResp;

    // Reopen — Alpha now leads because its last_used_at was touched.
    await openSnippetDropdown(page);
    const reopened = page.locator('.chat-panel__snippet-item');
    await expect(reopened).toHaveCount(2);
    await expect(reopened.first()).toHaveAttribute('data-snippet-id', String(idA));
  });
});

// ─── Local mode ─────────────────────────────────────────────────────────────

test.describe('Chat prompt snippets (local mode)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('pair-review:chat-tabs:'))
          .forEach((k) => localStorage.removeItem(k));
      } catch { /* noop */ }
    });
    await clearSnippets(page);
    // Seeded local review id=2 (see tests/e2e/global-setup.js).
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    await enableChat(page);
  });

  test('inserts a snippet into the chat input in local mode', async ({ page }) => {
    await seedSnippet(page, 'Summarize the local changes');
    await openChatPanel(page);
    await openSnippetDropdown(page);

    const input = page.locator('.chat-panel__input');
    const sendBtn = page.locator('.chat-panel__send-btn');
    await expect(sendBtn).toBeDisabled();

    await page.locator('.chat-panel__snippet-item').first().click();

    await expect(input).toHaveValue('Summarize the local changes');
    await expect(sendBtn).toBeEnabled();
    await expect(page.locator('.chat-panel__snippet-dropdown')).toBeHidden();
  });
});

// ─── Settings page ──────────────────────────────────────────────────────────

test.describe('Chat prompt snippets (settings page)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearSnippets(page);
  });

  test('shows the Chat Snippets nav item + section and round-trips CRUD', async ({ page }) => {
    await page.goto('/settings');

    // Nav item points at the snippets section, which exists on the page.
    const navList = page.locator('#settings-nav-list');
    const navItem = navList.locator('.settings-nav-item[data-target="snippets-section"]');
    await expect(navItem).toBeVisible({ timeout: 5000 });
    await expect(navItem).toContainText('Chat Snippets');
    await expect(page.locator('#snippets-section')).toHaveCount(1);

    const manager = page.locator('#snippets-manager');
    // Starts empty.
    await expect(manager.locator('.snippet-manager__empty')).toBeVisible();

    // ── Add ──
    await manager.locator('.snippet-manager__add-btn').click();
    await manager.locator('.snippet-manager__textarea').fill('Draft a changelog entry');
    await manager.locator('.snippet-manager__save-btn').click();

    const row = manager.locator('.snippet-manager__row');
    await expect(row).toHaveCount(1);
    await expect(manager.locator('.snippet-manager__preview')).toContainText('Draft a changelog entry');

    // ── Edit ──
    await manager.locator('.snippet-manager__edit-btn').click();
    const textarea = manager.locator('.snippet-manager__textarea');
    await expect(textarea).toHaveValue('Draft a changelog entry');
    await textarea.fill('Draft a detailed changelog entry');
    await manager.locator('.snippet-manager__save-btn').click();

    await expect(manager.locator('.snippet-manager__preview'))
      .toContainText('Draft a detailed changelog entry');
    await expect(manager.locator('.snippet-manager__row')).toHaveCount(1);

    // ── Delete ──
    // Delete is guarded by a confirmation. The settings page doesn't load the
    // styled confirmDialog, so SnippetManager falls back to native window.confirm
    // — accept it (Playwright auto-dismisses dialogs by default).
    page.once('dialog', (dialog) => dialog.accept());
    await manager.locator('.snippet-manager__delete-btn').click();
    await expect(manager.locator('.snippet-manager__row')).toHaveCount(0);
    await expect(manager.locator('.snippet-manager__empty')).toBeVisible();
  });
});
