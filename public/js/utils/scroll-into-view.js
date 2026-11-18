// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stable scroll-into-view for the virtualized diff panel.
 *
 * The diff viewer draws the files near the viewport and estimates the
 * heights of the others. A plain `scrollIntoView()` can therefore land off
 * target on the first attempt: the browser computes the destination from
 * the layout as it is, then the files passed during the scroll are drawn
 * and measured, shifting the target away from where the animation ends.
 *
 * `scrollIntoViewStable()`:
 *   1. Issues the caller's scroll (smooth behavior preserved).
 *   2. Waits for the viewport-relative position of the target to stop
 *      moving (scroll animation done AND the layout settled), then
 *      re-issues an instant scroll. If that correction moved the target,
 *      the layout shifted again — so settle and correct again, up to
 *      MAX_CORRECTIONS times.
 *
 * The target must be an element that is on screen or can be scrolled to:
 * the caller (PRManager.revealInDiff) brings a card the viewer does not
 * draw into its mounted window first.
 *
 * The settle loop aborts if the user starts scrolling themselves (wheel /
 * touch / scroll-intent keys) so corrections never fight real input, and
 * whenever the target leaves the DOM (file list re-render, tour unmount).
 */

/** Corrective re-scroll attempts after the initial scroll. */
const MAX_CORRECTIONS = 4;
/** Position delta (px) treated as "didn't move". */
const STABLE_PX = 2;
/** Consecutive same-position frames before the target counts as settled. */
const SETTLE_FRAMES = 3;
/** Hard cap on one settle wait — covers the longest smooth animation. */
const SETTLE_TIMEOUT_MS = 2000;

/** Keys that express scroll intent and should cancel pending corrections. */
const SCROLL_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '
]);

/**
 * Latest-scroll-wins token. Every call captures `++activeGeneration`; any
 * call whose captured value no longer matches has been superseded by a newer
 * scroll and must bow out so stale settle loops don't fight or snap the
 * viewport back to an old target.
 */
let activeGeneration = 0;

/**
 * Wait until `target` has a rendered box whose viewport-relative top stays
 * unchanged for SETTLE_FRAMES frames (or SETTLE_TIMEOUT_MS passes).
 * Resolves early when the target is disconnected or `isCancelled()` trips.
 * @param {Element} target
 * @param {() => boolean} isCancelled
 * @returns {Promise<void>}
 */
function waitForStablePosition(target, isCancelled) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastTop = null;
    let stableFrames = 0;
    const tick = () => {
      if (isCancelled() || !target.isConnected || Date.now() - start > SETTLE_TIMEOUT_MS) {
        resolve();
        return;
      }
      const rect = target.getBoundingClientRect();
      // Pierre can attach an annotation before its worker paints the slot.
      // An unchanged zero-sized box is not a settled scroll target. Restart
      // settling if an intervening render temporarily removes the box too.
      if (rect.width === 0 && rect.height === 0) {
        lastTop = null;
        stableFrames = 0;
        requestAnimationFrame(tick);
        return;
      }
      const top = rect.top;
      if (lastTop !== null && Math.abs(top - lastTop) <= STABLE_PX) {
        stableFrames += 1;
        if (stableFrames >= SETTLE_FRAMES) {
          resolve();
          return;
        }
      } else {
        stableFrames = 0;
      }
      lastTop = top;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Scroll `target` into view and keep it there while the layout settles.
 * Safe to call on any element; outside the diff it degrades to one
 * `scrollIntoView` plus a settle wait. Fire-and-forget friendly.
 * @param {Element} target - Element to bring into view
 * @param {ScrollIntoViewOptions} [options] - Passed to the initial scroll;
 *   corrective re-scrolls force `behavior: 'auto'`.
 * @returns {Promise<void>} resolves once the position is stable (or aborted)
 */
async function scrollIntoViewStable(target, options = {}) {
  if (!target || !target.isConnected || typeof target.scrollIntoView !== 'function') return;

  // Claim the active-scroll slot. A later call bumps activeGeneration past
  // ours, at which point isCancelled() trips and this call bows out.
  const myGen = ++activeGeneration;

  // Cancel corrections when the user scrolls on their own OR when a newer
  // scrollIntoViewStable call supersedes this one (latest-scroll-wins).
  let cancelled = false;
  const isCancelled = () => cancelled || myGen !== activeGeneration;
  const cancel = () => { cancelled = true; };
  const onKeyDown = (e) => {
    // Scroll-intent keys are also everyday caret/typing keys inside form
    // fields — there they mean "move the cursor", not "scroll the page", so
    // they must not abort the correction loop.
    if (e.target?.closest?.('input, textarea, select') || e.target?.isContentEditable) return;
    if (SCROLL_KEYS.has(e.key)) cancelled = true;
  };
  window.addEventListener('wheel', cancel, { capture: true, passive: true });
  window.addEventListener('touchstart', cancel, { capture: true, passive: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });

  try {
    target.scrollIntoView(options);
    for (let i = 0; i < MAX_CORRECTIONS; i++) {
      await waitForStablePosition(target, isCancelled);
      if (isCancelled() || !target.isConnected) return;
      // Re-issue instantly: a no-op when the smooth scroll landed true, a
      // snap to the real position when the layout shifted under the scroll.
      const rect = target.getBoundingClientRect();
      // The wait may have timed out before paint. Do not spend corrective
      // attempts scrolling an unrendered target, or treat that no-op as success.
      if (rect.width === 0 && rect.height === 0) return;
      const before = rect.top;
      target.scrollIntoView({ ...options, behavior: 'auto' });
      if (Math.abs(target.getBoundingClientRect().top - before) <= STABLE_PX) return;
      // The correction moved us — files that came into view may be drawn
      // and shift layout once more; loop to settle and verify again.
    }
  } finally {
    window.removeEventListener('wheel', cancel, { capture: true });
    window.removeEventListener('touchstart', cancel, { capture: true });
    window.removeEventListener('keydown', onKeyDown, { capture: true });
  }
}

if (typeof window !== 'undefined') {
  window.ScrollUtils = { scrollIntoViewStable, waitForStablePosition };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scrollIntoViewStable, waitForStablePosition, MAX_CORRECTIONS, STABLE_PX, SETTLE_FRAMES, SETTLE_TIMEOUT_MS };
}
