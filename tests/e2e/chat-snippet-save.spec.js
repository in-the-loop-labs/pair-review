// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Save a chat message as a snippet (alt-click affordance)
 *
 * Complements chat-snippets.spec.js (which covers the insert direction). Here we
 * lock down the reverse direction: alt-clicking a message the user already sent
 * reveals a single "Save as snippet" pill; clicking it persists that message's
 * body to the global snippet library.
 *
 *   1. Alt-click a submitted USER message → pill appears; clicking it POSTs the
 *      body to /api/snippets (verified via a follow-up GET).
 *   2. Escape dismisses the pill WITHOUT closing the chat panel.
 *   3. Works in both PR mode and local mode (ChatPanel is one shared component).
 *
 * Snippets live in the per-worker E2E DB shared across tests in a worker; only
 * the snippet specs touch /api/snippets, so each test wipes the table first.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

/**
 * Force chat into "available" state so the toggle is interactive and a session
 * can be created. Pi isn't installed in E2E — same shim as chat-tabs.spec.js.
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

/** Open the chat panel via its toggle and wait for it to be visible. */
async function openChatPanel(page) {
  await page.locator('#chat-toggle-btn').click();
  await expect(page.locator('.chat-panel')).toBeVisible();
}

/** Send a chat message and wait for its user bubble to render. */
async function sendMessage(page, body) {
  await page.locator('.chat-panel__input').fill(body);
  await page.locator('.chat-panel__send-btn').click();
  await expect(page.locator('.chat-panel__message--user', { hasText: body })).toBeVisible();
}

/** Wipe persisted chat-tab state, then load the given review URL. */
async function bootReview(page, url) {
  await page.goto('/');
  await page.evaluate(() => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('pair-review:chat-tabs:'))
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* noop */ }
  });
  await clearSnippets(page);
  await page.goto(url);
  await waitForDiffToRender(page);
  await enableChat(page);
}

/** Poll the snippet library until a snippet with the exact body exists. */
async function expectSnippetSaved(page, body) {
  await expect.poll(async () => {
    const res = await page.request.get('/api/snippets');
    if (!res.ok()) return false;
    const data = await res.json();
    return (data.snippets || []).some((s) => s.body === body);
  }, { timeout: 5000 }).toBe(true);
}

// ─── PR mode ──────────────────────────────────────────────────────────────

test.describe('Save chat message as snippet (PR mode)', () => {
  test.beforeEach(async ({ page }) => {
    await bootReview(page, '/pr/test-owner/test-repo/1');
  });

  test('alt-click a user message → pill saves its body to the library', async ({ page }) => {
    await openChatPanel(page);

    // Unique body so the save assertion can't match a restored message.
    const body = 'Save-as-snippet marker 7c19: check error handling';
    await sendMessage(page, body);

    // Alt-click the sent user message to reveal the pill.
    await page.locator('.chat-panel__message--user', { hasText: body }).click({ modifiers: ['Alt'] });
    const pill = page.locator('.chat-panel__save-snippet-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('Save as snippet');

    // Click the pill and confirm the POST landed, then the pill dismisses.
    const saveResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/snippets') && r.request().method() === 'POST'
    );
    await pill.click();
    await saveResp;
    await expect(pill).toHaveCount(0);

    await expectSnippetSaved(page, body);
  });

  test('Escape dismisses the pill without closing the chat panel', async ({ page }) => {
    await openChatPanel(page);
    const body = 'Escape-dismiss marker 3b8e';
    await sendMessage(page, body);

    await page.locator('.chat-panel__message--user', { hasText: body }).click({ modifiers: ['Alt'] });
    await expect(page.locator('.chat-panel__save-snippet-pill')).toBeVisible();

    await page.keyboard.press('Escape');

    // Pill gone, panel still open.
    await expect(page.locator('.chat-panel__save-snippet-pill')).toHaveCount(0);
    await expect(page.locator('.chat-panel')).toBeVisible();
  });
});

// ─── Local mode ─────────────────────────────────────────────────────────────

test.describe('Save chat message as snippet (local mode)', () => {
  test.beforeEach(async ({ page }) => {
    // Seeded local review id=2 (see tests/e2e/global-setup.js).
    await bootReview(page, '/local/2');
  });

  test('alt-click a user message → pill saves its body in local mode', async ({ page }) => {
    await openChatPanel(page);
    const body = 'Local-mode save marker 9d42';
    await sendMessage(page, body);

    await page.locator('.chat-panel__message--user', { hasText: body }).click({ modifiers: ['Alt'] });
    const pill = page.locator('.chat-panel__save-snippet-pill');
    await expect(pill).toBeVisible();

    const saveResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/snippets') && r.request().method() === 'POST'
    );
    await pill.click();
    await saveResp;

    await expectSnippetSaved(page, body);
  });
});
