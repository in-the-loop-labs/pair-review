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

      // Park the pointer deep in the additions CONTENT track — X to the RIGHT of
      // the gutter (between the line-number cell's right edge and the pre's right
      // edge), any row. This matters for determinism: the fallback positioner
      // re-arms ONLY when a synthetic pointermove (dispatched by the bridge's
      // post-scroll hover re-derive) lands on a line-NUMBER cell. A point in the
      // content track never resolves to a number cell regardless of how far the
      // diff scrolls or what annotations are present, so no fixed button can
      // re-arm. (Using the FIRST content cell's centre — as an earlier version
      // did — is unsafe: the first added line is blank, so its cell is near-zero
      // width and its centre sits over the gutter, which re-armed under some
      // layouts and made this test flaky in the full suite.)
      const park = await page.evaluate((file) => {
        const sr = document
          .querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`)
          ?.querySelector('diffs-container')?.shadowRoot;
        const pre = sr?.querySelector('pre[data-diff-type="split"]');
        const numCell = sr?.querySelector('code[data-additions] [data-column-number]');
        const contentCell = sr?.querySelector('code[data-additions] [data-content]');
        if (!pre || !numCell || !contentCell) return null;
        const preR = pre.getBoundingClientRect();
        const numR = numCell.getBoundingClientRect();
        const cR = contentCell.getBoundingClientRect();
        return { x: (numR.right + preR.right) / 2, y: cR.y + Math.min(40, cR.height / 2) };
      }, FILE);
      expect(park, 'additions content track should be resolvable in split').not.toBeNull();
      await page.mouse.move(park.x, park.y);
      // Buttons survive the move (pointer still over the file, over content).
      expect((await fallbackGutterState(page)).some((s) => s.fallbackPositioned)).toBe(true);

      // Scroll the diff's own scroll container WITHOUT moving the pointer. Driving
      // the container directly (rather than a wheel gesture, whose delivery
      // depends on what element is under the pointer being scrollable) fires the
      // same window-level scroll event the bridge listens for, deterministically.
      // Fixed-position buttons would otherwise stay glued to the viewport while
      // the diff moves under them; the scroll must detach every fixed button.
      // Scroll toward whichever direction has room — in the shared-DB full suite
      // the container may already sit at the bottom (other specs' state makes the
      // diff taller / pre-scrolled), so a fixed downward delta would be a no-op.
      const scrolled = await page.evaluate((file) => {
        let el = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
        while (el) {
          const oy = getComputedStyle(el).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) break;
          el = el.parentElement;
        }
        if (!el) return false;
        const maxScroll = el.scrollHeight - el.clientHeight;
        const before = el.scrollTop;
        el.scrollTop = before < maxScroll ? maxScroll : 0;
        return el.scrollTop !== before;
      }, FILE);
      expect(scrolled, 'the diff container should have a scrollable ancestor that moved').toBe(true);

      // A normal button re-hovered on the line still under the pointer is fine;
      // the regression is a FIXED (fallback-positioned) button surviving the
      // scroll (see expectNoFallbackButtons).
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
