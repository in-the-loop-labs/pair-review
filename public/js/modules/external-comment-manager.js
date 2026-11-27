// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * ExternalCommentManager - Read-only renderer for external review comments.
 *
 * Consumes `GET /api/reviews/:reviewId/external-comments?source=<source>` and
 * renders thread-grouped comments as `.external-comment-row` cards anchored
 * under the appropriate diff line.
 *
 * FILE-LEVEL PATH — a thread with `is_file_level` (GitHub subject_type='file')
 * has no line anchor. It renders into the file's `.file-comments-zone` above
 * the diff (the same light-DOM zone FileCommentManager uses for native
 * file-level comments), carrying `external-comment-row--file-level`. Threads
 * whose line anchor can't be found (outdated / force-pushed) fall back into the
 * SAME zone with `external-comment-row--file-fallback`. Both keep the base
 * `.external-comment-row` class so `clear()`'s DOM sweep, the comment-minimizer,
 * and AIPanel.scrollToExternalThread stay agnostic to placement. A bare
 * file-wrapper append is the last resort only when the zone is missing.
 *
 * LINE THREADS — a file of the diff pane is drawn by the diff viewer in a
 * shadow-DOM `<diffs-container>`. A thread mounts as a custom
 * `'external-comment'` annotation (via PierreBridge.addAnnotation), which the
 * bridge slots BELOW its anchor line into the file's light DOM as a
 * `<div class="external-comment-row">`. A file is the viewer's iff
 * `window.prManager.pierreBridge.files.has(filePath)`; a thread on any other
 * file has no line to anchor against and goes to the fallback above.
 * Every placement carries the SAME inner `.external-comment-thread` card and
 * the same `data-thread-id` / `data-source` attributes, so page CSS, the
 * comment-minimizer, and AIPanel.scrollToExternalThread are agnostic to
 * where a thread was mounted.
 *
 * Read-only: no draft / submit / edit / dismiss flows. Only chat-about
 * actions, which delegate to the global chat panel.
 *
 * Ordering rule (see plans/fetch-external-review-comments.md "Hazards"):
 * three kinds of card sit under the same diff line: AI suggestions, user
 * comments, external threads. External threads sit BELOW the AI suggestions
 * and user comments of the line, by PierreBridge's `typeOrder` map
 * (external-comment sorts after suggestion + comment). This module ONLY
 * touches its own `.external-comment-row` elements / `'external-comment'`
 * annotations when clearing — it never strips cards owned by other
 * renderers.
 */

class ExternalCommentManager {
  /**
   * @param {Object} opts
   * @param {string|number} opts.reviewId - Review id used to build the API URL
   * @param {string[]} [opts.sources=['github']] - External sources to load
   * @param {Object} [opts.chatPanel=window.chatPanel] - Chat panel reference
   */
  constructor({ reviewId, sources = ['github'], chatPanel } = {}) {
    this.reviewId = reviewId;
    this.sources = sources;
    // Bind lazily so tests / late-loaded chat panel both work
    this.chatPanel = chatPanel || (typeof window !== 'undefined' ? window.chatPanel : null);
    // source -> threads[]
    this.threadsBySource = new Map();
    // Track whether we've already warned about a missing anchor for a given thread
    this._anchorWarnings = new Set();
    // Per-manager in-flight promise. Coalesces concurrent loadAndRender calls
    // (page-load + manual refresh + post-AI re-render) into one round-trip.
    this._inflight = null;
    // One-time guard: the 'external-comment' custom annotation renderer is
    // registered on the shared PierreBridge exactly once (it persists on the
    // bridge across re-renders). See `_ensurePierreRendererRegistered`.
    this._pierreRendererRegistered = false;
  }

  // ------------------------------------------------------------------
  // Data fetch
  // ------------------------------------------------------------------

  /**
   * Fetch threads for a single source and cache them in `threadsBySource`.
   * @param {string} source - Source identifier (e.g. 'github')
   * @returns {Promise<Array>} The fetched threads
   */
  async fetch(source) {
    if (!this.reviewId) {
      throw new Error('ExternalCommentManager: reviewId is required to fetch');
    }
    const url = `/api/reviews/${encodeURIComponent(this.reviewId)}/external-comments?source=${encodeURIComponent(source)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      this._toast(`Failed to load ${source} review comments`, 'error');
      throw err;
    }
    if (!res.ok) {
      this._toast(`Failed to load ${source} review comments`, 'error');
      throw new Error(`Failed to fetch external comments: ${res.status}`);
    }
    const data = await res.json();
    const threads = Array.isArray(data) ? data : (data.threads || []);
    this.threadsBySource.set(source, threads);
    return threads;
  }

  /**
   * Fetch + render for all configured sources. Failure in one source does
   * not abort the rest.
   *
   * Canonical refresh entry point for GET-only callers (analysis rebuilds,
   * whitespace toggles, post-AI rerender). For full sync+load — POST to
   * /external-comments/sync followed by GET + render — use `syncAndRender`
   * instead. Both methods share `this._inflight`, so a GET-only caller
   * that races an in-flight `syncAndRender` joins the full sync+load
   * promise rather than racing the POST with a stale GET. This is NOT
   * declared `async` on purpose; an async wrapper would create a fresh
   * Promise on each call and break the shared-Promise contract.
   */
  loadAndRender() {
    if (this._inflight) return this._inflight;
    const inflight = (async () => {
      const result = await this._fetchAllAndRender();
      return result;
    })().finally(() => {
      this._inflight = null;
    });
    this._inflight = inflight;
    return this._inflight;
  }

  /**
   * Sync upstream → load → render. The orchestration sequence for the
   * "refresh external comments" button and PR-page load.
   *
   * Shares `this._inflight` with `loadAndRender`: while a sync+load is in
   * flight, any GET-only caller (analysis rebuild, whitespace toggle) that
   * calls `loadAndRender` joins this promise instead of racing the POST
   * with a stale GET. The POST happens BEFORE the GET so the GET sees the
   * latest mirror.
   *
   * @param {Object} options
   * @param {() => Promise<{count: number, lostAnchors: number, deleted: number, syncedAt: string}>} options.syncFn -
   *   Async function that performs the POST /external-comments/sync. Injected so the manager
   *   doesn't have to know about pr.js — keeps it testable and source-agnostic.
   * @returns {Promise<{errors: Array, syncResult: Object|null, syncError: Error|null}>}
   */
  syncAndRender({ syncFn } = {}) {
    if (this._inflight) return this._inflight;
    const inflight = (async () => {
      let syncResult = null;
      let syncError = null;
      if (typeof syncFn === 'function') {
        try {
          syncResult = await syncFn();
        } catch (err) {
          // Sync failure shouldn't block render — we may have cached rows
          // from a previous run. The caller is responsible for surfacing
          // the failure (toast, etc.); we just keep going.
          syncError = err;
        }
      }
      const renderResult = await this._fetchAllAndRender();
      return { ...renderResult, syncResult, syncError };
    })().finally(() => {
      this._inflight = null;
    });
    this._inflight = inflight;
    return this._inflight;
  }

  /**
   * Internal helper shared by loadAndRender and syncAndRender. Pulls
   * threads for each configured source and re-renders. Failures in one
   * source don't abort the rest.
   * @private
   */
  async _fetchAllAndRender() {
    const errors = [];
    for (const source of this.sources) {
      try {
        await this.fetch(source);
      } catch (err) {
        errors.push({ source, err });
        // Toast already shown in fetch()
        if (typeof console !== 'undefined') {
          console.warn(`[ExternalCommentManager] Failed to fetch ${source}:`, err);
        }
      }
    }
    await this.render();
    // Hand off the flattened thread list to the Review panel so its
    // External segment stays in sync with the inline rows.
    this._notifyPanel();
    return { errors };
  }

  /**
   * Flatten threadsBySource into a single array. The Review panel does
   * not care about source grouping in its list — sort + display keys are
   * file + line — so a flat union is the right shape to hand off.
   *
   * @returns {Array<Object>} The flattened thread roots.
   */
  getAllThreads() {
    const out = [];
    for (const threads of this.threadsBySource.values()) {
      if (Array.isArray(threads)) {
        for (const thread of threads) out.push(thread);
      }
    }
    return out;
  }

  /**
   * Push the current flattened thread list onto the Review panel's
   * External segment. No-op when the panel isn't ready (e.g. before
   * DOMContentLoaded or in tests that don't initialize it).
   * @private
   */
  _notifyPanel() {
    if (typeof window === 'undefined') return;
    const panel = window.aiPanel;
    if (!panel || typeof panel.setExternalThreads !== 'function') return;
    try {
      panel.setExternalThreads(this.getAllThreads());
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[ExternalCommentManager] setExternalThreads threw', err);
      }
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  /**
   * Render all cached threads into the diff. Idempotent: clears any
   * previously rendered external-comment rows first.
   *
   * Async because `_renderThread` may await `prManager.ensureLinesVisible`
   * when an outdated comment's anchor row is collapsed.
   */
  async render() {
    this.clear();
    for (const [, threads] of this.threadsBySource) {
      if (!Array.isArray(threads)) continue;
      for (const thread of threads) {
        try {
          await this._renderThread(thread);
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn('[ExternalCommentManager] Failed to render thread', thread?.id, err);
          }
        }
      }
    }

    // Rebuild minimize-mode indicators so external rows are reflected in
    // the per-line count badges. Mirrors what comment-manager and
    // suggestion-manager do on render. No-op when the minimizer isn't
    // active (refreshIndicators short-circuits on `!this._active`).
    try {
      if (typeof window !== 'undefined' && window.prManager && window.prManager.commentMinimizer) {
        window.prManager.commentMinimizer.refreshIndicators();
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[ExternalCommentManager] minimizer.refreshIndicators threw', err);
      }
    }
  }

  /**
   * Remove every external-comment card this module owns.
   *
   * Line threads: drop the `'external-comment'` annotations via the bridge
   * (which redraws the file, un-slotting their `<div>` cards). A slotted
   * card must NOT be `.remove()`d directly — the bridge still holds the
   * annotation and would slot it again on the next draw, causing
   * duplicates. Drop the annotation and let the bridge own the DOM
   * lifecycle.
   *
   * File-level and fallback cards: strip them from the file-comment zones
   * (attached or not) and from the document. Leaves the cards of other
   * renderers untouched.
   *
   * Order matters: clear the annotations FIRST so their redraw removes the
   * slotted cards, then the sweep only finds zone and fallback cards.
   */
  clear() {
    if (typeof document === 'undefined') return;

    const bridge = this._pierreBridge();
    if (bridge && bridge.files && typeof bridge.removeAnnotationsByType === 'function') {
      for (const [file] of bridge.files) {
        // Guard the rerender: only touch files that actually carry an
        // external-comment annotation so we don't force a needless rerender
        // on every file in a large diff.
        const anns = typeof bridge.getAnnotations === 'function'
          ? bridge.getAnnotations(file, 'external-comment')
          : null;
        if (!anns || anns.length > 0) {
          bridge.removeAnnotationsByType(file, 'external-comment');
        }
      }
    }

    const rows = new Set(document.querySelectorAll('.external-comment-row'));
    // File-level and fallback cards live in file-comment zones, which need
    // not be attached to the document.
    const prManager = (typeof window !== 'undefined' && window.prManager) || null;
    if (prManager && typeof prManager.forEachFileCommentsZone === 'function') {
      prManager.forEachFileCommentsZone((zone) => {
        zone.querySelectorAll('.external-comment-row').forEach((row) => rows.add(row));
      });
    }
    rows.forEach((row) => row.remove());
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Compute the (file, line, side) anchor for a comment, accounting for
   * outdated rows that fall back to the original anchor.
   * Returns null if the comment cannot be anchored.
   */
  _resolveAnchor(comment) {
    if (!comment || !comment.file) return null;

    // File-level comments (GitHub subject_type='file') have no line anchor —
    // they belong in the per-file comments zone above the diff, not on any
    // line. Signal that with `fileLevel: true` so `_renderThread` routes them
    // to the zone.
    if (comment.is_file_level === 1 || comment.is_file_level === true) {
      return { file: comment.file, fileLevel: true };
    }

    const side = comment.side || 'RIGHT';
    const outdated = comment.is_outdated === 1 || comment.is_outdated === true;

    // Treat `is_outdated` as a hint about which anchor to PREFER, not a
    // strict switch. The GitHub adapter couples is_outdated with line_end
    // being null, but future adapters (GitLab, Linear) won't necessarily
    // observe that invariant. Falling back to the other anchor when our
    // preferred one is missing keeps cells like "outdated row that still
    // has a live line_end" or "non-outdated row missing line_end"
    // renderable instead of silently dropped.
    const live = Number.isFinite(comment.line_end) ? comment.line_end : null;
    const orig = Number.isFinite(comment.original_line_end) ? comment.original_line_end : null;
    const line = outdated ? (orig ?? live) : (live ?? orig);
    if (line == null) return null;
    return { file: comment.file, line, side };
  }

  /**
   * Render a single thread (root + replies) into the diff.
   *
   * A thread on a line of a file of the diff pane mounts as an annotation
   * (_renderThreadPierre, which reveals a hidden anchor line first). A
   * thread that cannot be anchored drops to a file-level fallback so the
   * discussion stays visible rather than disappearing silently.
   * @private
   */
  async _renderThread(thread) {
    if (!thread) return;
    const anchor = this._resolveAnchor(thread);
    if (!anchor) {
      const key = `${thread.source}:${thread.id}`;
      if (!this._anchorWarnings.has(key)) {
        this._anchorWarnings.add(key);
        if (typeof console !== 'undefined') {
          console.warn('[ExternalCommentManager] Skipping thread with no anchor', thread.id);
        }
      }
      return;
    }

    // File-level comments render in the per-file comments zone above the diff
    // (light DOM) — no line anchor, no bridge.
    if (anchor.fileLevel) {
      this._renderThreadFileLevel(thread, anchor.file);
      return;
    }

    if (this._isPierreFile(anchor.file)) {
      await this._renderThreadPierre(thread, anchor);
      return;
    }

    // A file the diff viewer does not hold has no line to anchor against
    // (the thread names a file that is not in the diff any more). Render
    // into the per-file comments zone when there is one.
    if (this._renderFileFallback(thread, anchor.file)) return;

    if (typeof console !== 'undefined') {
      console.warn(`[ExternalCommentManager] Could not find diff row for ${anchor.file}:${anchor.line} (${anchor.side})`);
    }
  }

  /**
   * @returns {boolean} true when `window.prManager.ensureLinesVisible` is callable.
   * @private
   */
  _canEnsureLinesVisible() {
    return (
      typeof window !== 'undefined' &&
      window.prManager &&
      typeof window.prManager.ensureLinesVisible === 'function'
    );
  }

  // ------------------------------------------------------------------
  // Line threads: annotations of the diff viewer
  // ------------------------------------------------------------------

  /**
   * The shared PierreBridge instance, or null when the diff viewer is not
   * on the page (unit tests, a bundle that did not load).
   * @returns {Object|null}
   * @private
   */
  _pierreBridge() {
    if (typeof window === 'undefined') return null;
    return (window.prManager && window.prManager.pierreBridge) || null;
  }

  /**
   * Whether `file` is a file of the diff viewer (it has a record there,
   * mounted or not), so that a thread can mount as an annotation of it.
   * @param {string} file
   * @returns {boolean}
   * @private
   */
  _isPierreFile(file) {
    const bridge = this._pierreBridge();
    if (!bridge || !bridge.files || typeof bridge.files.has !== 'function') return false;
    return bridge.files.has(file);
  }

  /**
   * Stable, per-thread annotation id. Deterministic so a re-render targets
   * (replaces / removes) the existing annotation by id instead of stacking.
   * @param {Object} thread
   * @returns {string}
   * @private
   */
  _pierreAnnotationId(thread) {
    const source = thread && thread.source ? thread.source : 'unknown';
    const id = thread && thread.id != null ? thread.id : 'noid';
    return `external-thread-${source}-${id}`;
  }

  /**
   * Register the `'external-comment'` custom annotation renderer on the shared
   * PierreBridge once. The bridge re-invokes this callback whenever it (re)slots
   * an external-comment annotation — including after worker rebuilds / content
   * upgrades that re-apply `fileState.annotations` — so it rebuilds the card
   * from the annotation's stored thread data each time.
   * @param {Object} bridge
   * @private
   */
  _ensurePierreRendererRegistered(bridge) {
    if (this._pierreRendererRegistered) return;
    if (!bridge || typeof bridge.registerAnnotationRenderer !== 'function') return;
    bridge.registerAnnotationRenderer('external-comment', (data) => this._buildThreadDiv(data));
    this._pierreRendererRegistered = true;
  }

  /**
   * The annotation id of a thread that is anchored on a line of the diff, or
   * null when the thread is not an annotation (it was rendered at file level,
   * or not at all). For navigation, which waits on the annotation's card.
   * @param {string|number} threadId
   * @param {string} [source]
   * @returns {string|null}
   */
  threadAnnotationId(threadId, source) {
    if (threadId == null) return null;
    const id = String(threadId);
    const bridge = this._pierreBridge();
    if (!bridge || typeof bridge.findAnnotationByData !== 'function') return null;
    const hit = bridge.findAnnotationByData('external-comment', (data) =>
      data && String(data.id) === id && (!source || !data.source || String(data.source) === String(source)));
    return hit ? hit.annotation.metadata.id : null;
  }

  /**
   * The card of a thread wherever it was rendered: on its anchor line (an
   * annotation of the diff viewer), else in a file-comment zone (file-level
   * threads and unanchorable ones), else a card appended to a file's element
   * (_appendThreadToWrapper). The one lookup for "the element of thread X";
   * used by navigation.
   * @param {string|number} threadId
   * @param {string} [source]
   * @returns {HTMLElement|null}
   */
  findThreadCard(threadId, source) {
    if (threadId == null || typeof document === 'undefined') return null;
    const id = String(threadId);
    const matches = (data) => data && String(data.id) === id && (!source || !data.source || String(data.source) === String(source));
    const bridge = this._pierreBridge();
    const hit = bridge && typeof bridge.findAnnotationByData === 'function'
      ? bridge.findAnnotationByData('external-comment', matches)
      : null;
    if (hit) {
      const card = bridge.getAnnotationElement(hit.fileName, hit.annotation.metadata.id, { create: true });
      if (card) return card;
    }
    const esc = (value) => ((typeof globalThis !== 'undefined' && globalThis.CSS?.escape)
      ? globalThis.CSS.escape(String(value))
      : String(value));
    const selectors = [];
    if (source) selectors.push(`.external-comment-row[data-thread-id="${esc(id)}"][data-source="${esc(source)}"]`);
    selectors.push(`.external-comment-row[data-thread-id="${esc(id)}"]`);
    const prManager = (typeof window !== 'undefined' && window.prManager) || null;
    for (const selector of selectors) {
      let card = null;
      if (prManager && typeof prManager.forEachFileCommentsZone === 'function') {
        prManager.forEachFileCommentsZone((zone) => { card = card || zone.querySelector(selector); });
      }
      card = card || document.querySelector(selector);
      if (card) return card;
    }
    return null;
  }

  /**
   * Mount a thread into a file of the diff viewer as an `'external-comment'`
   * annotation. The bridge slots the card BELOW its anchor line into the
   * file's light DOM (so page CSS + inline handlers work) and orders it after
   * suggestion + comment annotations on the same line via its `typeOrder` map.
   *
   * Outdated / gap-folded anchors: we first ask the PR manager to expand any
   * collapsed gap covering the anchor line (mirrors `loadUserComments`) so the
   * line is rendered before we add the annotation. If the annotation still
   * doesn't slot (line genuinely absent from the diff), we roll it back and
   * fall to a file-level fallback so the discussion stays discoverable.
   * @private
   */
  async _renderThreadPierre(thread, anchor) {
    const bridge = this._pierreBridge();
    if (!bridge || typeof bridge.addAnnotation !== 'function') return;

    if (this._canEnsureLinesVisible()) {
      try {
        await window.prManager.ensureLinesVisible([
          { file: anchor.file, line_start: anchor.line, line_end: anchor.line, side: anchor.side }
        ]);
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[ExternalCommentManager] ensureLinesVisible threw (pierre), continuing', err);
        }
      }
    }

    this._ensurePierreRendererRegistered(bridge);

    // Decide from the diff's data whether the anchor line is one the diff
    // shows. Never from the DOM: the card of an annotation that was just
    // added is not in the document while the file's new diff is still
    // awaiting display (a content upgrade whose highlight result has not
    // come back), although its line is in that diff. Reading that as "line
    // not rendered" left the thread in the file's comment zone for good.
    // Nor from the collapse: a viewed or generated file starts collapsed,
    // and its threads belong on their lines when the reader opens it; the
    // bridge hides the annotation meanwhile, as it does a user comment's.
    // An unanchorable (e.g. destroyed-upstream) discussion goes to a
    // file-level card so it stays discoverable rather than vanishing.
    if (!this._isPierreLineInDiff(bridge, anchor)) {
      this._renderPierreFileFallback(thread, anchor.file);
      return;
    }

    bridge.addAnnotation(anchor.file, {
      lineNumber: anchor.line,
      side: anchor.side,
      type: 'external-comment',
      id: this._pierreAnnotationId(thread),
      data: thread,
    });
  }

  /**
   * Whether the diff shows the anchor line of a thread, by the bridge's
   * data (hunks of the file's current diff plus revealed and expanded
   * context), whether or not the file is collapsed (isLineInDiff).
   * @private
   */
  _isPierreLineInDiff(bridge, anchor) {
    if (!bridge || typeof bridge.isLineInDiff !== 'function') return false;
    try {
      return bridge.isLineInDiff(anchor.file, anchor.line, anchor.side) === true;
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[ExternalCommentManager] isLineInDiff threw, treating the line as not shown', err);
      }
      return false;
    }
  }

  /**
   * File-level fallback for a thread whose anchor line the diff does not
   * show: zone first (`_renderFileFallback`).
   * @private
   */
  _renderPierreFileFallback(thread, file) {
    if (!this._renderFileFallback(thread, file) && typeof console !== 'undefined') {
      console.warn(`[ExternalCommentManager] Could not anchor pierre thread ${thread?.id} in ${file}`);
    }
  }

  /**
   * Render a genuine file-level thread (root + replies) into the file's
   * comments zone above the diff. Carries `external-comment-row--file-level`.
   * @private
   */
  _renderThreadFileLevel(thread, file) {
    if (this._appendThreadToZone(thread, file, 'external-comment-row--file-level')) return;
    // Zone missing (rare — every file of the pane gets one when the diff is
    // rendered). Fall back to a bare wrapper append so the discussion stays
    // discoverable.
    if (!this._appendThreadToWrapper(thread, file, 'external-comment-row--file-level')
        && typeof console !== 'undefined') {
      console.warn(`[ExternalCommentManager] Could not anchor file-level thread ${thread?.id} in ${file}`);
    }
  }

  /**
   * Render an unanchorable line thread (outdated / line dropped from the diff)
   * into the file's comments zone, carrying `external-comment-row--file-fallback`
   * so the outdated badge + fallback styling are preserved. Returns true when
   * the card was placed (zone OR wrapper). Bare wrapper append is the last
   * resort when the zone is absent.
   * @private
   */
  _renderFileFallback(thread, file) {
    if (this._appendThreadToZone(thread, file, 'external-comment-row--file-fallback')) return true;
    return this._appendThreadToWrapper(thread, file, 'external-comment-row--file-fallback');
  }

  /**
   * Build the thread card `<div class="external-comment-row">`, tag it with
   * `extraClass`, and append it to the file's `.file-comments-container`.
   * Returns true on success, false when the zone is missing. The zone is light
   * DOM created per file by FileCommentManager.createFileCommentsZone.
   * @private
   */
  _appendThreadToZone(thread, file, extraClass) {
    const zone = this._resolveFileCommentsZone(file);
    if (!zone) return false;
    const container = zone.querySelector('.file-comments-container') || zone;
    const div = this._buildThreadDiv(thread);
    if (!div) return false;
    if (extraClass) div.classList.add(extraClass);
    container.appendChild(div);
    return true;
  }

  /**
   * Last-resort placement when the comments zone is missing: append the card
   * directly to the file wrapper (light DOM). `clear()`'s DOM sweep removes it
   * on the next render cycle. Returns true on success.
   * @private
   */
  _appendThreadToWrapper(thread, file, extraClass) {
    const wrapper = this._findFileWrapper(file);
    if (!wrapper) return false;
    const div = this._buildThreadDiv(thread);
    if (!div) return false;
    if (extraClass) div.classList.add(extraClass);
    wrapper.appendChild(div);
    return true;
  }

  /**
   * Resolve a file's comment zone through the page's one resolver
   * (PRManager.getFileCommentsZone), which answers from the zone registry
   * and so also finds a zone that is not attached to the document.
   * @param {string} file
   * @returns {HTMLElement|null}
   * @private
   */
  _resolveFileCommentsZone(file) {
    if (typeof document === 'undefined' || !file) return null;
    const prManager = (typeof window !== 'undefined' && window.prManager) || null;
    if (!prManager || typeof prManager.getFileCommentsZone !== 'function') return null;
    return prManager.getFileCommentsZone(file) || null;
  }

  /**
   * Resolve a file's `.d2h-file-wrapper` element (null for a file the viewer
   * has not mounted).
   * @param {string} file
   * @returns {HTMLElement|null}
   * @private
   */
  _findFileWrapper(file) {
    if (typeof document === 'undefined' || !file) return null;
    if (typeof window !== 'undefined' && window.DiffRenderer && typeof window.DiffRenderer.findFileElement === 'function') {
      const el = window.DiffRenderer.findFileElement(file);
      if (el) return el;
    }
    try {
      const esc = (typeof globalThis !== 'undefined' && globalThis.CSS?.escape)
        ? globalThis.CSS.escape(file)
        : file;
      return document.querySelector(`.d2h-file-wrapper[data-file-name="${esc}"]`);
    } catch {
      return null;
    }
  }

  /**
   * Build the `.external-comment-thread` element containing the root comment,
   * its replies, and per-comment actions; `_buildThreadDiv` wraps it.
   * @private
   */
  _buildThreadElement(thread) {
    const threadEl = document.createElement('div');
    threadEl.className = 'external-comment-thread';

    // Root comment
    const rootEl = this._buildCommentElement(thread, { isReply: false });
    threadEl.appendChild(rootEl);

    // Replies
    const replies = Array.isArray(thread.replies) ? thread.replies : [];
    for (const reply of replies) {
      const replyEl = this._buildCommentElement(reply, { isReply: true });
      threadEl.appendChild(replyEl);
    }

    return threadEl;
  }

  /**
   * Apply the `data-thread-id` / `data-source` attributes the card's wrapper
   * carries (AIPanel.scrollToExternalThread queries them, and the
   * comment-minimizer keys off the class).
   * @private
   */
  _applyThreadDataset(el, thread) {
    el.dataset.threadId = thread.id != null ? String(thread.id) : '';
    el.dataset.source = thread.source || '';
  }

  /**
   * Build the `<div class="external-comment-row">` wrapper of a thread. For a
   * line thread the bridge slots it into the file's light DOM below the
   * anchor line; file-level and fallback threads put it in the file's
   * comment zone. The class and `data-thread-id` / `data-source` are what page
   * CSS, the minimizer, and the AIPanel scroll-to lookup go by.
   * @private
   */
  _buildThreadDiv(thread) {
    if (typeof document === 'undefined') return null;
    const div = document.createElement('div');
    div.className = 'external-comment-row';
    this._applyThreadDataset(div, thread);
    div.appendChild(this._buildThreadElement(thread));
    return div;
  }

  /**
   * Build a single `.external-comment` element (root or reply).
   * @private
   */
  _buildCommentElement(comment, { isReply }) {
    const escapeHtml = this._escapeHtml;
    const source = comment.source || 'github';

    const el = document.createElement('div');
    const classes = ['external-comment', `source-${source}`];
    if (isReply) classes.push('is-reply');
    if (comment.is_outdated === 1 || comment.is_outdated === true) classes.push('is-outdated');
    el.className = classes.join(' ');
    el.dataset.commentId = comment.id != null ? String(comment.id) : '';
    el.dataset.source = source;
    if (comment.external_id != null) el.dataset.externalId = String(comment.external_id);

    // ---- Header ----
    const header = document.createElement('div');
    header.className = 'external-comment-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'external-comment-header-left';

    // Author (link only when the URL is safe — falls back to plain text
    // for `javascript:`, `data:`, or other non-navigational schemes).
    if (comment.author_url && this._isSafeUrl(comment.author_url)) {
      const a = document.createElement('a');
      a.className = 'external-comment-author';
      a.href = comment.author_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = comment.author || '';
      headerLeft.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'external-comment-author';
      span.textContent = comment.author || '';
      headerLeft.appendChild(span);
    }

    // Outdated badge
    if (comment.is_outdated === 1 || comment.is_outdated === true) {
      const badge = document.createElement('span');
      badge.className = 'external-comment-outdated-badge';
      badge.title = 'This comment was made against an earlier version of the file';
      badge.textContent = 'outdated';
      headerLeft.appendChild(badge);
    }

    // Timestamp
    const tsText = this._formatTimestamp(comment.external_created_at);
    if (tsText) {
      const ts = document.createElement('span');
      ts.className = 'external-comment-timestamp';
      ts.textContent = tsText;
      if (comment.external_created_at) ts.title = comment.external_created_at;
      headerLeft.appendChild(ts);
    }

    header.appendChild(headerLeft);

    // Right side of header: chat-about + permalink, mirroring the
    // header-right layout used by user comments and AI suggestions.
    const headerRight = document.createElement('div');
    headerRight.className = 'external-comment-header-right';

    const chatBtn = this._buildChatCommentButton(comment, { isReply });
    headerRight.appendChild(chatBtn);

    if (comment.external_url && this._isSafeUrl(comment.external_url)) {
      const link = document.createElement('a');
      link.className = 'external-comment-permalink';
      link.href = comment.external_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'Open in source system';
      link.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7.75 2.5a.75.75 0 0 0 0 1.5h2.69L5.22 9.22a.75.75 0 1 0 1.06 1.06L11.5 5.06v2.69a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75ZM3.75 3A1.75 1.75 0 0 0 2 4.75v7.5C2 13.216 2.784 14 3.75 14h7.5A1.75 1.75 0 0 0 13 12.25v-3.5a.75.75 0 0 0-1.5 0v3.5a.25.25 0 0 1-.25.25h-7.5a.25.25 0 0 1-.25-.25v-7.5a.25.25 0 0 1 .25-.25h3.5a.75.75 0 0 0 0-1.5Z"/></svg>';
      headerRight.appendChild(link);
    }

    header.appendChild(headerRight);
    el.appendChild(header);

    // ---- Body ----
    const body = document.createElement('div');
    body.className = 'external-comment-body';
    const bodyText = comment.body || '';
    if (typeof window !== 'undefined' && typeof window.renderMarkdown === 'function') {
      body.innerHTML = window.renderMarkdown(bodyText);
    } else {
      body.textContent = bodyText;
    }
    el.appendChild(body);

    return el;
  }

  /**
   * Build the per-comment chat button.
   * - On the thread root (`isReply: false`), chats about the whole thread.
   * - On a reply, chats about just that reply.
   * @private
   */
  _buildChatCommentButton(comment, { isReply } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-chat-comment external-comment-chat-btn';
    btn.title = isReply ? 'Chat about this comment' : 'Chat about thread';
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isReply) {
        this._openCommentChat(comment);
      } else {
        this._openThreadChat(comment);
      }
    });
    return btn;
  }

  /**
   * Dispatch chat-about-comment to the chat panel using the canonical
   * `commentContext` shape (see plans/fetch-external-review-comments.md
   * § 10 and Phase 4 task spec).
   * @private
   */
  _openCommentChat(comment) {
    const panel = this._resolveChatPanel();
    if (!panel || typeof panel.open !== 'function') {
      // The panel is gone — surface that to the reviewer instead of
      // silently dropping the click. Buttons should also be CSS-hidden via
      // [data-chat='disabled'], this is the backstop for racing state.
      this._toast('Chat is unavailable', 'warn');
      return;
    }
    const outdated = comment.is_outdated === 1 || comment.is_outdated === true;
    panel.open({
      commentContext: {
        commentId: comment.id,
        body: comment.body,
        file: comment.file,
        side: comment.side || 'RIGHT',
        line_start: outdated ? comment.original_line_start : comment.line_start,
        line_end: outdated ? comment.original_line_end : comment.line_end,
        source: 'external',
        externalSource: comment.source,
        author: comment.author,
        externalUrl: comment.external_url,
        isOutdated: !!outdated,
      },
    });
  }

  /**
   * Dispatch chat-about-thread to the chat panel using the canonical
   * `threadContext` shape.
   * @private
   */
  _openThreadChat(root) {
    const panel = this._resolveChatPanel();
    if (!panel || typeof panel.open !== 'function') {
      this._toast('Chat is unavailable', 'warn');
      return;
    }
    const outdated = root.is_outdated === 1 || root.is_outdated === true;
    const replies = Array.isArray(root.replies) ? root.replies : [];
    panel.open({
      threadContext: {
        rootId: root.id,
        source: 'external',
        externalSource: root.source,
        file: root.file,
        side: root.side || 'RIGHT',
        line_start: outdated ? root.original_line_start : root.line_start,
        line_end: outdated ? root.original_line_end : root.line_end,
        comments: [
          {
            author: root.author,
            body: root.body,
            isOutdated: !!outdated,
            externalUrl: root.external_url,
            externalCreatedAt: root.external_created_at,
          },
          ...replies.map((r) => ({
            author: r.author,
            body: r.body,
            isOutdated: !!(r.is_outdated === 1 || r.is_outdated === true),
            externalUrl: r.external_url,
            externalCreatedAt: r.external_created_at,
          })),
        ],
      },
    });
  }

  /**
   * Resolve the chat panel reference late so callers that attach
   * `window.chatPanel` after this manager is constructed still work.
   * @private
   */
  _resolveChatPanel() {
    if (this.chatPanel) return this.chatPanel;
    if (typeof window !== 'undefined' && window.chatPanel) {
      this.chatPanel = window.chatPanel;
      return this.chatPanel;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  /**
   * Show a toast via the project-wide toast helper. Falls back to console
   * when the helper isn't available (e.g. unit tests).
   * @private
   */
  _toast(message, level = 'error') {
    if (typeof window === 'undefined') return;
    const t = window.toast;
    if (t) {
      if (level === 'error' && typeof t.showError === 'function') return t.showError(message);
      if (level === 'warn' && typeof t.showWarning === 'function') return t.showWarning(message);
      if (level === 'info' && typeof t.showInfo === 'function') return t.showInfo(message);
      if (level === 'success' && typeof t.showSuccess === 'function') return t.showSuccess(message);
    }
    if (typeof window.showToast === 'function') {
      return window.showToast(message, level);
    }
    // Last-resort log only — never throw from a toast helper.
    if (typeof console !== 'undefined') {
      console.warn(`[ExternalCommentManager] toast(${level}): ${message}`);
    }
  }

  /**
   * Format an ISO timestamp into a short relative description.
   * Falls back to the raw string on parse failure.
   * @private
   */
  _formatTimestamp(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date.getTime())) return iso;
    const now = Date.now();
    const diffMs = now - date.getTime();
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.round(months / 12);
    return `${years}y ago`;
  }

  /**
   * Allow only http/https/mailto URLs. Used to gate `<a href>` attributes
   * built from server-supplied data so a malicious upstream cannot smuggle
   * `javascript:` or `data:` URLs into our DOM.
   * @private
   */
  _isSafeUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    // Relative URLs are safe — they resolve under our origin.
    if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) return true;
    try {
      const u = new URL(trimmed, (typeof window !== 'undefined' && window.location) ? window.location.href : 'http://localhost/');
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
    } catch {
      return false;
    }
  }

  /**
   * Minimal HTML escape used as a fallback when window helpers aren't loaded.
   * @private
   */
  _escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// Browser singleton — instantiated on DOMContentLoaded so the PR page
// can immediately `await window.externalCommentManager.loadAndRender()`
// once the review id is known. Callers should set `reviewId` and
// `sources` before invoking `loadAndRender` (see PR page wiring).
if (typeof window !== 'undefined') {
  window.ExternalCommentManager = ExternalCommentManager;

  if (typeof document !== 'undefined' && !window.externalCommentManager) {
    const initSingleton = () => {
      if (!window.externalCommentManager) {
        window.externalCommentManager = new ExternalCommentManager({});
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initSingleton);
    } else {
      initSingleton();
    }
  }
}

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExternalCommentManager };
}
