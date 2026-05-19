// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * ExternalCommentManager - Read-only renderer for external review comments.
 *
 * Consumes `GET /api/reviews/:reviewId/external-comments?source=<source>` and
 * renders thread-grouped comments as `.external-comment-row` rows inserted
 * after the appropriate diff line.
 *
 * Read-only: no draft / submit / edit / dismiss flows. Only chat-about
 * actions, which delegate to the global chat panel.
 *
 * Ordering rule (shared diff-row surface — see plans/fetch-external-review-comments.md
 * "Hazards"): three independent renderers append rows after the same diff
 * line: `.ai-suggestion-row`, `.user-comment-row`, `.external-comment-row`.
 * External rows sit BELOW AI suggestion + user comment rows for the same
 * diff line. This module ONLY touches `.external-comment-row` elements when
 * clearing — it never strips rows owned by other renderers.
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
    return { errors };
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
   * Remove all `.external-comment-row` rows we own from the DOM.
   * Leaves `.user-comment-row` and `.ai-suggestion-row` rows untouched.
   */
  clear() {
    if (typeof document === 'undefined') return;
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
      // File-level fallback: outdated discussions that we can't anchor
      // precisely still need to be discoverable. Render them at the top of
      // the file wrapper so the reviewer can find them via the file panel.
      const fallbackTarget = this._resolveFileFallbackTarget(anchor.file);
      if (fallbackTarget) {
        const externalRow = this._buildThreadRow(thread, fallbackTarget);
        if (externalRow) {
          externalRow.classList.add('external-comment-row--file-fallback');
          this._insertAtOrderedPosition(fallbackTarget, externalRow);
          return;
        }
      }

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

  /**
   * Find a fallback insertion target for a file when no diff row matches
   * the comment's anchor (e.g. outdated comment whose original line is no
   * longer in the diff at all). Returns the first <tr> in the file
   * wrapper's table so the thread renders at file-level. Returns null when
   * the file wrapper itself isn't in the DOM.
   * @private
   */
  _resolveFileFallbackTarget(file) {
    if (typeof document === 'undefined' || !file) return null;
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
    return fileElement.querySelector('tr');
  }

  /**
   * Build the `<tr class="external-comment-row">` wrapper containing the
   * root comment, replies, and per-thread actions.
   * @private
   */
  _buildThreadRow(thread, targetRow) {
    if (typeof document === 'undefined') return null;
    const tr = document.createElement('tr');
    tr.className = 'external-comment-row';
    tr.dataset.threadId = thread.id != null ? String(thread.id) : '';
    tr.dataset.source = thread.source || '';

    const td = document.createElement('td');
    // Match user-comment-row colspan of 4 used elsewhere in the diff table
    td.colSpan = this._resolveColSpan(targetRow);
    td.className = 'external-comment-cell';

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

    // Thread-level action: chat about whole thread
    const threadActions = document.createElement('div');
    threadActions.className = 'external-comment-actions external-comment-thread-actions';
    const chatThreadBtn = this._buildChatThreadButton(thread);
    threadActions.appendChild(chatThreadBtn);
    threadEl.appendChild(threadActions);

    td.appendChild(threadEl);
    tr.appendChild(td);
    return tr;
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

    // Permalink (right side of header) — drop when URL fails the safety check.
    if (comment.external_url && this._isSafeUrl(comment.external_url)) {
      const link = document.createElement('a');
      link.className = 'external-comment-permalink';
      link.href = comment.external_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'Open in source system';
      link.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7.75 2.5a.75.75 0 0 0 0 1.5h2.69L5.22 9.22a.75.75 0 1 0 1.06 1.06L11.5 5.06v2.69a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75ZM3.75 3A1.75 1.75 0 0 0 2 4.75v7.5C2 13.216 2.784 14 3.75 14h7.5A1.75 1.75 0 0 0 13 12.25v-3.5a.75.75 0 0 0-1.5 0v3.5a.25.25 0 0 1-.25.25h-7.5a.25.25 0 0 1-.25-.25v-7.5a.25.25 0 0 1 .25-.25h3.5a.75.75 0 0 0 0-1.5Z"/></svg>';
      header.appendChild(link);
    }

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

    // ---- Actions ----
    const actions = document.createElement('div');
    actions.className = 'external-comment-actions';
    const chatBtn = this._buildChatCommentButton(comment);
    actions.appendChild(chatBtn);
    el.appendChild(actions);

    return el;
  }

  /**
   * Build the per-comment "Chat about this comment" button.
   * @private
   */
  _buildChatCommentButton(comment) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-chat-comment external-comment-chat-btn';
    btn.title = 'Chat about this comment';
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openCommentChat(comment);
    });
    return btn;
  }

  /**
   * Build the per-thread "Chat about this thread" button.
   * @private
   */
  _buildChatThreadButton(thread) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-chat-thread external-comment-chat-thread-btn';
    btn.title = 'Chat about this thread';
    // Stacked-bubbles glyph: two overlapping chat bubbles. Visually distinct
    // from the single-bubble chat-comment button so the reviewer can tell
    // "chat about THIS comment" apart from "chat about WHOLE thread".
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg> Chat about thread';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openThreadChat(thread);
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
