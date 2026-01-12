/**
 * Pull Request UI Management
 * Main orchestrator that coordinates the extracted modules:
 * - HunkParser: Hunk header parsing and gap context expansion
 * - LineTracker: Line number mapping and range selection
 * - DiffRenderer: Diff parsing and line rendering
 * - CommentManager: Comment forms and editing
 * - SuggestionManager: AI suggestion handling
 */
class PRManager {
  // Forward static constants from modules for backward compatibility
  static get CATEGORY_EMOJI_MAP() {
    return window.SuggestionManager?.CATEGORY_EMOJI_MAP || {
      'bug': '\u{1F41B}',
      'performance': '\u{26A1}',
      'design': '\u{1F4D0}',
      'code-style': '\u{1F9F9}',
      'improvement': '\u{1F4A1}',
      'praise': '\u{2B50}',
      'security': '\u{1F512}',
      'suggestion': '\u{1F4AC}'
    };
  }

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
    // Canonical file order - sorted file paths for consistent ordering across components
    this.canonicalFileOrder = new Map();

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

    // In local mode, LocalManager handles init instead
    if (!window.PAIR_REVIEW_LOCAL_MODE) {
      this.init();
    }
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
        await this.loadPR(owner, repo, parseInt(number));
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

      const [owner, repo, number] = parts;
      await this.loadPR(owner, repo, number);
    } catch (error) {
      console.error('Error initializing PR viewer:', error);
      this.showError(error.message);
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

      // Load saved comments
      await this.loadUserComments();

      // Initialize split button for comment actions
      this.initSplitButton();

      // Initialize AI Panel before loading suggestions so it can receive them
      // Only initialize if not already created (avoid duplicates on refresh)
      if (window.AIPanel && !window.aiPanel) {
        window.aiPanel = new window.AIPanel();
      }

      // Set PR context for AI Panel (for PR-specific localStorage keys)
      if (window.aiPanel?.setPR) {
        window.aiPanel.setPR(owner, repo, number);
      }

      // Load saved AI suggestions if they exist
      await this.loadAISuggestions();

      // Check if AI analysis is currently running
      await this.checkRunningAnalysis();

    } catch (error) {
      console.error('Error loading PR:', error);
      this.showError(error.message);
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * Load files and diff from the diff endpoint
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   */
  async loadAndDisplayFiles(owner, repo, number) {
    try {
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/diff`);

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
    if (branchName) {
      branchName.textContent = pr.head_branch;
      // Set tooltip with full branch info (base <- head, showing merge direction)
      if (branchContainer) {
        branchContainer.title = `${pr.base_branch} <- ${pr.head_branch}`;
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
    const lines = patch.split('\n');
    let diffPosition = 0;  // GitHub diff_position (1-indexed, consecutive)
    let prevBlockEnd = { old: 0, new: 0 };
    let isFirstHunk = true;

    // Parse diff into blocks (hunks)
    const blocks = [];
    let currentBlock = null;

    lines.forEach(line => {
      if (line.startsWith('@@')) {
        // Start new block
        if (currentBlock) {
          blocks.push(currentBlock);
        }

        // Parse hunk header
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          currentBlock = {
            header: line,
            oldStart: parseInt(match[1]),
            newStart: parseInt(match[2]),
            lines: []
          };
        }
      } else if (currentBlock) {
        currentBlock.lines.push(line);
      }
    });

    if (currentBlock) {
      blocks.push(currentBlock);
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
      const gapEndOld = (blockBounds.old || block.oldStart) - 1;
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
        // For the gap before the first hunk, lines are unchanged context starting at line 1
        // Both OLD and NEW versions have these lines, but their line numbers may differ
        // if the first hunk doesn't start at the same position in both versions
        const gapRow = window.HunkParser.createGapSection(
          null,
          fileName,
          1,
          gapEndOld,
          gapEndOld,
          'above',
          (controls, direction, count) => this.expandGapContext(controls, direction, count),
          1  // NEW also starts at line 1 for first-hunk gaps
        );
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
        old: endBounds.old || (block.oldStart + block.lines.filter(l => !l.startsWith('+')).length - 1),
        new: endBounds.new || (block.newStart + block.lines.filter(l => !l.startsWith('-')).length - 1)
      };
    });

    // Add end-of-file gap section after the last hunk
    // This handles the case where there are unchanged lines after the last change
    // Use EOF_SENTINEL (-1) for endLine to indicate "rest of file" (unknown size)
    // The gap is marked as pending validation and will be removed async if no lines exist
    if (blocks.length > 0) {
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
          this.lineTracker.potentialDragStart = null;

          if (start.lineNumber !== lineNumber || start.fileName !== file) {
            // Drag selection ended on a different line
            // If drag wasn't started yet (quick drag without mouseover), start it first
            if (!this.lineTracker.isDraggingRange) {
              this.lineTracker.startDragSelection(start.row, start.lineNumber, start.fileName, start.side);
            }
            this.lineTracker.completeDragSelection(row, lineNumber, file);
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
   */
  getLineNumber(row) {
    return this.lineTracker.getLineNumber(row);
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
    if (!this.currentPR) return null;

    const { owner, repo, number } = this.currentPR;
    const response = await fetch(
      `/api/file-content-original/${encodeURIComponent(fileName)}?owner=${owner}&repo=${repo}&number=${number}`
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
    const { gapStart: startLine, gapEnd: endLine, gapStartNew: startLineNew, offset: lineOffset } = coords;

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
          fragment.appendChild(newGapRow);
        }
      }

      // Insert fragment before gap row and remove the old gap row
      // The fragment is already assembled in the correct visual order
      gapRow.parentNode.insertBefore(fragment, gapRow);
      gapRow.remove();

      // Check all function context markers in this file and remove any whose
      // function definitions are now visible
      if (window.DiffRenderer) {
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
    const { gapStart, gapEnd, gapStartNew, offset: lineOffset } = coords;

    const fileName = controls.dataset.fileName;
    const tbody = gapRow.closest('tbody');

    if (!tbody) return;

    try {
      const data = await this.fetchFileContent(fileName);
      if (!data) return;

      const fragment = document.createDocumentFragment();

      // Create gap above if needed
      const gapAboveSize = expandStart - gapStart;
      if (gapAboveSize > 0) {
        const aboveRow = window.HunkParser.createGapRowElement(
          fileName,
          gapStart,
          expandStart - 1,
          gapAboveSize,
          'above',
          (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt),
          gapStartNew  // Preserve the NEW line number offset
        );
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
          'below',
          (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt),
          belowGapStartNew  // Updated NEW line number for gap below
        );
        fragment.appendChild(belowRow);
      }

      // Replace the gap row
      gapRow.parentNode.insertBefore(fragment, gapRow);
      gapRow.remove();

      // Check all function context markers in this file and remove any whose
      // function definitions are now visible
      if (window.DiffRenderer) {
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
   */
  async expandForSuggestion(file, lineStart, lineEnd = lineStart) {
    const { findMatchingGap, convertNewToOldCoords, debugLog } = window.GapCoordinates || {};
    debugLog?.('expandForSuggestion', `Attempting to reveal ${file}:${lineStart}-${lineEnd}`);

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
    // which checks NEW coordinates first (AI suggestions target NEW line numbers)
    const gapRows = fileElement.querySelectorAll('tr.context-expand-row');
    const match = findMatchingGap?.(gapRows, lineStart, lineEnd);

    if (!match) {
      console.warn(`[expandForSuggestion] Could not find gap for lines ${lineStart}-${lineEnd}`);
      return false;
    }

    const { row: targetGapRow, controls: targetControls, coords, matchedInNewCoords } = match;
    const { gapStart, gapEnd, gapStartNew, gapEndNew } = coords;
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

  getCodeFromLines(fileName, startLine, endLine) {
    return this.commentManager.getCodeFromLines(fileName, startLine, endLine);
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
        const response = await fetch(`/api/user-comment/${commentId}`);
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

      const editFormHTML = `
        <div class="user-comment-edit-form">
          <div class="comment-form-toolbar">
            <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M14.064 0a8.75 8.75 0 00-6.187 2.563l-.459.458c-.314.314-.616.641-.904.979H3.31a1.75 1.75 0 00-1.49.833L.11 7.607a.75.75 0 00.418 1.11l3.102.954c.037.051.079.1.124.145l2.429 2.428c.046.046.094.088.145.125l.954 3.102a.75.75 0 001.11.418l2.774-1.707a1.75 1.75 0 00.833-1.49V9.485c.338-.288.665-.59.979-.904l.458-.459A8.75 8.75 0 0016 1.936V1.75A1.75 1.75 0 0014.25 0h-.186z"></path>
              </svg>
            </button>
          </div>
          <textarea
            id="edit-comment-${commentId}"
            class="comment-edit-textarea"
            placeholder="Enter your comment..."
            data-file="${fileName}"
            data-line="${lineStart}"
            data-line-end="${lineEnd}"
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
    try {
      const textarea = document.getElementById(`edit-comment-${commentId}`);
      const editedText = textarea.value.trim();

      if (!editedText) {
        alert('Comment cannot be empty');
        textarea.focus();
        return;
      }

      const response = await fetch(`/api/user-comment/${commentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editedText })
      });

      if (!response.ok) throw new Error('Failed to update comment');

      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      const commentDiv = commentRow.querySelector('.user-comment');
      let bodyDiv = commentDiv.querySelector('.user-comment-body');
      const editForm = commentDiv.querySelector('.user-comment-edit-form');

      if (!bodyDiv) {
        bodyDiv = document.createElement('div');
        bodyDiv.className = 'user-comment-body';
        commentDiv.appendChild(bodyDiv);
      }

      bodyDiv.innerHTML = window.renderMarkdown ? window.renderMarkdown(editedText) : this.escapeHtml(editedText);
      bodyDiv.dataset.originalMarkdown = editedText;
      bodyDiv.style.display = '';

      if (editForm) editForm.remove();
      commentDiv.classList.remove('editing-mode');

      const timestamp = commentDiv.querySelector('.user-comment-timestamp');
      if (timestamp) timestamp.textContent = new Date().toLocaleString();

      // Notify AI Panel about the updated comment body
      if (window.aiPanel?.updateComment) {
        window.aiPanel.updateComment(commentId, { body: editedText });
      }

    } catch (error) {
      console.error('Error saving comment:', error);
      alert('Failed to save comment');
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

    const timestamp = commentDiv.querySelector('.user-comment-timestamp');
    if (timestamp && timestamp.textContent === 'Editing comment...') {
      timestamp.textContent = 'Draft';
    }
  }

  /**
   * Delete user comment
   * If the comment was adopted from an AI suggestion, the suggestion is transitioned to dismissed state.
   */
  async deleteUserComment(commentId) {
    if (!window.confirmDialog) {
      alert('Confirmation dialog unavailable. Please refresh the page.');
      return;
    }

    const result = await window.confirmDialog.show({
      title: 'Delete Comment?',
      message: 'Are you sure you want to delete this comment? This action cannot be undone.',
      confirmText: 'Delete',
      confirmClass: 'btn-danger'
    });

    if (result !== 'confirm') return;

    try {
      const response = await fetch(`/api/user-comment/${commentId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete comment');

      const apiResult = await response.json();

      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (commentRow) {
        commentRow.remove();
        this.updateCommentCount();
      }

      // Notify AI Panel about the deleted comment
      if (window.aiPanel?.removeComment) {
        window.aiPanel.removeComment(commentId);
      }

      // If a parent suggestion was dismissed, update its UI state
      if (apiResult.dismissedSuggestionId) {
        this.updateDismissedSuggestionUI(apiResult.dismissedSuggestionId);
      }
    } catch (error) {
      console.error('Error deleting comment:', error);
      alert('Failed to delete comment');
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
   * Clear all user comments
   */
  async clearAllUserComments() {
    // Count both line-level and file-level user comments
    const lineCommentRows = document.querySelectorAll('.user-comment-row');
    const fileCommentCards = document.querySelectorAll('.file-comment-card.user-comment');
    const totalComments = lineCommentRows.length + fileCommentCards.length;

    if (totalComments === 0) return;

    if (!window.confirmDialog) {
      alert('Confirmation dialog unavailable. Please refresh the page.');
      return;
    }

    const dialogResult = await window.confirmDialog.show({
      title: 'Clear All Comments?',
      message: `This will delete all ${totalComments} user comment${totalComments !== 1 ? 's' : ''} from this PR. This action cannot be undone.`,
      confirmText: 'Delete All',
      confirmClass: 'btn-danger'
    });

    if (dialogResult !== 'confirm') return;

    try {
      const response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/user-comments`, {
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

      // Clear internal userComments array
      this.userComments = [];

      // Clear comments from AI Panel
      if (window.aiPanel?.setComments) {
        window.aiPanel.setComments([]);
      }

      // Update comment count display
      this.updateCommentCount();

      // Update dismissed suggestions in the UI
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
   */
  async loadUserComments() {
    if (!this.currentPR) return;

    try {
      const response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/user-comments`);
      if (!response.ok) return;

      const data = await response.json();
      this.userComments = data.comments || [];

      // Separate file-level and line-level comments
      const fileLevelComments = [];
      const lineLevelComments = [];

      this.userComments.forEach(comment => {
        if (comment.is_file_level === 1) {
          fileLevelComments.push(comment);
        } else {
          lineLevelComments.push(comment);
        }
      });

      // Display line-level comments inline with diff
      lineLevelComments.forEach(comment => {
        const fileElement = this.findFileElement(comment.file);
        if (!fileElement) return;

        const lineRows = fileElement.querySelectorAll('tr');
        for (const row of lineRows) {
          const lineNum = this.getLineNumber(row);
          if (lineNum === comment.line_start) {
            this.displayUserComment(comment, row);
            break;
          }
        }
      });

      // Load file-level comments into their zones
      if (this.fileCommentManager && fileLevelComments.length > 0) {
        this.fileCommentManager.loadFileComments(fileLevelComments, []);
      }

      // Populate AI Panel with comments
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
   */
  async loadAISuggestions(level = null) {
    if (!this.currentPR) return;

    try {
      // First, check if analysis has been run for this PR
      const { owner, repo, number } = this.currentPR;
      let analysisHasRun = false;
      try {
        const checkResponse = await fetch(`/api/pr/${owner}/${repo}/${number}/has-ai-suggestions`);
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

      // Use provided level, or fall back to current selectedLevel
      const filterLevel = level || this.selectedLevel || 'final';
      const url = `/api/pr/${owner}/${repo}/${number}/ai-suggestions?levels=${filterLevel}`;

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

  async collapseAISuggestion(suggestionId, suggestionRow, collapsedText, status) {
    return this.suggestionManager.collapseAISuggestion(suggestionId, suggestionRow, collapsedText, status);
  }

  getCategoryEmoji(category) {
    return this.suggestionManager.getCategoryEmoji(category);
  }

  formatAdoptedComment(text, category) {
    return this.suggestionManager.formatAdoptedComment(text, category);
  }

  async createUserCommentFromSuggestion(suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side) {
    return this.suggestionManager.createUserCommentFromSuggestion(suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side);
  }

  getTypeDescription(type) {
    return this.suggestionManager.getTypeDescription(type);
  }

  /**
   * Adopt an AI suggestion and open it in edit mode
   */
  async adoptAndEditSuggestion(suggestionId) {
    try {
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (!suggestionDiv) throw new Error('Suggestion element not found');

      const { suggestionText, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
      const { suggestionRow, lineNumber, fileName, diffPosition, side } = this.getFileAndLineInfo(suggestionDiv);

      await this.collapseAISuggestion(suggestionId, suggestionRow, 'Suggestion adopted', 'adopted');

      const newComment = await this.createUserCommentFromSuggestion(
        suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side
      );

      this.displayUserCommentInEditMode(newComment, suggestionRow);

      // Notify AI Panel about the new adopted comment
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

      const { suggestionText, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
      const { suggestionRow, lineNumber, fileName, diffPosition, side } = this.getFileAndLineInfo(suggestionDiv);

      await this.collapseAISuggestion(suggestionId, suggestionRow, 'Suggestion adopted', 'adopted');

      const newComment = await this.createUserCommentFromSuggestion(
        suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side
      );

      this.displayUserComment(newComment, suggestionRow);

      // Notify AI Panel about the new adopted comment
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
    } catch (error) {
      console.error('Error adopting suggestion:', error);
      alert(`Failed to adopt suggestion: ${error.message}`);
    }
  }

  /**
   * Dismiss an AI suggestion
   * If the suggestion was adopted (hiddenForAdoption === 'true'), only toggle visibility
   * without changing the underlying status - the suggestion remains "adopted"
   */
  async dismissSuggestion(suggestionId) {
    try {
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      const suggestionRow = suggestionDiv?.closest('tr');

      // If this suggestion was adopted, only toggle visibility - don't change status
      // The adoption still exists (there's a user comment linked to this suggestion)
      if (suggestionRow?.dataset.hiddenForAdoption === 'true') {
        // suggestionDiv is guaranteed to exist since suggestionRow was derived from it
        suggestionDiv.classList.add('collapsed');

        const button = suggestionDiv.querySelector('.btn-restore');
        if (button) {
          button.title = 'Show suggestion';
          const btnText = button.querySelector('.btn-text');
          if (btnText) btnText.textContent = 'Show';
        }
        return;
      }

      const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
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
      const suggestionRow = suggestionDiv?.closest('tr');

      if (suggestionRow?.dataset.hiddenForAdoption === 'true') {
        const div = suggestionRow.querySelector('.ai-suggestion');
        if (div) {
          div.classList.toggle('collapsed');

          const button = suggestionRow.querySelector('.btn-restore');
          if (button) {
            const isNowCollapsed = div.classList.contains('collapsed');
            button.title = isNowCollapsed ? 'Show suggestion' : 'Hide suggestion';
            button.querySelector('.btn-text').textContent = isNowCollapsed ? 'Show' : 'Hide';
          }
        }
        return;
      }

      const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
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

    if (reviewEvent === 'REQUEST_CHANGES' && !reviewBody && document.querySelectorAll('.user-comment-row').length === 0) {
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
            generated: file.generated || false
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
        generated: file.generated || false
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

    const fileName = document.createElement('span');
    fileName.className = 'file-name';
    fileName.textContent = file.name;

    const changes = document.createElement('span');
    changes.className = 'file-changes';

    if (file.binary) {
      changes.textContent = 'BIN';
    } else {
      const parts = [];
      if (file.additions > 0) parts.push(`+${file.additions}`);
      if (file.deletions > 0) parts.push(`-${file.deletions}`);
      changes.textContent = parts.join(' ') || '';
    }

    item.appendChild(fileName);
    item.appendChild(changes);

    item.addEventListener('click', (e) => {
      e.preventDefault();
      this.scrollToFile(file.fullPath);
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

    // Restore collapsed state from localStorage
    const isCollapsed = localStorage.getItem('file-sidebar-collapsed') === 'true';
    if (isCollapsed) {
      sidebar.classList.add('collapsed');
    }

    // Collapse button (X) in sidebar header - collapses sidebar
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.add('collapsed');
      localStorage.setItem('file-sidebar-collapsed', 'true');
    });

    // Expand button in diff toolbar - expands sidebar
    collapsedBtn.addEventListener('click', () => {
      sidebar.classList.remove('collapsed');
      localStorage.setItem('file-sidebar-collapsed', 'false');
    });
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
  }

  /**
   * Check if AI analysis is currently running for this PR and show progress dialog
   */
  async checkRunningAnalysis() {
    if (!this.currentPR) return;

    try {
      const { owner, repo, number } = this.currentPR;
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/analysis-status`);

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

        // Show progress dialog for the running analysis
        if (window.progressModal) {
          window.progressModal.show(data.analysisId);
        } else {
          console.warn('Progress modal not yet initialized');
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
  reopenProgressModal() {
    if (this.currentAnalysisId && window.progressModal) {
      window.progressModal.show(this.currentAnalysisId);
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
   * Fetch last used custom instructions from review record
   * @returns {Promise<string>} Last custom instructions or empty string
   */
  async fetchLastCustomInstructions() {
    if (!this.currentPR) return '';

    const { owner, repo, number } = this.currentPR;
    try {
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/review-settings`);
      if (!response.ok) {
        return '';
      }
      const data = await response.json();
      return data.custom_instructions || '';
    } catch (error) {
      console.warn('Error fetching last custom instructions:', error);
      return '';
    }
  }

  /**
   * Trigger AI analysis
   */
  async triggerAIAnalysis() {
    // If analysis is already running, just reopen the progress modal
    if (this.isAnalyzing) {
      this.reopenProgressModal();
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
      // Check if PR has new commits before analysis
      try {
        const staleResponse = await fetch(`/api/pr/${owner}/${repo}/${number}/check-stale`);
        if (!staleResponse.ok) {
          // Handle non-OK responses (401/403/500 etc)
          const errorText = await staleResponse.text().catch(() => 'Unknown error');
          console.warn(`Stale check failed with status ${staleResponse.status}:`, errorText);
          if (window.toast) {
            window.toast.showWarning(`Could not verify PR is current (${staleResponse.status}). Proceeding with analysis.`);
          }
          // Fall through to continue with analysis
        } else {
          const staleData = await staleResponse.json();

          // Handle PR state - show info for closed/merged PRs but still allow analysis
          if (staleData.prState && (staleData.prState !== 'open' || staleData.merged)) {
            const stateLabel = staleData.merged ? 'merged' : 'closed';
            if (window.toast) {
              window.toast.showWarning(`This PR is ${stateLabel}. Analysis will proceed on the existing data.`);
            }
          }

          // Handle isStale === null (unknown - couldn't check)
          if (staleData.isStale === null) {
            // Couldn't verify - show toast and proceed
            if (window.toast) {
              window.toast.showWarning('Could not verify PR is current. Proceeding with analysis.');
            }
            // Continue with analysis
          } else if (staleData.isStale === true) {
            // PR is stale - show single dialog with 3 options
            if (!window.confirmDialog) {
              console.warn('ConfirmDialog not available for stale PR check');
            } else {
              const choice = await window.confirmDialog.show({
                title: 'PR Has New Commits',
                message: 'This pull request has new commits since you last loaded it. What would you like to do?',
                confirmText: 'Refresh & Analyze',
                confirmClass: 'btn-primary',
                secondaryText: 'Analyze Anyway',
                secondaryClass: 'btn-warning'
              });

              if (choice === 'confirm') {
                // User wants to refresh first
                await this.refreshPR();
                // After refresh, continue with analysis
              } else if (choice === 'secondary') {
                // User chose to analyze anyway - continue with stale data
              } else {
                // User cancelled
                return;
              }
            }
          }
          // If isStale === false, PR is up-to-date, just continue
        }
      } catch (staleError) {
        // Fail-open: show toast warning and continue with analysis
        console.warn('Error checking PR staleness:', staleError);
        if (window.toast) {
          window.toast.showWarning('Could not verify PR is current. Proceeding with analysis.');
        }
      }

      // Check if there are existing AI suggestions first
      let hasSuggestions = false;
      try {
        const checkResponse = await fetch(`/api/pr/${owner}/${repo}/${number}/has-ai-suggestions`);
        if (checkResponse.ok) {
          const data = await checkResponse.json();
          hasSuggestions = data.hasSuggestions;
        }
      } catch (checkError) {
        console.warn('Error checking for existing AI suggestions:', checkError);
      }

      // If there are existing suggestions, confirm replacement before showing modal
      if (hasSuggestions) {
        if (!window.confirmDialog) {
          console.error('ConfirmDialog not loaded');
          this.showError('Confirmation dialog unavailable. Please refresh the page.');
          return;
        }

        const replaceResult = await window.confirmDialog.show({
          title: 'Replace Existing Analysis?',
          message: 'This will replace all existing AI suggestions for this PR. Continue?',
          confirmText: 'Continue',
          confirmClass: 'btn-danger'
        });

        if (replaceResult !== 'confirm') {
          return;
        }
      }

      // Show analysis config modal
      if (!this.analysisConfigModal) {
        console.warn('AnalysisConfigModal not initialized, proceeding without config');
        await this.startAnalysis(owner, repo, number, btn, {});
        return;
      }

      // Fetch repo settings and last used instructions in parallel
      const [repoSettings, lastInstructions] = await Promise.all([
        this.fetchRepoSettings(),
        this.fetchLastCustomInstructions()
      ]);

      // Determine the model and provider to use (priority: remembered > repo default > defaults)
      const modelStorageKey = PRManager.getRepoStorageKey('pair-review-model', owner, repo);
      const providerStorageKey = PRManager.getRepoStorageKey('pair-review-provider', owner, repo);
      const rememberedModel = localStorage.getItem(modelStorageKey);
      const rememberedProvider = localStorage.getItem(providerStorageKey);
      const currentModel = rememberedModel || repoSettings?.default_model || 'sonnet';
      const currentProvider = rememberedProvider || repoSettings?.default_provider || 'claude';

      // Show the config modal
      const config = await this.analysisConfigModal.show({
        currentModel,
        currentProvider,
        repoInstructions: repoSettings?.default_instructions || '',
        lastInstructions: lastInstructions,
        rememberModel: !!(rememberedModel || rememberedProvider)
      });

      // If user cancelled, do nothing
      if (!config) {
        return;
      }

      // Save remembered model and provider preferences if requested
      if (config.rememberModel) {
        localStorage.setItem(modelStorageKey, config.model);
        localStorage.setItem(providerStorageKey, config.provider);
      } else {
        localStorage.removeItem(modelStorageKey);
        localStorage.removeItem(providerStorageKey);
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

      // Start AI analysis with model and instructions
      const response = await fetch(`/api/analyze/${owner}/${repo}/${number}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          provider: config.provider || 'claude',
          model: config.model || 'sonnet',
          customInstructions: config.customInstructions || null
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start AI analysis');
      }

      const result = await response.json();

      // Set AI Panel to loading state
      if (window.aiPanel?.setAnalysisState) {
        window.aiPanel.setAnalysisState('loading');
      }

      // Set analyzing state and show progress modal
      this.setButtonAnalyzing(result.analysisId);

      if (window.progressModal) {
        window.progressModal.show(result.analysisId);
      }

    } catch (error) {
      console.error('Error starting AI analysis:', error);
      this.showError(`Failed to start AI analysis: ${error.message}`);
      this.resetButton();
    }
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
}

// Initialize PR manager when DOM is loaded (browser environment only)
let prManager;
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // Clean up legacy localStorage on startup (shared module loaded via HTML)
    if (typeof window.cleanupLegacyLocalStorage === 'function') {
      window.cleanupLegacyLocalStorage();
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
