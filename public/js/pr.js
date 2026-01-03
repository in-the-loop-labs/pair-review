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

    // Initialize modules
    this.lineTracker = new window.LineTracker();
    this.commentManager = new window.CommentManager(this);
    this.suggestionManager = new window.SuggestionManager(this);

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
    this.init();
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

    // Setup comment form keyboard shortcut delegation
    this.setupCommentFormDelegation();
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
      if (window.AIPanel) {
        window.aiPanel = new window.AIPanel();
      }

      // Load saved AI suggestions if they exist
      await this.loadAISuggestions();

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

        // Update sidebar with file list
        this.updateFileList(filesWithPatches);

        // Render diff using the existing renderDiff method
        this.renderDiff({ changed_files: filesWithPatches });

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
    const filePattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
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

    // Update meta info
    const branchName = document.getElementById('pr-branch-name');
    if (branchName) {
      branchName.textContent = `${pr.base_branch} <- ${pr.head_branch}`;
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

      if (commitCopy) {
        commitCopy.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(pr.head_sha);
            // Visual feedback
            commitCopy.classList.add('copied');
            setTimeout(() => commitCopy.classList.remove('copied'), 2000);
          } catch (err) {
            console.error('Failed to copy SHA:', err);
          }
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
    if (isGenerated) {
      wrapper.classList.add('generated-file', 'collapsed');
    }

    // Create file header
    const header = window.DiffRenderer.createFileHeader(
      file.file,
      isGenerated,
      !wrapper.classList.contains('collapsed'),
      isGenerated ? this.generatedFiles.get(file.file) : null,
      (path) => this.toggleGeneratedFile(path)
    );
    wrapper.appendChild(header);

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
    let currentHunkHeader = null;
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
          (controls, direction, count) => this.expandGapContext(controls, direction, count)
        );
        tbody.appendChild(gapRow);

        // Auto-expand small gaps
        if (window.HunkParser.shouldAutoExpand(gapSize)) {
          setTimeout(() => this.expandGapContext(gapRow.expandControls, 'all', gapSize), 0);
        }
      } else if (gapSize > 0 && isFirstHunk) {
        // Create "expand up" section at file start
        const gapRow = window.HunkParser.createGapSection(
          null,
          fileName,
          1,
          gapEndOld,
          gapEndOld,
          'above',
          (controls, direction, count) => this.expandGapContext(controls, direction, count)
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
      onCommentButtonClick: (e, row, lineNumber, file, lineData) => {
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
      onMouseOver: (e, row, lineNumber, file) => {
        this.lineTracker.updateDragSelection(row, lineNumber, file);
      },
      onMouseUp: (e, row, lineNumber, file) => {
        if (this.lineTracker.potentialDragStart) {
          const start = this.lineTracker.potentialDragStart;
          this.lineTracker.potentialDragStart = null;

          if (start.lineNumber !== lineNumber || start.fileName !== file) {
            // Drag selection ended on a different line
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
   * Toggle visibility of generated file diff
   * @param {string} filePath - Path of the file
   */
  toggleGeneratedFile(filePath) {
    const wrapper = document.querySelector(`[data-file-name="${filePath}"]`);
    if (!wrapper) return;

    const isCollapsed = wrapper.classList.contains('collapsed');
    const toggleBtn = wrapper.querySelector('.generated-toggle');

    if (isCollapsed) {
      wrapper.classList.remove('collapsed');
      if (toggleBtn) {
        toggleBtn.innerHTML = window.DiffRenderer.EYE_CLOSED_ICON;
        toggleBtn.title = 'Hide generated file diff';
      }
    } else {
      wrapper.classList.add('collapsed');
      if (toggleBtn) {
        toggleBtn.innerHTML = window.DiffRenderer.EYE_ICON;
        toggleBtn.title = 'Show generated file diff';
      }
    }
  }

  /**
   * Expand gap context
   * @param {Element} controls - The expand controls element
   * @param {string} direction - 'up', 'down', or 'all'
   * @param {number} count - Number of lines to expand
   */
  async expandGapContext(controls, direction, count) {
    const fileName = controls.dataset.fileName;
    const startLine = parseInt(controls.dataset.startLine);
    const endLine = parseInt(controls.dataset.endLine);
    const gapRow = controls.closest ? controls.closest('tr') : controls.parentElement?.closest('tr');

    if (!gapRow || !this.currentPR) return;

    try {
      // Fetch file content
      const { owner, repo, number } = this.currentPR;
      const response = await fetch(`/api/file-content-original/${encodeURIComponent(fileName)}?owner=${owner}&repo=${repo}&number=${number}`);
      const data = await response.json();

      if (!response.ok || !data.lines) {
        console.error('Failed to fetch file content');
        return;
      }

      const tbody = gapRow.closest('tbody');
      if (!tbody) return;

      let linesToShow = [];
      let newGapStart = startLine;
      let newGapEnd = endLine;

      if (direction === 'all') {
        // Show all lines in the gap
        linesToShow = data.lines.slice(startLine - 1, endLine);
        newGapStart = endLine + 1; // No remaining gap
      } else if (direction === 'up') {
        // Show lines from the bottom of the gap (expanding upward)
        const expandEnd = endLine;
        const expandStart = Math.max(startLine, endLine - count + 1);
        linesToShow = data.lines.slice(expandStart - 1, expandEnd);
        newGapEnd = expandStart - 1;
      } else if (direction === 'down') {
        // Show lines from the top of the gap (expanding downward)
        const expandStart = startLine;
        const expandEnd = Math.min(endLine, startLine + count - 1);
        linesToShow = data.lines.slice(expandStart - 1, expandEnd);
        newGapStart = expandEnd + 1;
      }

      // Create fragment for new rows
      const fragment = document.createDocumentFragment();

      // If expanding down, add new gap at top first
      if (direction === 'down' && newGapStart <= endLine) {
        const remainingGap = endLine - newGapStart + 1;
        if (remainingGap > 0) {
          const newGapRow = window.HunkParser.createGapRowElement(
            fileName,
            newGapStart,
            endLine,
            remainingGap,
            'between',
            (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt)
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
          lineNumber = Math.max(startLine, endLine - count + 1) + idx;
        } else {
          lineNumber = startLine + idx;
        }

        const lineData = {
          type: 'context',
          oldNumber: lineNumber,
          newNumber: lineNumber,
          content: content || ''
        };

        const lineRow = this.renderDiffLine(fragment, lineData, fileName, null);
        if (lineRow) {
          lineRow.classList.add('newly-expanded');
          setTimeout(() => lineRow.classList.remove('newly-expanded'), 800);
        }
      });

      // If expanding up, add new gap at bottom
      if (direction === 'up' && newGapEnd >= startLine) {
        const remainingGap = newGapEnd - startLine + 1;
        if (remainingGap > 0) {
          const newGapRow = window.HunkParser.createGapRowElement(
            fileName,
            startLine,
            newGapEnd,
            remainingGap,
            'between',
            (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt)
          );
          fragment.appendChild(newGapRow);
        }
      }

      // Replace or insert based on direction
      if (direction === 'up') {
        gapRow.parentNode.insertBefore(fragment, gapRow);
        gapRow.remove();
      } else if (direction === 'down') {
        gapRow.parentNode.insertBefore(fragment, gapRow.nextSibling);
        gapRow.remove();
      } else {
        gapRow.parentNode.insertBefore(fragment, gapRow);
        gapRow.remove();
      }

    } catch (error) {
      console.error('Error expanding gap context:', error);
    }
  }

  /**
   * Expand a specific range within a gap
   */
  async expandGapRange(gapRow, controls, expandStart, expandEnd) {
    const fileName = controls.dataset.fileName;
    const gapStart = parseInt(controls.dataset.startLine);
    const gapEnd = parseInt(controls.dataset.endLine);
    const tbody = gapRow.closest('tbody');

    if (!tbody || !this.currentPR) return;

    try {
      const { owner, repo, number } = this.currentPR;
      const response = await fetch(`/api/file-content-original/${encodeURIComponent(fileName)}?owner=${owner}&repo=${repo}&number=${number}`);
      const data = await response.json();

      if (!response.ok || !data.lines) {
        console.error('Failed to fetch file content');
        return;
      }

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
          (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt)
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
          newNumber: lineNumber,
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
        const belowRow = window.HunkParser.createGapRowElement(
          fileName,
          expandEnd + 1,
          gapEnd,
          gapBelowSize,
          'below',
          (controls, dir, cnt) => this.expandGapContext(controls, dir, cnt)
        );
        fragment.appendChild(belowRow);
      }

      // Replace the gap row
      gapRow.parentNode.insertBefore(fragment, gapRow);
      gapRow.remove();

    } catch (error) {
      console.error('Error in expandGapRange:', error);
    }
  }

  /**
   * Expand for suggestion - reveal lines that an AI suggestion targets
   */
  async expandForSuggestion(file, lineStart, lineEnd = lineStart) {
    console.log(`[expandForSuggestion] Attempting to reveal ${file}:${lineStart}-${lineEnd}`);

    const fileElement = this.findFileElement(file);
    if (!fileElement) {
      console.warn(`[expandForSuggestion] Could not find file element for: ${file}`);
      return false;
    }

    // Check if file is collapsed (generated files)
    if (fileElement.classList.contains('collapsed')) {
      console.log(`[expandForSuggestion] File is collapsed, expanding first`);
      this.toggleGeneratedFile(file);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Find the gap section containing the target lines
    const gapRows = fileElement.querySelectorAll('tr.context-expand-row');
    let targetGapRow = null;
    let targetControls = null;

    for (const row of gapRows) {
      const controls = row.expandControls;
      if (!controls) continue;

      const gapStart = parseInt(controls.dataset.startLine);
      const gapEnd = parseInt(controls.dataset.endLine);

      if (lineStart <= gapEnd && lineEnd >= gapStart) {
        targetGapRow = row;
        targetControls = controls;
        break;
      }
    }

    if (!targetGapRow || !targetControls) {
      console.warn(`[expandForSuggestion] Could not find gap for lines ${lineStart}-${lineEnd}`);
      return false;
    }

    const gapStart = parseInt(targetControls.dataset.startLine);
    const gapEnd = parseInt(targetControls.dataset.endLine);
    const gapSize = gapEnd - gapStart + 1;

    // Calculate expansion range with context
    const contextRadius = 3;
    const expandStart = Math.max(gapStart, lineStart - contextRadius);
    const expandEnd = Math.min(gapEnd, lineEnd + contextRadius);
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

  autoSaveComment(textarea) {
    this.commentManager.autoSaveComment(textarea);
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
            <button class="btn btn-sm btn-primary save-edit-btn">Save comment</button>
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
   */
  async deleteUserComment(commentId) {
    if (!window.confirmDialog) {
      alert('Confirmation dialog unavailable. Please refresh the page.');
      return;
    }

    const confirmed = await window.confirmDialog.show({
      title: 'Delete Comment?',
      message: 'Are you sure you want to delete this comment? This action cannot be undone.',
      confirmText: 'Delete',
      confirmClass: 'btn-danger'
    });

    if (!confirmed) return;

    try {
      const response = await fetch(`/api/user-comment/${commentId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete comment');

      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (commentRow) {
        commentRow.remove();
        this.updateCommentCount();
      }
    } catch (error) {
      console.error('Error deleting comment:', error);
      alert('Failed to delete comment');
    }
  }

  /**
   * Clear all user comments
   */
  async clearAllUserComments() {
    const userComments = document.querySelectorAll('.user-comment-row');
    if (userComments.length === 0) return;

    if (!window.confirmDialog) {
      alert('Confirmation dialog unavailable. Please refresh the page.');
      return;
    }

    const confirmed = await window.confirmDialog.show({
      title: 'Clear All Comments?',
      message: `This will delete all ${userComments.length} user comment${userComments.length !== 1 ? 's' : ''} from this PR. This action cannot be undone.`,
      confirmText: 'Delete All',
      confirmClass: 'btn-danger'
    });

    if (!confirmed) return;

    try {
      const response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/user-comments`, {
        method: 'DELETE'
      });

      if (!response.ok) throw new Error('Failed to delete comments');

      userComments.forEach(row => row.remove());
      this.updateCommentCount();
    } catch (error) {
      console.error('Error clearing user comments:', error);
      alert('Failed to clear comments');
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

      // Display saved comments
      this.userComments.forEach(comment => {
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

      this.updateCommentCount();
    } catch (error) {
      console.error('Error loading user comments:', error);
    }
  }

  /**
   * Load AI suggestions from API
   */
  async loadAISuggestions() {
    if (!this.currentPR) return;

    try {
      const response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/ai-suggestions`);
      if (!response.ok) return;

      const data = await response.json();
      if (data.suggestions && data.suggestions.length > 0) {
        await this.displayAISuggestions(data.suggestions);
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
   */
  async dismissSuggestion(suggestionId) {
    try {
      const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed' })
      });

      if (!response.ok) throw new Error('Failed to dismiss suggestion');

      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
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
          const isCollapsed = div.classList.contains('collapsed');
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
      const container = document.getElementById('review-actions');
      if (container) {
        this.splitButton = new window.SplitButton(container, {
          onSubmit: () => this.openReviewModal(),
          onPreview: () => this.openPreviewModal(),
          onClear: () => this.clearAllUserComments()
        });
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
    const userComments = document.querySelectorAll('.user-comment-row').length;

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
    const toggleBtn = document.getElementById('sidebar-toggle');
    const collapsedBtn = document.getElementById('sidebar-toggle-collapsed');

    if (!sidebar || !toggleBtn || !collapsedBtn) return;

    const isCollapsed = localStorage.getItem('file-sidebar-collapsed') === 'true';
    if (isCollapsed) {
      sidebar.style.display = 'none';
      collapsedBtn.classList.add('visible');
    }

    toggleBtn.addEventListener('click', () => {
      sidebar.style.display = 'none';
      collapsedBtn.classList.add('visible');
      localStorage.setItem('file-sidebar-collapsed', 'true');
    });

    collapsedBtn.addEventListener('click', () => {
      sidebar.style.display = 'block';
      collapsedBtn.classList.remove('visible');
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
      const icon = this.currentTheme === 'light' ?
        `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-1.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0-10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Z"/></svg>` :
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
}

// Initialize PR manager when DOM is loaded
let prManager;
document.addEventListener('DOMContentLoaded', () => {
  prManager = new PRManager();
  // CRITICAL FIX: Make prManager available globally for component access
  window.prManager = prManager;
});
