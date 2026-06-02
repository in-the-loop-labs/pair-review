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
 *   - Toggle the `body.tour-active` class for tour-specific chrome styling
 *     (sticky tour-bar offsets on .diff-toolbar / .d2h-file-header, plus
 *     the active-stop annotation highlight). Hunk summaries and tour stops
 *     are NOT mutually exclusive — both can render at once; the user
 *     toggles each independently.
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
    // Set<number> — stop indices whose description the user has expanded
    // via "Show more". Survives unmount/remount within the same tour
    // session (e.g. when the user scrolls past, then back to, the stop)
    // so the description doesn't snap back to its clamped form. Cleared
    // when setStops replaces the tour entirely.
    this._expandedDescriptions = new Set();
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
    // A new stops list silently remaps indices; previously-expanded entries
    // would point at the wrong descriptions. Reset rather than carry stale
    // state across.
    this._expandedDescriptions.clear();
  }

  /**
   * Toggle the page-level "tour is active" body class. Drives tour-specific
   * chrome styling (sticky tour-bar offsets, active-stop highlight) and any
   * future global tour styling. Idempotent. Hunk summaries are NOT hidden
   * by this class — both annotation styles can coexist in the diff.
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

    // Now that the row is in the live DOM, measure the description and
    // append a "Show more" toggle if it actually overflows the clamp.
    // Defer one frame (rAF when available, microtask in jsdom) so the
    // browser has time to apply layout to the just-inserted node before
    // we read `scrollHeight`. The helper is idempotent against re-mounts.
    this._scheduleOverflowCheck(index);
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

    // Chat-about button lives in the header, pinned right of the marker.
    // Icon-only — the title attribute / aria-label carry the meaning. The
    // header CSS uses `justify-content: space-between` so the button hugs
    // the right edge regardless of marker width. Mirrors the comment /
    // suggestion pattern (.ai-action / .ai-action-chat) so the user can
    // pivot from passive read to an interactive conversation about THIS
    // stop.
    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = 'ai-action ai-action-chat tour-annotation-chat-btn';
    chatBtn.title = 'Chat about this tour stop';
    chatBtn.setAttribute('aria-label', 'Chat about this tour stop');
    chatBtn.dataset.stopIndex = String(index);
    chatBtn.innerHTML =
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>' +
      '</svg>';
    chatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openChatForStop(index);
    });
    header.appendChild(chatBtn);

    const title = document.createElement('h4');
    title.className = 'tour-annotation-title';
    title.textContent = stop.title || '';

    // The wrapper carries the CSS line-clamp so we can measure overflow
    // (scrollHeight > clientHeight) on the SAME element that hosts the clamp.
    // The inner <p> stays so existing selectors (.tour-annotation-description)
    // — including tests and the e2e spec — keep working.
    const descriptionWrap = document.createElement('div');
    descriptionWrap.className = 'tour-annotation-description-wrap';
    if (this._expandedDescriptions.has(index)) {
      descriptionWrap.classList.add('expanded');
    }

    const description = document.createElement('p');
    description.className = 'tour-annotation-description';
    description.textContent = stop.description || '';
    descriptionWrap.appendChild(description);

    annotation.appendChild(header);
    annotation.appendChild(title);
    annotation.appendChild(descriptionWrap);

    // Footer is reserved for the "Show more"/"Show less" toggle that the
    // overflow check appends when the description is clamped. Empty when
    // the description fits inline.
    const footer = document.createElement('div');
    footer.className = 'tour-annotation-footer';
    annotation.appendChild(footer);

    cell.appendChild(annotation);
    row.appendChild(cell);

    // Suppress the anchorRow parameter being marked unused by linters that
    // care; it's only here for future enhancements (e.g. computing colspan
    // from the anchor row's siblings).
    void anchorRow;

    return row;
  }

  /**
   * Defer one frame, then evaluate description overflow for `index`. Real
   * browsers need a layout pass before `scrollHeight` is meaningful on a
   * just-inserted node; jsdom returns 0 either way, which is fine — there
   * is no real overflow to detect.
   *
   * Uses `requestAnimationFrame` when present (real browsers), otherwise
   * falls back to a 0ms timer (jsdom). Tests that want to force the
   * overflow path can stub `scrollHeight` / `clientHeight` on the wrapper
   * and call `_evaluateDescriptionOverflow(index)` directly without
   * waiting for the timer.
   *
   * @param {number} index
   */
  _scheduleOverflowCheck(index) {
    const run = () => this._evaluateDescriptionOverflow(index);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else if (typeof setTimeout === 'function') {
      setTimeout(run, 0);
    } else {
      run();
    }
  }

  /**
   * Synchronously read the description wrapper's overflow state and, if
   * it overflows the line-clamp, append a "Show more" toggle to the stop's
   * footer. Idempotent — calling it twice on the same row does NOT add
   * two buttons.
   *
   * Overflow check: `scrollHeight > clientHeight + 1`. The 1px fudge
   * dampens sub-pixel rounding noise on retina displays.
   *
   * Exported (as a regular method) so tests can stub scrollHeight /
   * clientHeight on the wrapper before triggering the check, sidestepping
   * jsdom's zero-layout default.
   *
   * @param {number} index
   */
  _evaluateDescriptionOverflow(index) {
    const row = this._mounted.get(index);
    if (!row || !row.isConnected) return;
    const wrap = row.querySelector('.tour-annotation-description-wrap');
    if (!wrap) return;
    const footer = row.querySelector('.tour-annotation-footer');
    if (!footer) return;
    // Idempotency guard — re-running after a remount must not add a
    // second button.
    if (footer.querySelector('.tour-annotation-show-more-btn')) return;
    // Don't show the toggle when the user already expanded this stop;
    // the wrapper has no overflow to detect in that state.
    if (this._expandedDescriptions.has(index)) {
      this._appendShowMoreButton(index, row, /* expanded */ true);
      return;
    }
    const overflows = wrap.scrollHeight > wrap.clientHeight + 1;
    if (!overflows) return;
    this._appendShowMoreButton(index, row, /* expanded */ false);
  }

  /**
   * Build and insert the "Show more"/"Show less" button into the stop's
   * footer. The Chat about button now lives in the header, so the footer
   * is dedicated to the show-more toggle.
   *
   * @param {number} index
   * @param {HTMLElement} row
   * @param {boolean} expanded
   */
  _appendShowMoreButton(index, row, expanded) {
    const footer = row.querySelector('.tour-annotation-footer');
    if (!footer) return;
    const wrap = row.querySelector('.tour-annotation-description-wrap');
    if (!wrap) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tour-annotation-show-more-btn';
    btn.dataset.stopIndex = String(index);
    btn.textContent = expanded ? 'Show less' : 'Show more';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleDescriptionExpansion(index);
    });
    footer.appendChild(btn);
  }

  /**
   * Flip the expanded state for stop `index`: toggles the wrapper's
   * `.expanded` class and the button label. Persists the index into
   * `_expandedDescriptions` so a remount restores the expanded state.
   *
   * @param {number} index
   */
  _toggleDescriptionExpansion(index) {
    const row = this._mounted.get(index);
    if (!row) return;
    const wrap = row.querySelector('.tour-annotation-description-wrap');
    const btn = row.querySelector('.tour-annotation-show-more-btn');
    if (!wrap || !btn) return;
    const willExpand = !wrap.classList.contains('expanded');
    wrap.classList.toggle('expanded', willExpand);
    btn.textContent = willExpand ? 'Show less' : 'Show more';
    btn.setAttribute('aria-expanded', willExpand ? 'true' : 'false');
    if (willExpand) {
      this._expandedDescriptions.add(index);
    } else {
      this._expandedDescriptions.delete(index);
    }
  }

  /**
   * Open the chat panel pre-focused on the given tour stop. The chat panel
   * builds its own pending-context card; the renderer just supplies the stop
   * metadata (title, description, file/line range, side) and the
   * reviewId from the owning PRManager.
   *
   * No-op when the chat panel isn't mounted (e.g. unit tests without
   * PanelGroup) or when the stop index is out of range. Stays defensive
   * about missing fields — every callsite for chat-open in the codebase
   * tolerates partial context.
   *
   * @param {number} index
   */
  _openChatForStop(index) {
    const stop = this._stops[index];
    if (!stop) return;
    if (typeof window === 'undefined' || !window.chatPanel || typeof window.chatPanel.open !== 'function') {
      return;
    }
    const lineStart = typeof stop.line_start === 'number' ? stop.line_start : null;
    const lineEnd = (typeof stop.line_end === 'number' && stop.line_end >= (lineStart || 0))
      ? stop.line_end
      : lineStart;
    window.chatPanel.open({
      reviewId: this.prManager?.currentPR?.id,
      tourContext: {
        stopIndex: index,
        totalStops: this._stops.length,
        title: stop.title || '',
        description: stop.description || '',
        file: stop.file_path || '',
        line_start: lineStart,
        line_end: lineEnd,
        side: stop.side || 'RIGHT'
      }
    });
  }
}

if (typeof window !== 'undefined') {
  window.TourRenderer = TourRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TourRenderer };
}
