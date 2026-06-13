// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stable scroll-into-view for the lazily rendered diff panel.
 *
 * Since the large-PR perf fix, expanded file bodies start as empty
 * placeholders (`minHeight` ≈ patch lines × APPROX_DIFF_LINE_PX) and only
 * render real rows when an IntersectionObserver sees them near the viewport.
 * A plain `scrollIntoView()` therefore lands wrong on the first attempt:
 * the browser computes the destination from placeholder heights, then the
 * bodies passed during the scroll render and change height, shifting the
 * target away from where the animation ends. A second attempt "works"
 * because everything along the path has rendered by then.
 *
 * `scrollIntoViewStable()` fixes this by:
 *   1. Rendering the target's own file body first (rows inside a lazy body
 *      don't exist until rendered, and its placeholder height is wrong).
 *   2. Issuing the caller's scroll (smooth behavior preserved).
 *   3. Waiting for the viewport-relative position of the target to stop
 *      moving (scroll animation done AND observer-triggered renders settled),
 *      then re-issuing an instant scroll. If that correction moved the
 *      target, newly revealed placeholders rendered and shifted layout
 *      again — so settle and correct again, up to MAX_CORRECTIONS times.
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
 * Wait until `target`'s viewport-relative top is unchanged for
 * SETTLE_FRAMES consecutive animation frames (or SETTLE_TIMEOUT_MS passes).
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
      const top = target.getBoundingClientRect().top;
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
 * Scroll `target` into view and keep it there while lazy file bodies render.
 * Safe to call on any element; outside a lazy diff it degrades to one
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

  // Render the target's own lazy body first: until then its rows don't
  // exist and the wrapper's height is the placeholder estimate. Skip
  // collapsed wrappers — their body is display:none (zero height), so
  // rendering would pay full renderPatch cost without changing the scroll.
  // Skip file-level comment/suggestion cards too: they live in
  // `.file-comments-zone`, which sits above the lazy body, so rendering the
  // body can't move them — only burn the renderPatch cost we want to avoid.
  const prManager = (typeof window !== 'undefined') ? window.prManager : null;
  const wrapper = target.closest?.('.d2h-file-wrapper');
  if (wrapper && !target.closest?.('.file-comments-zone')
      && !wrapper.classList.contains('collapsed')
      && typeof prManager?.ensureFileBodyRendered === 'function') {
    try {
      await prManager.ensureFileBodyRendered(wrapper);
    } catch (err) {
      console.warn('[ScrollUtils] ensureFileBodyRendered failed; scrolling anyway', err);
    }
    if (!target.isConnected || myGen !== activeGeneration) return;
  }

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
      // snap to the real position when lazy renders shifted the layout.
      const before = target.getBoundingClientRect().top;
      target.scrollIntoView({ ...options, behavior: 'auto' });
      if (Math.abs(target.getBoundingClientRect().top - before) <= STABLE_PX) return;
      // The correction moved us — newly revealed bodies may render and
      // shift layout once more; loop to settle and verify again.
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
