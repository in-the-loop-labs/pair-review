// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * TourRenderer - Inline tour-stop annotations + body-level tour mode.
 *
 * Responsibilities:
 *   - Look up the DOM anchor row for a stop by (file_path, side, line_start).
 *   - Mount a styled <tr class="tour-annotation-row"> immediately above the
 *     anchor row, carrying the stop's title + description and Prev/Next
 *     buttons that callback into the owning PRManager.
 *   - Track the currently-highlighted row and toggle the `active-stop` class.
 *   - Toggle the `body.tour-active` class so existing summary CSS hides
 *     summary annotations while a tour is in progress (no JS state to
 *     reconcile on exit; CSS handles it).
 *
 * Stops are line-range based (see plans/semantic-hunk-summaries-and-tours.md);
 * there is NO content_hash on stops. The anchor row is found via the
 * diff-renderer's existing `data-line-number` + `data-side` attributes.
 *
 * A stop whose anchor row is missing (file filtered out, line not in the
 * rendered diff, etc.) is skipped with a console.warn — the caller treats
 * a null return as "couldn't render, advance to the next stop".
 */

// Prefixed to avoid collision with TourBar.js when both load as plain
// <script> tags into the shared global scope.
const TOUR_RENDERER_LOCATION_PATH = 'm12.596 11.596-3.535 3.536a1.5 1.5 0 0 1-2.122 0l-3.535-3.536a6.5 6.5 0 1 1 9.192-9.193 6.5 6.5 0 0 1 0 9.193Zm-1.06-8.132v-.001a5 5 0 1 0-7.072 7.072L8 14.07l3.536-3.534a5 5 0 0 0 0-7.072ZM8 9a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 9Z';

/**
 * Escape a string for inclusion in a CSS attribute selector. Prefers the
 * native `CSS.escape` when available (real browsers) and falls back to a
 * minimal escape for jsdom / older runtimes that don't expose it.
 * @param {string} value
 * @returns {string}
 */
function tourRendererEscapeAttr(value) {
  const s = String(value);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  // Fallback: backslash-escape anything that isn't a safe attribute char.
  return s.replace(/[^a-zA-Z0-9_\-./]/g, (ch) => `\\${ch}`);
}

class TourRenderer {
  /**
   * @param {Object} prManager - Owning PRManager. Callbacks invoke
   *   prManager._advanceTour / prManager._exitTour so the renderer doesn't
   *   own navigation state.
   */
  constructor(prManager) {
    this.prManager = prManager;
    this._stops = [];
    // Map<number, HTMLTableRowElement> — stop index -> mounted row
    this._mounted = new Map();
    // Set<string> — file paths that we auto-expanded during this tour so we
    // can re-collapse them on exit. Tracking this lets us preserve the
    // user's pre-tour collapse state (the user-facing `collapsedFiles` set
    // on PRManager) instead of silently clobbering it.
    this._autoExpanded = new Set();
    // Cache the user's motion preference at construction so scrollIntoView
    // honors it on every navigation. Reading matchMedia each call would
    // still work; caching just avoids the lookup.
    this._reduceMotion = (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
    );
  }

  /**
   * Stash the stops list. Does NOT mount anything — call `mountStop` per
   * stop as the user navigates.
   *
   * Any previously-mounted annotation rows are unmounted, because `_mounted`
   * is keyed by integer index into `_stops` and a fresh stops list silently
   * remaps those indices to different entries (or none at all). Leaving
   * stale rows behind would orphan them in the DOM.
   *
   * @param {Array<Object>} stops
   */
  setStops(stops) {
    this.unmountAll();
    this._stops = Array.isArray(stops) ? stops : [];
  }

  /**
   * Toggle the page-level "tour is active" body class. Drives summary
   * hiding (CSS) and any future global styling. Idempotent.
   * @param {boolean} isActive
   */
  setActive(isActive) {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('tour-active', isActive === true);
  }

  /**
   * Mount the annotation row for the stop at `index`. Returns the row, or
   * null if no anchor could be located.
   *
   * If the target file's wrapper is collapsed, expand it via the
   * prManager's `toggleFileCollapse` so the renderer and PRManager's
   * `collapsedFiles` set stay in sync. The expansion is recorded on
   * `_autoExpanded` so `unmountAll` can re-collapse on tour exit, restoring
   * the user's pre-tour collapse state.
   *
   * If `toggleFileCollapse` is missing we refuse to expand rather than
   * strip the `collapsed` class directly — diverging the DOM from
   * `collapsedFiles` would leave the file-tree and viewed-badge state
   * lying.
   *
   * @param {number} index
   * @returns {HTMLTableRowElement|null}
   */
  mountStop(index) {
    const stop = this._stops[index];
    if (!stop) return null;

    if (this._mounted.has(index)) {
      const existing = this._mounted.get(index);
      if (existing && existing.isConnected) return existing;
      this._mounted.delete(index);
    }

    const filePath = stop.file_path;
    const side = stop.side || 'RIGHT';
    const lineStart = stop.line_start;
    // `line_end` may be missing on legacy/older stops; fall back to
    // `line_start` so the range scan still works.
    const lineEnd = (typeof stop.line_end === 'number' && stop.line_end >= lineStart)
      ? stop.line_end
      : lineStart;

    if (!filePath || typeof lineStart !== 'number') {
      console.warn('[TourRenderer] stop missing file_path/line_start; skipping', stop);
      return null;
    }

    const wrapper = document.querySelector(
      `.d2h-file-wrapper[data-file-name="${tourRendererEscapeAttr(filePath)}"]`
    );
    if (!wrapper) {
      console.warn(`[TourRenderer] no wrapper for ${filePath}; skipping stop ${index}`);
      return null;
    }

    // Look up the anchor row BEFORE expanding. Collapsed wrappers hide
    // .d2h-file-body via CSS (`display: none`) but the rows are still in
    // the DOM, so the query succeeds either way. Only expand once we've
    // confirmed a row to mount against — otherwise an unmountable stop
    // would leave the file expanded for no benefit.
    //
    // The validator accepts any stop whose [line_start, line_end] range
    // intersects the changed-line set, so the EXACT line_start row may
    // not be in the rendered diff (e.g. line_start is a context line that
    // got folded). Scan forward through the range and anchor on the first
    // row that exists.
    let anchorRow = null;
    for (let n = lineStart; n <= lineEnd; n++) {
      const candidate = wrapper.querySelector(
        `tr[data-line-number="${n}"][data-side="${side}"]`
      );
      if (candidate) {
        anchorRow = candidate;
        break;
      }
    }
    if (!anchorRow) {
      console.warn(
        `[TourRenderer] no anchor row for ${filePath}:${lineStart}-${lineEnd} (${side}); ` +
        'stop will be skipped'
      );
      return null;
    }

    // We have an anchor — now safe to expand if the file was collapsed.
    // Route through PRManager.toggleFileCollapse so the user-facing
    // `collapsedFiles` set stays in sync with the DOM; refuse to expand
    // (and bail) when the API is missing rather than strip the class
    // directly, which would silently desync the two views of collapse
    // state.
    if (wrapper.classList.contains('collapsed')) {
      if (this.prManager && typeof this.prManager.toggleFileCollapse === 'function') {
        try {
          this.prManager.toggleFileCollapse(filePath);
          // Record so unmountAll() can re-collapse on tour exit.
          this._autoExpanded.add(filePath);
        } catch (err) {
          console.warn(
            '[TourRenderer] toggleFileCollapse failed; skipping stop',
            err
          );
          return null;
        }
      } else {
        console.warn(
          '[TourRenderer] prManager.toggleFileCollapse missing; ' +
          'refusing to strip collapsed class — stop skipped'
        );
        return null;
      }
    }

    const row = this._buildAnnotationRow(index, stop, anchorRow);
    anchorRow.parentNode.insertBefore(row, anchorRow);
    this._mounted.set(index, row);
    return row;
  }

  /**
   * Remove the mounted annotation for `index`. Returns true if a row was
   * removed.
   * @param {number} index
   * @returns {boolean}
   */
  unmountStop(index) {
    const row = this._mounted.get(index);
    if (!row) return false;
    if (row.isConnected) row.remove();
    this._mounted.delete(index);
    return true;
  }

  /**
   * Remove every mounted annotation. Call on tour exit.
   *
   * Also re-collapses any files we auto-expanded during the tour by
   * calling `toggleFileCollapse` on each path in `_autoExpanded`. This
   * restores the user's pre-tour collapse state instead of silently
   * leaving files expanded.
   */
  unmountAll() {
    for (const row of this._mounted.values()) {
      if (row && row.isConnected) row.remove();
    }
    this._mounted.clear();

    if (
      this._autoExpanded.size > 0 &&
      this.prManager &&
      typeof this.prManager.toggleFileCollapse === 'function'
    ) {
      for (const filePath of this._autoExpanded) {
        try {
          // Only re-collapse if the file is still expanded — the user may
          // have toggled it manually during the tour, in which case we
          // honor their explicit action and leave it alone.
          const wrapper = document.querySelector(
            `.d2h-file-wrapper[data-file-name="${tourRendererEscapeAttr(filePath)}"]`
          );
          if (wrapper && !wrapper.classList.contains('collapsed')) {
            this.prManager.toggleFileCollapse(filePath);
          }
        } catch (err) {
          console.warn('[TourRenderer] re-collapse failed for', filePath, err);
        }
      }
    }
    this._autoExpanded.clear();
  }

  /**
   * Smoothly scroll the mounted row for `index` into view, centering it.
   * No-op if the row isn't mounted.
   * @param {number} index
   */
  scrollToStop(index) {
    const row = this._mounted.get(index);
    if (!row || !row.isConnected) return;
    row.scrollIntoView({
      behavior: this._reduceMotion ? 'auto' : 'smooth',
      block: 'center'
    });
  }

  /**
   * Move the `active-stop` class to the stop at `index`. Removes it from
   * every other mounted row.
   * @param {number} index
   */
  highlightActive(index) {
    for (const [i, row] of this._mounted.entries()) {
      if (!row) continue;
      row.classList.toggle('active-stop', i === index);
    }
  }

  // --- private ------------------------------------------------------------

  _buildAnnotationRow(index, stop, anchorRow) {
    const row = document.createElement('tr');
    row.className = 'tour-annotation-row';
    row.dataset.stopIndex = String(index);

    const cell = document.createElement('td');
    cell.colSpan = 2;
    cell.className = 'tour-annotation-cell';

    const annotation = document.createElement('div');
    annotation.className = 'tour-annotation';

    const header = document.createElement('div');
    header.className = 'tour-annotation-header';

    const marker = document.createElement('span');
    marker.className = 'tour-stop-marker';
    marker.innerHTML =
      `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">` +
      `<path d="${TOUR_RENDERER_LOCATION_PATH}"/></svg>` +
      `<span>Stop ${index + 1} of ${this._stops.length}</span>`;
    header.appendChild(marker);

    const title = document.createElement('h4');
    title.className = 'tour-annotation-title';
    title.textContent = stop.title || '';

    const description = document.createElement('p');
    description.className = 'tour-annotation-description';
    description.textContent = stop.description || '';

    annotation.appendChild(header);
    annotation.appendChild(title);
    annotation.appendChild(description);

    cell.appendChild(annotation);
    row.appendChild(cell);

    // Suppress the anchorRow parameter being marked unused by linters that
    // care; it's only here for future enhancements (e.g. computing colspan
    // from the anchor row's siblings).
    void anchorRow;

    return row;
  }
}

if (typeof window !== 'undefined') {
  window.TourRenderer = TourRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TourRenderer };
}
