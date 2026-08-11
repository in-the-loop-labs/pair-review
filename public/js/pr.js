// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Pull Request UI Management
 * Main orchestrator that coordinates the extracted modules:
 * - HunkParser: Hunk header parsing and gap context expansion
 * - LineTracker: Line number mapping and range selection
 * - DiffRenderer: Diff parsing and line rendering
 * - CommentManager: Comment forms and editing
 * - SuggestionManager: AI suggestion handling
 */
// Timeout (ms) for stale check — git commands can hang on locked repos
const STALE_TIMEOUT = 2000;

class PRManager {
  // Forward static constants from modules for backward compatibility
  static get FOLD_UP_ICON() {
    return window.HunkParser?.FOLD_UP_ICON || '';
  }

  static get FOLD_DOWN_ICON() {
    return window.HunkParser?.FOLD_DOWN_ICON || '';
  }

  static get UNFOLD_ICON() {
    return window.HunkParser?.UNFOLD_ICON || '';
  }

  static get FOLD_UP_DOWN_ICON() {
    return window.HunkParser?.FOLD_UP_DOWN_ICON || '';
  }

  static get EYE_ICON() {
    return window.DiffRenderer?.EYE_ICON || '';
  }

  static get EYE_CLOSED_ICON() {
    return window.DiffRenderer?.EYE_CLOSED_ICON || '';
  }

  static get GENERATED_FILE_ICON() {
    return window.DiffRenderer?.GENERATED_FILE_ICON || '';
  }

  static get LANGUAGE_MAP() {
    return window.DiffRenderer?.LANGUAGE_MAP || {};
  }

  static get DEFAULT_EXPAND_LINES() {
    return window.HunkParser?.DEFAULT_EXPAND_LINES || 20;
  }

  static get SMALL_GAP_THRESHOLD() {
    return window.HunkParser?.SMALL_GAP_THRESHOLD || 10;
  }

  static get AUTO_EXPAND_THRESHOLD() {
    return window.HunkParser?.AUTO_EXPAND_THRESHOLD || 6;
  }

  static PIERRE_HIGHLIGHT_MAX_PATCH_CHARS = 300 * 1024;
  static PIERRE_HIGHLIGHT_MAX_PATCH_LINES = 3000;
  static PIERRE_AUTO_RENDER_MAX_PATCH_CHARS = 500 * 1024;
  static PIERRE_AUTO_RENDER_MAX_PATCH_LINES = 20000;
  static PIERRE_UPGRADE_MAX_PATCH_CHARS = 120 * 1024;
  static PIERRE_UPGRADE_MAX_PATCH_LINES = 3000;
  static PIERRE_UPGRADE_MAX_CONTENT_CHARS = 400 * 1024;
  static PIERRE_UPGRADE_MAX_CONTENT_LINES = 12000;
  static PIERRE_UPGRADE_CONCURRENCY = 4;
  static PIERRE_BACKGROUND_UPGRADE_DELAY_MS = 1000;
  static PIERRE_POINTER_UPGRADE_RETRY_MS = 400;

  // Logo icon - infinity loop rotated for "in-the-loop" branding
  static LOGO_ICON = `
    <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
      <path transform="rotate(-50 12 12)" d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.356-8-5.096 0-5.096 8 0 8 5.223 0 7.26-8 12.356-8z"/>
    </svg>
  `;

  /**
   * Forward static methods to modules
   */
  static extractFunctionContext(header) {
    return window.HunkParser?.extractFunctionContext(header) || null;
  }

  static getBlockCoordinateBounds(block, mode) {
    return window.HunkParser?.getBlockCoordinateBounds(block, mode) || { old: null, new: null };
  }

  static detectLanguage(fileName) {
    return window.DiffRenderer?.detectLanguage(fileName) || 'plaintext';
  }

  /**
   * Generate a safe localStorage key for repository-specific settings.
   * Delegates to the shared helper in public/js/utils/storage-keys.js
   * (loaded before pr.js) so keys stay byte-identical with the index/bulk page,
   * which writes the same per-repo keys this page reads.
   * @param {string} prefix - Key prefix (e.g., 'pair-review-model')
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {string} Safe localStorage key
   */
  static getRepoStorageKey(prefix, owner, repo) {
    return window.getRepoStorageKey(prefix, owner, repo);
  }

  constructor() {
    this.currentPR = null;
    this.loadingState = false;
    this.expandedFolders = new Set();
    this.expandedSections = new Set();
    // Resolved theme ('light'|'dark') — the diff renderer needs a concrete
    // value, never the 'system' preference. Kept in sync by initTheme().
    this.currentTheme = window.PairReviewTheme.resolvePreference();
    this.suggestionNavigator = null;
    // AI analysis state
    this.isAnalyzing = false;
    this.currentAnalysisId = null;
    // Level filter state - default to 'final' (orchestrated suggestions)
    this.selectedLevel = 'final';
    // Split button for comment actions
    this.splitButton = null;
    // Generated files - collapsed by default, stores map of filename -> generated info
    this.generatedFiles = new Map();
    // User comments storage
    this.userComments = [];
    // Analysis config modal
    this.analysisConfigModal = null;
    // File collapse state - tracks which files are manually collapsed
    this.collapsedFiles = new Set();
    // File viewed state - tracks which files are marked as viewed
    this.viewedFiles = new Set();
    // Context files - pinned non-diff file ranges
    this.contextFiles = [];
    // Diff-only files from the sidebar list. null until updateFileList delivers
    // the list — distinct from [] (a genuinely empty diff), because the
    // "diff wins" suppression in loadContextFiles must not treat "not loaded
    // yet" as "no diff files".
    this.diffFiles = null;
    // Canonical file order - sorted file paths for consistent ordering across components
    this.canonicalFileOrder = new Map();
    // Raw per-file patch text for chat context enrichment
    this.filePatches = new Map();
    // Current rendered changed files keyed by path. Used to materialize
    // deferred diffs and lazily fetch full-file metadata for line anchors.
    this.changedFilesByPath = new Map();
    this._fileContentsUpgradeState = null;
    this._pierreContentUpgradePromises = new Map();
    // Eligible-by-size files that should get background content upgrade as their
    // lazy Pierre bodies render (set in _upgradeFilesWithContents, reset in
    // renderDiff). Null when no upgrade session is active.
    this._pierreUpgradeCandidates = null;
    // Analysis history manager - for switching between analysis runs
    this.analysisHistoryManager = null;
    // Currently selected analysis run ID (null = latest)
    this.selectedRunId = null;
    // Keyboard shortcuts manager
    this.keyboardShortcuts = null;
    // Hide whitespace toggle state — must be set before DiffOptionsDropdown
    // is constructed because it fires the callback synchronously on init
    // when localStorage has a persisted `true` value.
    this.hideWhitespace = false;
    // Diff options dropdown (gear icon popover)
    this.diffOptionsDropdown = null;
    // Comment minimizer — manages minimize mode indicators
    this.commentMinimizer = window.CommentMinimizer ? new window.CommentMinimizer() : null;
    // Hunk summary renderer (Phase 5) — inline natural-language summaries
    this.hunkSummaryRenderer = window.HunkSummaryRenderer ? new window.HunkSummaryRenderer(this) : null;
    // Per-render anchor map, file-scoped so a content-hash shared across two
    // files (renamed-with-tiny-edits, copy-pasted boilerplate, identical
    // stubs) can't let the later file's anchor overwrite the earlier one's:
    //   Map<filePath, Map<contentHash, anchorRow>>
    // where anchorRow is the first code-line <tr> of the hunk. Symmetric with
    // `_pendingSummariesByHash` so both sides of the queue/anchor handshake
    // key on (filePath, hash).
    this._summaryAnchorsByHash = new Map();
    // Per-render file map: filePath -> Set<contentHash>
    this._summaryHashesByFile = new Map();
    // Summaries that arrived (via WS or fetch) before their hunk had been
    // hashed, scoped by file path so a content-hash collision across files
    // can't let one file's anchor consume another file's queued summary:
    //   Map<filePath, Map<contentHash, summary>>
    // The '' bucket holds summaries queued without a file path (the legacy
    // ungrouped-fetch fallback in _fetchHunkSummaryMap).
    this._pendingSummariesByHash = new Map();
    // Per-file summary visibility (persisted in localStorage per-review)
    this.summariesHiddenFiles = new Set();
    // Render-generation token — incremented at the top of renderDiff() so any
    // fire-and-forget _fetchHunkSummaryMap() from a prior render can detect
    // it's stale and bail (refresh / whitespace toggle / scope change race).
    this._renderGen = 0;
    // ---- Lazy diff-body rendering (perf for very large PRs) -----------
    // Each file's wrapper + header render eagerly, but the <tbody> of diff
    // lines is built on demand: when the body scrolls near the viewport
    // (IntersectionObserver), when the file is expanded, or when a code path
    // needs to anchor into it (see ensureFileBodyRendered). Collapsed bodies
    // are `display:none`, so they never intersect and stay unrendered until
    // expanded. Key = file path; value = lazy entry (see renderFileDiff).
    this._lazyFileBodies = new Map();
    // The IntersectionObserver watching `.d2h-file-body` elements for the
    // current render generation. Recreated on every renderDiff().
    this._fileBodyObserver = null;
    // Cached /api/config response (lazy-loaded)
    this._appConfigPromise = null;
    // Review-level summary visibility (persisted in localStorage per-review)
    this._summariesHidden = false;
    // Whether the background summary job is currently running for this review.
    // Cleared by the `review:background_job_finished` event for jobType=summaries.
    this._summariesGenerating = false;
    // Whether any hunk summaries exist for this review (loaded from the server
    // or mounted live during generation). Gates the toolbar button's `.active`
    // (blue) state: before any summary exists the button stays colorless so the
    // user can tell nothing has been generated yet. Set true by
    // `_applyHunkSummaries` and the initial existing-summaries fetch.
    this._summariesGenerated = false;
    // Whether any non-trivial hunk summary EXISTS for this review — mounted
    // OR merely queued because its lazy file body hasn't rendered yet. This is
    // deliberately separate from `_summariesGenerated` (which gates the
    // `.active` blue styling and tracks summaries actually in the DOM): with
    // lazy bodies a valid summary can arrive before its anchor exists, and the
    // toolbar must still treat the feature as "has data" so a click toggles
    // visibility instead of dispatching a duplicate generation job. Set by
    // `_applyHunkSummaries` / `_fetchHunkSummaryMap`; reset in renderDiff.
    this._summariesAvailable = false;
    // Tri-state: true when /api/config reports summaries.enabled, false when
    // disabled, null until /api/config resolves. Per-file toggle buttons are
    // gated on this so users on disabled deployments don't see them flicker
    // in.
    this._summariesEnabled = null;
    // Tri-state mirror of `summaries.auto_generate` in /api/config. When
    // false, the click handler hits the manual-start endpoint instead of
    // expecting a server-initiated kickoff. Null until /api/config resolves.
    this._summariesAutoGenerate = null;
    // ---- Tour state (Phase 8) -----------------------------------------
    // Lazy-instantiated TourBar / TourRenderer; populated on first open.
    this._tourBar = null;
    this._tourRenderer = null;
    // Tri-state mirror of `tours.enabled` in /api/config. Tours are
    // independent of summaries on both the server and the client (see
    // the explanatory comment in setupEventHandlers()).
    this._toursEnabled = null;
    // Tri-state mirror of `tours.auto_generate` in /api/config. When false,
    // the click handler hits the manual-start endpoint instead of expecting
    // a server-initiated kickoff. Null until /api/config resolves.
    this._toursAutoGenerate = null;
    // Cached stops from the most recent /api/reviews/:id/tour fetch, or null
    // when nothing has been loaded for this review yet.
    this._tourStops = null;
    // 0-based index of the current stop while a tour is open; -1 when no
    // tour is mounted.
    this._tourActiveIndex = -1;
    // Whether the background tour-generation job is currently running; drives
    // the pulse on the toolbar button.
    this._tourGenerating = false;
    // When a `review:tour_ready` event fires while a tour is already mounted,
    // we stash the new stops here rather than yank the current tour out from
    // under the user. The pending stops are applied on the next exit or
    // restart. Cleared once consumed.
    this._tourStopsPendingRestart = null;
    // Bound keydown handler; tracked so it can be removed on tour exit.
    this._tourKeydownHandler = null;
    // Re-entry guard for `_promptCancelJob`. The cancel-confirm dialog
    // opens off the same pulsing toolbar button that triggered it, and
    // the button stays clickable while the dialog is up — `ConfirmDialog`
    // is a singleton, so a second click would overwrite the first
    // invocation's callbacks and leave its Promise dangling. Held true
    // for the lifetime of the dialog; cleared in a `finally`.
    this._cancelPromptOpen = false;
    // Re-entrance latch for the async `_advanceTour` probe loop. Holds the
    // `_tourGen` value the in-flight call belongs to (or -1 when no call
    // is in flight). Generation-scoped — not a plain boolean — so a
    // teardown that bumps `_tourGen` auto-invalidates the holder and the
    // next reopen passes the latch check without any teardown path having
    // to remember to reset the flag explicitly.
    this._advanceInFlightGen = -1;
    // Tour-open generation. Bumped on every open and exit so an in-flight
    // async `_advanceTour` can detect that the tour it started navigating
    // has since been torn down (Escape, exit button, toolbar toggle) and
    // bail instead of mutating a dead tour's state.
    this._tourGen = 0;
    // Drain promise stashed by `_exitTour`. Resolves once every async
    // teardown step from the prior tour (fire-and-forget context-file
    // DELETEs + their loadContextFiles reloads) has settled. The next
    // open awaits this before reading wrappers so a stale DELETE can't
    // rip the newly-mounted tour's wrapper out from under it.
    this._tourCleanupPending = null;
    // Cached staleness check promise — shared between on-load and triggerAIAnalysis
    this._stalenessPromise = null;
    // Unique client ID for self-echo suppression on WebSocket review events.
    // Sent as X-Client-Id header on mutation requests; the server echoes
    // it back in the WebSocket broadcast so this tab can skip its own events.
    this._clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this._installFetchInterceptor();

    // Initialize modules
    this.lineTracker = new window.LineTracker();
    this.commentManager = new window.CommentManager(this);
    this.suggestionManager = new window.SuggestionManager(this);
    this.fileCommentManager = window.FileCommentManager ? new window.FileCommentManager(this) : null;

    // Initialize PierreBridge for @pierre/diffs rendering.
    // Read the persisted diff-view preference so the first render uses the
    // saved style (no flash, no double render). localStorage is the single
    // source of truth shared with DiffOptionsDropdown; readPersistedDiffView
    // (from DiffOptionsDropdown.js, loaded first) owns the key + validation.
    const initialDiffStyle = window.readPersistedDiffView
      ? window.readPersistedDiffView()
      : (localStorage.getItem('pair-review-diff-view') === 'split' ? 'split' : 'unified');
    this.pierreBridge = window.PierreBridge ? new window.PierreBridge({
      theme: this.currentTheme,
      diffStyle: initialDiffStyle,
      onCommentClick: (fileName, lineNumber, side, target) => {
        // target.isRange is true when the user selected multiple lines
        const diffPosition = this.pierreBridge.getDiffPosition(fileName, target.start, target.side);
        if (target.isRange) {
          this.showCommentForm(null, target.start, fileName, diffPosition, target.end, target.side);
        } else {
          this.showCommentForm(null, lineNumber, fileName, diffPosition, null, side);
        }
      },
      onChatClick: (fileName, lineNumber, side, target) => {
        if (!window.chatPanel) return;
        window.chatPanel.open({
          commentContext: {
            type: 'line',
            body: null,
            file: fileName || '',
            line_start: target.start,
            line_end: target.end,
            side: target.side || side || 'RIGHT',
            source: 'user'
          }
        });
      },
      onCommentEdit: (comment) => {
        if (this.commentManager) {
          this.commentManager.editComment(comment.id);
        }
      },
      onCommentDelete: (comment) => {
        if (this.commentManager) {
          this.commentManager.deleteComment(comment.id);
        }
      },
      onSuggestionAdopt: (suggestion) => {
        if (this.suggestionManager) {
          this.suggestionManager.adoptSuggestion(suggestion.id);
        }
      },
      onSuggestionDismiss: (suggestion) => {
        if (this.suggestionManager) {
          this.suggestionManager.dismissSuggestion(suggestion.id);
        }
      },
      onCommentFormSubmit: (fileName, annotationId, data, body) => {
        this._handleCommentFormSubmit(fileName, annotationId, data, body);
      },
      onCommentFormCancel: (fileName, annotationId, data) => {
        this.pierreBridge.removeAnnotation(fileName, annotationId);
      },
      onSuggestionInsert: (textarea, button) => {
        if (this.commentManager) {
          this.commentManager.insertSuggestionBlock(textarea, button);
        }
      },
    }) : null;

    // Line range selection state - delegate to lineTracker
    Object.defineProperty(this, 'rangeSelectionStart', {
      get: () => this.lineTracker.rangeSelectionStart,
      set: (v) => { this.lineTracker.rangeSelectionStart = v; }
    });
    Object.defineProperty(this, 'rangeSelectionEnd', {
      get: () => this.lineTracker.rangeSelectionEnd,
      set: (v) => { this.lineTracker.rangeSelectionEnd = v; }
    });
    Object.defineProperty(this, 'isDraggingRange', {
      get: () => this.lineTracker.isDraggingRange,
      set: (v) => { this.lineTracker.isDraggingRange = v; }
    });
    Object.defineProperty(this, 'dragStartLine', {
      get: () => this.lineTracker.dragStartLine,
      set: (v) => { this.lineTracker.dragStartLine = v; }
    });
    Object.defineProperty(this, 'dragEndLine', {
      get: () => this.lineTracker.dragEndLine,
      set: (v) => { this.lineTracker.dragEndLine = v; }
    });
    Object.defineProperty(this, 'potentialDragStart', {
      get: () => this.lineTracker.potentialDragStart,
      set: (v) => { this.lineTracker.potentialDragStart = v; }
    });

    // Stack analysis components
    this.stackAnalysisDialog = window.StackAnalysisDialog ? new window.StackAnalysisDialog() : null;
    this.stackProgressModal = window.StackProgressModal ? new window.StackProgressModal() : null;
    // Track open state of split button and stack nav dropdowns
    this._analyzeDropdownOpen = false;
    this._stackNavOpen = false;
    this._closeAnalyzeDropdown = null;
    this._closeStackNav = null;

    // Initialize event handlers and UI
    this.setupEventHandlers();
    this.initTheme();
    this.initAnalysisConfigModal();
    this.initKeyboardShortcuts();

    // Track toolbar height for sticky file headers (they sit below the sticky toolbar)
    this._initToolbarHeightTracking();

    // Initialize diff options dropdown (gear icon for whitespace toggle).
    // Must happen before init() so the persisted hideWhitespace state is
    // applied before the first loadAndDisplayFiles() call.
    const diffOptionsBtn = document.getElementById('diff-options-btn');
    if (diffOptionsBtn && window.DiffOptionsDropdown) {
      this.diffOptionsDropdown = new window.DiffOptionsDropdown(diffOptionsBtn, {
        onToggleWhitespace: (hide) => this.handleWhitespaceToggle(hide),
        onToggleMinimize: (minimized) => this.handleMinimizeToggle(minimized),
        onDiffViewChange: (mode) => this.handleDiffViewChange(mode),
        diffView: initialDiffStyle,
        // Only offer the Unified/Split control when a Pierre render path can
        // apply it. Without the bridge, handleDiffViewChange no-ops and the
        // legacy renderer stays unified, so a selection would desync.
        diffViewAvailable: Boolean(this.pierreBridge && !this.pierreBridge._disabled),
      });
    }

    // Initialize notification sounds dropdown (bell icon)
    const notifBtn = document.getElementById('notification-toggle');
    if (notifBtn && window.NotificationDropdown) {
      const notifEvents = window.PAIR_REVIEW_LOCAL_MODE ? ['analysis'] : ['analysis', 'setup'];
      this.notificationDropdown = new window.NotificationDropdown(notifBtn, { events: notifEvents });
    }

    // In local mode, LocalManager handles init instead
    if (!window.PAIR_REVIEW_LOCAL_MODE) {
      this.init();
    }
  }

  /**
   * Install a global fetch interceptor that adds X-Client-Id to all
   * mutation requests (POST/PUT/DELETE) targeting the review API.
   * This is the SINGLE SOURCE of X-Client-Id injection — no individual
   * fetch call site should manually set this header.
   * This ensures that even direct fetch() calls (e.g. from page.evaluate
   * in tests, or any code that bypasses PRManager methods) carry the
   * client ID so the server can tag the WebSocket broadcast for self-echo
   * suppression.
   */
  _installFetchInterceptor() {
    if (window._prFetchIntercepted) return;
    window._prFetchIntercepted = true;

    const originalFetch = window.fetch;
    const prManager = this;

    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = (init?.method || 'GET').toUpperCase();

      // Only intercept mutations to the reviews API
      if ((method === 'POST' || method === 'PUT' || method === 'DELETE') &&
          url.includes('/api/reviews/') && prManager._clientId) {
        init = init || {};
        // Merge X-Client-Id into existing headers
        if (init.headers instanceof Headers) {
          if (!init.headers.has('X-Client-Id')) {
            init.headers.set('X-Client-Id', prManager._clientId);
          }
        } else if (typeof init.headers === 'object' && init.headers !== null) {
          if (!init.headers['X-Client-Id']) {
            init.headers['X-Client-Id'] = prManager._clientId;
          }
        } else {
          init.headers = { 'X-Client-Id': prManager._clientId };
        }
      }
      return originalFetch.call(this, input, init);
    };
  }

  /**
   * Keep --toolbar-height CSS variable in sync with the actual toolbar size
   * so sticky file headers can position themselves below the sticky toolbar.
   */
  _initToolbarHeightTracking() {
    const toolbar = document.querySelector('.diff-toolbar');
    if (!toolbar) return;

    const update = () => {
      document.documentElement.style.setProperty(
        '--toolbar-height', toolbar.offsetHeight + 'px'
      );
    };
    update();

    // Re-measure when toolbar resizes (e.g. analysis dots appear/disappear)
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(update).observe(toolbar);
    }
  }

  /**
   * Keep --diff-file-header-height in sync with the rendered sticky file
   * header so navigation (block:'start' + scroll-margin-top in pr.css) lands
   * targets just below the header rather than hidden behind it. Headers are
   * single-line and uniform, so measuring the first one is representative.
   * Call after renderDiff appends the headers.
   */
  _measureFileHeaderHeight(attempt = 0) {
    const header = document.querySelector('.d2h-file-wrapper .d2h-file-header');
    if (header && header.offsetHeight) {
      document.documentElement.style.setProperty(
        '--diff-file-header-height', header.offsetHeight + 'px'
      );
      return;
    }
    // In Local + CodeView the header light DOM mounts a few frames after
    // renderAll (PR mode has it at the first rAF; Local does not), so a single
    // pass leaves --diff-file-header-height unset and scrollToFile/scroll-margin
    // fall back to 0. Retry until the header exists. Idempotent in both modes.
    if (attempt < 8) {
      requestAnimationFrame(() => this._measureFileHeaderHeight(attempt + 1));
    }
  }

  /**
   * Feed CodeView the real rendered item-height metrics (header, line-row and
   * hunk-separator px) so its estimates match the DOM. The vendor's
   * getEstimatedLineHeight is static (returns metrics.lineHeight for every
   * off-screen line, never adapting to measured heights) and the custom header
   * is never measured — so its defaults (lineHeight 20 vs our real ~17.4px,
   * diffHeaderHeight 44 vs our ~53px) make reserved heights disagree with
   * rendered heights, which then shifts as lines mount on scroll (wandering
   * gaps) and makes navigation land off. Call after a CodeView render.
   *
   * The header lives in light DOM (measured into --diff-file-header-height by
   * _measureFileHeaderHeight); the line rows and separators live in the vendor
   * Shadow DOM, which populates a frame or two after mount — retry a bounded
   * number of times until the line height is measurable.
   */
  _syncCodeViewItemMetrics(attempt = 0) {
    if (!this._usesPierreCodeView() ||
        typeof this.pierreBridge.setItemMetrics !== 'function') {
      return;
    }
    const metrics = {};
    // Probe every mounted host, not just the first: a binary or header-only first
    // file has no shadow line rows at all, so sampling only that host re-measures
    // the same row-less shadow root on each retry, burns the attempt budget and
    // leaves lineHeight at the vendor default (~20 vs the real ~17.4) for the
    // WHOLE view — which is the wandering-gap jank this method exists to prevent.
    const hosts = document.querySelectorAll('#diff-container diffs-container');
    for (const host of hosts) {
      // Header lives in the item's light DOM. Measure it directly rather than
      // trusting --diff-file-header-height, whose _measureFileHeaderHeight write
      // can lag behind this pass (it did in Local mode); fall back to the CSS
      // var only if no header is mounted yet.
      if (metrics.diffHeaderHeight == null) {
        const header = host.querySelector('.d2h-file-header');
        if (header) {
          const h = header.getBoundingClientRect().height;
          if (h > 0) metrics.diffHeaderHeight = h;
        }
      }
      const shadow = host.shadowRoot;
      if (shadow) {
        if (metrics.lineHeight == null) {
          const line = shadow.querySelector('[data-line-index]');
          if (line) {
            const h = line.getBoundingClientRect().height;
            if (h > 0) metrics.lineHeight = h;
          }
        }
        if (metrics.hunkSeparatorHeight == null) {
          const separator = shadow.querySelector('[data-separator-wrapper]');
          if (separator) {
            const h = separator.getBoundingClientRect().height;
            if (h > 0) metrics.hunkSeparatorHeight = h;
          }
        }
      }
      // Separators are optional (a full-context file has none), so stop once the
      // two metrics every item depends on are measured.
      if (metrics.diffHeaderHeight != null && metrics.lineHeight != null) break;
    }
    if (metrics.diffHeaderHeight == null) {
      const headerPx = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--diff-file-header-height')
      );
      if (Number.isFinite(headerPx) && headerPx > 0) metrics.diffHeaderHeight = headerPx;
    }

    if (Object.keys(metrics).length) this.pierreBridge.setItemMetrics(metrics);

    // The header (light DOM) and line rows (vendor Shadow DOM) can each mount a
    // frame or two after render; retry until both are measured so neither the
    // header offset nor off-screen line reservation is left at a vendor default.
    if ((metrics.diffHeaderHeight == null || metrics.lineHeight == null) && attempt < 8) {
      requestAnimationFrame(() => this._syncCodeViewItemMetrics(attempt + 1));
    }
  }

  /**
   * Set up event handlers
   */
  setupEventHandlers() {
    // Theme toggle is wired by the shared helper in initTheme() (js/theme.js).

    // Analyze button
    const analyzeBtn = document.getElementById('analyze-btn');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', () => this.triggerAIAnalysis());
    }

    // Refresh PR button
    const refreshBtn = document.getElementById('refresh-pr');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refreshPR());
    }

    // Refresh external (GitHub) review comments. Handler lives on the
    // instance so unit tests can call it directly (avoids duplicating the
    // production click logic in tests, per CLAUDE.md).
    // Skip wiring entirely when the external_comments feature toggle is
    // off — the button is also CSS-hidden via .external-comments-only, so
    // this is belt-and-suspenders.
    if (this._externalCommentsEnabled()) {
      const refreshExternalBtnPanel = document.getElementById('refresh-external-comments-btn-panel');
      if (refreshExternalBtnPanel) {
        refreshExternalBtnPanel.addEventListener('click', () => {
          void this._handleExternalCommentsRefreshClick({ button: refreshExternalBtnPanel });
        });
      }
    }

    // Hunk summary toolbar toggle (Phase 5).
    // Hidden by default in HTML; revealed asynchronously when /api/config
    // reports summaries.enabled. The same config check also controls the
    // per-file `.file-header-summary-toggle` buttons (which are created
    // hidden by createFileHeader and revealed/removed once config resolves).
    const summaryToggle = document.getElementById('summary-toggle-btn');
    if (summaryToggle) {
      summaryToggle.addEventListener('click', () => this._handleSummaryToggleClick());
    }
    this._getAppConfig().then((cfg) => {
      const summariesCfg = (cfg && cfg.summaries) || {};
      this._summariesEnabled = summariesCfg.enabled === true;
      this._summariesAutoGenerate = summariesCfg.auto_generate !== false;
      if (this._summariesEnabled) {
        if (summaryToggle) {
          summaryToggle.style.display = '';
          this._syncSummaryToolbarButton();
        }
        document
          .querySelectorAll('.file-header-summary-toggle.summary-toggle-pending')
          .forEach((btn) => {
            btn.classList.remove('summary-toggle-pending');
            btn.style.display = '';
          });
      } else {
        document
          .querySelectorAll('.file-header-summary-toggle')
          .forEach((btn) => btn.remove());
      }
    });

    // Tour toolbar toggle (Phase 8). Hidden by default in HTML; revealed
    // asynchronously once /api/config confirms `tours.enabled` is on.
    // Tours are independent of `summaries.enabled` — both server- and
    // client-side gates check only `tours.enabled`.
    const tourToggle = document.getElementById('tour-toggle-btn');
    if (tourToggle) {
      tourToggle.addEventListener('click', () => this._handleTourToggleClick());
    }
    this._getAppConfig().then((cfg) => {
      const toursCfg = (cfg && cfg.tours) || {};
      this._toursEnabled = toursCfg.enabled === true;
      this._toursAutoGenerate = toursCfg.auto_generate !== false;
      if (this._toursEnabled && tourToggle) {
        tourToggle.style.display = '';
        this._syncTourToolbarButton();
      }
      // NOTE: do NOT probe /api/reviews/:id/tour here when no diff has
      // rendered yet — `currentPR.id` is not populated until
      // init()/LocalManager loads the review. The probe is normally
      // deferred to renderDiff() (which fires after currentPR is set).
      //
      // RACE: if renderDiff() has ALREADY run by the time /api/config
      // resolves, its `_toursEnabled === true` check failed (was still
      // null) and the probe was skipped. Catch that case here so the
      // tour toolbar still surfaces a generated tour.
      if (this._toursEnabled && this._renderGen > 0) {
        this._loadAndStashTour({ cancelOnRender: false }).catch(() => {});
      }
    });

    // PR description popover
    this.setupPRDescriptionPopover();

    // Setup comment form keyboard shortcut delegation
    this.setupCommentFormDelegation();

    // Listen for level filter changes from AI panel
    document.addEventListener('levelChanged', (e) => {
      const level = e.detail?.level;
      if (level) {
        this.selectedLevel = level;
        this.loadAISuggestions(level);
      }
    });

    // Listen for filter dismissed changes from AI panel
    document.addEventListener('filterDismissedChanged', (e) => {
      const showDismissed = e.detail?.showDismissed;
      this.loadUserComments(showDismissed);
    });
  }

  /**
   * Setup delegated event listeners for comment form keyboard shortcuts
   * This avoids memory leaks from attaching listeners to each textarea
   */
  setupCommentFormDelegation() {
    document.addEventListener('keydown', (e) => {
      // Check if we're in a comment-related textarea
      const textarea = e.target;
      if (!textarea.matches('.comment-textarea, .comment-edit-textarea')) {
        return;
      }

      // Escape key - cancel
      if (e.key === 'Escape') {
        e.preventDefault();
        // Find and click the cancel button
        const form = textarea.closest('.user-comment-form, .user-comment-edit-form');
        const cancelBtn = form?.querySelector('.cancel-comment-btn, .cancel-edit-btn');
        if (cancelBtn) {
          cancelBtn.click();
        } else {
          // Fallback to hideCommentForm
          this.hideCommentForm();
          this.clearRangeSelection();
        }
        return;
      }

      // Cmd/Ctrl + Enter - save
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Find and click the save button
        const form = textarea.closest('.user-comment-form, .user-comment-edit-form');
        const saveBtn = form?.querySelector('.save-comment-btn, .save-edit-btn');
        if (saveBtn) {
          saveBtn.click();
        }
        return;
      }
    });
  }

  /**
   * Initialize the PR viewer
   */
  async init() {
    try {
      // First, check if we have PR context from URL path (e.g., /pr/owner/repo/number)
      const pathMatch = window.location.pathname.match(/^\/pr\/([^\/]+)\/([^\/]+)\/(\d+)$/);
      if (pathMatch) {
        const [, owner, repo, number] = pathMatch;
        const prNumber = parseInt(number);
        await this.loadPR(owner, repo, prNumber);

        // Auto-trigger analysis if ?analyze=true is present
        await this._maybeAutoAnalyze(owner, repo, prNumber);

        return;
      }

      // Fallback: Check if we have PR context from URL query parameters
      const urlParams = new URLSearchParams(window.location.search);
      const prRef = urlParams.get('pr');

      if (!prRef) {
        this.showError('No PR reference provided. Use ?pr=owner/repo/number');
        return;
      }

      // Parse PR reference from query param
      const parts = prRef.split('/');
      if (parts.length !== 3) {
        throw new Error('Invalid PR reference format. Expected: owner/repo/number');
      }

      const [owner, repo, numberStr] = parts;
      const prNumber = parseInt(numberStr);
      await this.loadPR(owner, repo, prNumber);

      // Auto-trigger analysis if ?analyze=true is present
      await this._maybeAutoAnalyze(owner, repo, prNumber);
    } catch (error) {
      console.error('Error initializing PR viewer:', error);
      this.showError(error.message);
    }
  }

  /**
   * Build analysis config from repo defaults (no modal interaction).
   * Used by auto-analyze (--ai) to honour the repository's default provider/council.
   * When the default is a council, fetches the council config from the server so the
   * progress modal can render the voice/level layout.
   * @param {Object|null} repoSettings - Repo settings from fetchRepoSettings()
   * @param {Object} reviewSettings - Review settings from fetchLastReviewSettings()
   * @returns {Promise<Object>} Config object suitable for startAnalysis / startLocalAnalysis
   */
  async _buildDefaultAnalysisConfig(repoSettings, reviewSettings, appConfig = {}, providersInfo = null, urlOverride = null) {
    const defaultTab = repoSettings?.default_tab || 'single';
    const councilId = repoSettings?.default_council_id || reviewSettings?.last_council_id || null;

    // A `?council=<id>` URL param (set by the CLI when opening the browser) takes
    // highest priority for council selection. When present we force the council
    // branch regardless of default_tab/settings, and derive configType from the
    // council's own type ('council' or 'advanced') rather than the repo default.
    // An explicit council outranks a provider/model override here, matching the
    // backend precedence in resolveReviewConfig where --council beats --provider.
    const urlSearch = (typeof window !== 'undefined' && window.location && window.location.search) || '';
    const urlCouncilId = new URLSearchParams(urlSearch).get('council');
    if (urlCouncilId) {
      let councilConfig = null;
      let councilName = null;
      let councilType = null;
      try {
        const resp = await fetch(`/api/councils/${urlCouncilId}`);
        if (resp.ok) {
          const data = await resp.json();
          councilConfig = data.council?.config || null;
          councilName = data.council?.name || null;
          councilType = data.council?.type || null;
        } else {
          console.warn(`Failed to fetch council "${urlCouncilId}" from URL param (status ${resp.status}); falling back to default analysis config`);
        }
      } catch (e) {
        console.warn('Failed to fetch council config for URL council param:', e);
      }

      // Only honor the URL council if we successfully fetched its config.
      // Otherwise fall through to the existing default-selection logic.
      if (councilConfig) {
        return {
          isCouncil: true,
          councilId: urlCouncilId,
          councilConfig,
          councilName,
          configType: councilType || 'advanced',
          customInstructions: null
        };
      }
    }

    // A CLI/env or delegation-URL provider/model override names a single
    // provider, which is incompatible with a multi-voice council. When an
    // override is active we bypass the repo's *default* council and force the
    // single-provider path so `--provider` is always honored. (An explicit
    // `?council=` above still wins, matching the backend precedence.)
    const overrideActive = window.hasProviderModelOverride(appConfig, urlOverride);

    if (!overrideActive && (defaultTab === 'council' || defaultTab === 'advanced') && councilId) {
      // Fetch the full council config so the progress modal can render correctly
      let councilConfig = null;
      let councilName = null;
      try {
        const resp = await fetch(`/api/councils/${councilId}`);
        if (resp.ok) {
          const data = await resp.json();
          councilConfig = data.council?.config || null;
          councilName = data.council?.name || null;
        }
      } catch (e) {
        console.warn('Failed to fetch council config for auto-analyze:', e);
      }

      return {
        isCouncil: true,
        councilId,
        councilConfig,
        councilName,
        configType: defaultTab,
        customInstructions: null
      };
    }

    // Resolve provider and model as a MATCHED pair. Resolving each half
    // independently (repo || app || hardcoded) can mix a provider from one
    // scope with a model from another, yielding an invalid pair (e.g.
    // antigravity/opus) that startAnalysis would forward to the backend as-is.
    // buildProviderModelScopes prepends any CLI/env or delegation-URL override
    // ahead of repo settings so `--provider` outranks a repo's saved default.
    const providers = providersInfo || await this._getProvidersInfo();
    const { provider, model } = window.resolveProviderModelPair(
      window.buildProviderModelScopes(repoSettings, appConfig, urlOverride),
      providers
    );

    return {
      provider,
      model,
      customInstructions: null
    };
  }

  async _fetchAutoAnalysisConfigFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const configId = params.get('analysisConfigId');
    if (!configId) return { requested: false, config: null, error: null };

    try {
      const response = await fetch(`/api/bulk-analysis-configs/${encodeURIComponent(configId)}`);
      if (!response.ok) {
        throw new Error('Stored analysis settings were not found');
      }
      const data = await response.json();
      if (!data.analysisConfig) {
        throw new Error('Stored analysis settings response was empty');
      }
      return { requested: true, config: data.analysisConfig, error: null };
    } catch (error) {
      console.warn('Failed to fetch bulk analysis config:', error);
      return { requested: true, config: null, error };
    }
  }

  /**
   * Auto-trigger analysis if ?analyze=true is present in the URL.
   * Skips refresh if data was just loaded fresh by loadPR (to avoid redundant fetches).
   * Otherwise, refreshes PR data first to ensure we analyze the latest code.
   * If refresh fails, proceeds with existing data rather than failing entirely.
   * Cleans up the query parameter afterwards regardless of success or failure.
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} prNumber - PR number
   */
  async _maybeAutoAnalyze(owner, repo, prNumber) {
    const searchParams = new URLSearchParams(window.location.search);
    const autoAnalyze = searchParams.get('analyze');
    if (autoAnalyze === 'true' && !this.isAnalyzing) {
      this._autoAnalyzeRequested = true;
      let shouldCleanUrl = true;
      // Provider/model override carried on the URL by single-port delegation
      // (the delegated-to server is a different process whose env never saw the
      // CLI flag). Prepended ahead of repo settings in _buildDefaultAnalysisConfig.
      const urlOverride = {
        provider: searchParams.get('provider'),
        model: searchParams.get('model')
      };
      try {
        // Skip refresh if we just loaded fresh data (loadPR sets _justLoaded = true).
        // Otherwise, refresh to ensure we have the latest PR data in case the worktree
        // already existed but the PR has new commits since last load.
        if (this._justLoaded) {
          this._justLoaded = false;
        } else {
          try {
            await this.refreshPR();
          } catch (e) {
            // If refresh fails, proceed with existing data - this is intentional.
            // We'd rather analyze stale data than fail entirely.
            console.warn('Pre-analysis refresh failed, proceeding with existing data', e);
          }
        }

        const storedConfig = await this._fetchAutoAnalysisConfigFromUrl();
        let config;
        if (storedConfig.requested) {
          if (!storedConfig.config) {
            // The stored bulk-analysis config expired (TTL/eviction/restart).
            // The PR diff has already rendered, so don't replace it with a
            // full-screen error whose Retry button would just re-trigger the
            // same failed lookup. Warn, strip the stale params (so a refresh
            // won't re-trigger), and leave the PR usable for manual analysis.
            const message = 'Could not load the selected bulk analysis settings. Start analysis manually to choose new settings.';
            if (window.toast) window.toast.showWarning(message);
            return;
          }
          config = storedConfig.config;
        } else {
          // Fetch repo settings so we honour the repository's default provider/council
          const [repoSettings, reviewSettings, appConfig] = await Promise.all([
            this.fetchRepoSettings().catch(() => null),
            this.fetchLastReviewSettings().catch(() => ({ custom_instructions: '', last_council_id: null })),
            this._getAppConfig()
          ]);
          config = await this._buildDefaultAnalysisConfig(repoSettings, reviewSettings, appConfig, null, urlOverride);
        }

        await this.startAnalysis(owner, repo, prNumber, null, config);
      } finally {
        this._autoAnalyzeRequested = false;
        if (shouldCleanUrl) {
          const cleanUrl = new URL(window.location);
          // Strip the whole auto-analyze intent bundle (analyze/analysisConfigId/
          // council/provider/model) so a manual refresh does not replay the intent.
          window.stripAnalyzeParams(cleanUrl);
          history.replaceState(null, '', cleanUrl);
        }
      }
    }
  }

  /**
   * Sync worktree name/path to the diff options dropdown.
   * Clears both fields when worktree_path is absent.
   * @param {Object} prData - PR data object from the API
   */
  _syncWorktreeDropdown(prData) {
    if (!this.diffOptionsDropdown) return;
    if (prData.worktree_path) {
      this.diffOptionsDropdown.worktreeName = prData.worktree_name || null;
      this.diffOptionsDropdown.worktreePath = prData.worktree_path;
    } else {
      this.diffOptionsDropdown.worktreeName = null;
      this.diffOptionsDropdown.worktreePath = null;
    }
  }

  /**
   * Load PR data from the API
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} number - PR number
   */
  async loadPR(owner, repo, number) {
    this.setLoading(true);

    try {
      // Fetch PR metadata
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}`);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load PR');
      }

      const responseData = await response.json();
      // API returns { success: true, data: { ... } } wrapper
      const prData = responseData.data || responseData;
      this.currentPR = prData;

      // Update diff options dropdown with worktree path and display name
      this._syncWorktreeDropdown(prData);

      // Render PR header with metadata
      this.renderPRHeader(prData);

      // Set descriptive tab title
      if (window.tabTitle) {
        window.tabTitle.setBase(`PR #${number}`);
      }

      // Fetch diff and file list from diff endpoint
      await this.loadAndDisplayFiles(owner, repo, number);

      // Initialize split button for comment actions
      this.initSplitButton();

      // Initialize AI Panel before loading comments so we can read the restored filter state
      // Only initialize if not already created (avoid duplicates on refresh)
      if (window.AIPanel && !window.aiPanel) {
        window.aiPanel = new window.AIPanel();
      }

      // Set PR context for AI Panel and Panel Group (for per-review localStorage keys)
      // This restores the filter state and chat visibility from localStorage
      if (window.aiPanel?.setPR) {
        window.aiPanel.setPR(owner, repo, number);
      }
      window.panelGroup?.setPR(`${owner}/${repo}#${number}`);

      // Load saved comments using the restored filter state from AI Panel
      // If AI Panel has showDismissedComments=true (restored from localStorage), use that
      const includeDismissed = window.aiPanel?.showDismissedComments || false;
      await this.loadUserComments(includeDismissed);

      // Initialize analysis history manager if review ID is available
      // The review ID is needed to fetch analysis runs from the database
      if (this.currentPR.id && window.AnalysisHistoryManager) {
        this.analysisHistoryManager = new window.AnalysisHistoryManager({
          reviewId: this.currentPR.id,
          mode: 'pr',
          shaAbbrevLength: this.currentPR.shaAbbrevLength || 7,
          onSelectionChange: (runId, _run) => {
            this.selectedRunId = runId;
            this.loadAISuggestions(null, runId);
          }
        });
        this.analysisHistoryManager.init();
        await this.analysisHistoryManager.loadAnalysisRuns();
      }

      // Load saved AI suggestions if they exist
      // Note: If analysisHistoryManager is initialized, it will trigger loadAISuggestions
      // via onSelectionChange when selecting the latest run. Only call directly if no manager.
      if (!this.analysisHistoryManager) {
        await this.loadAISuggestions();
      }

      // Check if AI analysis is currently running
      await this.checkRunningAnalysis();

      // Listen for review mutation events via WebSocket pub/sub
      this._initReviewEventListeners();

      // Fire-and-forget staleness check — shows badge or auto-refreshes
      this._stalenessPromise = this._checkStalenessOnLoad(owner, repo, number);

      // Fire-and-forget external review-comment sync + render.
      // Runs after the diff and user comments have been rendered so the
      // external-comment manager has DOM anchors to attach blue rows to.
      // Failures are swallowed inside _loadExternalComments and surface via
      // console.warn; they must never block the main PR-load path.
      void this._loadExternalComments().catch((err) => {
        console.warn('[external-comments] _loadExternalComments threw', err);
      });

    } catch (error) {
      console.error('Error loading PR:', error);
      this.showError(error.message);
    } finally {
      this.setLoading(false);
      // Mark that we just loaded fresh data - used by _maybeAutoAnalyze to skip redundant refresh
      this._justLoaded = true;
    }
  }

  /**
   * Sync external review comments against the source system and render the
   * results. Non-blocking from the user's perspective: a sync failure does
   * not prevent rendering of any cached rows from a previous run.
   *
   * No-op in local mode (external sources require a real GitHub PR).
   */
  /**
   * Re-render every overlay (AI suggestions, user comments, external comments)
   * after the underlying diff DOM has been rebuilt.
   *
   * Used by anything that destroys and re-mounts the diff (refreshPR, the
   * whitespace toggle, pre-analysis refresh). Centralizing keeps the three
   * renderers from drifting: each one has its own clear()/append cycle and
   * forgetting any of them produces hard-to-spot bugs like "comments
   * disappeared after refresh".
   *
   * @param {Object} [options]
   * @param {string} [options.analysisRunId] - Optional run id to pin AI suggestions to.
   * @param {boolean} [options.syncExternal=false] - When true, fire the
   *   external-comments sync POST before re-rendering. Used by `refreshPR`
   *   where the diff was just fetched fresh from GitHub and cached anchors
   *   may not match the new commit. GET-only callers (whitespace toggle,
   *   analysis rebuilds, post-analysis reload) pass the default and reuse
   *   the existing mirror.
   */
  async _rerenderAllOverlays({ analysisRunId, syncExternal = false } = {}) {
    const includeDismissed = window.aiPanel?.showDismissedComments || false;
    await this.loadUserComments(includeDismissed);
    await this.loadAISuggestions(null, analysisRunId);
    // Skip external-comment re-rendering entirely when the feature is off.
    // The manager is never populated with rows in that case, so there's
    // nothing to re-anchor.
    if (!this._externalCommentsEnabled()) return;
    try {
      if (typeof window !== 'undefined' && window.externalCommentManager) {
        if (this.currentPR && this.currentPR.id) {
          window.externalCommentManager.reviewId = this.currentPR.id;
        }
        if (syncExternal) {
          // refreshPR path: full sync+load through the canonical entry
          // point. `_loadExternalComments` already owns the toast + error
          // wiring for the sync result.
          await this._loadExternalComments();
        } else {
          // GET-only path: the local mirror is current; just re-anchor
          // rows on the freshly-rebuilt diff DOM.
          await window.externalCommentManager.loadAndRender();
        }
      }
    } catch (err) {
      console.warn('[external-comments] re-render after diff rebuild failed', err);
    }
  }

  /**
   * Click handler for the "refresh external comments" header button.
   *
   * Extracted from `setupEventListeners` so unit tests can exercise the
   * production handler directly without re-implementing it (CLAUDE.md
   * forbids duplicating production code in tests). The DOM button id is
   * the canonical attach point — pass it in for tests that build their
   * own button.
   *
   * @param {Object} [options]
   * @param {HTMLElement} [options.button] - The button element to toggle. Defaults to `#refresh-external-comments-btn-panel`.
   * @returns {Promise<void>}
   */
  async _handleExternalCommentsRefreshClick({ button } = {}) {
    // Defensive guard: even if a stale caller invokes this with the
    // feature disabled, swallow it. UI wiring already skips this path.
    if (!this._externalCommentsEnabled()) return;
    const btn = button
      || (typeof document !== 'undefined' ? document.getElementById('refresh-external-comments-btn-panel') : null);
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-refreshing');
    btn.setAttribute('aria-busy', 'true');
    btn.removeAttribute('data-state');
    try {
      await this._loadExternalComments();
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-refreshing');
      btn.removeAttribute('aria-busy');
    }
  }

  /**
   * Feature toggle for the external-comments (GitHub PR review-comment)
   * subsystem. Reads `window.PAIR_REVIEW_RUNTIME_CONFIG` which is set
   * synchronously by `/runtime-config.js` BEFORE this file loads, so the
   * check is safe at any call site. Defaults to enabled when the flag is
   * missing — preserves behavior for any environment that omits the
   * runtime-config script (e.g., older test fixtures).
   * @returns {boolean}
   */
  _externalCommentsEnabled() {
    if (typeof window === 'undefined') return true;
    return window.PAIR_REVIEW_RUNTIME_CONFIG?.external_comments_enabled !== false;
  }

  async _loadExternalComments() {
    if (typeof window !== 'undefined' && window.PAIR_REVIEW_LOCAL_MODE) return;
    if (!this._externalCommentsEnabled()) return;
    if (!this.currentPR || !this.currentPR.id) return;
    if (typeof window === 'undefined' || !window.externalCommentManager) return;

    window.externalCommentManager.reviewId = this.currentPR.id;

    // Route through the manager's `syncAndRender`. That method owns the
    // in-flight guard for the FULL sync+load sequence, so a GET-only
    // caller (analysis rebuild, whitespace toggle) that hits
    // `loadAndRender` during this window joins the same promise instead
    // of racing the POST with a stale GET. The manager surfaces sync
    // result and sync error separately so this method can fire the
    // status-aware toasts without intercepting render.
    let result;
    try {
      result = await window.externalCommentManager.syncAndRender({
        syncFn: () => this._syncExternalComments(),
      });
    } catch (err) {
      console.warn('[external-comments] syncAndRender failed', err);
      return;
    }

    if (result && result.syncError) {
      // Sync failed but render proceeded against the previously-cached
      // mirror. Toast + button-error cue so the reviewer knows the
      // counts may lag upstream.
      this._showExternalSyncErrorToast(result.syncError);
      this._markExternalRefreshErrorState();
      console.warn('[external-comments] sync failed; rendering cached data only', result.syncError);
    } else if (result && result.syncResult && typeof result.syncResult.lostAnchors === 'number' && result.syncResult.lostAnchors > 0) {
      // Surface lost-anchor counts so the reviewer knows why visible
      // external-comment counts may lag what GitHub shows — these are
      // comments whose anchors were destroyed upstream (force-push, file
      // delete, etc.) and have no place to render in the current diff.
      this._showExternalLostAnchorsToast(result.syncResult.lostAnchors);
    }
  }

  /**
   * Pick a toast message by HTTP status for a failed external-comment sync.
   * Falls back to a generic message when status is missing or unknown.
   * @private
   */
  _showExternalSyncErrorToast(err) {
    const status = err && typeof err.status === 'number' ? err.status : 0;
    let message;
    if (status === 401) {
      message = 'GitHub token missing or invalid — external comments not refreshed.';
    } else if (status === 403) {
      message = 'GitHub denied the request (403) — external comments not refreshed.';
    } else if (status === 429) {
      message = 'GitHub rate limited — external comments not refreshed.';
    } else {
      message = 'Could not refresh GitHub review comments.';
    }
    try {
      if (typeof window !== 'undefined') {
        if (window.toast && typeof window.toast.showError === 'function') {
          window.toast.showError(message);
          return;
        }
        if (typeof window.showToast === 'function') {
          window.showToast(message, 'error');
          return;
        }
      }
    } catch {
      // toast helpers must never break the page; swallow.
    }
  }

  /**
   * Show a warning toast describing how many external comments couldn't be
   * anchored to the current diff (lost-anchor count from the sync result).
   * Mirrors `_showExternalSyncErrorToast` so failures and partial successes
   * have symmetrical UI treatment.
   * @param {number} count - Number of lost-anchor comments
   * @private
   */
  _showExternalLostAnchorsToast(count) {
    if (typeof window === 'undefined') return;
    const noun = count === 1 ? 'comment' : 'comments';
    const message = `${count} ${noun} lost their anchor due to upstream changes`;
    try {
      if (window.toast && typeof window.toast.showWarning === 'function') {
        window.toast.showWarning(message);
        return;
      }
      if (window.toast && typeof window.toast.showInfo === 'function') {
        window.toast.showInfo(message);
        return;
      }
      if (typeof window.showToast === 'function') {
        window.showToast(message, 'warn');
        return;
      }
    } catch {
      // toast helpers must never break the page; swallow.
    }
  }

  /**
   * Briefly mark the refresh button so the user notices the failure even if
   * they dismissed the toast. Cleared after 4s; no state machine — best
   * effort cue. No-op when the button isn't present.
   * @private
   */
  _markExternalRefreshErrorState() {
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('refresh-external-comments-btn-panel');
    if (!btn) return;
    btn.setAttribute('data-state', 'error');
    setTimeout(() => {
      if (btn.getAttribute('data-state') === 'error') {
        btn.removeAttribute('data-state');
      }
    }, 4000);
  }

  /**
   * POST to the sync endpoint for the GitHub source. Coalesced server-side
   * for concurrent (review, source) calls; safe to invoke from page-load and
   * the manual refresh button in parallel.
   * @returns {Promise<{ count: number, lostAnchors: number, syncedAt: string }>}
   */
  async _syncExternalComments() {
    const source = 'github';
    const res = await fetch(
      `/api/reviews/${this.currentPR.id}/external-comments/sync?source=${source}`,
      { method: 'POST' }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `Sync failed with status ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /**
   * Reload AI suggestions, user comments, and external comments after an
   * analysis completes. Shared by the foreground `analysis_completed`
   * handler and the deferred `_dirtyAnalysis` branch in the
   * visibilitychange listener. Routing through `_rerenderAllOverlays`
   * keeps external-comment rows in sync with the other two overlays
   * whenever post-analysis refresh fires.
   */
  _reloadAfterAnalysis() {
    return this._rerenderAllOverlays();
  }

  /**
   * Resolve the cached `/api/config` payload, fetching it on first use.
   * @returns {Promise<Object>}
   */
  _getAppConfig() {
    if (!this._appConfigPromise) {
      this._appConfigPromise = fetch('/api/config')
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }
    return this._appConfigPromise;
  }

  /**
   * Fetch and cache the provider/model metadata from /api/providers. Used to
   * resolve a coherent provider/model pair for the non-modal auto-analyze path
   * (the modal loads its own copy). Resolves to the `providers` array, or [] on
   * failure so callers can fall back to provider-agnostic defaults.
   */
  _getProvidersInfo() {
    if (!this._providersInfoPromise) {
      this._providersInfoPromise = fetch('/api/providers')
        .then((r) => (r.ok ? r.json() : {}))
        .then((data) => (Array.isArray(data.providers) ? data.providers : []))
        .catch(() => []);
    }
    return this._providersInfoPromise;
  }

  /**
   * Wire one file's hunk anchor rows to their server-supplied content hashes
   * as that file's body renders (called from _renderFileBodyNow), then mount
   * any summary that already arrived for those hunks.
   *
   * Pre-lazy-render this happened once globally in _kickOffHunkSummaries;
   * with lazy bodies a file's anchor rows don't exist until it renders, so
   * anchoring is now incremental. The server computes hashes from the
   * canonical (non-whitespace-filtered) diff so they stay aligned with
   * persisted summary keys regardless of `?w=1`; records lacking a
   * `contentHash` are logged-and-skipped.
   *
   * The bridge for "summary arrived before its anchor existed" is the existing
   * `_pendingSummariesByHash` map: _renderOneSummary / _applyHunkSummaries
   * queue there when no anchor is found, and we drain matching entries here.
   * @param {Array<{file,header,anchorRow,contentHash}>} records
   */
  _registerHunkAnchorsForFile(records) {
    if (!Array.isArray(records) || records.length === 0) return;
    const filesWithMounts = new Set();
    for (const rec of records) {
      if (!rec.anchorRow || !rec.anchorRow.isConnected) continue;
      const hex = rec.contentHash;
      if (!hex) {
        console.warn(
          `[HunkSummary] no server contentHash for ${rec.file} ` +
          `hunk ${rec.header}; skipping (summaries will not anchor here).`
        );
        continue;
      }
      rec.anchorRow.dataset.hunkStart = hex;
      // Scope the anchor by file so a hash collision across files can't let
      // the later file's anchor clobber the earlier file's (which would mount
      // a summary against the wrong hunk). Symmetric with the file-scoped
      // pending-summary queue.
      let anchors = this._summaryAnchorsByHash.get(rec.file);
      if (!anchors) {
        anchors = new Map();
        this._summaryAnchorsByHash.set(rec.file, anchors);
      }
      anchors.set(hex, rec.anchorRow);
      let bucket = this._summaryHashesByFile.get(rec.file);
      if (!bucket) {
        bucket = new Set();
        this._summaryHashesByFile.set(rec.file, bucket);
      }
      bucket.add(hex);

      // Mount a summary that arrived before this anchor existed. Look it up by
      // THIS file + hash so a content-hash that also appears in another file
      // (renamed-with-tiny-edits, copy-pasted boilerplate, identical stubs)
      // can't let this file's anchor consume the other file's queued summary.
      const pending = this._takePendingSummary(rec.file, hex);
      if (pending) {
        const row = this._renderOneSummary(pending, rec.file);
        if (row) {
          this._summariesGenerated = true;
          this._summariesAvailable = true;
          filesWithMounts.add(rec.file);
        }
        // If it couldn't mount (anchor not connected after all),
        // _renderOneSummary re-queued it scoped to rec.file for a later pass.
      }
    }
    if (this._summariesGenerated) this._syncSummaryToolbarButton();
    for (const filePath of filesWithMounts) this._refreshFileSummaryToggle(filePath);
  }

  /**
   * Compute per-hunk summary anchor positions for a Pierre-rendered file.
   *
   * Legacy rendering (`renderPatch`) captures the first `<tr>` of each hunk as
   * the anchor. Pierre renders into a shadow DOM we don't own, so instead we
   * derive each hunk's first rendered line from the patch text and let
   * PierreBridge slot the summary card below it. Positions come purely from the
   * patch — the canonical content hashes still come from the backend.
   *
   * Anchor rules (mirrors renderPatch's first-rendered-row):
   *   - first line is an addition (`+`) or context (` `) → side 'RIGHT', at the
   *     hunk's NEW start line (the line exists in the new file);
   *   - first line is a deletion (`-`), e.g. a pure-deletion hunk → side
   *     'LEFT', at the hunk's OLD start line.
   *
   * Fails closed on hash/hunk count drift (the same `?w=1` divergence
   * renderPatch guards against): returns an empty map so summaries simply don't
   * anchor rather than anchor to the wrong hunk.
   *
   * @param {string} patch - Unified diff patch text
   * @param {string[]|null} hunkHashes - Canonical per-hunk hashes, parallel to
   *   the blocks `parseDiffIntoBlocks` returns
   * @returns {Map<string, {lineNumber: number, side: string}>}
   */
  _computePierreHunkAnchors(patch, hunkHashes) {
    const anchors = new Map();
    if (!patch || !Array.isArray(hunkHashes) || hunkHashes.length === 0) return anchors;
    if (!window.HunkParser?.parseDiffIntoBlocks) return anchors;

    const blocks = window.HunkParser.parseDiffIntoBlocks(patch);
    // Fail closed on length drift — a misaligned hash would anchor the summary
    // to the wrong hunk. Symmetric with renderPatch's guard.
    if (hunkHashes.length !== blocks.length) {
      if (!this._warnedHunkHashLengthMismatch) {
        this._warnedHunkHashLengthMismatch = true;
        console.warn(
          `[HunkSummary] hunk_hashes length mismatch (pierre): ${hunkHashes.length} ` +
          `canonical hashes, ${blocks.length} rendered blocks. Dropping hashes for this file.`
        );
      }
      return anchors;
    }

    blocks.forEach((block, blockIndex) => {
      const hash = hunkHashes[blockIndex];
      if (!hash) return; // no canonical hash for this hunk → can't anchor
      // First rendered line of the hunk (renderPatch skips undefined/null but
      // treats '' as a blank context line).
      const firstLine = block.lines.find(line => line || line === '');
      if (firstLine == null) return; // empty hunk — nothing to anchor to
      let side, lineNumber;
      if (firstLine.startsWith('-')) {
        side = 'LEFT';
        lineNumber = block.oldStart;
      } else {
        // Addition or context — present on the NEW side.
        side = 'RIGHT';
        lineNumber = block.newStart;
      }
      anchors.set(hash, { lineNumber, side });
    });

    return anchors;
  }

  /**
   * Wire a Pierre-rendered file's hunk anchors to their canonical content
   * hashes, then mount any summary that already arrived for those hunks. The
   * Pierre analogue of _registerHunkAnchorsForFile: it stores position-based
   * anchor records (`{pierre, fileName, lineNumber, side}`) instead of `<tr>`
   * rows, and mounts via PierreBridge annotations.
   *
   * Called once per file from renderFileDiff's Pierre branch (the file is in
   * `pierreBridge.files` by then). Idempotent — re-running re-sets the same
   * map entries and re-drains an already-empty pending queue.
   * @param {Object} file - A changed_files entry with `.file`, `.patch`, `.hunk_hashes`
   */
  _registerPierreHunkAnchorsForFile(file) {
    if (!file || !file.patch) return;
    const fileName = file.file;
    // Only meaningful for files actually Pierre-rendered — addAnnotation needs
    // a live fileState, and legacy files use _registerHunkAnchorsForFile.
    if (!this.pierreBridge?.files?.has(fileName)) return;

    const positions = this._computePierreHunkAnchors(file.patch, file.hunk_hashes);
    if (positions.size === 0) return;

    let anchors = this._summaryAnchorsByHash.get(fileName);
    if (!anchors) {
      anchors = new Map();
      this._summaryAnchorsByHash.set(fileName, anchors);
    }
    let bucket = this._summaryHashesByFile.get(fileName);
    if (!bucket) {
      bucket = new Set();
      this._summaryHashesByFile.set(fileName, bucket);
    }

    const filesWithMounts = new Set();
    for (const [hash, pos] of positions) {
      // Scope by file so a hash shared across files can't cross-wire anchors,
      // mirroring the legacy path.
      anchors.set(hash, { pierre: true, fileName, lineNumber: pos.lineNumber, side: pos.side });
      bucket.add(hash);

      const pending = this._takePendingSummary(fileName, hash);
      if (pending) {
        const mounted = this._renderOneSummary(pending, fileName);
        if (mounted) {
          this._summariesGenerated = true;
          this._summariesAvailable = true;
          filesWithMounts.add(fileName);
        }
        // If it couldn't mount, _renderOneSummary re-queued it scoped to
        // fileName for a later pass.
      }
    }

    if (this._summariesGenerated) this._syncSummaryToolbarButton();
    for (const filePath of filesWithMounts) this._refreshFileSummaryToggle(filePath);
  }

  /**
   * Load the review's hunk summaries from the server and apply them to the
   * anchors that exist so far (gated by `summaries.enabled` in `/api/config`).
   *
   * With lazy bodies, anchor wiring is incremental (_registerHunkAnchorsForFile
   * runs as each body renders), so this method no longer walks render records.
   * Summaries whose file hasn't rendered yet are queued in
   * `_pendingSummariesByHash` (via _applyHunkSummaries / _renderOneSummary) and
   * drained when that body renders.
   *
   * Order:
   *   1. Config gate first — bail before paying any cost when the feature is off.
   *   2. Restore localStorage visibility state.
   *   3. Fetch existing summaries and apply/queue them.
   *
   * Race-safety: `_renderGen` is captured at entry and rechecked after every
   * `await`. If `renderDiff()` ran again mid-flight, we stop touching the (now
   * stale) maps and DOM.
   * @returns {Promise<void>}
   */
  async _fetchHunkSummaryMap() {
    const gen = this._renderGen;

    // 1. Config gate — bail before doing any work when the feature is off.
    const cfg = await this._getAppConfig();
    if (gen !== this._renderGen) return;
    if (!(cfg.summaries && cfg.summaries.enabled)) return;

    // 2. Restore localStorage visibility state.
    if (this.currentPR?.id) {
      const hidden = window.localStorage.getItem(`pair-review:summaries-hidden:${this.currentPR.id}`) === '1';
      this._summariesHidden = hidden;
      document.body.classList.toggle('summaries-hidden', hidden);
      this._syncSummaryToolbarButton();
      this._restoreSummariesHiddenFiles();
      // Apply per-file hidden state to wrappers already in the DOM, syncing
      // both the wrapper class AND the toggle button so its visible state and
      // aria-pressed match the persisted hidden flag.
      for (const filePath of this.summariesHiddenFiles) {
        const wrapper = document.querySelector(
          `.d2h-file-wrapper[data-file-name="${CSS.escape(filePath)}"]`
        );
        if (!wrapper) continue;
        wrapper.classList.add('summaries-hidden-file');
        const btn = wrapper.querySelector('.file-header-summary-toggle');
        if (btn) this._syncFileSummaryToggleButton(btn, filePath);
      }
    }

    // 3. Load existing summaries from the server.
    if (!this.currentPR?.id) return;

    try {
      const resp = await fetch(`/api/reviews/${this.currentPR.id}/hunk-summaries`);
      if (gen !== this._renderGen) return;
      if (!resp.ok) return;
      const data = await resp.json();
      if (gen !== this._renderGen) return;
      const summaries = Array.isArray(data.summaries) ? data.summaries : [];
      // Group by file path so we can refresh each file's toggle button once.
      const byFile = new Map();
      for (const summary of summaries) {
        const fp = summary.file_path;
        if (!fp) continue;
        if (!byFile.has(fp)) byFile.set(fp, []);
        byFile.get(fp).push(summary);
      }
      // If summaries lack file_path, fall back to ungrouped rendering. Set
      // `_summariesGenerated` only after a summary actually mounts against the
      // current render anchors — never from the raw fetch count — so stale-hash
      // rows the anchor filter rejects can't flip the toolbar into Hide/Show
      // mode with nothing in the DOM. The grouped path defers this to
      // `_applyHunkSummaries`, which sets the flag on a successful mount.
      if (byFile.size === 0 && summaries.length > 0) {
        let mountedAny = false;
        let availableAny = false;
        for (const summary of summaries) {
          if (summary.summary_text) availableAny = true;
          if (this._renderOneSummary(summary)) mountedAny = true;
        }
        if (availableAny) this._summariesAvailable = true;
        if (mountedAny) this._summariesGenerated = true;
        if (mountedAny || availableAny) this._syncSummaryToolbarButton();
      } else {
        for (const [filePath, fileSummaries] of byFile.entries()) {
          this._applyHunkSummaries(filePath, fileSummaries);
        }
      }
      // Mirror the queue's view of whether summaries are still being generated.
      // The `review:background_job_finished` WS event clears this when the job
      // completes mid-session.
      this._summariesGenerating = data.generating === true;
      this._syncSummaryToolbarButton();
    } catch (err) {
      console.warn('[HunkSummary] failed to load summaries:', err);
    }
  }

  /**
   * Apply a batch of summaries delivered via the WS
   * `review:hunk_summaries_ready` event for a single file. Validates each
   * summary's hash against the per-file hash bucket so a hash collision
   * across files can't pull a summary into the wrong file's view, and
   * re-enables the per-file toggle button once a file has at least one
   * summary mounted.
   * @param {string} filePath - File path the summaries belong to
   * @param {Array<Object>} summaries - Summary rows for that file
   */
  _applyHunkSummaries(filePath, summaries) {
    if (!Array.isArray(summaries)) return;
    const allowedHashes = this._summaryHashesByFile.get(filePath) || new Set();
    let mountedAny = false;
    let availableAny = false;
    for (const summary of summaries) {
      if (!summary?.content_hash) continue;
      if (allowedHashes.size > 0 && !allowedHashes.has(summary.content_hash)) {
        if (!this._warnedCrossFileHashMismatch) {
          this._warnedCrossFileHashMismatch = true;
          console.warn(
            `[HunkSummary] dropping summary for ${filePath}: hash ${summary.content_hash} ` +
            'not present in file hash bucket. Likely cross-file collision or stale render.'
          );
        }
        continue;
      }
      // A non-trivial summary that belongs to this render (it passed the hash
      // filter) means the feature has data even if its body hasn't rendered
      // yet — _renderOneSummary will queue it rather than mount it in that
      // case. Track availability separately from mounted rows.
      if (summary.summary_text) availableAny = true;
      const row = this._renderOneSummary(summary, filePath);
      if (row) mountedAny = true;
    }
    if (availableAny) this._summariesAvailable = true;
    if (mountedAny) {
      // At least one summary mounted — the feature now has visible data, so
      // the toolbar button can show its `.active` (blue) state.
      this._summariesGenerated = true;
    }
    // Refresh the toolbar when either flag changed: `.active` tracks
    // `_summariesGenerated` (rows in the DOM) while the Generate-vs-Show/Hide
    // decision tracks `_summariesAvailable` (mounted OR queued). Refreshing on
    // availableAny prevents a not-yet-rendered file from leaving the toolbar
    // in "Generate" mode, where a click would start a duplicate job.
    if (mountedAny || availableAny) this._syncSummaryToolbarButton();
    if (mountedAny && filePath) this._refreshFileSummaryToggle(filePath);
  }

  /**
   * Refresh the per-file summary toggle button for `filePath` so it reflects
   * the current state: enabled iff there is at least one mounted summary in
   * that file's hash bucket.
   * @param {string} filePath
   */
  _refreshFileSummaryToggle(filePath) {
    if (!filePath) return;
    const wrapper = document.querySelector(
      `.d2h-file-wrapper[data-file-name="${CSS.escape(filePath)}"]`
    );
    if (!wrapper) return;
    const btn = wrapper.querySelector('.file-header-summary-toggle');
    if (!btn) return;
    this._syncFileSummaryToggleButton(btn, filePath);
  }

  /**
   * Apply the canonical per-file summary toggle button state derived from
   * `_summaryHashesByFile` and `summariesHiddenFiles`. Sets `disabled`,
   * `summaries-off`, `aria-pressed`, and `title` on the button.
   *
   * Used by three call sites that must agree on the button's visible state:
   *   - createFileHeader (initial render)
   *   - _fetchHunkSummaryMap (rehydrate after localStorage restore)
   *   - _refreshFileSummaryToggle (when summaries arrive late)
   *   - toggleFileSummaries (user click)
   *
   * @param {HTMLButtonElement} btn
   * @param {string} filePath
   */
  _syncFileSummaryToggleButton(btn, filePath) {
    if (!btn || !filePath) return;
    const hasSummaries = (this._summaryHashesByFile.get(filePath)?.size || 0) > 0;
    const isHidden = this.summariesHiddenFiles.has(filePath);
    btn.classList.toggle('summaries-off', isHidden);
    btn.setAttribute('aria-pressed', isHidden ? 'false' : 'true');
    if (!hasSummaries) {
      btn.disabled = true;
      btn.title = 'No summaries available';
    } else {
      btn.disabled = false;
      btn.title = isHidden ? 'Show file summaries' : 'Hide file summaries';
    }
  }

  /**
   * Queue a summary that arrived before its hunk anchor existed, scoped by
   * file path so a content-hash collision across files can't let one file's
   * anchor consume another file's queued summary. Summaries arriving without
   * a file path (legacy ungrouped fetch) land in the '' bucket.
   * @param {string|undefined} filePath
   * @param {Object} summary - must have `content_hash`
   */
  _queuePendingSummary(filePath, summary) {
    const key = filePath || '';
    let bucket = this._pendingSummariesByHash.get(key);
    if (!bucket) {
      bucket = new Map();
      this._pendingSummariesByHash.set(key, bucket);
    }
    bucket.set(summary.content_hash, summary);
  }

  /**
   * Pull (and remove) a queued summary for (filePath, hash). Checks the
   * file-scoped bucket first, then the '' bucket that holds summaries queued
   * without a file path (legacy ungrouped fetch). Returns null when nothing
   * is queued for that pair.
   * @param {string|undefined} filePath
   * @param {string} hash
   * @returns {Object|null}
   */
  _takePendingSummary(filePath, hash) {
    for (const key of [filePath || '', '']) {
      const bucket = this._pendingSummariesByHash.get(key);
      if (bucket && bucket.has(hash)) {
        const summary = bucket.get(hash);
        bucket.delete(hash);
        if (bucket.size === 0) this._pendingSummariesByHash.delete(key);
        return summary;
      }
    }
    return null;
  }

  /**
   * Resolve the anchor row for (filePath, hash) against the file-scoped
   * `_summaryAnchorsByHash` map.
   *
   * When `filePath` is known (the grouped path), the lookup is strictly
   * scoped to that file so a content-hash shared across files can't pull a
   * summary onto the wrong file's anchor. When it's absent — the legacy
   * ungrouped-fetch fallback where summaries arrive without a `file_path` —
   * there's no file to scope by, so we accept the first file whose bucket
   * carries the hash. This mirrors `_takePendingSummary`'s `''` fallback
   * bucket: file-scoped first, best-effort otherwise.
   * @param {string|undefined} filePath
   * @param {string} hash
   * @returns {HTMLTableRowElement|null}
   */
  _findSummaryAnchor(filePath, hash) {
    if (filePath) {
      return this._summaryAnchorsByHash.get(filePath)?.get(hash) || null;
    }
    for (const anchors of this._summaryAnchorsByHash.values()) {
      const anchor = anchors.get(hash);
      if (anchor) return anchor;
    }
    return null;
  }

  /**
   * Render a single summary row, or queue it if the matching hunk hasn't
   * been hashed yet (race between WS broadcast and post-render hashing).
   * Trivial / model-skipped / model-malformed rows are ignored.
   * @param {Object} summary - { content_hash, summary_text, trivial_reason }
   * @param {string} [filePath] - File the summary belongs to. Used to scope
   *   both the anchor lookup and the pending-queue key so a cross-file hash
   *   collision can't misroute it to the wrong file's hunk.
   * @returns {HTMLTableRowElement|null} The mounted row, or null if queued/skipped.
   */
  _renderOneSummary(summary, filePath) {
    if (!summary || !summary.content_hash) return null;
    if (!summary.summary_text) return null; // trivial / opt-out — nothing to show
    const hash = summary.content_hash;
    const anchor = this._findSummaryAnchor(filePath, hash);
    if (!anchor) {
      // Anchor not registered yet (lazy body / deferred render) → defer; the
      // next render pass that re-establishes the hash will drain this map.
      this._queuePendingSummary(filePath, summary);
      return null;
    }
    if (!this.hunkSummaryRenderer) return null;

    // Pierre-rendered files anchor by position and mount via a bridge
    // annotation rather than a DOM `<tr>`. `anchor.pierre` distinguishes the
    // two flavors of record populated by _registerPierreHunkAnchorsForFile
    // (position object) vs _registerHunkAnchorsForFile (a `<tr>`).
    if (anchor.pierre) {
      // The file may have been destroyed/re-deferred since its anchor was
      // registered; addAnnotation is a no-op without a live fileState, so
      // requeue rather than silently drop.
      if (!this.pierreBridge?.files?.has(anchor.fileName)) {
        this._queuePendingSummary(filePath, summary);
        return null;
      }
      return this.hunkSummaryRenderer.renderPierre(anchor.fileName, anchor, summary);
    }

    if (!anchor.isConnected) {
      // Legacy DOM anchor detached (stale render) → defer.
      this._queuePendingSummary(filePath, summary);
      return null;
    }
    return this.hunkSummaryRenderer.renderInline(anchor, summary);
  }

  /**
   * Storage key for per-file summary visibility. Mirrors the
   * `pair-review:summaries-hidden:${reviewId}` review-level key.
   * @param {number|string} reviewId
   * @returns {string}
   */
  static summariesHiddenFilesStorageKey(reviewId) {
    return `pair-review:summaries-hidden-files:${reviewId}`;
  }

  /**
   * Toggle the visibility of summaries for a single file. Updates the
   * `summariesHiddenFiles` set, the wrapper's CSS class, the per-file toggle
   * button's `summaries-off` class, and persists the set per-review.
   * @param {string} filePath
   * @param {HTMLElement} fileWrapper - The `.d2h-file-wrapper` element
   */
  toggleFileSummaries(filePath, fileWrapper) {
    if (!filePath || !fileWrapper) return;
    const isHidden = this.summariesHiddenFiles.has(filePath);
    if (isHidden) {
      this.summariesHiddenFiles.delete(filePath);
    } else {
      this.summariesHiddenFiles.add(filePath);
    }
    fileWrapper.classList.toggle('summaries-hidden-file', !isHidden);
    const btn = fileWrapper.querySelector('.file-header-summary-toggle');
    if (btn) this._syncFileSummaryToggleButton(btn, filePath);
    if (this.currentPR?.id != null) {
      try {
        window.localStorage.setItem(
          PRManager.summariesHiddenFilesStorageKey(this.currentPR.id),
          JSON.stringify([...this.summariesHiddenFiles])
        );
      } catch {
        // localStorage unavailable; in-session state still applies.
      }
    }
  }

  /**
   * Hydrate `summariesHiddenFiles` from localStorage for the current review.
   * Safe to call multiple times — the state always reflects what's in storage.
   */
  _restoreSummariesHiddenFiles() {
    if (!this.currentPR?.id) return;
    try {
      const raw = window.localStorage.getItem(
        PRManager.summariesHiddenFilesStorageKey(this.currentPR.id)
      );
      if (!raw) {
        this.summariesHiddenFiles = new Set();
        return;
      }
      const arr = JSON.parse(raw);
      this.summariesHiddenFiles = new Set(Array.isArray(arr) ? arr : []);
    } catch {
      this.summariesHiddenFiles = new Set();
    }
  }

  /**
   * Toggle review-level summary visibility. Persists per-review.
   */
  toggleSummariesVisibility() {
    this._summariesHidden = !this._summariesHidden;
    document.body.classList.toggle('summaries-hidden', this._summariesHidden);
    if (this.currentPR?.id != null) {
      try {
        window.localStorage.setItem(
          `pair-review:summaries-hidden:${this.currentPR.id}`,
          this._summariesHidden ? '1' : '0'
        );
      } catch {
        // localStorage unavailable; in-session state still applies.
      }
    }
    this._syncSummaryToolbarButton();
  }

  /**
   * Reflect the current state (visible / hidden / generating) on the
   * toolbar toggle button. The button gets:
   *   - `.active` when summaries are visible
   *   - `.generating` when a background summary job is in flight
   *   - `title` + `aria-label` + `data-label` (CSS hover fallback) all kept
   *     in sync so the user always knows what the button does.
   */
  _syncSummaryToolbarButton() {
    const btn = document.getElementById('summary-toggle-btn');
    if (!btn) return;
    // `.active` (blue) only once summaries actually exist AND are visible.
    // Before any generation the button stays colorless so the pre-generated
    // state is visually distinct from "generated but hidden".
    btn.classList.toggle('active', this._summariesGenerated && !this._summariesHidden);
    btn.classList.toggle('generating', this._summariesGenerating === true);

    let label;
    if (this._summariesGenerating) {
      // Hint at the cancel affordance — clicking the pulsing button now
      // opens a confirm dialog ("Cancel Summaries" / "OK") instead of
      // toggling visibility. See _handleSummaryToggleClick.
      label = 'Generating summaries… (click to cancel)';
    } else if (!this._summariesAvailable) {
      // Pre-generated state: nothing generated yet (mounted or queued).
      // Colorless button; a click kicks off generation. Gated on
      // `_summariesAvailable` (not `_summariesGenerated`) so a review whose
      // summaries exist but haven't mounted shows Show/Hide, matching the
      // click behavior in _handleSummaryToggleClick.
      label = 'Generate hunk summaries';
    } else {
      label = this._summariesHidden ? 'Show hunk summaries' : 'Hide hunk summaries';
    }
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.dataset.label = label;
    btn.setAttribute(
      'aria-pressed',
      (this._summariesGenerated && !this._summariesHidden) ? 'true' : 'false'
    );
  }

  // ===== Tour (Phase 8) ===================================================

  /**
   * Whether a tour is currently mounted in the UI.
   * @returns {boolean}
   */
  _tourIsActive() {
    return this._tourActiveIndex >= 0 && !!this._tourRenderer;
  }

  /**
   * Reflect tour state on the toolbar toggle button. Mirrors the structure
   * of `_syncSummaryToolbarButton` so future tweaks stay in lockstep.
   */
  _syncTourToolbarButton() {
    const btn = document.getElementById('tour-toggle-btn');
    if (!btn) return;
    const active = this._tourIsActive();
    const hasPending = active && Array.isArray(this._tourStopsPendingRestart);
    btn.classList.toggle('active', active);
    btn.classList.toggle('generating', this._tourGenerating === true);
    btn.classList.toggle('tour-updated-pending', hasPending);

    let label;
    if (this._tourGenerating) {
      // Hint at the cancel affordance — see _handleTourToggleClick.
      label = active
        ? 'Generating tour… (click to cancel)'
        : 'Generating guided tour… (click to cancel)';
    } else if (hasPending) {
      label = 'Tour updated — restart to apply new stops';
    } else if (active) {
      label = 'Exit guided tour';
    } else if (this._tourStops && this._tourStops.length > 0) {
      label = 'Start guided tour';
    } else if (this._toursAutoGenerate === false) {
      // No stops yet and auto-generation is off: a click kicks off manual
      // generation (see startOrToggleTour), so the verb is "Generate".
      label = 'Generate guided tour';
    } else {
      label = 'Guided tour (none available yet)';
    }
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.dataset.label = label;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  // ===== Cancel flow (shared) =============================================

  /**
   * Toolbar click handler for the summaries toggle. If a summary job is
   * in flight (`.generating` pulse), intercept and open the cancel-confirm
   * dialog instead of toggling visibility. Toggle visibility otherwise.
   *
   * Kept thin so `addEventListener` callers don't need to know about the
   * cancel flow — that lives in `_promptCancelJob`.
   * @returns {void}
   */
  async _handleSummaryToggleClick() {
    if (this._summariesGenerating) {
      await this._promptCancelJob({
        kind: 'summaries',
        onCleared: () => {
          this._summariesGenerating = false;
          this._syncSummaryToolbarButton();
        },
      });
      return;
    }
    if (!this._summariesAvailable) {
      // Nothing generated yet (mounted OR queued): a click triggers generation
      // rather than toggling visibility. `_startGenerationJob` sets the pulsing
      // `.generating` state optimistically (there is no
      // `review:background_job_started` event). We gate on `_summariesAvailable`
      // rather than `_summariesGenerated` so summaries that exist server-side
      // but haven't mounted (their lazy file body isn't rendered yet) toggle
      // visibility instead of kicking off a duplicate generation job.
      await this._startGenerationJob('summary');
      return;
    }
    this.toggleSummariesVisibility();
  }

  /**
   * Toolbar click handler for the tour toggle. If a tour job is in flight
   * (`.generating` pulse), intercept and open the cancel-confirm dialog
   * instead of opening/exiting the tour. Defer to `startOrToggleTour`
   * otherwise.
   * @returns {Promise<void>}
   */
  async _handleTourToggleClick() {
    if (this._tourGenerating) {
      await this._promptCancelJob({
        kind: 'tour',
        onCleared: () => {
          this._tourGenerating = false;
          this._syncTourToolbarButton();
        },
      });
      return;
    }
    await this.startOrToggleTour();
  }

  /**
   * Shared cancel-flow entrypoint: opens the right confirm dialog for the
   * given job kind, POSTs the cancel on confirm, and runs `onCleared` so
   * the caller can reset the pulse state. The corresponding broadcast
   * (`review:background_job_finished` with `cancelled: true`) will arrive
   * shortly after; that handler also clears the flag, so a double-clear
   * is harmless.
   *
   * @param {Object} opts
   * @param {'tour'|'summaries'} opts.kind
   * @param {Function} opts.onCleared - Called after the user confirms.
   * @returns {Promise<void>}
   */
  async _promptCancelJob({ kind, onCleared }) {
    // Re-entry guard: the pulsing toolbar button stays clickable while the
    // confirm dialog is up. ConfirmDialog is a singleton — a second call to
    // .show() overwrites the first invocation's callbacks and orphans its
    // Promise. Drop the second click instead.
    if (this._cancelPromptOpen) return;
    const helper = typeof window !== 'undefined' ? window.CancelBackgroundJob : null;
    if (!helper) return;
    const reviewId = this.currentPR && this.currentPR.id;
    if (!reviewId) return;
    const show = kind === 'tour'
      ? helper.showCancelTourDialog
      : helper.showCancelSummariesDialog;
    this._cancelPromptOpen = true;
    try {
      await show({ reviewId, onCancelled: onCleared });
    } finally {
      this._cancelPromptOpen = false;
    }
  }

  /**
   * Manually trigger a summary or tour generation job for the current review.
   * Used when `auto_generate` is off so generation does not kick off on load;
   * the user clicks the toolbar button to start it.
   *
   * Mode-aware: PR reviews POST to `/api/pr/...`, local reviews to
   * `/api/local/...`. The server enqueues the job with `trigger: 'manual'`
   * (bypassing the `auto_generate` gate) and responds with `{ started }` /
   * `{ alreadyRunning }`. There is no `review:background_job_started`
   * broadcast, so this method optimistically sets the matching `*Generating`
   * flag and pulses the button itself; `review:background_job_finished`
   * clears the flag when the job ends.
   *
   * @param {'summary'|'tour'} jobKey
   * @returns {Promise<void>}
   */
  async _startGenerationJob(jobKey) {
    const pr = this.currentPR;
    if (!pr || pr.id == null) return;
    const isLocal = pr.reviewType === 'local'
      || (typeof window !== 'undefined' && window.PAIR_REVIEW_LOCAL_MODE === true);
    const url = isLocal
      ? `/api/local/${encodeURIComponent(pr.id)}/jobs/${encodeURIComponent(jobKey)}/start`
      : `/api/pr/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/${encodeURIComponent(pr.number)}/jobs/${encodeURIComponent(jobKey)}/start`;
    // Phrasing varies by job kind. `featureLabel` goes into the HTTP/decline
    // error messages; `noDiffMessage` is the dedicated "nothing to do" line.
    // NOTE: the toast singleton is lowercase `window.toast` (see
    // cancel-background-job.js); `window.Toast` does not exist.
    const featureLabel = jobKey === 'tour' ? 'tour' : 'summary';
    const noDiffMessage = jobKey === 'tour' ? 'No tour to generate.' : 'No summaries to generate.';
    try {
      const resp = await fetch(url, { method: 'POST' });
      if (resp.status === 409) {
        // Feature disabled in config — shouldn't happen (the button is hidden
        // when disabled) but surface it rather than failing silently.
        window.toast?.showError?.('This feature is disabled in config.');
        return;
      }
      if (!resp.ok) {
        console.warn(`[StartJob] ${jobKey} start POST failed: ${resp.status}`);
        window.toast?.showError?.(`Failed to start ${featureLabel} generation (HTTP ${resp.status}).`);
        return;
      }
      // Optimistic UI: there is no `review:background_job_started` broadcast,
      // so set the generating flag now — when the server enqueued a job
      // (`started`) or one was already running (`alreadyRunning`) — to start
      // the pulse immediately. Results arrive via `review:hunk_summaries_ready`
      // / `review:tour_ready`; `review:background_job_finished` clears the flag
      // when the job ends.
      const payload = await resp.json().catch(() => ({}));
      if (payload.started || payload.alreadyRunning) {
        if (jobKey === 'summary') {
          this._summariesGenerating = true;
          this._syncSummaryToolbarButton();
        } else if (jobKey === 'tour') {
          this._tourGenerating = true;
          this._syncTourToolbarButton();
        }
        return;
      }
      // Server accepted the request but declined to enqueue. The known
      // reason today is `'no-diff'` — review has no changes to act on. Tell
      // the user so the button doesn't appear inert. Unknown decline
      // reasons fall through to a generic message rather than silence.
      if (payload.reason === 'no-diff') {
        window.toast?.showInfo?.(noDiffMessage);
      } else {
        window.toast?.showError?.(`Could not start ${featureLabel} generation.`);
      }
    } catch (err) {
      console.warn(`[StartJob] ${jobKey} start POST error:`, err.message);
      window.toast?.showError?.(`Failed to start ${featureLabel} generation: ${err.message}`);
    }
  }

  /**
   * Fetch /api/reviews/:reviewId/tour and stash the result in `_tourStops`
   * / `_tourGenerating`. Does NOT open the tour.
   *
   * If `deferIfActive` is true and a tour is currently mounted, the fetched
   * stops are stashed on `_tourStopsPendingRestart` instead of replacing
   * the active tour's stops. The pending stops apply on the next exit or
   * restart. This is the v1 simple approach — replacing the running tour
   * mid-flight is doable but adds complexity (mounted refs keyed by old
   * indices, current-stop drift, etc.) without a clear UX win.
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.deferIfActive=false]
   * @param {boolean} [opts.cancelOnRender=true] - When true (default),
   *   the probe captures `_renderGen` and aborts before mutating state
   *   if a later render bumps the generation. Render-triggered probes
   *   want this so a stale fetch can't clobber a fresh reset. One-shot
   *   recovery callers (e.g. the deferred config-probe) pass `false`
   *   so they don't self-cancel.
   * @returns {Promise<Array<Object>|null>} resolved stops, or null on miss.
   */
  async _loadAndStashTour({ deferIfActive = false, cancelOnRender = true } = {}) {
    if (!this.currentPR?.id) return null;
    if (this._toursEnabled === false) return null;
    // Capture the current render generation; if a later renderDiff bumps
    // _renderGen between our awaits, bail before mutating state. Only
    // applied when cancelOnRender is true — the deferred config probe
    // and other one-shot recovery callers pass `cancelOnRender: false`.
    const gen = this._renderGen;
    const guardStale = () => cancelOnRender && gen !== this._renderGen;
    try {
      const resp = await fetch(`/api/reviews/${this.currentPR.id}/tour`);
      if (guardStale()) return null;
      if (!resp.ok) return null;
      const data = await resp.json();
      if (guardStale()) return null;
      this._tourGenerating = data.generating === true;
      const stops = Array.isArray(data.tour?.stops) ? data.tour.stops : null;
      if (deferIfActive && this._tourIsActive()) {
        this._tourStopsPendingRestart = stops;
      } else {
        this._tourStops = stops;
        this._tourStopsPendingRestart = null;
      }
      this._syncTourToolbarButton();
      return stops;
    } catch (err) {
      console.warn('[Tour] failed to load tour:', err);
      return null;
    }
  }

  /**
   * Toolbar click entrypoint. If a tour is active, exit. Otherwise fetch
   * stops if needed, then open from the first stop. No-ops when no stops
   * exist (toolbar button stays inert with the "none available yet" label).
   * @returns {Promise<void>}
   */
  async startOrToggleTour() {
    if (this._tourIsActive()) {
      this._exitTour();
      return;
    }
    if (!this._tourStops || this._tourStops.length === 0) {
      await this._loadAndStashTour();
    }
    if (!this._tourStops || this._tourStops.length === 0) {
      // No tour stops available. When auto-generation is off and nothing is
      // already in flight, a click triggers manual generation (mirrors the
      // summaries button). `_startGenerationJob` sets the pulsing state
      // optimistically (there is no `review:background_job_started` event).
      // When `review:tour_ready` arrives the stops load and the button becomes
      // "Start guided tour" — the user clicks again to open it (no auto-open).
      if (this._toursAutoGenerate === false && !this._tourGenerating) {
        await this._startGenerationJob('tour');
      }
      return;
    }
    await this._openTourAtStart();
  }

  /**
   * Open the tour UI starting at stop 0. Lazy-creates the TourBar and
   * TourRenderer on first call so we pay zero cost for users who never
   * trigger a tour.
   */
  async _openTourAtStart() {
    if (!this._tourStops || this._tourStops.length === 0) return;

    // Drain any pending teardown from the previous tour BEFORE we read
    // wrappers below. Otherwise a fire-and-forget DELETE + its
    // loadContextFiles reload landing mid-open can rip the wrapper the
    // first stop is about to mount against. allSettled-wrapped so it
    // never rejects.
    if (this._tourCleanupPending) {
      const pending = this._tourCleanupPending;
      this._tourCleanupPending = null;
      await pending;
    }

    if (!this._tourRenderer && typeof window !== 'undefined' && window.TourRenderer) {
      this._tourRenderer = new window.TourRenderer(this);
    }
    if (!this._tourBar && typeof window !== 'undefined' && window.TourBar) {
      this._tourBar = new window.TourBar({
        onPrev: () => this._advanceTour(-1),
        onNext: () => this._advanceTour(1),
        onExit: () => this._exitTour(),
        onRestart: () => this._restartTour(),
      });
    }
    if (!this._tourRenderer || !this._tourBar) {
      console.warn('[Tour] TourRenderer/TourBar not available; cannot open tour');
      return;
    }

    this._tourRenderer.setStops(this._tourStops);
    this._tourRenderer.setActive(true);
    // Mount inside the diff-view scroll container so the bar (position:
    // sticky) spans only the diff width — the file-tree sidebar and its
    // controls stay visible.
    const diffView = document.querySelector('.main-layout .diff-view');
    this._tourBar.mount(diffView || undefined);
    this._tourBar.setStops(this._tourStops);
    this._tourBar.setCompleted(false);

    this._tourActiveIndex = -1;
    // Bump the generation BEFORE the first _advanceTour call so it sees
    // the fresh value as its baseline. Subsequent exits bump it again,
    // making in-flight probes from this open detect the mismatch and bail.
    this._tourGen += 1;
    this._registerTourKeyboardHandlers();
    this._advanceTour(1);
    this._syncTourToolbarButton();
  }

  /**
   * Advance (or rewind) the active stop by `delta`. Going past the end of
   * the tour flips the bar into completion state; going before the start
   * clamps at 0.
   *
   * Async because each probe candidate is run through
   * `TourRenderer.prepareStop` first, which may need to await a file
   * fetch (adding a non-diff file as a context file) and/or a gap-expand
   * to surface folded rows the stop anchors on. Re-entrant calls (rapid
   * Next presses, keyboard mashing) are dropped via `_advanceInFlight`
   * so we never have two probe loops mutating tour state concurrently.
   *
   * @param {number} delta - Typically +1 (next) or -1 (prev).
   * @returns {Promise<void>}
   */
  async _advanceTour(delta) {
    if (!this._tourRenderer || !this._tourBar || !this._tourStops) return;
    const total = this._tourStops.length;
    if (total === 0) return;

    // Drop overlapping nav requests. The keyboard / button callbacks all
    // fire-and-forget, so a fast Next-Next-Next while a file fetch is in
    // flight would otherwise interleave probe loops on shared mutable
    // state (`_tourActiveIndex`, the renderer's `_mounted` map).
    //
    // Latch is generation-scoped: an in-flight call from a torn-down
    // generation no longer matches `_tourGen`, so a fresh reopen passes
    // the check without any teardown path having to remember to clear
    // the slot. Fixes the exit-then-reopen wedge where the boolean
    // latch survived `_exitTour` and silently dropped the next open's
    // first `_advanceTour`.
    if (this._advanceInFlightGen === this._tourGen) return;
    this._advanceInFlightGen = this._tourGen;
    // Capture the open-generation so we can detect a teardown (exit /
    // reopen) that happened while we were sitting on an await below.
    const startGen = this._tourGen;
    const isStale = () => this._tourGen !== startGen;
    try {
      const startIndex = this._tourActiveIndex + delta;
      const dir = delta >= 0 ? 1 : -1;

      // Forward past the end (initial open uses delta=1 from -1, so this only
      // fires once we've actually reached the last stop and pressed Next again).
      if (startIndex >= total) {
        this._tourBar.setCompleted(true);
        this._tourBar.setActiveIndex(total - 1);
        this._syncTourToolbarButton();
        return;
      }

      // Probe-then-mount: locate the next mountable index WITHOUT unmounting
      // the current one. Only swap once we have a confirmed replacement. This
      // avoids the wedge where the current stop is torn down and no successor
      // mounts (file filtered out, scope change, etc.).
      let probe = Math.max(0, startIndex);
      let nextRow = null;
      let nextIndex = -1;
      while (probe >= 0 && probe < total) {
        // Skip re-probing the index that's already mounted — `mountStop` is
        // idempotent and returns the existing row, but we want to keep going
        // past the current active when delta moves us off it.
        if (probe !== this._tourActiveIndex) {
          // Prepare the stop first: add the file as a context file if it
          // isn't in the diff, and unfold any gap covering its line range.
          // prepareStop returning true is no guarantee mountStop will
          // succeed — genuinely missing data still falls through.
          await this._tourRenderer.prepareStop(probe);
          // Tour could have been exited (or re-opened) while prepareStop
          // was awaiting a file fetch / loadContextFiles. Bail before
          // mounting against a torn-down tour.
          if (isStale()) return;
          // mountStop is async (it awaits toggleFileCollapse so a collapsed
          // file is rendered + visibly expanded before we scroll to it).
          const row = await this._tourRenderer.mountStop(probe);
          // Re-check staleness: the await above is a suspension window.
          if (isStale()) return;
          if (row) {
            nextRow = row;
            nextIndex = probe;
            break;
          }
        } else if (dir > 0) {
          // Already-active probe under forward motion shouldn't count as a hit;
          // we want to advance past it.
        } else {
          // Backward delta landing on the current stop: nothing earlier mounted.
          break;
        }
        probe += dir;
      }

      if (!nextRow) {
        if (dir > 0) {
          // Forward exhaustion: flip to completion using the last successfully
          // mounted index. If we never mounted anything (initial open found no
          // mountable stops), bail out cleanly so the toolbar resets.
          if (this._tourActiveIndex < 0) {
            console.warn('[Tour] no mountable stops found; exiting');
            this._exitTour();
            return;
          }
          this._tourBar.setCompleted(true);
          this._tourBar.setActiveIndex(this._tourActiveIndex);
          this._syncTourToolbarButton();
          return;
        }
        // Backward exhaustion: leave the current stop mounted/active untouched.
        console.debug('[Tour] no earlier mountable stop; staying put');
        return;
      }

      // Successful candidate — only now unmount the previous stop.
      if (this._tourActiveIndex >= 0 && this._tourActiveIndex !== nextIndex) {
        this._tourRenderer.unmountStop(this._tourActiveIndex);
      }

      this._tourActiveIndex = nextIndex;
      this._tourRenderer.highlightActive(nextIndex);
      this._tourRenderer.scrollToStop(nextIndex);
      this._tourBar.setCompleted(false);
      this._tourBar.setActiveIndex(nextIndex);
      this._syncTourToolbarButton();
      // Suppress unused-var lints; nextRow exists for symmetry with future
      // post-mount work (focus management, telemetry).
      void nextRow;
    } finally {
      // Only release the latch if we still own the slot. A teardown that
      // bumped `_tourGen` between entry and now has already invalidated
      // our holder — and a fresh generation may have taken the slot for
      // its own call. Clobbering it with `-1` would let two _advanceTour
      // calls run concurrently on the new generation.
      if (this._advanceInFlightGen === startGen) {
        this._advanceInFlightGen = -1;
      }
    }
  }

  /**
   * Tear down the tour: unmount every annotation, unmount the bar, drop the
   * body class, and unregister keyboard handlers.
   */
  _exitTour() {
    // Bump generation FIRST so any in-flight `_advanceTour` (sitting on an
    // ensureContextFile / ensureLinesVisible await) sees the mismatch on
    // resume and bails instead of mutating state for a torn-down tour.
    this._tourGen += 1;
    let drain = Promise.resolve();
    if (this._tourRenderer) {
      // unmountAll fires-and-forgets context-file DELETEs but returns a
      // drain promise. Stash it on `_tourCleanupPending` so the next open
      // can await it before reading wrappers — otherwise the DELETE's
      // loadContextFiles reload can rip the new tour's wrapper out from
      // under an active stop.
      drain = this._tourRenderer.unmountAll();
      this._tourRenderer.setActive(false);
    }
    this._tourCleanupPending = drain;
    if (this._tourBar) {
      this._tourBar.unmount();
    }
    this._unregisterTourKeyboardHandlers();
    this._tourActiveIndex = -1;
    // Consume any pending tour stashed by `review:tour_ready` while we
    // were running. Next open uses the fresh stops.
    if (Array.isArray(this._tourStopsPendingRestart)) {
      this._tourStops = this._tourStopsPendingRestart;
      this._tourStopsPendingRestart = null;
    }
    this._syncTourToolbarButton();
  }

  /**
   * Exit, then re-open from stop 0. Async because `_openTourAtStart`
   * drains the prior tour's pending teardown (context-file DELETEs +
   * their loadContextFiles reloads) before reading wrappers, so the
   * fresh tour can't mount against a wrapper the old DELETE is about to
   * tear down. If a newer tour was stashed via `review:tour_ready`,
   * `_exitTour` swaps it in before we reopen.
   *
   * Caller (`onRestart` toolbar callback) is fire-and-forget; the
   * returned promise is for symmetry / testability.
   *
   * @returns {Promise<void>}
   */
  async _restartTour() {
    this._exitTour();
    await this._openTourAtStart();
  }

  /**
   * Install the keyboard shortcut handler. Bound to `document` so it fires
   * regardless of focus, with a guard that skips when the user is typing
   * in a text field.
   */
  _registerTourKeyboardHandlers() {
    if (this._tourKeydownHandler) return;
    const handler = (e) => {
      if (!this._tourIsActive()) return;

      // Skip when the user is typing — text fields, contenteditable, etc.
      // Arrow keys move the caret; Escape is owned by the surrounding form.
      const target = e.target;
      const tag = target && target.tagName;
      const isEditable = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' ||
        (target && (target.isContentEditable || target.contentEditable === 'true'));
      if (isEditable) return;

      // Skip when a modal is open. Modals own their own Escape ladder
      // (close dropdown, blur, dismiss); we don't want to compete. Defer
      // to the shared ModalDetection utility so the selector list stays
      // in sync with KeyboardShortcuts.
      if (window.ModalDetection?.isModalOpen()) return;

      // Skip ALL tour shortcuts when the chat panel is open. ChatPanel
      // binds its own document-level Escape handler with a ladder of
      // states (provider/session dropdown, streaming stop, blur input,
      // close panel). Arrow keys may also be in use by chat surfaces.
      // Yanking the tour out from under the user — by advancing OR
      // exiting — when they have the chat panel open would be surprising.
      const chatPanel = document.querySelector('.chat-panel.chat-panel--open');
      if (chatPanel) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        this._advanceTour(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this._advanceTour(-1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Stop propagation so other Escape-bound listeners (chat panel
        // when it's closed-but-bound, future keyboard shortcuts) don't
        // also fire for the same key event.
        e.stopImmediatePropagation();
        this._exitTour();
      }
    };
    document.addEventListener('keydown', handler);
    this._tourKeydownHandler = handler;
  }

  _unregisterTourKeyboardHandlers() {
    if (!this._tourKeydownHandler) return;
    document.removeEventListener('keydown', this._tourKeydownHandler);
    this._tourKeydownHandler = null;
  }

  /**
   * Listen for review-scoped CustomEvents dispatched by ChatPanel's
   * WebSocket pub/sub connection.
   */
  _initReviewEventListeners() {
    if (this._reviewEventsBound) return;
    this._reviewEventsBound = true;

    // Eagerly connect WebSocket subscriptions so review events flow even before chat opens
    window.chatPanel?._ensureSubscriptions();

    // Late-bind reviewId to ChatPanel if it was auto-opened by PanelGroup
    // before prManager was ready (DOMContentLoaded race condition)
    if (this.currentPR?.id) {
      window.chatPanel?._lateBindReview(this.currentPR.id).catch(err => console.warn('[ChatPanel] Late-bind failed:', err));
    }

    // Dirty flags for stale-tab recovery
    this._dirtyComments = false;
    this._dirtySuggestions = false;
    this._dirtyAnalysis = false;
    this._dirtyAnalysisStarted = false;
    this._dirtyContextFiles = false;

    // Simple debounce helper
    const timers = {};
    const debounced = (key, fn, ms = 300) => {
      clearTimeout(timers[key]);
      timers[key] = setTimeout(fn, ms);
    };

    const reviewId = () => this.currentPR?.id;

    document.addEventListener('review:comments_changed', (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      // Suppress self-echo: if this tab originated the mutation, skip reload
      if (e.detail?.sourceClientId === this._clientId) return;
      if (document.hidden) { this._dirtyComments = true; return; }
      debounced('comments', () => this.loadUserComments());
    });

    document.addEventListener('review:suggestions_changed', (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      // Suppress self-echo for suggestion mutations too
      if (e.detail?.sourceClientId === this._clientId) return;
      if (document.hidden) { this._dirtySuggestions = true; return; }
      debounced('suggestions', () => this.loadAISuggestions());
    });

    document.addEventListener('review:analysis_started', (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      if (document.hidden) { this._dirtyAnalysisStarted = true; return; }
      debounced('analysisStarted', () => this.checkRunningAnalysis());
    });

    document.addEventListener('review:analysis_completed', (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      if (document.hidden) { this._dirtyAnalysis = true; return; }
      debounced('analysis', () => {
        if (this.analysisHistoryManager) {
          this.analysisHistoryManager.refresh({ switchToNew: true })
            .then(() => this._reloadAfterAnalysis());
        } else {
          this._reloadAfterAnalysis();
        }
      });
    });

    document.addEventListener('review:context_files_changed', (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      if (e.detail?.sourceClientId === this._clientId) return;
      if (document.hidden) { this._dirtyContextFiles = true; return; }
      debounced('contextFiles', () => this.loadContextFiles());
    });

    document.addEventListener('review:expand_hunk', async (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      const { file, line_start, line_end, side } = e.detail;
      await this.ensureLinesVisible([{ file, line_start, line_end, side: side || 'right' }]);
    });

    document.addEventListener('review:hunk_summaries_ready', (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      // Per-file completion implies the review-level job is still working,
      // so reflect "generating" until `background_job_finished` clears it.
      // (No-op when the toolbar button is already pulsing.)
      if (!this._summariesGenerating) {
        this._summariesGenerating = true;
        this._syncSummaryToolbarButton();
      }
      this._applyHunkSummaries(e.detail.filePath, e.detail.summaries || []);
    });

    // Tour-ready broadcasts arrive after the tour-generation job persists a
    // new tour. We refresh the cached stops in the background but do NOT
    // auto-open the tour — user must click the toolbar button. If a tour is
    // already mounted, the new stops are stashed for restart so we don't
    // yank the active tour out from under the user (v1 simple approach).
    document.addEventListener('review:tour_ready', (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      this._loadAndStashTour({ deferIfActive: true }).catch(() => {});
    });

    document.addEventListener('review:background_job_finished', (e) => {
      if (e.detail?.reviewId !== reviewId()) return;
      const jobType = e.detail?.jobType || '';
      const isSummaries = jobType === 'summaries' || jobType.startsWith('summaries:');
      const isTour = jobType === 'tour' || jobType.startsWith('tour:');
      if (!isSummaries && !isTour) return;
      // The queue can host multiple `${type}:${digest}` jobs back-to-back
      // (refresh, scope change, whitespace toggle). The broadcast payload
      // carries `hasActiveForType` from the queue's view AFTER this job's
      // key was deleted, so a sibling job still in flight keeps the pulse
      // visible.
      if (e.detail?.hasActiveForType === true) return;
      if (isSummaries) {
        this._summariesGenerating = false;
        this._syncSummaryToolbarButton();
      }
      if (isTour) {
        this._tourGenerating = false;
        this._syncTourToolbarButton();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (this._dirtyComments) { this._dirtyComments = false; this.loadUserComments(); }
      if (this._dirtyAnalysisStarted) {
        this._dirtyAnalysisStarted = false;
        // Skip if analysis already completed while hidden — the completed handler below will refresh everything
        if (!this._dirtyAnalysis) {
          this.checkRunningAnalysis();
        }
      }
      if (this._dirtyAnalysis) {
        this._dirtyAnalysis = false;
        this._dirtySuggestions = false; // analysis refresh includes suggestion reload
        if (this.analysisHistoryManager) {
          this.analysisHistoryManager.refresh({ switchToNew: true })
            .then(() => this._reloadAfterAnalysis());
        } else {
          this._reloadAfterAnalysis();
        }
      } else if (this._dirtySuggestions) {
        this._dirtySuggestions = false;
        this.loadAISuggestions();
      }
      if (this._dirtyContextFiles) {
        this._dirtyContextFiles = false;
        this.loadContextFiles();
      }
    });
  }

  /**
   * Load files and diff from the diff endpoint
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   */
  async loadAndDisplayFiles(owner, repo, number) {
    try {
      const diffUrl = this.hideWhitespace
        ? `/api/pr/${owner}/${repo}/${number}/diff?w=1`
        : `/api/pr/${owner}/${repo}/${number}/diff`;
      const response = await fetch(diffUrl);

      if (response.ok) {
        const data = await response.json();
        const files = data.changed_files || [];
        const fullDiff = data.diff || '';

        // Build map of generated files for quick lookup
        this.generatedFiles.clear();
        files.forEach(file => {
          if (file.generated) {
            this.generatedFiles.set(file.file, {
              insertions: file.insertions || 0,
              deletions: file.deletions || 0
            });
          }
        });

        // Parse the unified diff to extract per-file patches
        const filePatchMap = this.parseUnifiedDiff(fullDiff);
        this.filePatches = filePatchMap;

        // Merge patch data into file objects
        const filesWithPatches = files.map(file => ({
          ...file,
          patch: filePatchMap.get(file.file) || ''
        }));

        // Sort files alphabetically by path for consistent ordering across all components
        if (!window.FileOrderUtils) {
          console.warn('FileOrderUtils not loaded - file ordering will be inconsistent');
        }
        const sortedFiles = window.FileOrderUtils?.sortFilesByPath(filesWithPatches) || filesWithPatches;

        // Store canonical file order for use by AIPanel and other components
        this.canonicalFileOrder = window.FileOrderUtils?.createFileOrderMap(sortedFiles) || new Map();

        // Pass file order to AIPanel
        if (window.aiPanel?.setFileOrder) {
          window.aiPanel.setFileOrder(this.canonicalFileOrder);
        }

        // Load viewed state before rendering so files can start collapsed
        // and so the sidebar viewed indicator renders on first paint
        await this.loadViewedState();

        // Update sidebar with file list
        this.updateFileList(sortedFiles);

        // Render diff using the existing renderDiff method
        this.renderDiff({ changed_files: sortedFiles });

        // Progressively fetch full file contents for hunk expansion
        this._upgradeFilesWithContents(sortedFiles);

      } else {
        const diffContainer = document.getElementById('diff-container');
        if (diffContainer) {
          diffContainer.innerHTML = '<div class="no-diff">Failed to load changes</div>';
        }
      }
    } catch (error) {
      console.error('Error loading files:', error);
      const diffContainer = document.getElementById('diff-container');
      if (diffContainer) {
        diffContainer.innerHTML = '<div class="no-diff">Error loading changes</div>';
      }
    }
  }

  /**
   * Handle the whitespace visibility toggle from DiffOptionsDropdown.
   * Re-fetches the diff (with or without ?w=1), re-renders it, and
   * re-anchors user comments and AI suggestions on the fresh DOM.
   * @param {boolean} hide - Whether to hide whitespace-only changes
   */
  async handleWhitespaceToggle(hide) {
    this.hideWhitespace = hide;

    // Nothing to reload if we haven't loaded a PR yet
    if (!this.currentPR) return;

    const { owner, repo, number } = this.currentPR;
    const scrollY = window.scrollY;

    // Re-fetch and re-render the diff
    await this.loadAndDisplayFiles(owner, repo, number);

    // Re-anchor every overlay (user comments, AI suggestions, external
    // comments) via the shared helper so the three renderers can't drift.
    // The diff DOM was just rebuilt, so external-comment rows are gone
    // until loadAndRender re-inserts them.
    await this._rerenderAllOverlays({ analysisRunId: this.selectedRunId });

    // Restore scroll position after the DOM settles
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollY);
    });
  }

  /**
   * Handle the minimize comments toggle from DiffOptionsDropdown.
   * Toggles minimize mode which hides inline comments/suggestions and
   * shows compact indicators on diff lines instead.
   * @param {boolean} minimized - Whether to minimize comments
   */
  handleMinimizeToggle(minimized) {
    if (this.commentMinimizer) {
      this.commentMinimizer.setMinimized(minimized);
    }
  }

  /**
   * Handle the diff-view toggle (Unified / Split) from DiffOptionsDropdown.
   *
   * Unlike handleWhitespaceToggle, this does NOT re-fetch the diff — it asks
   * PierreBridge to switch the single CodeView's diffStyle. The CodeView
   * relayouts and re-renders all mounted items in the new style, preserving
   * each item's annotations (comments, suggestions, external threads) and
   * capturing a scroll anchor so position is retained across the swap — so no
   * _rerenderAllOverlays and no manual scrollTop save/restore are needed here.
   * Shared by both PR mode and local mode (local.js patches PRManager).
   * @param {('unified'|'split')} mode
   */
  handleDiffViewChange(mode) {
    // No bridge means no renderer can apply the swap. Report failure so the
    // dropdown rolls back its selection instead of persisting a mode the diff
    // won't reflect. (The dropdown also hides the control via
    // diffViewAvailable, so this is defense in depth.)
    if (!this.pierreBridge) return false;
    // The single CodeView owns scrolling on #diff-container; its setOptions
    // relayout captures a scroll anchor and restores position across the
    // unified/split swap, so no manual scrollTop save/restore is needed here.
    this.pierreBridge.setDiffStyle(mode);
    return true;
  }

  /**
   * Parse unified diff to extract per-file patches
   * @param {string} diff - Full unified diff
   * @returns {Map<string, string>} Map of filename to patch content
   */
  parseUnifiedDiff(diff) {
    const filePatchMap = new Map();
    if (!diff) return filePatchMap;

    // Split by diff --git headers
    const parts = diff.split(/(?=^diff --git )/m);

    for (const part of parts) {
      if (!part.trim()) continue;

      // Extract filename from diff --git line
      const match = part.match(/^diff --git a\/(.+?) b\/(.+)/);
      if (match) {
        const fileName = match[2]; // Use the 'b' path (new file path)
        filePatchMap.set(fileName, part);
      }
    }

    return filePatchMap;
  }

  /**
   * Set loading state
   * @param {boolean} loading - Whether loading is in progress
   */
  setLoading(loading) {
    this.loadingState = loading;
    const container = document.getElementById('pr-container');
    if (container) {
      // State flag only — must not be `loading`, which is the visual
      // placeholder class (padding + centered text). The diff paints inside
      // this container before loading finishes, so placeholder styles here
      // cause a visible centered-then-left layout shift.
      if (loading) {
        container.classList.add('is-loading');
      } else {
        container.classList.remove('is-loading');
      }
    }
  }

  /**
   * Render PR header
   * @param {Object} pr - PR data
   */
  renderPRHeader(pr) {
    // Update breadcrumb
    const breadcrumbOrg = document.querySelector('.breadcrumb-org');
    const breadcrumbRepo = document.querySelector('.breadcrumb-repo');
    const breadcrumbPr = document.querySelector('.breadcrumb-pr');

    if (breadcrumbOrg) breadcrumbOrg.textContent = pr.owner;
    if (breadcrumbRepo) breadcrumbRepo.textContent = pr.repo;
    if (breadcrumbPr) breadcrumbPr.textContent = `#${pr.number}`;

    // Update title — wrap in stack nav dropdown when stack data is available
    const titleElement = document.getElementById('pr-title-text');
    if (titleElement) {
      titleElement.textContent = pr.title;
    }
    this._renderStackNavDropdown(pr);

    // Show/hide PR description info button
    const descToggle = document.getElementById('pr-description-toggle');
    if (descToggle) {
      if (pr.body) {
        descToggle.style.display = '';
        this._prBody = pr.body;
      } else {
        descToggle.style.display = 'none';
        this._prBody = null;
      }
    }

    // Update meta info - show only head branch, full info in tooltip
    const branchName = document.getElementById('pr-branch-name');
    const branchContainer = document.getElementById('pr-branch');
    const branchCopy = document.getElementById('pr-branch-copy');
    if (branchName) {
      branchName.textContent = pr.head_branch;
      // Set tooltip with full branch info (base <- head, showing merge direction)
      if (branchContainer) {
        branchContainer.title = `${pr.base_branch} <- ${pr.head_branch}`;
      }

      if (branchCopy && !branchCopy.hasAttribute('data-listener-added')) {
        branchCopy.setAttribute('data-listener-added', 'true');
        branchCopy.addEventListener('click', async (e) => {
          e.stopPropagation();
          const branch = branchName.textContent;
          if (!branch || branch === '--') return;
          try {
            await navigator.clipboard.writeText(branch);
            // Visual feedback
            branchCopy.classList.add('copied');
            setTimeout(() => branchCopy.classList.remove('copied'), 2000);
          } catch (err) {
            console.error('Failed to copy branch name:', err);
          }
        });
      }
    }

    const additions = document.getElementById('pr-additions');
    if (additions) {
      additions.textContent = `+${pr.additions}`;
    }

    const deletions = document.getElementById('pr-deletions');
    if (deletions) {
      deletions.textContent = `-${pr.deletions}`;
    }

    const filesCount = document.getElementById('pr-files-count');
    if (filesCount) {
      filesCount.textContent = `${pr.file_changes || pr.changed_files?.length || 0} files`;
    }

    // Update commit SHA with copy functionality
    const commitSha = document.getElementById('pr-commit-sha');
    const commitCopy = document.getElementById('pr-commit-copy');
    if (commitSha && pr.head_sha) {
      const abbrevLen = pr.shaAbbrevLength || 7;
      commitSha.textContent = pr.head_sha.substring(0, abbrevLen);
      // Store full SHA for copying (updates on refresh)
      commitSha.dataset.fullSha = pr.head_sha;

      if (commitCopy && !commitCopy.hasAttribute('data-listener-added')) {
        commitCopy.setAttribute('data-listener-added', 'true');
        commitCopy.addEventListener('click', async (e) => {
          e.stopPropagation();
          const fullSha = commitSha.dataset.fullSha;
          if (!fullSha) return;
          try {
            await navigator.clipboard.writeText(fullSha);
            // Visual feedback
            commitCopy.classList.add('copied');
            setTimeout(() => commitCopy.classList.remove('copied'), 2000);
          } catch (err) {
            console.error('Failed to copy SHA:', err);
          }
        });
      }
    }

    // Update GitHub link
    const githubLink = document.getElementById('github-link');
    if (githubLink && pr.html_url) {
      githubLink.href = pr.html_url;
    }

    // Update Graphite link (gated on enable_graphite config)
    const graphiteLink = document.getElementById('graphite-link');
    if (graphiteLink && pr.html_url && window.__pairReview?.enableGraphite
        && graphiteLink.dataset.suppressed !== 'true') {
      // Derive from html_url to preserve GitHub's original casing (Graphite URLs are case-sensitive)
      const graphiteUrl = window.__pairReview.toGraphiteUrl(pr.html_url);
      graphiteLink.href = graphiteUrl;
      graphiteLink.style.display = '';
    }

    if (window.RepoLinks && pr.owner && pr.repo) {
      const linksApplied = window.RepoLinks.fetchAndApplyRepoLinks(pr.owner, pr.repo, {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        branch: pr.head_branch,
        base_branch: pr.base_branch,
        head_sha: pr.head_sha,
      });
      // The repo links (incl. the configured host name) resolve asynchronously
      // after this synchronous render. Re-render the pending-draft indicator
      // once they land so it shows the configured host name (e.g. "Meteorite")
      // instead of the "GitHub" fallback it would otherwise bake in below.
      if (linksApplied && typeof linksApplied.then === 'function') {
        linksApplied.then(() => this.updatePendingDraftIndicator(pr.pendingDraft));
      }
    }

    // Update settings link
    const settingsLink = document.getElementById('settings-link');
    if (settingsLink && pr.owner && pr.repo) {
      settingsLink.href = `/settings/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`;

      // Store referrer data for back navigation from settings page
      // Key is scoped by repo to prevent collision between multiple tabs
      // Guard against adding duplicate listeners (renderPRHeader can be called multiple times)
      if (!settingsLink.dataset.listenerAttached) {
        settingsLink.dataset.listenerAttached = 'true';
        settingsLink.addEventListener('click', () => {
          const referrerKey = `settingsReferrer:${pr.owner}/${pr.repo}`;
          localStorage.setItem(referrerKey, JSON.stringify({
            prNumber: pr.number,
            owner: pr.owner,
            repo: pr.repo
          }));
        });
      }
    }

    // Update pending draft indicator in toolbar
    this.updatePendingDraftIndicator(pr.pendingDraft);

    // Render analyze split button when stack data is available
    this._renderAnalyzeSplitButton(pr);
  }

  /**
   * Render the analyze split button when stack data is available.
   * Wraps the existing #analyze-btn with a dropdown toggle for "Analyze Stack".
   * @param {Object} pr - PR data with optional stack_data
   */
  _renderAnalyzeSplitButton(pr) {
    const analyzeBtn = document.getElementById('analyze-btn');
    if (!analyzeBtn) return;

    // Remove existing split container if present (re-render safe)
    const existingContainer = document.getElementById('analyze-split-container');
    if (existingContainer) {
      // Move analyze button back out of the container before removing
      existingContainer.parentNode.insertBefore(analyzeBtn, existingContainer);
      existingContainer.remove();
    }
    // Clean up previous outside-click handler
    if (this._closeAnalyzeDropdown) {
      document.removeEventListener('click', this._closeAnalyzeDropdown);
      this._closeAnalyzeDropdown = null;
    }

    // Determine stack PRs (non-trunk entries with PR numbers)
    const stackPRs = this._getStackPRs(pr);
    if (stackPRs.length < 2) return; // No meaningful stack

    // Create split button container
    const container = document.createElement('div');
    container.className = 'analyze-split-container';
    container.id = 'analyze-split-container';

    // Insert container where analyze button is, then move button inside
    analyzeBtn.parentNode.insertBefore(container, analyzeBtn);
    container.appendChild(analyzeBtn);

    // Dropdown toggle (chevron)
    const toggle = document.createElement('button');
    toggle.className = 'analyze-dropdown-toggle';
    toggle.id = 'analyze-stack-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Stack analysis options');
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
      </svg>
    `;
    container.appendChild(toggle);

    // Dropdown menu
    const menu = document.createElement('div');
    menu.className = 'analyze-dropdown-menu';
    menu.id = 'analyze-dropdown-menu';
    const itemBtn = document.createElement('button');
    itemBtn.className = 'analyze-dropdown-item';
    itemBtn.id = 'analyze-stack-btn';
    itemBtn.type = 'button';
    itemBtn.textContent = `Analyze Stack (${stackPRs.length} PRs)`;
    menu.appendChild(itemBtn);
    container.appendChild(menu);

    // Event: toggle dropdown
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = container.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });

    // Event: click stack analysis item
    itemBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      container.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      this.triggerStackAnalysis();
    });

    // Close dropdown on outside click
    this._closeAnalyzeDropdown = (e) => {
      if (!container.contains(e.target)) {
        container.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('click', this._closeAnalyzeDropdown);
  }

  /**
   * Render the stack navigation dropdown around the PR title.
   * Replaces static title with a clickable dropdown when stack data has multiple PRs.
   * @param {Object} pr - PR data with optional stack_data
   */
  _renderStackNavDropdown(pr) {
    const titleWrapper = document.querySelector('.pr-title-wrapper');
    if (!titleWrapper) return;

    // Remove existing stack nav if present (re-render safe)
    const existingNav = titleWrapper.querySelector('.stack-nav-dropdown');
    if (existingNav) {
      // Restore the title element outside the nav wrapper
      const titleEl = existingNav.querySelector('#pr-title-text');
      if (titleEl) {
        titleWrapper.insertBefore(titleEl, existingNav);
      }
      existingNav.remove();
    }
    // Clean up previous outside-click handler
    if (this._closeStackNav) {
      document.removeEventListener('click', this._closeStackNav);
      this._closeStackNav = null;
    }

    const stackPRs = this._getStackPRs(pr);
    if (stackPRs.length < 2) return; // No meaningful stack

    const titleElement = document.getElementById('pr-title-text');
    if (!titleElement) return;

    // Create dropdown wrapper
    const dropdown = document.createElement('div');
    dropdown.className = 'stack-nav-dropdown';

    // Create trigger button wrapping the title
    const trigger = document.createElement('button');
    trigger.className = 'stack-nav-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');

    // Move title into trigger
    titleWrapper.insertBefore(dropdown, titleElement);
    dropdown.appendChild(trigger);
    trigger.appendChild(titleElement);

    // Add chevron
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.classList.add('stack-nav-chevron');
    chevron.setAttribute('viewBox', '0 0 16 16');
    chevron.setAttribute('width', '14');
    chevron.setAttribute('height', '14');
    chevron.innerHTML = '<path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>';
    trigger.appendChild(chevron);

    // Create menu
    const menu = document.createElement('div');
    menu.className = 'stack-nav-menu';
    dropdown.appendChild(menu);

    // Populate menu items (reversed: stack base at bottom)
    const displayPRs = [...stackPRs].reverse();
    for (const stackPR of displayPRs) {
      const isCurrent = stackPR.prNumber === pr.number;
      // Render as a real anchor so right-click / cmd-click / middle-click can
      // open the PR in a new tab natively. The current PR gets no href (not a
      // link to itself).
      const item = document.createElement('a');
      item.className = 'stack-nav-item';
      if (isCurrent) {
        item.classList.add('current');
      } else {
        item.href = `/pr/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/${stackPR.prNumber}`;
      }
      item.dataset.pr = stackPR.prNumber;

      // Text content column
      const textCol = document.createElement('div');
      textCol.className = 'stack-nav-text';

      // Primary row: PR number + title inline
      const primaryRow = document.createElement('div');
      primaryRow.className = 'stack-nav-primary';

      const numberSpan = document.createElement('span');
      numberSpan.className = 'stack-nav-number';
      numberSpan.textContent = `#${stackPR.prNumber}`;
      primaryRow.appendChild(numberSpan);

      if (stackPR.title) {
        const titleSpan = document.createElement('span');
        titleSpan.className = 'stack-nav-title';
        titleSpan.textContent = stackPR.title;
        primaryRow.appendChild(titleSpan);
      }

      textCol.appendChild(primaryRow);

      // Secondary row: branch name
      const branchRow = document.createElement('div');
      branchRow.className = 'stack-nav-branch';
      // SVG branch icon
      branchRow.innerHTML = '<svg class="stack-nav-branch-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"></path></svg>';
      const branchName = document.createElement('span');
      branchName.textContent = stackPR.branch || '';
      branchRow.appendChild(branchName);
      textCol.appendChild(branchRow);

      item.appendChild(textCol);

      // Navigation is handled natively by the anchor's href (enabling
      // open-in-new-tab). A plain left-click follows the link and unloads the
      // page; for modified clicks (cmd/ctrl/middle → new tab) or the current
      // PR, just close the menu without navigating the current tab.
      item.addEventListener('click', (e) => {
        // Modified clicks open a new tab — leave the current page as-is.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) {
          dropdown.classList.remove('open');
          trigger.setAttribute('aria-expanded', 'false');
          return;
        }
        // Current PR has no href; nothing to navigate to.
        if (stackPR.prNumber === pr.number) {
          e.preventDefault();
        }
        dropdown.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      });

      menu.appendChild(item);
    }

    // Toggle dropdown
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.toggle('open');
      trigger.setAttribute('aria-expanded', String(isOpen));
    });

    // Close on outside click
    this._closeStackNav = (e) => {
      if (!dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('click', this._closeStackNav);
  }

  /**
   * Extract non-trunk stack PRs from PR data.
   * @param {Object} pr - PR data with optional stack_data
   * @returns {Array<Object>} Stack PR entries with prNumber, title, branch, hasAnalysis
   */
  _getStackPRs(pr) {
    if (!pr.stack_data || !Array.isArray(pr.stack_data)) return [];
    return pr.stack_data.filter(entry => !entry.isTrunk && entry.prNumber);
  }

  /**
   * Trigger stack analysis flow:
   * 1. Open StackAnalysisDialog to select PRs
   * 2. Open AnalysisConfigModal for analysis config
   * 3. Call startStackAnalysis()
   */
  async triggerStackAnalysis() {
    // If a stack analysis is active (running but hidden), reopen its progress modal
    if (this.stackProgressModal?.isActive) {
      this.stackProgressModal.reopenFromBackground();
      return;
    }

    if (!this.currentPR) {
      this.showError('No PR loaded');
      return;
    }

    const { owner, repo, number } = this.currentPR;

    try {
      // Open stack selection dialog
      if (!this.stackAnalysisDialog) {
        console.warn('StackAnalysisDialog not initialized');
        return;
      }

      const dialogResult = await this.stackAnalysisDialog.open(owner, repo, number);
      if (!dialogResult) return; // User cancelled
      const { selectedPRNumbers, prList } = dialogResult;
      if (!selectedPRNumbers || selectedPRNumbers.length === 0) return;

      // Open analysis config modal
      if (!this.analysisConfigModal) {
        console.warn('AnalysisConfigModal not initialized, proceeding with defaults');
        await this.startStackAnalysis(owner, repo, number, selectedPRNumbers, {}, prList);
        return;
      }

      // Fetch settings in parallel
      const [repoSettings, reviewSettings, appConfig] = await Promise.all([
        this.fetchRepoSettings().catch(() => null),
        this.fetchLastReviewSettings().catch(() => ({ custom_instructions: '', last_council_id: null })),
        this._getAppConfig()
      ]);

      // Resolve provider and model as a MATCHED pair so the council/advanced tabs
      // are never seeded with a cross-provider model (e.g. antigravity + opus), which
      // would blank the model <select> and be rejected by the backend.
      // buildProviderModelScopes prepends any CLI/env override ahead of repo
      // settings so `--provider` seeds the modal as the default selection.
      const providersInfo = await this._getProvidersInfo();
      const { provider: currentProvider, model: currentModel } = window.resolveProviderModelPair(
        window.buildProviderModelScopes(repoSettings, appConfig),
        providersInfo
      );
      const tabStorageKey = PRManager.getRepoStorageKey('pair-review-tab', owner, repo);
      const rememberedTab = localStorage.getItem(tabStorageKey);
      const defaultTab = rememberedTab || repoSettings?.default_tab || 'single';
      const instructionsStorageKey = PRManager.getRepoStorageKey('pair-review-instructions', owner, repo);
      const lastInstructions = reviewSettings.custom_instructions
        ?? localStorage.getItem(instructionsStorageKey)
        ?? '';
      const lastCouncilId = reviewSettings.last_council_id;

      this.analysisConfigModal.onTabChange = (tabId) => {
        localStorage.setItem(tabStorageKey, tabId);
      };

      const config = await this.analysisConfigModal.show({
        currentModel,
        currentProvider,
        defaultTab,
        repoInstructions: repoSettings?.default_instructions || '',
        lastInstructions,
        lastCouncilId,
        defaultCouncilId: repoSettings?.default_council_id || null
      });

      if (!config) return; // User cancelled

      // Persist custom instructions
      const submittedInstructions = config.customInstructions || '';
      if (submittedInstructions) {
        localStorage.setItem(instructionsStorageKey, submittedInstructions);
      } else {
        localStorage.removeItem(instructionsStorageKey);
      }

      await this.startStackAnalysis(owner, repo, number, selectedPRNumbers, config, prList);

    } catch (error) {
      console.error('Error triggering stack analysis:', error);
      this.showError(`Failed to start stack analysis: ${error.message}`);
    }
  }

  /**
   * Start stack analysis by posting to the backend and opening the progress modal.
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - Current PR number
   * @param {Array<number>} selectedPRNumbers - PRs to analyze
   * @param {Object} analysisConfig - Analysis configuration from the config modal
   * @param {Array<Object>} [prList] - PR metadata with titles from the selection dialog
   */
  async startStackAnalysis(owner, repo, number, selectedPRNumbers, analysisConfig, prList) {
    try {
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/analyses/stack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prNumbers: selectedPRNumbers,
          analysisConfig
        })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Failed to start stack analysis');
      }

      const result = await response.json();

      // Merge titles from dialog into backend response
      const prAnalysesWithTitles = (result.prAnalyses || []).map(pr => {
        const info = (prList || []).find(p => p.prNumber === pr.prNumber);
        return { ...pr, title: info?.title || pr.title };
      });

      // Set button to analyzing state so clicking it reopens the modal
      this.setButtonAnalyzing(result.stackAnalysisId);

      // Update dropdown item to show "Analyzing Stack..."
      const stackBtn = document.getElementById('analyze-stack-btn');
      if (stackBtn) {
        stackBtn.textContent = 'Analyzing Stack...';
      }

      // Open stack progress modal
      if (this.stackProgressModal) {
        this.stackProgressModal.open(result.stackAnalysisId, prAnalysesWithTitles, {
          owner, repo,
          onComplete: () => {
            this.resetButton();
            // Reset dropdown item text
            const btn = document.getElementById('analyze-stack-btn');
            if (btn) {
              const stackPRs = this._getStackPRs(this.currentPR);
              btn.textContent = `Analyze Stack (${stackPRs.length} PRs)`;
            }
          }
        });
      }

    } catch (error) {
      console.error('Error starting stack analysis:', error);
      if (window.toast) {
        window.toast.showError(`Stack analysis failed: ${error.message}`);
      }
    }
  }

  /**
   * Set up the PR description popover toggle (called once during init).
   */
  setupPRDescriptionPopover() {
    const toggle = document.getElementById('pr-description-toggle');
    if (!toggle) return;

    const closePopover = () => {
      const existing = document.querySelector('.pr-description-popover');
      if (existing) existing.remove();
      toggle.classList.remove('active');
      toggle.setAttribute('aria-expanded', 'false');
    };

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.querySelector('.pr-description-popover');
      if (existing) {
        closePopover();
        return;
      }

      const body = this._prBody || '';
      const rendered = window.renderMarkdown ? window.renderMarkdown(body) : this.escapeHtml(body);

      const popover = document.createElement('div');
      popover.className = 'pr-description-popover';

      const arrow = document.createElement('div');
      arrow.className = 'pr-description-popover-arrow';

      const header = document.createElement('div');
      header.className = 'pr-description-popover-header';

      const title = document.createElement('span');
      title.className = 'pr-description-popover-title';
      title.textContent = 'PR Description';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'pr-description-popover-close';
      closeBtn.title = 'Close';
      closeBtn.innerHTML = '&times;';

      header.append(title, closeBtn);

      const content = document.createElement('div');
      content.className = 'pr-description-popover-content';
      content.innerHTML = rendered;

      popover.append(arrow, header, content);

      // Position relative to the toggle button
      const rect = toggle.getBoundingClientRect();
      popover.style.position = 'fixed';
      popover.style.top = `${rect.bottom + 8}px`;
      popover.style.left = `${rect.left + rect.width / 2}px`;
      popover.style.transform = 'translateX(-50%)';

      // Append to document.body to escape overflow:hidden on .header-center
      document.body.appendChild(popover);

      toggle.classList.add('active');
      toggle.setAttribute('aria-expanded', 'true');

      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closePopover();
      });

      popover.addEventListener('click', (ev) => ev.stopPropagation());
    });

    document.addEventListener('click', () => {
      if (toggle.classList.contains('active')) closePopover();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && toggle.classList.contains('active')) closePopover();
    });
  }

  /**
   * Update the pending draft indicator in the toolbar
   * @param {Object|null} pendingDraft - Pending draft data or null if no draft
   */
  updatePendingDraftIndicator(pendingDraft) {
    // Find or create the draft indicator container
    const toolbarMeta = document.getElementById('toolbar-meta');
    if (!toolbarMeta) return;

    // Remove existing indicator if present
    const existing = document.getElementById('pending-draft-indicator');
    if (existing) {
      existing.remove();
    }

    // Don't show if no pending draft
    if (!pendingDraft) return;

    // Resolve the configured host name + URL (alt-host aware). Prefer the
    // URL built from the repo's url_template over the server-reported
    // github_url, which some alt-hosts return as a wrong-host github.com URL.
    const hostName = (window.RepoLinks && typeof window.RepoLinks.hostName === 'function')
      ? window.RepoLinks.hostName() : 'GitHub';
    const externalUrl = (window.RepoLinks && typeof window.RepoLinks.externalUrl === 'function')
      ? window.RepoLinks.externalUrl() : null;

    // Create the indicator
    const indicator = document.createElement('a');
    indicator.id = 'pending-draft-indicator';
    indicator.className = 'pending-draft-indicator';
    indicator.href = externalUrl || pendingDraft.github_url || '#';
    indicator.target = '_blank';
    indicator.rel = 'noopener noreferrer';
    indicator.title = `View your pending draft review on ${hostName}`;

    const commentCount = pendingDraft.comments_count || 0;
    const commentText = commentCount === 1 ? '1 comment' : `${commentCount} comments`;

    indicator.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm5.03 2.22a.75.75 0 0 1 0 1.06L5.31 6.25l1.47 1.47a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.06 0Zm2.44 0a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l1.47-1.47-1.47-1.47a.75.75 0 0 1 0-1.06Z"/>
      </svg>
      <span class="pending-draft-text">Draft on ${this.escapeHtml(hostName)} (${commentText})</span>
    `;

    // Insert after the commit element (or at the end of toolbar-meta)
    const commitElement = document.getElementById('pr-commit');
    if (commitElement && commitElement.nextSibling) {
      toolbarMeta.insertBefore(indicator, commitElement.nextSibling);
    } else {
      toolbarMeta.appendChild(indicator);
    }
  }

  /**
   * Count logical lines without allocating a large split array.
   * @param {string} text
   * @returns {number}
   */
  _countLines(text) {
    if (!text) return 0;
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lines++;
    }
    return lines;
  }

  /**
   * Return cached size metrics for a patch.
   * @param {Object} file
   * @returns {{chars: number, lines: number}}
   */
  _getPatchMetrics(file) {
    if (!file) return { chars: 0, lines: 0 };
    if (file._patchMetrics) return file._patchMetrics;
    const patch = file.patch || '';
    file._patchMetrics = {
      chars: patch.length,
      lines: this._countLines(patch),
    };
    return file._patchMetrics;
  }

  /**
   * Decide how to render a file with @pierre/diffs.
   *
   * Normal-sized files get syntax highlighting. Larger files still use the
   * Pierre layout, but are forced to plain text so worker highlighting cannot
   * swamp the UI. Extremely large patches are deferred until the user opts in.
   *
   * @param {Object} file
   * @param {Object} [options]
   * @param {boolean} [options.forceRender] - Render even when above the automatic render budget
   * @returns {{usePierre: boolean, forcePlainText: boolean, deferDiff: boolean}}
   */
  _getPierreRenderDecision(file, options = {}) {
    if (!this.pierreBridge || this.pierreBridge._disabled || !file?.patch || file.binary) {
      return { usePierre: false, forcePlainText: false, deferDiff: false };
    }

    const metrics = this._getPatchMetrics(file);
    if (
      !options.forceRender &&
      (
        metrics.chars > PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_CHARS ||
        metrics.lines > PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_LINES
      )
    ) {
      return { usePierre: false, forcePlainText: true, deferDiff: true };
    }

    const exceedsFileHighlightBudget =
      metrics.chars > PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_CHARS ||
      metrics.lines > PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES;

    // Highlighting is bounded per-file (a huge file still renders as plain
    // text) and, since the CodeView migration, bounded by virtualization: only
    // mounted items are highlighted at all. There is deliberately NO shared
    // total budget — this runs for every file up front, so a pool would drain
    // in file-list order regardless of what the user views, and the verdict is
    // baked into the CodeView item with no re-highlight path. That permanently
    // downgrades files the user may actually open, to save work virtualization
    // never performs.
    const forcePlainText = !!options.forceRender || exceedsFileHighlightBudget;
    return { usePierre: true, forcePlainText, deferDiff: false };
  }

  _isPatchEligibleForContentUpgrade(file) {
    const metrics = this._getPatchMetrics(file);
    return (
      metrics.chars <= PRManager.PIERRE_UPGRADE_MAX_PATCH_CHARS &&
      metrics.lines <= PRManager.PIERRE_UPGRADE_MAX_PATCH_LINES
    );
  }

  _isContentEligibleForPierreUpgrade(oldContents, newContents) {
    const values = [oldContents, newContents].filter(v => v != null);
    return values.every(value =>
      value.length <= PRManager.PIERRE_UPGRADE_MAX_CONTENT_CHARS &&
      this._countLines(value) <= PRManager.PIERRE_UPGRADE_MAX_CONTENT_LINES
    );
  }

  _getPierreContentUpgradeFiles(files, options = {}) {
    if (!this.pierreBridge?.files) return [];
    const forceFiles = options.forceFiles || new Set();
    return files.filter(f => {
      if (!f.patch || f.binary || !this.pierreBridge.files.has(f.file)) return false;
      return forceFiles.has(f.file) || this._isPatchEligibleForContentUpgrade(f);
    });
  }

  _getChangedFile(filePath) {
    return this.changedFilesByPath?.get(filePath) || null;
  }

  async _fetchAndUpgradePierreFileContents(file, signal, options = {}) {
    if (signal?.aborted) return false;

    const reviewId = this.currentPR?.id;
    if (!reviewId || !file?.patch || file.binary) return false;
    if (this.pierreBridge?.files?.get(file.file)?.baseMetadata) return true;

    // A previous attempt already fetched and parsed these contents and then
    // deferred on pointer-over. Nothing about the pointer moving invalidates
    // them, and the baseMetadata early-out above can never cover the retry (the
    // metadata only lands on a successful upgrade), so without this cache a
    // pointer parked over a large file re-downloads and re-parses it on every
    // retry tick. The cache is dropped whenever a render replaces the abort
    // controller, so stale contents can never be published.
    const cached = this._deferredUpgradeContents?.get(file.file);
    if (cached) {
      return this._publishPierreFileContents(file, cached.oldFile, cached.newFile, signal, options);
    }

    // Use diff header metadata (not insertion/deletion counts) to determine
    // true file status. Only check before the first @@ hunk marker to avoid
    // matching code content that happens to contain these strings. If the
    // patch has no @@ marker (empty added/deleted files, mode-only changes)
    // the whole patch is header.
    const atIdx = file.patch.indexOf('@@');
    const diffHeader = atIdx === -1 ? file.patch : file.patch.substring(0, atIdx);
    const status = diffHeader.includes('new file mode') ? 'added'
      : diffHeader.includes('deleted file mode') ? 'deleted'
      : 'modified';
    let url = `/api/reviews/${reviewId}/file-contents/${encodeURIComponent(file.file)}?status=${encodeURIComponent(status)}`;
    if (file.renamedFrom) {
      url += `&oldPath=${encodeURIComponent(file.renamedFrom)}`;
    }

    try {
      const fetchOptions = signal ? { signal } : undefined;
      const resp = await fetch(url, fetchOptions);
      if (!resp.ok || signal?.aborted) return false;
      const data = await resp.json();
      if (data.tooLarge || data.binary || signal?.aborted) return false;
      if (!this._isContentEligibleForPierreUpgrade(data.oldContents, data.newContents)) return false;

      const oldFile = data.oldContents != null
        ? { name: data.oldPath || file.renamedFrom || file.file, contents: data.oldContents }
        : null;
      const newFile = data.newContents != null
        ? { name: file.file, contents: data.newContents }
        : null;

      if (!oldFile && !newFile) return false;
      await this._yieldForDiffWork(signal);
      return this._publishPierreFileContents(file, oldFile, newFile, signal, options);
    } catch (err) {
      if (err.name === 'AbortError') return false;
      console.error(`Failed to fetch file contents for ${file.file}:`, err);
      return false;
    }
  }

  /**
   * Publish already-fetched full contents to the bridge, or park them for a
   * retry when the pointer is over the file. Shared by the fetching path and
   * the deferred-retry path so both apply the same gate and the same cache
   * bookkeeping.
   * @param {Object} file - A changed_files entry
   * @param {Object|null} oldFile - { name, contents } or null
   * @param {Object|null} newFile - { name, contents } or null
   * @param {AbortSignal|null} signal
   * @param {Object} [options] - { waitForPointerIdle }
   * @returns {Promise<boolean>} true once the bridge holds the full contents
   * @private
   */
  async _publishPierreFileContents(file, oldFile, newFile, signal, options = {}) {
    if (signal?.aborted) return false;
    if (this.pierreBridge?.files?.get(file.file)?.baseMetadata) {
      this._deferredUpgradeContents?.delete(file.file);
      return true;
    }
    // Defer while the pointer is over this file. The upgrade re-renders the
    // diff (patch-only → full-contents flip) — a shadow-DOM rebuild that
    // moves the hovered gutter comment button. Landing that mid hover/click
    // under load is the dominant comment-family E2E flake ("element is not
    // stable" → 30s timeouts). Offscreen files never trip this
    // (isPointerOverFile is false) so they upgrade freely; a hovered file is
    // requeued and retried once the pointer leaves. Checked IMMEDIATELY
    // before the publish, not at batch start, so it reflects the live
    // pointer. The immediate, user-driven path (waitForPointerIdle:false,
    // e.g. jump-to-comment) upgrades now — the user asked for that expansion.
    if (options.waitForPointerIdle !== false &&
        this.pierreBridge?.isPointerOverFile?.(file.file)) {
      // Keep the contents so the retry skips the fetch + JSON parse entirely.
      if (!this._deferredUpgradeContents) this._deferredUpgradeContents = new Map();
      this._deferredUpgradeContents.set(file.file, { oldFile, newFile });
      this._deferPierreUpgrade(file);
      return false;
    }
    if (signal?.aborted) return false;
    const upgraded = await this.pierreBridge.upgradeFileContents(file.file, oldFile, newFile);
    if (upgraded) this._deferredUpgradeContents?.delete(file.file);
    return upgraded;
  }

  /**
   * Requeue a background content upgrade that was deferred because the pointer
   * was over the file. Retries after a short idle window (the pointer-over
   * check re-runs then); keeps deferring while the pointer stays, so the
   * re-render never lands mid-interaction. No-op once the file is upgraded, the
   * render was superseded, or the queue was aborted.
   * @param {Object} file - A changed_files entry
   * @private
   */
  _deferPierreUpgrade(file) {
    const signal = this._fileContentsAbort?.signal;
    if (!signal || signal.aborted) return;
    setTimeout(() => {
      // Bail if a newer render replaced the abort controller, the queue was
      // aborted, or the file upgraded some other way in the meantime.
      if (this._fileContentsAbort?.signal !== signal || signal.aborted) return;
      if (this.pierreBridge?.files?.get(file.file)?.baseMetadata) return;
      // The deferred attempt was marked completed by the drain; clear that so
      // the re-enqueue runs. Re-enqueue (not a direct drain) because the queue
      // may have drained to empty and nulled _fileContentsUpgradeState — the
      // enqueue path re-establishes a queue when one no longer exists. If the
      // pointer is still over the file, this simply defers again (bounded to
      // one retry per PIERRE_POINTER_UPGRADE_RETRY_MS until the pointer leaves).
      this._fileContentsUpgradeState?.completed?.delete(file.file);
      this._enqueuePierreContentUpgrade(file);
    }, PRManager.PIERRE_POINTER_UPGRADE_RETRY_MS);
  }

  _getOrStartPierreContentUpgrade(file, signal, options = {}) {
    if (!file?.file) return Promise.resolve(false);
    if (!this._pierreContentUpgradePromises) {
      this._pierreContentUpgradePromises = new Map();
    }
    // The immediate (user-driven) and background paths are keyed separately ON
    // PURPOSE. Do NOT merge them into one key: sharing the background promise
    // would make an immediate, user-driven upgrade inherit the background
    // path's pointer-over deferral (_deferPierreUpgrade), stalling it behind
    // idle throttling. The known cost of the split is a duplicate fetch + JSON parse
    // when navigation races an in-flight background upgrade for the same file
    // (cheap once metadata lands, thanks to the baseMetadata early-return). A
    // future improvement could piggyback on the in-flight background fetch while
    // still skipping the pointer-idle wait for the immediate path.
    const cacheKey = options.waitForPointerIdle === false
      ? `${file.file}\0immediate`
      : file.file;
    const existing = this._pierreContentUpgradePromises.get(cacheKey);
    if (existing) return existing;

    let promise;
    promise = this._fetchAndUpgradePierreFileContents(file, signal, options)
      .finally(() => {
        if (this._pierreContentUpgradePromises.get(cacheKey) === promise) {
          this._pierreContentUpgradePromises.delete(cacheKey);
        }
      });
    this._pierreContentUpgradePromises.set(cacheKey, promise);
    return promise;
  }

  async _ensurePierreContentUpgrade(filePath) {
    const fileState = this.pierreBridge?.files?.get(filePath);
    if (!fileState) return false;
    if (fileState.baseMetadata) return true;

    const file = this._getChangedFile(filePath);
    if (!file?.patch || file.binary) return false;

    this._prioritizePierreContentUpgrade(filePath);
    await this._getOrStartPierreContentUpgrade(file, this._fileContentsAbort?.signal || null, {
      waitForPointerIdle: false,
    });
    return !!this.pierreBridge?.files?.get(filePath)?.baseMetadata;
  }

  _yieldForDiffWork(signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => resolve();
      if (typeof window !== 'undefined' && window.requestIdleCallback) {
        window.requestIdleCallback(done, { timeout: 200 });
      } else {
        setTimeout(done, 16);
      }
    });
  }

  _startFileContentUpgradeQueue(files, worker, signal) {
    if (signal.aborted || this._fileContentsAbort?.signal !== signal) return;
    const state = {
      pending: [...files],
      inFlight: new Set(),
      completed: new Set(),
      active: 0,
      worker,
      signal,
    };
    this._fileContentsUpgradeState = state;
    this._drainFileContentUpgradeQueue(state);
  }

  _drainFileContentUpgradeQueue(state) {
    if (!state || state !== this._fileContentsUpgradeState || state.signal.aborted) return;

    const concurrency = Math.max(1, PRManager.PIERRE_UPGRADE_CONCURRENCY);
    while (!state.signal.aborted && state.active < concurrency && state.pending.length > 0) {
      const file = state.pending.shift();
      if (!file || state.completed.has(file.file) || state.inFlight.has(file.file)) continue;

      state.active++;
      state.inFlight.add(file.file);
      Promise.resolve()
        .then(() => state.worker(file))
        .catch(err => {
          console.error(`Failed to upgrade file contents for ${file.file}:`, err);
        })
        .finally(async () => {
          state.inFlight.delete(file.file);
          state.completed.add(file.file);
          state.active--;
          await this._yieldForDiffWork(state.signal);
          this._drainFileContentUpgradeQueue(state);
        });
    }

    if (state.active === 0 && state.pending.length === 0 && this._fileContentsUpgradeState === state) {
      this._fileContentsUpgradeState = null;
    }
  }

  _prioritizePierreContentUpgrade(filePath) {
    const state = this._fileContentsUpgradeState;
    if (!state || state.signal.aborted || state.completed.has(filePath) || state.inFlight.has(filePath)) {
      return false;
    }

    const index = state.pending.findIndex(file => file.file === filePath);
    if (index === -1) return false;
    if (index > 0) {
      const [file] = state.pending.splice(index, 1);
      state.pending.unshift(file);
    }
    this._drainFileContentUpgradeQueue(state);
    return true;
  }

  /**
   * Render diff for the PR
   * @param {Object} pr - PR data with files
   */
  renderDiff(pr) {
    // A payload with NO file list (changed_files/files undefined or non-array)
    // means "unknown — keep the currently rendered diff", NOT an empty diff.
    // Only an explicit array (including []) is authoritative. Bail BEFORE any
    // teardown/abort so a partial refresh response (e.g. /refresh without
    // changed_files) never wipes the rendered files into the "No files changed"
    // placeholder; an explicit [] still falls through and renders it.
    if (!Array.isArray(pr?.changed_files ?? pr?.files)) return;

    // Abort any in-flight file content fetches from progressive loading
    this._fileContentsAbort?.abort();
    this._fileContentsAbort = null;
    this._fileContentsUpgradeState = null;
    this._pierreContentUpgradePromises = new Map();
    this._pierreUpgradeCandidates = null;
    // Contents parked for a pointer-deferred retry belong to the render that
    // fetched them; this render's files may differ (scope/whitespace change).
    this._deferredUpgradeContents = null;

    const diffContainer = document.getElementById('diff-container');
    if (!diffContainer) return;

    // Tear down any active tour BEFORE wiping the diff DOM: unmountAll()
    // re-collapses files the tour auto-expanded by looking them up via
    // `.d2h-file-wrapper[data-file-name=...]`. If we cleared innerHTML
    // first those lookups would all miss, and the user's pre-tour
    // collapse state would be silently lost. (Mirrors the rationale for
    // hunkSummaryRenderer.reset below — anchor-based DOM state cannot
    // survive a re-render.)
    if (this._tourIsActive && this._tourIsActive()) {
      this._exitTour();
    }

    // Clean up existing @pierre/diffs instances before clearing the container
    if (this.pierreBridge) {
      this.pierreBridge.destroyAll();
    }

    // In CodeView mode the bridge owns #diff-container (it is the virtualized
    // scroll root). destroyAll() reset the item list; a raw innerHTML wipe here
    // would tear out the CodeView scaffolding, so it is legacy-path only.
    // Per-file comment zones are cached across renders and must be reset.
    if (this._usesPierreCodeView()) {
      // Stop watching the zones about to be dropped: a detached zone can still
      // report a resize, and flushing layout for a torn-down render is noise.
      this._fileCommentZoneObserver?.disconnect();
      this._fileCommentZones = new Map();
      this._contextItemsByPath = new Map();
    } else {
      diffContainer.innerHTML = '';
    }

    // Reset hunk-summary tracking — `renderPatch` will populate this as it
    // walks each block, and we hash the records once render finishes.
    this._pendingHunkRecords = [];
    if (this.hunkSummaryRenderer) {
      this.hunkSummaryRenderer.reset();
    }
    this._tourStops = null;
    this._summaryAnchorsByHash = new Map();
    this._summaryHashesByFile = new Map();
    this._pendingSummariesByHash = new Map();
    // Reset alongside the other per-render summary state. Set true again only
    // when a summary actually mounts (see _applyHunkSummaries / the existing-
    // summary fetch). Without this, a re-render whose subsequent fetch returns
    // no matching rows keeps the stale `true`, leaving the toolbar stuck in
    // Hide/Show mode with nothing in the DOM and blocking click-to-generate.
    this._summariesGenerated = false;
    // Reset alongside `_summariesGenerated`. Set true again only when a fetch
    // (or WS event) accepts/queues a non-trivial summary for this render.
    this._summariesAvailable = false;
    // Bump generation so any in-flight `_fetchHunkSummaryMap` from the
    // previous render bails out instead of mutating maps we just reset.
    this._renderGen = (this._renderGen || 0) + 1;

    // Reset lazy-body state and (re)create the IntersectionObserver. The
    // `innerHTML = ''` above detached every previously-observed body, so a
    // stale observer would hold dead references and never fire — tear it down
    // and start fresh for this render generation. This runs for every render
    // path (initial load, whitespace toggle, scope change) since they all
    // funnel through renderDiff().
    // Lazy-body observer machinery is legacy-only; CodeView virtualizes bodies
    // natively (only visible items mount), so no IntersectionObserver is needed.
    this._teardownFileBodyObserver();
    this._lazyFileBodies = new Map();
    if (!this._usesPierreCodeView()) {
      this._fileBodyObserver = this._createFileBodyObserver();
    }

    // Use changed_files array from API
    const files = pr.changed_files || pr.files || [];
    this.changedFilesByPath = new Map(files.map(file => [file.file, file]));

    // Collect generated files info before rendering
    if (files.length > 0) {
      files.forEach(file => {
        if (file.generated) {
          this.generatedFiles.set(file.file, {
            insertions: file.insertions,
            deletions: file.deletions
          });
        }
      });
    }

    // Parse each file's diff
    if (this._usesPierreCodeView()) {
      // Single-CodeView path: hand the whole ordered file list to the bridge,
      // which builds one virtualized item per file. No per-file wrappers, no
      // lazy observer — CodeView mounts only what is on screen.
      this._renderDiffWithCodeView(files);
    } else if (files.length > 0) {
      files.forEach(file => {
        const fileWrapper = this.renderFileDiff(file);
        if (fileWrapper) {
          diffContainer.appendChild(fileWrapper);
        }
      });

      // NOTE: end-of-file gap validation runs per-file inside _renderFileBodyNow
      // now (legacy bodies render lazily), not once globally here.

      // Measure the now-rendered sticky file header so navigation can offset
      // targets below it (scroll-margin-top in pr.css).
      this._measureFileHeaderHeight();
    } else {
      diffContainer.innerHTML = '<div class="no-diff">No files changed</div>';
    }

    // Load context files after diff is rendered
    this.contextFiles = [];
    this.loadContextFiles();

    // Fetch hunk summaries (Phase 5). Fire-and-forget — the diff is fully
    // usable while summaries arrive asynchronously. Anchors are wired lazily
    // as each file body renders (_registerHunkAnchorsForFile); this just loads
    // the server's summary map and applies it to whatever has rendered so far.
    if (this.hunkSummaryRenderer) {
      this._fetchHunkSummaryMap().catch((err) => {
        console.warn('[HunkSummary] summary fetch failed:', err);
      });
    }

    // Probe tour endpoint after diff is rendered. `currentPR.id` is now
    // set (init()/LocalManager populates it before calling renderDiff),
    // so the toolbar button can reflect the right state.
    if (this._toursEnabled === true) {
      this._loadAndStashTour().catch(() => {});
    }
  }

  /**
   * Progressively fetch full file contents and upgrade Pierre-rendered files
   * to enable hunk expansion. Eligible files flow through one bounded idle
   * queue, and sidebar navigation can move a file to the front of the queue.
   *
   * Under the single-CodeView render path every changed file enters
   * pierreBridge.files up front (renderAll), so we record the eligible-by-size
   * candidate set + the abort signal here and a delayed catch-up sweep enqueues
   * each candidate through the de-duping _enqueuePierreContentUpgrade.
   * @param {Array} files - The sorted changed_files array
   */
  _upgradeFilesWithContents(files) {
    if (!this.pierreBridge || this.pierreBridge._disabled) return;

    const reviewId = this.currentPR?.id;
    if (!reviewId) return;

    const controller = new AbortController();
    this._fileContentsAbort = controller;
    const signal = controller.signal;
    // New controller = new render generation; drop any contents parked by the
    // previous one (see _publishPierreFileContents).
    this._deferredUpgradeContents = null;

    this._pierreUpgradeCandidates = new Set(
      files
        .filter(f => f.patch && !f.binary && this._isPatchEligibleForContentUpgrade(f))
        .map(f => f.file)
    );
    if (this._pierreUpgradeCandidates.size === 0) return;

    const scheduleUpgrade = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
    setTimeout(() => scheduleUpgrade(() => {
      if (signal.aborted || this._fileContentsAbort?.signal !== signal) return;
      // Enqueue every eligible candidate; all files are already in
      // pierreBridge.files under the CodeView render path.
      for (const file of this._getPierreContentUpgradeFiles(files)) {
        this._enqueuePierreContentUpgrade(file);
      }
    }), PRManager.PIERRE_BACKGROUND_UPGRADE_DELAY_MS);
  }

  /**
   * Enqueue a single (now-rendered) Pierre file for background content upgrade,
   * reusing the in-flight bounded queue when one exists so the concurrency cap
   * is honored and nothing is double-scheduled. Called from the delayed
   * catch-up sweep in _upgradeFilesWithContents.
   * @param {Object} file - A changed_files entry
   */
  _enqueuePierreContentUpgrade(file) {
    if (!file?.patch || file.binary) return;
    if (!this._pierreUpgradeCandidates?.has(file.file)) return;
    const signal = this._fileContentsAbort?.signal;
    if (!signal || signal.aborted) return;

    const worker = (f) => this._getOrStartPierreContentUpgrade(f, signal);
    const state = this._fileContentsUpgradeState;
    if (state && state.signal === signal && !signal.aborted) {
      if (state.completed.has(file.file) || state.inFlight.has(file.file)) return;
      if (state.pending.some(f => f.file === file.file)) return;
      state.pending.push(file);
      this._drainFileContentUpgradeQueue(state);
      return;
    }
    // No live queue (initial enqueue, or the previous one drained empty). Start
    // a fresh one seeded with this file; subsequent enqueues reuse it above.
    this._startFileContentUpgradeQueue([file], worker, signal);
  }

  /**
   * True when diffs render through the single-CodeView bridge path (the bridge
   * is present and enabled). When false, the legacy per-file table path runs.
   * @returns {boolean}
   */
  _usesPierreCodeView() {
    return !!(this.pierreBridge && !this.pierreBridge._disabled);
  }

  /**
   * Build the ordered CodeView entry list for the whole changed-file set and
   * hand it to the bridge in one call. Replaces the per-file renderFileDiff
   * loop + IntersectionObserver on the CodeView path.
   * @param {Array<Object>} files - changed_files entries
   * @private
   */
  _renderDiffWithCodeView(files) {
    const diffContainer = document.getElementById('diff-container');
    if (!diffContainer) return;

    const entries = [];
    for (const file of files || []) {
      const isGenerated = file.generated || this.generatedFiles.has(file.file);
      const isViewed = this.viewedFiles.has(file.file);
      const isCollapsed = isGenerated || isViewed || this.collapsedFiles.has(file.file);

      if (file.binary) {
        entries.push({
          id: file.file,
          type: 'binary',
          fileName: file.file,
          collapsed: isCollapsed,
          binaryMessage: 'Binary file not shown',
        });
        continue;
      }

      // `_getPierreRenderDecision` decides plain-text vs highlighted from the
      // per-file caps. Under CodeView there is no deferral (virtualization
      // already bounds work), so a `deferDiff` verdict just means "render
      // plain-text" — the cap's intent is preserved.
      const decision = this._getPierreRenderDecision(file);
      entries.push({
        id: file.file,
        type: 'diff',
        fileName: file.file,
        patch: file.patch || null,
        collapsed: isCollapsed,
        forcePlainText: decision.forcePlainText || decision.deferDiff,
      });
    }

    this.pierreBridge.renderAll(diffContainer, entries, {
      renderHeader: (fileName, ctx) => {
        const id = ctx?.item?.id;
        if (typeof id === 'string' && id.startsWith('context:')) {
          return this._buildContextFileHeader(fileName);
        }
        return this._buildPierreFileHeader(fileName);
      },
      // Domain host classes reconciled by the bridge on every (re)mount and
      // stripped on recycle. `collapsed`/`context-file` are bridge-derived;
      // these are the pr.js-owned ones (generated + summaries-hidden).
      hostClasses: (fileName, itemType) => this._pierreHostClasses(fileName, itemType),
    });

    // File-comments zones live in the scrolling body as lineNumber:0 (file-
    // level) annotations, out of the sticky header region. Register the renderer
    // and anchor one per file so the header comment button has a zone to write
    // into and existing file comments render.
    this._ensurePierreFileCommentsRenderer();
    for (const file of files || []) {
      this.pierreBridge.addAnnotation(file.file, {
        type: 'file-comments',
        side: this._pierreFileAnnotationSide(file),
        lineNumber: 0,
        id: `file-comments:${file.file}`,
        data: { file: file.file },
      });
    }

    // Every file is registered in the bridge immediately (renderAll), so wire
    // hunk-summary anchors for all of them now. There is no per-body render
    // hook under CodeView, so drive it here or summaries never mount.
    for (const file of files || []) {
      if (file.binary || !file.patch) continue;
      this._registerPierreHunkAnchorsForFile(file);
    }

    // Header markup lives in each item's light DOM; measure the first one for
    // scroll-margin offsets once a frame has painted, then feed the real header,
    // line-row and hunk-separator heights to CodeView so its item-height
    // estimates (and off-screen line reservation) match what actually renders.
    requestAnimationFrame(() => {
      this._measureFileHeaderHeight();
      this._syncCodeViewItemMetrics();
    });

    // Empty diff: the "No files changed" placeholder lives only in the legacy
    // render branch, so an empty CodeView render left the pane blank. CodeView
    // owns #diff-container (an innerHTML wipe would tear out its scaffolding and
    // _ensureCodeView's same-root early-return would not restore it), so toggle
    // a sibling message element the render explicitly adds/removes instead.
    this._togglePierreEmptyPlaceholder(diffContainer, (files || []).length === 0);
  }

  /**
   * Show or remove the "No files changed" placeholder alongside the CodeView
   * scroll root without disturbing the vendor's own container child.
   * @private
   */
  _togglePierreEmptyPlaceholder(container, show) {
    if (!container) return;
    let placeholder = container.querySelector(':scope > .no-diff');
    if (show) {
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'no-diff';
        placeholder.textContent = 'No files changed';
        container.appendChild(placeholder);
      }
    } else if (placeholder) {
      placeholder.remove();
    }
  }

  /**
   * The pr.js-owned domain classes to stamp on a CodeView item's host. The
   * bridge derives d2h-file-wrapper/context-file/collapsed itself; these are
   * the state-driven ones it can't know. Recomputed on every (re)mount so the
   * host reflects live generated / summaries-hidden state, and never carries a
   * recycled host's stale classes.
   * @param {string} fileName
   * @param {string} itemType - 'diff' | 'binary' | 'context'
   * @returns {string[]}
   * @private
   */
  _pierreHostClasses(fileName, itemType) {
    if (itemType === 'context') return []; // generated/summaries don't apply
    const classes = [];
    if (this.generatedFiles.has(fileName) || this._getChangedFile(fileName)?.generated) {
      classes.push('generated-file');
    }
    if (this.summariesHiddenFiles?.has(fileName)) {
      classes.push('summaries-hidden-file');
    }
    return classes;
  }

  /**
   * Build the header element for a diff/binary file in the CodeView path. Wraps
   * the shared header parts (+ file-comments zone) in a single element so it can
   * be returned from CodeView's renderCustomHeader callback. Rebuilt on every
   * virtualization remount, so it reads live collapse/viewed state each call.
   * @param {string} fileName
   * @returns {HTMLElement|null}
   * @private
   */
  /**
   * Get (creating + caching) the per-file file-comments zone. Shared by the
   * header button wiring and the CodeView 'file-comments' annotation renderer
   * so both reference the SAME element (state — open form, indicator — is
   * preserved across virtualization remounts). Cache is reset each renderDiff.
   * @param {string} fileName
   * @returns {HTMLElement|null}
   * @private
   */
  _getOrCreateFileCommentsZone(fileName) {
    if (!this.fileCommentManager) return null;
    if (!this._fileCommentZones) this._fileCommentZones = new Map();
    let zone = this._fileCommentZones.get(fileName);
    if (!zone) {
      zone = this.fileCommentManager.createFileCommentsZone(fileName);
      this._fileCommentZones.set(fileName, zone);
      this._observeFileCommentZoneSize(zone);
    }
    return zone;
  }

  /**
   * Flush the CodeView scroll extent whenever a file-comments zone changes height.
   *
   * The vendor re-measures the item on its own (its ResizeObserver parents every
   * rendered item), but it only pushes the new height into the scrollable
   * container during a render pass — so after a form opens, the DOM scroll extent
   * stays short by the form's height until something else happens to render.
   * Measured: extent 1216px against the vendor's own 1430px. The user cannot
   * scroll into that gap, which is what puts Save out of reach on a last file
   * whose body already fills the viewport. See PierreBridge.syncScrollExtent.
   *
   * The zone's DOM is mutated from a dozen places that never touch the bridge
   * (form open/cancel, card insert/delete, the adopt-suggestion form, the
   * minimizer's expand toggle), so observing the element covers all of them at
   * once. One observer for every zone; zones are cached per file and re-slotted
   * across virtualization remounts, so each is observed exactly once, and
   * renderDiff disconnects when it drops the cache. The requested render is
   * queued, so a burst of resizes collapses into one flush per frame.
   *
   * LINE-level comment forms deliberately get no equivalent, but the reason is
   * CONDITIONAL and worth stating precisely. Their textarea autogrow self-heals
   * only when the growth pushes the CARET out of view: the browser then scrolls
   * the container to keep it visible, and any scroll renders. Measured
   * 2026-07-30 on the tall fixture — extent tracked the form exactly (+334px for
   * +334px) via 2 caret-driven scrolls, Save reachable, observation on or off.
   * When the caret stays visible no scroll happens, nothing renders, and the
   * extent gap is real but RECOVERABLE (measured holding at 1431px for 10s under
   * saturation, and closed by any later scroll). The unrecoverable shape is
   * growth that does not move the caret while the root is already at max scroll —
   * an error banner, a preview toggle, a paste that wraps within view. No such
   * affordance exists today; whoever adds one must extend this observer to the
   * cached line-form elements. See the KNOWN GAP note above the autogrow test in
   * tests/e2e/codeview-behaviors.spec.js.
   * @param {HTMLElement} zone
   * @private
   */
  _observeFileCommentZoneSize(zone) {
    if (!zone || !this._usesPierreCodeView() || typeof ResizeObserver === 'undefined') return;
    if (!this._fileCommentZoneObserver) {
      this._fileCommentZoneObserver = new ResizeObserver(() => {
        this.pierreBridge?.syncScrollExtent();
      });
    }
    this._fileCommentZoneObserver.observe(zone);
  }

  /**
   * Register the CodeView 'file-comments' annotation renderer once. The zone is
   * rendered as a lineNumber:0 (file-level) annotation in each item's scrolling
   * body — out of the sticky header region — returning the same cached zone the
   * header comment button writes into.
   * @private
   */
  _ensurePierreFileCommentsRenderer() {
    if (this._pierreFileCommentsRendererReady || !this.pierreBridge) return;
    this.pierreBridge.registerAnnotationRenderer('file-comments', (_data, _id, fileName) => {
      return this._getOrCreateFileCommentsZone(fileName) || undefined;
    });
    this._pierreFileCommentsRendererReady = true;
  }

  /**
   * The diff side to anchor a file-level (lineNumber:0) annotation on. The
   * vendor requires additions for a 'new' file and deletions for a 'deleted'
   * file; anything else accepts either, so default to RIGHT.
   * @param {Object} file - changed_files entry
   * @returns {'LEFT'|'RIGHT'}
   * @private
   */
  _pierreFileAnnotationSide(file) {
    // GitHub Pulls API reports deleted files with status 'removed', and its
    // patch STARTS at the first @@ (no `deleted file mode` git header), so the
    // header sniff below never fires in PR mode. Prefer the explicit status;
    // fall back to the patch header for Local mode (git diff carries the header).
    if (file?.status === 'removed') return 'LEFT';
    const patch = file?.patch || '';
    const atIdx = patch.indexOf('@@');
    const head = atIdx === -1 ? patch : patch.slice(0, atIdx);
    return head.includes('deleted file mode') ? 'LEFT' : 'RIGHT';
  }

  _buildPierreFileHeader(fileName) {
    const file = this._getChangedFile(fileName) || { file: fileName };
    const isGenerated = file.generated || this.generatedFiles.has(fileName);
    const isViewed = this.viewedFiles.has(fileName);
    // Collapse truth comes from the bridge item once rendered; fall back to the
    // seed computation for the very first build.
    const fileState = this.pierreBridge?.files?.get(fileName);
    const isCollapsed = fileState
      ? !!fileState.collapsed
      : (isGenerated || isViewed || this.collapsedFiles.has(fileName));

    // Only the header row goes in the sticky custom header. The file-comments
    // zone is rendered separately as a lineNumber:0 body annotation (see
    // _renderDiffWithCodeView) so it scrolls with the diff instead of sticking
    // — the legacy `.d2h-file-header { position: sticky }` used to slide over
    // the zone and intercept its comment-card buttons. _buildDiffFileHeaderParts
    // still creates/caches the zone and wires the header comment button to it.
    const { header } = this._buildDiffFileHeaderParts(file, {
      isGenerated, isViewed, isCollapsed, wrapper: null,
    });

    const container = document.createElement('div');
    container.className = 'pierre-file-header-wrap';
    container.appendChild(header);
    return container;
  }

  /**
   * Build the file header element and its file-comments zone. Shared by the
   * legacy renderFileDiff path and the CodeView renderCustomHeader factory.
   *
   * The header carries the collapse chevron, viewed checkbox, stats, and the
   * file comment / chat / per-file summary buttons. The comments zone is cached
   * per file (this._fileCommentZones) so it survives CodeView virtualization
   * remounts with any open comment form / indicator state intact.
   *
   * @param {Object} file - changed_files entry (needs `.file`)
   * @param {Object} opts - { isGenerated, isViewed, isCollapsed, wrapper }
   * @returns {{ header: HTMLElement, commentsZone: HTMLElement|null }}
   * @private
   */
  _buildDiffFileHeaderParts(file, opts = {}) {
    const { isGenerated, isViewed, isCollapsed, wrapper } = opts;
    const fileStats = {
      insertions: file.insertions || 0,
      deletions: file.deletions || 0,
    };

    const header = window.DiffRenderer.createFileHeader(file.file, {
      isGenerated,
      isExpanded: !isCollapsed,
      isViewed,
      generatedInfo: isGenerated ? this.generatedFiles.get(file.file) : null,
      fileStats,
      renamed: file.renamed || false,
      renamedFrom: file.renamedFrom || null,
      onToggleCollapse: (path) => this.toggleFileCollapse(path),
      onToggleViewed: (path, checked) => this.toggleFileViewed(path, checked),
    });

    let commentsZone = null;
    if (this.fileCommentManager) {
      // Reuse a cached zone per file so its state (open form, indicator)
      // survives remounts on the CodeView path. Legacy path has no cache map
      // (each render rebuilds), so create fresh there.
      if (this._usesPierreCodeView()) {
        commentsZone = this._getOrCreateFileCommentsZone(file.file);
      } else {
        commentsZone = this.fileCommentManager.createFileCommentsZone(file.file);
      }

      const fileCommentBtn = document.createElement('button');
      fileCommentBtn.className = 'file-header-comment-btn';
      fileCommentBtn.title = 'Add file comment';
      fileCommentBtn.dataset.file = file.file;
      fileCommentBtn.innerHTML = `
        <svg class="comment-icon-outline" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.5 0v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25H2.75a.25.25 0 0 0-.25.25Z"/>
        </svg>
        <svg class="comment-icon-filled" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display:none">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5Z"/>
        </svg>
      `;
      fileCommentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.fileCommentManager.showCommentForm(commentsZone, file.file);
      });
      header.appendChild(fileCommentBtn);
      commentsZone.headerButton = fileCommentBtn;
      // The button is rebuilt outline-only on every (re)mount; the cached zone
      // survives virtualization and still holds its cards, so refresh the icon
      // from the zone's current count or a file with comments shows the empty
      // outline after scrolling out and back.
      this.fileCommentManager.updateCommentCount(commentsZone);

      const fileChatBtn = document.createElement('button');
      fileChatBtn.className = 'file-header-chat-btn';
      fileChatBtn.title = 'Chat about file';
      fileChatBtn.dataset.file = file.file;
      fileChatBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
        </svg>
      `;
      fileChatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.chatPanel) {
          window.chatPanel.open({ fileContext: { file: file.file } });
        }
      });
      header.appendChild(fileChatBtn);

      if (this._summariesEnabled !== false) {
        const summaryToggleBtn = document.createElement('button');
        summaryToggleBtn.className = 'file-header-summary-toggle';
        summaryToggleBtn.dataset.file = file.file;
        summaryToggleBtn.innerHTML = `
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z"/>
          </svg>
        `;

        if (this._summariesEnabled !== true) {
          summaryToggleBtn.classList.add('summary-toggle-pending');
          summaryToggleBtn.style.display = 'none';
        }

        const fileIsHidden = this.summariesHiddenFiles?.has(file.file) || false;
        if (fileIsHidden && wrapper) {
          wrapper.classList.add('summaries-hidden-file');
        }
        this._syncFileSummaryToggleButton(summaryToggleBtn, file.file);

        summaryToggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleFileSummaries(file.file, wrapper || this.findFileElement(file.file));
        });
        header.appendChild(summaryToggleBtn);
      }
    }

    return { header, commentsZone };
  }

  /**
   * Render diff for a single file
   * @param {Object} file - File data
   * @returns {HTMLElement} File wrapper element
   */
  renderFileDiff(file) {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = file.file;

    // Check if this is a generated file
    const isGenerated = file.generated || this.generatedFiles.has(file.file);
    // Determine initial collapse state:
    // - Generated files start collapsed
    // - Files marked as viewed start collapsed
    // - Files in collapsedFiles set are collapsed
    const isViewed = this.viewedFiles.has(file.file);
    const isCollapsed = isGenerated || isViewed || this.collapsedFiles.has(file.file);

    if (isGenerated) {
      wrapper.classList.add('generated-file');
    }
    if (isCollapsed) {
      wrapper.classList.add('collapsed');
    }

    // Get file stats for collapsed view
    const fileStats = {
      insertions: file.insertions || 0,
      deletions: file.deletions || 0
    };

    // Build the file header (+ file-comments zone). Shared with the CodeView
    // render path via _buildPierreFileHeader so both render identical headers.
    const { header, commentsZone } = this._buildDiffFileHeaderParts(file, {
      isGenerated, isViewed, isCollapsed, wrapper,
    });
    wrapper.appendChild(header);
    if (commentsZone) wrapper.appendChild(commentsZone);

    // Old table-based rendering (used when PierreBridge is not
    // available). Created with an EMPTY tbody — the rows are NOT rendered
    // here; see the lazy-body machinery below. This is the core large-PR
    // perf fix: building + syntax-highlighting every line of every (often
    // collapsed) file up front froze the browser on big diffs.
    const table = document.createElement('table');
    table.className = 'd2h-diff-table';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    // Wrap table in a scrollable container for horizontal scroll of long code lines
    // (parent elements use overflow:visible to support sticky file headers)
    const fileBody = document.createElement('div');
    fileBody.className = 'd2h-file-body';
    fileBody.appendChild(table);
    wrapper.appendChild(fileBody);

    // Reserve approximate height for EXPANDED-but-not-yet-rendered bodies so
    // the scrollbar stays roughly stable as the user scrolls and bodies fill
    // in. Collapsed bodies are `display:none`, so they contribute no height
    // and need no placeholder. Cleared once the body actually renders.
    if (!isCollapsed && file.patch) {
      const approxLines = file.patch.split('\n').length;
      fileBody.style.minHeight = (approxLines * PRManager.APPROX_DIFF_LINE_PX) + 'px';
    }

    // Register the lazy entry. `gen` lets _renderFileBodyNow detect a body
    // left over from a superseded render and skip anchor registration.
    this._lazyFileBodies.set(file.file, {
      fileName: file.file,
      patch: file.patch || null,
      binary: !!file.binary,
      hunkHashes: file.hunk_hashes || null,
      fileBody,
      wrapper,
      rendered: false,
      renderPromise: null,
      gen: this._renderGen
    });

    // Observe the body so it renders as it nears the viewport. Collapsed
    // bodies (display:none) never intersect → stay unrendered until expanded.
    if ((file.patch || file.binary) && this._fileBodyObserver) {
      this._fileBodyObserver.observe(fileBody);
    }

    return wrapper;
  }

  /**
   * Approximate rendered height (px) of one diff line row. Used only to
   * reserve placeholder height for expanded-but-unrendered file bodies so the
   * scrollbar doesn't jump as lazy bodies fill in. Errs slightly high.
   */
  static get APPROX_DIFF_LINE_PX() { return 20; }

  /**
   * Create the IntersectionObserver that renders file bodies as they approach
   * the viewport. One instance per render generation; recreated in renderDiff.
   * Returns null where IntersectionObserver is unavailable (e.g. jsdom unit
   * tests) — bodies then render only on demand via ensureFileBodyRendered().
   * @returns {IntersectionObserver|null}
   */
  _createFileBodyObserver() {
    if (typeof IntersectionObserver === 'undefined') return null;
    // `.diff-view` is the vertical scroll container (see pr.css). Fall back to
    // the viewport when it can't be resolved.
    const root = document.querySelector('.diff-view') || null;
    return new IntersectionObserver((entries, observer) => {
      for (const ioEntry of entries) {
        if (!ioEntry.isIntersecting) continue;
        const lazyEntry = this._lazyFileBodyForElement(ioEntry.target);
        observer.unobserve(ioEntry.target);
        if (lazyEntry) this._renderFileBodyNow(lazyEntry);
      }
    }, { root, rootMargin: '800px 0px', threshold: 0 });
  }

  /**
   * Disconnect and drop the current file-body observer, if any.
   */
  _teardownFileBodyObserver() {
    if (this._fileBodyObserver) {
      this._fileBodyObserver.disconnect();
      this._fileBodyObserver = null;
    }
  }

  /**
   * Resolve the lazy entry for a `.d2h-file-body` element via its wrapper's
   * data-file-name. Returns null if not a known lazy body.
   * @param {Element} bodyEl
   * @returns {object|null}
   */
  _lazyFileBodyForElement(bodyEl) {
    if (!this._lazyFileBodies) return null;
    const wrapper = bodyEl?.closest?.('.d2h-file-wrapper');
    const filePath = wrapper?.dataset?.fileName;
    if (!filePath) return null;
    return this._lazyFileBodies.get(filePath) || null;
  }

  /**
   * Ensure a file's diff-line body is rendered into the DOM, rendering it now
   * if it hasn't been. Idempotent and cheap when already rendered. Every code
   * path that scans a file's `<tr>` rows (comment/suggestion anchoring, gap
   * expansion, scroll-to-file, expand) must await this first, because a lazy
   * body has zero rows until rendered.
   * @param {string|Element} fileOrWrapper - file path, file body, or wrapper
   * @returns {Promise<HTMLElement|null>} the file body, or null if unknown
   */
  async ensureFileBodyRendered(fileOrWrapper) {
    // No lazy map (e.g. called before renderDiff, or a non-lazy render path) →
    // treat the body as already present and let callers scan as before.
    if (!this._lazyFileBodies) return null;
    let entry = null;
    if (typeof fileOrWrapper === 'string') {
      entry = this._lazyFileBodies.get(fileOrWrapper) || null;
      if (!entry) {
        // The map is keyed by the canonical `file.file` value, but callers
        // (AI suggestions, external comments, tour stops) may pass a
        // non-canonical path form. findFileElement normalizes './', '/', and
        // git rename syntax ('{old => new}') against data-file-name, so
        // resolve the wrapper first and retry with its canonical name. This
        // keeps the strict Map.get fast path while tolerating the same path
        // variants the rest of the diff UI accepts — without it the body
        // stays unrendered and the downstream row scan sees zero <tr> rows.
        const wrapper = this.findFileElement?.(fileOrWrapper);
        const canonicalFile = wrapper?.dataset?.fileName;
        if (canonicalFile) entry = this._lazyFileBodies.get(canonicalFile) || null;
      }
    } else if (fileOrWrapper && fileOrWrapper.nodeType === 1) {
      entry = this._lazyFileBodyForElement(fileOrWrapper)
        || (this._lazyFileBodies.get(fileOrWrapper.dataset?.fileName) || null);
    }
    if (!entry) return null;
    if (entry.rendered) return entry.fileBody;
    if (entry.renderPromise) return entry.renderPromise;
    // _renderFileBodyNow is synchronous; wrapping in a resolved promise keeps
    // the signature async and lets concurrent callers (observer + on-demand)
    // share one promise so renderPatch runs exactly once.
    entry.renderPromise = Promise.resolve().then(() => this._renderFileBodyNow(entry));
    return entry.renderPromise;
  }

  /**
   * Synchronously build a file's diff-line body: run renderPatch (or the
   * binary placeholder), clear the height placeholder, wire hunk-summary
   * anchors, and validate this file's EOF gap. Idempotent.
   *
   * Invariant: there must be NO `await` between the `_pendingHunkRecords`
   * save and restore below — renderPatch pushes per-hunk anchor records into
   * the shared `_pendingHunkRecords`, and JS single-threading only guarantees
   * non-interleaving with other file renders while this stays synchronous.
   * @param {object} entry - a _lazyFileBodies value
   * @returns {HTMLElement} the file body element
   */
  _renderFileBodyNow(entry) {
    if (entry.rendered) return entry.fileBody;
    if (this._fileBodyObserver) this._fileBodyObserver.unobserve(entry.fileBody);

    const tbody = entry.fileBody.querySelector('tbody');

    // Capture only THIS file's hunk anchor records (renderPatch appends to
    // this._pendingHunkRecords; see invariant above). The swap is wrapped in
    // try/finally so a renderPatch throw can't leak the temporary buffer: were
    // the restore skipped, every subsequent file render would append its
    // anchor records into the stale array, silently cross-wiring
    // _summaryAnchorsByHash / _summaryHashesByFile for the rest of the session.
    const prevPending = this._pendingHunkRecords;
    this._pendingHunkRecords = [];
    let records;
    try {
      if (entry.patch && tbody) {
        this.renderPatch(tbody, entry.patch, entry.fileName, entry.hunkHashes);
      } else if (entry.binary && tbody) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="2" class="binary-file">Binary file</td>';
        tbody.appendChild(row);
      }
    } finally {
      records = this._pendingHunkRecords;
      this._pendingHunkRecords = prevPending;
    }

    entry.fileBody.style.minHeight = '';
    entry.rendered = true;
    entry.renderPromise = null;

    // Skip post-render wiring for a body left over from a superseded render
    // (its maps were reset and the body is detached). Both anchor registration
    // and EOF-gap validation are pointless/wasteful for a stale body.
    if (entry.gen === this._renderGen) {
      this._registerHunkAnchorsForFile(records);
      // Validate this file's pending EOF gaps. Pre-lazy-render this was a
      // single global pass at the end of renderDiff; now it runs per-file as
      // bodies render. Cheap pre-check first: most files have no pending EOF
      // gap, so skip the async work (Array.from + Promise.all + per-gap
      // /file-content fetches) entirely when this body has none. The selector
      // mirrors the one validatePendingEofGaps scans for.
      if (entry.fileBody.querySelector('tr.context-expand-row[data-pending-eof-validation="true"]')) {
        // Keep the in-flight promise on the entry. Until it resolves, the
        // trailing EOF gap still carries EOF_SENTINEL coords, which makes
        // findMatchingGap()'s overlap test unmatchable for a real target line.
        // Line-anchoring callers (expandForSuggestion) await this so a
        // suggestion/comment on a trailing unchanged line doesn't silently fail
        // to expand. Fire-and-forget for everyone else.
        entry.eofValidationPromise = this.validatePendingEofGaps(entry.fileBody);
      }
    }

    return entry.fileBody;
  }

  /**
   * Parse and render a unified diff patch
   * @param {HTMLElement} tbody - Table body element
   * @param {string} patch - Unified diff patch string
   * @param {string} fileName - File name
   * @param {string[]|null} [hunkHashes] - Per-hunk content hashes parallel
   *   to the order `parseDiffIntoBlocks` returns hunks. When supplied, these
   *   are used instead of computing client-side hashes. Computed by the
   *   backend from the canonical (non-whitespace-filtered) diff so they
   *   stay aligned with persisted summary keys.
   */
  renderPatch(tbody, patch, fileName, hunkHashes = null) {
    let diffPosition = 0;  // GitHub diff_position (1-indexed, consecutive)
    let prevBlockEnd = { old: 0, new: 0 };
    let isFirstHunk = true;

    const blocks = window.HunkParser.parseDiffIntoBlocks(patch);

    // Defend against length drift between server-supplied (canonical) hashes
    // and the rendered (possibly whitespace-filtered) blocks: under `?w=1`,
    // `git diff -w` can drop or merge whitespace-only hunks so the canonical
    // and rendered hunk counts diverge. Misaligned hashes would write the
    // wrong canonical hash onto every block after the first dropped hunk,
    // anchoring summaries to the wrong rendered hunk. Fail closed: drop the
    // hashes for this file. Summaries then simply won't anchor — visibly
    // missing rather than visibly wrong.
    if (Array.isArray(hunkHashes) && hunkHashes.length !== blocks.length) {
      if (!this._warnedHunkHashLengthMismatch) {
        this._warnedHunkHashLengthMismatch = true;
        console.warn(
          `[HunkSummary] hunk_hashes length mismatch for ${fileName}: ` +
          `${hunkHashes.length} canonical hashes, ${blocks.length} rendered ` +
          'blocks. Dropping hashes for this file.'
        );
      }
      hunkHashes = null;
    }

    // Render blocks with gap sections
    blocks.forEach((block, blockIndex) => {
      diffPosition++; // Hunk header counts as a position

      // Calculate gap before this block
      const blockBounds = window.HunkParser.getBlockCoordinateBounds(
        { lines: this.parseBlockLines(block) },
        'first'
      );

      const gapStartOld = prevBlockEnd.old + 1;
      const gapEndOld = (blockBounds.old ?? block.oldStart) - 1;
      const gapSize = gapEndOld - gapStartOld + 1;
      // Calculate the corresponding NEW line number for correct right-side display
      const gapStartNew = prevBlockEnd.new + 1;

      // Create gap section if there's a gap
      if (gapSize > 0 && !isFirstHunk) {
        const position = blockIndex === 0 ? 'above' : 'between';
        const gapRow = window.HunkParser.createGapSection(
          null,
          fileName,
          gapStartOld,
          gapEndOld,
          gapSize,
          position,
          (controls, direction, count) => this.expandGapContext(controls, direction, count),
          gapStartNew  // Pass NEW line number for correct right-side display
        );
        tbody.appendChild(gapRow);

        // Auto-expand small gaps
        if (window.HunkParser.shouldAutoExpand(gapSize)) {
          setTimeout(() => this.expandGapContext(gapRow.expandControls, 'all', gapSize), 0);
        }
      } else if (gapSize > 0 && isFirstHunk) {
        // Create "expand up" section at file start
        // For the gap before the first hunk, lines are unchanged context starting at line 1.
        // Both OLD and NEW versions start at line 1, but the gap may have different sizes
        // if the first hunk doesn't start at the same position in both versions.
        //
        // Example: @@ -10,5 +12,7 @@ means:
        //   - OLD gap covers lines 1-9 (gapEndOld = 10 - 1 = 9)
        //   - NEW gap covers lines 1-11 (gapEndNew = 12 - 1 = 11)
        //
        // This is a non-uniform offset case: both start at 1, but end at different lines.
        // We use endLineNew to specify the NEW end explicitly.
        const gapEndNew = block.newStart - 1;
        const gapRow = window.HunkParser.createGapSection(
          null,
          fileName,
          1,         // OLD starts at line 1
          gapEndOld, // OLD ends before hunk.oldStart
          gapEndOld, // gapSize based on OLD lines
          'above',
          (controls, direction, count) => this.expandGapContext(controls, direction, count),
          1          // NEW also starts at line 1
        );
        // Set endLineNew explicitly for correct NEW range in findMatchingGap
        gapRow.expandControls.dataset.endLineNew = gapEndNew;
        tbody.appendChild(gapRow);
      }

      isFirstHunk = false;

      // Check if we should show the hunk header
      // Skip if there was no gap AND previous block ended at adjacent line
      const shouldShowHeader = gapSize > 0 || prevBlockEnd.old === 0;

      if (shouldShowHeader) {
        // Add hunk header row
        const headerRow = window.DiffRenderer.createHunkHeaderRow(block.header);
        tbody.appendChild(headerRow);
      }

      // Parse lines in block
      let oldLineNum = block.oldStart;
      let newLineNum = block.newStart;

      let firstLineRow = null;
      block.lines.forEach(line => {
        if (!line && line !== '') return; // Skip undefined

        diffPosition++;

        let type = 'context';
        let oldNumber = null;
        let newNumber = null;

        if (line.startsWith('+')) {
          type = 'insert';
          newNumber = newLineNum++;
        } else if (line.startsWith('-')) {
          type = 'delete';
          oldNumber = oldLineNum++;
        } else {
          type = 'context';
          oldNumber = oldLineNum++;
          newNumber = newLineNum++;
        }

        const lineData = {
          type,
          oldNumber,
          newNumber,
          content: line
        };

        this.renderDiffLine(tbody, lineData, fileName, diffPosition);
        if (!firstLineRow) firstLineRow = tbody.lastElementChild;
      });

      // Record this hunk's first rendered code row as the anchor for any
      // inline summary annotation. The canonical hash comes from the
      // backend (`hunkHashes[blockIndex]`); _registerHunkAnchorsForFile mounts
      // it as `data-hunk-start` when this file's body renders so the summary
      // renderer can find the anchor and insert the annotation above it.
      if (this._pendingHunkRecords && firstLineRow) {
        const serverHash = Array.isArray(hunkHashes) ? hunkHashes[blockIndex] || null : null;
        this._pendingHunkRecords.push({
          file: fileName,
          header: block.header,
          anchorRow: firstLineRow,
          contentHash: serverHash
        });
      }

      // Update previous block end coordinates
      const endBounds = window.HunkParser.getBlockCoordinateBounds(
        { lines: this.parseBlockLines(block) },
        'last'
      );
      prevBlockEnd = {
        old: endBounds.old ?? (block.oldStart + block.lines.filter(l => !l.startsWith('+')).length - 1),
        new: endBounds.new ?? (block.newStart + block.lines.filter(l => !l.startsWith('-')).length - 1)
      };
    });

    // Add end-of-file gap section after the last hunk
    // This handles the case where there are unchanged lines after the last change
    // Use EOF_SENTINEL (-1) for endLine to indicate "rest of file" (unknown size)
    // The gap is marked as pending validation and will be removed async if no lines exist
    // Skip for new files: when gapStartOld <= 0, the old file has no content (e.g. @@ -0,0 +1,N @@)
    // so there are no trailing unchanged lines to expand
    if (blocks.length > 0 && prevBlockEnd.old > 0) {
      const gapStartOld = prevBlockEnd.old + 1;
      const gapStartNew = prevBlockEnd.new + 1;
      const gapRow = window.HunkParser.createGapSection(
        null,
        fileName,
        gapStartOld,
        window.HunkParser.EOF_SENTINEL,  // Sentinel: end of file (unknown size)
        window.HunkParser.EOF_SENTINEL,  // Sentinel: gap size unknown until file is fetched
        'below',
        (controls, direction, count) => this.expandGapContext(controls, direction, count),
        gapStartNew
      );
      // Mark for async validation - will be removed if no trailing lines exist
      gapRow.dataset.pendingEofValidation = 'true';
      tbody.appendChild(gapRow);
    }
  }

  /**
   * Parse block lines into line objects for coordinate calculation
   * @param {Object} block - Block with raw lines
   * @returns {Array} Parsed line objects
   */
  parseBlockLines(block) {
    let oldLineNum = block.oldStart;
    let newLineNum = block.newStart;

    return block.lines.map(line => {
      if (line.startsWith('+')) {
        return { newNumber: newLineNum++ };
      } else if (line.startsWith('-')) {
        return { oldNumber: oldLineNum++ };
      } else {
        return { oldNumber: oldLineNum++, newNumber: newLineNum++ };
      }
    }).filter(l => l);
  }

  /**
   * Render a single diff line - delegated to DiffRenderer
   */
  renderDiffLine(container, line, fileName, diffPosition) {
    return window.DiffRenderer.renderDiffLine(container, line, fileName, diffPosition, {
      onCommentButtonClick: (_e, row, lineNumber, file, lineData) => {
        // Handle comment button click
        const side = lineData.type === 'delete' ? 'LEFT' : 'RIGHT';

        // Check for existing line range selection
        if (this.lineTracker.hasActiveSelection() &&
            this.lineTracker.rangeSelectionStart.fileName === file) {
          // Use selection range
          const range = this.lineTracker.getSelectionRange();
          this.showCommentForm(row, range.start, file, diffPosition, range.end, range.side);
        } else {
          // Single line comment
          this.showCommentForm(row, lineNumber, file, diffPosition, null, side);
        }
      },
      onChatButtonClick: (_e, row, lineNumber, file, lineData) => {
        if (!window.chatPanel) return;
        let startLine = lineNumber;
        let endLine = null;

        if (this.lineTracker.hasActiveSelection() &&
            this.lineTracker.rangeSelectionStart.fileName === file) {
          const range = this.lineTracker.getSelectionRange();
          startLine = range.start;
          endLine = range.end;
          this.lineTracker.clearRangeSelection();
        }

        window.chatPanel.open({
          commentContext: {
            type: 'line',
            body: null,
            file: file || '',
            line_start: startLine,
            line_end: endLine || startLine,
            source: 'user'
          }
        });
      },
      onMouseOver: (_e, row, lineNumber, file) => {
        // Check if we have a potential drag start and convert it to an actual drag
        if (this.lineTracker.potentialDragStart && !this.lineTracker.isDraggingRange) {
          const start = this.lineTracker.potentialDragStart;
          // Only start drag if we've moved to a different line
          if (start.lineNumber !== lineNumber || start.fileName !== file) {
            this.lineTracker.startDragSelection(start.row, start.lineNumber, start.fileName, start.side);
          }
        }
        this.lineTracker.updateDragSelection(row, lineNumber, file);
      },
      onMouseUp: (_e, row, lineNumber, file) => {
        if (this.lineTracker.potentialDragStart) {
          const start = this.lineTracker.potentialDragStart;
          const isChat = start.isChat;
          this.lineTracker.potentialDragStart = null;

          if (start.lineNumber !== lineNumber || start.fileName !== file) {
            // Drag selection ended on a different line
            // If drag wasn't started yet (quick drag without mouseover), start it first
            if (!this.lineTracker.isDraggingRange) {
              this.lineTracker.startDragSelection(start.row, start.lineNumber, start.fileName, start.side);
            }
            this.lineTracker.completeDragSelection(row, lineNumber, file);

            // For chat drags, immediately open chat with the selected range
            if (isChat && this.lineTracker.hasActiveSelection()) {
              const range = this.lineTracker.getSelectionRange();
              this.lineTracker.clearRangeSelection();
              if (window.chatPanel) {
                window.chatPanel.open({
                  commentContext: {
                    type: 'line',
                    body: null,
                    file: file || '',
                    line_start: range.start,
                    line_end: range.end,
                    source: 'user'
                  }
                });
              }
            }
          }
        } else if (this.lineTracker.isDraggingRange) {
          this.lineTracker.completeDragSelection(row, lineNumber, file);
        }
      },
      lineTracker: this.lineTracker
    });
  }

  /**
   * Get line number from a row - delegate to LineTracker
   * @param {Element} row - Table row element
   * @param {string} [side] - Optional side ('LEFT' or 'RIGHT') to get specific coordinate system
   * @returns {number|null} The line number or null if not found
   */
  getLineNumber(row, side) {
    return this.lineTracker.getLineNumber(row, side);
  }

  /**
   * Find file element in the DOM - delegate to DiffRenderer
   */
  findFileElement(file) {
    return window.DiffRenderer.findFileElement(file);
  }

  /**
   * Toggle collapse state of a file diff
   * @param {string} filePath - Path of the file
   */
  async toggleFileCollapse(filePath) {
    // CodeView path: collapse state lives on the item, not a persistent DOM
    // class. Flip it via the bridge; the item re-renders its header (chevron)
    // and body from the new flag. Keep collapsedFiles in sync for persistence.
    if (this._usesPierreCodeView() && this.pierreBridge.files.has(filePath)) {
      const fileState = this.pierreBridge.files.get(filePath);
      const willCollapse = !fileState.collapsed;
      if (willCollapse) this.collapsedFiles.add(filePath);
      else this.collapsedFiles.delete(filePath);
      this.pierreBridge.setCollapsed(filePath, willCollapse);
      return;
    }

    const wrapper = this.findFileElement(filePath);
    if (!wrapper) return;

    const isCollapsed = wrapper.classList.contains('collapsed');
    const header = wrapper.querySelector('.d2h-file-header');

    if (isCollapsed) {
      // Render the body before revealing it (lazy bodies are empty until now).
      await this.ensureFileBodyRendered(filePath);
      wrapper.classList.remove('collapsed');
      this.collapsedFiles.delete(filePath);
    } else {
      wrapper.classList.add('collapsed');
      this.collapsedFiles.add(filePath);
    }

    // Update header state
    if (header) {
      window.DiffRenderer.updateFileHeaderState(header, !wrapper.classList.contains('collapsed'));
    }

    // Sync collapsed state with @pierre/diffs instance
    if (this.pierreBridge && this.pierreBridge.files.has(filePath)) {
      this.pierreBridge.setCollapsed(filePath, wrapper.classList.contains('collapsed'));
    }
  }

  /**
   * Toggle viewed state of a file
   * @param {string} filePath - Path of the file
   * @param {boolean} isViewed - Whether the file is now viewed
   */
  async toggleFileViewed(filePath, isViewed) {
    // CodeView path: viewed auto-collapses (and unviewed auto-expands). Drive
    // both the viewed set and the item's collapse flag through the bridge; the
    // item re-renders its header so the checkbox/chevron reflect the new state.
    if (this._usesPierreCodeView() && this.pierreBridge.files.has(filePath)) {
      if (isViewed) {
        this.viewedFiles.add(filePath);
        this.collapsedFiles.add(filePath);
        this.pierreBridge.setCollapsed(filePath, true);
      } else {
        this.viewedFiles.delete(filePath);
        this.collapsedFiles.delete(filePath);
        this.pierreBridge.setCollapsed(filePath, false);
      }
      this.updateFileItemViewedState(filePath, isViewed);
      this.saveViewedState();
      return;
    }

    const wrapper = this.findFileElement(filePath);

    if (isViewed) {
      this.viewedFiles.add(filePath);
      // Auto-collapse when marking as viewed
      if (wrapper && !wrapper.classList.contains('collapsed')) {
        wrapper.classList.add('collapsed');
        this.collapsedFiles.add(filePath);
        const header = wrapper.querySelector('.d2h-file-header');
        if (header) {
          window.DiffRenderer.updateFileHeaderState(header, false);
        }
        // Sync with @pierre/diffs
        if (this.pierreBridge && this.pierreBridge.files.has(filePath)) {
          this.pierreBridge.setCollapsed(filePath, true);
        }
      }
    } else {
      this.viewedFiles.delete(filePath);
      // Auto-expand when unchecking viewed (match GitHub behavior)
      if (wrapper && wrapper.classList.contains('collapsed')) {
        // Render the body before revealing it (lazy bodies are empty until now).
        await this.ensureFileBodyRendered(filePath);
        wrapper.classList.remove('collapsed');
        this.collapsedFiles.delete(filePath);
        const header = wrapper.querySelector('.d2h-file-header');
        if (header) {
          window.DiffRenderer.updateFileHeaderState(header, true);
        }
        // Sync with @pierre/diffs
        if (this.pierreBridge && this.pierreBridge.files.has(filePath)) {
          this.pierreBridge.setCollapsed(filePath, false);
        }
      }
    }

    // Update sidebar file row to reflect viewed state
    this.updateFileItemViewedState(filePath, isViewed);

    // Persist viewed state
    this.saveViewedState();
  }

  /**
   * Collapse/viewed state key for a context entry. Context entries share a
   * file path with a possible diff entry for the same file, so their state
   * is tracked under a namespaced key to keep the two independent.
   * @param {string} filePath - Path of the file
   * @returns {string}
   */
  _contextStateKey(filePath) {
    return `context:${filePath}`;
  }

  /**
   * Resolve a file path to the ACTUAL CodeView item id in the bridge: the diff
   * item id (plain path) when a diff item exists for it, otherwise the context
   * item id (`context:<path>`). A context-only file has NO plain-path item, so
   * any path that awaits slotting, scrolls, or hydrates a file by its plain path
   * must resolve through here or it targets a non-existent item. Returns null
   * when the bridge holds neither (unknown / legacy path).
   * @param {string} filePath
   * @returns {string|null}
   * @private
   */
  _pierreItemIdForPath(filePath) {
    const bridge = this.pierreBridge;
    if (!bridge || !bridge.files) return null;
    if (bridge.files.has(filePath)) return filePath;
    const contextId = this._contextStateKey(filePath);
    if (bridge.files.has(contextId)) return contextId;
    return null;
  }

  /**
   * Find the context-entry wrapper for a file path. Unlike findFileElement,
   * this never resolves to the diff wrapper for the same file.
   * @param {string} filePath - Path of the file
   * @returns {Element|null}
   */
  findContextFileWrapper(filePath) {
    return document.querySelector(
      `.d2h-file-wrapper.context-file[data-file-name="${CSS.escape(filePath)}"]`
    );
  }

  /**
   * Toggle collapse state of a context entry.
   *
   * Context entries must not route through toggleFileCollapse: that resolves
   * by file path, which finds the diff wrapper when the same file also has a
   * diff entry — collapsing the context entry would expand the viewed diff
   * instead (#540). Context bodies are built eagerly and are not managed by
   * the pierre bridge, so no lazy render or bridge sync is needed here.
   * @param {string} filePath - Path of the file
   */
  toggleContextFileCollapse(filePath) {
    // CodeView path: the context entry is a bridge file item, not a DOM
    // wrapper. Flip its collapse flag through the bridge (the `context:` key
    // keeps it distinct from any same-path diff entry, #540).
    if (this._usesPierreCodeView() && this.pierreBridge.hasContextFile(filePath)) {
      const key = this._contextStateKey(filePath);
      const fileState = this.pierreBridge.files.get(key);
      const willCollapse = !(fileState && fileState.collapsed);
      if (willCollapse) this.collapsedFiles.add(key);
      else this.collapsedFiles.delete(key);
      this.pierreBridge.setContextFileCollapsed(filePath, willCollapse);
      return;
    }

    const wrapper = this.findContextFileWrapper(filePath);
    if (!wrapper) return;

    const key = this._contextStateKey(filePath);
    const collapsed = wrapper.classList.toggle('collapsed');
    if (collapsed) {
      this.collapsedFiles.add(key);
    } else {
      this.collapsedFiles.delete(key);
    }

    const header = wrapper.querySelector('.d2h-file-header');
    if (header) {
      window.DiffRenderer.updateFileHeaderState(header, !collapsed);
    }
  }

  /**
   * Toggle viewed state of a context entry, independent of the diff entry
   * for the same file. Persists through the same viewedFiles storage as
   * diff entries, under the context-scoped key.
   * @param {string} filePath - Path of the file
   * @param {boolean} isViewed - Whether the context entry is now viewed
   */
  toggleContextFileViewed(filePath, isViewed) {
    // CodeView path: drive the context item's viewed/collapse state through the
    // bridge; the item re-renders its header so the checkbox/chevron update.
    if (this._usesPierreCodeView() && this.pierreBridge.hasContextFile(filePath)) {
      const ckey = this._contextStateKey(filePath);
      if (isViewed) {
        this.viewedFiles.add(ckey);
        this.collapsedFiles.add(ckey);
        this.pierreBridge.setContextFileCollapsed(filePath, true);
      } else {
        this.viewedFiles.delete(ckey);
        this.collapsedFiles.delete(ckey);
        this.pierreBridge.setContextFileCollapsed(filePath, false);
      }
      this.updateFileItemViewedState(filePath, isViewed, { contextItem: true });
      this.saveViewedState();
      return;
    }

    const wrapper = this.findContextFileWrapper(filePath);
    const key = this._contextStateKey(filePath);
    const header = wrapper ? wrapper.querySelector('.d2h-file-header') : null;

    if (isViewed) {
      this.viewedFiles.add(key);
      // Auto-collapse when marking as viewed
      if (wrapper && !wrapper.classList.contains('collapsed')) {
        wrapper.classList.add('collapsed');
        this.collapsedFiles.add(key);
        if (header) {
          window.DiffRenderer.updateFileHeaderState(header, false);
        }
      }
    } else {
      this.viewedFiles.delete(key);
      // Auto-expand when unchecking viewed (match GitHub behavior)
      if (wrapper && wrapper.classList.contains('collapsed')) {
        wrapper.classList.remove('collapsed');
        this.collapsedFiles.delete(key);
        if (header) {
          window.DiffRenderer.updateFileHeaderState(header, true);
        }
      }
    }

    // Context entries only get their own sidebar row when the file is not in
    // the diff; scope to context items so a same-path diff row is untouched.
    this.updateFileItemViewedState(filePath, isViewed, { contextItem: true });

    this.saveViewedState();
  }

  /**
   * Build the eye-slash icon wrapper element used to mark a sidebar
   * file row as viewed. Shared by the initial render and in-place updates
   * so the markup and attributes stay in sync.
   * @returns {HTMLSpanElement}
   */
  _createViewedIcon() {
    const viewedIcon = document.createElement('span');
    viewedIcon.className = 'file-viewed-icon-wrapper';
    viewedIcon.title = 'Marked as viewed';
    viewedIcon.setAttribute('aria-label', 'Marked as viewed');
    viewedIcon.innerHTML = '<svg class="file-viewed-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M1.22 1.22a.75.75 0 0 1 1.06 0l12.5 12.5a.75.75 0 1 1-1.06 1.06l-1.82-1.82A7.44 7.44 0 0 1 8 14c-2.12 0-3.88-.81-5.26-1.94A13.13 13.13 0 0 1 .75 9.44a7.34 7.34 0 0 1-.51-.66.77.77 0 0 1 0-.84 12.52 12.52 0 0 1 .55-.72c.28-.34.66-.79 1.13-1.26L1.22 2.28a.75.75 0 0 1 0-1.06ZM4.5 5.56 6 7.06a2.5 2.5 0 0 0 2.94 2.94l1.22 1.22a4 4 0 0 1-5.66-5.66ZM8 3.5a4 4 0 0 1 3.98 4.46l3.04 3.04.1-.12c.36-.44.65-.87.87-1.22a.77.77 0 0 0 0-.84 13.13 13.13 0 0 0-2-2.62A7.44 7.44 0 0 0 8 2a7.4 7.4 0 0 0-2.3.36L7.1 3.78c.3-.18.62-.28.9-.28Z"/></svg>';
    return viewedIcon;
  }

  /**
   * Update the sidebar file row to reflect the viewed state.
   * Adds/removes the .viewed class and injects/removes the eye-slash icon
   * without re-rendering the whole file list.
   * @param {string} filePath - Path of the file
   * @param {boolean} isViewed - Whether the file is now viewed
   * @param {Object} [options]
   * @param {boolean} [options.contextItem=false] - Match the context-entry
   *   sidebar row instead of the diff row (they can share a file path)
   */
  updateFileItemViewedState(filePath, isViewed, { contextItem = false } = {}) {
    const items = document.querySelectorAll('.file-item');
    let item = null;
    for (const candidate of items) {
      if (candidate.dataset.path === filePath &&
          candidate.classList.contains('context-file-item') === contextItem) {
        item = candidate;
        break;
      }
    }
    if (!item) return;

    const existingIcon = item.querySelector('.file-viewed-icon-wrapper');

    if (isViewed) {
      item.classList.add('viewed');
      if (!existingIcon) {
        const viewedIcon = this._createViewedIcon();
        item.insertBefore(viewedIcon, item.firstChild);
      }
    } else {
      item.classList.remove('viewed');
      if (existingIcon) existingIcon.remove();
    }
  }

  /**
   * Save viewed files state to storage
   * Persists per PR for later retrieval
   */
  async saveViewedState() {
    if (!this.currentPR) return;

    const { owner, repo, number } = this.currentPR;
    const viewedArray = Array.from(this.viewedFiles);

    try {
      await fetch(`/api/pr/${owner}/${repo}/${number}/files/viewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: viewedArray })
      });
    } catch (error) {
      console.error('Failed to save viewed state:', error);
      // Fallback to localStorage
      const key = PRManager.getRepoStorageKey('pair-review-viewed', owner, repo) + `:${number}`;
      localStorage.setItem(key, JSON.stringify(viewedArray));
    }
  }

  /**
   * Load viewed files state from storage
   * Retrieves per-PR viewed state
   */
  async loadViewedState() {
    if (!this.currentPR) return;

    const { owner, repo, number } = this.currentPR;

    try {
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/files/viewed`);
      if (response.ok) {
        const data = await response.json();
        this.viewedFiles = new Set(data.files || []);
        return;
      }
    } catch (error) {
      console.error('Failed to load viewed state from API:', error);
    }

    // Fallback to localStorage
    const key = PRManager.getRepoStorageKey('pair-review-viewed', owner, repo) + `:${number}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        this.viewedFiles = new Set(JSON.parse(stored));
      } catch (e) {
        this.viewedFiles = new Set();
      }
    }
  }

  /**
   * Toggle visibility of generated file diff
   * @param {string} filePath - Path of the file
   * @deprecated Use toggleFileCollapse instead - kept for backward compatibility
   */
  toggleGeneratedFile(filePath) {
    return this.toggleFileCollapse(filePath);
  }

  /**
   * Fetch original file content for context expansion
   * @param {string} fileName - The file path
   * @returns {Promise<{lines: string[]}|null>} File content with lines array, or null on error
   */
  async fetchFileContent(fileName) {
    const reviewId = this.currentPR?.id;
    if (!reviewId) return null;

    const response = await fetch(
      `/api/reviews/${reviewId}/file-content/${encodeURIComponent(fileName)}`
    );
    const data = await response.json();

    if (!response.ok || !data.lines) {
      console.error('Failed to fetch file content');
      return null;
    }

    return data;
  }

  /**
   * Validate pending end-of-file gaps asynchronously
   * Removes gap rows where there are no trailing lines to expand
   * This ensures users don't see expand buttons that do nothing
   * @param {ParentNode} [root=document] - Scope the search. With lazy bodies,
   *   _renderFileBodyNow passes the just-rendered file body so each file's EOF
   *   gap is validated as it renders (rather than one global post-render pass).
   */
  async validatePendingEofGaps(root = document) {
    const pendingGaps = root.querySelectorAll('tr.context-expand-row[data-pending-eof-validation="true"]');

    // Process all pending gaps in parallel for efficiency
    const validationPromises = Array.from(pendingGaps).map(async (gapRow) => {
      const controls = gapRow.expandControls;
      if (!controls) {
        gapRow.remove();
        return;
      }

      const fileName = controls.dataset.fileName;
      const startLine = parseInt(controls.dataset.startLine);

      // Safety net: remove gaps with invalid start lines (should not occur after
      // the prevBlockEnd.old > 0 guard in renderPatch, but handles edge cases defensively)
      if (startLine <= 0) {
        console.debug('Removing EOF gap with invalid startLine:', startLine, 'for file:', fileName);
        gapRow.remove();
        return;
      }

      try {
        const data = await this.fetchFileContent(fileName);
        if (!data) {
          // Can't validate - remove the gap to be safe
          gapRow.remove();
          return;
        }

        const totalLines = data.lines.length;

        // If startLine is beyond file length, there are no remaining lines
        if (startLine > totalLines) {
          gapRow.remove();
        } else {
          // Gap is valid - update with actual count and remove pending flag
          const actualGapSize = totalLines - startLine + 1;
          controls.dataset.endLine = totalLines;
          controls.dataset.hiddenCount = actualGapSize;
          gapRow.removeAttribute('data-pending-eof-validation');

          // Update the display text with actual count
          const expandInfo = gapRow.querySelector('.expand-info');
          if (expandInfo) {
            expandInfo.textContent = `${actualGapSize} hidden lines`;
          }
          const contentCell = gapRow.querySelector('.clickable-expand');
          if (contentCell) {
            contentCell.title = 'Expand all';
          }
        }
      } catch (error) {
        console.error('Error validating EOF gap:', error);
        // On error, remove the gap to be safe
        gapRow.remove();
      }
    });

    await Promise.all(validationPromises);
  }

  /**
   * Expand gap context
   * @param {Element} controls - The expand controls element
   * @param {string} direction - 'up', 'down', or 'all'
   * @param {number} count - Number of lines to expand
   */
  async expandGapContext(controls, direction, count) {
    const coords = window.GapCoordinates?.getGapCoordinates(controls);
    if (!coords) return;
    const { gapStart: startLine, gapEnd: endLine, gapStartNew: startLineNew, gapEndNew: endLineNew, offset: lineOffset } = coords;

    // Check if original gap has explicit endLineNew (for non-uniform offset gaps)
    const hasExplicitEndLineNew = !isNaN(parseInt(controls.dataset.endLineNew));

    const fileName = controls.dataset.fileName;
    const position = controls.dataset.position || 'between';

    // Find the gap row by matching the controls element
    // The controls element is stored on the row as row.expandControls but is NOT in the DOM
    let gapRow = null;
    const allGapRows = document.querySelectorAll('tr.context-expand-row');
    for (const row of allGapRows) {
      if (row.expandControls === controls) {
        gapRow = row;
        break;
      }
    }

    if (!gapRow) return;

    const tbody = gapRow.closest('tbody');
    if (!tbody) return;

    try {
      const data = await this.fetchFileContent(fileName);
      if (!data) return;

      // Handle EOF_SENTINEL for end-of-file gaps with unknown size
      // When endLine is EOF_SENTINEL, determine actual file size from fetched content
      let actualEndLine = endLine;
      if (endLine === window.HunkParser.EOF_SENTINEL) {
        actualEndLine = data.lines.length;
        // If startLine is beyond file length, there are no remaining lines
        if (startLine > actualEndLine) {
          gapRow.remove();
          return;
        }
      }

      let linesToShow = [];
      let newGapStart = startLine;
      let newGapEnd = actualEndLine;

      if (direction === 'all') {
        // Show all lines in the gap
        linesToShow = data.lines.slice(startLine - 1, actualEndLine);
        newGapStart = actualEndLine + 1; // No remaining gap
      } else if (direction === 'up') {
        // Show lines from the bottom of the gap (expanding upward)
        const expandEnd = actualEndLine;
        const expandStart = Math.max(startLine, actualEndLine - count + 1);
        linesToShow = data.lines.slice(expandStart - 1, expandEnd);
        newGapEnd = expandStart - 1;
      } else if (direction === 'down') {
        // Show lines from the top of the gap (expanding downward)
        const expandStart = startLine;
        const expandEnd = Math.min(actualEndLine, startLine + count - 1);
        linesToShow = data.lines.slice(expandStart - 1, expandEnd);
        newGapStart = expandEnd + 1;
      }

      // Create fragment for new rows
      const fragment = document.createDocumentFragment();

      // For 'up' direction: first add remaining gap, then expanded lines
      // For 'down' direction: first add expanded lines, then remaining gap
      // This ensures correct visual order when fragment is inserted

      // If expanding up, add remaining gap FIRST (it appears above expanded lines)
      if (direction === 'up' && newGapEnd >= startLine) {
        const remainingGap = newGapEnd - startLine + 1;
        if (remainingGap > 0) {
          const newGapRow = window.HunkParser.createGapRowElement(
            fileName,
            startLine,
            newGapEnd,
            remainingGap,
            position, // Preserve original position (above/between/below)
            (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt),
            startLineNew  // Preserve the NEW line number offset
          );
          // Propagate endLineNew for non-uniform offset gaps (e.g., start-of-file gaps)
          // The remaining gap's NEW end is calculated based on how many lines remain
          if (hasExplicitEndLineNew) {
            const newEndLineNew = startLineNew + (newGapEnd - startLine);
            newGapRow.expandControls.dataset.endLineNew = newEndLineNew;
          }
          fragment.appendChild(newGapRow);
        }
      }

      // Add the expanded lines
      linesToShow.forEach((content, idx) => {
        let lineNumber;
        if (direction === 'down') {
          lineNumber = startLine + idx;
        } else if (direction === 'up') {
          lineNumber = Math.max(startLine, actualEndLine - count + 1) + idx;
        } else {
          lineNumber = startLine + idx;
        }

        const lineData = {
          type: 'context',
          oldNumber: lineNumber,
          newNumber: lineNumber + lineOffset,  // Apply offset for correct right-side line number
          // Expanded rows should follow the same contract as parsed diff context
          // lines so DiffRenderer strips the synthetic diff marker, not real indent.
          content: ' ' + (content || '')
        };

        const lineRow = this.renderDiffLine(fragment, lineData, fileName, null);
        if (lineRow) {
          lineRow.classList.add('newly-expanded');
          setTimeout(() => lineRow.classList.remove('newly-expanded'), 800);
        }
      });

      // If expanding down, add remaining gap LAST (it appears below expanded lines)
      if (direction === 'down' && newGapStart <= actualEndLine) {
        const remainingGap = actualEndLine - newGapStart + 1;
        if (remainingGap > 0) {
          // Calculate the new startLineNew for the remaining gap
          // It should advance by the same amount as the OLD line numbers
          const expandedCount = newGapStart - startLine;
          const newStartLineNew = startLineNew + expandedCount;
          const newGapRow = window.HunkParser.createGapRowElement(
            fileName,
            newGapStart,
            actualEndLine,
            remainingGap,
            position, // Preserve original position (above/between/below)
            (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt),
            newStartLineNew  // Updated NEW line number for remaining gap
          );
          // Propagate endLineNew for non-uniform offset gaps (e.g., start-of-file gaps)
          // The remaining gap's NEW end stays the same (we're just moving the start)
          if (hasExplicitEndLineNew) {
            newGapRow.expandControls.dataset.endLineNew = endLineNew;
          }
          fragment.appendChild(newGapRow);
        }
      }

      // Insert fragment before gap row and remove the old gap row
      // The fragment is already assembled in the correct visual order
      gapRow.parentNode.insertBefore(fragment, gapRow);
      gapRow.remove();

      // Remove hunk headers that are no longer at a gap boundary,
      // then check remaining headers for visible function definitions
      if (window.DiffRenderer) {
        window.DiffRenderer.removeStrandedHunkHeaders(tbody);
        window.DiffRenderer.updateFunctionContextVisibility(tbody);
      }

    } catch (error) {
      console.error('Error expanding gap context:', error);
    }
  }

  /**
   * Expand a specific range within a gap
   */
  async expandGapRange(gapRow, controls, expandStart, expandEnd) {
    const coords = window.GapCoordinates?.getGapCoordinates(controls);
    if (!coords) return;
    const { gapStart, gapEnd, gapStartNew, gapEndNew, offset: lineOffset } = coords;

    // Check if original gap has explicit endLineNew (for non-uniform offset gaps)
    const hasExplicitEndLineNew = !isNaN(parseInt(controls.dataset.endLineNew));

    const fileName = controls.dataset.fileName;
    const position = controls.dataset.position || 'between';
    const tbody = gapRow.closest('tbody');

    if (!tbody) return;

    try {
      const data = await this.fetchFileContent(fileName);
      if (!data) return;

      const fragment = document.createDocumentFragment();

      // Compute positions for each remnant based on file boundary proximity.
      // The upper remnant keeps 'above' only if the original gap was at the file start;
      // the lower remnant keeps 'below' only if the original gap was at the file end.
      // Inner remnants become 'between' since they're sandwiched between visible content.
      const gapAbovePosition = position === 'above' ? 'above' : 'between';
      const gapBelowPosition = position === 'below' ? 'below' : 'between';

      // Create gap above if needed
      const gapAboveSize = expandStart - gapStart;
      if (gapAboveSize > 0) {
        const aboveRow = window.HunkParser.createGapRowElement(
          fileName,
          gapStart,
          expandStart - 1,
          gapAboveSize,
          gapAbovePosition,
          (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt),
          gapStartNew  // Preserve the NEW line number offset
        );
        // Propagate endLineNew for non-uniform offset gaps (e.g., start-of-file gaps)
        // The gap above's NEW end is calculated based on how many lines remain
        if (hasExplicitEndLineNew) {
          const aboveEndLineNew = gapStartNew + (expandStart - 1 - gapStart);
          aboveRow.expandControls.dataset.endLineNew = aboveEndLineNew;
        }
        fragment.appendChild(aboveRow);
      }

      // Add the expanded lines
      const linesToShow = data.lines.slice(expandStart - 1, expandEnd);
      linesToShow.forEach((content, idx) => {
        const lineNumber = expandStart + idx;
        const lineData = {
          type: 'context',
          oldNumber: lineNumber,
          newNumber: lineNumber + lineOffset,  // Apply offset for correct right-side line number
          // Expanded rows should follow the same contract as parsed diff context
          // lines so DiffRenderer strips the synthetic diff marker, not real indent.
          content: ' ' + (content || '')
        };

        const lineRow = this.renderDiffLine(fragment, lineData, fileName, null);
        if (lineRow) {
          lineRow.classList.add('newly-expanded');
          setTimeout(() => lineRow.classList.remove('newly-expanded'), 800);
        }
      });

      // Create gap below if needed
      const gapBelowSize = gapEnd - expandEnd;
      if (gapBelowSize > 0) {
        // Calculate the NEW start line for the gap below
        const belowGapStartNew = (expandEnd + 1) + lineOffset;
        const belowRow = window.HunkParser.createGapRowElement(
          fileName,
          expandEnd + 1,
          gapEnd,
          gapBelowSize,
          gapBelowPosition,
          (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt),
          belowGapStartNew  // Updated NEW line number for gap below
        );
        // Propagate endLineNew for non-uniform offset gaps (e.g., start-of-file gaps)
        // The gap below's NEW end stays the same as the original gap's end
        if (hasExplicitEndLineNew) {
          belowRow.expandControls.dataset.endLineNew = gapEndNew;
        }
        fragment.appendChild(belowRow);
      }

      // Replace the gap row
      gapRow.parentNode.insertBefore(fragment, gapRow);
      gapRow.remove();

      // Remove hunk headers that are no longer at a gap boundary,
      // then check remaining headers for visible function definitions
      if (window.DiffRenderer) {
        window.DiffRenderer.removeStrandedHunkHeaders(tbody);
        window.DiffRenderer.updateFunctionContextVisibility(tbody);
      }

    } catch (error) {
      console.error('Error in expandGapRange:', error);
    }
  }

  /**
   * Expand for suggestion - reveal lines that an AI suggestion targets
   *
   * Uses GapCoordinates module for coordinate handling.
   * See public/js/modules/gap-coordinates.js for detailed documentation on:
   *   - OLD vs NEW coordinate systems
   *   - When offsets are non-zero
   *   - Which functions use which coordinate system
   *
   * @param {string} file - File path
   * @param {number} lineStart - Start line number
   * @param {number} lineEnd - End line number (defaults to lineStart)
   * @param {string} side - Required: 'RIGHT' for NEW coords, 'LEFT' for OLD coords
   */
  async expandForSuggestion(file, lineStart, lineEnd = lineStart, side) {
    const { findMatchingGap, convertNewToOldCoords, debugLog } = window.GapCoordinates || {};
    debugLog?.('expandForSuggestion', `Attempting to reveal ${file}:${lineStart}-${lineEnd} (${side})`);

    const fileElement = this.findFileElement(file);
    if (!fileElement) {
      console.warn(`[expandForSuggestion] Could not find file element for: ${file}`);
      return false;
    }

    // Render the body first — gap rows (and code rows) only exist once the
    // lazy body has rendered. Without this the gap query below returns nothing.
    await this.ensureFileBodyRendered(file);

    // The trailing end-of-file gap is created with EOF_SENTINEL (-1) coords and
    // resolved to real line numbers asynchronously by validatePendingEofGaps(),
    // which _renderFileBodyNow fires fire-and-forget as the body renders. Until
    // it settles the gap's NEW/OLD end is negative, so findMatchingGap()'s
    // overlap test can never match a real target line — a suggestion (or
    // comment, via ensureLinesVisible) on a trailing unchanged line silently
    // fails to expand and never anchors. Pre-lazy-render this validation ran at
    // renderDiff time, long before any suggestion was placed; lazy rendering
    // collapsed that head start to nothing, which is the regression. Await the
    // same in-flight promise (not a second /file-content fetch) so the EOF gap
    // carries real coordinates before we match below.
    const lazyEntry = this._lazyFileBodies?.get(fileElement.dataset?.fileName || file);
    if (lazyEntry?.eofValidationPromise) {
      try {
        await lazyEntry.eofValidationPromise;
      } catch {
        // Validation removes the gap on fetch failure; matching simply misses.
      }
    }

    // Check if file is collapsed (generated files)
    if (fileElement.classList.contains('collapsed')) {
      debugLog?.('expandForSuggestion', 'File is collapsed, expanding first');
      await this.toggleGeneratedFile(file);
    }

    // For @pierre/diffs rendered files, use context ranges to reveal collapsed lines
    if (this.pierreBridge && this.pierreBridge.files.has(file)) {
      await this._ensurePierreContentUpgrade(file);
      let rangeStart = lineStart;
      let rangeEnd = lineEnd;

      // addContextRanges expects NEW-file coordinates.
      // LEFT-side suggestions use OLD-file numbers — convert first.
      if (side === 'LEFT') {
        const converted = this.pierreBridge.convertOldToNew(file, lineStart, lineEnd);
        if (!converted) return false;
        rangeStart = converted.startLine;
        rangeEnd = converted.endLine;
      }

      const padding = 3;
      const range = {
        startLine: Math.max(1, rangeStart - padding),
        endLine: rangeEnd + padding,
      };
      return this.pierreBridge.addContextRanges(file, [range]);
    }

    // Find the gap section containing the target lines using the shared module
    // Pass the side parameter so findMatchingGap uses the correct coordinate system:
    // - 'RIGHT' = NEW coordinates (modified file, most common for AI suggestions)
    // - 'LEFT' = OLD coordinates (deleted lines from original file)
    const gapRows = fileElement.querySelectorAll('tr.context-expand-row');
    const match = findMatchingGap?.(gapRows, lineStart, lineEnd, side);

    if (!match) {
      console.warn(`[expandForSuggestion] Could not find gap for ${file}:${lineStart}-${lineEnd} (side=${side})`);
      return false;
    }

    const { row: targetGapRow, controls: targetControls, coords, matchedInNewCoords } = match;
    let { gapStart, gapEnd, gapStartNew, gapEndNew } = coords;

    // Handle EOF_SENTINEL for end-of-file gaps with unknown size
    // When gapEnd is EOF_SENTINEL, determine actual file size from fetched content
    if (gapEnd === window.HunkParser.EOF_SENTINEL) {
      const data = await this.fetchFileContent(file);
      if (data && data.lines) {
        gapEnd = data.lines.length;
        // Also update gapEndNew to maintain the same offset
        const offset = gapStartNew - gapStart;
        gapEndNew = gapEnd + offset;
        debugLog?.('expandForSuggestion', `Resolved EOF_SENTINEL: gapEnd=${gapEnd}, gapEndNew=${gapEndNew}`);
      } else {
        console.warn(`[expandForSuggestion] Could not fetch file content to resolve EOF_SENTINEL for: ${file}`);
        return false;
      }
    }

    const gapSize = gapEnd - gapStart + 1;

    if (matchedInNewCoords) {
      debugLog?.('expandForSuggestion', `Found gap match in NEW coords: gap ${gapStartNew}-${gapEndNew}, suggestion ${lineStart}-${lineEnd}`);
    } else {
      debugLog?.('expandForSuggestion', `Found gap match in OLD coords: gap ${gapStart}-${gapEnd}, suggestion ${lineStart}-${lineEnd}`);
    }

    // If suggestion matched in NEW coordinates, convert to OLD for expansion
    // since expandGapRange() uses OLD line numbers internally
    let targetLineStart = lineStart;
    let targetLineEnd = lineEnd;
    if (matchedInNewCoords) {
      const converted = convertNewToOldCoords?.(targetControls, lineStart, lineEnd);
      if (converted) {
        targetLineStart = converted.targetLineStart;
        targetLineEnd = converted.targetLineEnd;
        debugLog?.('expandForSuggestion', `Converted NEW coords ${lineStart}-${lineEnd} to OLD coords ${targetLineStart}-${targetLineEnd} (offset: ${converted.offset})`);
      }
    }

    // Calculate expansion range with context (using OLD coordinates)
    const contextRadius = 3;
    const expandStart = Math.max(gapStart, targetLineStart - contextRadius);
    const expandEnd = Math.min(gapEnd, targetLineEnd + contextRadius);
    const linesToExpand = expandEnd - expandStart + 1;

    if (gapSize <= 10 || linesToExpand >= gapSize * 0.7) {
      await this.expandGapContext(targetControls, 'all', gapSize);
    } else {
      await this.expandGapRange(targetGapRow, targetControls, expandStart, expandEnd);
    }

    return true;
  }

  /**
   * Ensure that the given line ranges are visible in the diff view.
   * For each item, checks if the target line rows exist in the DOM; if not,
   * calls expandForSuggestion() to expand the gap containing those lines.
   * @param {Array<{file: string, line_start: number, line_end: number, side: string}>} items
   */
  async ensureLinesVisible(items) {
    for (const item of items) {
      const { file, line_start, line_end, side } = item;
      if (!file || !line_start) continue;
      const resolvedSide = (side || 'right').toUpperCase();

      // Materialize the lazy body BEFORE branching on the rendering engine. A
      // Pierre file whose body hasn't rendered yet is NOT in pierreBridge.files,
      // so it would wrongly fall through to the legacy <tr> path below (which
      // scans zero rows for a Pierre file); and an unrendered legacy body has no
      // rows either. Rendering here lands the file in pierreBridge.files so the
      // Pierre branch is taken correctly.
      await this.ensureFileBodyRendered(file);

      // @pierre/diffs files: use context ranges to reveal collapsed lines
      if (this.pierreBridge && this.pierreBridge.files.has(file)) {
        // Check the WHOLE range, not just line_start. Callers pass multi-line
        // ranges (comments, suggestions, chat citations); if line_start is on
        // screen but line_end is still inside a collapsed gap, we must still
        // expand. Preserve the skip-when-fully-visible optimization: only expand
        // when at least one endpoint is hidden.
        const endLine = line_end || line_start;
        const startVisible = this.pierreBridge.isLineVisible(file, line_start, resolvedSide);
        const endVisible = this.pierreBridge.isLineVisible(file, endLine, resolvedSide);
        if (!startVisible || !endVisible) {
          await this._ensurePierreContentUpgrade(file);
          let rangeStart = line_start;
          let rangeEnd = line_end || line_start;

          // addContextRanges expects NEW-file coordinates.
          // LEFT-side items use OLD-file numbers — convert first.
          if (resolvedSide === 'LEFT') {
            const converted = this.pierreBridge.convertOldToNew(file, rangeStart, rangeEnd);
            if (converted) {
              rangeStart = converted.startLine;
              rangeEnd = converted.endLine;
            } else {
              continue;
            }
          }

          this.pierreBridge.addContextRanges(file, [{
            startLine: rangeStart,
            endLine: rangeEnd,
          }]);
        }
        continue;
      }

      const fileElement = this.findFileElement(file);
      if (!fileElement) continue;

      // Render the file body first — with lazy rendering an unrendered file
      // has zero rows, so the visibility scan below would always miss and the
      // line would be treated as "hidden in a gap" (then gap-expanded against
      // zero gap rows → silent anchor failure).
      await this.ensureFileBodyRendered(file);

      // Check if any line in the range is already visible
      let anyLineVisible = false;
      const lineRows = fileElement.querySelectorAll('tr');
      for (let checkLine = line_start; checkLine <= (line_end || line_start); checkLine++) {
        for (const row of lineRows) {
          const lineNum = this.getLineNumber(row, resolvedSide);
          if (lineNum === checkLine) {
            anyLineVisible = true;
            break;
          }
        }
        if (anyLineVisible) break;
      }

      if (!anyLineVisible) {
        await this.expandForSuggestion(file, line_start, line_end || line_start, resolvedSide);
      }
    }
  }

  /**
   * Line range selection methods - delegate to LineTracker
   */
  startRangeSelection(row, lineNumber, fileName, side = 'RIGHT') {
    this.lineTracker.startRangeSelection(row, lineNumber, fileName, side);
  }

  completeRangeSelection(endRow, endLineNumber, fileName) {
    this.lineTracker.completeRangeSelection(endRow, endLineNumber, fileName,
      (row, line, file, pos, endLine, side) => this.showCommentForm(row, line, file, pos, endLine, side)
    );
  }

  highlightLineRange(startRow, endRow, fileName, minLine, maxLine, side) {
    this.lineTracker.highlightLineRange(startRow, endRow, fileName, minLine, maxLine, side);
  }

  clearRangeSelection() {
    this.lineTracker.clearRangeSelection();
  }

  startDragSelection(row, lineNumber, fileName, side = 'RIGHT') {
    this.lineTracker.startDragSelection(row, lineNumber, fileName, side);
  }

  updateDragSelection(row, lineNumber, fileName) {
    this.lineTracker.updateDragSelection(row, lineNumber, fileName);
  }

  completeDragSelection(row, lineNumber, fileName) {
    this.lineTracker.completeDragSelection(row, lineNumber, fileName);
  }

  /**
   * Comment form methods - delegate to CommentManager
   */
  showCommentForm(targetRow, lineNumber, fileName, diffPosition, endLineNumber, side = 'RIGHT') {
    // Use PierreBridge annotation for files rendered by @pierre/diffs
    if (this.pierreBridge && this.pierreBridge.files.has(fileName)) {
      const formId = `form-${fileName}-${lineNumber}-${side}`;
      this.pierreBridge.addAnnotation(fileName, {
        lineNumber: endLineNumber || lineNumber,
        side: side,
        type: 'comment-form',
        id: formId,
        data: {
          lineStart: lineNumber,
          lineEnd: endLineNumber || lineNumber,
          fileName: fileName,
          diffPosition: diffPosition,
          side: side,
          showSuggestionBtn: true,
        },
      });
      return;
    }
    // Fallback: old table-based comment form (context files)
    this.commentManager.showCommentForm(targetRow, lineNumber, fileName, diffPosition, endLineNumber, side);
  }

  /**
   * Handle comment form submission from PierreBridge annotation.
   * Saves the comment via API, removes the form annotation, and reloads comments.
   * @param {string} fileName - File the comment belongs to
   * @param {string} annotationId - PierreBridge annotation ID for the form
   * @param {Object} data - Form data (lineStart, lineEnd, fileName, diffPosition, side)
   * @param {string} body - Comment body text
   */
  async _handleCommentFormSubmit(fileName, annotationId, data, body) {
    if (!body || !body.trim()) return;

    // Custom submit flow (e.g. edit-and-adopt suggestion): let the caller
    // decide how to save and how to re-render the result. The handler owns
    // removing the form annotation.
    if (typeof data.customSubmit === 'function') {
      try {
        await data.customSubmit(body.trim(), fileName, annotationId);
      } catch (error) {
        console.error('Error running custom comment form submit:', error);
        alert(`Failed to save: ${error.message}`);
      }
      return;
    }

    try {
      const commentData = {
        file: data.fileName,
        line_start: data.lineStart,
        line_end: data.lineEnd,
        body: body.trim(),
        side: data.side || 'RIGHT',
        diff_position: data.diffPosition,
        // Anchor to the PR head commit so repositioning works if the PR is
        // updated later. Parity with CommentManager.saveComment.
        commit_sha: this.currentPR?.head_sha,
      };

      const response = await fetch(`/api/reviews/${this.currentPR.id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': this._clientId,
        },
        body: JSON.stringify(commentData),
      });

      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        // Remove form annotation
        this.pierreBridge.removeAnnotation(fileName, annotationId);
        // Reload comments to show the new one
        const includeDismissed = window.aiPanel?.showDismissedComments || false;
        await this.loadUserComments(includeDismissed);

        // Legacy-path side-effects: clear the dragged range, auto-expand in
        // minimize mode, and notify the AI chat context. Parity with
        // CommentManager.saveComment.
        this.lineTracker?.clearRangeSelection();
        if (result.commentId != null && this.commentMinimizer) {
          const newRow = document.querySelector(
            `[data-comment-id="${result.commentId}"]`
          );
          if (newRow) this.commentMinimizer.expandForElement(newRow);
        }
        window.chatPanel?.queueUserActionHint(
          `[User Action: created comment on ${data.fileName} lines ${data.lineStart}-${data.lineEnd}]`
        );
      }
    } catch (error) {
      console.error('Error saving comment:', error);
    }
  }

  hideCommentForm() {
    this.commentManager.hideCommentForm();
  }

  autoResizeTextarea(textarea, minRows = 4) {
    this.commentManager.autoResizeTextarea(textarea, minRows);
  }

  hasSuggestionBlock(text) {
    return this.commentManager.hasSuggestionBlock(text);
  }

  updateSuggestionButtonState(textarea, button) {
    this.commentManager.updateSuggestionButtonState(textarea, button);
  }

  insertSuggestionBlock(textarea, button) {
    this.commentManager.insertSuggestionBlock(textarea, button);
  }

  async saveUserComment(textarea, formRow) {
    return this.commentManager.saveUserComment(textarea, formRow);
  }

  displayUserComment(comment, targetRow) {
    this.commentManager.displayUserComment(comment, targetRow);
  }

  displayUserCommentInEditMode(comment, targetRow) {
    this.commentManager.displayUserCommentInEditMode(comment, targetRow);
  }

  /**
   * Edit user comment
   * NOTE: similar edit form in comment-manager.js _buildEditFormRow — keep in sync
   */
  async editUserComment(commentId) {
    try {
      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (!commentRow) return;

      const commentDiv = commentRow.querySelector('.user-comment');
      const bodyDiv = commentDiv.querySelector('.user-comment-body');
      let currentText = bodyDiv.dataset.originalMarkdown || '';

      if (!currentText) {
        const response = await fetch(`/api/reviews/${this.currentPR.id}/comments/${commentId}`);
        if (response.ok) {
          const data = await response.json();
          currentText = data.body || bodyDiv.textContent.trim();
        } else {
          currentText = bodyDiv.textContent.trim();
        }
      }

      if (commentDiv.classList.contains('editing-mode')) return;

      commentDiv.classList.add('editing-mode');

      const fileName = commentRow.dataset.file || '';
      const lineStart = commentRow.dataset.lineStart || '';
      const lineEnd = commentRow.dataset.lineEnd || lineStart;
      const side = commentRow.dataset.side || '';

      const editFormHTML = `
        <div class="user-comment-edit-form">
          <div class="comment-form-toolbar">
            <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion">
              ${CommentManager.SUGGESTION_ICON_SVG}
            </button>
          </div>
          <textarea
            id="edit-comment-${commentId}"
            class="comment-edit-textarea"
            placeholder="Enter your comment..."
            data-file="${fileName}"
            data-line="${lineStart}"
            data-line-end="${lineEnd}"
            data-side="${side || 'RIGHT'}"
          >${this.escapeHtml(currentText)}</textarea>
          <div class="comment-edit-actions">
            <button class="btn btn-sm btn-primary save-edit-btn">Save</button>
            <button class="btn btn-sm btn-secondary cancel-edit-btn">Cancel</button>
          </div>
        </div>
      `;

      bodyDiv.style.display = 'none';
      bodyDiv.insertAdjacentHTML('afterend', editFormHTML);

      const editForm = commentDiv.querySelector('.user-comment-edit-form');
      const textarea = document.getElementById(`edit-comment-${commentId}`);
      const suggestionBtn = editForm.querySelector('.suggestion-btn');
      const saveBtn = editForm.querySelector('.save-edit-btn');
      const cancelBtn = editForm.querySelector('.cancel-edit-btn');

      if (textarea) {
        this.autoResizeTextarea(textarea);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        this.updateSuggestionButtonState(textarea, suggestionBtn);

        suggestionBtn.addEventListener('click', () => {
          if (!suggestionBtn.disabled) {
            this.insertSuggestionBlock(textarea, suggestionBtn);
          }
        });

        saveBtn.addEventListener('click', () => this.saveEditedUserComment(commentId));
        cancelBtn.addEventListener('click', () => this.cancelEditUserComment(commentId));

        textarea.addEventListener('input', () => {
          this.autoResizeTextarea(textarea);
          this.updateSuggestionButtonState(textarea, suggestionBtn);
        });
      }
    } catch (error) {
      console.error('Error editing comment:', error);
      alert('Failed to edit comment');
    }
  }

  /**
   * Save edited user comment
   */
  async saveEditedUserComment(commentId) {
    // Prevent duplicate saves from rapid clicks or Cmd+Enter
    const editForm = document.querySelector(`#edit-comment-${commentId}`)?.closest('.user-comment-edit-form');
    const saveBtn = editForm?.querySelector('.save-edit-btn');
    if (saveBtn?.dataset.saving === 'true') {
      return;
    }
    if (saveBtn) saveBtn.dataset.saving = 'true';
    if (saveBtn) saveBtn.disabled = true;

    try {
      const textarea = document.getElementById(`edit-comment-${commentId}`);
      const editedText = textarea.value.trim();

      if (!editedText) {
        alert('Comment cannot be empty');
        textarea.focus();
        if (saveBtn) {
          saveBtn.dataset.saving = 'false';
          saveBtn.disabled = false;
        }
        return;
      }

      const response = await fetch(`/api/reviews/${this.currentPR.id}/comments/${commentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editedText })
      });

      if (!response.ok) throw new Error('Failed to update comment');

      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      const commentDiv = commentRow.querySelector('.user-comment');
      let bodyDiv = commentDiv.querySelector('.user-comment-body');
      const editFormEl = commentDiv.querySelector('.user-comment-edit-form');

      if (!bodyDiv) {
        bodyDiv = document.createElement('div');
        bodyDiv.className = 'user-comment-body';
        commentDiv.appendChild(bodyDiv);
      }

      bodyDiv.innerHTML = window.renderMarkdown ? window.renderMarkdown(editedText) : this.escapeHtml(editedText);
      bodyDiv.dataset.originalMarkdown = editedText;
      bodyDiv.style.display = '';

      if (editFormEl) editFormEl.remove();
      commentDiv.classList.remove('editing-mode');

      // Sync the data model, not just the DOM. Under CodeView, line comments
      // re-render from bridge ANNOTATION DATA on remount, so an in-place DOM
      // edit REVERTS when the file scrolls out and back unless the annotation's
      // stored data is updated too. Also update this.userComments so a later
      // load-driven re-render carries the new body.
      const editedComment = this.userComments?.find(c => String(c.id) === String(commentId));
      if (editedComment) editedComment.body = editedText;
      if (this.pierreBridge && editedComment && editedComment.file && editedComment.is_file_level !== 1) {
        this.pierreBridge.updateAnnotationData(editedComment.file, `comment-${commentId}`, { body: editedText });
      }

      // Notify AI Panel about the updated comment body
      if (window.aiPanel?.updateComment) {
        window.aiPanel.updateComment(commentId, { body: editedText });
      }

    } catch (error) {
      console.error('Error saving comment:', error);
      alert('Failed to save comment');
      // Re-enable save button on failure so the user can retry
      if (saveBtn) {
        saveBtn.dataset.saving = 'false';
        saveBtn.disabled = false;
      }
    }
  }

  /**
   * Cancel editing user comment
   */
  cancelEditUserComment(commentId) {
    const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (!commentRow) return;

    const commentDiv = commentRow.querySelector('.user-comment');
    const bodyDiv = commentDiv.querySelector('.user-comment-body');
    const editForm = commentDiv.querySelector('.user-comment-edit-form');

    bodyDiv.style.display = '';
    if (editForm) editForm.remove();
    commentDiv.classList.remove('editing-mode');
  }

  /**
   * Delete user comment (soft-delete - no confirmation needed)
   * If the comment was adopted from an AI suggestion, the suggestion is transitioned to dismissed state.
   *
   * DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
   * They only appear in the AI/Review Panel when the "show dismissed" filter is ON.
   * So we always remove the comment from the DOM here.
   */
  async deleteUserComment(commentId) {
    try {
      const response = await fetch(`/api/reviews/${this.currentPR.id}/comments/${commentId}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Failed to delete comment');

      const apiResult = await response.json();

      // Sync the data model and the count, not just the DOM: the annotation data
      // model owns line-comment rendering (a removed row alone resurrects on
      // remount) and the count is data-backed. Repaints even when the comment is
      // virtualized out and there is no DOM to remove.
      this._markCommentDeleted(commentId);

      // Check if dismissed comments filter is enabled for AI Panel updates
      const showDismissed = window.aiPanel?.showDismissedComments || false;

      // File-level comment cards go first, through the zone-aware sweep: it
      // reaches detached (virtualized-out) zones, which are re-slotted verbatim
      // on scroll-in, and _markCommentDeleted deliberately leaves file-level
      // comments' bridge annotations in place, so this DOM sweep is the ONLY
      // removal. Before the generic query below, too — that one also matches a
      // file-comment card by id, and removing the card there would rob the zone
      // of its comment-count refresh.
      const escapedId = globalThis.CSS?.escape
        ? CSS.escape(String(commentId))
        : String(commentId);
      this._purgeFileCommentCards(`.file-comment-card[data-comment-id="${escapedId}"]`);

      // Always remove the comment from the diff view (design decision: dismissed comments never shown in diff)
      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (commentRow) {
        commentRow.remove();
      }

      // Update AI Panel - transition to dismissed state or remove based on filter
      if (showDismissed && window.aiPanel?.updateComment) {
        // Update comment status to 'inactive' so it renders with dismissed styling in AI Panel
        window.aiPanel.updateComment(commentId, { status: 'inactive' });
      } else if (window.aiPanel?.removeComment) {
        window.aiPanel.removeComment(commentId);
      }

      // If a parent suggestion existed, the suggestion card is still collapsed/dismissed in the diff view.
      // Update AIPanel to show the suggestion as 'dismissed' (matching its visual state).
      // User can click "Show" to restore it to active state if they want to re-adopt.
      if (apiResult.dismissedSuggestionId) {
        if (window.aiPanel?.updateFindingStatus) {
          window.aiPanel.updateFindingStatus(apiResult.dismissedSuggestionId, 'dismissed');
        }
        // Clear hiddenForAdoption so that restoring the suggestion takes the API code path
        // instead of the toggle-only shortcut. Without this, restoring a previously-adopted
        // suggestion would only toggle visibility without updating its status.
        const suggestionDiv = document.querySelector(`[data-suggestion-id="${apiResult.dismissedSuggestionId}"]`);
        if (suggestionDiv) {
          delete suggestionDiv.dataset.hiddenForAdoption;
        }
      }

      // Refresh minimize-mode indicators so deleted comments no longer show
      if (this.commentMinimizer) {
        this.commentMinimizer.refreshIndicators();
      }

      // Show success toast
      if (window.toast) {
        window.toast.showSuccess('Comment dismissed');
      }

      if (apiResult.dismissedSuggestionId) {
        window.chatPanel?.queueUserActionHint(`[User Action: dismissed suggestion ${apiResult.dismissedSuggestionId}]`);
      }
      window.chatPanel?.queueUserActionHint(`[User Action: dismissed comment ${commentId}]`);
    } catch (error) {
      console.error('Error deleting comment:', error);
      if (window.toast) {
        window.toast.showError('Failed to dismiss comment');
      }
    }
  }

  /**
   * Restore a dismissed user comment
   * @param {number} commentId - The comment ID to restore
   */
  async restoreUserComment(commentId) {
    try {
      const response = await fetch(`/api/reviews/${this.currentPR.id}/comments/${commentId}/restore`, {
        method: 'PUT'
      });
      if (!response.ok) throw new Error('Failed to restore comment');

      // Reload comments to update both the diff view and AI panel
      // Pass the current filter state from the AI panel
      const includeDismissed = window.aiPanel?.showDismissedComments || false;
      await this.loadUserComments(includeDismissed);

      // Show success toast
      if (window.toast) {
        window.toast.showSuccess('Comment restored');
      }

      window.chatPanel?.queueUserActionHint(`[User Action: restored comment ${commentId}]`);
    } catch (error) {
      console.error('Error restoring comment:', error);
      if (window.toast) {
        window.toast.showError('Failed to restore comment');
      }
    }
  }

  /**
   * Update the UI for a dismissed AI suggestion
   * Delegates to the shared SuggestionUI utility
   * @param {number} suggestionId - The suggestion ID that was dismissed
   */
  updateDismissedSuggestionUI(suggestionId) {
    if (window.SuggestionUI?.updateDismissedSuggestionUI) {
      window.SuggestionUI.updateDismissedSuggestionUI(suggestionId);
    }
  }

  /**
   * Clear all user comments (soft-delete with confirmation for bulk operations)
   */
  async clearAllUserComments() {
    // Data-backed count (line + file level): a DOM query misses files the
    // virtualized CodeView has unmounted and races the async annotation slot,
    // so it would report "No comments to clear" while comments exist.
    const totalComments = this._countActiveUserComments();

    if (totalComments === 0) {
      if (window.toast?.showInfo) {
        window.toast.showInfo('No comments to clear');
      }
      return;
    }

    if (!window.confirmDialog) {
      alert('Confirmation dialog unavailable. Please refresh the page.');
      return;
    }

    const dialogResult = await window.confirmDialog.show({
      title: 'Clear All Comments?',
      message: `This will dismiss all ${totalComments} comment${totalComments !== 1 ? 's' : ''}. You can restore them later.`,
      confirmText: 'Clear All',
      confirmClass: 'btn-danger'
    });

    if (dialogResult !== 'confirm') return;

    try {
      const response = await fetch(`/api/reviews/${this.currentPR.id}/comments`, {
        method: 'DELETE'
      });

      if (!response.ok) throw new Error('Failed to delete comments');

      const result = await response.json();
      const deletedCount = result.deletedCount || totalComments;

      // Opportunistically remove the comment elements that are currently
      // mounted; unmounted (virtualized-out) line comments are handled by the
      // loadUserComments reload below.
      const lineCommentRows = document.querySelectorAll('.user-comment-row:not(.suggestion-edit-pending)');

      // Remove line-level comment rows from DOM
      lineCommentRows.forEach(row => row.remove());

      // File-level cards get the zone-aware sweep: the reload backstop below
      // only re-renders zones when fileLevelComments is non-empty, which it
      // never is after a clear — so a card left in a detached zone would
      // resurrect on scroll-in against a count that already reads 0.
      this._purgeFileCommentCards('.file-comment-card.user-comment');

      // Remove line-level and file-level comment elements from diff view
      // (They have been soft-deleted, so should not appear in the diff panel per design decision)
      // The comments array will be reloaded below with proper dismissed state.

      // Reload comments to update both internal state and AI Panel
      // This shows dismissed comments in AI Panel if filter is enabled, matching individual deletion behavior
      const includeDismissed = window.aiPanel?.showDismissedComments || false;
      await this.loadUserComments(includeDismissed);

      // Update dismissed suggestions in the diff view UI
      // (AI Panel is already updated by loadUserComments via setComments)
      if (result.dismissedSuggestionIds && result.dismissedSuggestionIds.length > 0) {
        for (const suggestionId of result.dismissedSuggestionIds) {
          this.updateDismissedSuggestionUI(suggestionId);
        }
      }

      // Show success toast notification
      if (window.toast) {
        window.toast.showSuccess(`Cleared ${deletedCount} comment${deletedCount !== 1 ? 's' : ''}`);
      }
    } catch (error) {
      console.error('Error clearing user comments:', error);
      if (window.toast) {
        window.toast.showError('Failed to clear comments');
      } else {
        alert('Failed to clear comments');
      }
    }
  }

  /**
   * Load user comments from API
   * @param {boolean} [includeDismissed=false] - Whether to include dismissed (inactive) comments
   *   When true, dismissed comments are returned by the API so they can be shown in the AI Panel.
   *   Note: Dismissed comments are NEVER shown in the diff panel per design decision.
   */
  async loadUserComments(includeDismissed = false) {
    if (!this.currentPR) return;

    try {
      const queryParam = includeDismissed ? '?includeDismissed=true' : '';
      const response = await fetch(`/api/reviews/${this.currentPR.id}/comments${queryParam}`);
      if (!response.ok) return;

      const data = await response.json();
      this.userComments = data.comments || [];

      // Separate file-level and line-level comments for diff view rendering
      // DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
      // They only appear in the AI/Review Panel when the "show dismissed" filter is ON.
      // This provides cleaner UX - the diff view shows only active comments, while
      // the AI Panel serves as the "inbox" where you can optionally see and restore dismissed items.
      const fileLevelComments = [];
      const lineLevelComments = [];

      this.userComments.forEach(comment => {
        // Skip inactive (dismissed) comments - they should not appear in the diff view
        if (comment.status === 'inactive') {
          return;
        }
        if (comment.is_file_level === 1) {
          fileLevelComments.push(comment);
        } else {
          lineLevelComments.push(comment);
        }
      });

      // Clear existing comment rows before re-rendering
      document.querySelectorAll('.user-comment-row:not(.suggestion-edit-pending)').forEach(row => row.remove());

      // Clear existing PierreBridge comment annotations
      if (this.pierreBridge) {
        for (const [file] of this.pierreBridge.files) {
          this.pierreBridge.removeAnnotationsByType(file, 'comment');
        }
      }

      // Ensure every comment's target line is reachable in the DOM before
      // rendering. `ensureLinesVisible` handles both engines — for Pierre
      // files it expands collapsed gaps via `addContextRanges` so the
      // annotation row exists; for legacy files it expands hidden hunks.
      // Without this, comments on lines outside the default hunks render
      // nowhere on reload and "jump to comment" silently fails.
      if (lineLevelComments.length > 0) {
        await this.ensureLinesVisible(lineLevelComments.map(c => ({
          file: c.file,
          line_start: c.line_start,
          line_end: c.line_end || c.line_start,
          side: c.side || 'RIGHT',
        })));
      }

      // Partition line-level comments by rendering engine
      const pierreComments = [];
      const legacyComments = [];
      lineLevelComments.forEach(comment => {
        if (this.pierreBridge && this.pierreBridge.files.has(comment.file)) {
          pierreComments.push(comment);
        } else {
          legacyComments.push(comment);
        }
      });

      // Display comments via PierreBridge annotations. Group by file so each
      // file rerenders ONCE for its whole set of comments, not once per comment.
      const commentAnnotationsByFile = new Map();
      pierreComments.forEach(comment => {
        if (!commentAnnotationsByFile.has(comment.file)) {
          commentAnnotationsByFile.set(comment.file, []);
        }
        commentAnnotationsByFile.get(comment.file).push({
          lineNumber: comment.line_start,
          side: comment.side || 'RIGHT',
          type: 'comment',
          id: `comment-${comment.id}`,
          data: comment,
        });
      });
      for (const [file, annotations] of commentAnnotationsByFile) {
        this.pierreBridge.addAnnotations(file, annotations);
      }

      if (legacyComments.length > 0) {
        legacyComments.forEach(comment => {
          const fileElement = this.findFileElement(comment.file);
          if (!fileElement) return;

          const side = comment.side || 'RIGHT';
          const lineRows = fileElement.querySelectorAll('tr');
          for (const row of lineRows) {
            const lineNum = this.getLineNumber(row, side);
            if (lineNum === comment.line_start) {
              this.displayUserComment(comment, row);
              break;
            }
          }
        });
      }

      // Load file-level comments into their zones (only active comments reach here)
      if (this.fileCommentManager && fileLevelComments.length > 0) {
        // CodeView renders each file-comments zone as a lineNumber:0 body
        // annotation on the next frame; loadFileComments locates zones via the
        // DOM, so wait for the slotting pass first or the cards land nowhere on
        // a fresh load/refresh (a mounted file resolves slotted; a virtualized-
        // out file resolves not-mounted and its zone renders on scroll-in).
        if (this._usesPierreCodeView() && this.pierreBridge?.whenAnnotationsSlotted) {
          const files = [...new Set(fileLevelComments.map(c => c.file))];
          await Promise.all(files.map(f => {
            // A context-ONLY file has no plain-path item — await the REAL item id
            // (context:<path>) or whenAnnotationsSlotted resolves 'unknown-file'
            // instantly and hydration runs before the zone exists.
            const itemId = this._pierreItemIdForPath(f) || f;
            return this.pierreBridge.whenAnnotationsSlotted(itemId).catch(() => null);
          }));
        }
        this.fileCommentManager.loadFileComments(fileLevelComments, []);
      }

      // Populate AI Panel with all comments (including dismissed if requested)
      if (window.aiPanel?.setComments) {
        window.aiPanel.setComments(this.userComments);
      }

      this.updateCommentCount();

      // Refresh minimize-mode indicators (no-op when minimize mode is off)
      if (this.commentMinimizer) {
        this.commentMinimizer.refreshIndicators();
      }
    } catch (error) {
      console.error('Error loading user comments:', error);
    }
  }

  /**
   * Load AI suggestions from API
   * @param {string} level - Optional level filter ('final', '1', '2', '3')
   * @param {string} runId - Optional analysis run ID (defaults to latest)
   */
  async loadAISuggestions(level = null, runId = null) {
    if (!this.currentPR) return;

    try {
      const { owner, repo, number } = this.currentPR;

      // Use provided level, or fall back to current selectedLevel
      const filterLevel = level || this.selectedLevel || 'final';
      // Use provided runId, or fall back to selectedRunId (which may be null for latest)
      const filterRunId = runId !== undefined ? runId : this.selectedRunId;

      // First, check if analysis has been run for this PR and get summary for the selected run
      let analysisHasRun = false;
      try {
        const id = this.currentPR.id;
        let checkUrl = `/api/reviews/${id}/suggestions/check`;
        if (filterRunId) {
          checkUrl += `?runId=${filterRunId}`;
        }
        const checkResponse = await fetch(checkUrl);
        if (checkResponse.ok) {
          const checkData = await checkResponse.json();
          analysisHasRun = checkData.analysisHasRun;

          // Store summary data in the AI panel for the AI Summary modal
          if (window.aiPanel?.setSummaryData) {
            window.aiPanel.setSummaryData({
              summary: checkData.summary,
              stats: checkData.stats
            });
          }
        }
      } catch (checkError) {
        console.warn('Error checking analysis status:', checkError);
      }

      // Set the analysis state on the AI panel BEFORE loading suggestions
      // This ensures the correct empty state is shown
      if (window.aiPanel?.setAnalysisState) {
        window.aiPanel.setAnalysisState(analysisHasRun ? 'complete' : 'unknown');
      }

      let url = `/api/reviews/${this.currentPR.id}/suggestions?levels=${filterLevel}`;
      if (filterRunId) {
        url += `&runId=${filterRunId}`;
      }

      const response = await fetch(url);
      if (!response.ok) return;

      const data = await response.json();
      if (data.suggestions && data.suggestions.length > 0) {
        await this.displayAISuggestions(data.suggestions);
      } else {
        // Clear existing suggestions if none returned for this level
        await this.displayAISuggestions([]);
      }
    } catch (error) {
      console.error('Error loading AI suggestions:', error);
    }
  }

  /**
   * AI Suggestion methods - delegate to SuggestionManager
   */
  findHiddenSuggestions(suggestions) {
    return this.suggestionManager.findHiddenSuggestions(suggestions);
  }

  async displayAISuggestions(suggestions) {
    await this.suggestionManager.displayAISuggestions(suggestions);
    // Refresh minimize-mode indicators (no-op when minimize mode is off)
    if (this.commentMinimizer) {
      this.commentMinimizer.refreshIndicators();
    }
  }

  createSuggestionRow(suggestions) {
    return this.suggestionManager.createSuggestionRow(suggestions);
  }

  extractSuggestionData(suggestionDiv) {
    return this.suggestionManager.extractSuggestionData(suggestionDiv);
  }

  getFileAndLineInfo(suggestionDiv) {
    return this.suggestionManager.getFileAndLineInfo(suggestionDiv);
  }

  getCategoryEmoji(category) {
    return this.suggestionManager.getCategoryEmoji(category);
  }

  getTypeDescription(type) {
    return this.suggestionManager.getTypeDescription(type);
  }

  /**
   * Collapse a suggestion div in the UI after adoption.
   * Handles adding collapsed class, setting the 'Adopted' state tooltip,
   * updating the restore button, and setting hiddenForAdoption flag.
   *
   * With legacy rendering, `suggestionRow` is the `<tr>` containing the
   * suggestion. With @pierre/diffs there is no `<tr>`, so callers pass null
   * and this method falls back to a document-wide lookup by id.
   *
   * @param {HTMLElement|null} suggestionRow - The suggestion row element (legacy only)
   * @param {number|string} suggestionId - Suggestion ID
   */
  collapseSuggestionForAdoption(suggestionRow, suggestionId) {
    const targetDiv = suggestionRow
      ? suggestionRow.querySelector(`[data-suggestion-id="${suggestionId}"]`)
      : document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
    if (!targetDiv) return;
    targetDiv.classList.add('collapsed');
    window.SuggestionUI?.setCollapsedStateTooltip?.(targetDiv, 'Adopted');
    const restoreButton = targetDiv.querySelector('.btn-restore');
    if (restoreButton) {
      restoreButton.title = 'Show suggestion';
      const btnText = restoreButton.querySelector('.btn-text');
      if (btnText) btnText.textContent = 'Show';
    }
    targetDiv.dataset.hiddenForAdoption = 'true';
  }

  /**
   * Render an adopted user comment in the appropriate rendering engine.
   *
   * For files rendered by @pierre/diffs, `suggestionRow` is null (suggestions
   * are annotations, not table rows). Add the comment as a Pierre annotation
   * so it slots into the shadow DOM alongside the collapsed suggestion.
   *
   * For legacy (table-based) rendering, delegate to the existing
   * `displayUserComment(comment, suggestionRow)` which inserts a `<tr>`.
   *
   * @param {Object} comment - The newly-adopted comment
   * @param {HTMLElement|null} suggestionRow - Legacy table row, or null for Pierre
   * @private
   */
  async _renderAdoptedUserComment(comment, suggestionRow) {
    if (this.pierreBridge && comment.file && this.pierreBridge.files.has(comment.file)) {
      // Reveal the target line if it sits inside a collapsed gap — otherwise
      // the annotation has no DOM row to attach to and never renders.
      await this.ensureLinesVisible([{
        file: comment.file,
        line_start: comment.line_start,
        line_end: comment.line_end || comment.line_start,
        side: comment.side || 'RIGHT',
      }]);
      this.pierreBridge.addAnnotation(comment.file, {
        lineNumber: comment.line_start,
        side: comment.side || 'RIGHT',
        type: 'comment',
        id: `comment-${comment.id}`,
        data: comment,
      });
      return;
    }
    // Legacy path: displayUserComment inserts a <tr> after suggestionRow
    this.displayUserComment(comment, suggestionRow);
  }

  /**
   * Build a user comment object from adoption/edit response data.
   * Single source of truth for comment shape — used by both adopt-as-is
   * and edit-then-adopt flows.
   */
  _buildCommentObject({ userCommentId, formattedBody, fileName, lineNumber, lineEnd, suggestionType, suggestionTitle, suggestionId, diffPosition, side }) {
    return {
      id: userCommentId,
      file: fileName,
      line_start: parseInt(lineNumber),
      line_end: lineEnd ? parseInt(lineEnd) : null,
      body: formattedBody,
      type: suggestionType,
      title: suggestionTitle,
      parent_id: suggestionId,
      diff_position: diffPosition ? parseInt(diffPosition) : null,
      side: side || 'RIGHT',
      created_at: new Date().toISOString()
    };
  }

  /**
   * Helper for adoptSuggestion (adopt-as-is flow).
   * Performs the /adopt fetch, collapses the suggestion, formats the comment,
   * and builds the newComment object. Returns { newComment, suggestionRow }
   * or null on failure. Throws on errors so the caller can handle them.
   */
  async _adoptAndBuildComment(suggestionId, suggestionDiv) {
    const { suggestionText, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
    const { suggestionRow, lineNumber, lineEnd, fileName, diffPosition, side, isFileLevel } = this.getFileAndLineInfo(suggestionDiv);

    // File-level suggestions are handled by FileCommentManager; signal the caller
    if (isFileLevel) {
      return { isFileLevel: true, suggestionText, suggestionType, suggestionTitle, fileName, suggestionRow };
    }

    // Use the atomic /adopt endpoint which creates the user comment, sets parent_id
    // linkage, and updates suggestion status to 'adopted' in a single request
    const reviewId = this.currentPR?.id;
    const adoptResponse = await fetch(`/api/reviews/${reviewId}/suggestions/${suggestionId}/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!adoptResponse.ok) throw new Error('Failed to adopt suggestion');

    const adoptResult = await adoptResponse.json();

    // Collapse the suggestion in the UI
    this.collapseSuggestionForAdoption(suggestionRow, suggestionId);

    const newComment = this._buildCommentObject({
      userCommentId: adoptResult.userCommentId,
      formattedBody: adoptResult.formattedBody,
      fileName, lineNumber, lineEnd, suggestionType, suggestionTitle,
      suggestionId, diffPosition, side
    });

    return { isFileLevel: false, newComment, suggestionRow };
  }

  /**
   * Notify panels and navigator after a successful adoption
   */
  /**
   * Optimistically register a just-created comment in this.userComments and
   * refresh the data-backed count. The array is otherwise only assigned
   * wholesale (init + loadUserComments) with no push/splice, so any optimistic
   * create (suggestion adoption, file-level comment) MUST funnel through here or
   * _countActiveUserComments — and everything derived from it (SplitButton
   * count, review-button text, Clear-All enablement, REQUEST_CHANGES validation)
   * — stays stale until a WebSocket-triggered reload. Rendering stays with the
   * caller; this owns only the data + count. Upserts by id and forces an ACTIVE
   * status because the count filters out status === 'inactive'.
   * @param {Object} comment - the created comment (server response shape)
   */
  _registerOptimisticUserComment(comment) {
    if (!comment || comment.id == null) { this.updateCommentCount(); return; }
    if (!Array.isArray(this.userComments)) this.userComments = [];
    const existing = this.userComments.find(c => c && String(c.id) === String(comment.id));
    if (existing) {
      Object.assign(existing, comment);
      if (existing.status === 'inactive') existing.status = 'active';
    } else {
      this.userComments.push({ ...comment, status: comment.status || 'active' });
    }
    this.updateCommentCount();
  }

  /**
   * Remove file-level comment cards from EVERY zone, including the zones the
   * virtualized CodeView has detached from the document. Those zones live on in
   * `_fileCommentZones` and are re-slotted verbatim when their file scrolls back
   * in, so a `document.querySelectorAll` sweep leaves cards that resurrect later
   * — with no data-side backstop, since file-level comments keep their bridge
   * annotation and the reload path re-renders zones only when there are
   * file-level comments left to render.
   * @param {string} selector - card selector to remove within each zone
   * @private
   */
  _purgeFileCommentCards(selector) {
    const zones = new Set(document.querySelectorAll('.file-comments-zone'));
    for (const zone of this._fileCommentZones?.values() || []) zones.add(zone);
    for (const zone of zones) {
      let removed = 0;
      for (const card of zone.querySelectorAll(selector)) {
        card.remove();
        removed++;
      }
      if (removed && this.fileCommentManager) {
        this.fileCommentManager.updateCommentCount(zone);
      }
    }
  }

  /**
   * Mark an already-deleted comment inactive in the count-backing data model and
   * repaint the count. The delete direction of _registerOptimisticUserComment.
   *
   * The two delete flows each used to own only HALF of this invariant:
   * deleteUserComment flipped the status but repainted the count only inside its
   * DOM-removal branches (deleting a virtualized-out comment from the AI panel
   * found neither row nor card, so the count never repainted), while
   * FileCommentManager.deleteFileComment always repainted but never flipped the
   * status (so the data-backed count kept counting the deleted comment until a
   * full reload). DOM removal stays with the callers; this owns the data + count
   * and repaints UNCONDITIONALLY. Line comments also drop their bridge
   * annotation, or the comment resurrects when the file remounts.
   * @param {number|string} commentId - the deleted comment's id
   */
  _markCommentDeleted(commentId) {
    const comment = Array.isArray(this.userComments)
      ? this.userComments.find(c => c && String(c.id) === String(commentId))
      : null;
    if (comment) {
      if (this.pierreBridge && comment.file && comment.is_file_level !== 1) {
        this.pierreBridge.removeAnnotation(comment.file, `comment-${commentId}`);
      }
      comment.status = 'inactive';
    }
    this.updateCommentCount();
  }

  _notifyAdoption(suggestionId, newComment) {
    if (window.aiPanel?.addComment) {
      window.aiPanel.addComment(newComment);
    }

    if (this.suggestionNavigator?.suggestions) {
      const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
        s.id === suggestionId ? { ...s, status: 'adopted' } : s
      );
      this.suggestionNavigator.updateSuggestions(updatedSuggestions);
    }

    if (window.aiPanel) {
      window.aiPanel.updateFindingStatus(suggestionId, 'adopted');
    }

    // Add the adopted comment to the count-backing array (the panel got it via
    // addComment above); a bare updateCommentCount here would count a stale array.
    this._registerOptimisticUserComment(newComment);

    // Refresh minimize-mode indicators so the adopted comment is reflected
    if (this.commentMinimizer) {
      this.commentMinimizer.refreshIndicators();
    }
  }

  /**
   * Open an AI suggestion in edit mode without adopting it yet.
   * The suggestion is only adopted when the user clicks Save/Adopt.
   */
  async editAndAdoptSuggestion(suggestionId) {
    try {
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (!suggestionDiv) throw new Error('Suggestion element not found');

      const { suggestionText, formattedBody, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
      const { suggestionRow, lineNumber, lineEnd, fileName, diffPosition, side, isFileLevel } = this.getFileAndLineInfo(suggestionDiv);

      if (isFileLevel) {
        if (!this.fileCommentManager) throw new Error('FileCommentManager not initialized');
        const zone = this.fileCommentManager.findZoneForFile(fileName);
        if (!zone) throw new Error(`Could not find file comments zone for ${fileName}`);

        const suggestion = {
          id: suggestionId,
          file: fileName,
          body: suggestionText,
          formattedBody,
          type: suggestionType,
          title: suggestionTitle
        };

        this.fileCommentManager.editAndAdoptAISuggestion(zone, suggestion);
        return;
      }

      // Line-level: show edit form WITHOUT adopting yet
      const suggestion = {
        id: suggestionId,
        file: fileName,
        body: formattedBody || suggestionText,
        type: suggestionType,
        title: suggestionTitle,
        lineNumber,
        lineEnd,
        diffPosition,
        side
      };

      // Pierre-rendered files: suggestions live as annotations (no <tr>),
      // so `displaySuggestionEditForm` — which inserts a table row after
      // `suggestionRow` — cannot run. Open the edit form as a comment-form
      // annotation on the same line, pre-filled with the suggestion body,
      // and wire a custom submit that runs the adopt-edited flow.
      if (this.pierreBridge && this.pierreBridge.files.has(fileName)) {
        const formId = `edit-suggestion-${suggestionId}`;
        const onAdoptEdited = async (editedText, _fileName, annotationId) => {
          const reviewId = this.currentPR?.id;
          const editResponse = await fetch(`/api/reviews/${reviewId}/suggestions/${suggestionId}/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'adopt_edited', editedText })
          });
          if (!editResponse.ok) throw new Error('Failed to adopt suggestion with edits');
          const editResult = await editResponse.json();

          // Collapse the suggestion annotation and render the new comment.
          this.collapseSuggestionForAdoption(null, suggestionId);
          const newComment = this._buildCommentObject({
            userCommentId: editResult.userCommentId,
            formattedBody: editResult.formattedBody,
            fileName, lineNumber, lineEnd, suggestionType, suggestionTitle,
            suggestionId, diffPosition, side
          });

          // Remove the edit form annotation and add the comment annotation.
          this.pierreBridge.removeAnnotation(fileName, annotationId);
          await this._renderAdoptedUserComment(newComment, null);
          this._notifyAdoption(suggestionId, newComment);
        };

        this.pierreBridge.addAnnotation(fileName, {
          lineNumber: lineEnd || lineNumber,
          side: side || 'RIGHT',
          type: 'comment-form',
          id: formId,
          data: {
            headerTitle: 'Edit suggestion',
            lineStart: lineNumber,
            lineEnd: lineEnd || lineNumber,
            fileName: fileName,
            diffPosition: diffPosition,
            side: side || 'RIGHT',
            showSuggestionBtn: true,
            initialValue: formattedBody || suggestionText,
            customSubmit: onAdoptEdited,
          },
        });
        return;
      }

      this.commentManager.displaySuggestionEditForm(
        suggestion,
        suggestionRow,
        async (editedText) => {
          // User clicked Save — now adopt via /edit endpoint
          try {
            const reviewId = this.currentPR?.id;
            const editResponse = await fetch(`/api/reviews/${reviewId}/suggestions/${suggestionId}/edit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'adopt_edited', editedText })
            });

            if (!editResponse.ok) throw new Error('Failed to adopt suggestion with edits');
            const editResult = await editResponse.json();

            // Collapse the suggestion card
            this.collapseSuggestionForAdoption(suggestionRow, suggestionId);

            const newComment = this._buildCommentObject({
              userCommentId: editResult.userCommentId,
              formattedBody: editResult.formattedBody,
              fileName, lineNumber, lineEnd, suggestionType, suggestionTitle,
              suggestionId, diffPosition, side
            });
            await this._renderAdoptedUserComment(newComment, suggestionRow);
            this._notifyAdoption(suggestionId, newComment);
            window.chatPanel?.queueUserActionHint(`[User Action: adopted suggestion ${suggestionId}]`);
          } catch (error) {
            console.error('Error saving edited suggestion:', error);
            alert(`Failed to save suggestion: ${error.message}`);
            throw error; // Re-throw so displaySuggestionEditForm can re-enable the save button
          }
        },
        () => {
          // User clicked Cancel — nothing to revert
        }
      );
    } catch (error) {
      console.error('Error editing suggestion:', error);
      alert(`Failed to edit suggestion: ${error.message}`);
    }
  }

  /**
   * Adopt an AI suggestion directly
   */
  async adoptSuggestion(suggestionId) {
    try {
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (!suggestionDiv) throw new Error('Suggestion element not found');

      const result = await this._adoptAndBuildComment(suggestionId, suggestionDiv);

      if (result.isFileLevel) {
        if (!this.fileCommentManager) throw new Error('FileCommentManager not initialized');
        const zone = this.fileCommentManager.findZoneForFile(result.fileName);
        if (!zone) throw new Error(`Could not find file comments zone for ${result.fileName}`);

        const suggestion = {
          id: suggestionId,
          file: result.fileName,
          body: result.suggestionText,
          type: result.suggestionType,
          title: result.suggestionTitle
        };

        await this.fileCommentManager.adoptAISuggestion(zone, suggestion);
        return;
      }

      await this._renderAdoptedUserComment(result.newComment, result.suggestionRow);
      this._notifyAdoption(suggestionId, result.newComment);
      window.chatPanel?.queueUserActionHint(`[User Action: adopted suggestion ${suggestionId}]`);
    } catch (error) {
      console.error('Error adopting suggestion:', error);
      alert(`Failed to adopt suggestion: ${error.message}`);
    }
  }

  /**
   * Dismiss an AI suggestion
   * If the suggestion was adopted (hiddenForAdoption === 'true' on the suggestion div),
   * only toggle visibility without changing the underlying status - the suggestion remains "adopted"
   */
  async dismissSuggestion(suggestionId) {
    try {
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);

      // If this suggestion was adopted, only toggle visibility - don't change status
      // The adoption still exists (there's a user comment linked to this suggestion)
      if (suggestionDiv?.dataset?.hiddenForAdoption === 'true') {
        // suggestionDiv is guaranteed to exist since we just queried for it.
        // The suggestion stays adopted here; we only re-hide it, so the
        // collapsed-bar tooltip keeps reading 'Adopted'.
        suggestionDiv.classList.add('collapsed');
        window.SuggestionUI?.setCollapsedStateTooltip?.(suggestionDiv, 'Adopted');

        const button = suggestionDiv.querySelector('.btn-restore');
        if (button) {
          button.title = 'Show suggestion';
          const btnText = button.querySelector('.btn-text');
          if (btnText) btnText.textContent = 'Show';
        }
        return;
      }

      const response = await fetch(`/api/reviews/${this.currentPR.id}/suggestions/${suggestionId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed' })
      });

      if (!response.ok) throw new Error('Failed to dismiss suggestion');

      if (suggestionDiv) {
        suggestionDiv.classList.add('collapsed');
        window.SuggestionUI?.setCollapsedStateTooltip?.(suggestionDiv, 'Dismissed');
        const restoreButton = suggestionDiv.querySelector('.btn-restore');
        if (restoreButton) {
          restoreButton.title = 'Show suggestion';
          const btnText = restoreButton.querySelector('.btn-text');
          if (btnText) btnText.textContent = 'Show';
        }
      }

      if (this.suggestionNavigator?.suggestions) {
        const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
          s.id === suggestionId ? { ...s, status: 'dismissed' } : s
        );
        this.suggestionNavigator.updateSuggestions(updatedSuggestions);
      }

      if (window.aiPanel) {
        window.aiPanel.updateFindingStatus(suggestionId, 'dismissed');
      }

      // Refresh minimize-mode indicators after suggestion state change
      if (this.commentMinimizer) {
        this.commentMinimizer.refreshIndicators();
      }

      window.chatPanel?.queueUserActionHint(`[User Action: dismissed suggestion ${suggestionId}]`);
    } catch (error) {
      console.error('Error dismissing suggestion:', error);
      alert('Failed to dismiss suggestion');
    }
  }

  /**
   * Restore a dismissed AI suggestion
   */
  async restoreSuggestion(suggestionId) {
    try {
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);

      if (suggestionDiv?.dataset?.hiddenForAdoption === 'true') {
        // Use suggestionDiv (found by ID) not suggestionRow.querySelector('.ai-suggestion')
        // because multiple suggestions can share the same row when they target the same line
        suggestionDiv.classList.toggle('collapsed');

        // Find the button within this specific suggestion div, not the first one in the row
        const button = suggestionDiv.querySelector('.btn-restore');
        const isNowCollapsed = suggestionDiv.classList.contains('collapsed');
        if (button) {
          button.title = isNowCollapsed ? 'Show suggestion' : 'Hide suggestion';
          button.querySelector('.btn-text').textContent = isNowCollapsed ? 'Show' : 'Hide';
        }
        // Still adopted; keep the 'Adopted' tooltip only while re-hidden.
        window.SuggestionUI?.setCollapsedStateTooltip?.(suggestionDiv, isNowCollapsed ? 'Adopted' : '');
        return;
      }

      const response = await fetch(`/api/reviews/${this.currentPR.id}/suggestions/${suggestionId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' })
      });

      if (!response.ok) throw new Error('Failed to restore suggestion');

      if (suggestionDiv) {
        suggestionDiv.classList.remove('collapsed');
        // Restored to active — clear the collapsed-bar state tooltip.
        window.SuggestionUI?.setCollapsedStateTooltip?.(suggestionDiv, '');
        // Strip stale dismissal-reason markup (note + popover attr/brain button)
        // baked in while dismissed; same-tab broadcasts are suppressed so no
        // refetch rescues this card.
        window.SuggestionUI?.clearDismissalReasonUI?.(suggestionDiv);
      }

      if (this.suggestionNavigator?.suggestions) {
        const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
          s.id === suggestionId ? { ...s, status: 'active' } : s
        );
        this.suggestionNavigator.updateSuggestions(updatedSuggestions);
      }

      if (window.aiPanel) {
        window.aiPanel.updateFindingStatus(suggestionId, 'active');
      }

      // Refresh minimize-mode indicators after suggestion state change
      if (this.commentMinimizer) {
        this.commentMinimizer.refreshIndicators();
      }

      window.chatPanel?.queueUserActionHint(`[User Action: restored suggestion ${suggestionId}]`);
    } catch (error) {
      console.error('Error restoring suggestion:', error);
      alert('Failed to restore suggestion');
    }
  }

  /**
   * Toggle original suggestion visibility
   */
  toggleOriginalSuggestion(parentId, commentId) {
    const suggestionRow = document.querySelector(`[data-suggestion-id="${parentId}"]`);
    if (!suggestionRow) return;

    if (suggestionRow.style.display === 'none') {
      suggestionRow.style.display = '';
      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      const eyeButton = commentRow?.querySelector('.btn-toggle-original');
      if (eyeButton) {
        eyeButton.classList.add('showing-original');
        eyeButton.title = 'Hide original AI suggestion';
      }
    } else {
      suggestionRow.style.display = 'none';
      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      const eyeButton = commentRow?.querySelector('.btn-toggle-original');
      if (eyeButton) {
        eyeButton.classList.remove('showing-original');
        eyeButton.title = 'Show original AI suggestion';
      }
    }
  }

  /**
   * Initialize split button for review actions
   */
  initSplitButton() {
    if (window.SplitButton) {
      const placeholder = document.getElementById('split-button-placeholder');
      if (placeholder) {
        // Destroy existing split button if present to prevent duplicates on refresh
        if (this.splitButton) {
          this.splitButton.destroy();
        }
        // Clear placeholder in case of any orphaned elements
        placeholder.innerHTML = '';

        const shareConfig = window.__pairReview?.share;
        let validatedShareUrl = null;
        if (shareConfig?.url) {
          try {
            new URL(shareConfig.url);
            validatedShareUrl = shareConfig.url;
          } catch {
            // Invalid share URL in config — don't render share button
          }
        }
        this.splitButton = new window.SplitButton({
          onSubmit: () => this.openReviewModal(),
          onPreview: () => this.openPreviewModal(),
          onClear: () => this.clearAllUserComments(),
          onShare: () => this.openSharePage(),
          shareUrl: validatedShareUrl,
          shareIcon: shareConfig?.icon || null,
          shareLabel: shareConfig?.label || 'Share',
          shareDescription: shareConfig?.description || null
        });
        const buttonElement = this.splitButton.render();
        placeholder.appendChild(buttonElement);
        this.updateCommentCount();

        // Handle late config arrival — update share config when config fetch resolves
        window.addEventListener('chat-state-changed', () => {
          const lateCfg = window.__pairReview?.share;
          if (this.splitButton) {
            this.splitButton.setShareConfig(lateCfg || null);
          }
        }, { once: true });
      }
    }
  }

  /**
   * Open review modal
   */
  openReviewModal() {
    if (!this.reviewModal) {
      this.reviewModal = new ReviewModal();
    }
    this.reviewModal.show();
  }

  /**
   * Open preview modal
   */
  openPreviewModal() {
    if (!this.previewModal) {
      this.previewModal = new PreviewModal();
    }
    this.previewModal.show();
  }

  /**
   * Open share page in a new tab
   * Builds the share URL with a callback_url pointing to this PR's share endpoint
   * Validates that there is analysis data to share before opening.
   */
  async openSharePage() {
    const shareConfig = window.__pairReview?.share;
    if (!shareConfig?.url) return;

    const pr = this.currentPR;
    if (!pr) return;

    // Validate the share URL before attempting to use it
    let shareUrl;
    try {
      shareUrl = new URL(shareConfig.url);
    } catch {
      console.error('Invalid share URL in configuration:', shareConfig.url);
      return;
    }

    // Build the callback URL for the share endpoint
    let callbackUrl = `${window.location.origin}/api/pr/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/${pr.number}/share`;

    // Include selected run ID if one is explicitly selected
    if (this.selectedRunId) {
      callbackUrl += `?runId=${encodeURIComponent(this.selectedRunId)}`;
    }

    // Check that there is analysis data to share before opening the page
    try {
      const response = await fetch(callbackUrl);
      if (!response.ok) {
        if (window.toast) {
          window.toast.showError('Unable to share: could not load review data');
        }
        return;
      }
      const data = await response.json().catch(() => null);
      if (!data) {
        if (window.toast) {
          window.toast.showError('Unable to share: unexpected response from server');
        }
        return;
      }
      if (!data.run) {
        if (window.toast) {
          window.toast.showError('Nothing to share: no completed analysis found. Run an AI analysis first.');
        }
        return;
      }
    } catch (error) {
      console.error('Error checking share data:', error);
      if (window.toast) {
        window.toast.showError('Unable to share: ' + error.message);
      }
      return;
    }

    shareUrl.searchParams.set('callback_url', callbackUrl);
    window.open(shareUrl.toString(), '_blank');
  }

  /**
   * Update comment count display
   * Note: Dismissed comments are never in the diff DOM (design decision), so we simply count all visible elements.
   */
  /**
   * Number of active user comments (line + file level) for count/validation UI
   * (SplitButton "Clear All", review button, submit validation).
   *
   * Under CodeView, comment cards slot into the DOM asynchronously (next rAF)
   * and virtualized-out files render no card at all, so a `document.querySelector`
   * count RACES the render and undercounts — e.g. right after a save the card
   * has not slotted yet, so Clear All stays disabled. Count from the loaded
   * comment data instead, which is exact and virtualization-independent. Legacy
   * (per-file table) rendering is synchronous, so its DOM count is reliable and
   * remains the path there (and the fallback before comment data has loaded).
   * @returns {number}
   */
  _countActiveUserComments() {
    if (this._usesPierreCodeView() && Array.isArray(this.userComments)) {
      return this.userComments.filter(c => c && c.status !== 'inactive').length;
    }
    const lineComments = document.querySelectorAll('.user-comment-row:not(.suggestion-edit-pending)').length;
    const fileComments = document.querySelectorAll('.file-comment-card.user-comment').length;
    return lineComments + fileComments;
  }

  updateCommentCount() {
    const userComments = this._countActiveUserComments();

    if (this.splitButton) {
      this.splitButton.updateCommentCount(userComments);
    }

    const reviewButton = document.getElementById('review-button');
    if (reviewButton) {
      const buttonText = reviewButton.querySelector('.review-button-text');
      if (buttonText) {
        buttonText.textContent = `${userComments} ${userComments === 1 ? 'comment' : 'comments'}`;
      }

      if (userComments > 0) {
        reviewButton.classList.add('has-comments');
      } else {
        reviewButton.classList.remove('has-comments');
      }
    }

    const clearButton = document.getElementById('clear-comments-btn');
    if (clearButton) {
      clearButton.disabled = userComments === 0;
    }
  }

  /**
   * Submit review to GitHub
   */
  async submitReview() {
    const reviewEvent = document.getElementById('review-event').value;
    const reviewBody = document.getElementById('review-body').value.trim();
    const submitBtn = document.getElementById('submit-review-btn');

    // Count BOTH line-level and file-level comments for validation. Uses the
    // data-backed count under CodeView (a DOM count races the async annotation
    // slot / undercounts virtualized-out files).
    const totalComments = this._countActiveUserComments();
    if (reviewEvent === 'REQUEST_CHANGES' && !reviewBody && totalComments === 0) {
      alert('Please add comments or a review summary when requesting changes.');
      return;
    }

    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Submitting...';
    submitBtn.disabled = true;

    try {
      const response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/submit-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: reviewEvent, body: reviewBody })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to submit review');
      }

      const result = await response.json();
      alert(`Review submitted successfully! ${result.message}`);

      document.getElementById('review-body').value = '';
      document.getElementById('review-event').value = 'COMMENT';

    } catch (error) {
      console.error('Error submitting review:', error);
      alert(`Failed to submit review: ${error.message}`);
    } finally {
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  }

  /**
   * Escape HTML characters
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Show error message
   */
  showError(message) {
    const container = document.getElementById('pr-container');
    if (!container) return;

    container.innerHTML = `
      <div class="error-container">
        <div class="error-icon">Warning</div>
        <div class="error-message">${this.escapeHtml(message)}</div>
        <button class="btn btn-secondary" onclick="window.location.reload()">Retry</button>
      </div>
    `;
    container.style.display = 'block';
  }

  /**
   * Format date for display
   */
  formatDate(dateString) {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (error) {
      return dateString;
    }
  }

  /**
   * Format description
   */
  formatDescription(description) {
    return this.escapeHtml(description)
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }

  /**
   * Initialize suggestion navigator
   */
  initSuggestionNavigator() {
    if (window.SuggestionNavigator) {
      this.suggestionNavigator = new window.SuggestionNavigator();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (window.SuggestionNavigator) {
          this.suggestionNavigator = new window.SuggestionNavigator();
        }
      });
    }
  }

  /**
   * Initialize keyboard shortcuts manager
   */
  initKeyboardShortcuts() {
    if (!window.KeyboardShortcuts) {
      console.warn('KeyboardShortcuts component not loaded');
      return;
    }

    this.keyboardShortcuts = new window.KeyboardShortcuts({
      onCopyComments: () => this.copyCommentsToClipboard(),
      onClearComments: () => this.clearAllUserComments(),
      onNextSuggestion: () => this.suggestionNavigator?.goToNext(),
      onPrevSuggestion: () => this.suggestionNavigator?.goToPrevious()
    });
  }

  /**
   * Copy user comments to clipboard as markdown
   * Used by keyboard shortcut 'c c'
   */
  async copyCommentsToClipboard() {
    try {
      // Get current PR from prManager
      const pr = this.currentPR;
      if (!pr) {
        if (window.toast) {
          window.toast.showWarning('No PR loaded');
        }
        return;
      }

      // Use unified review comments API (works for both PR and local mode)
      const reviewId = pr.id;
      let response;
      response = await fetch(`/api/reviews/${reviewId}/comments`);

      if (!response.ok) {
        throw new Error('Failed to load comments');
      }

      const data = await response.json();
      const comments = data.comments || [];

      if (comments.length === 0) {
        if (window.toast) {
          window.toast.showInfo('No comments to copy');
        }
        return;
      }

      // Format comments using PreviewModal's static method
      if (!window.PreviewModal?.formatComments) {
        if (window.toast) {
          window.toast.showError('PreviewModal not available');
        }
        return;
      }
      const formattedText = window.PreviewModal.formatComments(comments);

      await navigator.clipboard.writeText(formattedText);

      if (window.toast) {
        window.toast.showSuccess('Comments copied to clipboard');
      }
    } catch (error) {
      console.error('Error copying comments to clipboard:', error);
      if (window.toast) {
        window.toast.showError('Failed to copy comments');
      }
    }
  }

  /**
   * File list methods
   */
  buildFileTree(files) {
    const tree = {};
    files.forEach(file => {
      const parts = file.file.split('/');
      let current = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        if (isFile) {
          if (!current._files) current._files = [];
          current._files.push({
            name: part,
            fullPath: file.file,
            status: this.getFileStatus(file),
            additions: file.insertions,
            deletions: file.deletions,
            binary: file.binary,
            generated: file.generated || false,
            renamed: file.renamed || false,
            renamedFrom: file.renamedFrom || null,
          });
        } else {
          if (!current[part]) current[part] = {};
          current = current[part];
        }
      }
    });
    return tree;
  }

  getFileStatus(file) {
    if (file.renamed) {
      if (file.insertions > 0 || file.deletions > 0) return 'modified';
      return 'renamed';
    }
    if (file.binary) return 'modified';
    if (!file.deletions || file.deletions === 0) return 'added';
    if (!file.insertions || file.insertions === 0) return 'deleted';
    return 'modified';
  }

  groupFilesByDirectory(files) {
    const groups = {};
    files.forEach(file => {
      const filePath = file.file;
      const lastSlashIndex = filePath.lastIndexOf('/');
      const dirPath = lastSlashIndex === -1 ? '.' : filePath.substring(0, lastSlashIndex);
      const fileName = lastSlashIndex === -1 ? filePath : filePath.substring(lastSlashIndex + 1);

      if (!groups[dirPath]) groups[dirPath] = [];
      groups[dirPath].push({
        name: fileName,
        fullPath: filePath,
        status: this.getFileStatus(file),
        additions: file.insertions,
        deletions: file.deletions,
        binary: file.binary,
        generated: file.generated || false,
        renamed: file.renamed || false,
        renamedFrom: file.renamedFrom || null,
        contextFile: file.contextFile || false,
        contextId: file.contextId || null,
        label: file.label || null,
        lineStart: file.lineStart || null,
        lineEnd: file.lineEnd || null,
      });
    });

    const sortedGroups = {};
    Object.keys(groups).sort().forEach(key => {
      sortedGroups[key] = groups[key];
    });
    return sortedGroups;
  }

  updateFileList(files) {
    // Store diff-only files for merging with context files later. Assigned before
    // the sidebar guard below: this is the data model the "diff wins" suppression
    // reads, and it must leave the not-loaded-yet null state even when there is
    // no sidebar to render into.
    this.diffFiles = files.filter(f => !f.contextFile);

    const fileListContainer = document.getElementById('file-list');
    if (!fileListContainer) return;

    // Update sidebar file count badge
    const fileCountEl = document.getElementById('sidebar-file-count');
    if (fileCountEl) {
      fileCountEl.textContent = files.length;
    }

    if (files.length === 0) {
      fileListContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--color-text-secondary);">No files changed</div>';
      return;
    }

    const groupedFiles = this.groupFilesByDirectory(files);
    fileListContainer.innerHTML = '';

    for (const [dirPath, dirFiles] of Object.entries(groupedFiles)) {
      const groupElement = this.renderFileGroup(dirPath, dirFiles);
      fileListContainer.appendChild(groupElement);
    }

    this.setupSidebarToggle();
  }

  renderFileGroup(dirPath, files) {
    const group = document.createElement('div');
    group.className = 'file-group';
    group.dataset.path = dirPath;

    const header = document.createElement('div');
    header.className = 'file-group-header';

    const chevron = document.createElement('span');
    chevron.className = 'file-group-chevron';
    chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M4.7 10c-.2 0-.4-.1-.5-.2-.3-.3-.3-.8 0-1.1L6.9 6 4.2 3.3c-.3-.3-.3-.8 0-1.1.3-.3.8-.3 1.1 0l3.3 3.3c.3.3.3.8 0 1.1L5.3 9.8c-.2.1-.4.2-.6.2Z"/></svg>`;

    const folderIcon = document.createElement('span');
    folderIcon.className = 'folder-icon';
    folderIcon.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>`;

    const dirName = document.createElement('span');
    dirName.textContent = dirPath === '.' ? '(root)' : dirPath;

    header.appendChild(chevron);
    header.appendChild(folderIcon);
    header.appendChild(dirName);
    group.appendChild(header);

    const fileList = document.createElement('div');
    fileList.className = 'file-group-items';

    files.forEach(file => {
      const fileItem = this.renderFileItem(file);
      fileList.appendChild(fileItem);
    });

    group.appendChild(fileList);
    group.classList.add('expanded');

    header.addEventListener('click', () => group.classList.toggle('expanded'));

    return group;
  }

  renderFileItem(file) {
    const item = document.createElement('a');
    item.className = 'file-item';
    item.href = `#${file.fullPath}`;
    item.dataset.path = file.fullPath;
    item.dataset.status = file.status;

    if (file.generated) item.classList.add('generated');
    if (file.contextFile) item.classList.add('context-file-item');
    // Context entries track viewed state under a context-scoped key so they
    // stay independent of a diff entry for the same file.
    const viewedKey = file.contextFile ? this._contextStateKey(file.fullPath) : file.fullPath;
    if (this.viewedFiles && this.viewedFiles.has(viewedKey)) {
      item.classList.add('viewed');
      const viewedIcon = this._createViewedIcon();
      item.insertBefore(viewedIcon, item.firstChild);
    }
    if (file.renamed && file.renamedFrom) {
      item.title = `Renamed from: ${file.renamedFrom}`;
      const renameIcon = document.createElement('span');
      renameIcon.className = 'file-rename-icon-wrapper';
      renameIcon.innerHTML = '<svg class="file-rename-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Zm9.03 6.03-3.25 3.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.97-1.97H4.75a.75.75 0 0 1 0-1.5h4.69L7.47 5.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l3.25 3.25a.75.75 0 0 1 0 1.06Z"/></svg>';
      item.appendChild(renameIcon);
    }

    const fileName = document.createElement('span');
    fileName.className = 'file-name';
    fileName.textContent = file.name;

    const changes = document.createElement('span');
    changes.className = 'file-changes';

    if (file.contextFile) {
      const badge = document.createElement('span');
      badge.className = 'context-badge';
      badge.textContent = 'CONTEXT';
      if (file.label) badge.title = file.label;
      changes.appendChild(badge);
    } else if (file.binary) {
      changes.textContent = 'BIN';
    } else {
      if (file.additions > 0) {
        const addSpan = document.createElement('span');
        addSpan.className = 'file-additions';
        addSpan.textContent = `+${file.additions}`;
        changes.appendChild(addSpan);
      }
      if (file.deletions > 0) {
        const delSpan = document.createElement('span');
        delSpan.className = 'file-deletions';
        delSpan.textContent = `-${file.deletions}`;
        changes.appendChild(delSpan);
      }
    }

    item.appendChild(fileName);
    item.appendChild(changes);

    item.addEventListener('click', (e) => {
      e.preventDefault();
      if (file.contextFile) {
        this.scrollToContextFile(file.fullPath, file.lineStart, file.contextId);
      } else {
        this.scrollToFile(file.fullPath);
      }
      this.setActiveFileItem(file.fullPath);
    });

    return item;
  }

  setActiveFileItem(filePath) {
    document.querySelectorAll('.file-item.active').forEach(item => item.classList.remove('active'));
    const fileItem = document.querySelector(`.file-item[data-path="${filePath}"]`);
    if (fileItem) fileItem.classList.add('active');
  }

  setupSidebarToggle() {
    const sidebar = document.getElementById('files-sidebar');
    const toggleBtn = document.getElementById('sidebar-collapse-btn');
    const collapsedBtn = document.getElementById('sidebar-toggle-collapsed');

    if (!sidebar || !toggleBtn || !collapsedBtn) return;

    // Helper to toggle sidebar with batched updates to prevent flicker
    // Batches class change and CSS variable update in a single frame
    const toggleSidebar = (collapse) => {
      const widthValue = collapse
        ? '0px'
        : `${window.PanelResizer?.getSavedWidth('sidebar')
            || window.PanelResizer?.getDefaultWidth('sidebar')
            || 260}px`;

      // Batch both changes in a single requestAnimationFrame to prevent double-reflow
      requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--sidebar-width', widthValue);
        if (collapse) {
          sidebar.classList.add('collapsed');
        } else {
          sidebar.classList.remove('collapsed');
        }
        localStorage.setItem('file-sidebar-collapsed', String(collapse));
      });
    };

    // Restore collapsed state from localStorage (synchronous on init is fine)
    const isCollapsed = localStorage.getItem('file-sidebar-collapsed') === 'true';
    if (isCollapsed) {
      sidebar.classList.add('collapsed');
      document.documentElement.style.setProperty('--sidebar-width', '0px');
    } else {
      const savedWidth = window.PanelResizer?.getSavedWidth('sidebar')
        || window.PanelResizer?.getDefaultWidth('sidebar')
        || 260;
      document.documentElement.style.setProperty('--sidebar-width', `${savedWidth}px`);
    }

    // Collapse button (X) in sidebar header - collapses sidebar
    toggleBtn.addEventListener('click', () => toggleSidebar(true));

    // Expand button in diff toolbar - expands sidebar
    collapsedBtn.addEventListener('click', () => toggleSidebar(false));
  }

  async scrollToFile(filePath) {
    // CodeView path: the bridge scrolls its virtualized root to the item, even
    // when the file is currently virtualized out of the DOM. Move the file to
    // the front of the content-upgrade queue first (mirrors the legacy hint).
    if (this._usesPierreCodeView() && this.pierreBridge.files.has(filePath)) {
      const fileState = this.pierreBridge.files.get(filePath);
      if (!fileState.collapsed) this._prioritizePierreContentUpgrade(filePath);
      await this._scrollToPierreItemWithStickyOffset(filePath);
      return;
    }

    const fileWrapper = this.findFileElement(filePath);
    if (fileWrapper) {
      // Render the body so the scroll target has its real height (an empty
      // lazy body would land the scroll at the wrong offset for expanded
      // files). Skip it for collapsed files: their body is display:none
      // (zero height) and `block: 'start'` aligns the header regardless, so
      // force-rendering would only pay the full renderPatch + per-line
      // highlight cost for content that stays hidden. scrollToFile does no
      // post-render row scan, so gating on `!collapsed` is safe; expanding
      // later still renders on demand via toggleFileCollapse.
      if (!fileWrapper.classList.contains('collapsed')) {
        await this.ensureFileBodyRendered(filePath);
        // Move this file to the front of the Pierre content-upgrade queue.
        // Collapsed files stay hidden and never upgrade, so they intentionally
        // get no priority hint.
        this._prioritizePierreContentUpgrade(filePath);
      }
      // Stable variant: lazy bodies between here and the target render as
      // the smooth scroll passes them, shifting layout mid-flight. The
      // helper re-corrects after the scroll settles so the first attempt
      // lands where the second used to.
      const scrollOptions = { behavior: 'smooth', block: 'start' };
      if (window.ScrollUtils?.scrollIntoViewStable) {
        await window.ScrollUtils.scrollIntoViewStable(fileWrapper, scrollOptions);
      } else {
        fileWrapper.scrollIntoView(scrollOptions);
      }
    }
  }

  /**
   * Scroll a CodeView item (diff file OR `context:<path>` reference) to the top
   * of the viewport, compensated for the preceding item's pinned sticky header.
   *
   * The vendor compensates line/range scrolls but not item scrolls, so every
   * whole-item jump needs this — context items render in the SAME CodeView with
   * the same sticky headers, so they need it identically.
   * @param {string} itemId - bridge item id (file path or `context:<path>`)
   * @private
   */
  async _scrollToPierreItemWithStickyOffset(itemId) {
    // --diff-file-header-height is measured by _measureFileHeaderHeight; fall
    // back to the vendor's own sticky offset if it is not set yet.
    const headerPx = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--diff-file-header-height')
    );
    const base = Number.isFinite(headerPx) && headerPx > 0
      ? headerPx
      : (this.pierreBridge.codeView
        && typeof this.pierreBridge.codeView.getStickyHeaderOffset === 'function'
          ? (this.pierreBridge.codeView.getStickyHeaderOffset() || 0)
          : 0);
    this.pierreBridge.scrollToFile(itemId, { align: 'start', behavior: 'smooth', stickyOffset: base });

    // A full header-height of compensation lands a normal file flush, but a
    // short / collapsed (header-only) target cannot absorb it and overshoots
    // (its header clipped above the toolbar); an unmeasured base undershoots.
    // The landing gap moves ~1:1 with the offset, so once the smooth scroll
    // settles, nudge the offset by the residual gap until flush. Corrections
    // are instant (no second glide) and bounded; tall targets land within
    // tolerance on the first pass and never enter the loop.
    const LANDING_TOLERANCE = 2;
    let gap = await this._awaitPierreNavGap(itemId);
    let comp = base;
    let guard = 0;
    while (gap != null && Math.abs(gap) > LANDING_TOLERANCE && guard++ < 3) {
      comp = Math.max(0, comp + gap);
      this.pierreBridge.scrollToFile(itemId, { align: 'start', behavior: 'auto', stickyOffset: comp });
      gap = await this._awaitPierreNavGap(itemId, { timeout: 400 });
    }
  }

  /**
   * The px gap between a CodeView item header's top and the scroll container's
   * top — 0 is flush under the toolbar, negative means the header is clipped
   * above it. Returns null when the target's header is not mounted (virtualized
   * out) so callers can keep waiting.
   *
   * Takes a bridge ITEM id, not a path: hosts carry `data-file-name` (the plain
   * path), so a file with both a diff item and a `context:<path>` item has two
   * matching hosts — the item's type picks the right one.
   * @param {string} itemId - bridge item id (file path or `context:<path>`)
   */
  _pierreNavGap(itemId) {
    const container = document.getElementById('diff-container');
    if (!container) return null;
    const fileState = this.pierreBridge?.files?.get(itemId);
    const fileName = fileState?.fileName || itemId;
    const base = `diffs-container[data-file-name="${CSS.escape(fileName)}"]`;
    const host = container.querySelector(
      fileState?.itemType === 'context' ? `${base}.context-file` : `${base}:not(.context-file)`
    );
    const header = host ? host.querySelector('.d2h-file-header') : null;
    if (!header) return null;
    return Math.round(
      header.getBoundingClientRect().top - container.getBoundingClientRect().top
    );
  }

  /**
   * Wait for a smooth scroll to a CodeView item to settle, then return the
   * landing gap (see _pierreNavGap). Polls per frame until the gap holds steady
   * (the target may still be mounting on the way in) or a timeout elapses.
   */
  async _awaitPierreNavGap(itemId, { timeout = 1200, stableFrames = 3 } = {}) {
    const start = performance.now();
    let last = null;
    let stable = 0;
    while (performance.now() - start < timeout) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const gap = this._pierreNavGap(itemId);
      if (gap == null) { last = null; stable = 0; continue; }
      if (last != null && Math.abs(gap - last) <= 1) {
        if (++stable >= stableFrames) return gap;
      } else {
        stable = 0;
      }
      last = gap;
    }
    return last;
  }

  setActiveFile(filePath) {
    this.setActiveFileItem(filePath);
    document.querySelectorAll('.tree-file.active').forEach(file => file.classList.remove('active'));
    const fileElement = document.querySelector(`.tree-file[data-path="${filePath}"]`);
    if (fileElement) fileElement.classList.add('active');
  }

  /**
   * Theme methods
   */
  initTheme() {
    // Shared helper (js/theme.js) owns preference storage, the
    // light → dark → system toggle cycle, the button icon, and the live
    // OS-change listener. We keep this.currentTheme as the *resolved* theme so
    // the diff renderer (@pierre/diffs) always receives a concrete
    // 'light'|'dark', never the 'system' preference.
    this._themeDispose = window.PairReviewTheme.setup({
      onChange: (resolved) => {
        this.currentTheme = resolved;
        if (this.pierreBridge) {
          this.pierreBridge.setTheme(resolved);
        }
      },
    });
  }

  savePanelStates() {
    const sidebar = document.getElementById('files-sidebar');
    const aiPanel = document.getElementById('ai-panel');
    const panelStates = {
      filesSidebar: sidebar ? sidebar.classList.contains('collapsed') : false,
      aiPanel: aiPanel ? aiPanel.classList.contains('collapsed') : false
    };
    localStorage.setItem('pair-review-panel-states', JSON.stringify(panelStates));
  }

  restorePanelStates() {
    const savedStates = localStorage.getItem('pair-review-panel-states');
    if (!savedStates) return;

    try {
      const panelStates = JSON.parse(savedStates);
      const sidebar = document.getElementById('files-sidebar');
      const aiPanel = document.getElementById('ai-panel');

      if (sidebar && panelStates.filesSidebar) sidebar.classList.add('collapsed');
      if (aiPanel && panelStates.aiPanel) aiPanel.classList.add('collapsed');
    } catch (e) {
      console.error('Failed to restore panel states:', e);
    }
  }

  /**
   * Initialize the analysis config modal
   */
  initAnalysisConfigModal() {
    if (window.AnalysisConfigModal) {
      this.analysisConfigModal = new window.AnalysisConfigModal();
      window.analysisConfigModal = this.analysisConfigModal;
    } else {
      console.warn('AnalysisConfigModal not loaded');
    }
  }

  /**
   * Get the Analyze with AI button
   */
  getAnalyzeButton() {
    return document.getElementById('analyze-btn') ||
           document.querySelector('button[onclick*="triggerAIAnalysis"]');
  }

  /**
   * Set button to analyzing state
   */
  setButtonAnalyzing(analysisId) {
    const btn = this.getAnalyzeButton();
    if (!btn) return;

    this.isAnalyzing = true;
    this.currentAnalysisId = analysisId;

    btn.classList.add('btn-analyzing');
    btn.disabled = false; // Keep clickable to reopen modal

    // Also highlight the split dropdown toggle if present
    const toggle = document.getElementById('analyze-stack-toggle');
    if (toggle) toggle.classList.add('btn-analyzing');

    const btnText = btn.querySelector('.btn-text');
    if (btnText) {
      // Insert the spinner before the label (guard against a double-call
      // stacking two spinners), then switch the label.
      if (!btn.querySelector('.btn-spinner')) {
        const spinner = document.createElement('span');
        spinner.className = 'btn-spinner';
        btn.insertBefore(spinner, btnText);
      }
      btnText.textContent = 'Analyzing...';
    } else {
      btn.innerHTML = '<span class="btn-spinner"></span> Analyzing...';
    }
  }

  /**
   * Set button to complete state (briefly)
   */
  setButtonComplete() {
    const btn = this.getAnalyzeButton();
    if (!btn) return;

    btn.classList.remove('btn-analyzing');
    btn.classList.add('btn-complete');

    // Also clear the split dropdown toggle
    const toggleComplete = document.getElementById('analyze-stack-toggle');
    if (toggleComplete) toggleComplete.classList.remove('btn-analyzing');

    const btnText = btn.querySelector('.btn-text');
    if (btnText) {
      const spinner = btn.querySelector('.btn-spinner');
      if (spinner) spinner.remove();
      btnText.textContent = 'Complete';
    } else {
      btn.innerHTML = '✓ Analysis Complete';
    }
    btn.disabled = true;

    // Revert to normal after 2 seconds
    setTimeout(() => this.resetButton(), 2000);
  }

  /**
   * Reset button to normal state
   */
  resetButton() {
    const btn = this.getAnalyzeButton();
    if (!btn) return;

    this.isAnalyzing = false;
    this.currentAnalysisId = null;

    btn.classList.remove('btn-analyzing', 'btn-complete');
    btn.disabled = false;

    // Also clear the split dropdown toggle
    const toggleReset = document.getElementById('analyze-stack-toggle');
    if (toggleReset) toggleReset.classList.remove('btn-analyzing');

    const btnText = btn.querySelector('.btn-text');
    if (btnText) {
      const spinner = btn.querySelector('.btn-spinner');
      if (spinner) spinner.remove();
      btnText.textContent = 'Analyze';
    } else {
      btn.innerHTML = 'Analyze with AI';
    }
  }

  /**
   * Check if AI analysis is currently running for this PR and show progress dialog
   */
  async checkRunningAnalysis() {
    if (!this.currentPR) return;

    try {
      const reviewId = this.currentPR.id;
      if (!reviewId) return;
      const response = await fetch(`/api/reviews/${reviewId}/analyses/status`);

      if (!response.ok) {
        console.warn('Could not check analysis status:', response.statusText);
        return;
      }

      const data = await response.json();

      if (data.running && data.analysisId) {
        console.log('Found running analysis:', data.analysisId);

        // Set AI Panel to loading state
        if (window.aiPanel?.setAnalysisState) {
          window.aiPanel.setAnalysisState('loading');
        }

        // Set button to analyzing state
        this.setButtonAnalyzing(data.analysisId);

        // Show the appropriate progress modal
        if (window.councilProgressModal) {
          window.councilProgressModal.setPRMode();
          window.councilProgressModal.show(
            data.analysisId,
            data.status?.isCouncil ? data.status.councilConfig : null,
            null,
            {
              configType: data.status?.isCouncil ? (data.status.configType || 'advanced') : 'single',
              enabledLevels: data.status?.enabledLevels || [1, 2, 3],
              noLevels: data.status?.noLevels || false
            }
          );
        }
      }
    } catch (error) {
      console.error('Error checking running analysis:', error);
      // Don't show error to user - this is a background check
    }
  }

  /**
   * Reopen progress modal when button is clicked during analysis
   */
  reopenModal() {
    if (!this.currentAnalysisId) return;

    // Reopen the per-PR progress modal (council/single analysis)
    if (window.councilProgressModal && window.councilProgressModal.currentAnalysisId === this.currentAnalysisId) {
      window.councilProgressModal.reopenFromBackground();
    }
  }

  /**
   * Fetch repo settings (default instructions and model)
   * @returns {Promise<Object|null>} Repo settings or null
   */
  async fetchRepoSettings() {
    if (!this.currentPR) return null;

    const { owner, repo } = this.currentPR;
    try {
      const response = await fetch(`/api/repos/${owner}/${repo}/settings`);
      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        console.warn('Failed to fetch repo settings:', response.statusText);
        return null;
      }
      return await response.json();
    } catch (error) {
      console.warn('Error fetching repo settings:', error);
      return null;
    }
  }

  /**
   * Fetch last review settings (custom instructions and council ID) from review record
   * @returns {Promise<{custom_instructions: string, last_council_id: string|null}>} Last review settings
   */
  async fetchLastReviewSettings() {
    if (!this.currentPR) return { custom_instructions: '', last_council_id: null };

    const { owner, repo, number } = this.currentPR;
    try {
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/review-settings`);
      if (!response.ok) {
        return { custom_instructions: '', last_council_id: null };
      }
      const data = await response.json();
      return {
        custom_instructions: data.custom_instructions || '',
        last_council_id: data.last_council_id || null
      };
    } catch (error) {
      console.warn('Error fetching last custom instructions:', error);
      return { custom_instructions: '', last_council_id: null };
    }
  }

  /**
   * Trigger AI analysis
   */
  async triggerAIAnalysis() {
    // If analysis is already running, just reopen the progress modal
    if (this.isAnalyzing) {
      this.reopenModal();
      return;
    }

    if (!this.currentPR) {
      this.showError('No PR loaded');
      return;
    }

    const { owner, repo, number } = this.currentPR;

    const btn = this.getAnalyzeButton();

    // Prevent concurrent analysis requests
    if (btn && btn.disabled) {
      return;
    }

    try {
      // Show analysis config modal
      if (!this.analysisConfigModal) {
        console.warn('AnalysisConfigModal not initialized, proceeding without config');
        await this.startAnalysis(owner, repo, number, btn, {});
        return;
      }

      // Run stale check and settings fetch in parallel to minimize dialog delay.
      // Reuse the on-load staleness promise if still available, otherwise fetch fresh.
      const _tParallel0 = performance.now();
      const staleCheckWithTimeout = this._stalenessPromise
        ? this._stalenessPromise
        : this._fetchStaleness(owner, repo, number);
      this._stalenessPromise = null; // consume it

      // Pass owner+repo to /api/config so has_github_token reflects the
      // repo's actual auth (covers repo-scoped tokens, token_command, and
      // alt-host bindings — not just the global github_token).
      const configUrl = `/api/config?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`;
      const [staleResult, repoSettings, reviewSettings, appConfig] = await Promise.all([
        staleCheckWithTimeout,
        this.fetchRepoSettings(),
        this.fetchLastReviewSettings(),
        fetch(configUrl).then(r => r.ok ? r.json() : {}).catch(() => ({}))
      ]);
      console.debug(`[Analyze] parallel-fetch (stale+settings): ${Math.round(performance.now() - _tParallel0)}ms`);

      // Handle staleness result — check for expected properties to distinguish
      // a valid response from a failed/timed-out fetch (which resolves to null)
      if (staleResult && 'isStale' in staleResult) {
        // Handle PR state - show info for closed/merged PRs
        if (staleResult.prState && (staleResult.prState !== 'open' || staleResult.merged)) {
          const stateLabel = staleResult.merged ? 'merged' : 'closed';
          if (window.toast) {
            window.toast.showWarning(`This PR is ${stateLabel}. Analysis will proceed on the existing data.`);
          }
        }

        if (staleResult.isStale === null) {
          if (window.toast) {
            window.toast.showWarning('Could not verify PR is current. Proceeding with analysis.');
          }
        } else if (staleResult.isStale === true) {
          if (window.confirmDialog) {
            const choice = await window.confirmDialog.show({
              title: 'PR Has New Commits',
              message: 'This pull request has new commits since you last loaded it. What would you like to do?',
              confirmText: 'Refresh & Analyze',
              confirmClass: 'btn-primary',
              secondaryText: 'Analyze Anyway',
              secondaryClass: 'btn-warning'
            });

            if (choice === 'confirm') {
              await this.refreshPR();
            } else if (choice !== 'secondary') {
              return;
            }
          }
        }
      } else if (!staleResult) {
        // Network error, HTTP error, or timeout — fail open with warning
        if (window.toast) {
          window.toast.showWarning('Could not verify PR is current. Proceeding with analysis.');
        }
      }

      const lastCouncilId = reviewSettings.last_council_id;

      // Resolve provider and model as a MATCHED pair so the council/advanced tabs
      // are never seeded with a cross-provider model (e.g. antigravity + opus), which
      // would blank the model <select> and be rejected by the backend.
      // buildProviderModelScopes prepends any CLI/env override ahead of repo
      // settings so `--provider` seeds the modal as the default selection.
      const providersInfo = await this._getProvidersInfo();
      const { provider: currentProvider, model: currentModel } = window.resolveProviderModelPair(
        window.buildProviderModelScopes(repoSettings, appConfig),
        providersInfo
      );

      // Determine default tab (priority: localStorage > repo settings > 'single')
      const tabStorageKey = PRManager.getRepoStorageKey('pair-review-tab', owner, repo);
      const rememberedTab = localStorage.getItem(tabStorageKey);
      const defaultTab = rememberedTab || repoSettings?.default_tab || 'single';

      // Restore custom instructions (priority: database > localStorage)
      const instructionsStorageKey = PRManager.getRepoStorageKey('pair-review-instructions', owner, repo);
      const lastInstructions = reviewSettings.custom_instructions
        ?? localStorage.getItem(instructionsStorageKey)
        ?? '';

      // Save tab selection to localStorage when user switches tabs
      this.analysisConfigModal.onTabChange = (tabId) => {
        localStorage.setItem(tabStorageKey, tabId);
      };

      // Show the config modal
      const config = await this.analysisConfigModal.show({
        currentModel,
        currentProvider,
        defaultTab,
        repoInstructions: repoSettings?.default_instructions || '',
        lastInstructions: lastInstructions,
        lastCouncilId,
        defaultCouncilId: repoSettings?.default_council_id || null,
        hasPr: true,
        // Use the repo-aware field (we passed owner+repo to /api/config).
        // Fall back to the global field only if the response was malformed
        // or the params were rejected — defensive, should not happen.
        hasGithubToken: Boolean(
          appConfig.has_github_token ?? appConfig.has_global_github_token
        )
      });

      // If user cancelled, do nothing
      if (!config) {
        return;
      }

      // Persist custom instructions to localStorage for immediate recall on next dialog open
      const submittedInstructions = config.customInstructions || '';
      if (submittedInstructions) {
        localStorage.setItem(instructionsStorageKey, submittedInstructions);
      } else {
        localStorage.removeItem(instructionsStorageKey);
      }

      // Start the analysis with the selected config
      await this.startAnalysis(owner, repo, number, btn, config);

    } catch (error) {
      console.error('Error triggering AI analysis:', error);
      this.showError(`Failed to start AI analysis: ${error.message}`);
      this.resetButton();
    }
  }

  /**
   * Start the actual AI analysis with the given config
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   * @param {HTMLElement} btn - Analyze button element
   * @param {Object} config - Analysis config from modal
   */
  async startAnalysis(owner, repo, number, btn, config) {
    try {
      // Disable button and show starting state
      if (btn) {
        btn.disabled = true;
        btn.classList.add('btn-analyzing');
        const btnText = btn.querySelector('.btn-text');
        if (btnText) {
          btnText.textContent = 'Starting...';
        } else {
          btn.innerHTML = '<span class="spinner"></span> Starting...';
        }
      }

      // Clear existing AI suggestions from UI immediately when starting new analysis
      if (window.aiPanel && typeof window.aiPanel.clearAllFindings === 'function') {
        try {
          window.aiPanel.clearAllFindings();
        } catch (e) {
          console.warn('Error clearing AI panel findings:', e);
          // Fall through to manual DOM cleanup
        }
      }
      // Always do manual DOM cleanup as backup
      document.querySelectorAll('.ai-suggestion-row').forEach(row => row.remove());

      // Determine endpoint and body based on whether this is a council analysis
      let analyzeUrl, analyzeBody;
      if (config.isCouncil) {
        analyzeUrl = `/api/pr/${owner}/${repo}/${number}/analyses/council`;
        analyzeBody = {
          councilId: config.councilId || undefined,
          councilConfig: config.councilConfig || undefined,
          configType: config.configType || 'advanced',
          customInstructions: config.customInstructions || null,
          excludePrevious: config.excludePrevious || undefined
        };
      } else {
        analyzeUrl = `/api/pr/${owner}/${repo}/${number}/analyses`;
        analyzeBody = {
          provider: config.provider || 'claude',
          model: config.model || 'opus',
          tier: config.tier || 'balanced',
          customInstructions: config.customInstructions || null,
          enabledLevels: config.enabledLevels || [1, 2, 3],
          skipLevel3: config.skipLevel3 || false,
          excludePrevious: config.excludePrevious || undefined
        };
      }

      // Start AI analysis
      const response = await fetch(analyzeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(analyzeBody)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (response.status === 404) {
          this.showWorktreeNotFoundError(owner, repo, number);
          return;
        }
        throw new Error(error.error || 'Failed to start AI analysis');
      }

      const result = await response.json();

      // Set AI Panel to loading state
      if (window.aiPanel?.setAnalysisState) {
        window.aiPanel.setAnalysisState('loading');
      }

      // Set analyzing state and show progress modal
      this.setButtonAnalyzing(result.analysisId);

      // Always use the unified progress modal
      if (window.councilProgressModal) {
        window.councilProgressModal.setPRMode();
        window.councilProgressModal.show(
          result.analysisId,
          config.isCouncil ? config.councilConfig : null,
          config.isCouncil ? config.councilName : null,
          {
            configType: config.isCouncil ? (config.configType || 'advanced') : 'single',
            enabledLevels: config.enabledLevels || [1, 2, 3],
            noLevels: config.noLevels || false
          }
        );
      }

    } catch (error) {
      console.error('Error starting AI analysis:', error);
      this.showError(`Failed to start AI analysis: ${error.message}`);
      this.resetButton();
    }
  }

  /**
   * Build the worktree-not-found recovery URL. When the user arrived via
   * auto-analyze (?analyze=true), the reload link preserves the whole
   * auto-analyze intent bundle (analyze/analysisConfigId/council/provider/model)
   * so analysis re-triggers with the same selection after worktree setup.
   * Carrying is delegated to the shared `carryAnalyzeParams` relay so this
   * hop stays in lockstep with the other three (see analyze-params.js);
   * dropping `council` would silently fall back to the repo/default analysis
   * config, and dropping `provider`/`model` would lose a `--provider` override.
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   * @returns {string} The recovery URL (unescaped)
   */
  _buildWorktreeRecoveryUrl(owner, repo, number) {
    // A fixed base is fine — only pathname + search are used for the link, so
    // the origin is irrelevant (and this avoids depending on window.location).
    const setupUrl = new URL(
      `/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`,
      'http://localhost'
    );
    if (this._autoAnalyzeRequested) {
      // The current search still carries the bundle here — it isn't stripped
      // until _maybeAutoAnalyze's finally block, which runs after this handler.
      // Force analyze=true so the retry still auto-triggers even if the source
      // somehow lost it, then carry the rest of the bundle via the shared relay.
      setupUrl.searchParams.set('analyze', 'true');
      window.carryAnalyzeParams(window.location.search, setupUrl);
    }
    return setupUrl.pathname + setupUrl.search;
  }

  /**
   * Show an error when the worktree is not found during analysis.
   * Displays a helpful message with a reload link that preserves any
   * auto-analyze state (see _buildWorktreeRecoveryUrl).
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   */
  showWorktreeNotFoundError(owner, repo, number) {
    const href = this._buildWorktreeRecoveryUrl(owner, repo, number);
    const container = document.getElementById('pr-container');
    if (container) {
      container.innerHTML = `
        <div class="error-container">
          <div class="error-icon">Warning</div>
          <div class="error-message">Worktree not found. Please reload the PR to set up the worktree before running analysis.</div>
          <a class="btn btn-primary" href="${this.escapeHtml(href)}">Reload PR</a>
        </div>
      `;
      container.style.display = 'block';
    }
    this.resetButton();
  }

  // ─── Staleness Badge ────────────────────────────────────────────

  /**
   * Fire-and-forget staleness check on page load.
   * If stale and no active session data, silently refreshes.
   * If stale and session data exists, shows the badge.
   * Also shows badge variants for closed/merged PRs.
   * @returns {Promise<Object|null>} The parsed staleness result, or null on failure.
   */
  async _checkStalenessOnLoad(owner, repo, number) {
    try {
      const result = await this._fetchStaleness(owner, repo, number);
      if (!result) return null;

      // Show badge for closed/merged PRs regardless of staleness
      if (result.prState && result.prState !== 'open') {
        const type = result.merged ? 'merged' : 'closed';
        this._showStaleBadge(type);
        return result;
      }

      if (result.isStale !== true) return result;

      // Stale — decide: silent refresh or show badge
      const hasData = await this._hasActiveSessionData();
      if (hasData) {
        this._showStaleBadge('stale');
        if (window.chatPanel) {
          const abbrevLen = this.currentPR?.shaAbbrevLength || 7;
          const oldSha = result.localHeadSha ? result.localHeadSha.substring(0, abbrevLen) : 'unknown';
          const newSha = result.remoteHeadSha ? result.remoteHeadSha.substring(0, abbrevLen) : 'unknown';
          window.chatPanel.queueDiffStateNotification(
            `PR HEAD has changed (${oldSha} → ${newSha}). The diff has not been refreshed yet.`
          );
        }
      } else {
        // No user work to protect — refresh silently
        await this.refreshPR();
      }
      return result;
    } catch {
      // Fail silently — staleness badge is best-effort
      return null;
    }
  }

  /**
   * Fetch staleness data from the server with a timeout.
   * @returns {Promise<Object|null>} The parsed staleness result, or null on failure/timeout.
   */
  async _fetchStaleness(owner, repo, number) {
    try {
      const staleAbort = new AbortController();
      const staleTimer = setTimeout(() => staleAbort.abort(), STALE_TIMEOUT);
      const response = await fetch(
        `/api/pr/${owner}/${repo}/${number}/check-stale`,
        { signal: staleAbort.signal }
      );
      clearTimeout(staleTimer);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Check whether the current session has user work worth protecting
   * (analysis results or active user comments).
   * Returns true if uncertain (fail-safe: don't auto-refresh).
   */
  async _hasActiveSessionData() {
    const reviewId = this.currentPR?.id;
    // No review record → no session data possible
    if (!reviewId) return false;

    try {
      const [suggestionsRes, commentsRes] = await Promise.all([
        fetch(`/api/reviews/${reviewId}/suggestions/check`).then(r => r.ok ? r.json() : null),
        fetch(`/api/reviews/${reviewId}/comments`).then(r => r.ok ? r.json() : null)
      ]);

      const hasAnalysis = suggestionsRes?.analysisHasRun === true;
      const hasUserComments = (commentsRes?.comments || []).some(
        c => c.source === 'user' && c.status !== 'inactive'
      );

      return hasAnalysis || hasUserComments;
    } catch {
      // Uncertain — fail safe
      return true;
    }
  }

  /**
   * Show the stale badge with an optional variant class.
   * @param {'stale'|'closed'|'merged'} type
   * @param {string} [title] - Optional custom tooltip text. Falls back to type-specific defaults.
   */
  _showStaleBadge(type, title) {
    const badge = document.getElementById('stale-badge');
    if (!badge) return;

    // Reset variant classes
    badge.classList.remove('pr-closed', 'pr-merged');

    const textEl = badge.querySelector('.stale-badge-text');
    if (type === 'merged') {
      badge.classList.add('pr-merged');
      if (textEl) textEl.textContent = 'MERGED';
      badge.title = title || 'This PR has been merged';
    } else if (type === 'closed') {
      badge.classList.add('pr-closed');
      if (textEl) textEl.textContent = 'CLOSED';
      badge.title = title || 'This PR has been closed';
    } else {
      if (textEl) textEl.textContent = 'STALE';
      badge.title = title || 'PR data is outdated';
    }
    badge.style.display = '';
  }

  /**
   * Hide the stale badge.
   */
  _hideStaleBadge() {
    const badge = document.getElementById('stale-badge');
    if (badge) badge.style.display = 'none';
  }

  /**
   * Refresh the PR data
   */
  async refreshPR() {
    if (!this.currentPR) {
      console.error('No PR loaded to refresh');
      return;
    }

    const { owner, repo, number } = this.currentPR;
    const refreshBtn = document.getElementById('refresh-pr');

    if (refreshBtn) {
      refreshBtn.classList.add('refreshing');
      refreshBtn.disabled = true;
    }

    // Show loading state in diff container. NOT under CodeView: the bridge owns
    // #diff-container (its managed container is a child), and the re-render's
    // destroyAll preserves the CodeView↔root binding so _ensureCodeView would
    // early-return and keep updating the now-detached container while this
    // spinner shows forever. The refresh button shows its own spinning state.
    const diffContainer = document.getElementById('diff-container');
    if (diffContainer && !this._usesPierreCodeView()) {
      diffContainer.innerHTML = '<div class="loading">Refreshing pull request...</div>';
    }

    const oldHeadSha = this.currentPR?.head_sha;

    try {
      // Call refresh API endpoint to fetch fresh data from GitHub
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/refresh`, {
        method: 'POST'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to refresh pull request');
      }

      const data = await response.json();

      // Update current PR data
      if (data.success && data.data) {
        this.currentPR = data.data;

        // Notify chat agent if HEAD SHA changed
        const newHeadSha = data.data?.head_sha;
        if (window.chatPanel && oldHeadSha && newHeadSha && oldHeadSha !== newHeadSha) {
          const abbrevLen = this.currentPR?.shaAbbrevLength || 7;
          window.chatPanel.queueDiffStateNotification(
            `PR refreshed. HEAD changed: ${oldHeadSha.substring(0, abbrevLen)} → ${newHeadSha.substring(0, abbrevLen)}.`
          );
        }

        // Sync worktree label to dropdown (may have changed after refresh)
        this._syncWorktreeDropdown(data.data);

        // Save scroll position and expanded state
        const scrollPosition = window.scrollY;
        const expandedFolders = new Set(this.expandedFolders);

        // Update PR header with fresh data (title, description may have changed)
        this.renderPRHeader(data.data);

        // Reload the files/diff with fresh data
        await this.loadAndDisplayFiles(owner, repo, number);

        // Re-render the three independent overlay layers on the fresh DOM
        // (renderDiff clears the diff container). Going through the shared
        // helper guarantees the three renderers can't drift again — adding
        // a fourth overlay only requires updating this one place.
        // `syncExternal: true` because refreshPR fetched a brand-new diff
        // (commit SHA may have changed). Cached external-comment anchors
        // need a sync POST to re-evaluate which ones are outdated against
        // the new HEAD — otherwise we'd render stale `is_outdated` flags.
        // Note: Unlike loadPR() which skips loadAISuggestions when
        // analysisHistoryManager exists (because the manager triggers it via
        // onSelectionChange on init), refresh must call unconditionally
        // since the manager won't re-fire its callback.
        await this._rerenderAllOverlays({
          analysisRunId: this.selectedRunId,
          syncExternal: true,
        });

        // Restore expanded folders
        this.expandedFolders = expandedFolders;

        // Restore scroll position after a short delay to allow rendering
        setTimeout(() => {
          window.scrollTo(0, scrollPosition);
        }, 100);

        this._hideStaleBadge();
        this._stalenessPromise = null;

        console.log('PR refreshed successfully');
      }
    } catch (error) {
      console.error('Error refreshing PR:', error);
      this.showError(error.message);
    } finally {
      if (refreshBtn) {
        refreshBtn.classList.remove('refreshing');
        refreshBtn.disabled = false;
      }
    }
  }

  // ─── Context Files ──────────────────────────────────────────────

  /**
   * Load context files for the current review and render them in the diff panel.
   * Called after renderDiff() and on WebSocket context_files_changed events.
   */
  async loadContextFiles() {
    const reviewId = this.currentPR?.id;
    if (!reviewId) return;

    // The "diff wins" suppression below needs the diff's file list to know which
    // context rows are shadowed by a diff entry. `diffFiles` stays null until
    // updateFileList delivers it, and this method's callers (WebSocket
    // context_files_changed, the visibility-change flush, ensureContextFile) are
    // NOT ordered after that assignment. Treating the null window as "no diff
    // files" would render a context:<path> item for a path about to gain a diff
    // entry — the both-items-exist state the rule makes unrepresentable (the zone
    // cache and item-id resolution assume it cannot happen). Bail before touching
    // any state; renderDiff calls this again right after updateFileList, and no
    // context item can exist yet during that window.
    if (!Array.isArray(this.diffFiles)) return;

    // Capture before anything reassigns this.contextFiles — needed to scrub
    // context-scoped state for rows deleted remotely (peer tab / WebSocket).
    const previousFiles = this.contextFiles || [];

    try {
      const response = await fetch(`/api/reviews/${reviewId}/context-files`);
      if (!response.ok) return;

      const data = await response.json();
      const newFiles = data.contextFiles || [];

      const oldIds = new Set((this.contextFiles || []).map(f => f.id));
      const newIds = new Set(newFiles.map(f => f.id));

      // Remove only deleted context files (handles both standalone and merged wrappers)
      for (const old of this.contextFiles || []) {
        if (!newIds.has(old.id)) {
          if (this._usesPierreCodeView()) {
            // CodeView path: context entries are whole-file bridge items keyed
            // by path. Drop this record; remove the item only when no records
            // remain for its path.
            const recs = (this._contextItemsByPath?.get(old.file) || [])
              .filter(r => r.id !== old.id);
            if (recs.length > 0) {
              this._contextItemsByPath.set(old.file, recs);
            } else {
              this._contextItemsByPath?.delete(old.file);
              this.pierreBridge.removeContextFileItem(old.file);
            }
            continue;
          }
          const el = document.querySelector(`[data-context-id="${old.id}"]`);
          if (!el) continue;
          if (el.classList.contains('context-file')) {
            // Standalone wrapper (legacy) — remove entirely
            el.remove();
          } else {
            // Chunk tbody within a merged wrapper
            const wrapper = el.closest('.context-file');
            // Also remove adjacent separator tbody if present
            const prevSib = el.previousElementSibling;
            const nextSib = el.nextElementSibling;
            if (prevSib && prevSib.classList.contains('context-chunk-separator')) {
              prevSib.remove();
            } else if (nextSib && nextSib.classList.contains('context-chunk-separator')) {
              nextSib.remove();
            }
            el.remove();
            // If no more chunks remain, remove the wrapper too
            if (wrapper && !wrapper.querySelector('.context-chunk')) {
              wrapper.remove();
            }
          }
        }
      }

      // Add only new context files. "Diff wins": a stored context row whose
      // file has since entered the diff (Local-mode scope change, new commits,
      // PR refresh) is suppressed at the view layer — never rendered as a
      // duplicate wrapper, never deleted from the DB. renderDiff is a full
      // clear-and-rebuild that resets contextFiles and re-runs this method,
      // so a file leaving the diff self-heals back to a context wrapper.
      // Mirrors the add-time guards (ensureContextFile, the POST route) and
      // the sidebar merge (mergeFileListWithContext).
      // Guaranteed populated by the not-loaded-yet bail at the top of the method.
      const diffPaths = new Set(this.diffFiles.map(f => f.file));
      let newFilesRendered = false;
      for (const cf of newFiles) {
        if (diffPaths.has(cf.file)) continue;
        if (!oldIds.has(cf.id)) {
          await this.renderContextFile(cf);
          newFilesRendered = true;
        }
      }

      this.contextFiles = newFiles;

      // Scrub context-scoped viewed/collapsed keys for paths whose entries all
      // disappeared in this refresh. Without this, a delete arriving via the
      // WebSocket path leaves orphaned `context:` keys on peer tabs: re-adding
      // the file renders it pre-viewed/pre-collapsed, and a later
      // saveViewedState() writes the orphan back into shared storage.
      this._scrubRemovedContextState(previousFiles);

      // Rebuild sidebar with context files interleaved in natural path order
      this.rebuildFileListWithContext();

      // Re-anchor comments after new context files are rendered so that
      // comments targeting lines in these files find their DOM targets.
      // loadUserComments() is idempotent (clears existing comment rows first).
      if (newFilesRendered) {
        const includeDismissed = window.aiPanel?.showDismissedComments || false;
        await this.loadUserComments(includeDismissed);
      }
    } catch (error) {
      console.error('Error loading context files:', error);
    }
  }

  /**
   * Rebuild the sidebar file list with context files interleaved in natural path order.
   * Merges stored diff files with current context files and re-renders the sidebar.
   * Delegates to the shared FileListMerger module for the merge/sort logic.
   */
  rebuildFileListWithContext() {
    const { mergeFileListWithContext } = window.FileListMerger || {};
    if (!mergeFileListWithContext) {
      console.warn('FileListMerger not loaded - cannot rebuild file list with context');
      return;
    }
    const merged = mergeFileListWithContext(this.diffFiles, this.contextFiles);
    this.updateFileList(merged);
  }

  /**
   * Build a context chunk tbody with line rows for a context file range.
   * @param {Object} data - { lines: string[] } from fetchFileContent
   * @param {Object} contextFile - { id, file, line_start, line_end }
   * @returns {HTMLElement} tbody element with class context-chunk
   * @private
   */
  _buildContextChunkTbody(data, contextFile) {
    const tbody = document.createElement('tbody');
    tbody.className = 'd2h-diff-tbody context-chunk';
    tbody.dataset.contextId = contextFile.id;

    // Compute effective display range, shifting for end-of-file
    const clampedEnd = Math.min(contextFile.line_end, data.lines.length);
    const intendedSize = contextFile.line_end - contextFile.line_start + 1;
    let effectiveStart = contextFile.line_start;
    const actualSize = clampedEnd - effectiveStart + 1;
    if (actualSize < intendedSize && effectiveStart > 1) {
      effectiveStart = Math.max(1, effectiveStart - (intendedSize - actualSize));
    }
    tbody.dataset.lineStart = effectiveStart;

    // Add expand-up gap row if there are lines above the context range
    if (effectiveStart > 1) {
      const gapAboveSize = effectiveStart - 1;
      const gapAbove = window.HunkParser.createGapRowElement(
        contextFile.file,
        1,                  // startLine (old coords)
        effectiveStart - 1, // endLine (old coords)
        gapAboveSize,
        'above',
        this.expandGapContext.bind(this),
        1                   // startLineNew (same as old for context files — no diff offset)
      );
      tbody.appendChild(gapAbove);
    }

    for (let i = effectiveStart; i <= clampedEnd; i++) {
      const lineData = {
        type: 'context',
        oldNumber: i,
        newNumber: i,
        content: ' ' + (data.lines[i - 1] || '')
      };
      this.renderDiffLine(tbody, lineData, contextFile.file, null);
    }

    // Add expand-down gap row if there are lines below the context range
    const totalLines = data.lines.length;
    if (clampedEnd < totalLines) {
      const gapBelowSize = totalLines - clampedEnd;
      const gapBelow = window.HunkParser.createGapRowElement(
        contextFile.file,
        clampedEnd + 1, // startLine (old coords)
        totalLines,     // endLine (old coords)
        gapBelowSize,
        'below',
        this.expandGapContext.bind(this),
        clampedEnd + 1  // startLineNew (same as old)
      );
      tbody.appendChild(gapBelow);
    }

    return tbody;
  }

  /**
   * Insert a chunk tbody into an existing table in sorted position by line_start.
   * Adds a visual separator tbody between non-contiguous ranges.
   * @param {HTMLElement} table - the d2h-diff-table
   * @param {HTMLElement} newTbody - the context-chunk tbody to insert
   * @private
   */
  _insertChunkSorted(table, newTbody) {
    const newStart = parseInt(newTbody.dataset.lineStart, 10);
    const existingChunks = [...table.querySelectorAll('tbody.context-chunk')];

    // Find insertion point
    let insertBeforeChunk = null;
    for (const chunk of existingChunks) {
      const chunkStart = parseInt(chunk.dataset.lineStart, 10);
      if (chunkStart > newStart) {
        insertBeforeChunk = chunk;
        break;
      }
    }

    // Determine the element to insert before (including any separator before it)
    if (insertBeforeChunk) {
      const prevSibling = insertBeforeChunk.previousElementSibling;
      const hasSepBefore = prevSibling && prevSibling.classList.contains('context-chunk-separator');
      if (hasSepBefore) {
        table.insertBefore(newTbody, prevSibling);
        const sep = this._createChunkSeparator();
        table.insertBefore(sep, newTbody);
      } else {
        table.insertBefore(newTbody, insertBeforeChunk);
        const sep = this._createChunkSeparator();
        table.insertBefore(sep, insertBeforeChunk);
      }
    } else {
      // Append after the last chunk — add separator before if there are existing chunks
      if (existingChunks.length > 0) {
        const sep = this._createChunkSeparator();
        table.appendChild(sep);
      }
      table.appendChild(newTbody);
    }
  }

  /**
   * Create a visual separator tbody between context chunks.
   * @returns {HTMLElement} tbody with a single separator row
   * @private
   */
  _createChunkSeparator() {
    const sep = document.createElement('tbody');
    sep.className = 'context-chunk-separator';
    const row = document.createElement('tr');
    row.className = 'context-chunk-separator-row';
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'd2h-code-side-line context-chunk-separator-cell';
    row.appendChild(td);
    sep.appendChild(row);
    return sep;
  }

  /**
   * Render a context file as a whole-file CodeView reference item (CodeView
   * path). Multiple context ranges for the same path collapse into one item.
   * @param {Object} contextFile
   * @private
   */
  async _renderContextFileCodeView(contextFile) {
    const data = await this.fetchFileContent(contextFile.file);
    if (!data || !data.lines) return;

    const contents = data.lines.join('\n');
    const contextKey = this._contextStateKey(contextFile.file);
    const collapsed = this.viewedFiles.has(contextKey) || this.collapsedFiles.has(contextKey);

    // Track the context records per path so the header dismiss button can
    // remove every range that produced this reference item.
    if (!this._contextItemsByPath) this._contextItemsByPath = new Map();
    const recs = this._contextItemsByPath.get(contextFile.file) || [];
    if (!recs.some(r => r.id === contextFile.id)) recs.push(contextFile);
    this._contextItemsByPath.set(contextFile.file, recs);

    this.pierreBridge.addContextFile(contextFile.file, contents, { collapsed });

    // Render the file-comments zone as a lineNumber:0 body annotation (file
    // items take no side), mirroring the diff path. Context items are keyed by
    // their `context:<path>` id in the bridge; the renderer still receives the
    // plain path via fileState.fileName. This method runs once PER RECORD but
    // a path collapses into ONE `context:<path>` item, so upsert by id (add
    // only when not already anchored) or each record appends a duplicate zone.
    this._ensurePierreFileCommentsRenderer();
    const contextItemKey = this._contextStateKey(contextFile.file);
    const annotationId = `file-comments:${contextFile.file}`;
    const alreadyAnchored = (this.pierreBridge.getAnnotations(contextItemKey) || [])
      .some(a => a.metadata?.id === annotationId);
    if (!alreadyAnchored) {
      this.pierreBridge.addAnnotation(contextItemKey, {
        type: 'file-comments',
        lineNumber: 0,
        id: annotationId,
        data: { file: contextFile.file },
      });
    }
  }

  /**
   * Build the header element for a context-file reference item in the CodeView
   * path (chevron, name, CONTEXT badge, viewed checkbox, comment/chat/dismiss).
   *
   * renderContextFile's legacy branch builds a near-identical header inline. That
   * duplication is deliberate and stays: the legacy branch runs only when the
   * vendor bundle fails to load and is slated for removal, so a shared
   * abstraction would exist to serve a consumer about to be deleted.
   * @param {string} fileName
   * @returns {HTMLElement}
   * @private
   */
  _buildContextFileHeader(fileName) {
    const header = document.createElement('div');
    header.className = 'd2h-file-header context-file-header';

    const contextKey = this._contextStateKey(fileName);
    const fileState = this.pierreBridge?.files?.get(contextKey);
    const isCollapsed = fileState ? !!fileState.collapsed : this.collapsedFiles.has(contextKey);

    const chevronBtn = document.createElement('button');
    chevronBtn.className = 'file-collapse-toggle';
    chevronBtn.title = 'Collapse file';
    chevronBtn.innerHTML = window.DiffRenderer.CHEVRON_DOWN_ICON;
    chevronBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleContextFileCollapse(fileName);
    });
    header.appendChild(chevronBtn);

    const nameEl = document.createElement('span');
    nameEl.className = 'd2h-file-name';
    nameEl.textContent = fileName;
    header.appendChild(nameEl);

    const contextLabel = document.createElement('span');
    contextLabel.className = 'context-badge';
    contextLabel.textContent = 'CONTEXT';
    header.appendChild(contextLabel);

    const viewedLabel = document.createElement('label');
    viewedLabel.className = 'file-viewed-label';
    viewedLabel.title = 'Mark file as viewed';
    const viewedCheckbox = document.createElement('input');
    viewedCheckbox.type = 'checkbox';
    viewedCheckbox.className = 'file-viewed-checkbox';
    viewedCheckbox.checked = this.viewedFiles.has(contextKey);
    viewedCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      this.toggleContextFileViewed(fileName, viewedCheckbox.checked);
    });
    viewedLabel.appendChild(viewedCheckbox);
    viewedLabel.appendChild(document.createTextNode('Viewed'));
    header.appendChild(viewedLabel);

    if (this.fileCommentManager) {
      // The zone renders as a lineNumber:0 body annotation (see
      // _renderContextFileCodeView), not appended to this sticky header.
      const commentsZone = this._getOrCreateFileCommentsZone(fileName);
      const fileCommentBtn = document.createElement('button');
      fileCommentBtn.className = 'file-header-comment-btn';
      fileCommentBtn.title = 'Add file comment';
      fileCommentBtn.dataset.file = fileName;
      fileCommentBtn.innerHTML = `
        <svg class="comment-icon-outline" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.5 0v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25H2.75a.25.25 0 0 0-.25.25Z"/>
        </svg>
        <svg class="comment-icon-filled" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display:none">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5Z"/>
        </svg>
      `;
      fileCommentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.fileCommentManager.showCommentForm(commentsZone, fileName);
      });
      header.appendChild(fileCommentBtn);
      commentsZone.headerButton = fileCommentBtn;
      // Refresh the rebuilt icon from the cached zone's count (see the diff
      // header path) so a context file with comments keeps its filled icon
      // across virtualization remounts.
      this.fileCommentManager.updateCommentCount(commentsZone);
    }

    const fileChatBtn = document.createElement('button');
    fileChatBtn.className = 'file-header-chat-btn';
    fileChatBtn.title = 'Chat about file';
    fileChatBtn.dataset.file = fileName;
    fileChatBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
      </svg>
    `;
    fileChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.chatPanel) {
        window.chatPanel.open({ fileContext: { file: fileName } });
      }
    });
    header.appendChild(fileChatBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'context-file-dismiss';
    dismissBtn.title = 'Remove context file';
    dismissBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`;
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const recs = this._contextItemsByPath?.get(fileName) || [];
      const removeAll = async () => {
        for (const rec of recs) {
          await this.removeContextFile(rec.id);
        }
      };
      removeAll();
    });
    header.appendChild(dismissBtn);

    header.addEventListener('click', (e) => {
      if (e.target.closest('.file-viewed-label') || e.target.closest('.file-collapse-toggle') ||
          e.target.closest('.file-header-comment-btn') || e.target.closest('.file-header-chat-btn') ||
          e.target.closest('.context-file-dismiss')) {
        return;
      }
      this.toggleContextFileCollapse(fileName);
    });

    if (isCollapsed) {
      window.DiffRenderer.updateFileHeaderState(header, false);
    }

    return header;
  }

  /**
   * Render a single context file range in the diff panel.
   * Merges ranges for the same file into a single wrapper with multiple chunk tbodies.
   * @param {Object} contextFile - { id, review_id, file, line_start, line_end, label }
   */
  async renderContextFile(contextFile) {
    // CodeView path: context files become whole-file reference items appended
    // after the diff items (the chunk-range table model does not map onto the
    // single virtualized CodeView, so the whole reference file is shown).
    if (this._usesPierreCodeView()) {
      return this._renderContextFileCodeView(contextFile);
    }

    const diffContainer = document.getElementById('diff-container');
    if (!diffContainer) return;

    // Fetch file content
    const data = await this.fetchFileContent(contextFile.file);
    if (!data || !data.lines) return;

    // Check if a wrapper already exists for this file
    const existing = diffContainer.querySelector(
      `.d2h-file-wrapper.context-file[data-file-name="${CSS.escape(contextFile.file)}"]`
    );

    if (existing) {
      // Merge into existing wrapper — add a new chunk tbody
      const table = existing.querySelector('.d2h-diff-table');
      if (!table) return;
      const newTbody = this._buildContextChunkTbody(data, contextFile);
      this._insertChunkSorted(table, newTbody);
      return;
    }

    // No existing wrapper — create a new one
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper context-file';
    wrapper.dataset.fileName = contextFile.file;

    // Build file header — matches regular diff headers (chevron, viewed, comment btn, chat btn)
    const header = document.createElement('div');
    header.className = 'd2h-file-header context-file-header';

    // Chevron toggle for expand/collapse
    const chevronBtn = document.createElement('button');
    chevronBtn.className = 'file-collapse-toggle';
    chevronBtn.title = 'Collapse file';
    chevronBtn.innerHTML = window.DiffRenderer.CHEVRON_DOWN_ICON;
    chevronBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleContextFileCollapse(contextFile.file);
    });
    header.appendChild(chevronBtn);

    const fileName = document.createElement('span');
    fileName.className = 'd2h-file-name';
    fileName.textContent = contextFile.file;
    header.appendChild(fileName);

    const contextLabel = document.createElement('span');
    contextLabel.className = 'context-badge';
    contextLabel.textContent = 'CONTEXT';
    if (contextFile.label) contextLabel.title = contextFile.label;
    header.appendChild(contextLabel);

    // Viewed checkbox (right-aligned group start)
    const viewedLabel = document.createElement('label');
    viewedLabel.className = 'file-viewed-label';
    viewedLabel.title = 'Mark file as viewed';
    const viewedCheckbox = document.createElement('input');
    viewedCheckbox.type = 'checkbox';
    viewedCheckbox.className = 'file-viewed-checkbox';
    viewedCheckbox.checked = this.viewedFiles.has(this._contextStateKey(contextFile.file));
    viewedCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      this.toggleContextFileViewed(contextFile.file, viewedCheckbox.checked);
    });
    viewedLabel.appendChild(viewedCheckbox);
    viewedLabel.appendChild(document.createTextNode('Viewed'));
    header.appendChild(viewedLabel);

    // File comment button
    if (this.fileCommentManager) {
      const fileCommentsZone = this.fileCommentManager.createFileCommentsZone(contextFile.file);
      wrapper._fileCommentsZone = fileCommentsZone;

      const fileCommentBtn = document.createElement('button');
      fileCommentBtn.className = 'file-header-comment-btn';
      fileCommentBtn.title = 'Add file comment';
      fileCommentBtn.dataset.file = contextFile.file;
      fileCommentBtn.innerHTML = `
        <svg class="comment-icon-outline" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.5 0v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25H2.75a.25.25 0 0 0-.25.25Z"/>
        </svg>
        <svg class="comment-icon-filled" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display:none">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5Z"/>
        </svg>
      `;
      fileCommentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.fileCommentManager.showCommentForm(fileCommentsZone, contextFile.file);
      });
      header.appendChild(fileCommentBtn);
      fileCommentsZone.headerButton = fileCommentBtn;
    }

    // Chat/discussion button
    const fileChatBtn = document.createElement('button');
    fileChatBtn.className = 'file-header-chat-btn';
    fileChatBtn.title = 'Chat about file';
    fileChatBtn.dataset.file = contextFile.file;
    fileChatBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
      </svg>
    `;
    fileChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.chatPanel) {
        window.chatPanel.open({ fileContext: { file: contextFile.file } });
      }
    });
    header.appendChild(fileChatBtn);

    // Dismiss button — removes ALL context ranges for this file
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'context-file-dismiss';
    dismissBtn.title = 'Remove context file';
    dismissBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`;
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Remove all context ranges for this file
      const fileWrapper = e.target.closest('.context-file');
      if (!fileWrapper) return;
      const chunkIds = [...fileWrapper.querySelectorAll('tbody.context-chunk[data-context-id]')]
        .map(tb => tb.dataset.contextId);
      if (chunkIds.length === 0) return;
      // Remove all ranges — fire sequentially to avoid race conditions
      const removeAll = async () => {
        for (const cid of chunkIds) {
          await this.removeContextFile(cid);
        }
      };
      removeAll();
    });
    header.appendChild(dismissBtn);

    // Click anywhere on header to toggle collapse (except interactive controls)
    header.addEventListener('click', (e) => {
      if (e.target.closest('.file-viewed-label') || e.target.closest('.file-collapse-toggle') ||
          e.target.closest('.file-header-comment-btn') || e.target.closest('.file-header-chat-btn') ||
          e.target.closest('.context-file-dismiss')) {
        return;
      }
      this.toggleContextFileCollapse(contextFile.file);
    });

    wrapper.appendChild(header);

    // Insert file comments zone between header and diff content
    if (wrapper._fileCommentsZone) {
      wrapper.appendChild(wrapper._fileCommentsZone);
    }

    // Build code table with the first chunk
    const table = document.createElement('table');
    table.className = 'd2h-diff-table';
    const tbody = this._buildContextChunkTbody(data, contextFile);
    table.appendChild(tbody);

    const fileBody = document.createElement('div');
    fileBody.className = 'd2h-file-body';
    fileBody.appendChild(table);
    wrapper.appendChild(fileBody);

    // Apply context-scoped collapse/viewed state (independent of any diff
    // entry for the same file) — mirrors renderFileDiff's initial state.
    const contextKey = this._contextStateKey(contextFile.file);
    if (this.viewedFiles.has(contextKey) || this.collapsedFiles.has(contextKey)) {
      wrapper.classList.add('collapsed');
      window.DiffRenderer.updateFileHeaderState(header, false);
    }

    // Insert in sorted path order among existing file wrappers
    const allWrappers = [...diffContainer.querySelectorAll('.d2h-file-wrapper')];
    const insertBefore = allWrappers.find(w => w.dataset.fileName > contextFile.file);
    if (insertBefore) {
      diffContainer.insertBefore(wrapper, insertBefore);
    } else {
      diffContainer.appendChild(wrapper);
    }
  }

  /**
   * Scrub context-scoped viewed/collapsed keys for context entries that no
   * longer have any row for their path in the current this.contextFiles.
   * Persists via saveViewedState() only when a viewed key was actually
   * removed, so WebSocket-driven refreshes don't POST on every event.
   * Idempotent: re-running with the same input is a no-op.
   *
   * Note: the "diff wins" guard in loadContextFiles only suppresses rendering;
   * suppressed rows remain in this.contextFiles, so they are correctly treated
   * as still present here and never scrubbed.
   *
   * @param {Array<{file: string}>} previousContextFiles - Context rows that
   *   existed before the refresh/delete (candidates for scrubbing)
   */
  _scrubRemovedContextState(previousContextFiles) {
    if (!previousContextFiles || previousContextFiles.length === 0) return;

    const remainingPaths = new Set((this.contextFiles || []).map(cf => cf.file));
    let viewedRemoved = false;
    for (const prev of previousContextFiles) {
      if (!prev || remainingPaths.has(prev.file)) continue;
      const key = this._contextStateKey(prev.file);
      this.collapsedFiles?.delete(key);
      if (this.viewedFiles?.delete(key)) {
        viewedRemoved = true;
      }
    }
    if (viewedRemoved) {
      this.saveViewedState();
    }
  }

  /**
   * Remove a context file by ID.
   * @param {number} contextFileId
   */
  async removeContextFile(contextFileId) {
    const reviewId = this.currentPR?.id;
    if (!reviewId) return;

    // Capture the row before loadContextFiles refreshes this.contextFiles —
    // afterwards the deleted ID is gone and the file path with it.
    const removed = (this.contextFiles || []).find(
      cf => String(cf.id) === String(contextFileId)
    );

    try {
      const resp = await fetch(`/api/reviews/${reviewId}/context-files/${contextFileId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!resp.ok) {
        console.error('Failed to remove context file:', resp.status);
        return;
      }
      // Refresh immediately — WebSocket self-echo is suppressed by the client ID filter
      await this.loadContextFiles();

      // Defense-in-depth: loadContextFiles already scrubs based on its own
      // previous-files snapshot, but scrub the captured row explicitly too —
      // the helper's remaining-paths check makes double-scrubbing harmless.
      if (removed) {
        this._scrubRemovedContextState([removed]);
      }
    } catch (error) {
      console.error('Error removing context file:', error);
    }
  }

  /**
   * Scroll to a context file (or diff file) in the diff panel.
   * @param {string} file - File path
   * @param {number} [lineStart] - Optional line number to highlight
   */
  async scrollToContextFile(file, lineStart, contextId) {
    // CodeView path: context files are `context:<path>` virtualized items with
    // NO legacy .context-chunk / .context-file / <tr> DOM (and none at all when
    // virtualized out), so the legacy query below no-ops. Scroll through the
    // bridge by the resolved item id instead, mirroring diff-file nav.
    if (this._usesPierreCodeView()) {
      const itemId = this._pierreItemIdForPath(file);
      if (!itemId) return;
      if (lineStart) {
        // Line scrolls are compensated by the vendor; only whole-item jumps
        // need the sticky-header offset + landing correction.
        this.pierreBridge.scrollToLine(itemId, lineStart, 'RIGHT');
      } else {
        await this._scrollToPierreItemWithStickyOffset(itemId);
      }
      return;
    }

    // Use contextId to find a specific chunk tbody within a merged wrapper,
    // or fall back to a standalone wrapper or the file-level wrapper.
    let target;
    if (contextId) {
      // First try finding a specific chunk tbody (merged wrapper case)
      const chunk = document.querySelector(`.context-chunk[data-context-id="${CSS.escape(contextId)}"]`);
      if (chunk) {
        target = chunk;
      } else {
        // Fallback: legacy standalone wrapper with data-context-id on the wrapper itself
        target = document.querySelector(`.d2h-file-wrapper.context-file[data-context-id="${CSS.escape(contextId)}"]`);
      }
    }
    if (!target) {
      target = document.querySelector(`.d2h-file-wrapper.context-file[data-file-name="${CSS.escape(file)}"]`);
    }
    if (!target) return;

    // Stable variant ensures the target's lazy body is rendered and
    // re-corrects after lazy renders along the scroll path shift layout.
    const scrollOptions = { behavior: 'smooth', block: 'start' };
    if (window.ScrollUtils?.scrollIntoViewStable) {
      await window.ScrollUtils.scrollIntoViewStable(target, scrollOptions);
    } else {
      target.scrollIntoView(scrollOptions);
    }

    if (lineStart) {
      // Search for the line row within the wrapper (not just the target chunk)
      const wrapper = target.closest('.d2h-file-wrapper') || target;
      // The awaited stable scroll has already settled (and rendered the lazy
      // body), so the row exists now — highlight it immediately rather than
      // pulsing on a stale timer that would fire after the scroll completes.
      const row = wrapper.querySelector(`tr[data-line-number="${lineStart}"]`);
      if (row) {
        row.classList.remove('chat-line-highlight');
        void row.offsetWidth;
        row.classList.add('chat-line-highlight');
        row.addEventListener('animationend', () => {
          row.classList.remove('chat-line-highlight');
        }, { once: true });
      }
    }
  }

  async ensureContextFile(file, lineStart = null, lineEnd = null) {
    // 1. Guard: no review loaded
    if (!this.currentPR?.id) return null;

    // 2. Check diff files
    if (this.diffFiles?.some(f => f.file === file)) {
      return { type: 'diff' };
    }

    // 3. Compute line range values up front (used by both existing-check and POST)
    let lineStartVal, lineEndVal;
    if (lineStart == null && lineEnd == null) {
      lineStartVal = 1;
      lineEndVal = 100;
    } else if (lineEnd == null) {
      // Center a ~21-line window around the target line (±10 lines)
      lineStartVal = Math.max(1, lineStart - 10);
      lineEndVal = lineStartVal + 20;
    } else {
      lineStartVal = lineStart;
      lineEndVal = Math.min(lineEnd, lineStart + 499);
    }

    // 4. Check existing context files — expand range if needed
    const existingEntries = this.contextFiles?.filter(cf => cf.file === file) || [];
    if (existingEntries.length > 0 && lineStart != null) {
      const covering = existingEntries.find(cf =>
        cf.line_start <= lineStartVal && cf.line_end >= lineEndVal
      );
      if (covering) {
        return { type: 'context', contextFile: covering };
      }

      const overlapping = existingEntries.find(cf =>
        cf.line_start <= lineEndVal && cf.line_end >= lineStartVal
      );
      if (overlapping) {
        const newStart = Math.min(overlapping.line_start, lineStartVal);
        let newEnd = Math.max(overlapping.line_end, lineEndVal);
        if (newEnd - newStart + 1 > 500) {
          newEnd = newStart + 499;
        }
        const reviewId = this.currentPR.id;
        try {
          const resp = await fetch(`/api/reviews/${reviewId}/context-files/${overlapping.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ line_start: newStart, line_end: newEnd })
          });
          if (resp.ok) {
            // Evict stale entries for this file so loadContextFiles sees
            // them as new IDs and triggers a fresh render.
            const staleFile = overlapping.file;
            this.contextFiles = (this.contextFiles || []).filter(cf => cf.file !== staleFile);
            // Remove the file wrapper from the DOM so chunks are re-created
            const staleWrapper = document.querySelector(
              `.d2h-file-wrapper.context-file[data-file-name="${CSS.escape(staleFile)}"]`
            );
            if (staleWrapper) staleWrapper.remove();

            await this.loadContextFiles();
            const updated = this.contextFiles?.find(cf => cf.id === overlapping.id);
            return { type: 'context', contextFile: updated || overlapping, expanded: true };
          }
        } catch (err) {
          console.error('Error expanding context file range:', err);
        }
      }
    } else if (existingEntries.length > 0) {
      return { type: 'context', contextFile: existingEntries[0] };
    }

    // 5. POST to add context file
    const reviewId = this.currentPR.id;
    try {
      const resp = await fetch(`/api/reviews/${reviewId}/context-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, line_start: lineStartVal, line_end: lineEndVal })
      });

      if (resp.status === 201) {
        // 6. Reload context files to render
        await this.loadContextFiles();
        const added = this.contextFiles?.find(cf => cf.file === file);
        return { type: 'context', contextFile: added || null };
      }

      if (resp.status === 400) {
        const data = await resp.json().catch(() => ({}));
        if (data.error?.includes('already part of the diff')) {
          return { type: 'diff' };
        }
      }

      // 7. Other errors
      console.error('Failed to add context file:', resp.status);
      return null;
    } catch (err) {
      console.error('Error adding context file:', err);
      return null;
    }
  }

}

// Initialize PR manager when DOM is loaded (browser environment only)
let prManager;
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // Clean up legacy localStorage on startup (shared module loaded via HTML)
    if (typeof window.cleanupLegacyLocalStorage === 'function') {
      window.cleanupLegacyLocalStorage();
    }

    // Initialize panel resizer for drag-to-resize functionality
    if (typeof window.PanelResizer !== 'undefined') {
      window.PanelResizer.init();
    }

    // Initialize tab title manager
    if (typeof TabTitle !== 'undefined') {
      window.tabTitle = new TabTitle();
    }

    prManager = new PRManager();
    // CRITICAL FIX: Make prManager available globally for component access
    window.prManager = prManager;
  });
}

// Export for testing (Node.js environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PRManager };
}
