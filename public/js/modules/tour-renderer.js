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
 *
 * Before calling `mountStop`, the caller should `await prepareStop(index)`,
 * which makes the stop's lines mountable when possible:
 *   - Files not present in the diff at all are auto-added via
 *     PRManager.ensureContextFile (the same surface used by the AI
 *     suggestion "open context" flow). Auto-added files are tracked on
 *     `_autoAddedContextFileIds` and removed on tour exit so they don't
 *     leak into the user's persistent context-files list.
 *   - Folded gaps covering the stop's [line_start, line_end] range are
 *     expanded via PRManager.ensureLinesVisible so the anchor row exists
 *     by the time mountStop runs its DOM scan.
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
    // Set<number> — context-file IDs we auto-added during this tour (via
    // prepareStop -> prManager.ensureContextFile) for files outside the
    // PR diff. Removed in unmountAll so the user's persistent context-files
    // list isn't polluted by transient tour state.
    this._autoAddedContextFileIds = new Set();
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
   * Make the stop at `index` mountable by ensuring its file is present in
   * the diff view and the rows covering its [line_start, line_end] range
   * are unfolded. Safe to call repeatedly — both the file-add path
   * (`ensureContextFile`) and the gap-expand path (`ensureLinesVisible`)
   * are idempotent.
   *
   * Resolves to `true` when the prep succeeded enough that `mountStop`
   * has a chance of finding an anchor row, `false` on a hard failure
   * (no PRManager, no stop, file fetch/POST failed). A `true` return is
   * NOT a promise that `mountStop` will succeed — genuinely missing data
   * (bad line numbers, file not in repo) still falls through to mountStop
   * returning null. The caller's probe loop handles that.
   *
   * Tracks auto-additions and auto-expansions on `_autoAddedContextFileIds`
   * and `_autoExpanded` (via the existing mountStop expand path) so
   * `unmountAll` can restore pre-tour state on exit.
   *
   * @param {number} index
   * @returns {Promise<boolean>}
   */
  async prepareStop(index) {
    const stop = this._stops[index];
    if (!stop || !this.prManager) return false;

    // Capture the open-generation ONCE at entry. Every await below is a
    // suspension window — if `_tourGen` bumps while we're suspended, the
    // tour we started preparing for is gone (Escape, exit, reopen) and
    // `unmountAll` has already run with an empty snapshot of
    // `_autoAddedContextFileIds`. Anything we add after that snapshot would
    // orphan, so we roll back directly on stale.
    const startGen = this.prManager._tourGen;
    const isStale = () => this.prManager._tourGen !== startGen;

    const filePath = stop.file_path;
    const lineStart = stop.line_start;
    if (!filePath || typeof lineStart !== 'number') return false;

    const lineEnd = (typeof stop.line_end === 'number' && stop.line_end >= lineStart)
      ? stop.line_end
      : lineStart;
    const side = stop.side || 'RIGHT';

    // 1) Ensure the file's wrapper is in the DOM. If the file isn't in the
    //    PR diff, route through ensureContextFile — which adds it as a
    //    context file (or PATCHes an existing context file to cover the
    //    range). Track the new id so unmountAll can DELETE it on exit and
    //    not leave the user with surprise persistent entries.
    const existingWrapper = document.querySelector(
      `.d2h-file-wrapper[data-file-name="${tourRendererEscapeAttr(filePath)}"]`
    );
    if (!existingWrapper && typeof this.prManager.ensureContextFile === 'function') {
      const wasAlreadyContext = Array.isArray(this.prManager.contextFiles) &&
        this.prManager.contextFiles.some((cf) => cf.file === filePath);
      try {
        const result = await this.prManager.ensureContextFile(filePath, lineStart, lineEnd);
        // Only track the id when WE added it (not when an existing context
        // file already covered or got merged-with this range — leaving
        // user-created entries alone is the right default).
        if (
          result &&
          result.type === 'context' &&
          !wasAlreadyContext &&
          result.contextFile &&
          result.contextFile.id != null
        ) {
          if (isStale()) {
            // Tour exited while the POST was in flight. unmountAll already
            // ran with an empty snapshot — tracking the id now would orphan
            // it forever. Roll back directly, fire-and-forget so the
            // mid-exit user isn't blocked on a DELETE.
            if (typeof this.prManager.removeContextFile === 'function') {
              try {
                const undo = this.prManager.removeContextFile(result.contextFile.id);
                if (undo && typeof undo.catch === 'function') undo.catch(() => {});
              } catch (_) {
                // best-effort rollback
              }
            }
            return false;
          }
          this._autoAddedContextFileIds.add(result.contextFile.id);
        }
      } catch (err) {
        console.warn('[TourRenderer] ensureContextFile failed for', filePath, err);
        // Fall through — mountStop will return null and the probe advances.
      }
    }

    // Skip the gap-unfold on a dead tour. Gap-unfolds aren't tracked in
    // _autoExpanded (that's collapse-state, not unfold-state) so they
    // don't leak persistent state, but they ARE visible UI churn the user
    // didn't ask for after pressing Escape.
    if (isStale()) return false;

    // 2) Unfold any gap covering the stop's range. Safe no-op when the
    //    rows are already visible. Works on both diff-file and context-file
    //    wrappers (both produce tr[data-line-number][data-side] rows).
    if (typeof this.prManager.ensureLinesVisible === 'function') {
      try {
        await this.prManager.ensureLinesVisible([
          { file: filePath, line_start: lineStart, line_end: lineEnd, side }
        ]);
      } catch (err) {
        console.warn('[TourRenderer] ensureLinesVisible failed for', filePath, err);
        // Fall through — the anchor scan may still succeed if a row in
        // the range happened to render via a different path.
      }
    }

    return true;
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
   * Also restores pre-tour state:
   *   - Re-collapses any files in `_autoExpanded` (via toggleFileCollapse).
   *   - Deletes any context files in `_autoAddedContextFileIds` (via
   *     removeContextFile) so transient tour-injected files don't
   *     persist in the user's context-files list.
   *
   * Both restorations are best-effort — failures are logged and ignored
   * so a partially-cleaned exit still tears down the tour UI.
   *
   * Returns a Promise that resolves once every issued `removeContextFile`
   * call (and its `loadContextFiles` reload) has settled. Callers that
   * need to observe a clean DOM before reading wrappers — restart, reopen
   * — should await it. The promise never rejects (errors are caught and
   * logged), so `await` is safe without try/catch.
   *
   * @returns {Promise<void>}
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

    const pending = [];
    if (
      this._autoAddedContextFileIds.size > 0 &&
      this.prManager &&
      typeof this.prManager.removeContextFile === 'function'
    ) {
      // Snapshot + clear before iterating so a re-entrant unmountAll
      // (e.g. if removeContextFile triggers a re-render hook that loops
      // back) doesn't try to delete the same ids twice.
      const ids = Array.from(this._autoAddedContextFileIds);
      this._autoAddedContextFileIds.clear();
      for (const id of ids) {
        try {
          const result = this.prManager.removeContextFile(id);
          if (result && typeof result.then === 'function') {
            // Attach a catch so rejections don't leak as unhandled, and
            // collect the wrapped promise so the caller's drain await
            // observes settlement (success OR failure).
            pending.push(result.catch((err) => {
              console.warn('[TourRenderer] removeContextFile rejected for', id, err);
            }));
          }
        } catch (err) {
          console.warn('[TourRenderer] removeContextFile failed for', id, err);
        }
      }
    }
    // allSettled never rejects; safe to await without try/catch.
    return Promise.allSettled(pending);
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
