// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Pull Request UI Management
 * Main orchestrator that coordinates the extracted modules:
 * - PierreBridge: the diff pane's one virtualized viewer (@pierre/diffs CodeView)
 * - HunkParser: Hunk parsing for summary anchors and stats
 * - DiffRenderer: File headers and path helpers
 * - CommentManager: Comment editing helpers
 * - SuggestionManager: AI suggestion handling
 */
// Timeout (ms) for stale check — git commands can hang on locked repos
const STALE_TIMEOUT = 2000;

// Review submission route; the fetch interceptor tags it with X-Client-Id
const SUBMIT_REVIEW_URL = /\/api\/pr\/[^/]+\/[^/]+\/\d+\/submit-review(?:[?#]|$)/;

class PRManager {
  // Icons forwarded from DiffRenderer
  static get EYE_ICON() {
    return window.DiffRenderer?.EYE_ICON || '';
  }

  static get EYE_CLOSED_ICON() {
    return window.DiffRenderer?.EYE_CLOSED_ICON || '';
  }

  static get GENERATED_FILE_ICON() {
    return window.DiffRenderer?.GENERATED_FILE_ICON || '';
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
  static PIERRE_POINTER_UPGRADE_DELAY_MS = 10000;

  // Logo icon - infinity loop rotated for "in-the-loop" branding
  static LOGO_ICON = `
    <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
      <path transform="rotate(-50 12 12)" d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.356-8-5.096 0-5.096 8 0 8 5.223 0 7.26-8 12.356-8z"/>
    </svg>
  `;

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
    this._initPaneState();
    // Context files - pinned non-diff file ranges
    this.contextFiles = [];
    // Canonical file order - sorted file paths for consistent ordering across components
    this.canonicalFileOrder = new Map();
    // Raw per-file patch text for chat context enrichment
    this.filePatches = new Map();
    // The changed files of the diff in the pane, keyed by path. Used to show a
    // held-back diff and to fetch a file's contents when it is first needed.
    this.changedFilesByPath = new Map();
    this._fileContentsUpgradeState = null;
    this._pierreContentUpgradePromises = new Map();
    // The render whose catch-up sweep of content upgrades has not run yet
    // (_upgradeFilesWithContents, _isContentUpgradeAwaited).
    this._pierreUpgradeSweepSignal = null;
    // Eligible-by-size files that get a background content upgrade when the
    // viewer mounts them (set in _upgradeFilesWithContents, reset in
    // renderDiff). Null when no upgrade session is active.
    this._pierreUpgradeCandidates = null;
    this._deferredDiffRenderPromises = new Map();
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
    //   Map<filePath, Map<contentHash, {fileName, lineNumber, side}>>
    // where the position is the first line of the hunk. Symmetric with
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
    // OR merely queued because its hunk has no anchor yet. This is
    // deliberately separate from `_summariesGenerated` (which gates the
    // `.active` blue styling and tracks summaries actually mounted): a
    // valid summary can arrive before its anchor exists (a held-back diff,
    // a summary fetched before the diff's anchors were registered), and the
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
    // Re-measures the mounted tour bar; see _trackTourBarHeight().
    this._tourBarResizeObserver = null;
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
    this.commentManager = new window.CommentManager(this);
    this.suggestionManager = new window.SuggestionManager(this);
    this.fileCommentManager = window.FileCommentManager ? new window.FileCommentManager(this) : null;

    // The diff pane's viewer (PierreBridge over @pierre/diffs' CodeView).
    // Read the persisted diff-view preference so the first render uses the
    // saved style (no flash, no double render). localStorage is the single
    // source of truth shared with DiffOptionsDropdown; readPersistedDiffView
    // (from DiffOptionsDropdown.js, loaded first) owns the key + validation.
    const initialDiffStyle = window.readPersistedDiffView
      ? window.readPersistedDiffView()
      : (localStorage.getItem('pair-review-diff-view') === 'split' ? 'split' : 'unified');
    const bridgeOptions = {
      theme: this.currentTheme,
      diffStyle: initialDiffStyle,
      onCommentClick: (fileName, lineNumber, side, target) => {
        // target.isRange is true when the user selected multiple lines
        const diffPosition = this.pierreBridge.getDiffPosition(fileName, target.start, target.side);
        if (target.isRange) {
          this.showCommentForm(fileName, target.start, diffPosition, target.end, target.side);
        } else {
          this.showCommentForm(fileName, lineNumber, diffPosition, null, side);
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
    };
    this.pierreBridge = this._createBridge(bridgeOptions);

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

    // Wire the file navigator toggles once; the sidebar markup is static, so
    // this must not wait for (or depend on) a non-empty file list
    this.setupSidebarToggle();

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
        // Without the viewer (its bundle did not load) nothing can apply the
        // Unified/Split control, and the pane shows an error instead of a diff.
        diffViewAvailable: Boolean(this.pierreBridge),
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
   * mutation requests (POST/PUT/DELETE) targeting the review API, and to
   * review submission (POST /api/pr/:owner/:repo/:number/submit-review).
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

      // Only intercept mutations to the reviews API, plus review submission
      // (it broadcasts review:comments_changed too)
      if ((method === 'POST' || method === 'PUT' || method === 'DELETE') &&
          (url.includes('/api/reviews/') || SUBMIT_REVIEW_URL.test(url)) && prManager._clientId) {
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
   * The page's state of the files of the diff pane that is not persisted:
   * what is collapsed right now, and what the page holds for the virtualized
   * viewer. Set up once, by the constructor.
   * @private
   */
  _initPaneState() {
    // Whether each file of the pane is collapsed right now, by state key
    // (_fileStateKey). A file is collapsed because it is generated, viewed or
    // was collapsed by the reader, and the reader can expand it whatever the
    // reason, so this is state of its own: seeded when a file is rendered,
    // written by setFileCollapsed, read by isFileCollapsed.
    this._fileCollapsed = new Map();
    // The virtualized viewer's per-file page state: cached headers by path,
    // the paths whose items are mounted, the context files that are items.
    this._fileHeaders = new Map();
    this._mountedDiffItems = new Set();
    this._contextItemIds = new Set();
    // The files whose summary toggle has been brought in line with their
    // summaries in this render (_noteSummaryToggleSynced).
    this._summaryToggleSyncedFiles = new Set();
    // Contents of the context files, by path: { text, seq }. `seq` changes
    // whenever other contents are loaded for a path.
    this._contextContents = new Map();
    this._contextContentsSeq = 0;
    this._contextLoadGen = 0;
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
   * Track the mounted tour bar's height (it grows when wrapped). Call after each mount.
   */
  _trackTourBarHeight() {
    const bar = document.querySelector('.tour-bar');
    if (!bar) return;

    const update = () => {
      if (bar.offsetHeight) {
        document.documentElement.style.setProperty(
          '--tour-bar-rendered-height', bar.offsetHeight + 'px'
        );
      }
    };
    update();

    if (typeof ResizeObserver !== 'undefined') {
      this._tourBarResizeObserver?.disconnect();
      this._tourBarResizeObserver = new ResizeObserver(update);
      this._tourBarResizeObserver.observe(bar);
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

    // Reload user comments when the reviewer changes the comment panel's
    // filters (show dismissed, show posted). loadUserComments reads them.
    document.addEventListener('commentFilterChanged', () => {
      this.loadUserComments();
    });
  }

  /**
   * Setup delegated event listeners for comment form keyboard shortcuts
   * This avoids memory leaks from attaching listeners to each textarea
   */
  setupCommentFormDelegation() {
    // "Update on GitHub" on an edited posted comment, in any diff renderer
    document.addEventListener('click', (e) => {
      const button = e.target.closest?.('.btn-update-on-host');
      if (!button || button.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      this.updatePostedCommentOnHost(button.dataset.updateCommentId).then(result => {
        if (result?.ok) window.toast?.showSuccess(`Comment updated on ${window.PostedComment.escapeHtml(window.PostedComment.hostName())}`);
      });
    });

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
        if (cancelBtn) cancelBtn.click();
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

      // Load saved comments: uses the comment panel's filters (restored from localStorage by setPR)
      await this.loadUserComments();

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
   * Used by anything that destroys and re-mounts the diff: refreshPR, the
   * whitespace toggle and the pre-analysis refresh in PR mode, and in local
   * mode (local.js) the whitespace toggle, the refresh and the scope change.
   * The local base-branch change does not call it (main's behaviour, kept
   * and characterized). Centralizing keeps the three
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
    await this.loadUserComments();
    await this.loadAISuggestions(null, analysisRunId);
    // External sources require a real pull request: nothing to re-anchor in
    // local mode, whose re-render paths (whitespace, refresh, scope) share
    // this helper. Same guard as _loadExternalComments.
    if (typeof window !== 'undefined' && window.PAIR_REVIEW_LOCAL_MODE) return;
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
   * Compute per-hunk summary anchor positions for a Pierre-rendered file.
   *
   * The viewer draws into a shadow DOM the page does not own, so each hunk's
   * first rendered line is derived from the patch text and PierreBridge slots
   * the summary card below it. Positions come purely from the patch — the
   * canonical content hashes still come from the backend.
   *
   * Anchor rules (the hunk's first rendered row):
   *   - first line is an addition (`+`) or context (` `) → side 'RIGHT', at the
   *     hunk's NEW start line (the line exists in the new file);
   *   - first line is a deletion (`-`), e.g. a pure-deletion hunk → side
   *     'LEFT', at the hunk's OLD start line.
   *
   * Fails closed on hash/hunk count drift (the `?w=1` divergence): returns an empty map so summaries simply don't
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
    // to the wrong hunk.
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
      // First rendered line of the hunk ('' is a blank context line).
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
   * Wire a changed file's hunk anchors to their canonical content hashes,
   * then mount any summary that already arrived for those hunks. An anchor
   * is a position (`{fileName, lineNumber, side}`); summaries mount as
   * PierreBridge annotations.
   *
   * Called once per file from renderDiff (the file has its record in
   * `pierreBridge.files` by then) and again when a held-back diff is shown.
   * Idempotent — re-running re-sets the same map entries and re-drains an
   * already-empty pending queue.
   * @param {Object} file - A changed_files entry with `.file`, `.patch`, `.hunk_hashes`
   */
  _registerPierreHunkAnchorsForFile(file) {
    if (!file || !file.patch) return;
    const fileName = file.file;
    // addAnnotation needs the file's record.
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
      // Scope by file so a hash shared across files can't cross-wire anchors.
      anchors.set(hash, { fileName, lineNumber: pos.lineNumber, side: pos.side });
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
   * Anchors are registered per file from data
   * (_registerPierreHunkAnchorsForFile, for every file in renderDiff and
   * again when a held-back diff is shown). Summaries of a hunk that has no
   * anchor yet are queued in `_pendingSummariesByHash` (via
   * _applyHunkSummaries / _renderOneSummary) and drained when it gets one.
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
      // Apply per-file hidden state to the files that are drawn already,
      // syncing both the file's class AND the toggle button so its visible
      // state and aria-pressed match the persisted hidden flag. The file's
      // element is the viewer's, which uses it again for another file: the
      // class is the bridge's to stamp from data (_fileHostClasses), as in
      // toggleFileSummaries, never written on the element from here.
      for (const filePath of this.summariesHiddenFiles) {
        this._noteSummaryToggleSynced(filePath);
        this.pierreBridge?.refreshHostState(filePath);
        const wrapper = this.pierreBridge?.findFileElement(filePath);
        if (!wrapper) continue;
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
    this._noteSummaryToggleSynced(filePath);
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
  _syncFileSummaryToggleButton(btn, filePath, { live = true } = {}) {
    if (!btn || !filePath) return;
    const hasSummaries = live && (this._summaryHashesByFile.get(filePath)?.size || 0) > 0;
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
   * Record that a file's summary toggle was brought in line with the file's
   * summaries: a summary was drawn on the file, its hidden state was
   * restored, or the reader used the toggle.
   *
   * A toggle starts out saying "No summaries available": a header is built
   * before the file's hunks are known. Where a header is an element of the
   * page for as long as the diff is drawn, that is what the toggle shows
   * until one of those three things happens. A header that is drawn again
   * whenever its file comes near the viewport (_syncFileHeader) must not
   * enable the toggle of a file without a summary merely by being drawn, so
   * it asks this record.
   * @param {string} filePath
   * @private
   */
  _noteSummaryToggleSynced(filePath) {
    if (filePath) this._summaryToggleSyncedFiles.add(filePath);
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
   * Resolve the anchor position for (filePath, hash) against the file-scoped
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
   * @returns {{fileName: string, lineNumber: number, side: string}|null}
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
   * Render a single summary card, or queue it if the matching hunk's anchor
   * is not registered yet (a summary pushed before the diff is drawn).
   * Trivial / model-skipped / model-malformed rows are ignored.
   * @param {Object} summary - { content_hash, summary_text, trivial_reason }
   * @param {string} [filePath] - File the summary belongs to. Used to scope
   *   both the anchor lookup and the pending-queue key so a cross-file hash
   *   collision can't misroute it to the wrong file's hunk.
   * @returns {HTMLElement|null} The mounted card, or null if queued/skipped.
   */
  _renderOneSummary(summary, filePath) {
    if (!summary || !summary.content_hash) return null;
    if (!summary.summary_text) return null; // trivial / opt-out — nothing to show
    const hash = summary.content_hash;
    const anchor = this._findSummaryAnchor(filePath, hash);
    if (!anchor) {
      // Anchor not registered yet → defer; the render pass that registers
      // the hash will drain this map.
      this._queuePendingSummary(filePath, summary);
      return null;
    }
    if (!this.hunkSummaryRenderer) return null;

    // An anchor is a position ({fileName, lineNumber, side}); the card is a
    // bridge annotation. The file may have left the pane since its anchor
    // was registered; addAnnotation does nothing without a record, so
    // requeue rather than silently drop.
    if (!this.pierreBridge?.files?.has(anchor.fileName)) {
      this._queuePendingSummary(filePath, summary);
      return null;
    }
    return this.hunkSummaryRenderer.renderPierre(anchor.fileName, anchor, summary);
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
    // The file's element is the viewer's: it stamps the class from data
    // (_fileHostClasses), so it is asked to stamp again.
    this.pierreBridge?.refreshHostState(filePath);
    this._noteSummaryToggleSynced(filePath);
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
      // but haven't mounted (their hunk has no anchor yet) toggle
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
    this._trackTourBarHeight();
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
    // The measured height is only read under body.tour-active, so a stale
    // value is harmless; just stop observing the removed bar.
    this._tourBarResizeObserver?.disconnect();
    this._tourBarResizeObserver = null;
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
      debounced('contextFiles', () => this.loadContextFiles({ whenIdle: true }));
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
        this.loadContextFiles({ whenIdle: true });
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
        this._setDiffStatus('<div class="no-diff">Failed to load changes</div>', { hideScroller: true });
      }
    } catch (error) {
      console.error('Error loading files:', error);
      this._setDiffStatus('<div class="no-diff">Error loading changes</div>', { hideScroller: true });
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

    // Re-fetch and re-render the diff. The viewer keeps the reader's place
    // (the first visible line of the file they were in) through the render.
    await this.loadAndDisplayFiles(owner, repo, number);

    // Re-anchor every overlay (user comments, AI suggestions, external
    // comments) via the shared helper so the three renderers can't drift.
    // The diff was just replaced, so external-comment cards are gone
    // until loadAndRender puts them back.
    await this._rerenderAllOverlays({ analysisRunId: this.selectedRunId });
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
   * Unlike handleWhitespaceToggle, this does NOT re-fetch the diff: the
   * viewer redraws its files in the new style, keeps their annotations (user
   * comments, AI suggestions, external comments) and keeps the first visible
   * line where it is, so there is no need to invoke _rerenderAllOverlays or
   * to restore a scroll position here.
   * Shared by both PR mode and local mode (local.js patches PRManager).
   * @param {('unified'|'split')} mode
   * @returns {boolean} false when there is no viewer to apply the mode
   */
  handleDiffViewChange(mode) {
    // No bridge means no renderer can apply the swap. Report failure so the
    // dropdown rolls back its selection instead of persisting a mode the diff
    // won't reflect. (The dropdown also hides the control via
    // diffViewAvailable, so this is defense in depth.)
    if (!this.pierreBridge) return false;
    return this.pierreBridge.setDiffStyle(mode);
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

      // Key by the decoded new path: the `rename to` line when there is one,
      // otherwise the 'b' side of the diff --git line. Git C-quotes names
      // containing control characters, `"` or `\` (`"b/tab\tname.js"`), and
      // the server keys changed_files, comments and suggestions by the
      // decoded spelling.
      const paths = window.GitPaths.parsePatchPaths(part);
      if (paths) {
        filePatchMap.set(paths.newPath, part);
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
   * Normal-sized files get syntax highlighting. A file over the per-file
   * limit is drawn as plain text, so that highlighting it cannot swamp the
   * UI. An extremely large patch is held back until the reader asks for it
   * ("Large diff ... Load diff").
   *
   * @param {Object} file
   * @returns {{forcePlainText: boolean, deferDiff: boolean}}
   */
  _getPierreRenderDecision(file) {
    if (!file?.patch || file.binary) {
      return { forcePlainText: false, deferDiff: false };
    }

    const metrics = this._getPatchMetrics(file);
    if (
      metrics.chars > PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_CHARS ||
      metrics.lines > PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_LINES
    ) {
      return { forcePlainText: true, deferDiff: true };
    }

    const forcePlainText =
      metrics.chars > PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_CHARS ||
      metrics.lines > PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES;
    return { forcePlainText, deferDiff: false };
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
      if (!f.patch || f.binary || !this._isDiffFileRendered(f.file)) return false;
      return forceFiles.has(f.file) || this._isPatchEligibleForContentUpgrade(f);
    });
  }

  /**
   * Whether a changed file is drawn right now: its item is mounted. (The
   * viewer holds a record for every file, so `files.has` would name the whole
   * diff.) Background content upgrades go to drawn files only.
   * @param {string} filePath
   * @returns {boolean}
   */
  _isDiffFileRendered(filePath) {
    return this._mountedDiffItems.has(filePath);
  }

  _getChangedFile(filePath) {
    return this.changedFilesByPath?.get(filePath) || null;
  }

  async _fetchAndUpgradePierreFileContents(file, signal, options = {}) {
    if (signal?.aborted) return false;

    const reviewId = this.currentPR?.id;
    if (!reviewId || !file?.patch || file.binary) return false;
    if (this.pierreBridge?.files?.get(file.file)?.baseMetadata) return true;

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
      if (signal?.aborted) return false;
      if (options.waitForPointerIdle !== false) {
        await this._waitForPierrePointerIdle(file.file, signal);
      }
      if (signal?.aborted) return false;
      if (this.pierreBridge?.files?.get(file.file)?.baseMetadata) return true;
      return this.pierreBridge.upgradeFileContents(file.file, oldFile, newFile);
    } catch (err) {
      if (err.name === 'AbortError') return false;
      console.error(`Failed to fetch file contents for ${file.file}:`, err);
      return false;
    }
  }

  /**
   * Hold a background content upgrade of a file back while it would get in
   * the reader's way. The upgrade re-creates the file's rows.
   *
   * While the pointer rests on the file, for at most
   * PIERRE_POINTER_UPGRADE_DELAY_MS: the row under the pointer would be
   * replaced under it. And, where the bridge can tell
   * (PierreBridge.isEditingInside), for as long as the reader is
   * typing in the file: the rows' replacement takes the keyboard focus out
   * of a comment form, and what is typed next would go nowhere. That wait has
   * no limit; it ends when the focus leaves the field, when the file goes
   * out of the viewer's mounted window, or with the render (the signal).
   *
   * A reveal the reader asked for does not come through here
   * (waitForPointerIdle: false).
   * @param {string} filePath
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async _waitForPierrePointerIdle(filePath, signal) {
    const pointerOver = () => !!this.pierreBridge?.isPointerOverFile?.(filePath);
    const typing = () => !!this.pierreBridge?.isEditingInside?.(filePath);
    if (!pointerOver() && !typing()) return;

    const start = Date.now();
    while (
      !signal?.aborted &&
      (typing() || (pointerOver() && Date.now() - start < PRManager.PIERRE_POINTER_UPGRADE_DELAY_MS))
    ) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  _getOrStartPierreContentUpgrade(file, signal, options = {}) {
    if (!file?.file) return Promise.resolve(false);
    if (!this._pierreContentUpgradePromises) {
      this._pierreContentUpgradePromises = new Map();
    }
    // The immediate (user-driven) and background paths are keyed separately ON
    // PURPOSE. Do NOT merge them into one key: sharing the background promise
    // would make an immediate, user-driven upgrade inherit that promise's
    // pointer-idle wait (_waitForPierrePointerIdle), stalling it behind idle
    // throttling. The known cost of the split is a duplicate fetch + JSON parse
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

  /**
   * Whether a changed file that is drawn is still to be given its contents
   * in the background: the catch-up sweep for the files drawn first has not
   * run yet (_upgradeFilesWithContents), a file is queued or its upgrade is
   * in flight (the request, the yield, the wait while the pointer rests on
   * the file or the reader types in it: _waitForPierrePointerIdle), or an
   * upgrade a navigation asked for is in flight. The viewer's bridge asks
   * this while it keeps the pane at its end after a collapse
   * (PierreBridge._holdEndAfterCollapse); it puts its own limit on the wait.
   * False once the render these belong to has been replaced.
   * @returns {boolean}
   * @private
   */
  _isContentUpgradeAwaited() {
    const signal = this._fileContentsAbort?.signal;
    if (!signal || signal.aborted) return false;
    if (this._pierreUpgradeSweepSignal === signal) return true;
    const state = this._fileContentsUpgradeState;
    if (state && state.signal === signal && (state.active > 0 || state.pending.length > 0)) return true;
    return (this._pierreContentUpgradePromises?.size || 0) > 0;
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

  // ─── The virtualized viewer ─────────────────────────────────────────
  //
  // One CodeView draws every file of the pane, changed files and context
  // files alike (PierreBridge). PRManager gives it an ordered list of
  // entries and three hooks, and keeps what is the page's: which files there
  // are, their collapsed and viewed state, their headers and comment zones.

  /**
   * Build the bridge of the virtualized viewer.
   * @param {Object} interaction - the callbacks the bridge takes
   * @returns {Object|null} null when the viewer's bundle is not on the page;
   *   renderDiff then shows an error in place of the diff
   * @private
   */
  _createBridge(interaction) {
    const Bridge = window.PierreBridge;
    if (!Bridge) return null;
    const bridge = new Bridge({
      ...interaction,
      root: document.getElementById('diff-container'),
      hooks: {
        renderHeader: (id, kind) => this._renderFileHeader(id, kind),
        hostState: (id) => this._fileHostClasses(id),
        onItemLifecycle: (id, phase) => this._onDiffItemLifecycle(id, phase),
        resolvePath: (path) => this._canonicalFilePath(path),
        contentsAwaited: () => this._isContentUpgradeAwaited(),
      },
      collaborators: () => ({
        escapeHtml: (text) => this.escapeHtml(text),
        PostedComment: window.PostedComment,
        suggestionManager: this.suggestionManager,
        // The card of a comment on a context file says how it is posted.
        isContextFile: (path) => this.fileKind(path) === 'context',
      }),
    });
    if (!bridge.available) {
      bridge.destroy();
      return null;
    }
    bridge.registerAnnotationRenderer('file-comments', (data) => this._ensureFileCommentsZone(data.file));
    bridge.registerAnnotationRenderer('notice', (data, id, fileName) => this._buildDiffNotice(fileName, data));
    return bridge;
  }

  /**
   * What a path is in the diff pane, from data: a changed file, a context
   * file, or neither. The one resolver; nothing asks the DOM.
   * @param {string} filePath - the pane's own path of the file
   * @returns {'diff'|'context'|null}
   */
  fileKind(filePath) {
    if (!filePath) return null;
    if (this.changedFilesByPath?.has(filePath)) return 'diff';
    if (this._contextItemIds.has(filePath)) return 'context';
    const kind = this.pierreBridge?.files?.get(filePath)?.kind;
    if (kind === 'diff' || kind === 'context') return kind;
    return (this.contextFiles || []).some(row => row.file === filePath) ? 'context' : null;
  }

  /**
   * The key a file's collapsed and viewed state is kept under: the path for
   * a changed file, `context:<path>` for a context file, so that the two
   * never share state when a path is one and later the other (#540). The key
   * is persisted with the viewed state; its format must not change.
   * @param {string} filePath - the pane's own path of the file
   * @returns {string}
   */
  _fileStateKey(filePath) {
    return this.fileKind(filePath) === 'context' ? this._contextStateKey(filePath) : filePath;
  }

  /**
   * The number of lines of a text, counted as an editor counts them: a final
   * newline ends the last line and does not start another. This is how the
   * viewer counts a context file's lines.
   * @param {string} text
   * @returns {number}
   */
  static countTextLines(text) {
    if (typeof text !== 'string' || text === '') return 0;
    let lines = 1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
    return text.endsWith('\n') ? lines - 1 : lines;
  }

  /**
   * The lines a stored context range shows in a file of `totalLines` lines.
   * A range that runs past the end of the file is moved up so that it keeps
   * its size, as far as line 1.
   * @param {{line_start: number, line_end: number}} row
   * @param {number} totalLines
   * @returns {{startLine: number, endLine: number}|null} null when the file
   *   has no such lines
   */
  _effectiveContextRange(row, totalLines) {
    const lineStart = Number(row?.line_start);
    const lineEnd = Number(row?.line_end);
    if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd) || !(totalLines > 0)) return null;
    const clampedEnd = Math.min(lineEnd, totalLines);
    const intendedSize = lineEnd - lineStart + 1;
    let effectiveStart = Math.max(1, lineStart);
    const actualSize = clampedEnd - effectiveStart + 1;
    if (actualSize < intendedSize && effectiveStart > 1) {
      effectiveStart = Math.max(1, effectiveStart - (intendedSize - actualSize));
    }
    if (clampedEnd < effectiveStart) return null;
    return { startLine: effectiveStart, endLine: clampedEnd };
  }

  /**
   * The entry of one changed file for the viewer's list. Also seeds the
   * file's collapsed state: generated, viewed, or collapsed by the reader.
   * @param {Object} file - a changed_files entry
   * @returns {Object}
   * @private
   */
  _buildDiffEntry(file) {
    const path = file.file;
    const isGenerated = file.generated || this.generatedFiles.has(path);
    // Seeded once per render: afterwards the state is the reader's.
    if (!this._fileCollapsed.has(path)) {
      this._fileCollapsed.set(path, !!(isGenerated || this.viewedFiles.has(path) || this.collapsedFiles.has(path)));
    }
    const collapsed = this._fileCollapsed.get(path);
    this._ensureFileCommentsZone(path);

    const decision = this._getPierreRenderDecision(file);
    const entry = {
      id: path,
      kind: 'diff',
      patch: file.binary ? null : (file.patch || null),
      status: file.status || null,
      collapsed,
      forcePlainText: decision.forcePlainText,
      deferred: decision.deferDiff,
    };
    if (decision.deferDiff) {
      const metrics = this._getPatchMetrics(file);
      entry.notice = { kind: 'large-diff', chars: metrics.chars, lines: metrics.lines };
    }
    return entry;
  }

  /**
   * The ordered list of everything the diff pane shows: the changed files in
   * diff order, and each context file before the first entry whose path
   * sorts after it. The one place the list is built.
   *
   * The diff wins: a context row whose path is a changed file gets no entry
   * (the row stays stored and comes back when the file leaves the diff). A
   * context path whose contents could not be loaded gets none either; its
   * sidebar entry stays.
   * @returns {Array<Object>} entries for PierreBridge
   * @private
   */
  _buildPaneEntries() {
    const changed = this.changedFilesByPath || new Map();
    const entries = [...changed.values()].map(file => this._buildDiffEntry(file));

    const rowsByPath = new Map();
    for (const row of this.contextFiles || []) {
      if (!row?.file || changed.has(row.file)) continue;
      if (!rowsByPath.has(row.file)) rowsByPath.set(row.file, []);
      rowsByPath.get(row.file).push(row);
    }
    const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    for (const path of [...rowsByPath.keys()].sort(byCodeUnit)) {
      const cached = this._contextContents.get(path);
      if (!cached) continue;
      const totalLines = PRManager.countTextLines(cached.text);
      const ranges = rowsByPath.get(path)
        .map(row => this._effectiveContextRange(row, totalLines))
        .filter(Boolean);
      const key = this._contextStateKey(path);
      if (!this._fileCollapsed.has(key)) {
        this._fileCollapsed.set(key, this.viewedFiles.has(key) || this.collapsedFiles.has(key));
      }
      this._ensureFileCommentsZone(path, { context: true });
      const entry = {
        id: path,
        kind: 'context',
        contents: cached.text,
        contentsSeq: cached.seq,
        ranges,
        collapsed: this._fileCollapsed.get(key),
      };
      const index = entries.findIndex(other => other.id > path);
      if (index === -1) entries.push(entry);
      else entries.splice(index, 0, entry);
    }
    return entries;
  }

  /**
   * Render the diff: every file of the pane becomes an item of the one
   * viewer. The reader's position is restored by the bridge when the file
   * they were in is still there.
   *
   * Callers: loadAndDisplayFiles (PR mode: first load, whitespace toggle,
   * refresh) and LocalManager.loadLocalDiff (Local mode: first load,
   * whitespace toggle, refresh, scope change, base-branch change).
   * @param {Object} pr - PR data with files
   */
  renderDiff(pr) {
    // A missing list is not an empty diff: leave what is drawn alone.
    const files = pr ? (pr.changed_files || pr.files) : null;
    if (!Array.isArray(files)) return;

    this._abortContentUpgrades();
    if (!document.getElementById('diff-container')) return;
    // Before the list is replaced: the tour's exit restores state of files
    // that must still be the pane's.
    if (this._tourIsActive && this._tourIsActive()) {
      this._exitTour();
    }
    this._resetHunkSummaryRenderState();

    this.changedFilesByPath = new Map(files.map(file => [file.file, file]));
    for (const file of files) {
      if (file.generated) {
        this.generatedFiles.set(file.file, { insertions: file.insertions, deletions: file.deletions });
      }
    }
    // Headers, comment zones and collapsed state belong to a render.
    this._fileHeaders = new Map();
    this._fileCollapsed = new Map();
    this._mountedDiffItems = new Set();
    this.fileCommentManager?.releaseAllZones?.();

    if (!this.pierreBridge) {
      this._setDiffStatus(
        '<div class="no-diff diff-viewer-missing">The diff viewer could not be loaded. Reload the page; if this message stays, reinstall pair-review.</div>',
        { hideScroller: true }
      );
      return;
    }

    // The container must be displayed before the viewer measures its rows.
    this._setDiffStatus(null);
    this.pierreBridge.renderAll(this._buildPaneEntries(), { keyPrefix: this.currentPR?.id ?? 'review' });
    // The page starts a render knowing no context item, so the load below
    // reloads the comments when the pane has any.
    this._contextItemIds = new Set();
    if (files.length === 0) {
      // The viewer stays: context files are its items.
      this._setDiffStatus('<div class="no-diff">No files changed</div>', { hideScroller: false });
    }
    for (const file of files) this._registerPierreHunkAnchorsForFile(file);

    // The rows are the review's, not the render's: they are kept, and the
    // contents of every context file are read again (they may have changed
    // with the diff).
    this.loadContextFiles({ refreshContents: true });
    this._startPostRenderLoads();
  }

  /**
   * Take every file out of the viewer (an empty diff), and forget what the
   * page held for them: headers, comment zones, collapsed state. The
   * container's children are the viewer's; it is given an empty list.
   *
   * Caller: LocalManager.loadLocalDiff when the scope has no changes.
   * @private
   */
  _clearDiffItems() {
    this.fileCommentManager?.releaseAllZones?.();
    this.changedFilesByPath = new Map();
    this._fileHeaders = new Map();
    this._fileCollapsed = new Map();
    this._mountedDiffItems = new Set();
    this._contextItemIds = new Set();
    // A context load in flight stops, and leaves nothing for the next one.
    // Loads that were overtaken by another load must not wait for that one
    // and then run again (_afterOvertakenContextLoad): the pane they would
    // put a context file back into has been emptied.
    this._contextLoadGen = (this._contextLoadGen || 0) + 1;
    this._contextLoadPending = null;
    this._contextLoadTail = null;
    this.pierreBridge?.renderAll([], { keyPrefix: this.currentPR?.id ?? 'review' });
  }

  /**
   * The header of a file of the pane, for the viewer: one element per file,
   * built on first use and re-stamped from data every time the viewer draws
   * it (a header that was off screen missed every change meanwhile).
   * @param {string} id - the file's path
   * @param {'diff'|'context'} kind
   * @returns {HTMLElement|null}
   * @private
   */
  _renderFileHeader(id, kind) {
    let header = this._fileHeaders.get(id);
    if (!header) {
      if (kind === 'context') {
        const row = (this.contextFiles || []).find(contextFile => contextFile.file === id);
        header = this._buildContextFileHeader(id, {
          label: row?.label || null,
          zone: this._ensureFileCommentsZone(id, { context: true }),
        });
      } else {
        const file = this._getChangedFile(id);
        if (!file) return null;
        header = this._buildFileHeader(file, {
          collapsed: this.isFileCollapsed(id) === true,
          zone: this._ensureFileCommentsZone(id),
        });
      }
      this._fileHeaders.set(id, header);
    }
    this._syncFileHeader(id, header);
    return header;
  }

  /**
   * Re-stamp a file's cached header from data: chevron, Viewed, the
   * file-comment indicator, the summary toggle. Idempotent; only touches the
   * header's own DOM.
   * @param {string} filePath - the pane's own path of the file
   * @param {HTMLElement} [header]
   * @private
   */
  _syncFileHeader(filePath, header = this._fileHeaders?.get(filePath)) {
    if (!header) return;
    window.DiffRenderer.updateFileHeaderState(header, this.isFileCollapsed(filePath) !== true);
    window.DiffRenderer.updateFileViewedState(header, this.viewedFiles.has(this._fileStateKey(filePath)));
    const zone = this.getFileCommentsZone(filePath);
    if (zone && zone.dataset.fileName === filePath && this.fileCommentManager && zone.querySelector('.file-comments-container')) {
      this.fileCommentManager.updateCommentCount(zone);
    }
    const summaryToggle = header.querySelector('.file-header-summary-toggle');
    if (summaryToggle) {
      if (this._summariesEnabled === false) {
        summaryToggle.remove();
      } else {
        if (this._summariesEnabled === true && summaryToggle.classList.contains('summary-toggle-pending')) {
          summaryToggle.classList.remove('summary-toggle-pending');
          summaryToggle.style.display = '';
        }
        this._syncFileSummaryToggleButton(summaryToggle, filePath, {
          live: this._summaryToggleSyncedFiles.has(filePath),
        });
      }
    }
    const badge = header.querySelector('.context-badge');
    if (badge) {
      const row = (this.contextFiles || []).find(contextFile => contextFile.file === filePath);
      if (row?.label) badge.title = row.label;
      else badge.removeAttribute('title');
    }
  }

  /**
   * The classes a file's element carries besides the viewer's own
   * (`collapsed`, `context-file`, `has-diff-lines`): what pr.css keys on for
   * a generated file, for a file whose summaries are hidden, and for a file
   * whose diff is drawn.
   * @param {string} id - the file's path
   * @returns {string[]}
   * @private
   */
  _fileHostClasses(id) {
    const classes = [];
    const file = this._getChangedFile(id);
    if (file && (file.generated || this.generatedFiles.has(id))) classes.push('generated-file');
    if (this.summariesHiddenFiles?.has(id)) classes.push('summaries-hidden-file');
    // A changed file whose diff is drawn (not a binary file, not a diff that
    // is held back for its size) had a code block under its header before
    // the migration to the viewer, lines or not; pr.css draws its empty form.
    if (file && file.patch && !file.binary && !this.pierreBridge?.files?.get(id)?.deferred) {
      classes.push('has-diff-body');
    }
    return classes;
  }

  /**
   * The viewer mounted, updated or unmounted a file's item. A changed file
   * that comes into the mounted window is queued for its content upgrade
   * (what makes its hidden lines expandable). Context files hold their whole
   * contents already.
   * @param {string} id - the file's path
   * @param {'mount'|'update'|'unmount'} phase
   * @private
   */
  _onDiffItemLifecycle(id, phase) {
    if (phase === 'unmount') {
      this._mountedDiffItems.delete(id);
      return;
    }
    if (phase !== 'mount') return;
    this._mountedDiffItems.add(id);
    const file = this._getChangedFile(id);
    if (file) this._enqueuePierreContentUpgrade(file);
  }

  /**
   * The file-comment zone of a file of the pane, created on first use and
   * held by FileCommentManager's registry whether or not it is on screen.
   * @param {string} filePath - the pane's own path of the file
   * @param {Object} [options]
   * @param {boolean} [options.context] - the file is a context file
   * @returns {HTMLElement|null}
   * @private
   */
  _ensureFileCommentsZone(filePath, { context = this.fileKind(filePath) === 'context' } = {}) {
    if (!this.fileCommentManager) return null;
    // The registry's lookup is tolerant of the forms a path comes in
    // ('a.js' finds the zone of 'src/a.js'); a file's own zone is the one
    // that carries exactly its path.
    const existing = this.getFileCommentsZone(filePath);
    if (existing && existing.dataset.fileName === filePath) return existing;
    return this.fileCommentManager.createFileCommentsZone(filePath, { context: !!context });
  }

  /**
   * The message a file shows under its header in place of its lines.
   * @param {string} filePath
   * @param {{kind: string, chars: number, lines: number}} data
   * @returns {HTMLElement|null}
   * @private
   */
  _buildDiffNotice(filePath, data) {
    if (data?.kind !== 'large-diff') return null;
    const file = this._getChangedFile(filePath);
    return file ? this._createDeferredDiffPlaceholder(file) : null;
  }

  /**
   * Show the lines of a file whose diff was held back for its size: the same
   * item of the viewer, now with its lines (_materializeDeferredDiff is the
   * only caller).
   * @param {string} filePath - the pane's own path of the file
   * @param {Object} [options]
   * @param {boolean} [options.reanchor=false] - reload comments and
   *   suggestions afterwards (the reader's own click; other callers do that
   *   themselves)
   * @returns {Promise<boolean>} true when the file shows its diff on return
   * @private
   */
  async _materializeDeferredItem(filePath, { reanchor = false } = {}) {
    const renderGen = this._renderGen;
    await this._yieldForDiffWork(this._fileContentsAbort?.signal || null);
    if (renderGen !== this._renderGen) return false;
    if (!this.pierreBridge?.materializeDeferred?.(filePath)) return false;
    const file = this._getChangedFile(filePath);
    if (file) this._registerPierreHunkAnchorsForFile(file);
    if (reanchor) await this._reanchorInlineFeedbackAfterDeferredRender();
    return true;
  }

  /**
   * The ids of the context files that are items of the viewer now.
   * @returns {Set<string>}
   * @private
   */
  _currentContextItemIds() {
    const ids = new Set();
    for (const [id, record] of this.pierreBridge?.files || []) {
      if (record.kind === 'context') ids.add(id);
    }
    return ids;
  }

  /**
   * Compare the context files that are items now with those the page last
   * knew of, and drop what the page holds for the ones that went: header,
   * comment zone, collapsed state.
   * @returns {{created: string[], removed: string[]}}
   * @private
   */
  _noteContextItems() {
    const now = this._currentContextItemIds();
    const known = this._contextItemIds || new Set();
    const created = [...now].filter(id => !known.has(id));
    const removed = [...known].filter(id => !now.has(id));
    this._contextItemIds = now;
    for (const id of removed) {
      this._fileHeaders.delete(id);
      this._fileCollapsed.delete(this._contextStateKey(id));
      const zone = this.fileCommentManager?.getZone?.(id);
      if (zone && zone.dataset.fileName === id && this.fileKind(id) !== 'diff') {
        this.fileCommentManager.releaseZone(zone);
      }
    }
    return { created, removed };
  }

  /**
   * Bring the viewer's context items in line with the context rows and the
   * contents the page holds. Synchronous and idempotent, and the only caller
   * of the bridge's `reconcile`.
   * @param {Object} [options]
   * @param {boolean} [options.whenIdle=false] - for a change the reader did
   *   not just ask for (a push): wait while a selection is being dragged in
   *   the pane; the comments are then reloaded when it has been applied
   * @returns {{created: string[], removed: string[], deferred: boolean}}
   * @private
   */
  _syncContextItems({ whenIdle = false } = {}) {
    const bridge = this.pierreBridge;
    if (!bridge || typeof bridge.reconcile !== 'function') return { created: [], removed: [], deferred: false };
    let deferred = false;
    const result = bridge.reconcile(() => {
      const entries = this._buildPaneEntries();
      if (deferred) {
        // Applied later than asked for: nobody is waiting for the outcome.
        queueMicrotask(() => {
          if (this._noteContextItems().created.length > 0) this.loadUserComments();
        });
      }
      return entries;
    }, { whenIdle });
    if (result.deferred) {
      deferred = true;
      return { created: [], removed: [], deferred: true };
    }
    return { ...this._noteContextItems(), deferred: false };
  }

  /**
   * Load the review's context rows and the contents of their files, and
   * bring the pane's context items in line with them: data in, one
   * synchronous sync out. No step reads the DOM.
   *
   * Callers: renderDiff (with refreshContents), the context_files_changed
   * listener (with whenIdle), removeContextFile, ensureContextFile after a
   * PATCH and after a POST, the visibility handler. Any two can be in flight
   * together: the later one wins, and an earlier one stops at its next await
   * without touching the pane.
   *
   * What a caller that awaits a load may rely on: when the promise settles,
   * the pane has the rows of a request that was sent after the call (its own,
   * or the one of a later load), unless that request failed or the diff has
   * been replaced meanwhile (the new diff's own load then answers for the
   * pane). A load that was overtaken therefore settles only when the load
   * that overtook it has; it hands the later load what it was asked for
   * (fresh contents, "the reader is waiting"); and when the later load ends
   * without having applied anything, it runs again.
   * @param {Object} [options]
   * @param {boolean} [options.refreshContents=false] - read every context
   *   file's contents again, not only those the page does not hold
   * @param {boolean} [options.whenIdle=false] - see _syncContextItems
   * @returns {Promise<void>}
   */
  loadContextFiles({ refreshContents = false, whenIdle = false } = {}) {
    if (!this.currentPR?.id) return Promise.resolve();
    const gen = this._contextLoadGen = (this._contextLoadGen || 0) + 1;
    // What the loads that are still in flight were asked for goes to this
    // one, which will be the one that reaches the pane.
    const pending = this._contextLoadPending;
    const request = {
      refreshContents: refreshContents || !!(pending && pending.refreshContents),
      whenIdle: whenIdle && (!pending || pending.whenIdle),
    };
    this._contextLoadPending = request;
    const promise = this._runContextLoad(gen, request);
    this._contextLoadTail = { gen, promise };
    return promise;
  }

  /**
   * One load of the context rows and contents (see loadContextFiles, the
   * only caller).
   * @param {number} gen - this load's number
   * @param {{refreshContents: boolean, whenIdle: boolean}} request
   * @returns {Promise<void>}
   * @private
   */
  async _runContextLoad(gen, request) {
    const reviewId = this.currentPR.id;
    const renderGen = this._renderGen;
    const superseded = () => gen !== this._contextLoadGen || renderGen !== this._renderGen;
    // The last load in flight has ended, one way or the other: nothing is
    // carried to the next.
    const ended = () => {
      if (gen === this._contextLoadGen) this._contextLoadPending = null;
    };

    try {
      const response = await fetch(`/api/reviews/${reviewId}/context-files`);
      if (superseded()) return this._afterOvertakenContextLoad(gen, renderGen, request);
      if (!response.ok) return ended();
      const data = await response.json();
      if (superseded()) return this._afterOvertakenContextLoad(gen, renderGen, request);
      const rows = data.contextFiles || [];

      const changed = this.changedFilesByPath || new Map();
      const paths = [...new Set(rows.map(row => row.file))].filter(path => !changed.has(path));
      const wanted = paths.filter(path => request.refreshContents || !this._contextContents.has(path));
      const fetched = await Promise.all(wanted.map(async (path) => {
        try {
          const content = await this.fetchFileContent(path);
          return [path, content && Array.isArray(content.lines) ? content.lines.join('\n') : null];
        } catch (error) {
          console.error(`Error loading context file ${path}:`, error);
          return [path, null];
        }
      }));
      if (superseded()) return this._afterOvertakenContextLoad(gen, renderGen, request);

      const previousRows = this.contextFiles || [];
      this.contextFiles = rows;
      for (const [path, text] of fetched) {
        if (text == null) {
          // No contents: no item. The sidebar entry stays and the next load
          // tries again.
          this._contextContents.delete(path);
          continue;
        }
        const cached = this._contextContents.get(path);
        if (!cached || cached.text !== text) {
          this._contextContentsSeq = (this._contextContentsSeq || 0) + 1;
          this._contextContents.set(path, { text, seq: this._contextContentsSeq });
        }
      }
      const rowPaths = new Set(rows.map(row => row.file));
      for (const path of [...this._contextContents.keys()]) {
        if (!rowPaths.has(path)) this._contextContents.delete(path);
      }
      this._scrubRemovedContextState(previousRows);

      const { created } = this._syncContextItems({ whenIdle: request.whenIdle });
      this._contextLoadApplied = gen;
      ended();
      this.rebuildFileListWithContext();
      // Comments on lines of a file that has just become an item.
      if (created.length > 0) {
        await this.loadUserComments();
      }
    } catch (error) {
      ended();
      console.error('Error loading context files:', error);
    }
    return undefined;
  }

  /**
   * The rest of a context load that a later load, or a new diff, overtook:
   * wait for the load that is now the newest, so that whoever awaits this
   * one finds the pane as that load left it; and load again when that load
   * ended without reaching the pane (its request failed) and the diff is
   * still the one this load was started for.
   * @param {number} gen - the overtaken load's number
   * @param {number} renderGen - the render it was started for
   * @param {{refreshContents: boolean, whenIdle: boolean}} request
   * @returns {Promise<void>}
   * @private
   */
  async _afterOvertakenContextLoad(gen, renderGen, request) {
    const tail = this._contextLoadTail;
    // Nothing later was started when only the diff was emptied
    // (_clearDiffItems): there is nothing to wait for.
    if (!tail || tail.gen <= gen) return;
    await tail.promise;
    if (renderGen !== this._renderGen) return;
    if ((this._contextLoadApplied || 0) > gen) return;
    if (this._contextLoadTail !== tail) {
      // A newer load was started meanwhile (by another overtaken load that
      // ran again): it answers for this one too.
      await this._afterOvertakenContextLoad(gen, renderGen, request);
      return;
    }
    await this.loadContextFiles(request);
  }

  /**
   * Remove every stored range of a context file (its header's dismiss
   * button). The ranges are the review's rows, read from data.
   * @param {string} filePath
   * @returns {Promise<void>}
   * @private
   */
  async _dismissContextFile(filePath) {
    const ids = (this.contextFiles || [])
      .filter(row => row.file === filePath)
      .map(row => row.id);
    // One after the other: each removal reloads the rows.
    for (const id of ids) {
      await this.removeContextFile(id);
    }
  }

  /**
   * Stop the content upgrades of the diff that is about to be replaced.
   * @private
   */
  _abortContentUpgrades() {
    // Abort any in-flight file content fetches from progressive loading
    this._fileContentsAbort?.abort();
    this._fileContentsAbort = null;
    this._fileContentsUpgradeState = null;
    this._pierreContentUpgradePromises = new Map();
    this._pierreUpgradeCandidates = null;
    this._pierreUpgradeSweepSignal = null;
    this._deferredDiffRenderPromises = new Map();
  }

  /**
   * Reset what a render owns of the hunk summaries and the tour, and start a
   * new render generation. Runs before the files of the new diff are drawn.
   * @private
   */
  _resetHunkSummaryRenderState() {
    if (this.hunkSummaryRenderer) {
      this.hunkSummaryRenderer.reset();
    }
    this._tourStops = null;
    this._summaryAnchorsByHash = new Map();
    this._summaryHashesByFile = new Map();
    this._summaryToggleSyncedFiles = new Set();
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
  }

  /**
   * What is loaded once a new diff is in the pane: hunk summaries and the
   * tour. Fire-and-forget; the diff is usable while they arrive.
   * @private
   */
  _startPostRenderLoads() {
    // Fetch hunk summaries (Phase 5). Fire-and-forget — the diff is fully
    // usable while summaries arrive asynchronously. The anchors were
    // registered from data by renderDiff (_registerPierreHunkAnchorsForFile);
    // this loads the server's summary map and applies it to them.
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
   * Only files the viewer has mounted are upgraded in the background (the
   * rest of a large diff is upgraded when the reader reaches it). So this
   * records the eligible-by-size candidate set and the abort signal, and a
   * file is enqueued when the viewer mounts it (_onDiffItemLifecycle →
   * _enqueuePierreContentUpgrade). A delayed catch-up sweep enqueues what
   * was mounted before the candidate set existed (the files visible at
   * first), so both routes funnel through the de-duping
   * _enqueuePierreContentUpgrade.
   * @param {Array} files - The sorted changed_files array
   */
  _upgradeFilesWithContents(files) {
    if (!this.pierreBridge) return;

    const reviewId = this.currentPR?.id;
    if (!reviewId) return;

    const controller = new AbortController();
    this._fileContentsAbort = controller;
    const signal = controller.signal;

    this._pierreUpgradeCandidates = new Set(
      files
        .filter(f => f.patch && !f.binary && this._isPatchEligibleForContentUpgrade(f))
        .map(f => f.file)
    );
    if (this._pierreUpgradeCandidates.size === 0) return;

    // Until the catch-up sweep has run, the files drawn first await their
    // contents with nothing queued for them (_isContentUpgradeAwaited).
    this._pierreUpgradeSweepSignal = signal;
    const scheduleUpgrade = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
    setTimeout(() => scheduleUpgrade(() => {
      if (this._pierreUpgradeSweepSignal === signal) this._pierreUpgradeSweepSignal = null;
      if (signal.aborted || this._fileContentsAbort?.signal !== signal) return;
      // Catch-up: enqueue any candidate that is mounted by now. Files
      // mounted later are enqueued from _onDiffItemLifecycle.
      for (const file of this._getPierreContentUpgradeFiles(files)) {
        this._enqueuePierreContentUpgrade(file);
      }
    }), PRManager.PIERRE_BACKGROUND_UPGRADE_DELAY_MS);
  }

  /**
   * Enqueue a single mounted file for background content upgrade, reusing
   * the in-flight bounded queue when one exists so the concurrency cap is
   * honored and nothing is double-scheduled. Called both from the delayed
   * catch-up sweep and from _onDiffItemLifecycle when the viewer mounts a file.
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

  async _reanchorInlineFeedbackAfterDeferredRender() {
    try {
      await this.loadUserComments();
      await this.loadAISuggestions(null, this.selectedRunId);
    } catch (err) {
      console.error('Failed to re-anchor inline feedback after deferred diff render:', err);
    }
  }

  _formatDiffSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
  }

  _createDeferredDiffPlaceholder(file) {
    const metrics = this._getPatchMetrics(file);
    const placeholder = document.createElement('div');
    placeholder.className = 'no-diff large-diff-placeholder';

    const message = document.createElement('span');
    message.textContent = `Large diff (${this._formatDiffSize(metrics.chars)}, ${metrics.lines.toLocaleString()} lines)`;

    const loadButton = document.createElement('button');
    loadButton.type = 'button';
    loadButton.className = 'btn btn-sm btn-secondary large-diff-load-btn';
    loadButton.textContent = 'Load diff';
    loadButton.addEventListener('click', async () => {
      loadButton.disabled = true;
      loadButton.textContent = 'Loading...';
      // Through _materializeDeferredDiff, so that this click shares one
      // promise with a reveal that shows the same file (ensureLinesVisible).
      // reanchor:true because a click is NOT inside a loadUserComments /
      // loadAISuggestions flow, so the comments and suggestions of the file
      // must be put on the diff that is now drawn.
      await this._materializeDeferredDiff(file.file, { reanchor: true });
    });

    placeholder.appendChild(message);
    placeholder.appendChild(loadButton);
    return placeholder;
  }

  /**
   * Show the lines of a file whose diff is held back for its size ("Large
   * diff ... Load diff"). Concurrent requests for one file share one
   * promise.
   *
   * Callers: the placeholder's "Load diff" button (reanchor: true, since a
   * click is not inside a comment or suggestion reload) and
   * ensureLinesVisible (which reloads at a higher level).
   * @param {string} filePath - the pane's own path of the file
   * @param {Object} [options]
   * @param {boolean} [options.reanchor=false] - reload comments and
   *   suggestions afterwards. Whichever call starts the shared promise
   *   decides; acceptable, because a caller that passes false reloads anyway.
   * @returns {Promise<boolean>} true when the file shows its diff on return;
   *   false for a path that is not a file of the pane
   */
  async _materializeDeferredDiff(filePath, { reanchor = false } = {}) {
    if (!filePath) return false;
    const record = this.pierreBridge?.files?.get(filePath);
    if (!record) return false;
    if (!record.deferred) return true;
    if (!this._deferredDiffRenderPromises) {
      this._deferredDiffRenderPromises = new Map();
    }

    const existing = this._deferredDiffRenderPromises.get(filePath);
    if (existing) return existing;

    let promise;
    promise = this._materializeDeferredItem(filePath, { reanchor }).finally(() => {
      if (this._deferredDiffRenderPromises.get(filePath) === promise) {
        this._deferredDiffRenderPromises.delete(filePath);
      }
    });
    this._deferredDiffRenderPromises.set(filePath, promise);
    return promise;
  }

  /**
   * The header button that opens a file-level comment form in the file's
   * comment zone. The zone keeps a reference to it so FileCommentManager can
   * show whether the file has comments.
   * @param {string} filePath
   * @param {HTMLElement} zone - the file's comment zone
   * @returns {HTMLButtonElement}
   * @private
   */
  _createFileCommentButton(filePath, zone) {
    const fileCommentBtn = document.createElement('button');
    fileCommentBtn.className = 'file-header-comment-btn';
    fileCommentBtn.title = 'Add file comment';
    fileCommentBtn.dataset.file = filePath;
    // Outline icon (no comments) - will be updated by updateHeaderButtonState
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
      // Directly open the comment form (like GitHub's behavior)
      this.fileCommentManager.showCommentForm(zone, filePath);
    });
    // Store reference for updating icon state later
    zone.headerButton = fileCommentBtn;
    return fileCommentBtn;
  }

  /**
   * The header button that opens the chat panel about a file.
   * @param {string} filePath
   * @returns {HTMLButtonElement}
   * @private
   */
  _createFileChatButton(filePath) {
    const fileChatBtn = document.createElement('button');
    fileChatBtn.className = 'file-header-chat-btn';
    fileChatBtn.title = 'Chat about file';
    fileChatBtn.dataset.file = filePath;
    fileChatBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
      </svg>
    `;
    fileChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.chatPanel) {
        window.chatPanel.open({
          fileContext: { file: filePath }
        });
      }
    });
    return fileChatBtn;
  }

  /**
   * Build the header of a changed file: chevron, path, stats, Viewed, and,
   * with a comment zone, the file-comment, chat and summary-toggle buttons.
   * Its controls call functions that work from data, so the header works
   * whatever element it is attached to.
   *
   * Caller: _renderFileHeader (the viewer's header hook, which caches the
   * element per file).
   * @param {Object} file - a changed_files entry
   * @param {Object} options
   * @param {boolean} options.collapsed - whether the file starts collapsed
   * @param {HTMLElement|null} options.zone - the file's comment zone
   * @returns {HTMLElement}
   * @private
   */
  _buildFileHeader(file, { collapsed, zone }) {
    const isGenerated = file.generated || this.generatedFiles.has(file.file);
    // Create file header with new options API
    const header = window.DiffRenderer.createFileHeader(file.file, {
      isGenerated,
      isExpanded: !collapsed,
      isViewed: this.viewedFiles.has(file.file),
      generatedInfo: isGenerated ? this.generatedFiles.get(file.file) : null,
      // File stats for collapsed view
      fileStats: {
        insertions: file.insertions || 0,
        deletions: file.deletions || 0
      },
      renamed: file.renamed || false,
      renamedFrom: file.renamedFrom || null,
      onToggleCollapse: (path) => this.toggleFileCollapse(path),
      onToggleViewed: (path, checked) => this.toggleFileViewed(path, checked)
    });
    if (!this.fileCommentManager || !zone) return header;

    // File comment button - directly adds a file comment (like GitHub)
    header.appendChild(this._createFileCommentButton(file.file, zone));
    header.appendChild(this._createFileChatButton(file.file));

    // Per-file hunk-summary toggle. Mirrors the toolbar toggle but scoped to
    // one file. Disabled (greyed) when no summaries exist yet for this file;
    // _applyHunkSummaries / _registerPierreHunkAnchorsForFile re-enable it as soon
    // as hashes for this file are recorded (so a summary that arrives later
    // doesn't get hidden behind a permanently-disabled button).
    // Gated on `_summariesEnabled`: skipped entirely when /api/config has
    // already reported the feature is off; created hidden + revealed later
    // when config has not yet resolved.
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
        // Config still pending; hide until the gate resolves.
        summaryToggleBtn.classList.add('summary-toggle-pending');
        summaryToggleBtn.style.display = 'none';
      }
      this._syncFileSummaryToggleButton(summaryToggleBtn, file.file);

      summaryToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFileSummaries(file.file, this.findFileElement(file.file));
      });
      header.appendChild(summaryToggleBtn);
    }
    return header;
  }

  /**
   * Build the header of a context file: chevron, path, the CONTEXT badge,
   * Viewed, the file-comment and chat buttons, and dismiss. Its controls
   * call functions that work from data (the context rows, the state keys).
   *
   * Caller: _renderFileHeader (the viewer's header hook).
   * @param {string} filePath
   * @param {Object} [options]
   * @param {string|null} [options.label] - the row's label, the badge's title
   * @param {HTMLElement|null} [options.zone] - the file's comment zone
   * @returns {HTMLElement}
   * @private
   */
  _buildContextFileHeader(filePath, { label = null, zone = null } = {}) {
    const header = document.createElement('div');
    header.className = 'd2h-file-header context-file-header';

    // Chevron toggle for expand/collapse
    const chevronBtn = document.createElement('button');
    chevronBtn.className = 'file-collapse-toggle';
    chevronBtn.title = 'Collapse file';
    chevronBtn.innerHTML = window.DiffRenderer.CHEVRON_DOWN_ICON;
    chevronBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleContextFileCollapse(filePath);
    });
    header.appendChild(chevronBtn);

    const fileName = document.createElement('span');
    fileName.className = 'd2h-file-name';
    fileName.textContent = filePath;
    window.DiffRenderer.applyFilePathTruncation(fileName, filePath);
    header.appendChild(fileName);

    const contextLabel = document.createElement('span');
    contextLabel.className = 'context-badge';
    contextLabel.textContent = 'CONTEXT';
    if (label) contextLabel.title = label;
    header.appendChild(contextLabel);

    // Viewed checkbox (right-aligned group start)
    const viewedLabel = document.createElement('label');
    viewedLabel.className = 'file-viewed-label';
    viewedLabel.title = 'Mark file as viewed';
    const viewedCheckbox = document.createElement('input');
    viewedCheckbox.type = 'checkbox';
    viewedCheckbox.className = 'file-viewed-checkbox';
    viewedCheckbox.checked = this.viewedFiles.has(this._contextStateKey(filePath));
    viewedCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      this.toggleContextFileViewed(filePath, viewedCheckbox.checked);
    });
    viewedLabel.appendChild(viewedCheckbox);
    viewedLabel.appendChild(document.createTextNode('Viewed'));
    header.appendChild(viewedLabel);

    // File comment button
    if (this.fileCommentManager && zone) {
      header.appendChild(this._createFileCommentButton(filePath, zone));
    }

    // Chat/discussion button
    header.appendChild(this._createFileChatButton(filePath));

    // Dismiss button — removes ALL context ranges for this file
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'context-file-dismiss';
    dismissBtn.title = 'Remove context file';
    dismissBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`;
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._dismissContextFile(filePath);
    });
    header.appendChild(dismissBtn);

    // Click anywhere on header to toggle collapse (except interactive controls)
    header.addEventListener('click', (e) => {
      if (e.target.closest('.file-viewed-label') || e.target.closest('.file-collapse-toggle') ||
          e.target.closest('.file-header-comment-btn') || e.target.closest('.file-header-chat-btn') ||
          e.target.closest('.context-file-dismiss')) {
        return;
      }
      this.toggleContextFileCollapse(filePath);
    });

    return header;
  }

  /**
   * Find file element in the DOM - delegate to DiffRenderer
   */
  findFileElement(file) {
    return window.DiffRenderer.findFileElement(file);
  }

  /**
   * Whether a path is a file of the diff pane (a changed file, or a context
   * file), decided from data. `findFileElement` returning null does not
   * answer this: an element is what is on screen, and a file of the pane
   * need not have one. Tolerates the path variants findFileElement accepts.
   * @param {string} filePath
   * @returns {boolean}
   */
  isFileInDiffPane(filePath) {
    if (!filePath) return false;
    const paths = [
      ...(this.changedFilesByPath ? this.changedFilesByPath.keys() : []),
      ...(this.contextFiles || []).map(contextFile => contextFile.file)
    ];
    if (paths.includes(filePath)) return true;
    const DiffRenderer = window.DiffRenderer;
    const normalized = DiffRenderer?.normalizeFilePath?.(filePath);
    if (normalized && paths.includes(normalized)) return true;
    return typeof DiffRenderer?.pathsMatch === 'function'
      && paths.some(path => DiffRenderer.pathsMatch(path, filePath));
  }

  /**
   * Toggle collapse state of a file diff
   * @param {string} filePath - Path of the file
   */
  async toggleFileCollapse(filePath) {
    const collapsed = this.isFileCollapsed(filePath);
    if (collapsed === null) return;
    await this.setFileCollapsed(filePath, !collapsed);
  }

  /**
   * The path the diff pane knows a file by, for any form of that path a
   * caller holds. `collapsedFiles`, the bridge's file records and a
   * wrapper's data-file-name are all keyed by a changed file's
   * `file.file`; a finding, an external thread or a chat link may carry the
   * path as a model or a host wrote it ('./src/a.js', '/src/a.js', git
   * rename syntax). Tolerates the variants findFileElement accepts.
   *
   * Every function that keys state by path resolves its argument here
   * first, so the state, the wrapper and the viewer are always addressed by
   * the same path.
   * @param {string} filePath
   * @returns {string|null} null when the path names no file of the pane
   */
  _canonicalFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    const changed = this.changedFilesByPath;
    if (changed?.has(filePath)) return filePath;
    // A context file is known from data, on screen or not.
    if (this._contextItemIds.has(filePath)) return filePath;
    if ((this.contextFiles || []).some(row => row.file === filePath)) return filePath;
    // What is on screen: a changed file's wrapper, else a context file's.
    const rendered = this.findFileElement(filePath)?.dataset?.fileName;
    if (rendered) return rendered;
    if (!changed) return null;
    const DiffRenderer = window.DiffRenderer;
    const normalized = DiffRenderer?.normalizeFilePath?.(filePath);
    if (normalized && changed.has(normalized)) return normalized;
    if (typeof DiffRenderer?.pathsMatch === 'function') {
      for (const path of changed.keys()) {
        if (DiffRenderer.pathsMatch(path, filePath)) return path;
      }
    }
    return null;
  }

  /**
   * Whether a file of the diff pane is collapsed. The one place that answers
   * it, from data: `_fileCollapsed`, which is seeded when a file is rendered
   * (generated, viewed, or collapsed by the reader) and written by
   * setFileCollapsed. No caller reads the `collapsed` class of an element;
   * an element is what is on screen, and a file need not have one.
   * @param {string} filePath - Path of the file, in any form
   *   _canonicalFilePath accepts
   * @returns {boolean|null} null when the path is not a file of the pane
   */
  isFileCollapsed(filePath) {
    const path = this._canonicalFilePath(filePath);
    if (!path) return null;
    const collapsed = this._fileCollapsed.get(this._fileStateKey(path));
    return typeof collapsed === 'boolean' ? collapsed : null;
  }

  /**
   * Collapse or expand a file of the diff pane, a changed file or a context
   * file. The single writer of a file's collapsed state: `_fileCollapsed`,
   * `collapsedFiles` (under the file's state key), the element's class, the
   * header's chevron and the viewer's item are updated here and nowhere else.
   * It needs no element: a file that is not on screen is collapsed in data
   * and drawn collapsed when it is.
   *
   * Callers: toggleFileCollapse (header chevron and click, toggleGeneratedFile,
   * the tour's restore on exit), toggleFileViewed, revealInDiff (navigation
   * from the review panel, the suggestion navigator), TourRenderer when a
   * stop is in a collapsed file.
   *
   * The path is resolved to the file's canonical path once, and that one
   * path addresses all four. Navigation passes the path a finding or a
   * thread carries, which need not be the canonical form; written under the
   * caller's form, `collapsedFiles` and the viewer would keep the file
   * collapsed while its wrapper showed it expanded.
   *
   * @param {string} filePath - Path of the file, in any form
   *   _canonicalFilePath accepts
   * @param {boolean} collapsed - The state to set
   * @returns {Promise<boolean>} true when the file is in the requested state
   *   on return; false when the path is not a file of the pane
   */
  async setFileCollapsed(filePath, collapsed) {
    const path = this._canonicalFilePath(filePath);
    if (!path || this.isFileCollapsed(path) === null) return false;
    collapsed = !!collapsed;

    const key = this._fileStateKey(path);
    if (collapsed) this.collapsedFiles.add(key);
    else this.collapsedFiles.delete(key);
    this._fileCollapsed.set(key, collapsed);

    const header = this._fileHeaders.get(path);
    if (header) {
      window.DiffRenderer.updateFileHeaderState(header, !collapsed);
    }

    // The viewer draws the file collapsed or expanded from its record, and
    // stamps the `collapsed` class on the file's element.
    if (this.pierreBridge && this.pierreBridge.files.has(path)) {
      this.pierreBridge.setCollapsed(path, collapsed);
    }
    return true;
  }

  /**
   * Toggle viewed state of a file
   * @param {string} filePath - Path of the file
   * @param {boolean} isViewed - Whether the file is now viewed
   */
  async toggleFileViewed(filePath, isViewed) {
    if (isViewed) {
      this.viewedFiles.add(filePath);
      // Auto-collapse when marking as viewed
      if (this.isFileCollapsed(filePath) === false) {
        await this.setFileCollapsed(filePath, true);
      }
    } else {
      this.viewedFiles.delete(filePath);
      // Auto-expand when unchecking viewed (match GitHub behavior)
      if (this.isFileCollapsed(filePath) === true) {
        await this.setFileCollapsed(filePath, false);
      }
    }

    // Update sidebar file row to reflect viewed state
    this.updateFileItemViewedState(filePath, isViewed);

    // Persist viewed state
    this.saveViewedState();
  }

  /**
   * Bring a place in the diff into view: a card on a line of a file, a card
   * in a file's comment zone, or a line.
   *
   * The one navigation helper. Its callers are the review panel (a finding, a
   * comment, an external thread; the review history jumps through the
   * comment path), the suggestion navigator, the tour, and a file link in
   * the chat panel (a line target, `flashLines`). Each of them used to carry
   * its own copy of this sequence and its own DOM lookups; here the order is
   * fixed and the card is resolved through the bridge and the zone registry,
   * so a card that is not attached to the document is still found:
   *
   *   1. Expand the file if it is collapsed (setFileCollapsed); not for a
   *      line target.
   *   2. Reveal the line range if it is hidden (ensureLinesVisible).
   *   3. Take the pane to the target's line when the viewer does not draw
   *      the target: a file far from the viewport
   *      has no elements, and a very long file has rows for a window of its
   *      lines only. "Drawn" is asked of the bridge (isElementDrawn): the
   *      card of a line outside that window is in the document all the
   *      same, without a place on screen. (The bridge sends nothing for a
   *      card that the display of a pending diff is about to draw.)
   *   4. Resolve the card: the annotation with `annotationId` (waiting until
   *      the diff has attached it), else the card matching
   *      `zoneCardSelector` in the file's comment zone, else `findElement()`.
   *      For a line target: wait until the line is what the file draws.
   *   5. Scroll it into view with ScrollUtils.scrollIntoViewStable, after
   *      expanding it when comments are minimized. A line target is scrolled
   *      to by the bridge and flashed.
   *
   * After every await the caller's `isCancelled` is asked, so a newer
   * navigation wins. Nothing is held across an await: the card is resolved
   * after the last one.
   *
   * @param {Object} target
   * @param {string} target.file - File path
   * @param {number} [target.line_start] - With line_end: the range to reveal
   * @param {number} [target.line_end]
   * @param {string} [target.side='RIGHT']
   * @param {string} [target.annotationId] - Bridge annotation id of the card
   * @param {string} [target.zoneCardSelector] - Selector of a card inside
   *   the file's comment zone (any file's zone when the file is unknown)
   * @param {Function} [target.findElement] - () => Element|null; last resort
   *   for a card its owner resolves itself (an external thread that was put
   *   in a file's comment zone: ExternalCommentManager.findThreadCard)
   * @param {boolean} [target.flashLines] - The target is the line range
   *   itself, not a card: scroll to `line_start` unless it is on screen, and
   *   flash every line of the range
   * @param {Function} [target.prepare] - (element) => void; runs on the
   *   resolved card before it is scrolled to
   * @param {Function} [target.isCancelled] - () => boolean
   * @param {Object|false} [target.scroll] - scrollIntoView options; false to
   *   only resolve the card. Default { behavior: 'smooth', block: 'start' }
   * @param {boolean} [target.expandMinimized=true] - In minimize mode, expand
   *   the card's line and scroll to that line instead of the hidden card
   * @returns {Promise<{element: HTMLElement|null, cancelled: boolean,
   *   revealed?: boolean}>} For a line target `revealed` says whether the
   *   line was scrolled to and flashed
   */
  async revealInDiff({
    file, line_start, line_end, side, annotationId, zoneCardSelector, findElement, flashLines,
    prepare, isCancelled, scroll, expandMinimized = true
  } = {}) {
    const stop = { element: null, cancelled: true };
    // Step 3 moves the pane, so two navigations cannot both run to their
    // end: the one that started last wins, whoever asked for it. (One key
    // press can start two: the review panel and the suggestion navigator
    // both answer `j` and `k`, each with its own cursor.)
    const navigation = scroll !== false ? (this._revealGen = (this._revealGen || 0) + 1) : null;
    const superseded = () => navigation !== null && this._revealGen !== navigation;
    const cancelled = () => superseded() || (typeof isCancelled === 'function' && isCancelled() === true);

    // A change of the pane's files that nobody asked for (a context file the
    // server pushes) replaces the viewer's list, which would cut this
    // navigation's scroll off: it waits until the navigation has landed.
    const release = navigation !== null ? this.pierreBridge?.holdListWrites?.() : null;
    let landing = null;
    try {
      return await this._revealSteps(
        { file, line_start, line_end, side, annotationId, zoneCardSelector, findElement, flashLines, prepare, scroll, expandMinimized },
        { cancelled, stop, landed: (promise) => { landing = promise; } }
      );
    } finally {
      if (release) Promise.resolve(landing).then(release, release);
    }
  }

  /**
   * Steps 1 to 5 of revealInDiff (its only caller).
   * @param {Object} target - revealInDiff's target
   * @param {Object} run
   * @param {Function} run.cancelled - () => boolean
   * @param {Object} run.stop - what a cancelled navigation answers
   * @param {Function} run.landed - (promise) => void; handed the promise of
   *   the final scroll, which settles when the target has come to rest
   * @returns {Promise<Object>}
   * @private
   */
  async _revealSteps(
    { file, line_start, line_end, side, annotationId, zoneCardSelector, findElement, flashLines, prepare, scroll, expandMinimized },
    { cancelled, stop, landed }
  ) {
    const start = line_start != null && line_start !== '' ? parseInt(line_start, 10) : NaN;
    const parsedEnd = line_end != null && line_end !== '' ? parseInt(line_end, 10) : start;
    const end = Number.isFinite(parsedEnd) ? parsedEnd : start;
    const resolvedSide = side || 'RIGHT';

    if (file) {
      try {
        // A card's file is opened. A line target leaves a collapsed file
        // collapsed: its caller goes to the file's header instead, which is
        // what a chat link to a line of a collapsed file has always done.
        if (!flashLines && this.isFileCollapsed(file) === true) {
          await this.setFileCollapsed(file, false);
        }
      } catch (error) {
        console.warn('[revealInDiff] could not prepare the file', file, error);
      }
      if (cancelled()) return stop;

      if (Number.isFinite(start) && typeof this.ensureLinesVisible === 'function') {
        await this.ensureLinesVisible([{ file, line_start: start, line_end: end, side: resolvedSide }]);
        if (cancelled()) return stop;
      }
    }

    const bridge = this.pierreBridge;
    if (flashLines) {
      const revealed = await this._revealLines({ file, start, end, side: resolvedSide, cancelled });
      if (cancelled()) return stop;
      return { element: null, cancelled: false, revealed };
    }

    let element = null;
    const annotationFile = annotationId != null && bridge?.findAnnotationFile
      ? bridge.findAnnotationFile(annotationId, file)
      : null;
    if (annotationFile) {
      // Step 3: a card the viewer does not draw is brought into its
      // mounted window. Nothing moves when it is drawn already.
      if (!bridge.isElementDrawn(bridge.getAnnotationElement(annotationFile, annotationId))) {
        await this._afterInputHandlers();
        if (cancelled()) return stop;
        bridge.scrollToAnnotation(annotationFile, annotationId);
      }
      element = await bridge.whenAnnotationRendered(annotationFile, annotationId, { isCancelled: cancelled });
      if (cancelled()) return stop;
    }
    if (!element && zoneCardSelector) {
      const zone = file ? this.getFileCommentsZone(file) : null;
      element = zone?.querySelector(zoneCardSelector) || null;
      if (!element) {
        this.forEachFileCommentsZone((other) => {
          element = element || other.querySelector(zoneCardSelector);
        });
      }
    }
    if (!element && typeof findElement === 'function') {
      element = findElement() || null;
    }
    if (element && bridge && !bridge.isElementDrawn(element)) {
      // Step 3 for a card in a file's comment zone: the zone is drawn under
      // the file's header, so the pane is taken to the file.
      const zoneFile = element.closest?.('.file-comments-zone')?.dataset?.fileName;
      if (zoneFile && bridge.files.has(zoneFile)) {
        await this._afterInputHandlers();
        if (cancelled()) return stop;
        bridge.scrollToItem(zoneFile, { align: 'start', behavior: 'instant' });
        const drawn = await bridge.whenElementDrawn(element, { isCancelled: cancelled });
        if (cancelled()) return stop;
        if (!drawn) element = null;
      }
    }
    // A card that is still not attached after the wait has no
    // place on screen (its line is not in the diff): nothing to scroll to.
    // (A card of a file whose new diff awaits display is attached and not
    // drawn yet: the scroll below waits for its box.)
    if (!element || !element.isConnected) return { element: null, cancelled: false };
    if (typeof prepare === 'function') prepare(element);

    if (scroll !== false) {
      let scrollTarget = element;
      const minimizer = this.commentMinimizer;
      if (expandMinimized && minimizer?.active) {
        // Expand file-level comments so the target becomes visible; a line
        // card stays minimized and its diff line is scrolled to instead.
        minimizer.expandForElement(element);
        scrollTarget = minimizer.findDiffRowFor(element) || element;
      }
      // Land the target at the top of the diff panel (scroll-margin-top in
      // pr.css offsets it below the pinned file header). The stable variant
      // re-corrects when the layout shifts under the scroll. Fire-and-forget.
      const options = scroll && typeof scroll === 'object' ? scroll : { behavior: 'smooth', block: 'start' };
      if (window.ScrollUtils?.scrollIntoViewStable) {
        landed(window.ScrollUtils.scrollIntoViewStable(scrollTarget, options));
      } else {
        scrollTarget.scrollIntoView(options);
      }
    }
    return { element, cancelled: false };
  }

  /**
   * Let every handler of the input event that is being handled start before
   * going on. revealInDiff waits this out before it moves the pane to a
   * target that is not mounted: one key press can start two navigations
   * (the review panel and the suggestion navigator both answer `j` and `k`),
   * and the one that started first must not have moved the pane by the time
   * the second, which wins, looks for its card.
   * @returns {Promise<void>}
   * @private
   */
  _afterInputHandlers() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * Steps 3 to 5 of revealInDiff for a line target: bring the line into the
   * viewer's mounted window, wait until it is what
   * the file draws (a line that was just revealed is drawn a worker round
   * trip later, and a scroll sent before that lands on the separator), then
   * scroll to it unless it is on screen, and flash the range.
   * @param {Object} target
   * @param {string} target.file
   * @param {number} target.start - first line of the range
   * @param {number} target.end - last line of the range
   * @param {string} target.side
   * @param {Function} target.cancelled - () => boolean
   * @returns {Promise<boolean>} false when the file does not show the line
   * @private
   */
  async _revealLines({ file, start, end, side, cancelled }) {
    const bridge = this.pierreBridge;
    const path = this._canonicalFilePath(file);
    if (!bridge || !path || !bridge.files.has(path) || !Number.isFinite(start)) return false;
    if (!bridge.isLineVisible(path, start, side)) return false;
    if (!bridge.findFileElement(path)) {
      // Not mounted: go to the line now, so that the file is mounted and
      // the wait below has something to wait for.
      await this._afterInputHandlers();
      if (cancelled()) return false;
      bridge.scrollToLine(path, start, side, { align: 'center', behavior: 'instant', flash: false });
    }
    if (!bridge.isDiffDisplayed(path)) {
      await bridge.whenLineDisplayed(path, start, side, { isCancelled: cancelled });
      if (cancelled()) return false;
    }
    return bridge.scrollToLine(path, start, side, {
      align: 'center', behavior: 'smooth', ifNeeded: true, endLine: end,
    });
  }

  /**
   * Show a message in place of, or above, the diff: loading, an error, an
   * empty diff. The only writer of the diff pane's status element
   * (`#diff-status`, a sibling of `#diff-container`), and the only code that
   * hides or shows the diff's container. Nothing writes markup into
   * `#diff-container` itself: its children belong to the diff renderer.
   *
   * Idempotent. Each call returns a token; `_clearDiffStatus(token)` clears
   * the message only if no later call replaced it, so a handler that put up
   * a "loading" message can take down its own and never one that a newer
   * render or a newer request put there.
   *
   * @param {string|null} html - Inner markup of the message; null clears it
   *   and shows the diff
   * @param {Object} [options]
   * @param {boolean} [options.hideScroller=false] - Hide the diff while the
   *   message shows (loading, error). An empty diff keeps it, so context
   *   files stay visible under the message.
   * @returns {number} token for _clearDiffStatus
   */
  _setDiffStatus(html, { hideScroller = false } = {}) {
    this._diffStatusToken = (this._diffStatusToken || 0) + 1;
    const container = document.getElementById('diff-container');
    let status = document.getElementById('diff-status');
    const show = html != null && html !== '';
    if (!status && show && container?.parentNode) {
      // A page that predates the element: create it where it belongs.
      status = document.createElement('div');
      status.id = 'diff-status';
      status.className = 'diff-container diff-status';
      container.parentNode.insertBefore(status, container);
    }
    if (status) {
      status.innerHTML = show ? html : '';
      status.hidden = !show;
      status.classList.toggle('diff-status--with-diff', show && !hideScroller);
    }
    if (container) container.hidden = show && !!hideScroller;
    return this._diffStatusToken;
  }

  /**
   * Take down the message a `_setDiffStatus` call put up, unless a later
   * call has replaced it.
   * @param {number} token - What that `_setDiffStatus` call returned
   * @returns {boolean} true when the message was cleared
   */
  _clearDiffStatus(token) {
    if (token !== this._diffStatusToken) return false;
    this._setDiffStatus(null);
    return true;
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
   * Toggle collapse state of a context entry. A context file is an item like
   * any other; its state is kept under its own key (_fileStateKey), so a
   * changed file of the same path is not touched (#540), and no element is
   * needed.
   * @param {string} filePath - Path of the file
   */
  toggleContextFileCollapse(filePath) {
    const isCollapsed = this.isFileCollapsed(filePath);
    if (isCollapsed !== null) this.setFileCollapsed(filePath, !isCollapsed);
  }

  /**
   * Toggle viewed state of a context entry, independent of the diff entry
   * for the same file. Persists through the same viewedFiles storage as
   * diff entries, under the context-scoped key.
   * @param {string} filePath - Path of the file
   * @param {boolean} isViewed - Whether the context entry is now viewed
   */
  toggleContextFileViewed(filePath, isViewed) {
    const stateKey = this._contextStateKey(filePath);
    if (isViewed) this.viewedFiles.add(stateKey);
    else this.viewedFiles.delete(stateKey);
    // Marking as viewed collapses, unmarking expands (match GitHub).
    if (this.isFileCollapsed(filePath) === !isViewed) {
      this.setFileCollapsed(filePath, !!isViewed);
    }
    this._syncFileHeader(filePath);
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
        await this.loadUserComments();

        // Auto-expand in minimize mode, and notify the AI chat context.
        if (result.commentId != null && this.commentMinimizer) {
          // Resolved after the reload has settled, through the one card
          // resolver: the card may not be attached yet.
          const newRow = this.findCommentCard(result.commentId);
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

  /**
   * Ensure that the given line ranges are shown in the diff. A range with a
   * hidden endpoint is revealed through the file's context ranges, after the
   * file's contents have been loaded (the lines between hunks are not in the
   * patch). Works on a file that is not mounted: the reveal is data.
   * @param {Array<{file: string, line_start: number, line_end: number, side: string, contextPadding?: number}>} items
   */
  async ensureLinesVisible(items) {
    for (const item of items) {
      const { file, line_start, line_end, side } = item;
      if (!file || !line_start) continue;
      const resolvedSide = (side || 'right').toUpperCase();

      await this._materializeDeferredDiff(file);

      if (!this.pierreBridge || !this.pierreBridge.files.has(file)) continue;

      // Check the WHOLE range, not just line_start. Callers pass multi-line
      // ranges (comments, suggestions, chat citations); if line_start is on
      // screen but line_end is still inside a collapsed gap, we must still
      // expand. Preserve the skip-when-fully-visible optimization: only expand
      // when at least one endpoint is hidden.
      const endLine = line_end || line_start;
      const startVisible = this.pierreBridge.isLineVisible(file, line_start, resolvedSide);
      const endVisible = this.pierreBridge.isLineVisible(file, endLine, resolvedSide);
      if (startVisible && endVisible) continue;

      await this._ensurePierreContentUpgrade(file);
      let rangeStart = line_start;
      let rangeEnd = line_end || line_start;

      // addContextRanges expects NEW-file coordinates.
      // LEFT-side items use OLD-file numbers — convert first.
      if (resolvedSide === 'LEFT') {
        const converted = this.pierreBridge.convertOldToNew(file, rangeStart, rangeEnd);
        if (!converted) continue;
        rangeStart = converted.startLine;
        rangeEnd = converted.endLine;
      }

      // Pad after converting to NEW coordinates. Padding the requested
      // endpoints can cross edits on LEFT or put a target beyond EOF.
      const padding = item.contextPadding || 0;
      this.pierreBridge.addContextRanges(file, [{
        startLine: Math.max(1, rangeStart - padding),
        endLine: rangeEnd + padding,
      }]);
    }
  }

  /**
   * Open a comment form under a line (or a range of lines) of a file of the
   * pane: a `comment-form` annotation of the viewer.
   * @param {string} fileName
   * @param {number} lineNumber - first line of the range
   * @param {number|null} diffPosition - GitHub diff position of that line
   * @param {number|null} [endLineNumber] - last line of a range
   * @param {string} [side='RIGHT']
   */
  showCommentForm(fileName, lineNumber, diffPosition, endLineNumber, side = 'RIGHT') {
    if (!this.pierreBridge || !this.pierreBridge.files.has(fileName)) return;
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
        // A context file's line has no position in the diff (the form warns).
        outsideDiff: this.fileKind(fileName) === 'context',
      },
    });
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

  /**
   * Edit user comment
   */
  async editUserComment(commentId) {
    try {
      const commentRow = this.findCommentCard(commentId);
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
      const textarea = this._findCommentEditTextarea(commentId, commentRow);
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
    const editForm = this._findCommentEditTextarea(commentId)?.closest('.user-comment-edit-form');
    const saveBtn = editForm?.querySelector('.save-edit-btn');
    if (saveBtn?.dataset.saving === 'true') {
      return;
    }
    if (saveBtn) saveBtn.dataset.saving = 'true';
    if (saveBtn) saveBtn.disabled = true;

    try {
      const textarea = this._findCommentEditTextarea(commentId);
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

      // Resolved again after the await: the card can have been rebuilt.
      const commentRow = this.findCommentCard(commentId);
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

      this.patchUserComment(commentId, { body: editedText });

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
    const commentRow = this.findCommentCard(commentId);
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

      // Always remove the comment from the diff view (design decision: dismissed comments never shown in diff)
      const commentRow = this.findCommentCard(commentId);
      if (commentRow) {
        commentRow.remove();
      }

      // Also handle file-level comment cards
      const fileCommentCard = this.findCommentCard(commentId, { fileLevel: true });
      if (fileCommentCard) {
        const zone = fileCommentCard.closest('.file-comments-zone');
        fileCommentCard.remove();
        if (zone && this.fileCommentManager) {
          this.fileCommentManager.updateCommentCount(zone);
        }
      }

      // Updates the counts, the minimizer, and the AI panel (dismissed styling
      // when it shows dismissed comments, otherwise removed). Also removes the
      // comment from the list its file is re-rendered from, so a later
      // re-render of the file cannot draw the dismissed comment again.
      this.patchUserComment(commentId, { status: 'inactive' });

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
        const suggestionDiv = this.findSuggestionCard(apiResult.dismissedSuggestionId);
        if (suggestionDiv) {
          delete suggestionDiv.dataset.hiddenForAdoption;
        }
        this._setSuggestionStatus(apiResult.dismissedSuggestionId, 'dismissed');
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
      await this.loadUserComments();

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
    const totalComments = this.getPendingCommentCount();
    const hasPosted = (this.userComments || []).some(window.PostedComment.isPostedComment);

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
      message: `This will dismiss all ${totalComments} pending comment${totalComments !== 1 ? 's' : ''}. You can restore them later.${hasPosted ? ' Posted comments are kept.' : ''}`,
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
      const deletedCount = result.deletedCount ?? totalComments;

      // Reload comments to update both internal state and AI Panel
      // This shows dismissed comments in AI Panel if filter is enabled, matching individual deletion behavior
      await this.loadUserComments();

      // Update dismissed suggestions in the diff view UI
      // (AI Panel is already updated by loadUserComments via setComments)
      if (result.dismissedSuggestionIds && result.dismissedSuggestionIds.length > 0) {
        for (const suggestionId of result.dismissedSuggestionIds) {
          this.updateDismissedSuggestionUI(suggestionId);
          this._setSuggestionStatus(suggestionId, 'dismissed');
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
   * Load user comments from API and render them.
   *
   * Every user comment is fetched, dismissed ones included, so the cache
   * matches what live edits leave in it and the hidden-comments notice can
   * count from data. What shows follows the comment panel's filters
   * (getCommentFilterState), read at render time, so reloads triggered by
   * events (live sync, tab becoming visible) keep what the panel shows.
   * Dismissed comments are NEVER shown in the diff panel (design decision);
   * they show in the AI Panel when its "Show dismissed" filter is on.
   * @returns {Promise<boolean|undefined>} true once rendered, false if the
   *   reload failed, undefined when no PR is loaded. A load overtaken by a
   *   newer one resolves with the newer load's result.
   */
  loadUserComments() {
    const load = this._loadUserComments();
    this._latestUserCommentsLoad = load;
    return load;
  }

  async _loadUserComments() {
    if (!this.currentPR) return;

    const generation = (this._userCommentsLoadGeneration || 0) + 1;
    this._userCommentsLoadGeneration = generation;

    try {
      let comments;
      let fileLevelComments;
      let lineLevelComments;
      // A save, edit or dismissal that lands while this load is in flight
      // isn't in the fetched data. Rendering that data would wipe the new row,
      // so fetch again (a few times at most) until the cache stood still.
      for (let attempt = 1; ; attempt++) {
        const cacheVersion = this._userCommentsVersion || 0;
        ({ comments, fileLevelComments, lineLevelComments } = await this._fetchUserCommentsForRender());
        if (generation !== this._userCommentsLoadGeneration) return this._latestUserCommentsLoad;
        if (cacheVersion === (this._userCommentsVersion || 0) || attempt >= 3) break;
      }

      // Assign the cache only now, next to the render: an overtaken or retried
      // load must not replace data that a save made meanwhile.
      this.userComments = comments;

      // Clear existing comment rows before re-rendering
      document.querySelectorAll('.user-comment-row').forEach(row => row.remove());

      // Display comments as annotations of the viewer. A comment on a file
      // that is not in the pane has no line to sit under. Group by file so
      // each file is drawn ONCE for its whole set of comments, not once per
      // comment.
      const commentAnnotationsByFile = new Map();
      lineLevelComments.forEach(comment => {
        if (!this.pierreBridge || !this.pierreBridge.files.has(comment.file)) return;
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
      // The old cards go and the new ones come as one change of the diff:
      // no file is drawn in between without its comments. Synchronous from
      // the cache assignment above to the end of this block; nothing here
      // may wait.
      if (this.pierreBridge) {
        this.pierreBridge.batch(() => {
          for (const [file] of this.pierreBridge.files) {
            this.pierreBridge.removeAnnotationsByType(file, 'comment');
          }
          for (const [file, annotations] of commentAnnotationsByFile) {
            this.pierreBridge.addAnnotations(file, annotations);
          }
        });
      }

      // Always pass the list, even when empty, so the cards of a
      // deleted or dismissed last comment are removed. null suggestions
      // leaves the file-level AI cards alone.
      if (this.fileCommentManager) {
        this.fileCommentManager.loadFileComments(fileLevelComments, null);
      }

      // Also refreshes the file-comment zones and minimize-mode indicators
      this.applyPostedCommentVisibility();

      this.updateCommentCount();
      return true;
    } catch (error) {
      console.error('Error loading user comments:', error);
      return false;
    }
  }

  /**
   * Fetch the review's user comments, split them for rendering, and make
   * every line-level comment's target line a line the diff shows.
   * @private
   */
  async _fetchUserCommentsForRender() {
    const response = await fetch(`/api/reviews/${this.currentPR.id}/comments?includeDismissed=true`);
    if (!response.ok) throw new Error('Failed to load comments');

    const data = await response.json();
    const comments = data.comments || [];

    // Separate file-level and line-level comments for diff view rendering
    // DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
    // They only appear in the AI/Review Panel when the "show dismissed" filter is ON.
    // Posted comments remain visible unless the reviewer opts to hide them.
    const fileLevelComments = [];
    const lineLevelComments = [];
    comments.forEach(comment => {
      if (comment.status === 'inactive') {
        return;
      }
      if (comment.is_file_level === 1) {
        fileLevelComments.push(comment);
      } else {
        lineLevelComments.push(comment);
      }
    });

    // Ensure every comment's target line is shown before rendering:
    // `ensureLinesVisible` reveals a line hidden between hunks, so the
    // annotation has a row. Without this, comments on lines outside the
    // default hunks render nowhere on reload and "jump to comment" silently
    // fails.
    if (lineLevelComments.length > 0) {
      await this.ensureLinesVisible(lineLevelComments.map(c => ({
        file: c.file,
        line_start: c.line_start,
        line_end: c.line_end || c.line_start,
        side: c.side || 'RIGHT',
      })));
    }

    return { comments, fileLevelComments, lineLevelComments };
  }

  /**
   * The comment panel's user-comment filters. Falls back to the panel's
   * show-dismissed flag and this review's posted setting when the panel
   * predates getCommentFilterState (or is a test stub).
   * @returns {{includeDismissed: boolean, showPosted: boolean}}
   */
  getCommentFilterState() {
    const state = window.aiPanel?.getCommentFilterState?.();
    if (state) return state;
    return {
      includeDismissed: !!window.aiPanel?.showDismissedComments,
      showPosted: !(window.PostedComment?.isHidePostedInEffect() ?? false)
    };
  }

  /**
   * How many cached user comments the panel's filters hide, counted from the
   * comment data (never DOM rows), for the panel's hidden-comments notice.
   * @param {{includeDismissed: boolean, showPosted: boolean}} [filter]
   * @returns {{posted: number, dismissed: number}}
   */
  getHiddenCommentCounts(filter = this.getCommentFilterState()) {
    const comments = this.userComments || [];
    return {
      posted: window.PostedComment.countHiddenPostedComments(comments, !filter.showPosted),
      dismissed: filter.includeDismissed ? 0 : comments.filter(c => c.status === 'inactive').length
    };
  }

  applyPostedCommentVisibility() {
    const { shouldHidePostedComment } = window.PostedComment;
    const filter = this.getCommentFilterState();
    const hidePosted = !filter.showPosted;
    const applyTo = (root) => root.querySelectorAll('[data-comment-status]').forEach(element => {
      element.classList.toggle('posted-comment-hidden',
        shouldHidePostedComment({ status: element.dataset.commentStatus, publication: element.dataset.commentPublication === 'none' ? null : { state: element.dataset.commentPublication } }, hidePosted));
    });
    applyTo(document);
    // Zones that are not attached to the document hold cards too. Line
    // comments need no sweep: their cards are stamped from data every time
    // the diff draws them (PostedComment.syncCommentElement).
    this.forEachFileCommentsZone((zone) => { if (!zone.isConnected) applyTo(zone); });
    window.aiPanel?.setHiddenCommentCounts?.(this.getHiddenCommentCounts(filter));
    window.aiPanel?.setComments?.((this.userComments || []).filter(c =>
      (c.status !== 'inactive' || filter.includeDismissed) &&
      !shouldHidePostedComment(c, hidePosted)
    ));

    // Hidden posted comments must not drive the file-comment header state or
    // the minimize-mode indicators. The minimizer's observer watches childList
    // only, so a class toggle needs an explicit refresh.
    if (this.fileCommentManager) {
      this.forEachFileCommentsZone((zone) => {
        if (zone.querySelector('.file-comments-container')) {
          this.fileCommentManager.updateCommentCount(zone);
        }
      });
    }
    this.commentMinimizer?.refreshIndicators();
  }

  /**
   * The file-comment zone of a file: the element that holds its file-level
   * comment cards, AI cards and forms. The only way to get one. It answers
   * from FileCommentManager's registry, so it finds a zone whether or not
   * the zone is attached to the document.
   * @param {string} filePath
   * @returns {HTMLElement|null}
   */
  getFileCommentsZone(filePath) {
    return this.fileCommentManager?.getZone?.(filePath) || null;
  }

  /**
   * How many AI suggestions the diff pane shows, whether or not their files
   * are on screen: a card under a line is an annotation of its file, a
   * file-level card is in its file's comment zone. Collapsed cards (adopted,
   * dismissed) count, as their cards do in the document.
   * @returns {number}
   */
  countDisplayedSuggestions() {
    let count = 0;
    const bridge = this.pierreBridge;
    if (bridge) {
      for (const fileName of bridge.files.keys()) count += bridge.getAnnotations(fileName, 'suggestion').length;
    }
    this.forEachFileCommentsZone((zone) => {
      count += zone.querySelectorAll('.ai-suggestion[data-suggestion-id]').length;
    });
    return count;
  }

  /**
   * Visit every file-comment zone of the diff pane, attached or not. The
   * only sweep over zones.
   * @param {Function} fn - (zone, filePath) => void
   */
  forEachFileCommentsZone(fn) {
    this.fileCommentManager?.forEachZone?.(fn);
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
   * Collapse a suggestion's card after adoption: the collapsed class, the
   * 'Adopted' tooltip, the restore button, and the hiddenForAdoption flag.
   * The card is resolved by id (findSuggestionCard), attached or not.
   * @param {number|string} suggestionId - Suggestion ID
   */
  collapseSuggestionForAdoption(suggestionId) {
    const targetDiv = this.findSuggestionCard(suggestionId);
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
   * Draw a newly adopted user comment: an annotation of the viewer on the
   * comment's line, next to the collapsed suggestion. A comment on a file
   * that is not in the pane has no line to sit under.
   * @param {Object} comment - The newly-adopted comment
   * @private
   */
  async _renderAdoptedUserComment(comment) {
    if (!this.pierreBridge || !comment.file || !this.pierreBridge.files.has(comment.file)) return;
    // Reveal the target line if it sits inside a collapsed gap — otherwise
    // the annotation has no row to attach to and never renders.
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
   * and builds the newComment object. Returns { isFileLevel, newComment }.
   * Throws on errors so the caller can handle them.
   */
  async _adoptAndBuildComment(suggestionId, suggestionDiv) {
    const { suggestionText, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
    const { lineNumber, lineEnd, fileName, diffPosition, side, isFileLevel } = this.getFileAndLineInfo(suggestionDiv);

    // File-level suggestions are handled by FileCommentManager; signal the caller
    if (isFileLevel) {
      return { isFileLevel: true, suggestionText, suggestionType, suggestionTitle, fileName };
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
    this.collapseSuggestionForAdoption(suggestionId);

    const newComment = this._buildCommentObject({
      userCommentId: adoptResult.userCommentId,
      formattedBody: adoptResult.formattedBody,
      fileName, lineNumber, lineEnd, suggestionType, suggestionTitle,
      suggestionId, diffPosition, side
    });

    return { isFileLevel: false, newComment };
  }

  /**
   * Notify panels and navigator after a successful adoption
   */
  _notifyAdoption(suggestionId, newComment) {
    this.registerUserComment(newComment);
    // After the comment is registered: an adopted suggestion's status is
    // also derived from the comment that adopted it.
    this._setSuggestionStatus(suggestionId, 'adopted');

    if (this.suggestionNavigator?.suggestions) {
      const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
        s.id === suggestionId ? { ...s, status: 'adopted' } : s
      );
      this.suggestionNavigator.updateSuggestions(updatedSuggestions);
    }

    if (window.aiPanel) {
      window.aiPanel.updateFindingStatus(suggestionId, 'adopted');
    }
  }

  /**
   * Open an AI suggestion in edit mode without adopting it yet.
   * The suggestion is only adopted when the user clicks Save/Adopt.
   */
  async editAndAdoptSuggestion(suggestionId) {
    try {
      const suggestionDiv = this.findSuggestionCard(suggestionId);
      if (!suggestionDiv) throw new Error('Suggestion element not found');

      const { suggestionText, formattedBody, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
      const { lineNumber, lineEnd, fileName, diffPosition, side, isFileLevel } = this.getFileAndLineInfo(suggestionDiv);

      if (isFileLevel) {
        if (!this.fileCommentManager) throw new Error('FileCommentManager not initialized');
        const zone = this.getFileCommentsZone(fileName);
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

      // Line-level: show the edit form WITHOUT adopting yet.
      // The edit form is a comment-form annotation on the suggestion's
      // line, pre-filled with the suggestion body, with a custom submit that
      // runs the adopt-edited flow. A suggestion on a file that is not in
      // the pane has no line to open it under.
      if (!this.pierreBridge || !this.pierreBridge.files.has(fileName)) return;
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
        this.collapseSuggestionForAdoption(suggestionId);
        const newComment = this._buildCommentObject({
          userCommentId: editResult.userCommentId,
          formattedBody: editResult.formattedBody,
          fileName, lineNumber, lineEnd, suggestionType, suggestionTitle,
          suggestionId, diffPosition, side
        });

        // Remove the edit form annotation and add the comment annotation.
        this.pierreBridge.removeAnnotation(fileName, annotationId);
        await this._renderAdoptedUserComment(newComment);
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
      const suggestionDiv = this.findSuggestionCard(suggestionId);
      if (!suggestionDiv) throw new Error('Suggestion element not found');

      const result = await this._adoptAndBuildComment(suggestionId, suggestionDiv);

      if (result.isFileLevel) {
        if (!this.fileCommentManager) throw new Error('FileCommentManager not initialized');
        const zone = this.getFileCommentsZone(result.fileName);
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

      await this._renderAdoptedUserComment(result.newComment);
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
      const suggestionDiv = this.findSuggestionCard(suggestionId);

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
      this._setSuggestionStatus(suggestionId, 'dismissed');

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
      const suggestionDiv = this.findSuggestionCard(suggestionId);

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
      this._setSuggestionStatus(suggestionId, 'active');

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
    const suggestionRow = this.findSuggestionCard(parentId);
    if (!suggestionRow) return;

    if (suggestionRow.style.display === 'none') {
      suggestionRow.style.display = '';
      const commentRow = this.findCommentCard(commentId);
      const eyeButton = commentRow?.querySelector('.btn-toggle-original');
      if (eyeButton) {
        eyeButton.classList.add('showing-original');
        eyeButton.title = 'Hide original AI suggestion';
      }
    } else {
      suggestionRow.style.display = 'none';
      const commentRow = this.findCommentCard(commentId);
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
          onHistory: window.PAIR_REVIEW_LOCAL_MODE ? null : () => this.openReviewHistory(),
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
   * Open the review history: what this review posted to the host. PR mode only.
   */
  openReviewHistory() {
    if (window.PAIR_REVIEW_LOCAL_MODE || !this.currentPR?.id || !window.ReviewHistoryModal) return;
    if (!this.reviewHistoryModal) {
      this.reviewHistoryModal = new window.ReviewHistoryModal();
    }
    this.reviewHistoryModal.show(this.currentPR.id);
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
   * Record a user comment just created (saved, adopted, or adopted with edit).
   * Call it once the comment's row or card is in the DOM: it updates the
   * comment cache, the AI panel, the comment counts and the minimize-mode
   * indicators.
   * @param {Object} comment - The new comment; status defaults to 'active'
   * @returns {Object} The comment as cached
   */
  registerUserComment(comment) {
    const stored = { status: 'active', ...comment };
    this.userComments = [...(this.userComments || []).filter(c => c.id !== stored.id), stored];
    // Lets an in-flight loadUserComments see that its data is stale
    this._userCommentsVersion = (this._userCommentsVersion || 0) + 1;
    window.aiPanel?.addComment?.(stored);
    this.updateCommentCount();
    this.commentMinimizer?.refreshIndicators();
    return stored;
  }

  /**
   * Apply a change to a cached user comment (an edit, or a dismissal) after
   * the DOM reflects it. Updates the AI panel, the comment counts and the
   * minimize-mode indicators. A dismissed comment stays in the AI panel only
   * when it is showing dismissed comments.
   * @param {number} commentId
   * @param {Object} updates - e.g. { body } or { status: 'inactive' }
   */
  patchUserComment(commentId, updates) {
    const before = (this.userComments || []).find(c => c.id === commentId);
    this.userComments = (this.userComments || []).map(c => c.id === commentId ? { ...c, ...updates } : c);
    this._patchCommentAnnotation(before, commentId, updates);
    // Editing a posted comment changes whether it differs from what was
    // posted; only the server knows the posted text, so ask it.
    if (updates.body !== undefined && before && window.PostedComment?.isPostedComment(before)) {
      window.PostedComment.setUpdateError(commentId, null);
      this.refreshCommentPublication(commentId);
    }
    this._userCommentsVersion = (this._userCommentsVersion || 0) + 1;
    if (window.aiPanel?.setHiddenCommentCounts) {
      window.aiPanel.setHiddenCommentCounts(this.getHiddenCommentCounts());
    }
    if (updates.status === 'inactive' && !this.getCommentFilterState().includeDismissed) {
      window.aiPanel?.removeComment?.(commentId);
    } else {
      window.aiPanel?.updateComment?.(commentId, updates);
    }
    this.updateCommentCount();
    this.commentMinimizer?.refreshIndicators();
  }

  /**
   * Keep the diff's own record of a line comment in step with the cache.
   *
   * The diff re-renders a file from its annotation list, and each comment
   * annotation carries the comment it was built from. An edit is written to
   * that object, so a card built later says what the cache says. A dismissal
   * removes the annotation: a dismissed comment is never shown in the diff,
   * and leaving it in the list would draw it again on the file's next
   * re-render.
   * @param {Object|undefined} before - The cached comment before the change
   * @param {number} commentId
   * @param {Object} updates
   * @private
   */
  _patchCommentAnnotation(before, commentId, updates) {
    const bridge = this.pierreBridge;
    if (!bridge?.findAnnotationByData) return;
    const hit = (before?.file && bridge.hasAnnotation?.(before.file, `comment-${commentId}`))
      ? { fileName: before.file, annotation: bridge.getAnnotations(before.file, 'comment').find(a => a.metadata.id === `comment-${commentId}`) }
      : bridge.findAnnotationByData('comment', data => data?.id === commentId);
    if (!hit?.annotation) return;
    if (updates.status === 'inactive') {
      bridge.removeAnnotation(hit.fileName, hit.annotation.metadata.id);
      return;
    }
    if (hit.annotation.metadata.data) Object.assign(hit.annotation.metadata.data, updates);
  }

  /**
   * The card of a user comment: the line comment's card in the diff, else
   * the file-level card in its file's comment zone.
   *
   * This is the one way to get a comment's card. The diff's card comes from
   * the bridge, which hands back the element it built for the comment whether
   * or not it is attached to the document right now, and builds it when it
   * has not been built yet; the file-level card comes from the zone registry,
   * which also holds zones that are not attached.
   * @param {number|string} commentId
   * @param {Object} [options]
   * @param {boolean} [options.fileLevel] - true: only the file-level card;
   *   false: only a line comment's card; omitted: whichever exists
   * @returns {HTMLElement|null}
   */
  findCommentCard(commentId, { fileLevel } = {}) {
    if (commentId == null || commentId === '') return null;
    const id = String(commentId);
    const escaped = id.replace(/["\\]/g, '\\$&');
    if (fileLevel !== true) {
      const bridge = this.pierreBridge;
      const cached = (this.userComments || []).find(c => String(c.id) === id);
      const annotationId = `comment-${id}`;
      const fileName = (cached?.file && bridge?.hasAnnotation?.(cached.file, annotationId))
        ? cached.file
        : bridge?.findAnnotationByData?.('comment', data => String(data?.id) === id)?.fileName;
      const card = fileName ? bridge.getAnnotationElement(fileName, annotationId, { create: true }) : null;
      if (card || fileLevel === false) return card;
    }
    let card = null;
    this.forEachFileCommentsZone((zone) => {
      card = card || zone.querySelector(`.file-comment-card[data-comment-id="${escaped}"]`);
    });
    return card;
  }

  /**
   * The textarea of a comment's open edit form, looked up inside the
   * comment's card (the card may not be attached to the document).
   * @private
   */
  _findCommentEditTextarea(commentId, card = this.findCommentCard(commentId)) {
    const selector = `#edit-comment-${String(commentId).replace(/[^\w-]/g, '\\$&')}`;
    return card?.querySelector(selector) || null;
  }

  /**
   * The card of an AI suggestion: the line suggestion's card in the diff,
   * else the file-level card in its file's comment zone. The one way to get
   * a suggestion's card; see findCommentCard for why the document is not
   * asked.
   * @param {number|string} suggestionId
   * @returns {HTMLElement|null}
   */
  findSuggestionCard(suggestionId) {
    if (suggestionId == null || suggestionId === '') return null;
    const id = String(suggestionId);
    const escaped = id.replace(/["\\]/g, '\\$&');
    const bridge = this.pierreBridge;
    const hit = bridge?.findAnnotationByData?.('suggestion', data => String(data?.id) === id);
    if (hit) {
      const element = bridge.getAnnotationElement(hit.fileName, hit.annotation.metadata.id, { create: true });
      const card = element?.matches?.('.ai-suggestion') ? element : element?.querySelector?.('.ai-suggestion');
      if (card) return card;
    }
    let card = null;
    this.forEachFileCommentsZone((zone) => {
      card = card || zone.querySelector(`.ai-suggestion[data-suggestion-id="${escaped}"]`);
    });
    return card;
  }

  /**
   * Write a suggestion's new status to the suggestion object its card is
   * built from, so a card built or drawn later shows it. Call it after the
   * flow has updated the card that exists: the card is then recorded as up
   * to date and the next draw leaves it alone.
   * @param {number|string} suggestionId
   * @param {'active'|'adopted'|'dismissed'} status
   * @private
   */
  _setSuggestionStatus(suggestionId, status) {
    if (suggestionId == null) return;
    const id = String(suggestionId);
    const hit = this.pierreBridge?.findAnnotationByData?.('suggestion', data => String(data?.id) === id);
    const suggestion = hit?.annotation?.metadata?.data;
    if (!suggestion) return;
    suggestion.status = status;
    const element = this.pierreBridge.getAnnotationElement(hit.fileName, hit.annotation.metadata.id);
    const card = element?.matches?.('.ai-suggestion') ? element : element?.querySelector?.('.ai-suggestion');
    this.suggestionManager?.markSuggestionSynced?.(card, suggestion);
  }

  /**
   * Replace a cached comment with the server's copy (fresh publication) and
   * re-render its edited-since-posted note in place, in every renderer.
   * @param {Object} comment - Comment from the server
   */
  applyServerComment(comment) {
    if (!comment) return;
    this.userComments = (this.userComments || []).map(c => c.id === comment.id ? { ...c, ...comment } : c);
    this._userCommentsVersion = (this._userCommentsVersion || 0) + 1;
    const cached = this.userComments.find(c => c.id === comment.id) || comment;
    // @pierre/diffs re-renders annotations from their stored data
    for (const annotation of this.pierreBridge?.getAnnotations?.(cached.file, 'comment') || []) {
      if (annotation.metadata?.data?.id === cached.id) Object.assign(annotation.metadata.data, cached);
    }
    window.PostedComment?.findRenderedComments(comment.id)
      .forEach(element => window.PostedComment.syncEditedSincePosted(element, cached));
    window.aiPanel?.updateComment?.(comment.id, { body: cached.body, publication: cached.publication });
    if (this.reviewModal?.isVisible) this.reviewModal.updateCommentCount();
  }

  /** Fetch one comment's publication after an edit. Best effort. */
  async refreshCommentPublication(commentId) {
    const reviewId = this.currentPR?.id;
    if (!reviewId || window.PAIR_REVIEW_LOCAL_MODE) return;
    try {
      const response = await fetch(`/api/reviews/${reviewId}/comments/${commentId}`);
      if (!response.ok) return;
      this.applyServerComment(await response.json());
    } catch (error) {
      console.warn('Could not refresh comment publication:', error);
    }
  }

  /**
   * Update an edited, already-posted comment on the host in place. Never
   * creates a comment. On failure the comment stays "Edited since posted" and
   * the server's message is shown beside it.
   * @param {number|string} commentId
   * @returns {Promise<{ok: boolean, comment?: Object, error?: Object}>}
   */
  async updatePostedCommentOnHost(commentId) {
    const PostedComment = window.PostedComment;
    const reviewId = this.currentPR?.id;
    if (!PostedComment || !reviewId) return { ok: false, error: { message: 'No review loaded' } };
    const id = Number(commentId);
    this._hostUpdatesInFlight = this._hostUpdatesInFlight || new Map();
    if (this._hostUpdatesInFlight.has(id)) return this._hostUpdatesInFlight.get(id);

    const run = (async () => {
      PostedComment.setUpdateBusy(id, true);
      const result = await PostedComment.requestHostUpdate(reviewId, id);
      // The update is over. "Busy" is data (a card drawn while the update
      // runs shows it too), so it is cleared here and not left to the note's
      // re-render below.
      PostedComment.setUpdateBusy(id, false);
      PostedComment.setUpdateError(id, result.ok ? null : result.error);
      const comment = result.ok ? result.comment
        : (this.userComments || []).find(c => c.id === id);
      if (comment) {
        if (result.ok) this.applyServerComment(comment);
        else PostedComment.findRenderedComments(id).forEach(el => PostedComment.syncEditedSincePosted(el, comment));
      }
      return result;
    })();
    this._hostUpdatesInFlight.set(id, run);
    try {
      return await run;
    } finally {
      this._hostUpdatesInFlight.delete(id);
    }
  }

  /** Comments the next submit will post: what "will be submitted" counts. */
  getPendingCommentCount() {
    return (this.userComments || []).filter(window.PostedComment.isPendingComment).length;
  }

  /**
   * Comments a non-draft submit will publish: the pending ones plus those
   * already saved to the pending draft review, which GitHub publishes with it.
   * Used only to decide whether a review has any comments at all.
   */
  getSubmittableCommentCount() {
    return (this.userComments || []).filter(c => window.PostedComment.isPendingComment(c) ||
      (c.status === 'active' && window.PostedComment.publicationState(c) === 'draft')).length;
  }

  /**
   * Update comment count display independently of diff visibility.
   */
  updateCommentCount() {
    const userComments = this.getPendingCommentCount();
    if (this.reviewModal?.isVisible) this.reviewModal.updateCommentCount();

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

  /**
   * Build the file navigator's directory tree. Directories that only contain
   * a single subdirectory are collapsed into one node (e.g. `src/js/utils`),
   * so long shared prefixes take one row instead of one row per segment.
   * @param {Array} files - Diff/context file entries
   * @returns {Object} Root node from FileOrderUtils.buildDirectoryTree whose
   *   `files` are navigator items and `dirs` are nested nodes
   */
  buildFileNavigatorTree(files) {
    const items = files.map(file => {
      const filePath = file.file;
      const lastSlashIndex = filePath.lastIndexOf('/');
      const fileName = lastSlashIndex === -1 ? filePath : filePath.substring(lastSlashIndex + 1);
      return {
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
      };
    });
    return window.FileOrderUtils.buildDirectoryTree(items, item => item.fullPath);
  }

  updateFileList(files) {
    const fileListContainer = document.getElementById('file-list');
    if (!fileListContainer) return;

    // Store diff-only files for merging with context files later
    this.diffFiles = files.filter(f => !f.contextFile);

    // Update sidebar file count badge
    const fileCountEl = document.getElementById('sidebar-file-count');
    if (fileCountEl) {
      fileCountEl.textContent = files.length;
    }

    if (files.length === 0) {
      fileListContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--color-text-secondary);">No files changed</div>';
      return;
    }

    const tree = this.buildFileNavigatorTree(files);
    fileListContainer.innerHTML = '';

    // Root-level files sit directly in the list, followed by top-level folders
    tree.files.forEach(file => fileListContainer.appendChild(this.renderFileItem(file)));
    tree.dirs.forEach(dir => fileListContainer.appendChild(this.renderFileGroup(dir)));
  }

  /**
   * Render a directory node and, recursively, its subdirectories.
   * @param {{name: string, path: string, files: Array, dirs: Array}} node
   * @returns {HTMLElement}
   */
  renderFileGroup(node) {
    const group = document.createElement('div');
    group.className = 'file-group';
    group.dataset.path = node.path;

    const header = document.createElement('div');
    header.className = 'file-group-header';
    header.title = node.path;

    const chevron = document.createElement('span');
    chevron.className = 'file-group-chevron';
    chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M4.7 10c-.2 0-.4-.1-.5-.2-.3-.3-.3-.8 0-1.1L6.9 6 4.2 3.3c-.3-.3-.3-.8 0-1.1.3-.3.8-.3 1.1 0l3.3 3.3c.3.3.3.8 0 1.1L5.3 9.8c-.2.1-.4.2-.6.2Z"/></svg>`;

    const folderIcon = document.createElement('span');
    folderIcon.className = 'folder-icon';
    folderIcon.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>`;

    const dirName = document.createElement('span');
    dirName.className = 'file-group-name';
    dirName.textContent = node.name;

    header.appendChild(chevron);
    header.appendChild(folderIcon);
    header.appendChild(dirName);
    group.appendChild(header);

    const fileList = document.createElement('div');
    fileList.className = 'file-group-items';

    node.files.forEach(file => fileList.appendChild(this.renderFileItem(file)));
    node.dirs.forEach(dir => fileList.appendChild(this.renderFileGroup(dir)));

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

    // Below its breakpoint pr.css hides the docked sidebar and flags that via
    // --sidebar-overlay-only; the toolbar toggle then opens it as an overlay
    // drawer instead. Reading the flag keeps the breakpoint in CSS only.
    const isOverlayMode = () => getComputedStyle(document.documentElement)
      .getPropertyValue('--sidebar-overlay-only').trim() === '1';

    // --sidebar-width is the room the docked sidebar takes from the layout:
    // 0 while collapsed, or on slim screens where it only floats.
    const syncSidebarWidth = () => {
      const docked = !isOverlayMode() && !sidebar.classList.contains('collapsed');
      const width = window.PanelResizer?.getSavedWidth('sidebar')
        || window.PanelResizer?.getDefaultWidth('sidebar')
        || 260;
      document.documentElement.style.setProperty('--sidebar-width', docked ? `${width}px` : '0px');
      // Notify PanelGroup so its docked-vs-floating decision sees the change
      window.panelGroup?._updateRightPanelGroupWidth();
    };

    // Restore collapsed state from localStorage (synchronous on init is fine)
    const isCollapsed = localStorage.getItem('file-sidebar-collapsed') === 'true';
    if (isCollapsed) {
      sidebar.classList.add('collapsed');
    }
    syncSidebarWidth();

    // The drawer state is transient so it never overwrites the persisted
    // docked (wide-screen) collapsed state.
    const setOverlayOpen = (open) => {
      sidebar.classList.toggle('sidebar--overlay-open', open);
      collapsedBtn.setAttribute('aria-expanded', String(open));
    };

    // Collapse button (X) in sidebar header - collapses sidebar
    toggleBtn.addEventListener('click', () => {
      if (isOverlayMode()) {
        setOverlayOpen(false);
        return;
      }
      toggleSidebar(true);
    });

    // Expand button in diff toolbar - expands sidebar (toggles the drawer on slim screens)
    collapsedBtn.addEventListener('click', () => {
      if (isOverlayMode()) {
        setOverlayOpen(!sidebar.classList.contains('sidebar--overlay-open'));
        return;
      }
      toggleSidebar(false);
    });

    // Picking a file from the drawer jumps to it, so get the drawer out of the
    // way of the diff it was covering.
    sidebar.addEventListener('click', (e) => {
      if (isOverlayMode() && e.target.closest?.('.file-item')) {
        setOverlayOpen(false);
      }
    });

    // Crossing the breakpoint: leaving slim mode docks the sidebar per its
    // persisted state, so drop the drawer (it must not reappear when the
    // viewport narrows again) and re-derive --sidebar-width either way.
    let wasOverlayMode = isOverlayMode();
    window.addEventListener('resize', () => {
      const overlayMode = isOverlayMode();
      if (overlayMode === wasOverlayMode) return;
      wasOverlayMode = overlayMode;
      if (!overlayMode) setOverlayOpen(false);
      syncSidebarWidth();
    });
  }

  /**
   * Scroll a file of the pane to the top of the pane. The viewer scrolls to
   * an item whether or not it is mounted, and lands its header at the top.
   *
   * Callers: the sidebar's entries (renderFileItem) and the chat panel's
   * file links (ChatPanel._handleFileLinkClick, _scrollToLine).
   * @param {string} filePath - Path of the file, in any form
   *   _canonicalFilePath accepts
   */
  async scrollToFile(filePath) {
    const path = this._canonicalFilePath(filePath);
    if (!path || !this.pierreBridge?.files.has(path)) return;
    if (this.isFileCollapsed(path) === false) this._prioritizePierreContentUpgrade(path);
    this.pierreBridge.scrollToItem(path, { align: 'start', behavior: 'smooth' });
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
   * Clear the previous run's AI findings when a new analysis starts: the AI
   * panel list and, through SuggestionManager.clearAISuggestions, every
   * suggestion card in the diff (inline rows, Pierre annotations, file-level
   * cards) and the navigator list. User comments stay. Shared by PR mode
   * (startAnalysis) and Local mode (startLocalAnalysis in local.js).
   */
  clearFindingsForNewAnalysis() {
    if (typeof window.aiPanel?.clearAllFindings === 'function') {
      try {
        // Also clears the diff view
        window.aiPanel.clearAllFindings();
        return;
      } catch (e) {
        console.warn('Error clearing AI panel findings:', e);
        // Fall through so the diff view is still cleared
      }
    }
    this.suggestionManager?.clearAISuggestions();
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
      this.clearFindingsForNewAnalysis();

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

    // Show loading state in place of the diff. The diff itself is left
    // alone until the refreshed one is rendered (renderDiff clears the
    // message); should the refresh end without a render, the message is
    // taken down again below and the diff that was there is back.
    const refreshStatus = this._setDiffStatus(
      '<div class="loading">Refreshing pull request...</div>', { hideScroller: true });

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

        // Save the expanded state of the file tree. (The reader's place in
        // the diff is kept by the viewer through the render.)
        const expandedFolders = new Set(this.expandedFolders);

        // Update PR header with fresh data (title, description may have changed)
        this.renderPRHeader(data.data);

        // Reload the files/diff with fresh data
        await this.loadAndDisplayFiles(owner, repo, number);

        // Re-render the three independent overlay layers on the fresh diff
        // (renderDiff replaces the viewer's files). Going through the shared
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
      // Only this refresh's own message, and only if nothing replaced it.
      this._clearDiffStatus(refreshStatus);
    }
  }

  // ─── Context Files ──────────────────────────────────────────────

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
      this._fileCollapsed.delete(key);
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
   * Scroll to a context file: bring its header to the top of the pane, or,
   * for a stored range that is not the file's first, that range's first
   * line; then flash `lineStart`.
   *
   * Callers: the sidebar's context entries (renderFileItem) and
   * ChatPanel._handleFileLinkClick.
   * @param {string} file - File path
   * @param {number} [lineStart] - line to flash
   * @param {number|string} [contextId] - the stored range the entry names
   */
  scrollToContextFile(file, lineStart, contextId) {
    const bridge = this.pierreBridge;
    const path = this._canonicalFilePath(file);
    if (!bridge || !path || !bridge.files.has(path)) return;

    const cached = this._contextContents.get(path);
    const totalLines = cached ? PRManager.countTextLines(cached.text) : 0;
    const ranges = (this.contextFiles || [])
      .filter(row => row.file === path)
      .map(row => ({ id: row.id, range: this._effectiveContextRange(row, totalLines) }))
      .filter(entry => entry.range);
    const firstStart = Math.min(...ranges.map(entry => entry.range.startLine));
    const named = contextId != null
      ? ranges.find(entry => String(entry.id) === String(contextId))
      : null;

    let scrolled = false;
    if (named && named.range.startLine > firstStart) {
      scrolled = bridge.scrollToLine(path, named.range.startLine, 'RIGHT', {
        align: 'center', behavior: 'smooth', flash: false
      });
    }
    if (!scrolled) bridge.scrollToItem(path, { align: 'start', behavior: 'smooth' });

    const line = Number(lineStart);
    if (Number.isFinite(line) && line > 0) {
      bridge.scrollToLine(path, line, 'RIGHT', { scroll: false });
    }
  }

  /**
   * Whether the viewer's item of a context file shows every line of a range
   * (at most the 500 lines a stored range may have). Asked of the bridge's
   * data, line by line.
   * @param {string} file
   * @param {number} start - first line
   * @param {number} end - last line
   * @returns {boolean}
   * @private
   */
  _contextItemShowsLines(file, start, end) {
    const bridge = this.pierreBridge;
    if (!bridge || !(end >= start)) return false;
    for (let line = start; line <= end; line++) {
      if (!bridge.isLineVisible(file, line, 'RIGHT')) return false;
    }
    return true;
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
    // A context file that is an item of the viewer: lines the reader has
    // revealed by hand are shown without a stored range, and need none. A
    // line inside a stored range goes on to the range logic below. A range
    // is asked line by line: its two ends can be shown (two separate
    // expansions) with hidden lines between them, and it then gets a range.
    if (existingEntries.length > 0 && lineStart != null
        && !existingEntries.some(cf => cf.line_start <= lineStart && cf.line_end >= lineStart)
        && this.pierreBridge?.files?.get?.(file)?.kind === 'context'
        && this._contextItemShowsLines(file, lineStart, lineEnd == null ? lineStart : lineEndVal)) {
      return { type: 'context', contextFile: existingEntries[0] };
    }
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
            // The row keeps its id; its new range is data, and the load
            // below publishes it.
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
