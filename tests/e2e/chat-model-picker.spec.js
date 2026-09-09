// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Chat model picker (plans/chat-model-selection.md)
 *
 * The chat header gained a second picker beside the provider picker. The model
 * belongs to the conversation: it can be chosen freely until the first message
 * is sent, after which the tab keeps it and switching offers a NEW tab behind a
 * one-time explainer dialog. Flows locked down here, in BOTH modes:
 *
 *   1. Fresh tab → pick a catalog model → the header label becomes the catalog
 *      NAME, the dropdown closes, and the first send carries that id all the way
 *      into `chat_sessions.model` (asserted through the POST body AND the
 *      persisted row via GET /api/review/:id/chat/sessions).
 *   2. Tab with messages → picking a different model raises the confirm dialog
 *      (with the "Don't ask again" checkbox). Cancel keeps the tab and its
 *      model and opens nothing; Confirm opens a NEW tab labelled with the picked
 *      model while the original tab stays put.
 *   3. Ticking "Don't ask again" before confirming writes the ack key, and the
 *      next switch on a messaged tab opens a new tab with NO dialog at all.
 *   4. The last model PICKED for a provider is remembered per browser and seeds
 *      the next new tab; picking "Provider default" clears it again.
 *   5. Switching provider on a fresh tab resets the model label to "Default"
 *      (a selector only means something under its own provider's catalog).
 *
 * The catalog is stubbed via `page.route('**\/api/chat/providers')` so the rows
 * are deterministic — the real endpoint reflects whatever CLIs the machine has.
 * `POST /api/chat/session` is deliberately NOT stubbed: it hits the real route
 * (and the test server's mock session manager, which persists `model`), which is
 * the whole point of scenario 1.
 *
 * Isolation: the per-worker DB and localStorage are shared across the file, so
 * every test wipes the chat-tab state, the model-switch ack key AND the
 * per-provider remembered-model keys, and always
 * works on a tab it opened itself via "+" rather than a restored one.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

/** localStorage flag written by "Don't ask again" (ChatPanel.MODEL_SWITCH_ACK_KEY). */
const ACK_KEY = 'pair-review:chat-model-switch-ack';

/**
 * Prefix of the per-provider "last model picked" keys
 * (ChatPanel.LAST_MODEL_KEY_PREFIX). Wiped alongside the ack key so a test
 * never inherits a preference written by an earlier one.
 */
const LAST_MODEL_PREFIX = 'pair-review:chat-model:';

/**
 * Deterministic stub for GET /api/chat/providers. Two providers so the provider
 * picker has somewhere to go (scenario 4), three models on `pi` so a switch has
 * a third target (scenario 3).
 *
 * The first pi model carries a realistic id that does NOT prettify to its
 * display name ("pi-fast-2026-05-01" -> "Pi Fast 2026 05 01"), so label
 * assertions prove the catalog lookup ran instead of passing on the
 * prettified-id fallback.
 */
const CHAT_PROVIDERS_STUB = {
  data: {
    providers: [
      {
        id: 'pi',
        name: 'Pi',
        type: 'pi',
        available: true,
        hasCatalog: true,
        configuredModel: null,
        models: [
          { id: 'pi-fast-2026-05-01', name: 'Model A', tier: 'fast', tagline: 'Quick first pass', badge: 'Fast', badgeClass: 'model-badge-fast', description: 'Model A description' },
          { id: 'model-b', name: 'Model B', tier: 'thorough', tagline: 'Deeper reasoning', badge: 'Thorough', badgeClass: 'model-badge-thorough', description: 'Model B description' },
          { id: 'model-c', name: 'Model C', tier: 'balanced', tagline: 'Middle ground', badge: '', badgeClass: '', description: 'Model C description' },
        ],
      },
      {
        id: 'claude',
        name: 'Claude',
        type: 'claude',
        available: true,
        hasCatalog: true,
        configuredModel: null,
        models: [
          { id: 'claude-model-x', name: 'Claude Model X', tier: 'balanced', tagline: 'Other catalog', badge: '', badgeClass: '', description: '' },
        ],
      },
    ],
  },
};

/**
 * Force chat into "available" state so the toggle is interactive and a session
 * can be created. Pi isn't installed in E2E — same shim as chat-tabs.spec.js,
 * plus a SECOND available provider so the provider dropdown has a real target.
 */
async function enableChat(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'available');
    window.__pairReview = window.__pairReview || {};
    window.__pairReview.chatProvider = 'pi';
    window.__pairReview.chatProviders = [
      { id: 'pi', name: 'Pi', type: 'pi', available: true },
      { id: 'claude', name: 'Claude', type: 'claude', available: true },
    ];
    window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
  });
}

/**
 * Wipe persisted chat-tab state + the model-switch ack, stub the catalog, then
 * load the given review URL and enable chat.
 *
 * The localStorage wipe bounces through the origin root: index.html doesn't
 * include ChatPanel, so touching storage there can't race the panel's restore.
 */
async function bootReview(page, url) {
  await page.route('**/api/chat/providers', (route) =>
    route.fulfill({ json: CHAT_PROVIDERS_STUB })
  );

  await page.goto('/');
  await page.evaluate(({ ackKey, modelPrefix }) => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('pair-review:chat-tabs:') || k.startsWith(modelPrefix))
        .forEach((k) => localStorage.removeItem(k));
      localStorage.removeItem(ackKey);
    } catch { /* noop */ }
  }, { ackKey: ACK_KEY, modelPrefix: LAST_MODEL_PREFIX });

  await page.goto(url);
  await waitForDiffToRender(page);
  await enableChat(page);
}

/** Open the chat panel via its toggle and wait for it to be visible. */
async function openChatPanel(page) {
  await page.locator('#chat-toggle-btn').click();
  await expect(page.locator('.chat-panel')).toBeVisible();
  // At least one tab must exist before "+" can meaningfully append one.
  await expect(page.locator('.chat-panel__tab')).not.toHaveCount(0);
}

/**
 * Click "+" and return the index of the freshly-appended (and focused) tab.
 * New tabs are always appended, so the index is stable for the rest of a test.
 */
async function openFreshTab(page) {
  const tabs = page.locator('.chat-panel__tab');
  const before = await tabs.count();
  await page.locator('.chat-panel__tab-new-btn').click();
  await expect(tabs).toHaveCount(before + 1);
  await expect(tabs.last()).toHaveClass(/chat-panel__tab--active/);
  return before; // zero-based index of the new last tab
}

/** Open the model dropdown and wait for it to render. */
async function openModelDropdown(page) {
  await page.locator('.chat-panel__model-picker-btn').click();
  const dropdown = page.locator('.chat-panel__model-dropdown');
  await expect(dropdown).toBeVisible();
  return dropdown;
}

/** Open the model dropdown and click the row for `modelId` ('' = provider default). */
async function pickModel(page, modelId) {
  const dropdown = await openModelDropdown(page);
  await dropdown.locator(`.chat-panel__model-item[data-model-id="${modelId}"]`).click();
}

/** The header's current model label. */
function modelLabel(page) {
  return page.locator('.chat-panel__model-text');
}

/** Send a chat message and wait for its user bubble to render. */
async function sendMessage(page, body) {
  await page.locator('.chat-panel__input').fill(body);
  await page.locator('.chat-panel__send-btn').click();
  await expect(page.locator('.chat-panel__message--user', { hasText: body })).toBeVisible();
}

/** Poll until the tab at `index` has a backend session id, then return it. */
async function waitForSessionId(page, index) {
  await expect.poll(
    () => page.evaluate((i) => window.chatPanel?.tabs?.[i]?.sessionId ?? null, index),
    { timeout: 5000 }
  ).not.toBeNull();
  return page.evaluate((i) => window.chatPanel.tabs[i].sessionId, index);
}

/** Read the persisted `model` for one session out of the review's session list. */
async function persistedSessionModel(page, reviewId, sessionId) {
  const res = await page.request.get(`/api/review/${reviewId}/chat/sessions`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const row = (body?.data?.sessions || []).find((s) => s.id === sessionId);
  expect(row, `session ${sessionId} missing from review ${reviewId}`).toBeTruthy();
  return row.model;
}

const MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1', reviewId: 1 },
  // Seeded local review id=2 (see tests/e2e/test-server.js).
  { name: 'Local mode', path: '/local/2', reviewId: 2 },
];

for (const mode of MODES) {
  test.describe(`Chat model picker (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await bootReview(page, mode.path);
    });

    test('picks a catalog model on a fresh tab and the first send persists it', async ({ page }) => {
      await openChatPanel(page);
      const tabIndex = await openFreshTab(page);

      // A brand-new tab starts on the provider default.
      await expect(modelLabel(page)).toHaveText('Default');

      const dropdown = await openModelDropdown(page);

      // Row order/shape contract: "Provider default" first, then the catalog.
      const items = dropdown.locator('.chat-panel__model-item');
      await expect(items).toHaveCount(4); // default + 3 pi models
      await expect(items.first()).toHaveAttribute('data-default', 'true');
      await expect(items.first()).toHaveAttribute('data-model-id', '');
      await expect(items.first()).toHaveClass(/chat-panel__model-item--active/);
      await expect(items.nth(1).locator('.chat-panel__model-item-name')).toHaveText('Model A');
      await expect(items.nth(1).locator('.chat-panel__model-badge')).toHaveText('Fast');
      await expect(items.nth(1).locator('.chat-panel__model-item-subtitle')).toHaveText('Quick first pass');

      await dropdown.locator('.chat-panel__model-item[data-model-id="pi-fast-2026-05-01"]').click();

      // Button label updates to the catalog NAME; dropdown closes. The fixture
      // id deliberately does not prettify to its name, so this proves the
      // catalog branch runs rather than the prettified-id fallback.
      await expect(modelLabel(page)).toHaveText('Model A');
      await expect(modelLabel(page)).not.toHaveText('Pi Fast 2026 05 01');
      await expect(dropdown).toBeHidden();
      // The provider text carries the provider only — the model has its own picker.
      await expect(page.locator('.chat-panel__title-text')).toHaveText('Chat · Pi');

      // Re-opening shows Model A as the active row (and no longer the default).
      const reopened = await openModelDropdown(page);
      await expect(reopened.locator('.chat-panel__model-item[data-model-id="pi-fast-2026-05-01"]'))
        .toHaveClass(/chat-panel__model-item--active/);
      await expect(reopened.locator('.chat-panel__model-item[data-model-id=""]'))
        .not.toHaveClass(/chat-panel__model-item--active/);
      // Close it again (click the picker button) so it can't swallow later clicks.
      await page.locator('.chat-panel__model-picker-btn').click();
      await expect(reopened).toBeHidden();

      // Send the first message. POST /api/chat/session is the REAL route.
      const sessionPost = page.waitForRequest(
        (r) => r.url().endsWith('/api/chat/session') && r.method() === 'POST'
      );
      await sendMessage(page, 'Model picker marker: which model am I?');
      const request = await sessionPost;
      expect(request.postDataJSON().model).toBe('pi-fast-2026-05-01');

      // ...and it landed in chat_sessions.model.
      const sessionId = await waitForSessionId(page, tabIndex);
      expect(await persistedSessionModel(page, mode.reviewId, sessionId)).toBe('pi-fast-2026-05-01');
    });

    test('switching model on a messaged tab: cancel keeps the tab, confirm opens a new one', async ({ page }) => {
      await openChatPanel(page);
      const tabIndex = await openFreshTab(page);

      await pickModel(page, 'pi-fast-2026-05-01');
      await expect(modelLabel(page)).toHaveText('Model A');
      await sendMessage(page, 'Cancel-then-confirm marker');
      await waitForSessionId(page, tabIndex);

      const tabs = page.locator('.chat-panel__tab');
      const countBefore = await tabs.count();
      const dialog = page.locator('#confirm-dialog');

      // ── Cancel ────────────────────────────────────────────────────────────
      await pickModel(page, 'model-b');
      await expect(dialog).toBeVisible();
      await expect(page.locator('#confirm-dialog-title')).toHaveText('Start a new conversation?');
      await expect(page.locator('#confirm-dialog-message')).toContainText('Model B');
      // The opt-in checkbox lives in the body, after the message.
      const checkbox = dialog.locator('.modal-body label.confirm-dialog__checkbox input[type="checkbox"]');
      await expect(checkbox).toBeVisible();
      await expect(checkbox).not.toBeChecked();
      // Cancel is labelled with the model we'd be keeping.
      const cancelBtn = dialog.locator('.modal-footer [data-action="cancel"]');
      await expect(cancelBtn).toContainText('Keep Model A');

      await cancelBtn.click();
      await expect(dialog).toBeHidden();

      // Same tab, same model, nothing opened.
      await expect(tabs).toHaveCount(countBefore);
      await expect(modelLabel(page)).toHaveText('Model A');
      expect(await page.evaluate((i) => window.chatPanel.tabs[i].model, tabIndex)).toBe('pi-fast-2026-05-01');
      // Cancelling must not write the ack key.
      expect(await page.evaluate((k) => localStorage.getItem(k), ACK_KEY)).toBeNull();

      // ── Confirm ───────────────────────────────────────────────────────────
      await pickModel(page, 'model-b');
      await expect(dialog).toBeVisible();
      await page.locator('#confirm-dialog-btn').click();
      await expect(dialog).toBeHidden();

      // A new tab opened on the picked model; the old one is still there,
      // still on Model A, still holding its message.
      await expect(tabs).toHaveCount(countBefore + 1);
      await expect(tabs.last()).toHaveClass(/chat-panel__tab--active/);
      await expect(modelLabel(page)).toHaveText('Model B');
      expect(await page.evaluate((i) => window.chatPanel.tabs[i].model, tabIndex)).toBe('pi-fast-2026-05-01');
      expect(
        await page.evaluate((i) => window.chatPanel.tabs[i].messages.map((m) => m.content), tabIndex)
      ).toContain('Cancel-then-confirm marker');
      // Unchecked box → no ack written.
      expect(await page.evaluate((k) => localStorage.getItem(k), ACK_KEY)).toBeNull();
    });

    test('"Don\'t ask again" writes the ack and suppresses the dialog on the next switch', async ({ page }) => {
      await openChatPanel(page);
      const firstTab = await openFreshTab(page);

      await pickModel(page, 'pi-fast-2026-05-01');
      await sendMessage(page, 'Ack-flow marker one');
      await waitForSessionId(page, firstTab);

      const tabs = page.locator('.chat-panel__tab');
      const dialog = page.locator('#confirm-dialog');
      const countBefore = await tabs.count();

      // Switch with the box ticked.
      await pickModel(page, 'model-b');
      await expect(dialog).toBeVisible();
      await dialog.locator('.modal-body label.confirm-dialog__checkbox input[type="checkbox"]').check();
      await page.locator('#confirm-dialog-btn').click();
      await expect(dialog).toBeHidden();

      await expect(tabs).toHaveCount(countBefore + 1);
      await expect(modelLabel(page)).toHaveText('Model B');
      await expect
        .poll(() => page.evaluate((k) => localStorage.getItem(k), ACK_KEY))
        .toBe('1');

      // Give the NEW tab a message so it, too, is past the in-place gate.
      const secondTab = countBefore; // index of the tab just appended
      await sendMessage(page, 'Ack-flow marker two');
      await waitForSessionId(page, secondTab);

      // Switching again opens a tab immediately — the appended tab IS the
      // deterministic signal that no dialog blocked the flow.
      await pickModel(page, 'model-c');
      await expect(tabs).toHaveCount(countBefore + 2);
      await expect(modelLabel(page)).toHaveText('Model C');
      await expect(dialog).toBeHidden();
    });

    test('the last picked model seeds the next new tab, and picking Default sticks too', async ({ page }) => {
      await openChatPanel(page);
      await openFreshTab(page);

      // Pick Model B — the pick is what gets remembered.
      await pickModel(page, 'model-b');
      await expect(modelLabel(page)).toHaveText('Model B');
      await expect
        .poll(() => page.evaluate((k) => localStorage.getItem(k), `${LAST_MODEL_PREFIX}pi`))
        .toBe('model-b');

      // A brand-new tab starts on it instead of the provider default.
      await openFreshTab(page);
      await expect(modelLabel(page)).toHaveText('Model B');

      // Picking "Provider default" is an explicit choice: it clears the memory.
      await pickModel(page, '');
      await expect(modelLabel(page)).toHaveText('Default');
      await expect
        .poll(() => page.evaluate((k) => localStorage.getItem(k), `${LAST_MODEL_PREFIX}pi`))
        .toBeNull();

      // ...so the tab after that starts on the default again.
      await openFreshTab(page);
      await expect(modelLabel(page)).toHaveText('Default');
    });

    test('switching provider on a fresh tab resets the model label to Default', async ({ page }) => {
      await openChatPanel(page);
      await openFreshTab(page);

      await pickModel(page, 'model-b');
      await expect(modelLabel(page)).toHaveText('Model B');
      await expect(page.locator('.chat-panel__title-text')).toHaveText('Chat · Pi');

      await page.locator('.chat-panel__provider-picker-btn').click();
      const providerDropdown = page.locator('.chat-panel__provider-dropdown');
      await expect(providerDropdown).toBeVisible();
      await providerDropdown.locator('.chat-panel__provider-item[data-provider-id="claude"]').click();

      await expect(page.locator('.chat-panel__title-text')).toHaveText('Chat · Claude');
      await expect(modelLabel(page)).toHaveText('Default');
      expect(await page.evaluate(() => {
        const p = window.chatPanel;
        return p.tabs[p.tabs.length - 1].model;
      })).toBeNull();

      // The dropdown now renders the NEW provider's catalog, with the default
      // row active again.
      const dropdown = await openModelDropdown(page);
      await expect(dropdown.locator('.chat-panel__model-item')).toHaveCount(2);
      await expect(dropdown.locator('.chat-panel__model-item[data-model-id=""]'))
        .toHaveClass(/chat-panel__model-item--active/);
      await expect(dropdown.locator('.chat-panel__model-item[data-model-id="claude-model-x"] .chat-panel__model-item-name'))
        .toHaveText('Claude Model X');
    });
  });
}
