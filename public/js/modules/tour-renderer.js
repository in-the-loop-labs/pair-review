// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * TourRenderer - Inline tour-stop annotations + body-level tour mode.
 *
 * A stop's file is a file of the diff viewer (a changed file or a context
 * file; a file outside the diff is added as a context file first). The stop
 * mounts as a custom `'tour-stop'` annotation (via PierreBridge.addAnnotation),
 * which the bridge slots BELOW its anchor line into the file's light DOM as a
 * `<div class="tour-annotation-row">`. The card inside is `.tour-annotation`
 * (title, full description, Chat-about button; Prev/Next lives on the
 * TourBar), with the stop's `data-stop-index`.
 *
 * Responsibilities:
 *   - Resolve a stop's anchor line by (file_path, side, [line_start, line_end])
 *     and mount its annotation.
 *   - Track the currently-highlighted stop and toggle the `active-stop` class.
 *   - Toggle the `body.tour-active` class for tour-specific chrome styling
 *     (sticky tour-bar offsets on .diff-toolbar / .d2h-file-header, plus
 *     the active-stop annotation highlight). Hunk summaries and tour stops
 *     are NOT mutually exclusive — both can render at once; the user
 *     toggles each independently.
 *
 * Stops are line-range based (see plans/semantic-hunk-summaries-and-tours.md);
 * there is NO content_hash on stops.
 *
 * A stop whose anchor is missing (file filtered out, line not in the rendered
 * diff, etc.) is skipped with a console.warn — the caller treats a null
 * return as "couldn't render, advance to the next stop".
 *
 * Before calling `mountStop`, the caller should `await prepareStop(index)`,
 * which makes the stop's lines mountable when possible:
 *   - Files not present in the diff at all are auto-added via
 *     PRManager.ensureContextFile (the same surface used by the AI
 *     suggestion "open context" flow). Auto-added files are tracked on
 *     `_autoAddedContextFileIds` and removed on tour exit so they don't
 *     leak into the user's persistent context-files list.
 *   - Folded gaps covering the stop's [line_start, line_end] range are
 *     expanded via PRManager.ensureLinesVisible so the anchor line is one
 *     the diff shows by the time mountStop looks for it.
 */

// Prefixed to avoid collision with TourBar.js when both load as plain
// <script> tags into the shared global scope.
const TOUR_RENDERER_LOCATION_PATH = 'm12.596 11.596-3.535 3.536a1.5 1.5 0 0 1-2.122 0l-3.535-3.536a6.5 6.5 0 1 1 9.192-9.193 6.5 6.5 0 0 1 0 9.193Zm-1.06-8.132v-.001a5 5 0 1 0-7.072 7.072L8 14.07l3.536-3.534a5 5 0 0 0 0-7.072ZM8 9a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 9Z';

class TourRenderer {
  /**
   * @param {Object} prManager - Owning PRManager. Callbacks invoke
   *   prManager._advanceTour / prManager._exitTour so the renderer doesn't
   *   own navigation state.
   */
  constructor(prManager) {
    this.prManager = prManager;
    this._stops = [];
    // Map<number, HTMLElement> — stop index -> the last-known annotation
    // element, the `<div class="tour-annotation-row">` slotted into the
    // file's light DOM. The cached reference can go stale (the viewer drops
    // and re-attaches elements); always re-resolve the live node via
    // `_resolveRow(index)` before operating on it.
    this._mounted = new Map();
    // Map<number, {filePath, side, id, anchorLine}> — the mounted stops, each
    // an annotation of the diff viewer. Holds the metadata needed to remove
    // the annotation (bridge.removeAnnotation) and to ask the bridge for the
    // stop's element again.
    this._pierreMounts = new Map();
    // The index highlighted as the active stop, or -1. Tracked on the
    // instance (not just the DOM) because a pierre annotation element is
    // rebuilt on every file rerender — the renderer callback re-applies the
    // `active-stop` class from this value so the highlight survives churn.
    this._activeIndex = -1;
    // One-time guard: the 'tour-stop' custom annotation renderer is
    // registered on the shared PierreBridge exactly once (it persists on the
    // bridge across tours).
    this._tourStopRendererRegistered = false;
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
    this._activeIndex = -1;
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
    //    "In the pane" is asked of data: a file the bridge holds is there
    //    whether or not it has an element (the viewer draws only what is
    //    near the viewport).
    const inPane = this._isPierreFile(filePath);
    if (!inPane && typeof this.prManager.ensureContextFile === 'function') {
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
    //    lines are already shown. Works on changed files and context files.
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
   * If the target file is collapsed (asked of data: PRManager.isFileCollapsed),
   * open it through the page's one writer, `setFileCollapsed`, so the
   * page's state, the header and the viewer stay in sync. The expansion is
   * recorded on `_autoExpanded` so `unmountAll` can re-collapse on tour
   * exit, restoring the user's pre-tour collapse state.
   *
   * If `setFileCollapsed` is missing we refuse to expand rather than open
   * the file another way — diverging the viewer from `collapsedFiles` would
   * leave the file-tree and viewed-badge state lying.
   *
   * Async because `setFileCollapsed` is async. The caller (`_advanceTour`)
   * awaits this so the file is expanded before `scrollToStop` runs —
   * otherwise a stop inside a just-expanded file could be scrolled to while
   * its rows are still hidden.
   *
   * @param {number} index
   * @returns {Promise<HTMLElement|null>}
   */
  async mountStop(index) {
    const stop = this._stops[index];
    if (!stop) return null;

    const filePath = stop.file_path;
    const side = stop.side || 'RIGHT';
    const lineStart = stop.line_start;
    // `line_end` may be missing on older stops; fall back to
    // `line_start` so the range scan still works.
    const lineEnd = (typeof stop.line_end === 'number' && stop.line_end >= lineStart)
      ? stop.line_end
      : lineStart;

    if (!filePath || typeof lineStart !== 'number') {
      console.warn('[TourRenderer] stop missing file_path/line_start; skipping', stop);
      return null;
    }

    // A file the viewer does not hold (it could not be added to the pane)
    // has no line to mount the stop under.
    if (!this._isPierreFile(filePath)) {
      console.warn(`[TourRenderer] no wrapper for ${filePath}; skipping stop ${index}`);
      return null;
    }
    return this._mountStopPierre(index, stop, filePath, side, lineStart, lineEnd);
  }

  /**
   * Mount a stop into a file of the diff viewer as a `'tour-stop'` annotation.
   *
   * The bridge slots the annotation BELOW its anchor line into the file's
   * light DOM (so page CSS + inline handlers work). We anchor at `line_end`
   * (parity with how suggestions anchor; the banner then reads as describing
   * the code above it), scanning backward through the range to the first
   * line the file's diff shows (isLineInDiff, collapsed or not) so a stop
   * whose exact line_end sits in a still-folded gap still finds a home.
   *
   * The `setFileCollapsed` await is a suspension window guarded against a
   * mid-flight tour teardown — see the inline note. Returns the slotted `<div class="tour-annotation-row">`, or null
   * when no line in the range is mountable (probe advances).
   *
   * @returns {Promise<HTMLElement|null>}
   */
  async _mountStopPierre(index, stop, filePath, side, lineStart, lineEnd) {
    const bridge = this.prManager && this.prManager.pierreBridge;
    if (!bridge) return null;

    // Capture the open-generation ONCE at entry, so the `setFileCollapsed`
    // await below can't record state for a torn-down tour.
    const startGen = this.prManager?._tourGen;
    const isStale = () => this.prManager?._tourGen !== startGen;

    // Idempotent remount: if the file still has the annotation, reuse its
    // element. If it went missing (the file was re-rendered from scratch,
    // dropping its annotations), fall through and re-add.
    if (this._pierreMounts.has(index)) {
      const existing = this._queryPierreRow(filePath, index);
      if (existing) {
        this._mounted.set(index, existing);
        return existing;
      }
      this._pierreMounts.delete(index);
      this._mounted.delete(index);
    }

    // Pick the anchor line: prefer line_end, scan back to line_start for the
    // first line the file's diff shows. Asked of the bridge's data
    // (isLineInDiff: the hunks of the metadata it last published, so it is
    // right while an async repaint is in flight), and whether or not the
    // file is collapsed: a collapsed file is opened below. No such line in
    // range → unmountable; return null so the navigator probes onward.
    let anchorLine = null;
    if (typeof bridge.isLineInDiff === 'function') {
      for (let n = lineEnd; n >= lineStart; n--) {
        if (bridge.isLineInDiff(filePath, n, side)) {
          anchorLine = n;
          break;
        }
      }
    }
    if (anchorLine == null) {
      console.warn(
        `[TourRenderer] no visible line for ${filePath}:${lineStart}-${lineEnd} (${side}); ` +
        'pierre stop will be skipped'
      );
      return null;
    }

    // Open a collapsed file through the page's one writer of the collapsed
    // state (PRManager.setFileCollapsed), so `collapsedFiles`, the header
    // and the viewer agree; refuse (bail) when the page has no such writer.
    // Whether the file is collapsed is asked of the page's data
    // (isFileCollapsed): a file that is scrolled away has no element. A
    // collapsed file draws no lines, so the stop would have no place on
    // screen.
    if (this._isFileCollapsed(filePath)) {
      if (this.prManager && typeof this.prManager.setFileCollapsed === 'function') {
        try {
          await this.prManager.setFileCollapsed(filePath, false);
          // Suspension window: if the tour exited/restarted while the expand
          // was in flight, `unmountAll` already ran against a snapshot that
          // excludes this stop. Recording `_autoExpanded` / adding the
          // annotation now would orphan both. Bail without mutating state.
          if (isStale()) return null;
          this._autoExpanded.add(filePath);
        } catch (err) {
          console.warn('[TourRenderer] setFileCollapsed failed; skipping pierre stop', err);
          return null;
        }
      } else {
        console.warn(
          '[TourRenderer] prManager.setFileCollapsed missing; ' +
          'refusing to open the file another way — pierre stop skipped'
        );
        return null;
      }
    }

    // Ensure the 'tour-stop' renderer is registered on the bridge, then add
    // the annotation. The anchor line was chosen from the bridge's visibility
    // oracle, so the annotation has a line to sit under; whether its element
    // is in the document yet is not asked (it is not while a new diff of the
    // file is still awaiting display).
    this._ensureTourStopRendererRegistered();
    const id = this._pierreAnnotationId(index);
    // Record BEFORE adding so the renderer callback (fired synchronously by
    // addAnnotation) can resolve the active-stop state for this index.
    this._pierreMounts.set(index, { filePath, side, id, anchorLine });
    if (typeof bridge.addAnnotation === 'function') {
      bridge.addAnnotation(filePath, {
        lineNumber: anchorLine,
        side,
        type: 'tour-stop',
        data: { index },
        id,
      });
    }

    const row = this._queryPierreRow(filePath, index);
    if (!row) {
      // The bridge did not take the annotation (it has no such file) or the
      // stop could not be built. Roll back so we don't leave a phantom mount.
      this._pierreMounts.delete(index);
      if (typeof bridge.removeAnnotation === 'function') {
        try { bridge.removeAnnotation(filePath, id); } catch (_) { /* best effort */ }
      }
      console.warn(
        `[TourRenderer] pierre annotation was not created for ${filePath}:${anchorLine} (${side}); ` +
        'stop will be skipped'
      );
      return null;
    }
    this._mounted.set(index, row);
    return row;
  }

  // --- pierre helpers -----------------------------------------------------

  /**
   * Whether a file of the pane is collapsed, from data: the page's answer
   * (PRManager.isFileCollapsed), else the viewer's record of the file. Never
   * the element: a file that is scrolled away has none.
   * @param {string} filePath
   * @returns {boolean|null} null when neither knows the file
   */
  _isFileCollapsed(filePath) {
    const pm = this.prManager;
    if (pm && typeof pm.isFileCollapsed === 'function') {
      const collapsed = pm.isFileCollapsed(filePath);
      return typeof collapsed === 'boolean' ? collapsed : null;
    }
    const record = pm?.pierreBridge?.files?.get?.(filePath);
    return record ? record.collapsed === true : null;
  }

  /**
   * Whether `filePath` is a file of the diff viewer (it has a record there,
   * mounted or not).
   * @param {string} filePath
   * @returns {boolean}
   */
  _isPierreFile(filePath) {
    const files = this.prManager && this.prManager.pierreBridge && this.prManager.pierreBridge.files;
    return !!(files && typeof files.has === 'function' && files.has(filePath));
  }

  /**
   * Stable annotation id for the stop at `index`.
   * @param {number} index
   * @returns {string}
   */
  _pierreAnnotationId(index) {
    return `tour-stop-${index}`;
  }

  /**
   * The annotation element of a pierre stop, by annotation id, through the
   * bridge. The bridge hands back the element it built for the stop whether
   * or not the diff has it on screen right now, and builds it when it has not
   * been built yet, so an element that is not attached to the document is
   * still the stop's element. null means the file no longer has the
   * annotation (the file was re-rendered from scratch).
   * @param {string} filePath
   * @param {number} index
   * @returns {HTMLElement|null}
   */
  _queryPierreRow(filePath, index) {
    const bridge = this.prManager?.pierreBridge;
    if (!bridge || typeof bridge.getAnnotationElement !== 'function') return null;
    return bridge.getAnnotationElement(filePath, this._pierreAnnotationId(index), { create: true }) || null;
  }

  /**
   * Resolve the annotation element of a mounted stop: asked of the bridge
   * again (the `_mounted` cache is refreshed). Returns null when nothing is
   * mounted for the index.
   * @param {number} index
   * @returns {HTMLElement|null}
   */
  _resolveRow(index) {
    const pierre = this._pierreMounts.get(index);
    if (!pierre) {
      this._mounted.delete(index);
      return null;
    }
    const el = this._queryPierreRow(pierre.filePath, index);
    if (el) this._mounted.set(index, el);
    else this._mounted.delete(index);
    return el;
  }

  /**
   * Register the `'tour-stop'` custom annotation renderer on the shared
   * PierreBridge (once). The callback receives (data, id, fileName) and
   * returns the annotation card element the bridge slots below the anchor
   * line. It is re-invoked on every file rerender, so it rebuilds the card
   * from CURRENT state (active-stop) each time.
   */
  _ensureTourStopRendererRegistered() {
    if (this._tourStopRendererRegistered) return;
    const bridge = this.prManager && this.prManager.pierreBridge;
    if (!bridge || typeof bridge.registerAnnotationRenderer !== 'function') return;
    bridge.registerAnnotationRenderer('tour-stop', (data) => {
      const index = data && typeof data.index === 'number' ? data.index : -1;
      const stop = this._stops[index];
      if (!stop) return null;
      const row = this._buildAnnotationDiv(index, stop);
      return row;
    });
    this._tourStopRendererRegistered = true;
  }

  /**
   * Remove the mounted annotation for `index`. Returns true if a row was
   * removed.
   * @param {number} index
   * @returns {boolean}
   */
  unmountStop(index) {
    // Remove via the bridge (which redraws the file without this
    // annotation). Do NOT touch the DOM node directly — the bridge owns its
    // lifecycle.
    const pierre = this._pierreMounts.get(index);
    this._mounted.delete(index);
    if (!pierre) return false;
    this._pierreMounts.delete(index);
    const bridge = this.prManager && this.prManager.pierreBridge;
    if (bridge && typeof bridge.removeAnnotation === 'function') {
      try {
        bridge.removeAnnotation(pierre.filePath, pierre.id);
      } catch (err) {
        console.warn('[TourRenderer] removeAnnotation failed for', pierre.id, err);
      }
    }
    return true;
  }

  /**
   * Remove every mounted annotation. Call on tour exit.
   *
   * Also restores pre-tour state:
   *   - Re-collapses any files in `_autoExpanded` that are still expanded
   *     (via setFileCollapsed; asked of data, so a file without an element
   *     is re-collapsed too).
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
    // Remove each stop via the bridge (which redraws the file without the
    // annotation). The DOM nodes are the bridge's.
    if (this._pierreMounts.size > 0) {
      const bridge = this.prManager && this.prManager.pierreBridge;
      for (const [index, pierre] of this._pierreMounts) {
        if (bridge && typeof bridge.removeAnnotation === 'function') {
          try {
            bridge.removeAnnotation(pierre.filePath, pierre.id);
          } catch (err) {
            console.warn('[TourRenderer] removeAnnotation failed for', pierre.id, err);
          }
        }
        this._mounted.delete(index);
      }
      this._pierreMounts.clear();
    }
    this._activeIndex = -1;
    this._mounted.clear();

    if (
      this._autoExpanded.size > 0 &&
      this.prManager &&
      typeof this.prManager.setFileCollapsed === 'function'
    ) {
      for (const filePath of this._autoExpanded) {
        try {
          // Only re-collapse if the file is still expanded — the user may
          // have collapsed it again during the tour, in which case we
          // honor their explicit action and leave it alone. Asked of data,
          // and written through the page's writer, so a file that is
          // scrolled away (it has no element) is collapsed again too.
          if (this._isFileCollapsed(filePath) === false) {
            const done = this.prManager.setFileCollapsed(filePath, true);
            if (done && typeof done.catch === 'function') {
              done.catch((err) => console.warn('[TourRenderer] re-collapse failed for', filePath, err));
            }
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
   * No-op if the stop isn't mounted.
   *
   * Goes through the page's one navigation helper (PRManager.revealInDiff),
   * which resolves the stop's element through the bridge by annotation id,
   * brings it into the viewer's mounted window, waits until the diff has
   * attached it (it is not while a new diff of the file is still awaiting
   * display) and scrolls with the stable variant.
   * Fire-and-forget for the caller; cancelled when the tour is left or
   * reopened, and it bails on its own if the user scrolls.
   * @param {number} index
   * @returns {Promise<void>|undefined}
   */
  scrollToStop(index) {
    const options = {
      behavior: this._reduceMotion ? 'auto' : 'smooth',
      block: 'center'
    };
    const manager = this.prManager;
    if (manager && typeof manager.revealInDiff === 'function') {
      const pierre = this._pierreMounts.get(index);
      if (!pierre) return undefined;
      const gen = manager._tourGen;
      return manager.revealInDiff({
        file: pierre.filePath,
        annotationId: pierre.id,
        scroll: options,
        // A stop is never minimized: scroll to the stop itself.
        expandMinimized: false,
        isCancelled: () => manager._tourGen !== gen
      }).then(({ element }) => {
        if (element && this._pierreMounts.get(index) === pierre) {
          this._mounted.set(index, element);
        }
      }).catch((err) => {
        console.warn('[TourRenderer] could not scroll to stop', index, err);
      });
    }
    // No page manager to navigate through: scroll the element we hold.
    const row = this._resolveRow(index);
    if (!row || !row.isConnected) return undefined;
    if (window.ScrollUtils?.scrollIntoViewStable) {
      window.ScrollUtils.scrollIntoViewStable(row, options);
    } else {
      row.scrollIntoView(options);
    }
    return undefined;
  }

  /**
   * Move the `active-stop` class to the stop at `index`. Removes it from
   * every other mounted row.
   * @param {number} index
   */
  highlightActive(index) {
    // Persist the active index so the pierre renderer callback can re-apply
    // `active-stop` when the annotation element is rebuilt on a rerender.
    this._activeIndex = index;
    // Snapshot keys — `_resolveRow` may delete stale pierre entries from
    // `_mounted`, which would mutate the map mid-iteration.
    for (const i of [...this._mounted.keys()]) {
      const row = this._resolveRow(i);
      if (!row) continue;
      row.classList.toggle('active-stop', i === index);
    }
  }

  // --- private ------------------------------------------------------------

  /**
   * Build the `<div class="tour-annotation-row">` wrapper of a stop. The
   * bridge slots it into the file's light DOM below the anchor line. Page
   * CSS keys on the class and on `data-stop-index`.
   * @param {number} index
   * @param {Object} stop
   * @returns {HTMLDivElement}
   */
  _buildAnnotationDiv(index, stop) {
    const row = document.createElement('div');
    row.className = 'tour-annotation-row';
    if (index === this._activeIndex) row.classList.add('active-stop');
    row.dataset.stopIndex = String(index);
    row.appendChild(this._buildAnnotationInner(index, stop));
    return row;
  }

  /**
   * Build the `.tour-annotation` card (marker + Chat button, title, full
   * description) inside the stop's wrapper.
   * @param {number} index
   * @param {Object} stop
   * @returns {HTMLDivElement}
   */
  _buildAnnotationInner(index, stop) {
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

    // Descriptions are always shown in full — they are short by design, so
    // there is no truncation or "Show more" toggle. The prose width is capped
    // to a readable measure in CSS (.tour-annotation-description), matching
    // full-width comment/suggestion bodies.
    const description = document.createElement('p');
    description.className = 'tour-annotation-description';
    description.textContent = stop.description || '';

    annotation.appendChild(header);
    annotation.appendChild(title);
    annotation.appendChild(description);

    return annotation;
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
