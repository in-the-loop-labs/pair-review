// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * TourBar - Sticky bottom bar shown while a guided tour is active.
 *
 * Displays "Stop N of M" plus Prev/Next/Exit controls. On completion the
 * Prev/Next/Exit chrome swaps for Restart/Close. The bar consumes callbacks
 * from PRManager; it never reaches back into application state.
 *
 * Lifecycle:
 *   const bar = new TourBar({ onPrev, onNext, onExit, onRestart });
 *   bar.mount();             // appends to document.body
 *   bar.setStops(stops);     // initial render
 *   bar.setActiveIndex(0);   // pre-tour state
 *   bar.setCompleted(true);  // toggles to Restart / Close chrome
 *   bar.unmount();
 *
 * Testability: instantiable in jsdom; CommonJS export at the bottom.
 */

// Octicon SVG path data. `milestone` brands the bar overall; `location`
// marks the per-stop navigation chrome (mirrors the inline stop marker).
// Module-scoped names are prefixed so they don't collide with the same
// constants in tour-renderer.js when both are loaded as plain <script> tags
// into the shared global scope.
const TOUR_BAR_MILESTONE_PATH = 'M7.75 0a.75.75 0 0 1 .75.75V3h3.634c.414 0 .814.144 1.13.406l2.501 2.071a1.75 1.75 0 0 1 0 2.696l-2.5 2.07a1.75 1.75 0 0 1-1.131.407H8.5v5.6a.75.75 0 0 1-1.5 0V10.65H3.75A1.75 1.75 0 0 1 2 8.9V4.75C2 3.784 2.784 3 3.75 3H7V.75A.75.75 0 0 1 7.75 0Zm-4 4.5a.25.25 0 0 0-.25.25V8.9c0 .138.112.25.25.25h8.384a.25.25 0 0 0 .16-.058l2.5-2.07a.25.25 0 0 0 0-.386l-2.5-2.07a.25.25 0 0 0-.16-.058H3.75Z';
const TOUR_BAR_LOCATION_PATH = 'm12.596 11.596-3.535 3.536a1.5 1.5 0 0 1-2.122 0l-3.535-3.536a6.5 6.5 0 1 1 9.192-9.193 6.5 6.5 0 0 1 0 9.193Zm-1.06-8.132v-.001a5 5 0 1 0-7.072 7.072L8 14.07l3.536-3.534a5 5 0 0 0 0-7.072ZM8 9a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 9Z';

function tourBarSvgIcon(pathData) {
  return `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="${pathData}"/></svg>`;
}

class TourBar {
  /**
   * @param {Object} callbacks
   * @param {Function} [callbacks.onPrev]    - Called when the user clicks Prev.
   * @param {Function} [callbacks.onNext]    - Called when the user clicks Next.
   * @param {Function} [callbacks.onExit]    - Called when the user clicks Exit.
   * @param {Function} [callbacks.onRestart] - Called when the user clicks Restart (completion state).
   */
  constructor({ onPrev, onNext, onExit, onRestart } = {}) {
    this._onPrev = onPrev || (() => {});
    this._onNext = onNext || (() => {});
    this._onExit = onExit || (() => {});
    this._onRestart = onRestart || (() => {});

    this._stops = [];
    this._activeIndex = -1;
    this._completed = false;

    this._root = null;
    this._progressEl = null;
    this._navEl = null;
    this._prevBtn = null;
    this._nextBtn = null;
    this._exitBtn = null;
    this._restartBtn = null;
    this._closeBtn = null;
  }

  /**
   * Append the bar to `document.body`. Idempotent.
   * @returns {TourBar}
   */
  mount() {
    if (this._root && this._root.isConnected) return this;

    const root = document.createElement('div');
    root.className = 'tour-bar';
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'Guided tour controls');

    const brand = document.createElement('div');
    brand.className = 'tour-bar__brand';
    brand.innerHTML = `${tourBarSvgIcon(TOUR_BAR_MILESTONE_PATH)}<span>Tour</span>`;

    const progress = document.createElement('div');
    progress.className = 'tour-bar__progress';
    progress.textContent = '';

    const nav = document.createElement('div');
    nav.className = 'tour-bar__nav';

    // Prev / Next / Exit (default chrome)
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'tour-bar__prev';
    prevBtn.innerHTML = `${tourBarSvgIcon(TOUR_BAR_LOCATION_PATH)}<span>Prev</span>`;
    prevBtn.addEventListener('click', () => this._onPrev());

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'tour-bar__next';
    nextBtn.innerHTML = `<span>Next</span>${tourBarSvgIcon(TOUR_BAR_LOCATION_PATH)}`;
    nextBtn.addEventListener('click', () => this._onNext());

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'tour-bar__exit';
    exitBtn.textContent = 'Exit';
    exitBtn.addEventListener('click', () => this._onExit());

    // Completion chrome (created up front, toggled by setCompleted)
    const restartBtn = document.createElement('button');
    restartBtn.type = 'button';
    restartBtn.className = 'tour-bar__restart';
    restartBtn.textContent = 'Restart';
    restartBtn.style.display = 'none';
    restartBtn.addEventListener('click', () => this._onRestart());

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tour-bar__close';
    closeBtn.textContent = 'Close';
    closeBtn.style.display = 'none';
    closeBtn.addEventListener('click', () => this._onExit());

    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    nav.appendChild(exitBtn);
    nav.appendChild(restartBtn);
    nav.appendChild(closeBtn);

    root.appendChild(brand);
    root.appendChild(progress);
    root.appendChild(nav);

    document.body.appendChild(root);

    this._root = root;
    this._progressEl = progress;
    this._navEl = nav;
    this._prevBtn = prevBtn;
    this._nextBtn = nextBtn;
    this._exitBtn = exitBtn;
    this._restartBtn = restartBtn;
    this._closeBtn = closeBtn;

    // Initial paint reflects whatever state was set before mount.
    this._render();
    return this;
  }

  /**
   * Remove the bar from the DOM. Safe to call repeatedly.
   */
  unmount() {
    if (this._root && this._root.isConnected) {
      this._root.remove();
    }
    this._root = null;
    this._progressEl = null;
    this._navEl = null;
    this._prevBtn = null;
    this._nextBtn = null;
    this._exitBtn = null;
    this._restartBtn = null;
    this._closeBtn = null;
  }

  /**
   * @param {Array<Object>} stops - The full ordered list of stops.
   */
  setStops(stops) {
    this._stops = Array.isArray(stops) ? stops : [];
    this._render();
  }

  /**
   * @param {number} index - The currently-active stop (0-based) or -1 for none.
   */
  setActiveIndex(index) {
    this._activeIndex = typeof index === 'number' ? index : -1;
    this._render();
  }

  /**
   * @param {boolean} isCompleted - Swap to Restart/Close chrome when true.
   */
  setCompleted(isCompleted) {
    this._completed = isCompleted === true;
    this._render();
  }

  // --- private ------------------------------------------------------------

  _render() {
    if (!this._root) return;
    const total = this._stops.length;
    const visibleIndex = this._activeIndex + 1; // 1-based for display

    if (this._progressEl) {
      if (total === 0) {
        this._progressEl.textContent = '';
      } else if (this._completed) {
        this._progressEl.textContent = `Tour complete (${total} stop${total === 1 ? '' : 's'})`;
      } else if (this._activeIndex < 0) {
        this._progressEl.textContent = `${total} stop${total === 1 ? '' : 's'}`;
      } else {
        this._progressEl.textContent = `Stop ${visibleIndex} of ${total}`;
      }
    }

    if (this._completed) {
      if (this._prevBtn) this._prevBtn.style.display = 'none';
      if (this._nextBtn) this._nextBtn.style.display = 'none';
      if (this._exitBtn) this._exitBtn.style.display = 'none';
      if (this._restartBtn) this._restartBtn.style.display = '';
      if (this._closeBtn) this._closeBtn.style.display = '';
    } else {
      if (this._prevBtn) this._prevBtn.style.display = '';
      if (this._nextBtn) this._nextBtn.style.display = '';
      if (this._exitBtn) this._exitBtn.style.display = '';
      if (this._restartBtn) this._restartBtn.style.display = 'none';
      if (this._closeBtn) this._closeBtn.style.display = 'none';

      // Disable Prev at first stop; disable Next at last (no auto-completion
      // happens in the bar — the orchestrator advances past the end to set
      // completed state).
      if (this._prevBtn) {
        this._prevBtn.disabled = this._activeIndex <= 0;
      }
      if (this._nextBtn) {
        // Next remains enabled on the last stop so the user can advance
        // into completion state.
        this._nextBtn.disabled = total === 0;
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.TourBar = TourBar;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TourBar };
}
