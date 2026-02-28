// SPDX-License-Identifier: GPL-3.0-or-later
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
   * Generate a safe localStorage key for repository-specific settings
   * Uses base64 encoding to handle special characters in owner/repo names
   * @param {string} prefix - Key prefix (e.g., 'pair-review-model')
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {string} Safe localStorage key
   */
  static getRepoStorageKey(prefix, owner, repo) {
    // Use encodeURIComponent + btoa to safely handle Unicode characters
    // btoa() only accepts Latin1, so we encode Unicode first
    const repoId = btoa(unescape(encodeURIComponent(`${owner}/${repo}`))).replace(/=/g, '');
    return `${prefix}:${repoId}`;
  }

  constructor() {
    this.currentPR = null;
    this.loadingState = false;
    this.expandedFolders = new Set();
    this.expandedSections = new Set();
    this.currentTheme = localStorage.getItem('theme') || 'light';
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
    // Canonical file order - sorted file paths for consistent ordering across components
    this.canonicalFileOrder = new Map();
    // Raw per-file patch text for chat context enrichment
    this.filePatches = new Map();
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

    // Initialize event handlers and UI
    this.setupEventHandlers();
    this.initTheme();
    this.initAnalysisConfigModal();
    this.initKeyboardShortcuts();

    // Initialize diff options dropdown (gear icon for whitespace toggle).
    // Must happen before init() so the persisted hideWhitespace state is
    // applied before the first loadAndDisplayFiles() call.
    const diffOptionsBtn = document.getElementById('diff-options-btn');
    if (diffOptionsBtn && window.DiffOptionsDropdown) {
      this.diffOptionsDropdown = new window.DiffOptionsDropdown(diffOptionsBtn, {
        onToggleWhitespace: (hide) => this.handleWhitespaceToggle(hide),
      });
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
   * Set up event handlers
   */
  setupEventHandlers() {
    // Theme toggle
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => this.toggleTheme());
    }

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
   * Auto-trigger analysis if ?analyze=true is present in the URL.
   * Cleans up the query parameter afterwards regardless of success or failure.
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} prNumber - PR number
   */
  async _maybeAutoAnalyze(owner, repo, prNumber) {
    const autoAnalyze = new URLSearchParams(window.location.search).get('analyze');
    if (autoAnalyze === 'true' && !this.isAnalyzing) {
      this._autoAnalyzeRequested = true;
      try {
        await this.startAnalysis(owner, repo, prNumber, null, {});
      } finally {
        this._autoAnalyzeRequested = false;
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('analyze');
        history.replaceState(null, '', cleanUrl);
      }
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

      // Render PR header with metadata
      this.renderPRHeader(prData);

      // Fetch diff and file list from diff endpoint
      await this.loadAndDisplayFiles(owner, repo, number);

      // Initialize split button for comment actions
      this.initSplitButton();

      // Initialize AI Panel before loading comments so we can read the restored filter state
      // Only initialize if not already created (avoid duplicates on refresh)
      if (window.AIPanel && !window.aiPanel) {
        window.aiPanel = new window.AIPanel();
      }

      // Set PR context for AI Panel (for PR-specific localStorage keys)
      // This restores the filter state from localStorage
      if (window.aiPanel?.setPR) {
        window.aiPanel.setPR(owner, repo, number);
      }

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

    } catch (error) {
      console.error('Error loading PR:', error);
      this.showError(error.message);
    } finally {
      this.setLoading(false);
    }
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
            .then(() => this.loadAISuggestions());
        } else {
          this.loadAISuggestions();
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
            .then(() => this.loadAISuggestions());
        } else {
          this.loadAISuggestions();
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
      let diffUrl = `/api/pr/${owner}/${repo}/${number}/diff`;
      if (this.hideWhitespace) {
        diffUrl += '?w=1';
      }
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

        // Update sidebar with file list
        this.updateFileList(sortedFiles);

        // Load viewed state before rendering so files can start collapsed
        await this.loadViewedState();

        // Render diff using the existing renderDiff method
        this.renderDiff({ changed_files: sortedFiles });

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

    // Re-anchor comments and suggestions on the fresh DOM
    const includeDismissed = window.aiPanel?.showDismissedComments || false;
    await this.loadUserComments(includeDismissed);
    await this.loadAISuggestions(null, this.selectedRunId);

    // Restore scroll position after the DOM settles
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollY);
    });
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
      if (loading) {
        container.classList.add('loading');
      } else {
        container.classList.remove('loading');
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

    // Update title
    const titleElement = document.getElementById('pr-title-text');
    if (titleElement) {
      titleElement.textContent = pr.title;
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
      commitSha.textContent = pr.head_sha.substring(0, 7);
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

    // Create the indicator
    const indicator = document.createElement('a');
    indicator.id = 'pending-draft-indicator';
    indicator.className = 'pending-draft-indicator';
    indicator.href = pendingDraft.github_url || '#';
    indicator.target = '_blank';
    indicator.rel = 'noopener noreferrer';
    indicator.title = 'View your pending draft review on GitHub';

    const commentCount = pendingDraft.comments_count || 0;
    const commentText = commentCount === 1 ? '1 comment' : `${commentCount} comments`;

    indicator.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm5.03 2.22a.75.75 0 0 1 0 1.06L5.31 6.25l1.47 1.47a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.06 0Zm2.44 0a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l1.47-1.47-1.47-1.47a.75.75 0 0 1 0-1.06Z"/>
      </svg>
      <span class="pending-draft-text">Draft on GitHub (${commentText})</span>
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
   * Render diff for the PR
   * @param {Object} pr - PR data with files
   */
  renderDiff(pr) {
    const diffContainer = document.getElementById('diff-container');
    if (!diffContainer) return;

    diffContainer.innerHTML = '';

    // Use changed_files array from API
    const files = pr.changed_files || pr.files || [];

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
    if (files.length > 0) {
      files.forEach(file => {
        const fileWrapper = this.renderFileDiff(file);
        if (fileWrapper) {
          diffContainer.appendChild(fileWrapper);
        }
      });

      // Async validate end-of-file gaps - removes any that have no trailing lines
      // This runs after render to avoid blocking initial display
      this.validatePendingEofGaps();
    } else {
      diffContainer.innerHTML = '<div class="no-diff">No files changed</div>';
    }

    // Load context files after diff is rendered
    this.contextFiles = [];
    this.loadContextFiles();
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

    // Create file header with new options API
    const header = window.DiffRenderer.createFileHeader(file.file, {
      isGenerated,
      isExpanded: !isCollapsed,
      isViewed,
      generatedInfo: isGenerated ? this.generatedFiles.get(file.file) : null,
      fileStats,
      renamed: file.renamed || false,
      renamedFrom: file.renamedFrom || null,
      onToggleCollapse: (path) => this.toggleFileCollapse(path),
      onToggleViewed: (path, checked) => this.toggleFileViewed(path, checked)
    });
    wrapper.appendChild(header);

    // Create file-level comments zone (between header and diff)
    if (this.fileCommentManager) {
      const fileCommentsZone = this.fileCommentManager.createFileCommentsZone(file.file);
      wrapper.appendChild(fileCommentsZone);

      // Add file comment button to header - directly adds a file comment (like GitHub)
      const fileCommentBtn = document.createElement('button');
      fileCommentBtn.className = 'file-header-comment-btn';
      fileCommentBtn.title = 'Add file comment';
      fileCommentBtn.dataset.file = file.file;
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
        this.fileCommentManager.showCommentForm(fileCommentsZone, file.file);
      });
      header.appendChild(fileCommentBtn);

      // Store reference for updating icon state later
      fileCommentsZone.headerButton = fileCommentBtn;

      // Add file chat button to header
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
          window.chatPanel.open({
            fileContext: { file: file.file }
          });
        }
      });
      header.appendChild(fileChatBtn);
    }

    // Create diff table
    const table = document.createElement('table');
    table.className = 'd2h-diff-table';

    const tbody = document.createElement('tbody');

    // Parse the diff content
    if (file.patch) {
      this.renderPatch(tbody, file.patch, file.file);
    } else if (file.binary) {
      const row = document.createElement('tr');
      row.innerHTML = '<td colspan="2" class="binary-file">Binary file</td>';
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    wrapper.appendChild(table);

    return wrapper;
  }

  /**
   * Parse and render a unified diff patch
   * @param {HTMLElement} tbody - Table body element
   * @param {string} patch - Unified diff patch string
   * @param {string} fileName - File name
   */
  renderPatch(tbody, patch, fileName) {
    let diffPosition = 0;  // GitHub diff_position (1-indexed, consecutive)
    let prevBlockEnd = { old: 0, new: 0 };
    let isFirstHunk = true;

    const blocks = window.HunkParser.parseDiffIntoBlocks(patch);

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
      });

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
  toggleFileCollapse(filePath) {
    const wrapper = document.querySelector(`[data-file-name="${filePath}"]`);
    if (!wrapper) return;

    const isCollapsed = wrapper.classList.contains('collapsed');
    const header = wrapper.querySelector('.d2h-file-header');

    if (isCollapsed) {
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
  }

  /**
   * Toggle viewed state of a file
   * @param {string} filePath - Path of the file
   * @param {boolean} isViewed - Whether the file is now viewed
   */
  toggleFileViewed(filePath, isViewed) {
    const wrapper = document.querySelector(`[data-file-name="${filePath}"]`);

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
      }
    } else {
      this.viewedFiles.delete(filePath);
    }

    // Persist viewed state
    this.saveViewedState();
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
    this.toggleFileCollapse(filePath);
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
   */
  async validatePendingEofGaps() {
    const pendingGaps = document.querySelectorAll('tr.context-expand-row[data-pending-eof-validation="true"]');

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
          content: content || ''
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
          content: content || ''
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

    // Check if file is collapsed (generated files)
    if (fileElement.classList.contains('collapsed')) {
      debugLog?.('expandForSuggestion', 'File is collapsed, expanding first');
      this.toggleGeneratedFile(file);
      await new Promise(resolve => setTimeout(resolve, 50));
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
      const resolvedSide = (side || 'right').toUpperCase();

      const fileElement = this.findFileElement(file);
      if (!fileElement) continue;

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
    this.commentManager.showCommentForm(targetRow, lineNumber, fileName, diffPosition, endLineNumber, side);
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

      // Check if dismissed comments filter is enabled for AI Panel updates
      const showDismissed = window.aiPanel?.showDismissedComments || false;

      // Always remove the comment from the diff view (design decision: dismissed comments never shown in diff)
      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (commentRow) {
        commentRow.remove();
        this.updateCommentCount();
      }

      // Also handle file-level comment cards
      const fileCommentCard = document.querySelector(`.file-comment-card[data-comment-id="${commentId}"]`);
      if (fileCommentCard) {
        const zone = fileCommentCard.closest('.file-comments-zone');
        fileCommentCard.remove();
        if (zone && this.fileCommentManager) {
          this.fileCommentManager.updateCommentCount(zone);
        }
        this.updateCommentCount();
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

      // Show success toast
      if (window.toast) {
        window.toast.showSuccess('Comment dismissed');
      }
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
    // Count both line-level and file-level user comments
    const lineCommentRows = document.querySelectorAll('.user-comment-row');
    const fileCommentCards = document.querySelectorAll('.file-comment-card.user-comment');
    const totalComments = lineCommentRows.length + fileCommentCards.length;

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

      // Remove line-level comment rows from DOM
      lineCommentRows.forEach(row => row.remove());

      // Remove file-level comment cards from DOM
      fileCommentCards.forEach(card => {
        const zone = card.closest('.file-comments-zone');
        card.remove();

        // Update the file comment zone header button state
        if (zone && this.fileCommentManager) {
          this.fileCommentManager.updateCommentCount(zone);
        }
      });

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
      document.querySelectorAll('.user-comment-row').forEach(row => row.remove());

      // Before rendering, ensure all comment target lines are visible
      // (expand hidden hunks so the line rows exist in the DOM)
      const lineItems = lineLevelComments.map(c => ({
        file: c.file,
        line_start: c.line_start,
        line_end: c.line_start,
        side: c.side || 'RIGHT'
      }));
      await this.ensureLinesVisible(lineItems);

      // Display line-level comments inline with diff (only active comments reach here)
      lineLevelComments.forEach(comment => {
        const fileElement = this.findFileElement(comment.file);
        if (!fileElement) return;

        // Use the comment's side to determine which coordinate system to search in
        // LEFT side = OLD coordinates (deleted lines or context lines in OLD coords)
        // RIGHT side = NEW coordinates (added lines or context lines in NEW coords)
        const side = comment.side || 'RIGHT';

        const lineRows = fileElement.querySelectorAll('tr');
        for (const row of lineRows) {
          // Pass side to getLineNumber() to get the correct coordinate system
          // This allows context lines (which have BOTH old and new line numbers) to be found
          // when the comment was placed on a LEFT-side line (old coordinate)
          const lineNum = this.getLineNumber(row, side);
          if (lineNum === comment.line_start) {
            this.displayUserComment(comment, row);
            break;
          }
        }
      });

      // Load file-level comments into their zones (only active comments reach here)
      if (this.fileCommentManager && fileLevelComments.length > 0) {
        this.fileCommentManager.loadFileComments(fileLevelComments, []);
      }

      // Populate AI Panel with all comments (including dismissed if requested)
      if (window.aiPanel?.setComments) {
        window.aiPanel.setComments(this.userComments);
      }

      this.updateCommentCount();
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
    return this.suggestionManager.displayAISuggestions(suggestions);
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
   * Handles adding collapsed class, updating text to 'Suggestion adopted',
   * updating the restore button, and setting hiddenForAdoption flag.
   * @param {HTMLElement} suggestionRow - The suggestion row element
   * @param {number|string} suggestionId - Suggestion ID
   */
  collapseSuggestionForAdoption(suggestionRow, suggestionId) {
    if (!suggestionRow) return;
    const targetDiv = suggestionRow.querySelector(`[data-suggestion-id="${suggestionId}"]`);
    if (!targetDiv) return;
    targetDiv.classList.add('collapsed');
    const collapsedContent = targetDiv.querySelector('.collapsed-text');
    if (collapsedContent) collapsedContent.textContent = 'Suggestion adopted';
    const restoreButton = targetDiv.querySelector('.btn-restore');
    if (restoreButton) {
      restoreButton.title = 'Show suggestion';
      const btnText = restoreButton.querySelector('.btn-text');
      if (btnText) btnText.textContent = 'Show';
    }
    targetDiv.dataset.hiddenForAdoption = 'true';
  }

  /**
   * Shared helper for adoptAndEditSuggestion and adoptSuggestion.
   * Performs the /adopt fetch, collapses the suggestion, formats the comment,
   * and builds the newComment object. Returns { newComment, suggestionRow }
   * or null on failure. Throws on errors so the caller can handle them.
   */
  async _adoptAndBuildComment(suggestionId, suggestionDiv) {
    const { suggestionText, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
    const { suggestionRow, lineNumber, fileName, diffPosition, side, isFileLevel } = this.getFileAndLineInfo(suggestionDiv);

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

    // Use the server-formatted body — server is the single source of truth
    const formattedText = adoptResult.formattedBody;
    const newComment = {
      id: adoptResult.userCommentId,
      file: fileName,
      line_start: parseInt(lineNumber),
      body: formattedText,
      type: suggestionType,
      title: suggestionTitle,
      parent_id: suggestionId,
      diff_position: diffPosition ? parseInt(diffPosition) : null,
      side: side || 'RIGHT',
      created_at: new Date().toISOString()
    };

    return { isFileLevel: false, newComment, suggestionRow };
  }

  /**
   * Notify panels and navigator after a successful adoption
   */
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

    this.updateCommentCount();
  }

  /**
   * Adopt an AI suggestion and open it in edit mode
   */
  async adoptAndEditSuggestion(suggestionId) {
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

        this.fileCommentManager.editAndAdoptAISuggestion(zone, suggestion);
        return;
      }

      this.displayUserCommentInEditMode(result.newComment, result.suggestionRow);
      this._notifyAdoption(suggestionId, result.newComment);
    } catch (error) {
      console.error('Error adopting and editing suggestion:', error);
      alert(`Failed to adopt suggestion: ${error.message}`);
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

      this.displayUserComment(result.newComment, result.suggestionRow);
      this._notifyAdoption(suggestionId, result.newComment);
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
        // suggestionDiv is guaranteed to exist since we just queried for it
        suggestionDiv.classList.add('collapsed');

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
        if (button) {
          const isNowCollapsed = suggestionDiv.classList.contains('collapsed');
          button.title = isNowCollapsed ? 'Show suggestion' : 'Hide suggestion';
          button.querySelector('.btn-text').textContent = isNowCollapsed ? 'Show' : 'Hide';
        }
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

        this.splitButton = new window.SplitButton({
          onSubmit: () => this.openReviewModal(),
          onPreview: () => this.openPreviewModal(),
          onClear: () => this.clearAllUserComments()
        });
        const buttonElement = this.splitButton.render();
        placeholder.appendChild(buttonElement);
        this.updateCommentCount();
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
   * Update comment count display
   * Note: Dismissed comments are never in the diff DOM (design decision), so we simply count all visible elements.
   */
  updateCommentCount() {
    // Count both line-level comments (.user-comment-row) and file-level comments (.file-comment-card.user-comment)
    const lineComments = document.querySelectorAll('.user-comment-row').length;
    const fileComments = document.querySelectorAll('.file-comment-card.user-comment').length;
    const userComments = lineComments + fileComments;

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

    // Count BOTH line-level and file-level comments for validation
    const lineComments = document.querySelectorAll('.user-comment-row').length;
    const fileComments = document.querySelectorAll('.file-comment-card.user-comment').length;
    const totalComments = lineComments + fileComments;
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

  scrollToFile(filePath) {
    const fileWrapper = document.querySelector(`[data-file-name="${filePath}"]`);
    if (fileWrapper) {
      fileWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
    document.documentElement.setAttribute('data-theme', this.currentTheme);
    this.updateThemeIcon();
  }

  toggleTheme() {
    this.currentTheme = this.currentTheme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', this.currentTheme);
    document.documentElement.setAttribute('data-theme', this.currentTheme);
    this.updateThemeIcon();
  }

  updateThemeIcon() {
    const themeButton = document.getElementById('theme-toggle');
    if (themeButton) {
      // Sun icon for light mode (with hollow center), moon icon for dark mode
      const icon = this.currentTheme === 'light' ?
        `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-1.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0-10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 0 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM16 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.061 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Z"/></svg>` :
        `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Z"/></svg>`;
      themeButton.innerHTML = icon;
      themeButton.title = `Switch to ${this.currentTheme === 'light' ? 'dark' : 'light'} mode`;
    }
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

    const btnText = btn.querySelector('.btn-text');
    if (btnText) {
      btnText.textContent = 'Analyzing...';
    } else {
      btn.innerHTML = '<span class="analyzing-icon">✨</span> Analyzing...';
    }

    // Show progress dots
    this.showProgressDots();
  }

  /**
   * Set button to complete state (briefly)
   */
  setButtonComplete() {
    const btn = this.getAnalyzeButton();
    if (!btn) return;

    btn.classList.remove('btn-analyzing');
    btn.classList.add('btn-complete');

    const btnText = btn.querySelector('.btn-text');
    if (btnText) {
      btnText.textContent = 'Complete';
    } else {
      btn.innerHTML = '✓ Analysis Complete';
    }
    btn.disabled = true;

    // Complete all progress dots (they'll be hidden when button resets)
    this.completeAllProgressDots();

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

    const btnText = btn.querySelector('.btn-text');
    if (btnText) {
      btnText.textContent = 'Analyze';
    } else {
      btn.innerHTML = 'Analyze with AI';
    }

    // Hide progress dots when resetting
    this.hideProgressDots();
  }

  // ============================================
  // Progress Dots Controller
  // ============================================

  /**
   * Get the progress dots container
   * @returns {HTMLElement|null}
   */
  getProgressDotsContainer() {
    return document.getElementById('analysis-progress-dots');
  }

  /**
   * Show progress dots (called when analysis starts)
   */
  showProgressDots() {
    const container = this.getProgressDotsContainer();
    if (!container) return;

    container.style.display = 'flex';

    // Reset all dots to initial state
    const dots = container.querySelectorAll('.progress-dot');
    dots.forEach(dot => {
      dot.classList.remove('active', 'completed', 'error');
    });

    // Set first dot (orchestration) as active
    const firstDot = container.querySelector('[data-phase="orchestration"]');
    if (firstDot) {
      firstDot.classList.add('active');
    }
  }

  /**
   * Hide progress dots (called when analysis completes or is cancelled)
   */
  hideProgressDots() {
    const container = this.getProgressDotsContainer();
    if (!container) return;

    container.style.display = 'none';

    // Reset all dots
    const dots = container.querySelectorAll('.progress-dot');
    dots.forEach(dot => {
      dot.classList.remove('active', 'completed', 'error');
    });
  }

  /**
   * Update progress dots based on level status
   * Maps level numbers to phases:
   * - Level 4 (orchestration/finalization) -> orchestration
   * - Level 1 -> level1
   * - Level 2 -> level2
   * - Level 3 -> level3
   * @param {number} level - The level number (1, 2, 3, or 4)
   * @param {string} status - The status ('running', 'completed', 'failed')
   */
  updateProgressDot(level, status) {
    const container = this.getProgressDotsContainer();
    if (!container) return;

    // Map levels to dot phases
    const phaseMap = {
      4: 'orchestration', // Orchestration/finalization is level 4 in progress modal
      1: 'level1',
      2: 'level2',
      3: 'level3'
    };

    const phase = phaseMap[level];
    if (!phase) return;

    const dot = container.querySelector(`[data-phase="${phase}"]`);
    if (!dot) return;

    // Remove existing states
    dot.classList.remove('active', 'completed', 'error');

    // Apply new state
    if (status === 'running') {
      dot.classList.add('active');
    } else if (status === 'completed') {
      dot.classList.add('completed');
    } else if (status === 'failed') {
      dot.classList.add('error');
    }
  }

  /**
   * Complete all progress dots (called briefly before hiding)
   */
  completeAllProgressDots() {
    const container = this.getProgressDotsContainer();
    if (!container) return;

    const dots = container.querySelectorAll('.progress-dot');
    dots.forEach(dot => {
      dot.classList.remove('active', 'error');
      dot.classList.add('completed');
    });
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
              enabledLevels: data.status?.enabledLevels || [1, 2, 3]
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

    // Reopen the progress modal if it was tracking this analysis
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

      // Run stale check and settings fetch in parallel to minimize dialog delay
      // Use AbortController so the fetch is truly cancelled on timeout,
      // freeing the HTTP connection for subsequent requests.
      const _tParallel0 = performance.now();
      const staleAbort = new AbortController();
      const staleTimer = setTimeout(() => {
        console.debug(`[Analyze] stale-check timed out after ${STALE_TIMEOUT}ms, aborting`);
        staleAbort.abort();
      }, STALE_TIMEOUT);
      const staleCheckWithTimeout = fetch(`/api/pr/${owner}/${repo}/${number}/check-stale`, { signal: staleAbort.signal })
        .then(r => r.ok ? r.json() : null)
        .then(result => { clearTimeout(staleTimer); return result; })
        .catch(() => { clearTimeout(staleTimer); return null; });

      const [staleResult, repoSettings, reviewSettings] = await Promise.all([
        staleCheckWithTimeout,
        this.fetchRepoSettings(),
        this.fetchLastReviewSettings()
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

      // Determine the model and provider to use (priority: repo default > defaults)
      const currentModel = repoSettings?.default_model || 'opus';
      const currentProvider = repoSettings?.default_provider || 'claude';

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
        defaultCouncilId: repoSettings?.default_council_id || null
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
          customInstructions: config.customInstructions || null
        };
      } else {
        analyzeUrl = `/api/pr/${owner}/${repo}/${number}/analyses`;
        analyzeBody = {
          provider: config.provider || 'claude',
          model: config.model || 'opus',
          tier: config.tier || 'balanced',
          customInstructions: config.customInstructions || null,
          enabledLevels: config.enabledLevels || [1, 2, 3],
          skipLevel3: config.skipLevel3 || false
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
            enabledLevels: config.enabledLevels || [1, 2, 3]
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
   * Show an error when the worktree is not found during analysis.
   * Displays a helpful message with a reload link. If the user arrived
   * via auto-analyze (?analyze=true), the reload link preserves that
   * parameter so analysis re-triggers after setup.
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   */
  showWorktreeNotFoundError(owner, repo, number) {
    let setupUrl = `/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
    if (this._autoAnalyzeRequested) {
      setupUrl += '?analyze=true';
    }
    const container = document.getElementById('pr-container');
    if (container) {
      container.innerHTML = `
        <div class="error-container">
          <div class="error-icon">Warning</div>
          <div class="error-message">Worktree not found. Please reload the PR to set up the worktree before running analysis.</div>
          <a class="btn btn-primary" href="${this.escapeHtml(setupUrl)}">Reload PR</a>
        </div>
      `;
      container.style.display = 'block';
    }
    this.resetButton();
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

    // Show loading state in diff container
    const diffContainer = document.getElementById('diff-container');
    if (diffContainer) {
      diffContainer.innerHTML = '<div class="loading">Refreshing pull request...</div>';
    }

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

        // Save scroll position and expanded state
        const scrollPosition = window.scrollY;
        const expandedFolders = new Set(this.expandedFolders);

        // Update PR header with fresh data (title, description may have changed)
        this.renderPRHeader(data.data);

        // Reload the files/diff with fresh data
        await this.loadAndDisplayFiles(owner, repo, number);

        // Re-render comments and AI suggestions on the fresh DOM
        // (renderDiff clears the diff container, so we must re-populate)
        const includeDismissed = window.aiPanel?.showDismissedComments || false;
        await this.loadUserComments(includeDismissed);
        // Note: Unlike loadPR() which skips this when analysisHistoryManager exists
        // (because the manager triggers loadAISuggestions via onSelectionChange on init),
        // refresh must call unconditionally since the manager won't re-fire its callback.
        await this.loadAISuggestions(null, this.selectedRunId);

        // Restore expanded folders
        this.expandedFolders = expandedFolders;

        // Restore scroll position after a short delay to allow rendering
        setTimeout(() => {
          window.scrollTo(0, scrollPosition);
        }, 100);

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

      // Add only new context files
      let newFilesRendered = false;
      for (const cf of newFiles) {
        if (!oldIds.has(cf.id)) {
          await this.renderContextFile(cf);
          newFilesRendered = true;
        }
      }

      this.contextFiles = newFiles;

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
    tbody.dataset.lineStart = contextFile.line_start;

    // Chunk header row with range label and per-chunk dismiss button
    const headerRow = document.createElement('tr');
    headerRow.className = 'context-chunk-header';
    const lineNumTd = document.createElement('td');
    lineNumTd.className = 'd2h-code-linenumber';
    headerRow.appendChild(lineNumTd);
    const contentTd = document.createElement('td');
    contentTd.className = 'd2h-code-side-line';
    contentTd.colSpan = 3;
    const rangeLabel = document.createElement('span');
    rangeLabel.className = 'context-range-label';
    const lineEnd = Math.min(contextFile.line_end, data.lines.length);
    rangeLabel.textContent = `Lines ${contextFile.line_start}\u2013${lineEnd}`;
    contentTd.appendChild(rangeLabel);
    const chunkDismiss = document.createElement('button');
    chunkDismiss.className = 'context-chunk-dismiss';
    chunkDismiss.title = 'Remove this range';
    chunkDismiss.innerHTML = '\u00d7';
    chunkDismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      this.removeContextFile(contextFile.id);
    });
    contentTd.appendChild(chunkDismiss);
    headerRow.appendChild(contentTd);
    tbody.appendChild(headerRow);

    const lineStart = contextFile.line_start;
    const clampedEnd = Math.min(contextFile.line_end, data.lines.length);

    // Add expand-up gap row if there are lines above the context range
    if (lineStart > 1) {
      const gapAboveSize = lineStart - 1;
      const gapAbove = window.HunkParser.createGapRowElement(
        contextFile.file,
        1,              // startLine (old coords)
        lineStart - 1,  // endLine (old coords)
        gapAboveSize,
        'above',
        this.expandGapContext.bind(this),
        1               // startLineNew (same as old for context files — no diff offset)
      );
      tbody.appendChild(gapAbove);
    }

    for (let i = lineStart; i <= clampedEnd; i++) {
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
   * Render a single context file range in the diff panel.
   * Merges ranges for the same file into a single wrapper with multiple chunk tbodies.
   * @param {Object} contextFile - { id, review_id, file, line_start, line_end, label }
   */
  async renderContextFile(contextFile) {
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
      this.toggleFileCollapse(contextFile.file);
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
    viewedCheckbox.checked = this.viewedFiles.has(contextFile.file);
    viewedCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      this.toggleFileViewed(contextFile.file, viewedCheckbox.checked);
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
      this.toggleFileCollapse(contextFile.file);
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
    wrapper.appendChild(table);

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
   * Remove a context file by ID.
   * @param {number} contextFileId
   */
  async removeContextFile(contextFileId) {
    const reviewId = this.currentPR?.id;
    if (!reviewId) return;

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
    } catch (error) {
      console.error('Error removing context file:', error);
    }
  }

  /**
   * Scroll to a context file (or diff file) in the diff panel.
   * @param {string} file - File path
   * @param {number} [lineStart] - Optional line number to highlight
   */
  scrollToContextFile(file, lineStart, contextId) {
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

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (lineStart) {
      // Search for the line row within the wrapper (not just the target chunk)
      const wrapper = target.closest('.d2h-file-wrapper') || target;
      // Brief delay to let scroll settle, then highlight the target line
      setTimeout(() => {
        const row = wrapper.querySelector(`tr[data-line-number="${lineStart}"]`);
        if (row) {
          row.classList.remove('chat-line-highlight');
          void row.offsetWidth;
          row.classList.add('chat-line-highlight');
          row.addEventListener('animationend', () => {
            row.classList.remove('chat-line-highlight');
          }, { once: true });
        }
      }, 400);
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
      lineStartVal = lineStart;
      lineEndVal = lineStart + 49;
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

    prManager = new PRManager();
    // CRITICAL FIX: Make prManager available globally for component access
    window.prManager = prManager;
  });
}

// Export for testing (Node.js environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PRManager };
}
