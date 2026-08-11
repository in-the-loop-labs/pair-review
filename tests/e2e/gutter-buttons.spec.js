// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: gutter buttons reveal on hover and never go stale.
 *
 * Under the single-CodeView render path the +/chat gutter buttons are built by
 * the bridge's `renderGutterUtility` and positioned by the vendor's
 * gutter-utility (a light-DOM `.pierre-gutter-buttons` container, `position:
 * absolute`, slotted at the hovered row). This REPLACED the old hand-rolled
 * `position:fixed` fallback positioner (`data-fallback-positioned`) whose
 * viewport-pinned buttons could be left floating over unrelated content — that
 * subsystem, and the staleness bug it caused, no longer exist.
 *
 * What still matters (and is covered here): the buttons must reveal when a diff
 * line is hovered, and must NOT remain visible once the interaction that
 * revealed them ends — the pointer leaving the diff, a scroll, or a
 * unified/split layout toggle. Because the buttons are now part of the diff's
 * own (absolutely-positioned, slotted) layout rather than pinned to the
 * viewport, "stale" here means "still visible with the pointer no longer on a
 * line", which is the mode-independent invariant we assert.
 *
 * The bridge/gutter path is shared by PR and Local mode; the per-worker test
 * server seeds the SAME src/utils.js diff for review 1 (PR) and review 2
 * (Local) — see tests/e2e/global-setup.js — so identical fixtures work in both.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, setDiffView, hoverUntilGutterVisible } from './helpers.js';

const FILE = 'src/utils.js';
// Line 3 is an added line in the fixture diff and sits clear of the sticky file
// header, so hovering it reliably routes through the vendor gutter-utility
// (hovering the very first row can land under the sticky header and miss).
const HOVER_LINE = 3;

/**
 * A single-file diff deterministically taller than the viewport, for the scroll
 * test. The seeded fixture is a handful of lines and only becomes scrollable
 * if/when the idle content upgrade inlines the full files — which nothing
 * awaits, so a scroll on it is a coin flip.
 */
const TALL_LINES = 400;
function tallDiff() {
  let d = `diff --git a/${FILE} b/${FILE}\n--- a/${FILE}\n+++ b/${FILE}\n@@ -1,1 +1,${TALL_LINES} @@\n`;
  for (let i = 1; i <= TALL_LINES; i++) d += `+// utils line ${i}\n`;
  return d;
}

const MODES = [
  {
    name: 'PR mode',
    path: '/pr/test-owner/test-repo/1',
    diffRoute: '**/api/pr/*/*/*/diff',
    tallBody: () => ({
      diff: tallDiff(),
      changed_files: [{ file: FILE, additions: TALL_LINES, deletions: 0 }]
    })
  },
  {
    name: 'Local mode',
    path: '/local/2',
    // Trailing wildcard so it also matches the query-string form local.js appends.
    diffRoute: '**/api/local/*/diff*',
    tallBody: () => ({
      diff: tallDiff(),
      stats: { files_changed: 1, additions: TALL_LINES, deletions: 0 }
    })
  }
];

/**
 * Visibility of every rendered gutter-button container. Each mounted file has
 * one `.pierre-gutter-buttons` (a light-DOM child of its host); the vendor sizes
 * it to non-zero only while its row is hovered.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<{visible:boolean}>>}
 */
async function gutterState(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('.pierre-gutter-buttons')].map((el) => {
      const r = el.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0 };
    });
  });
}

/**
 * Hover the target line and wait for its gutter to reveal, RE-hovering on each
 * poll (hoverUntilGutterVisible). Local mode fires a diff-refresh re-render
 * shortly after load that can rebuild the row out from under a one-shot hover
 * (dropping the reveal); re-hovering each iteration makes the arrange step
 * robust against that churn. Scoped to the hovered file's own gutter container
 * — hovering FILE's line reveals FILE's gutter.
 * @param {import('@playwright/test').Page} page
 * @param {number} line
 */
async function armGutter(page, line) {
  const host = page.locator(`diffs-container[data-file-name="${FILE}"]`);
  await hoverUntilGutterVisible(page, {
    cell: host.locator(`[data-line="${line}"]`).first(),
    button: host.locator('.pierre-gutter-buttons').first(),
    timeout: 8000,
  });
}

async function expectNoGutterVisible(page) {
  await expect.poll(async () => {
    const state = await gutterState(page);
    return state.every((s) => !s.visible);
  }, { timeout: 5000 }).toBe(true);
}

for (const mode of MODES) {
  test.describe(`Gutter buttons — reveal + no stale artifacts (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 700 });
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test('reveals the +/chat buttons when a diff line is hovered', async ({ page }) => {
      // No gutter is visible before any hover.
      await expectNoGutterVisible(page);

      // Re-hover on each poll via hoverUntilGutterVisible (Local mode's
      // diff-refresh re-render can drop a one-shot hover) and assert the
      // HOVERED file's own comment button becomes sized. Reading geometry
      // inside the poll avoids the race where a separate `toBeVisible` check
      // runs a frame after the gutter has hidden again.
      const host = page.locator(`diffs-container[data-file-name="${FILE}"]`);
      const cell = host.locator(`[data-line="${HOVER_LINE}"]`).first();
      await hoverUntilGutterVisible(page, {
        cell,
        button: host.locator('.pierre-comment-btn').first(),
        timeout: 8000,
      });

      // The chat button is provider-gated: the fixture server configures no
      // chat provider, so <html data-chat="unavailable"> hides it via CSS
      // (pr.css [data-chat="disabled"|"unavailable"] .pierre-chat-btn). Assert
      // the gate explicitly — the button must exist either way, and must be
      // sized exactly when the gate is open — so a regression that drops the
      // button entirely, or un-hides it while gated, still fails.
      const chatBtn = host.locator('.pierre-chat-btn').first();
      await expect(chatBtn).toBeAttached();
      const chatState = await page.evaluate(
        () => document.documentElement.getAttribute('data-chat')
      );
      if (chatState === 'disabled' || chatState === 'unavailable') {
        await expect(chatBtn).toBeHidden();
      } else {
        await hoverUntilGutterVisible(page, { cell, button: chatBtn, timeout: 8000 });
      }
    });

    test('clears when the pointer leaves the diff', async ({ page }) => {
      await armGutter(page, HOVER_LINE);

      // Park the pointer on the page header, well outside the diff.
      await page.mouse.move(800, 15);
      await expectNoGutterVisible(page);
    });

    test('clears when the diff scrolls under a parked pointer', async ({ page }) => {
      // Re-navigate onto a diff that is taller than the viewport by construction:
      // this test needs a scroll that genuinely MOVES content, and the seeded
      // fixture's scrollability depends on the un-awaited idle content upgrade.
      await page.route(mode.diffRoute, (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(mode.tallBody()) })
      );
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      // The virtualizer sizes its scroll content from measured item metrics, so
      // wait for the root to actually report scrollable extent before scrolling.
      await expect.poll(async () => page.evaluate(() => {
        const root = document.getElementById('diff-container');
        return !!root && root.scrollHeight > root.clientHeight + 4;
      }), { timeout: 10000 }).toBe(true);

      await armGutter(page, HOVER_LINE);

      // Scroll the CodeView root without moving the pointer. The revealed row
      // moves out from under the pointer, so the gutter must not stay visible
      // glued to its old position.
      const scrolled = await page.evaluate(() => {
        const root = document.getElementById('diff-container');
        const before = root.scrollTop;
        root.scrollTop = root.scrollTop > 0 ? 0 : root.scrollHeight;
        return root.scrollTop !== before;
      });
      expect(scrolled, 'the CodeView root should have scrollable content that moved').toBe(true);

      await expectNoGutterVisible(page);
    });

    test('clears when the diff view toggles to split', async ({ page }) => {
      await armGutter(page, HOVER_LINE);

      // Toggling layout rebuilds every mounted item; no gutter container should
      // survive the rerender still visible.
      await setDiffView(page, 'split');
      await expectNoGutterVisible(page);
    });
  });
}
