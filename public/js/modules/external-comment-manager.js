// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * ExternalCommentManager - Read-only renderer for external review comments.
 *
 * Consumes `GET /api/reviews/:reviewId/external-comments?source=<source>` and
 * renders thread-grouped comments as `.external-comment-row` rows anchored
 * after the appropriate diff line.
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
 * DUAL RENDERING PATH — a thread's file is rendered by ONE of two engines:
 *   - PIERRE (@pierre/diffs): the file lives in a shadow-DOM
 *     `<diffs-container>` with NO light-DOM `<tr>` rows. The thread mounts as
 *     a custom `'external-comment'` annotation (via PierreBridge.addAnnotation),
 *     which the bridge slots BELOW its anchor line into the file's light DOM
 *     as a `<div class="external-comment-row">`. A file is pierre-rendered iff
 *     `window.prManager.pierreBridge.files.has(filePath)`.
 *   - LEGACY (table renderer): context files / bridge-less fallbacks still
 *     render as an HTML table. The thread mounts as a
 *     `<tr class="external-comment-row">` inserted BELOW the anchor row.
 * Both variants carry the SAME inner `.external-comment-thread` card and the
 * same `data-thread-id` / `data-source` attributes, so page CSS, the
 * comment-minimizer, and AIPanel.scrollToExternalThread are agnostic to which
 * path mounted them.
 *
 * Read-only: no draft / submit / edit / dismiss flows. Only chat-about
 * actions, which delegate to the global chat panel. That property is what
 * makes this subsystem safe to surface in LOCAL mode, where there is no
 * write path back to GitHub at all.
 *
 * ANCHOR TRUST (local mode)
 * -------------------------
 * THE canonical description of the three gates. The caller computes their
 * values in `PRManager._externalAnchorContext`; `_anchorDegradeReason`
 * implements them.
 *
 * Every comment's `(file, line, side)` was resolved against the PR's HEAD
 * commit. In PR mode the rendered diff IS that commit, so the numbers agree
 * by construction, all three gates pass, and behaviour is byte-identical to
 * before this feature.
 *
 * In local mode the rendered diff is the working tree against a base, and
 * `--scope` can make it a different diff entirely. A line number from PR head
 * can then resolve to a DIFFERENT line locally — and `_findDiffLineRow`
 * matches on the number alone, so it would anchor confidently to the wrong
 * content. The existing file-level fallback only catches "line not found",
 * never "line found, wrong content". Hence:
 *
 *   1. `trustPreciseAnchors` — false whenever local HEAD does not equal the
 *      PR's `head_sha`. Every line thread then degrades to the file-level
 *      zone carrying a provenance note. Being visibly approximate beats being
 *      invisibly wrong (plans/bridge-local-and-pr-modes.md, decision 8).
 *
 *   2. `anchorCommitSha` — a PER-COMMENT gate, needed because both operands
 *      of gate 1 are page-load snapshots (local HEAD cached on `currentPR`,
 *      the PR head from the TTL-less `pr_metadata` cache), so a PR that
 *      advances mid-session still looks like a match. Each stored comment
 *      carries the commit it was anchored to and those arrive with the
 *      freshly-synced rows, no cache in the path. Armed only in local mode.
 *
 *   3. `trustLeftAnchors` — both gates above are HEAD-side, and a diff has two
 *      sides. LEFT line numbers (comments on lines the PR removed) come from
 *      the PR's BASE commit, while our left column is whatever base the scope
 *      picked — a merge-base, a `--base` override, or on the default
 *      `unstaged..untracked` scope the index/HEAD, which is not a merge-base
 *      at all. Matching HEADS say nothing about that, so without this gate a
 *      LEFT thread sails through and anchors into a different coordinate
 *      system. Only ever fires for `side === 'LEFT'`.
 *
 * The gates degrade for different reasons, so `_anchorDegradeReason` reports
 * WHICH one fired rather than a boolean — see `_provenanceNoteText`.
 *
 * Ordering rule (shared diff-row surface — see plans/fetch-external-review-comments.md
 * "Hazards"): three independent renderers append rows after the same diff
 * line: `.ai-suggestion-row`, `.user-comment-row`, `.external-comment-row`.
 * External rows sit BELOW AI suggestion + user comment rows for the same
 * diff line. In the legacy path this is enforced by `_insertAtOrderedPosition`;
 * in the pierre path by PierreBridge's `typeOrder` map (external-comment sorts
 * after suggestion + comment). This module ONLY touches its own
 * `.external-comment-row` elements / `'external-comment'` annotations when
 * clearing — it never strips rows owned by other renderers.
 */

class ExternalCommentManager {
  /**
   * @param {Object} opts
   * @param {string|number} opts.reviewId - Review id used to build the API URL
   * @param {string[]} [opts.sources=['github']] - External sources to load
   * @param {Object} [opts.chatPanel=window.chatPanel] - Chat panel reference
   * @param {boolean} [opts.trustPreciseAnchors=true] - Seed values for the
   *   anchor context; `setAnchorContext` documents them and is how they are
   *   normally supplied. The defaults are the PR-mode answer (trust
   *   everything, per-comment gate disarmed), so PR mode is unchanged.
   * @param {number|null} [opts.anchorPRNumber=null]
   * @param {string|null} [opts.anchorCommitSha=null]
   * @param {boolean} [opts.trustLeftAnchors=true]
   */
  constructor({
    reviewId,
    sources = ['github'],
    chatPanel,
    trustPreciseAnchors = true,
    anchorPRNumber = null,
    anchorCommitSha = null,
    trustLeftAnchors = true
  } = {}) {
    this.reviewId = reviewId;
    this.sources = sources;
    // Bind lazily so tests / late-loaded chat panel both work
    this.chatPanel = chatPanel || (typeof window !== 'undefined' ? window.chatPanel : null);
    // See `setAnchorContext` / the module header's ANCHOR TRUST section.
    this.trustPreciseAnchors = trustPreciseAnchors !== false;
    this.trustLeftAnchors = trustLeftAnchors !== false;
    this.anchorPRNumber = anchorPRNumber;
    this.anchorCommitSha = anchorCommitSha;
    // source -> threads[]
    this.threadsBySource = new Map();
    // Track whether we've already warned about a missing anchor for a given thread
    this._anchorWarnings = new Set();
    // Per-manager in-flight promise. Coalesces concurrent loadAndRender calls
    // (page-load + manual refresh + post-AI re-render) into one round-trip.
    // `_inflightIsSync` records whether it includes the sync POST, so a
    // `syncAndRender` never mistakes a GET-only load for its own work —
    // see `syncAndRender`.
    this._inflight = null;
    this._inflightIsSync = false;
    // One-time guard: the 'external-comment' custom annotation renderer is
    // registered on the shared PierreBridge exactly once (it persists on the
    // bridge across re-renders). See `_ensurePierreRendererRegistered`.
    this._pierreRendererRegistered = false;
  }

  /**
   * Declare how far the currently-rendered diff can be trusted to agree with
   * the PR head the comments were anchored against. Callers set this BEFORE
   * `render()` / `loadAndRender()` / `syncAndRender()`; the flags are read at
   * render time, never cached per thread, so a later re-render with a
   * different context re-decides cleanly.
   *
   * Omitted fields are left untouched. See ANCHOR TRUST in the module header
   * for what each flag guards against.
   *
   * @param {Object} [ctx]
   * @param {boolean} [ctx.trustPreciseAnchors] - false routes every LINE
   *   thread through the file-level zone with a provenance note. Genuine
   *   file-level threads are unaffected — they had no line anchor to lose.
   * @param {number|null} [ctx.prNumber] - named in the provenance note.
   * @param {string|null} [ctx.commitSha] - the commit the rendered diff IS.
   *   Arms the per-comment gate; pass null to disarm it (PR mode).
   * @param {boolean} [ctx.trustLeftAnchors] - false routes every LEFT-side
   *   thread through the file-level zone. RIGHT-side threads are unaffected.
   */
  setAnchorContext({ trustPreciseAnchors, prNumber, commitSha, trustLeftAnchors } = {}) {
    if (trustPreciseAnchors !== undefined) {
      this.trustPreciseAnchors = trustPreciseAnchors !== false;
    }
    if (trustLeftAnchors !== undefined) {
      this.trustLeftAnchors = trustLeftAnchors !== false;
    }
    if (prNumber !== undefined) {
      this.anchorPRNumber = prNumber;
    }
    if (commitSha !== undefined) {
      this.anchorCommitSha = commitSha || null;
    }
  }

  /**
   * Why this comment's precise (file, line, side) anchor cannot be trusted.
   *
   * The single source of truth behind BOTH the placement (`_resolveAnchor`)
   * and the explanation (`_buildProvenanceNote`, the chat hooks). A card that
   * says "approximate" while its chat button ships exact line numbers is worse
   * than either alone, so they must not be able to drift apart.
   *
   * Three fail-safe gates — see ANCHOR TRUST in the module header. The two
   * head-side ones answer `'head'`; the base-side one answers `'base'`.
   *
   * @param {Object} comment
   * @param {boolean} outdated - the `is_outdated` reading `_resolveAnchor`
   *   already computed, so the commit we check is the one belonging to the
   *   line it picked.
   * @returns {null|'head'|'base'} null when the anchor is trustworthy.
   * @private
   */
  _anchorDegradeReason(comment, outdated) {
    // Gate 1 — session level: local HEAD vs the PR's head_sha.
    if (!this.trustPreciseAnchors) return 'head';
    // Gate 2 — per comment, and only when the caller told us what commit the
    // rendered diff is. Disarmed in PR mode, where the diff IS the PR head.
    if (this.anchorCommitSha) {
      const live = comment?.commit_sha || null;
      const orig = comment?.original_commit_sha || null;
      // Mirror `_resolveAnchor`'s line preference so the commit we compare is
      // the one that owns the line we are about to anchor to. For an OUTDATED
      // row that is `original_commit_sha`, an older commit by definition — so
      // with this gate armed such rows ALWAYS degrade to file level. Intended:
      // their line numbers describe a commit we are demonstrably not
      // rendering. PR mode keeps its outdated-badge behaviour (gate disarmed).
      const sha = outdated ? (orig ?? live) : (live ?? orig);
      // A missing sha means upstream didn't record a commit for this row —
      // nothing to contradict gate 1, so let its answer stand rather than
      // degrading on missing data.
      if (sha && sha !== this.anchorCommitSha) return 'head';
    }
    // Gate 3 — the OTHER side of the diff. Only fires for LEFT, so RIGHT
    // threads are untouched by it.
    if ((comment?.side || 'RIGHT') === 'LEFT' && !this.trustLeftAnchors) return 'base';
    return null;
  }

  /** Boolean form of `_anchorDegradeReason`. @private */
  _anchorTrusted(comment, outdated) {
    return this._anchorDegradeReason(comment, outdated) === null;
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
      // Guarded: a `syncAndRender` that chained onto this one has already
      // taken ownership of `_inflight`, and must not be cleared by us.
      if (this._inflight === inflight) {
        this._inflight = null;
        this._inflightIsSync = false;
      }
    });
    this._inflight = inflight;
    this._inflightIsSync = false;
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
   * The reverse direction is NOT symmetric, and joining there would be a bug:
   * a sync that arrived while a GET-only load was in flight would return that
   * load's result — no `syncResult`, no `syncError`, and crucially no POST —
   * so the caller fires no toast and the mirror is never synced at all. It
   * instead CHAINS: wait for the in-flight load, then do the full sync+load.
   * `_inflightIsSync` is what tells the two cases apart.
   *
   * @param {Object} options
   * @param {() => Promise<{count: number, lostAnchors: number, deleted: number, syncedAt: string}>} options.syncFn -
   *   Async function that performs the POST /external-comments/sync. Injected so the manager
   *   doesn't have to know about pr.js — keeps it testable and source-agnostic.
   * @returns {Promise<{errors: Array, syncResult: Object|null, syncError: Error|null}>}
   */
  syncAndRender({ syncFn } = {}) {
    // Another sync is already doing exactly this work — join it.
    if (this._inflight && this._inflightIsSync) return this._inflight;
    // A GET-only load is in flight: let it finish (so our GET isn't racing
    // its render), then run the real sync. Its failure is its own caller's
    // to report, so swallow it here rather than aborting the sync.
    const pendingLoad = this._inflight;
    const inflight = (async () => {
      if (pendingLoad) {
        try {
          await pendingLoad;
        } catch {
          /* owned by the loadAndRender caller */
        }
      }
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
      if (this._inflight === inflight) {
        this._inflight = null;
        this._inflightIsSync = false;
      }
    });
    this._inflight = inflight;
    this._inflightIsSync = true;
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
   * Remove all external-comment rows we own from BOTH rendering engines.
   *
   * Pierre-rendered files: drop the `'external-comment'` annotations via the
   * bridge (which rerenders the file, un-slotting their `<div>` rows). We must
   * NOT `.remove()` a slotted pierre `<div>` directly — the bridge still holds
   * the annotation in `fileState.annotations` and would re-slot it on the next
   * rerender, causing duplicates. Drop the annotation and let the bridge own
   * the DOM lifecycle.
   *
   * Legacy files: strip the injected `<tr class="external-comment-row">`
   * (and any file-level fallback `<div>`) from the DOM. Leaves
   * `.user-comment-row` and `.ai-suggestion-row` rows untouched.
   *
   * Order matters: clear the pierre annotations FIRST so their rerender
   * removes the slotted divs, then the DOM sweep only finds legacy rows.
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

    const rows = document.querySelectorAll('.external-comment-row');
    rows.forEach((row) => row.remove());
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Resolve the diff row that an external comment / thread root anchors to.
   * Uses the project-wide DiffRenderer file lookup when available, and the
   * LineTracker side-aware coordinate lookup when present — both already
   * power the suggestion-manager and comment-manager renderers, so behavior
   * stays consistent across the three.
   *
   * @param {string} file
   * @param {number} line
   * @param {string} side - 'LEFT' or 'RIGHT'
   * @returns {Element|null}
   */
  _findDiffLineRow(file, line, side) {
    if (typeof document === 'undefined') return null;
    if (!file || !Number.isFinite(line)) return null;

    let fileElement = null;
    if (typeof window !== 'undefined' && window.DiffRenderer && typeof window.DiffRenderer.findFileElement === 'function') {
      fileElement = window.DiffRenderer.findFileElement(file);
    }
    if (!fileElement) {
      try {
        const escaped = (typeof globalThis !== 'undefined' && globalThis.CSS?.escape)
          ? globalThis.CSS.escape(file)
          : file;
        fileElement = document.querySelector(`[data-file-name="${escaped}"]`);
      } catch {
        fileElement = null;
      }
    }
    if (!fileElement) return null;

    const wantedSide = side || 'RIGHT';
    const rows = fileElement.querySelectorAll('tr');
    const lineTracker = (typeof window !== 'undefined' && window.LineTracker)
      ? new window.LineTracker()
      : null;

    for (const row of rows) {
      let lineNum = null;
      if (lineTracker && typeof lineTracker.getLineNumber === 'function') {
        lineNum = lineTracker.getLineNumber(row, wantedSide);
      } else {
        // Minimal fallback: dataset.lineNumber + dataset.side check
        const ds = row.dataset || {};
        if (wantedSide === 'LEFT' && ds.oldLineNumber) {
          lineNum = parseInt(ds.oldLineNumber, 10);
        } else if (wantedSide === 'RIGHT' && ds.newLineNumber) {
          lineNum = parseInt(ds.newLineNumber, 10);
        } else if (ds.lineNumber && (!ds.side || ds.side === wantedSide)) {
          lineNum = parseInt(ds.lineNumber, 10);
        }
      }
      if (lineNum === line) return row;
    }
    return null;
  }

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
    // to the zone regardless of which diff engine rendered the file.
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

    // The line number is real, but resolved against a commit we may not be
    // rendering — matching it here would anchor to whatever occupies that
    // number now. Degrade to the file zone, flagged so the render path can
    // tell it from a genuine file-level comment.
    if (!this._anchorTrusted(comment, outdated)) {
      return { file: comment.file, fileLevel: true, degraded: true };
    }

    return { file: comment.file, line, side };
  }

  /**
   * Render a single thread (root + replies) into the diff.
   *
   * When the anchor line isn't initially in the DOM (collapsed context for
   * outdated comments is the common case) we ask the PR manager to expand
   * any hidden lines that cover the anchor and re-look-up before giving up.
   * If still missing we drop to a file-level fallback so the discussion
   * stays visible rather than disappearing silently.
   *
   * Async because `PRManager.ensureLinesVisible` returns a Promise — we
   * MUST await it before re-looking-up, otherwise the freshly-materialized
   * row is not yet in the DOM when we ask for it.
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
    // (light DOM, shared by both diff engines) — no line anchor, no bridge.
    // Anchor-degraded line threads arrive here too (see ANCHOR TRUST); they
    // take the same zone but carry a different class and a provenance note.
    if (anchor.fileLevel) {
      this._renderThreadFileLevel(thread, anchor.file, { degraded: Boolean(anchor.degraded) });
      return;
    }

    // Route by rendering engine. Pierre-rendered files have no light-DOM
    // <tr> rows to anchor against, so they mount via the annotation bridge.
    if (this._isPierreFile(anchor.file)) {
      await this._renderThreadPierre(thread, anchor);
      return;
    }

    let targetRow = this._findDiffLineRow(anchor.file, anchor.line, anchor.side);

    // Outdated discussions often land on lines that the diff renderer
    // collapsed behind an "expand context" gap. Ask the PR manager (when
    // present) to expand the gap, then await before retrying the lookup.
    // PRManager.ensureLinesVisible takes an array of items and returns a
    // Promise — must await or the row isn't in the DOM yet.
    if (!targetRow && this._canEnsureLinesVisible()) {
      try {
        await window.prManager.ensureLinesVisible([
          {
            file: anchor.file,
            line_start: anchor.line,
            line_end: anchor.line,
            side: anchor.side
          }
        ]);
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[ExternalCommentManager] ensureLinesVisible threw, falling back', err);
        }
      }
      targetRow = this._findDiffLineRow(anchor.file, anchor.line, anchor.side);
    }

    if (!targetRow) {
      // Unanchorable discussion (outdated / force-pushed line no longer in the
      // diff). Render into the per-file comments zone above the diff rather
      // than faking a line-1 annotation at the top of the table. Falls back to
      // a bare wrapper append only when the zone itself is missing.
      if (this._renderFileFallback(thread, anchor.file)) return;

      if (typeof console !== 'undefined') {
        console.warn(`[ExternalCommentManager] Could not find diff row for ${anchor.file}:${anchor.line} (${anchor.side})`);
      }
      return;
    }

    const externalRow = this._buildThreadRow(thread, targetRow);
    if (!externalRow) return;
    this._insertAtOrderedPosition(targetRow, externalRow);
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
  // Pierre (@pierre/diffs) rendering path
  // ------------------------------------------------------------------

  /**
   * The shared PierreBridge instance, or null when @pierre/diffs isn't in
   * play (unit tests, legacy-only fallback).
   * @returns {Object|null}
   * @private
   */
  _pierreBridge() {
    if (typeof window === 'undefined') return null;
    return (window.prManager && window.prManager.pierreBridge) || null;
  }

  /**
   * Whether `file` is (or will be) rendered by @pierre/diffs vs the legacy
   * table. Pierre files have no light-DOM `<tr>` rows, so their threads mount
   * as annotations. Lazily-registered Pierre files are absent from
   * `bridge.files` until their body renders, so also consult the PR manager's
   * lazy registry — `_renderThreadPierre` materializes the body itself.
   * @param {string} file
   * @returns {boolean}
   * @private
   */
  _isPierreFile(file) {
    const bridge = this._pierreBridge();
    if (!bridge || !bridge.files || typeof bridge.files.has !== 'function') return false;
    if (bridge.files.has(file)) return true;
    const lazyBodies = window.prManager && window.prManager._lazyFileBodies;
    const lazyEntry = lazyBodies && typeof lazyBodies.get === 'function'
      ? lazyBodies.get(file)
      : null;
    return !!(lazyEntry && lazyEntry.pierre);
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
   * The light-DOM container a pierre file's annotations are slotted into,
   * or null.
   * @param {string} file
   * @returns {HTMLElement|null}
   * @private
   */
  _pierreContainer(file) {
    const fileState = this._pierreBridge()?.files?.get?.(file);
    return (fileState && fileState.container) || null;
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
   * Re-query the live slotted `<div class="external-comment-row">` for a
   * thread in a pierre file. The element is rebuilt on every FileDiff
   * rerender, so cached references go stale — resolve fresh before use.
   * @param {string} file
   * @param {Object} thread
   * @returns {HTMLElement|null}
   * @private
   */
  _queryPierreRow(file, thread) {
    const container = this._pierreContainer(file);
    if (!container) return null;
    const idAttr = thread && thread.id != null ? String(thread.id) : '';
    let selector;
    try {
      const esc = (typeof globalThis !== 'undefined' && globalThis.CSS?.escape)
        ? globalThis.CSS.escape(idAttr)
        : idAttr;
      selector = `.external-comment-row[data-thread-id="${esc}"]`;
    } catch {
      selector = `.external-comment-row[data-thread-id="${idAttr}"]`;
    }
    return container.querySelector(selector) || null;
  }

  /**
   * Mount a thread into a PIERRE-rendered file as an `'external-comment'`
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

    const id = this._pierreAnnotationId(thread);
    bridge.addAnnotation(anchor.file, {
      lineNumber: anchor.line,
      side: anchor.side,
      type: 'external-comment',
      id,
      data: thread,
    });

    // addAnnotation rerenders synchronously; verify the row actually slotted.
    // If the anchor line still isn't rendered, roll back and fall back to a
    // file-level card so an unanchorable (e.g. destroyed-upstream) discussion
    // stays discoverable rather than silently vanishing.
    if (!this._queryPierreRow(anchor.file, thread)) {
      if (typeof bridge.removeAnnotation === 'function') {
        try { bridge.removeAnnotation(anchor.file, id); } catch { /* best effort */ }
      }
      this._renderPierreFileFallback(thread, anchor.file);
    }
  }

  /**
   * File-level fallback for a pierre file: same zone-first strategy as the
   * legacy path. Shares `_renderFileFallback`.
   * @private
   */
  _renderPierreFileFallback(thread, file) {
    if (!this._renderFileFallback(thread, file) && typeof console !== 'undefined') {
      console.warn(`[ExternalCommentManager] Could not anchor pierre thread ${thread?.id} in ${file}`);
    }
  }

  /**
   * Render a file-scoped thread (root + replies) into the file's comments
   * zone above the diff.
   *
   * Two callers, two classes: a GENUINE file-level GitHub comment, and an
   * anchor-degraded line thread, which additionally gets the provenance note
   * from `_buildThreadElement` explaining why it isn't on its line.
   * @private
   */
  _renderThreadFileLevel(thread, file, { degraded = false } = {}) {
    const extraClass = degraded
      ? 'external-comment-row--anchor-degraded'
      : 'external-comment-row--file-level';
    if (this._appendThreadToZone(thread, file, extraClass)) return;
    // Zone missing (rare — created per file in renderFileDiff). Fall back to a
    // bare wrapper append so the discussion stays discoverable.
    if (!this._appendThreadToWrapper(thread, file, extraClass)
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
   * DOM created per file by FileCommentManager.createFileCommentsZone, so it
   * works for BOTH the legacy table and pierre engines.
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
   * Resolve a file's `.file-comments-zone` element. Prefers
   * FileCommentManager's own resolver (DiffRenderer-aware) when present, then
   * falls back to the file wrapper lookup and a direct attribute selector.
   * @param {string} file
   * @returns {HTMLElement|null}
   * @private
   */
  _resolveFileCommentsZone(file) {
    if (typeof document === 'undefined' || !file) return null;
    const fcm = (typeof window !== 'undefined' && window.prManager && window.prManager.fileCommentManager) || null;
    if (fcm && typeof fcm.findZoneForFile === 'function') {
      const zone = fcm.findZoneForFile(file);
      if (zone) return zone;
    }
    const wrapper = this._findFileWrapper(file);
    if (wrapper) {
      const zone = wrapper.querySelector('.file-comments-zone');
      if (zone) return zone;
    }
    try {
      const esc = (typeof globalThis !== 'undefined' && globalThis.CSS?.escape)
        ? globalThis.CSS.escape(file)
        : file;
      return document.querySelector(`.file-comments-zone[data-file-name="${esc}"]`);
    } catch {
      return null;
    }
  }

  /**
   * Resolve a file's `.d2h-file-wrapper` element (shared by both engines).
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
   * its replies, and per-comment actions. Shared by the legacy `<tr>` wrapper
   * (`_buildThreadRow`) and the pierre `<div>` wrapper (`_buildThreadDiv`).
   * @private
   */
  _buildThreadElement(thread) {
    const threadEl = document.createElement('div');
    threadEl.className = 'external-comment-thread';

    // Derived from manager state rather than passed in as a per-thread flag:
    // both wrapper builders and the pierre annotation renderer funnel through
    // here, so one check covers all three.
    const note = this._buildProvenanceNote(thread);
    if (note) threadEl.appendChild(note);

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
   * The "why isn't this on its line?" sentence for an anchor-degraded thread,
   * or null when the thread is anchored normally.
   *
   * Returns null for genuine file-level comments even while degraded — they
   * never had a line anchor, so nothing about them is approximate.
   *
   * The wording follows the REASON the anchor was rejected — claiming a head
   * mismatch on a base-side degrade would be a statement we know to be false.
   * Shared by the rendered card and the chat hooks, so the agent is told
   * exactly what the reviewer is looking at.
   * @private
   */
  _provenanceNoteText(thread) {
    if (!thread) return null;
    if (thread.is_file_level === 1 || thread.is_file_level === true) return null;
    // Re-asked rather than remembered: the same predicate that placed the
    // thread, so the note cannot drift out of step with the placement.
    const outdated = thread.is_outdated === 1 || thread.is_outdated === true;
    const reason = this._anchorDegradeReason(thread, outdated);
    if (reason === null) return null;

    const pr = this.anchorPRNumber != null && Number.isFinite(Number(this.anchorPRNumber))
      ? `PR #${this.anchorPRNumber}`
      : 'the associated PR';
    if (reason === 'base') {
      return `From ${pr} — this comment is on a line the PR removed. Its line numbers `
        + "come from the PR's base commit, which is not what the left side of this diff "
        + 'shows, so the thread appears at file level rather than on its original line.';
    }
    return `From ${pr} — these comments were written against a different commit than the code `
      + 'shown here, so this thread appears at file level rather than on its original line.';
  }

  /** `_provenanceNoteText` as an element, or null. @private */
  _buildProvenanceNote(thread) {
    const text = this._provenanceNoteText(thread);
    if (!text) return null;
    if (typeof document === 'undefined') return null;

    const note = document.createElement('div');
    note.className = 'external-comment-provenance';
    note.textContent = text;
    return note;
  }

  /**
   * Apply the `data-thread-id` / `data-source` attributes both engines' row
   * wrappers rely on (AIPanel.scrollToExternalThread queries them, and the
   * comment-minimizer keys off the class). Kept in one place so the legacy
   * `<tr>` and pierre `<div>` stay identical.
   * @private
   */
  _applyThreadDataset(el, thread) {
    el.dataset.threadId = thread.id != null ? String(thread.id) : '';
    el.dataset.source = thread.source || '';
  }

  /**
   * Build the LEGACY `<tr class="external-comment-row">` wrapper (table-based
   * files) containing the shared thread card. Inserted below the anchor row.
   * @private
   */
  _buildThreadRow(thread, targetRow) {
    if (typeof document === 'undefined') return null;
    const tr = document.createElement('tr');
    tr.className = 'external-comment-row';
    this._applyThreadDataset(tr, thread);

    const td = document.createElement('td');
    // Match user-comment-row colspan of 4 used elsewhere in the diff table
    td.colSpan = this._resolveColSpan(targetRow);
    td.className = 'external-comment-cell';

    td.appendChild(this._buildThreadElement(thread));
    tr.appendChild(td);
    return tr;
  }

  /**
   * Build the PIERRE `<div class="external-comment-row">` wrapper. The bridge
   * slots this into the file's light DOM below the anchor line. Carries the
   * same class + `data-thread-id` / `data-source` as the legacy `<tr>` so page
   * CSS, the minimizer, and the AIPanel scroll-to lookup treat both uniformly.
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
   * Best-effort colSpan resolution. The diff renderer uses a 4-column
   * layout (matches `.user-comment-cell` colSpan=4). Fall back to that
   * if we can't introspect the target row's column count.
   * @private
   */
  _resolveColSpan(targetRow) {
    try {
      const cells = targetRow?.cells || targetRow?.children;
      if (cells && cells.length) return cells.length;
    } catch {
      // ignore
    }
    return 4;
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
   *
   * The surface where a bad anchor costs the most: ChatPanel takes
   * `line_start`/`line_end` as fact — it quotes the LOCAL patch at those
   * numbers (`DiffContext.extractHunkForLines`) and asserts `file.js:123-125`
   * in the prompt header. So the lines go only when the SAME gate that placed
   * the card says they are exact; otherwise they are nulled and `isFileLevel`
   * routes ChatPanel down its file-scoped branch. `anchorNote` carries why.
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
    const fileLevel = comment.is_file_level === 1 || comment.is_file_level === true;
    // A genuine file-level comment has no line anchor to send in the first
    // place, so it takes the same file-scoped shape.
    const trusted = !fileLevel && this._anchorTrusted(comment, outdated);
    const ctx = {
      commentId: comment.id,
      body: comment.body,
      file: comment.file,
      side: comment.side || 'RIGHT',
      line_start: trusted ? (outdated ? comment.original_line_start : comment.line_start) : null,
      line_end: trusted ? (outdated ? comment.original_line_end : comment.line_end) : null,
      source: 'external',
      externalSource: comment.source,
      author: comment.author,
      externalUrl: comment.external_url,
      isOutdated: !!outdated,
    };
    // Set for a degraded anchor AND for a comment GitHub itself marked
    // file-level. The second case also fires in PR mode, where the flag was
    // previously never sent — so a genuinely file-level PR comment's prompt
    // gains a "Scope: File-level comment" line. A correction, not a regression
    // (line_start is already null, so hunk extraction is unaffected), but it
    // means the trusted payload is NOT byte-identical to before.
    if (!trusted) ctx.isFileLevel = true;
    const note = this._provenanceNoteText(comment);
    if (note) ctx.anchorNote = note;
    panel.open({ commentContext: ctx });
  }

  /**
   * Public entry point for chat-about-thread, used by AIPanel's Review-panel
   * quick action. A thin delegate so EVERY thread-chat entry point — the
   * inline card button and the Review panel alike — goes through the same
   * anchor-trust gate in `_openThreadChat`; a caller that builds its own
   * `threadContext` would ship untrusted coordinates ChatPanel asserts as
   * fact.
   * @param {Object} thread - Thread root row (with `replies`), as returned
   *   by `getAllThreads`.
   */
  openThreadChat(thread) {
    this._openThreadChat(thread);
  }

  /**
   * Dispatch chat-about-thread to the chat panel using the canonical
   * `threadContext` shape.
   *
   * Same anchor-trust gate as `_openCommentChat`, but NOT the same escape
   * hatch: `_sendThreadContextMessage` has no `isFileLevel` guard at all —
   * it keys its hunk extraction (and its `file:line` prompt header) purely on
   * `line_start`. So here the lines must actually be null for the context to
   * degrade to file scope.
   * @private
   */
  _openThreadChat(root) {
    const panel = this._resolveChatPanel();
    if (!panel || typeof panel.open !== 'function') {
      this._toast('Chat is unavailable', 'warn');
      return;
    }
    const outdated = root.is_outdated === 1 || root.is_outdated === true;
    const fileLevel = root.is_file_level === 1 || root.is_file_level === true;
    const trusted = !fileLevel && this._anchorTrusted(root, outdated);
    const replies = Array.isArray(root.replies) ? root.replies : [];
    const note = this._provenanceNoteText(root);
    const ctx = {
      rootId: root.id,
      source: 'external',
      externalSource: root.source,
      file: root.file,
      side: root.side || 'RIGHT',
      line_start: trusted ? (outdated ? root.original_line_start : root.line_start) : null,
      line_end: trusted ? (outdated ? root.original_line_end : root.line_end) : null,
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
    };
    // Omitted when the anchor is exact — trusted payload unchanged.
    if (note) ctx.anchorNote = note;
    panel.open({ threadContext: ctx });
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

  /**
   * Insert the external comment row at the correct position after the diff
   * line, preserving the ordering rule:
   *   AI suggestions  →  user comments  →  external comments
   *
   * Walk forward from `targetRow.nextSibling` while we see rows that should
   * come BEFORE us (AI suggestion rows, user comment rows, or already-
   * existing external comment rows for the same diff line). Insert before
   * the first non-comment row we encounter, or at the end of the table.
   * @private
   */
  _insertAtOrderedPosition(targetRow, externalRow) {
    const parent = targetRow.parentNode;
    if (!parent) return;
    let insertBefore = targetRow.nextSibling;
    while (insertBefore && this._isOwnedCommentRow(insertBefore)) {
      insertBefore = insertBefore.nextSibling;
    }
    if (insertBefore) {
      parent.insertBefore(externalRow, insertBefore);
    } else {
      parent.appendChild(externalRow);
    }
  }

  /**
   * Returns true if the given node is a comment-like row that belongs
   * to one of the three diff renderers and should remain ABOVE this
   * new external-comment row.
   * @private
   */
  _isOwnedCommentRow(node) {
    if (!node || node.nodeType !== 1 /* ELEMENT_NODE */) return false;
    const cls = node.classList;
    if (!cls) return false;
    return (
      cls.contains('ai-suggestion-row') ||
      cls.contains('user-comment-row') ||
      cls.contains('external-comment-row')
    );
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
