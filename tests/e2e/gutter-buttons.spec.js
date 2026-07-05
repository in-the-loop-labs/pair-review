// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: fallback-positioned gutter buttons must not go stale.
 *
 * PierreBridge's fallback gutter positioning pins the +/chat buttons with
 * position:fixed (viewport coordinates). Regression coverage for buttons
 * left floating over unrelated content when:
 *   - the pointer moves off the diff entirely (teardown used to rely on a
 *     pointerleave listener bound to the shadow ROOT, which never fires),
 *   - the page scrolls (fixed coordinates detach from the hovered line),
 *   - the diff view toggles unified/split (rerender moves every line).
 *
 * Split mode is used to arm the fallback positioner because split gutter
 * hover reliably routes through it (see pierre-bridge.js fallback tracking).
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, setDiffView, hoverSplitDiffLine } from './helpers.js';

const FILE = 'src/utils.js';

// The fallback gutter positioning lives in the shared PierreBridge/PRManager
// render path, exercised identically by PR and Local mode. The per-worker test
// server seeds the SAME src/utils.js diff for review 1 (PR) and review 2
// (Local) — see tests/e2e/global-setup.js — so the same line/side fixtures work
// in both. Run the whole suite against each mode for parity coverage.
const MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1' },
  { name: 'Local mode', path: '/local/2' }
];

async function fallbackGutterState(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('.pierre-gutter-buttons')];
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        fallbackPositioned: el.dataset.fallbackPositioned !== undefined,
        position: el.style.position || '',
        visible: r.width > 0 && r.height > 0
      };
    });
  });
}

async function armFallbackButtons(page) {
  await setDiffView(page, 'split');
  await hoverSplitDiffLine(page, { fileName: FILE, line: 4, side: 'additions' });
  await expect.poll(async () => {
    const state = await fallbackGutterState(page);
    return state.some((s) => s.fallbackPositioned && s.visible);
  }, { timeout: 5000 }).toBe(true);
}

async function expectNoStaleButtons(page) {
  await expect.poll(async () => {
    const state = await fallbackGutterState(page);
    return state.every((s) => !s.fallbackPositioned && !s.visible);
  }, { timeout: 5000 }).toBe(true);
}

/**
 * Assert no gutter container is still FALLBACK-positioned (position:fixed with
 * the fallbackPositioned marker). This is the precise regression signal for the
 * scroll and layout-toggle cases: the bug left FIXED-coordinate buttons floating
 * over unrelated content after the diff moved under them. A normal (slotted,
 * non-fixed) button legitimately re-hovered on the line still under the pointer
 * is NOT the bug — and whether that re-hover happens depends on the resulting
 * geometry (PR and Local mode lay the diff out at different heights / scroll
 * offsets), so asserting the whole gutter is hidden would be layout-coupled and
 * flaky. Asserting only "no fixed button remains" is the mode-independent
 * invariant. (The pointer-leave case parks the pointer clearly off the diff, so
 * it can use the stricter expectNoStaleButtons.)
 */
async function expectNoFallbackButtons(page) {
  await expect.poll(async () => {
    const state = await fallbackGutterState(page);
    return state.every((s) => !s.fallbackPositioned);
  }, { timeout: 5000 }).toBe(true);
}

for (const mode of MODES) {
  test.describe(`Gutter buttons — stale fallback positioning (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 700 });
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test('clear when the pointer leaves the diff', async ({ page }) => {
      await armFallbackButtons(page);

      // Park the pointer on the page header, well outside the file wrapper.
      await page.mouse.move(700, 20);
      await expectNoStaleButtons(page);
    });

    test('clear when the page scrolls under a parked pointer', async ({ page }) => {
      await armFallbackButtons(page);

      // Park the pointer over the additions CONTENT column (still inside the
      // file, so the pointer-move sweep keeps the buttons armed, but content
      // can never re-arm the fallback positioner after the scroll clears it —
      // only gutter cells can. Parking over the gutter would make the outcome
      // depend on which row lands under the pointer post-scroll: legitimate
      // re-anchoring, but nondeterministic).
      const content = await page.evaluate((file) => {
        const wrapper = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
        const sr = wrapper?.querySelector('diffs-container')?.shadowRoot;
        const r = sr?.querySelector('code[data-additions] [data-content]')?.getBoundingClientRect();
        return r ? { x: r.x + r.width / 2, y: r.y + Math.min(40, r.height / 2) } : null;
      }, FILE);
      expect(content, 'additions content cell should be resolvable in split').not.toBeNull();
      await page.mouse.move(content.x, content.y);
      // Buttons survive the move (pointer still over the file).
      expect((await fallbackGutterState(page)).some((s) => s.fallbackPositioned)).toBe(true);

      // Wheel-scroll without moving the pointer: fixed-position buttons would
      // otherwise stay glued to the viewport while the diff moves under them.
      // The scroll must detach every fixed button; a normal button re-hovered
      // on the line now under the pointer is fine (see expectNoFallbackButtons).
      await page.mouse.wheel(0, 400);
      await expectNoFallbackButtons(page);
    });

    test('clear when the diff view toggles back to unified', async ({ page }) => {
      await armFallbackButtons(page);

      // Toggle programmatically (no pointer movement) so this exercises the
      // setDiffStyle clearing path itself, not the pointer-move sweep. The
      // rerender must detach every fixed button; a normal button re-hovered on
      // the line still under the pointer in the new layout is fine (see
      // expectNoFallbackButtons).
      await page.evaluate(() => window.prManager.handleDiffViewChange('unified'));
      await expectNoFallbackButtons(page);
    });
  });
}
