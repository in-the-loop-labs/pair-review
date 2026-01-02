/**
 * Pull Request UI Management
 */
class PRManager {
  // Category to emoji mapping for adopted suggestions
  static CATEGORY_EMOJI_MAP = {
    'bug': '🐛',
    'performance': '⚡',
    'design': '📐',
    'code-style': '🧹',
    'improvement': '💡',
    'praise': '⭐',
    'security': '🔒',
    'suggestion': '💬'
  };

  // SVG icons for diff expansion controls (GitHub Octicons)
  static FOLD_UP_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M7.823 1.677 4.927 4.573A.25.25 0 0 0 5.104 5H7.25v3.236a.75.75 0 1 0 1.5 0V5h2.146a.25.25 0 0 0 .177-.427L8.177 1.677a.25.25 0 0 0-.354 0ZM13.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5Zm-3.75.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75ZM7.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5ZM4 11.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75ZM1.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5Z"/>
    </svg>
  `;

  static FOLD_DOWN_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="m8.177 14.323 2.896-2.896a.25.25 0 0 0-.177-.427H8.75V7.764a.75.75 0 1 0-1.5 0V11H5.104a.25.25 0 0 0-.177.427l2.896 2.896a.25.25 0 0 0 .354 0ZM2.25 5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 4.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75ZM8.25 5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 4.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z"/>
    </svg>
  `;

  // GitHub Octicons "unfold" icon - arrows pointing outward with dotted line between
  static UNFOLD_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="m8.177.677 2.896 2.896a.25.25 0 0 1-.177.427H8.75v1.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM7.25 10.75a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12H7.25v-1.25Zm-5-2a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z"/>
    </svg>
  `;

  // Keep old name as alias for backward compatibility
  static FOLD_UP_DOWN_ICON = PRManager.UNFOLD_ICON;

  /**
   * Generate a safe localStorage key for repository-specific settings
   * Uses base64 encoding to handle special characters in owner/repo names
   * @param {string} prefix - Key prefix (e.g., 'pair-review-model')
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {string} Safe localStorage key
   */
  static getRepoStorageKey(prefix, owner, repo) {
    // Use base64 encoding to safely handle any special characters
    const repoId = btoa(`${owner}/${repo}`).replace(/=/g, '');
    return `${prefix}:${repoId}`;
  }

  // Eye icon for showing hidden content (GitHub Octicons "eye")
  static EYE_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.824.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"/>
    </svg>
  `;

  // Eye-closed icon for hiding content (GitHub Octicons "eye-closed")
  static EYE_CLOSED_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M.143 2.31a.75.75 0 0 1 1.047-.167l14.5 10.5a.75.75 0 1 1-.88 1.214l-2.248-1.628C11.346 13.19 9.792 14 8 14c-1.981 0-3.67-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.797c.353-.533 1.063-1.502 2.063-2.487L.31 3.357A.75.75 0 0 1 .143 2.31Zm3.386 3.378a14.21 14.21 0 0 0-1.85 2.244.12.12 0 0 0 0 .136c.412.621 1.242 1.75 2.366 2.717C5.175 11.758 6.527 12.5 8 12.5c1.195 0 2.31-.488 3.29-1.191L9.063 9.695A2 2 0 0 1 6.058 7.52L3.529 5.688Zm6.728 4.873-1.676-1.214a.5.5 0 1 0 .798.59l.878.624ZM8 3.5c-.516 0-1.017.09-1.499.251a.75.75 0 0 1-.473-1.423A6.23 6.23 0 0 1 8 2c1.981 0 3.67.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.11.166-.248.365-.41.587a.75.75 0 1 1-1.21-.887c.148-.201.272-.382.371-.53a.119.119 0 0 0 0-.137c-.412-.621-1.242-1.75-2.366-2.717C10.825 4.242 9.473 3.5 8 3.5Z"/>
    </svg>
  `;

  // Logo icon - infinity loop rotated for "in-the-loop" branding
  static LOGO_ICON = `
    <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
      <path transform="rotate(-50 12 12)" d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.356-8-5.096 0-5.096 8 0 8 5.223 0 7.26-8 12.356-8z"/>
    </svg>
  `;

  // Generated file indicator icon (gear/cog icon)
  static GENERATED_FILE_ICON = `
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.585.52a2.678 2.678 0 0 0-3.17 0l-.928.68a1.178 1.178 0 0 1-.518.215L3.83 1.59a2.678 2.678 0 0 0-2.24 2.24l-.175 1.14a1.178 1.178 0 0 1-.215.518l-.68.928a2.678 2.678 0 0 0 0 3.17l.68.928c.113.153.186.33.215.518l.175 1.138a2.678 2.678 0 0 0 2.24 2.24l1.138.175c.187.029.365.102.518.215l.928.68a2.678 2.678 0 0 0 3.17 0l.928-.68a1.17 1.17 0 0 1 .518-.215l1.138-.175a2.678 2.678 0 0 0 2.241-2.241l.175-1.138c.029-.187.102-.365.215-.518l.68-.928a2.678 2.678 0 0 0 0-3.17l-.68-.928a1.179 1.179 0 0 1-.215-.518L14.41 3.83a2.678 2.678 0 0 0-2.24-2.24l-1.138-.175a1.179 1.179 0 0 1-.518-.215L9.585.52ZM7.303 1.728c.415-.305.979-.305 1.394 0l.928.68c.348.256.752.423 1.18.489l1.136.174c.51.078.909.478.987.987l.174 1.137c.066.427.233.831.489 1.18l.68.927c.305.415.305.98 0 1.394l-.68.928a2.678 2.678 0 0 0-.489 1.18l-.174 1.136a1.178 1.178 0 0 1-.987.987l-1.137.174a2.678 2.678 0 0 0-1.18.489l-.927.68c-.415.305-.98.305-1.394 0l-.928-.68a2.678 2.678 0 0 0-1.18-.489l-1.136-.174a1.178 1.178 0 0 1-.987-.987l-.174-1.137a2.678 2.678 0 0 0-.489-1.18l-.68-.927a1.178 1.178 0 0 1 0-1.394l.68-.928c.256-.348.423-.752.489-1.18l.174-1.136c.078-.51.478-.909.987-.987l1.137-.174a2.678 2.678 0 0 0 1.18-.489l.927-.68ZM8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4Z"/>
    </svg>
  `;

  // Default number of lines to expand when clicking up/down buttons
  static DEFAULT_EXPAND_LINES = 20;

  // Threshold for small gaps - show single "expand all" button instead of directional buttons
  static SMALL_GAP_THRESHOLD = 10;

  // Map of file extensions to highlight.js language names
  static LANGUAGE_MAP = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    // Web
    'html': 'html',
    'htm': 'html',
    'xml': 'xml',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    // Python
    'py': 'python',
    'pyw': 'python',
    // Ruby
    'rb': 'ruby',
    'erb': 'erb',
    // PHP
    'php': 'php',
    // Java/Kotlin/Scala
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'scala': 'scala',
    // C/C++
    'c': 'c',
    'h': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'hpp': 'cpp',
    'hh': 'cpp',
    // C#
    'cs': 'csharp',
    // Go
    'go': 'go',
    // Rust
    'rs': 'rust',
    // Swift
    'swift': 'swift',
    // Shell
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    // SQL
    'sql': 'sql',
    // JSON/YAML
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    // Markdown
    'md': 'markdown',
    'markdown': 'markdown',
    // Config files
    'toml': 'toml',
    'ini': 'ini',
    'conf': 'ini',
    // Docker
    'dockerfile': 'dockerfile',
    // Others
    'r': 'r',
    'lua': 'lua',
    'perl': 'perl',
    'pl': 'perl',
    'vim': 'vim'
  };

  /**
   * Detect language from file name for syntax highlighting
   * @param {string} fileName - The file name
   * @returns {string} The highlight.js language name
   */
  static detectLanguage(fileName) {
    if (!fileName) return 'plaintext';
    const extension = fileName.split('.').pop().toLowerCase();
    return PRManager.LANGUAGE_MAP[extension] || 'plaintext';
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
    // Line range selection state
    this.rangeSelectionStart = null;
    this.rangeSelectionEnd = null;
    this.isDraggingRange = false;
    this.dragStartLine = null;
    this.dragEndLine = null;
    this.potentialDragStart = null;
    // Level filter state - default to 'final' (orchestrated suggestions)
    this.selectedLevel = 'final';
    // Split button for comment actions
    this.splitButton = null;
    // Generated files - collapsed by default, stores map of filename -> generated info
    this.generatedFiles = new Map();
    this.expandedGeneratedFiles = new Set();
    // Analysis config modal
    this.analysisConfigModal = null;
    this.init();
    this.initTheme();
    this.initSuggestionNavigator();
    this.setupLevelChangeListener();
    this.initAnalysisConfigModal();
  }

  /**
   * Initialize PR manager
   */
  init() {
    // Setup delegated event handlers for comment forms
    this.setupCommentFormDelegation();

    // Check if we have PR context from URL path (e.g., /pr/owner/repo/number)
    const pathMatch = window.location.pathname.match(/^\/pr\/([^\/]+)\/([^\/]+)\/(\d+)$/);
    if (pathMatch) {
      const [, owner, repo, number] = pathMatch;
      this.loadPR(owner, repo, parseInt(number));
      return;
    }

    // Fallback: Check if we have PR context from URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const prParam = urlParams.get('pr');

    if (prParam) {
      // Parse PR parameter: owner/repo/number
      const prMatch = prParam.match(/^([^\/]+)\/([^\/]+)\/(\d+)$/);
      if (prMatch) {
        const [, owner, repo, number] = prMatch;
        this.loadPR(owner, repo, parseInt(number));
      } else {
        this.showError('Invalid PR format in URL parameter');
      }
    }
  }

  /**
   * Setup delegated event handler for comment form keyboard shortcuts.
   * Uses event delegation on #diff-container to avoid memory leaks from
   * attaching listeners directly to dynamically created textareas.
   */
  setupCommentFormDelegation() {
    const diffContainer = document.getElementById('diff-container');
    if (!diffContainer) {
      // Will be set up when diff container is available
      return;
    }

    diffContainer.addEventListener('keydown', (e) => {
      const target = e.target;

      // Handle new comment form textarea (.comment-textarea)
      if (target.classList.contains('comment-textarea')) {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.hideCommentForm();
          this.clearRangeSelection();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const formRow = target.closest('.comment-form-row');
          if (formRow) {
            this.saveUserComment(target, formRow);
          }
        }
        return;
      }

      // Handle edit comment textarea (.comment-edit-textarea)
      if (target.classList.contains('comment-edit-textarea')) {
        // Extract comment ID from the textarea id (format: edit-comment-{id})
        const textareaId = target.id;
        const match = textareaId.match(/^edit-comment-(.+)$/);
        if (match) {
          const commentId = match[1];
          if (e.key === 'Escape') {
            e.preventDefault();
            this.cancelEditUserComment(commentId);
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this.saveEditedUserComment(commentId);
          }
        }
        return;
      }
    });
  }

  /**
   * Setup listener for level changes from SuggestionNavigator
   */
  setupLevelChangeListener() {
    document.addEventListener('levelChanged', async (e) => {
      const newLevel = e.detail.level;
      console.log(`Level changed to: ${newLevel}`);
      this.selectedLevel = newLevel;
      await this.loadAISuggestions();
    });
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
          // No settings for this repo, that's fine
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
   * Load pull request data
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   */
  async loadPR(owner, repo, number) {
    if (this.loadingState) {
      return;
    }

    // Hide welcome section when loading a PR
    const welcomeSection = document.getElementById('welcome-section');
    if (welcomeSection) {
      welcomeSection.style.display = 'none';
    }

    try {
      this.showLoadingState();
      
      // Fetch PR data from API
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Pull request #${number} not found in repository ${owner}/${repo}`);
        } else if (response.status >= 500) {
          throw new Error('Server error. Please try again later.');
        } else {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to load pull request');
        }
      }

      const data = await response.json();
      
      // Handle new API format with success field
      if (data.success && data.data) {
        this.currentPR = data.data;
        // Display PR information with proper structure
        this.displayPR({ pr: data.data });
      } else {
        // Fallback for old format
        this.currentPR = data.pr;
        this.displayPR(data);
      }

      // Check if analysis is running after successful PR display
      await this.checkRunningAnalysis();
      
    } catch (error) {
      console.error('Error loading PR:', error);
      this.showError(error.message);
    } finally {
      this.hideLoadingState();
    }
  }

  /**
   * Refresh pull request data
   */
  async refreshPR() {
    if (!this.currentPR) {
      console.error('No PR loaded to refresh');
      return;
    }

    const refreshButton = document.getElementById('refresh-pr');
    if (!refreshButton) {
      return;
    }

    try {
      // Show spinner on button
      refreshButton.classList.add('refreshing');
      refreshButton.disabled = true;

      // Show loading state in diff container
      const diffContainer = document.getElementById('diff-container');
      if (diffContainer) {
        diffContainer.innerHTML = '<div class="loading">Refreshing pull request...</div>';
      }

      const { owner, repo, number } = this.currentPR;

      // Call refresh API endpoint
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

        // Update header with new PR data (includes commit SHA)
        this.updateHeader(this.currentPR);

        // Just reload the files/diff without re-rendering the whole page
        await this.loadAndDisplayFiles();

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
      const diffContainer = document.getElementById('diff-container');
      if (diffContainer) {
        diffContainer.innerHTML = `<div class="loading">Failed to refresh: ${error.message}</div>`;
      }
    } finally {
      // Hide spinner
      const btn = document.getElementById('refresh-pr');
      if (btn) {
        btn.classList.remove('refreshing');
        btn.disabled = false;
      }
    }
  }

  /**
   * Show loading state
   */
  showLoadingState() {
    this.loadingState = true;
    
    // Show loading in the main content area if it exists, otherwise in pr-container
    const mainContent = document.querySelector('.main-content');
    const diffContainer = document.getElementById('diff-container');
    
    if (diffContainer) {
      // If diff container exists, show loading there
      diffContainer.innerHTML = '<div class="loading">Fetching pull request...</div>';
    } else if (mainContent) {
      // If main content exists but no diff container, create loading in main content
      mainContent.innerHTML = `
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <div class="loading-text">Fetching pull request...</div>
        </div>
      `;
    } else {
      // Fallback: show loading in pr-container (initial load)
      const container = document.getElementById('pr-container');
      if (container) {
        container.innerHTML = `
          <div class="loading-container">
            <div class="loading-spinner"></div>
            <div class="loading-text">Fetching pull request...</div>
          </div>
        `;
        container.style.display = 'flex';
      }
    }
  }

  /**
   * Hide loading state
   */
  hideLoadingState() {
    this.loadingState = false;
  }

  /**
   * Display pull request information
   * @param {Object} data - PR data from API
   */
  displayPR(data) {
    const container = document.getElementById('pr-container');
    if (!container) return;

    const pr = data.pr || data;

    // Update the new header elements
    this.updateHeader(pr);

    // Wire up event handlers for the new layout
    this.initializeLayoutEvents();

    // Load files and display them in sidebar and main content
    this.loadAndDisplayFiles();
    
    // Ensure status indicator is properly positioned in the header
    setTimeout(() => {
      if (window.statusIndicator) {
        window.statusIndicator.repositionInHeader();
      }
    }, 100);
    
    // Check if there are existing AI suggestions and load them
    setTimeout(async () => {
      console.log('[UI] Checking for existing AI suggestions...');
      await this.loadAISuggestions();
    }, 1500);
    
    // Initialize review modal (but don't show it)
    if (!this.reviewModal) {
      this.reviewModal = new ReviewModal();
    }

    // Initialize split button for comment actions
    this.initializeSplitButton();

    container.style.display = 'block';
  }

  /**
   * Update the redesigned header with PR information
   * @param {Object} pr - PR data
   */
  updateHeader(pr) {
    // Parse owner/repo from base_repo or html_url
    let owner = '--';
    let repo = '--';

    if (pr.base_repo) {
      const parts = pr.base_repo.split('/');
      if (parts.length === 2) {
        owner = parts[0];
        repo = parts[1];
      }
    } else if (pr.html_url) {
      const match = pr.html_url.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (match) {
        owner = match[1];
        repo = match[2];
      }
    }

    // Update breadcrumb
    const breadcrumbOrg = document.querySelector('.breadcrumb-org');
    const breadcrumbRepo = document.querySelector('.breadcrumb-repo');
    const breadcrumbPr = document.querySelector('.breadcrumb-pr');
    if (breadcrumbOrg) breadcrumbOrg.textContent = owner;
    if (breadcrumbRepo) breadcrumbRepo.textContent = repo;
    if (breadcrumbPr) breadcrumbPr.textContent = `#${pr.number}`;

    // Update title
    const titleEl = document.getElementById('pr-title-text');
    if (titleEl) {
      titleEl.textContent = pr.title || 'Pull Request';
    }

    // Update branch
    const branchName = document.getElementById('pr-branch-name');
    if (branchName) {
      branchName.textContent = pr.head_ref || pr.head_branch || '--';
    }

    // Update stats
    const additions = document.getElementById('pr-additions');
    const deletions = document.getElementById('pr-deletions');
    const filesCount = document.getElementById('pr-files-count');

    if (additions) additions.textContent = `+${pr.additions || 0}`;
    if (deletions) deletions.textContent = `-${pr.deletions || 0}`;
    if (filesCount) filesCount.textContent = `${pr.file_changes || 0} files`;

    // Update commit SHA
    const commitSha = document.getElementById('pr-commit-sha');
    const commitContainer = document.getElementById('pr-commit');
    if (commitSha && pr.head_sha) {
      // Display short SHA (7 characters, like GitHub)
      commitSha.textContent = pr.head_sha.substring(0, 7);
      // Store full SHA for copying
      if (commitContainer) {
        commitContainer.dataset.fullSha = pr.head_sha;
      }
    }

    // Update GitHub link
    const githubLink = document.getElementById('github-link');
    if (githubLink && pr.html_url) {
      githubLink.href = pr.html_url;
    }

    // Add or update settings link
    this.updateSettingsLink(owner, repo);

    // Update sidebar file count
    const sidebarCount = document.getElementById('sidebar-file-count');
    if (sidebarCount) {
      sidebarCount.textContent = pr.file_changes || '0';
    }
  }

  /**
   * Add or update the repository settings link in the header
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   */
  updateSettingsLink(owner, repo) {
    const githubLink = document.getElementById('github-link');
    if (!githubLink || owner === '--' || repo === '--') {
      return;
    }

    // Check if settings link already exists
    let settingsLink = document.getElementById('settings-link');

    if (!settingsLink) {
      // Create the settings link element
      settingsLink = document.createElement('a');
      settingsLink.id = 'settings-link';
      settingsLink.className = 'btn btn-icon settings-link';
      settingsLink.title = 'Repository Settings';
      settingsLink.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M7.429 1.525a6.593 6.593 0 011.142 0c.036.003.108.036.137.146l.289 1.105c.147.56.55.967.997 1.189.174.086.341.183.501.29.417.278.97.423 1.53.27l1.102-.303c.11-.03.175.016.195.046.219.31.41.641.573.989.014.031.022.11-.059.19l-.815.806c-.411.406-.562.957-.53 1.456a4.588 4.588 0 010 .582c-.032.499.119 1.05.53 1.456l.815.806c.08.08.073.159.059.19a6.494 6.494 0 01-.573.99c-.02.029-.086.074-.195.045l-1.103-.303c-.559-.153-1.112-.008-1.529.27-.16.107-.327.204-.5.29-.449.222-.851.628-.998 1.189l-.289 1.105c-.029.11-.101.143-.137.146a6.613 6.613 0 01-1.142 0c-.036-.003-.108-.037-.137-.146l-.289-1.105c-.147-.56-.55-.967-.997-1.189a4.502 4.502 0 01-.501-.29c-.417-.278-.97-.423-1.53-.27l-1.102.303c-.11.03-.175-.016-.195-.046a6.492 6.492 0 01-.573-.989c-.014-.031-.022-.11.059-.19l.815-.806c.411-.406.562-.957.53-1.456a4.587 4.587 0 010-.582c.032-.499-.119-1.05-.53-1.456l-.815-.806c-.08-.08-.073-.159-.059-.19a6.44 6.44 0 01.573-.99c.02-.029.086-.074.195-.045l1.103.303c.559.153 1.112.008 1.529-.27.16-.107.327-.204.5-.29.449-.222.851-.628.998-1.189l.289-1.105c.029-.11.101-.143.137-.146zM8 0c-.236 0-.47.01-.701.03-.743.065-1.29.615-1.458 1.261l-.29 1.106c-.017.066-.078.158-.211.224a5.994 5.994 0 00-.668.386c-.123.082-.233.09-.3.071L3.27 2.776c-.644-.177-1.392.02-1.82.63a7.977 7.977 0 00-.704 1.217c-.315.675-.111 1.422.363 1.891l.815.806c.05.048.098.147.088.294a6.084 6.084 0 000 .772c.01.147-.038.246-.088.294l-.815.806c-.474.469-.678 1.216-.363 1.891.2.428.436.835.704 1.218.428.609 1.176.806 1.82.63l1.103-.303c.066-.019.176-.011.299.071.213.143.436.272.668.386.133.066.194.158.212.224l.289 1.106c.169.646.715 1.196 1.458 1.26a8.094 8.094 0 001.402 0c.743-.064 1.29-.614 1.458-1.26l.29-1.106c.017-.066.078-.158.211-.224a5.98 5.98 0 00.668-.386c.123-.082.233-.09.3-.071l1.102.302c.644.177 1.392-.02 1.82-.63.268-.382.505-.789.704-1.217.315-.675.111-1.422-.364-1.891l-.814-.806c-.05-.048-.098-.147-.088-.294a6.1 6.1 0 000-.772c-.01-.147.039-.246.088-.294l.814-.806c.475-.469.679-1.216.364-1.891a7.992 7.992 0 00-.704-1.218c-.428-.609-1.176-.806-1.82-.63l-1.103.303c-.066.019-.176.011-.299-.071a5.991 5.991 0 00-.668-.386c-.133-.066-.194-.158-.212-.224L10.16 1.29C9.99.645 9.444.095 8.701.031A8.094 8.094 0 008 0zm1.5 8a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM11 8a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
      `;

      // Insert before the GitHub link
      githubLink.parentNode.insertBefore(settingsLink, githubLink);
    }

    // Update the href
    settingsLink.href = `/settings/${owner}/${repo}`;
  }

  /**
   * Initialize event handlers for the new layout
   */
  initializeLayoutEvents() {
    // Theme toggle
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle && !themeToggle._eventBound) {
      themeToggle.addEventListener('click', () => this.toggleTheme());
      themeToggle._eventBound = true;
    }

    // Analyze button in toolbar
    const analyzeBtn = document.getElementById('analyze-btn');
    if (analyzeBtn && !analyzeBtn._eventBound) {
      analyzeBtn.addEventListener('click', () => this.triggerAIAnalysis());
      analyzeBtn._eventBound = true;
    }

    // Refresh PR button
    const refreshBtn = document.getElementById('refresh-pr');
    if (refreshBtn && !refreshBtn._eventBound) {
      refreshBtn.addEventListener('click', () => this.refreshPR());
      refreshBtn._eventBound = true;
    }

    // Commit SHA copy button
    const commitCopyBtn = document.getElementById('pr-commit-copy');
    const commitContainer = document.getElementById('pr-commit');
    if (commitCopyBtn && commitContainer && !commitCopyBtn._eventBound) {
      commitCopyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fullSha = commitContainer.dataset.fullSha;
        if (!fullSha) {
          window.toast.showError('Commit SHA not available yet');
          return;
        }
        try {
          await navigator.clipboard.writeText(fullSha);
          window.toast.showSuccess('Commit SHA copied to clipboard');
        } catch (err) {
          console.error('Failed to copy SHA:', err);
          window.toast.showError('Failed to copy SHA');
        }
      });
      commitCopyBtn._eventBound = true;
    }

    // AI Panel toggle
    const aiPanelToggle = document.getElementById('ai-panel-toggle');
    const aiPanel = document.getElementById('ai-panel');
    const aiPanelClose = document.getElementById('ai-panel-close');

    if (aiPanelToggle && aiPanel && !aiPanelToggle._eventBound) {
      aiPanelToggle.addEventListener('click', () => {
        aiPanel.classList.toggle('collapsed');
        this.savePanelStates();
      });
      aiPanelToggle._eventBound = true;
    }

    if (aiPanelClose && aiPanel && !aiPanelClose._eventBound) {
      aiPanelClose.addEventListener('click', () => {
        aiPanel.classList.add('collapsed');
        this.savePanelStates();
      });
      aiPanelClose._eventBound = true;
    }

    // Sidebar collapse/expand
    const sidebar = document.getElementById('files-sidebar');
    const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
    const sidebarExpandBtn = document.getElementById('sidebar-toggle-collapsed');

    // Collapse button in sidebar header
    if (sidebarCollapseBtn && sidebar && !sidebarCollapseBtn._eventBound) {
      sidebarCollapseBtn.addEventListener('click', () => {
        sidebar.classList.add('collapsed');
        this.savePanelStates();
      });
      sidebarCollapseBtn._eventBound = true;
    }

    // Expand button in diff toolbar
    if (sidebarExpandBtn && sidebar && !sidebarExpandBtn._eventBound) {
      sidebarExpandBtn.addEventListener('click', () => {
        sidebar.classList.remove('collapsed');
        this.savePanelStates();
      });
      sidebarExpandBtn._eventBound = true;
    }

    // Restore panel states from localStorage
    this.restorePanelStates();
  }

  /**
   * Create state badge HTML
   * @param {string} state - PR state (open, closed, merged)
   * @returns {string} HTML for state badge
   */
  createStateBadge(state) {
    const stateClass = state === 'open' ? 'state-open' : 
                     state === 'merged' ? 'state-merged' : 'state-closed';
    
    return `<span class="pr-state ${stateClass}">${state}</span>`;
  }

  /**
   * Create stats display HTML
   * @param {Object} pr - PR data
   * @returns {string} HTML for stats display
   */
  createStatsDisplay(pr) {
    if (!pr.additions && !pr.deletions && !pr.file_changes) {
      return '';
    }

    return `
      <div class="pr-stats">
        ${pr.file_changes ? `<span class="stat-item">${pr.file_changes} changed files</span>` : ''}
        ${pr.additions ? `<span class="stat-item additions">+${pr.additions}</span>` : ''}
        ${pr.deletions ? `<span class="stat-item deletions">-${pr.deletions}</span>` : ''}
      </div>
    `;
  }

  /**
   * Initialize the split button for comment actions
   */
  async initializeSplitButton() {
    const placeholder = document.getElementById('split-button-placeholder');
    if (!placeholder) {
      console.warn('[UI] Split button placeholder not found');
      return;
    }

    // Fetch user config to get default action preference
    let defaultAction = 'submit';
    try {
      const response = await fetch('/api/config');
      if (response.ok) {
        const config = await response.json();
        defaultAction = config.comment_button_action || 'submit';
      }
    } catch (error) {
      console.warn('[UI] Could not fetch config, using default action:', error);
    }

    // Create split button instance
    this.splitButton = new SplitButton({
      defaultAction: defaultAction,
      onSubmit: () => this.openReviewModal(),
      onPreview: () => this.openPreviewModal(),
      onClear: () => this.clearAllUserComments(),
      onSetDefault: async (action) => {
        // Save default action preference to config
        try {
          await fetch('/api/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comment_button_action: action })
          });
        } catch (error) {
          console.warn('[UI] Could not save config preference:', error);
        }
      }
    });

    // Render and insert into placeholder
    const buttonElement = this.splitButton.render();
    placeholder.replaceWith(buttonElement);

    console.log('[UI] Split button initialized with default action:', defaultAction);
  }


  /**
   * Load and display files in sidebar and diff view
   */
  async loadAndDisplayFiles() {
    if (!this.currentPR) return;

    try {
      const owner = this.currentPR.owner || this.currentPR.repository?.split('/')[0];
      const repo = this.currentPR.repo || this.currentPR.repository?.split('/')[1];
      const response = await fetch(`/api/pr/${owner}/${repo}/${this.currentPR.number}/diff`);

      if (response.ok) {
        const data = await response.json();
        const files = data.changed_files || [];

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

        // Update sidebar with file tree
        this.updateFileList(files);

        // Update diff stats
        this.updateDiffStats(files);

        // Update theme icon after rendering new content
        this.updateThemeIcon();

        // Display diff in main content
        this.displayDiff(data.diff || '');

        // Load user comments after displaying diff
        await this.loadUserComments();

      } else {
        const diffContainer = document.getElementById('diff-container');
        if (diffContainer) {
          diffContainer.innerHTML = '<div class="loading">Failed to load changes</div>';
        }
      }
    } catch (error) {
      const diffContainer = document.getElementById('diff-container');
      if (diffContainer) {
        diffContainer.innerHTML = '<div class="loading">Error loading changes</div>';
      }
    }
  }
  
  /**
   * Update diff stats display
   * @param {Array} files - Changed files data
   */
  updateDiffStats(files) {
    const statsEl = document.getElementById('diff-stats');
    if (!statsEl || !files) return;
    
    const totalAdditions = files.reduce((sum, file) => sum + (file.insertions || 0), 0);
    const totalDeletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0);
    
    statsEl.innerHTML = `
      <span class="stat-item">${files.length} changed files</span>
      ${totalAdditions > 0 ? `<span class="stat-item additions">+${totalAdditions}</span>` : ''}
      ${totalDeletions > 0 ? `<span class="stat-item deletions">-${totalDeletions}</span>` : ''}
    `;
  }


  /**
   * Display diff content using diff2html rendering
   * @param {string} diff - Unified diff content
   */
  displayDiff(diffText) {
    console.log('displayDiff called with:', { hasDiff: !!diffText });
    const container = document.getElementById('diff-container');
    container.innerHTML = '';

    if (!diffText) {
      container.innerHTML = '<div class="loading">No diff available</div>';
      return;
    }

    // Check if diff2html is available
    if (typeof Diff2Html === 'undefined') {
      console.error('Diff2Html library not loaded!');
      container.innerHTML = '<div class="loading">Error: Diff2Html library not loaded</div>';
      return;
    }

    // Use diff2html to parse the diff
    const diffJson = Diff2Html.parse(diffText);
    console.log('Parsed diff files:', diffJson.length, diffJson);

    // Create our own simple unified diff display
    container.innerHTML = '';

    try {
      diffJson.forEach(file => {
        const filePath = file.newName || file.oldName;
        const isGenerated = this.generatedFiles.has(filePath);
        const isExpanded = this.expandedGeneratedFiles.has(filePath);

        // Track diff position per file (resets for each file, matches GitHub behavior)
        let fileDiffPosition = 0;
        let foundFirstHunk = false;
        const fileWrapper = document.createElement('div');
        fileWrapper.className = 'd2h-file-wrapper';
        if (isGenerated) {
          fileWrapper.classList.add('generated-file');
          if (!isExpanded) {
            fileWrapper.classList.add('collapsed');
          }
        }
        fileWrapper.dataset.fileName = filePath;
        fileWrapper.setAttribute('data-file-name', filePath);

        // File header
        const fileHeader = document.createElement('div');
        fileHeader.className = 'd2h-file-header';

        // Add generated badge and expand/collapse toggle if this is a generated file
        if (isGenerated) {
          const generatedInfo = this.generatedFiles.get(filePath);

          // Create toggle button with eye icon
          const toggleBtn = document.createElement('button');
          toggleBtn.className = 'generated-toggle';
          toggleBtn.title = isExpanded ? 'Hide generated file diff' : 'Show generated file diff';
          toggleBtn.innerHTML = isExpanded ? PRManager.EYE_CLOSED_ICON : PRManager.EYE_ICON;
          toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleGeneratedFile(filePath);
          });
          fileHeader.appendChild(toggleBtn);

          // Add generated badge
          const badge = document.createElement('span');
          badge.className = 'generated-badge';
          badge.textContent = 'Generated file';
          badge.title = 'This file is marked as generated in .gitattributes';
          fileHeader.appendChild(badge);

          // Add stats summary for collapsed view (colored like other diff stats)
          const statsSummary = document.createElement('span');
          statsSummary.className = 'generated-stats';
          statsSummary.innerHTML = `<span class="additions">+${generatedInfo.insertions}</span> <span class="deletions">-${generatedInfo.deletions}</span>`;
          fileHeader.appendChild(statsSummary);
        }

        const fileName = document.createElement('span');
        fileName.className = 'd2h-file-name';
        fileName.textContent = filePath;
        fileHeader.appendChild(fileName);

        fileWrapper.appendChild(fileHeader);

        // Create simple table for diff
        const table = document.createElement('table');
        table.className = 'd2h-diff-table';
        const tbody = document.createElement('tbody');
        tbody.className = 'd2h-diff-tbody';

        // Add file class for styling new files
        if (file.isNew) {
          fileWrapper.classList.add('d2h-file-addition');
        }

        // Process blocks with context expansion
        file.blocks.forEach((block, blockIndex) => {
          // Add block header
          const headerRow = document.createElement('tr');
          headerRow.className = 'd2h-info';
          headerRow.innerHTML = `<td colspan="2" class="d2h-info">${block.header}</td>`;
          tbody.appendChild(headerRow);

          // Reset position counter for the first hunk in the file only
          if (!foundFirstHunk) {
            fileDiffPosition = 0;
            foundFirstHunk = true;
          } else {
            // Subsequent block headers (@@) count as positions according to GitHub spec
            fileDiffPosition++;
          }

          // Add expandable context at the beginning of first block if not starting at line 1
          if (blockIndex === 0 && block.lines.length > 0 && (block.lines[0].oldNumber > 1 || block.lines[0].newNumber > 1)) {
            const startLine = Math.min(block.lines[0].oldNumber || 1, block.lines[0].newNumber || 1);
            if (startLine > 1) {
              this.createGapSection(tbody, filePath, 1, startLine - 1, startLine - 1, 'above');
            }
          }

          // Process lines within block and track positions
          block.lines.forEach((line) => {
            fileDiffPosition++; // Increment position for each diff line within this file
            this.renderDiffLine(tbody, line, filePath, fileDiffPosition);
          });

          // Add expandable context between blocks
          if (blockIndex < file.blocks.length - 1) {
            const nextBlock = file.blocks[blockIndex + 1];
            const currentLastLine = block.lines[block.lines.length - 1];
            const nextFirstLine = nextBlock.lines[0];

            if (currentLastLine && nextFirstLine) {
              const currentEnd = Math.max(currentLastLine.oldNumber || 0, currentLastLine.newNumber || 0);
              const nextStart = Math.min(nextFirstLine.oldNumber || Infinity, nextFirstLine.newNumber || Infinity);

              if (nextStart - currentEnd > 1) {
                this.createGapSection(tbody, filePath, currentEnd + 1, nextStart - 1, nextStart - currentEnd - 1, 'between');
              }
            }
          }
        });

        table.appendChild(tbody);
        fileWrapper.appendChild(table);
        container.appendChild(fileWrapper);
      });
    } catch (error) {
      console.error('Error rendering diff:', error);
      container.innerHTML = '<div class="loading">Error rendering diff</div>';
    }
  }

  /**
   * Toggle expansion of a generated file's diff content
   * @param {string} filePath - Path of the file to toggle
   */
  toggleGeneratedFile(filePath) {
    const fileWrapper = document.querySelector(`[data-file-name="${filePath}"]`);
    if (!fileWrapper) return;

    const isCurrentlyExpanded = this.expandedGeneratedFiles.has(filePath);

    if (isCurrentlyExpanded) {
      // Collapse
      this.expandedGeneratedFiles.delete(filePath);
      fileWrapper.classList.add('collapsed');
    } else {
      // Expand
      this.expandedGeneratedFiles.add(filePath);
      fileWrapper.classList.remove('collapsed');
    }

    // Update toggle button icon
    const toggleBtn = fileWrapper.querySelector('.generated-toggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = isCurrentlyExpanded ? PRManager.EYE_ICON : PRManager.EYE_CLOSED_ICON;
      toggleBtn.title = isCurrentlyExpanded ? 'Show generated file diff' : 'Hide generated file diff';
    }
  }

  /**
   * Render a single diff line
   * @param {HTMLElement} tbody - Table body element
   * @param {Object} line - Diff line data
   * @param {string} fileName - The file name for this diff
   * @param {number} diffPosition - The diff position for GitHub API
   */
  renderDiffLine(tbody, line, fileName, diffPosition) {
    const row = document.createElement('tr');
    row.className = line.type === 'insert' ? 'd2h-ins' : 
                   line.type === 'delete' ? 'd2h-del' : 
                   'd2h-cntx';
    
    // Add data attributes for comment functionality
    // Track side (LEFT for deleted lines, RIGHT for added/context lines) for GitHub API
    if (line.type === 'delete') {
      // Deleted lines: use oldNumber and LEFT side
      row.dataset.lineNumber = line.oldNumber;
      row.dataset.oldLineNumber = line.oldNumber;
      row.dataset.side = 'LEFT';
      row.dataset.fileName = fileName;
      if (diffPosition !== undefined) {
        row.dataset.diffPosition = diffPosition;
      }
    } else if (line.newNumber) {
      // Added/context lines: use newNumber and RIGHT side
      row.dataset.lineNumber = line.newNumber;
      row.dataset.newLineNumber = line.newNumber;
      row.dataset.side = 'RIGHT';
      row.dataset.fileName = fileName;
      if (diffPosition !== undefined) {
        row.dataset.diffPosition = diffPosition;
      }
    }
    
    // Line numbers
    const lineNumCell = document.createElement('td');
    lineNumCell.className = 'd2h-code-linenumber';
    
    // Add comment button container to line number cell
    const lineNumContent = document.createElement('div');
    lineNumContent.className = 'line-number-content';
    lineNumContent.innerHTML = `<span class="line-num1">${line.oldNumber || ''}</span><span class="line-num2">${line.newNumber || ''}</span>`;
    
    // Add comment button for all line types (insert, context, delete)
    // Use newNumber for insert/context, oldNumber for delete
    const lineNumber = line.newNumber || line.oldNumber;
    if (lineNumber) {
      const commentButton = document.createElement('button');
      commentButton.className = 'add-comment-btn';
      commentButton.innerHTML = '+';

      // Lines without diff_position (expanded context) may not be submittable to GitHub
      // GitHub's position-based API only works for lines in the original diff
      const hasDiffPosition = diffPosition !== undefined && diffPosition !== null;
      if (!hasDiffPosition) {
        console.log('[DEBUG] No diffPosition for line:', lineNumber, 'in', fileName, 'type:', line.type, 'diffPosition:', diffPosition);
      }
      if (hasDiffPosition) {
        commentButton.title = 'Add comment (drag to select range)';
      } else {
        commentButton.title = 'Add comment (expanded context - may not submit to GitHub)';
        commentButton.classList.add('expanded-context-comment');
      }

      let dragStarted = false;
      let mouseDownTime = 0;

      // Track mousedown
      commentButton.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragStarted = false;
        mouseDownTime = Date.now();

        // Only start drag selection on mousemove, not on mousedown
        // Track side for GitHub API (LEFT for deleted lines, RIGHT for added/context)
        const side = line.type === 'delete' ? 'LEFT' : 'RIGHT';
        this.potentialDragStart = {
          row: row,
          lineNumber: lineNumber,
          fileName: fileName,
          button: commentButton,
          isDeletedLine: line.type === 'delete',
          side: side
        };
      };

      // Handle click (mouseup on same element without drag)
      commentButton.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const diffPos = row.dataset.diffPosition;
        const side = row.dataset.side || 'RIGHT';

        // If we have a completed drag selection, use it
        if (this.rangeSelectionStart?.lineNumber && this.rangeSelectionEnd?.lineNumber &&
            this.rangeSelectionStart.lineNumber !== this.rangeSelectionEnd.lineNumber) {
          const minLine = Math.min(this.rangeSelectionStart.lineNumber, this.rangeSelectionEnd.lineNumber);
          const maxLine = Math.max(this.rangeSelectionStart.lineNumber, this.rangeSelectionEnd.lineNumber);
          // Use the side from the range selection if available
          const rangeSide = this.rangeSelectionStart.side || side;
          this.showCommentForm(row, minLine, fileName, diffPos, maxLine, rangeSide);
        } else {
          // Single line comment (clear any single-line selection first)
          this.clearRangeSelection();
          this.showCommentForm(row, lineNumber, fileName, diffPos, null, side);
        }

        this.potentialDragStart = null;
      };

      lineNumContent.appendChild(commentButton);
    }

    // Add mouseover handler to rows for drag selection (all line types with a line number)
    if (lineNumber) {
      row.style.userSelect = 'none';

      // Track drag on mouseover the entire row
      row.onmouseover = (e) => {
        // Start drag if we have a potential drag and mouse moved to different row
        if (this.potentialDragStart && !this.isDraggingRange &&
            this.potentialDragStart.lineNumber !== lineNumber) {
          this.startDragSelection(
            this.potentialDragStart.row,
            this.potentialDragStart.lineNumber,
            this.potentialDragStart.fileName,
            this.potentialDragStart.side
          );
          this.potentialDragStart = null;
        }

        if (this.isDraggingRange) {
          e.preventDefault();
          this.updateDragSelection(row, lineNumber, fileName);
        }
      };

      // End drag on mouseup anywhere on the row
      row.onmouseup = (e) => {
        if (this.isDraggingRange) {
          e.preventDefault();
          const diffPos = row.dataset.diffPosition;
          this.completeDragSelection(row, lineNumber, fileName);

          // Show comment form after completing drag
          if (this.rangeSelectionStart && this.rangeSelectionEnd) {
            const minLine = Math.min(this.rangeSelectionStart.lineNumber, this.rangeSelectionEnd.lineNumber);
            const maxLine = Math.max(this.rangeSelectionStart.lineNumber, this.rangeSelectionEnd.lineNumber);
            // Use the side from the range selection start
            const side = this.rangeSelectionStart.side || 'RIGHT';
            this.showCommentForm(row, minLine, fileName, diffPos, maxLine, side);
          }
        }
      };
    }
    
    lineNumCell.appendChild(lineNumContent);
    
    // Content - remove ONLY the first +/- prefix from the raw diff, preserve all other whitespace
    const contentCell = document.createElement('td');
    contentCell.className = 'd2h-code-line-ctn';
    let content = line.content || '';
    // Strip only the first character if it's a diff marker (+, -, or space)
    // This preserves the actual indentation of the code
    if (content.length > 0 && (content[0] === '+' || content[0] === '-' || content[0] === ' ')) {
      content = content.substring(1);
    }

    // Apply syntax highlighting if highlight.js is available
    if (window.hljs && fileName) {
      try {
        const language = PRManager.detectLanguage(fileName);
        const highlighted = hljs.highlight(content, { language, ignoreIllegals: true });
        contentCell.innerHTML = highlighted.value;
      } catch (e) {
        // If highlighting fails, fall back to plain text
        console.warn('Syntax highlighting failed:', e);
        contentCell.textContent = content;
      }
    } else {
      contentCell.textContent = content;
    }
    
    row.appendChild(lineNumCell);
    row.appendChild(contentCell);
    tbody.appendChild(row);
    return row;
  }

  /**
   * Create gap section for expandable context between diff blocks
   * @param {HTMLElement} tbody - Table body element
   * @param {string} fileName - File name
   * @param {number} startLine - Start line number
   * @param {number} endLine - End line number
   * @param {number} gapSize - Number of hidden lines
   * @param {string} position - Position ('above', 'below', or 'between')
   */
  createGapSection(tbody, fileName, startLine, endLine, gapSize, position = 'between') {
    // Create a row for the gap between diff blocks
    const row = document.createElement('tr');
    row.className = 'context-expand-row';
    
    // Create separate cells for old and new line numbers
    const oldLineCell = document.createElement('td');
    oldLineCell.className = 'diff-line-num';
    oldLineCell.style.padding = '0';
    oldLineCell.style.textAlign = 'center';
    
    const newLineCell = document.createElement('td');
    newLineCell.className = 'diff-line-num';
    newLineCell.style.padding = '0';
    newLineCell.style.textAlign = 'center';
    
    // Put expand buttons in the first line number cell
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'expand-button-container';
    
    // Create expand controls container for metadata
    const expandControls = document.createElement('div');
    expandControls.className = 'context-expand-controls';
    
    // Store metadata for expansion
    expandControls.dataset.fileName = fileName;
    expandControls.dataset.startLine = startLine;
    expandControls.dataset.endLine = endLine;
    expandControls.dataset.hiddenCount = gapSize;
    expandControls.dataset.position = position;
    expandControls.dataset.isGap = 'true'; // Mark this as a gap section
    
    // Create the expand buttons with GitHub Octicons
    // For short sections (≤SMALL_GAP_THRESHOLD lines) or single-direction, show single button
    // For larger sections with both directions, show stacked buttons
    if (gapSize <= PRManager.SMALL_GAP_THRESHOLD || position !== 'between') {
      // Single button - either fold-up, fold-down, or fold-up-down
      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-button expand-all-short';

      if (position === 'above') {
        // At top - expand up to reveal lines above first visible line
        expandBtn.title = 'Expand up';
        expandBtn.innerHTML = PRManager.FOLD_UP_ICON;
        expandBtn.addEventListener('click', () => this.expandGapContext(expandControls, 'up', PRManager.DEFAULT_EXPAND_LINES));
      } else if (position === 'below') {
        // At bottom - expand down to reveal lines below last visible line
        expandBtn.title = 'Expand down';
        expandBtn.innerHTML = PRManager.FOLD_DOWN_ICON;
        expandBtn.addEventListener('click', () => this.expandGapContext(expandControls, 'down', PRManager.DEFAULT_EXPAND_LINES));
      } else {
        // Between - short section, expand all
        expandBtn.title = 'Expand all';
        expandBtn.innerHTML = PRManager.FOLD_UP_DOWN_ICON;
        expandBtn.addEventListener('click', () => this.expandGapContext(expandControls, 'all', gapSize));
      }
      buttonContainer.appendChild(expandBtn);
    } else {
      // Large gap between changes - show separate up/down buttons with GitHub fold icons
      const expandAbove = document.createElement('button');
      expandAbove.className = 'expand-button expand-up';
      expandAbove.title = 'Expand up';
      expandAbove.innerHTML = PRManager.FOLD_UP_ICON;

      const expandBelow = document.createElement('button');
      expandBelow.className = 'expand-button expand-down';
      expandBelow.title = 'Expand down';
      expandBelow.innerHTML = PRManager.FOLD_DOWN_ICON;

      // Stack buttons: down on top (visually), up below - matches GitHub behavior
      buttonContainer.appendChild(expandBelow);
      buttonContainer.appendChild(expandAbove);

      // Add event listeners - capture expandControls in closure at creation time
      expandAbove.addEventListener('click', () => this.expandGapContext(expandControls, 'up', PRManager.DEFAULT_EXPAND_LINES));
      expandBelow.addEventListener('click', () => this.expandGapContext(expandControls, 'down', PRManager.DEFAULT_EXPAND_LINES));
    }
    oldLineCell.appendChild(buttonContainer);

    // Create content cell for hidden lines text - clickable to expand all
    const contentCell = document.createElement('td');
    contentCell.className = 'diff-code expand-content clickable-expand';
    contentCell.colSpan = 2;
    contentCell.title = 'Expand all';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'expand-content-wrapper';

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.innerHTML = PRManager.FOLD_UP_DOWN_ICON;

    const expandInfo = document.createElement('span');
    expandInfo.className = 'expand-info';
    expandInfo.textContent = `${gapSize} hidden lines`;

    contentWrapper.appendChild(expandIcon);
    contentWrapper.appendChild(expandInfo);
    contentCell.appendChild(contentWrapper);

    // Make content cell clickable to expand all
    contentCell.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      const hiddenCount = parseInt(expandControls.dataset.hiddenCount) || gapSize;
      this.expandGapContext(row.expandControls, 'all', hiddenCount);
    });
    
    // Store expand controls reference on row
    row.expandControls = expandControls;
    
    row.appendChild(oldLineCell);
    row.appendChild(newLineCell);
    row.appendChild(contentCell);
    tbody.appendChild(row);
  }

  /**
   * Create collapsed section for large unchanged blocks
   * @param {HTMLElement} tbody - Table body element
   * @param {string} fileName - File name
   * @param {Array} allLines - All lines in the section
   * @param {number} startIdx - Start index in allLines
   * @param {number} endIdx - End index in allLines
   * @param {string} position - Position ('above', 'below', or 'between')
   */
  createCollapsedSection(tbody, fileName, allLines, startIdx, endIdx, position) {
    const hiddenCount = endIdx - startIdx;
    const firstLine = allLines[startIdx];
    const lastLine = allLines[endIdx - 1];
    
    // Check if this section was previously expanded
    const sectionKey = this.getExpandedSectionKey(fileName, 
      firstLine.oldNumber || firstLine.newNumber, 
      lastLine.oldNumber || lastLine.newNumber);
    
    if (this.expandedSections.has(sectionKey)) {
      // This section was previously expanded, show all lines
      allLines.slice(startIdx, endIdx).forEach(line => {
        // Context expansion lines don't have a specific diff position since they weren't in the original diff
        this.renderDiffLine(tbody, line, fileName, null);
      });
      return; // Don't create collapsed section
    }
    
    // Create the collapsed section row
    const row = document.createElement('tr');
    row.className = 'context-expand-row';
    
    // Create separate cells for old and new line numbers
    const oldLineCell = document.createElement('td');
    oldLineCell.className = 'diff-line-num';
    oldLineCell.style.padding = '0';
    oldLineCell.style.textAlign = 'center';
    
    const newLineCell = document.createElement('td');
    newLineCell.className = 'diff-line-num';  
    newLineCell.style.padding = '0';
    newLineCell.style.textAlign = 'center';
    
    // Put expand buttons in the first line number cell
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'expand-button-container';
    
    // Create expand controls container for metadata
    const expandControls = document.createElement('div');
    expandControls.className = 'context-expand-controls';
    
    // Store metadata for expansion
    expandControls.dataset.fileName = fileName;
    expandControls.dataset.startLine = firstLine.oldNumber || firstLine.newNumber;
    expandControls.dataset.endLine = lastLine.oldNumber || lastLine.newNumber;
    expandControls.dataset.hiddenCount = hiddenCount;
    expandControls.dataset.position = position;
    expandControls.dataset.sectionKey = sectionKey;
    
    // Create the expand buttons with GitHub Octicons
    // For short sections (≤SMALL_GAP_THRESHOLD lines) or single-direction, show single button
    // For larger sections with both directions, show stacked buttons
    if (hiddenCount <= PRManager.SMALL_GAP_THRESHOLD || position !== 'between') {
      // Single button - either fold-up, fold-down, or fold-up-down
      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-button expand-all-short';

      if (position === 'above') {
        // At top - expand up to reveal lines above first visible line
        expandBtn.title = 'Expand up';
        expandBtn.innerHTML = PRManager.FOLD_UP_ICON;
        expandBtn.addEventListener('click', () => this.expandContext(expandControls, 'up', PRManager.DEFAULT_EXPAND_LINES));
      } else if (position === 'below') {
        // At bottom - expand down to reveal lines below last visible line
        expandBtn.title = 'Expand down';
        expandBtn.innerHTML = PRManager.FOLD_DOWN_ICON;
        expandBtn.addEventListener('click', () => this.expandContext(expandControls, 'down', PRManager.DEFAULT_EXPAND_LINES));
      } else {
        // Between - short section, expand all
        expandBtn.title = 'Expand all';
        expandBtn.innerHTML = PRManager.FOLD_UP_DOWN_ICON;
        expandBtn.addEventListener('click', () => this.expandContext(expandControls, 'all', hiddenCount));
      }
      buttonContainer.appendChild(expandBtn);
    } else {
      // Large section between changes - show both up and down buttons
      const expandAbove = document.createElement('button');
      expandAbove.className = 'expand-button expand-up';
      expandAbove.title = 'Expand up';
      expandAbove.innerHTML = PRManager.FOLD_UP_ICON;

      const expandBelow = document.createElement('button');
      expandBelow.className = 'expand-button expand-down';
      expandBelow.title = 'Expand down';
      expandBelow.innerHTML = PRManager.FOLD_DOWN_ICON;

      // Stack buttons: down on top, up below - matches GitHub behavior
      buttonContainer.appendChild(expandBelow);
      buttonContainer.appendChild(expandAbove);

      // Capture expandControls in closure at creation time
      expandAbove.addEventListener('click', () => this.expandContext(expandControls, 'up', PRManager.DEFAULT_EXPAND_LINES));
      expandBelow.addEventListener('click', () => this.expandContext(expandControls, 'down', PRManager.DEFAULT_EXPAND_LINES));
    }

    oldLineCell.appendChild(buttonContainer);

    // Create content cell for hidden lines text - clickable to expand all
    const contentCell = document.createElement('td');
    contentCell.className = 'diff-code expand-content clickable-expand';
    contentCell.colSpan = 2;
    contentCell.title = 'Expand all';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'expand-content-wrapper';

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.innerHTML = PRManager.FOLD_UP_DOWN_ICON;

    const expandInfo = document.createElement('span');
    expandInfo.className = 'expand-info';
    expandInfo.textContent = `${hiddenCount} hidden lines`;

    contentWrapper.appendChild(expandIcon);
    contentWrapper.appendChild(expandInfo);
    contentCell.appendChild(contentWrapper);

    // Store the hidden lines data for expansion
    expandControls.hiddenLines = allLines.slice(startIdx, endIdx);

    // Make content cell clickable to expand all
    contentCell.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      const hiddenCountValue = parseInt(expandControls.dataset.hiddenCount) || hiddenCount;
      this.expandContext(row.expandControls, 'all', hiddenCountValue);
    });
    
    // Store expand controls reference on row
    row.expandControls = expandControls;
    
    row.appendChild(oldLineCell);
    row.appendChild(newLineCell);
    row.appendChild(contentCell);
    tbody.appendChild(row);
  }

  /**
   * Get unique key for expanded section tracking
   * @param {string} fileName - File name
   * @param {number} startLine - Start line number
   * @param {number} endLine - End line number
   * @returns {string} Unique section key
   */
  getExpandedSectionKey(fileName, startLine, endLine) {
    return `${fileName}:${startLine}-${endLine}`;
  }

  /**
   * Expand context for a regular collapsed section (hiddenLines)
   * @param {HTMLElement} controlsElement - Expand controls element
   * @param {string} direction - Direction: 'up', 'down', or 'all'
   * @param {number} lineCount - Number of lines to expand
   */
  async expandContext(controlsElement, direction, lineCount) {
    // Find the row by searching for the one with this expandControls
    let row = null;
    let tbody = null;
    const allRows = document.querySelectorAll('tr.context-expand-row');
    for (const r of allRows) {
      if (r.expandControls === controlsElement) {
        row = r;
        tbody = r.closest('tbody');
        break;
      }
    }
    
    if (!row || !tbody) {
      console.error('Could not find row for expand controls');
      return;
    }
    
    const hiddenLines = controlsElement.hiddenLines;
    const sectionKey = controlsElement.dataset.sectionKey;
    
    if (!hiddenLines || hiddenLines.length === 0) {
      console.warn('No hidden lines to expand');
      return;
    }

    let linesToShow = [];
    let remainingLines = [];
    
    if (direction === 'all') {
      // Show all hidden lines
      linesToShow = hiddenLines;
      // Track that this section is now fully expanded
      if (sectionKey) {
        this.expandedSections.add(sectionKey);
      }
    } else if (direction === 'up') {
      // Show first N lines
      linesToShow = hiddenLines.slice(0, Math.min(lineCount, hiddenLines.length));
      remainingLines = hiddenLines.slice(lineCount);
    } else if (direction === 'down') {
      // Show last N lines
      const startIdx = Math.max(0, hiddenLines.length - lineCount);
      linesToShow = hiddenLines.slice(startIdx);
      remainingLines = hiddenLines.slice(0, startIdx);
    }
    
    // Create rows for the lines to show
    const fragment = document.createDocumentFragment();
    const fileName = controlsElement.dataset.fileName;
    linesToShow.forEach(line => {
      const lineRow = this.renderDiffLine(fragment, line, fileName, null);
      // Add data attributes for selection
      if (lineRow && fileName && line.newNumber) {
        lineRow.dataset.file = fileName;
        lineRow.dataset.lineNumber = line.newNumber;
      }
      // Add animation class for newly expanded lines
      lineRow.classList.add('newly-expanded');
      // Remove animation class after animation completes
      setTimeout(() => {
        if (lineRow && lineRow.classList) {
          lineRow.classList.remove('newly-expanded');
        }
      }, 800);
    });
    
    if (direction === 'all') {
      // Insert all lines where the expand controls were
      if (row && row.parentNode) {
        row.parentNode.insertBefore(fragment, row);
        row.remove();
      }
    } else {
      // Update the expand controls with remaining lines
      if (remainingLines.length > 0) {
        controlsElement.hiddenLines = remainingLines;
        controlsElement.dataset.hiddenCount = remainingLines.length;
        
        // Update the info text in the row
        const infoSpan = row.querySelector('.expand-info');
        if (infoSpan) {
          infoSpan.textContent = `${remainingLines.length} hidden lines`;
        }
        
        // Update the expand-all button tooltip
        const expandAllBtn = row.querySelector('.expand-all');
        if (expandAllBtn) {
          expandAllBtn.title = `Expand all ${remainingLines.length} lines`;
        }
        
        // Insert the expanded lines
        if (row && row.parentNode) {
          if (direction === 'up') {
            row.parentNode.insertBefore(fragment, row);
          } else {
            row.parentNode.insertBefore(fragment, row.nextSibling);
          }
        }
      } else {
        // No more hidden lines, remove the expand controls
        if (row && row.parentNode) {
          row.parentNode.insertBefore(fragment, row);
          row.remove();
        }
      }
    }
  }

  /**
   * Expand gap context between diff blocks (fetches from API)
   * @param {HTMLElement} controlsElement - Expand controls element
   * @param {string} direction - Direction: 'up', 'down', or 'all'
   * @param {number} lineCount - Number of lines to expand
   */
  async expandGapContext(controlsElement, direction, lineCount) {
    // Special handler for expanding gaps between diff blocks
    const fileName = controlsElement.dataset.fileName;
    const startLine = parseInt(controlsElement.dataset.startLine);
    const endLine = parseInt(controlsElement.dataset.endLine);
    
    // Find the row by searching for the one with this expandControls
    let row = null;
    let tbody = null;
    const allRows = document.querySelectorAll('tr.context-expand-row');
    for (const r of allRows) {
      if (r.expandControls === controlsElement) {
        row = r;
        tbody = r.closest('tbody');
        break;
      }
    }
    
    if (!row || !tbody) {
      console.error('Could not find row for expand controls');
      return;
    }
    
    try {
      if (!this.currentPR) {
        throw new Error('No current PR data');
      }
      
      // Fetch the original file content
      const owner = this.currentPR.owner;
      const repo = this.currentPR.repo;
      const number = this.currentPR.number;
      
      const response = await fetch(`/api/file-content-original/${encodeURIComponent(fileName)}?owner=${owner}&repo=${repo}&number=${number}`);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch file content');
      }
      
      if (!data.lines || data.lines.length === 0) {
        console.error('Could not fetch file content');
        return;
      }
      
      // Get the lines we need (adjust for 0-based indexing)
      const allGapLines = data.lines.slice(startLine - 1, endLine);
      
      let linesToShow = [];
      let remainingStartLine = startLine;
      let remainingEndLine = endLine;
      
      if (direction === 'all') {
        // Show all hidden lines
        linesToShow = allGapLines;
      } else if (direction === 'up') {
        // "Up" means expand upward from bottom - show LAST N lines of the gap
        const showFromLine = Math.max(startLine, endLine - lineCount + 1);
        linesToShow = data.lines.slice(showFromLine - 1, endLine);
        remainingEndLine = showFromLine - 1;
      } else if (direction === 'down') {
        // "Down" means expand downward from top - show FIRST N lines of the gap
        const showToLine = Math.min(endLine, startLine + lineCount - 1);
        linesToShow = data.lines.slice(startLine - 1, showToLine);
        remainingStartLine = showToLine + 1;
      }
      
      // Create diff-formatted lines
      const fragment = document.createDocumentFragment();
      linesToShow.forEach((content, idx) => {
        const lineNumber = direction === 'down' ? 
          startLine + idx : 
          direction === 'up' ? 
          (endLine - linesToShow.length + 1 + idx) : 
          startLine + idx;
          
        const lineData = {
          type: 'context',
          oldNumber: lineNumber,
          newNumber: lineNumber,
          content: content || ''
        };
        
        const lineRow = this.renderDiffLine(fragment, lineData, fileName, null);
        if (lineRow) {
          lineRow.classList.add('newly-expanded');
          setTimeout(() => {
            if (lineRow && lineRow.classList) {
              lineRow.classList.remove('newly-expanded');
            }
          }, 800);
        }
      });
      
      if (direction === 'all') {
        // Replace the expand controls with all lines
        if (row && row.parentNode) {
          row.parentNode.insertBefore(fragment, row);
          row.remove();
        }
      } else {
        // Update remaining gap info
        const remainingGapSize = remainingEndLine - remainingStartLine + 1;
        
        if (remainingGapSize > 0) {
          // Update the controls
          controlsElement.dataset.startLine = remainingStartLine;
          controlsElement.dataset.endLine = remainingEndLine;
          controlsElement.dataset.hiddenCount = remainingGapSize;
          
          // Update the info text in the row
          const infoSpan = row.querySelector('.expand-info');
          if (infoSpan) {
            infoSpan.textContent = `${remainingGapSize} hidden lines`;
          }
          
          // Update the expand-all button tooltip
          const expandAllBtn = row.querySelector('.expand-all');
          if (expandAllBtn) {
            expandAllBtn.title = `Expand all ${remainingGapSize} lines`;
          }
          
          // Insert the expanded lines in the correct position
          if (row && row.parentNode) {
            if (direction === 'down') {
              // Expanding downward from top of gap - insert BEFORE divider
              row.parentNode.insertBefore(fragment, row);
            } else if (direction === 'up') {
              // Expanding upward from bottom of gap - insert AFTER divider
              row.parentNode.insertBefore(fragment, row.nextSibling);
            }
          }
        } else {
          // No more hidden lines, remove the expand controls
          if (row && row.parentNode) {
            row.parentNode.insertBefore(fragment, row);
            row.remove();
          }
        }
      }
      
    } catch (error) {
      console.error('Error expanding gap context:', error);
      // Show error in UI
      const errorRow = document.createElement('tr');
      errorRow.innerHTML = `<td colspan="2" class="expand-error">Error loading context: ${error.message}</td>`;
      if (row && row.parentNode) {
        row.parentNode.insertBefore(errorRow, row);
      }
    }
  }


  /**
   * Get the Analyze with AI button
   */
  getAnalyzeButton() {
    // Try new layout button first, fall back to old layout
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

    // Update button content based on layout
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
   * Reopen progress modal when button is clicked during analysis
   */
  reopenProgressModal() {
    if (this.currentAnalysisId && window.progressModal) {
      window.progressModal.show(this.currentAnalysisId);
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

    // Get button reference early to prevent concurrent clicks
    // Try new layout button first, fall back to old layout
    const btn = document.getElementById('analyze-btn') ||
                document.querySelector('button[onclick*="triggerAIAnalysis"]');

    // Prevent concurrent analysis requests
    if (btn && btn.disabled) {
      return;
    }

    try {
      // Check if there are existing AI suggestions first (before showing modal)
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

        const confirmed = await window.confirmDialog.show({
          title: 'Replace Existing Analysis?',
          message: 'This will replace all existing AI suggestions for this PR. Continue?',
          confirmText: 'Continue',
          confirmClass: 'btn-danger'
        });

        if (!confirmed) {
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

      // Determine the model to use (priority: remembered > repo default > 'sonnet')
      const modelStorageKey = PRManager.getRepoStorageKey('pair-review-model', owner, repo);
      const rememberedModel = localStorage.getItem(modelStorageKey);
      const currentModel = rememberedModel || repoSettings?.default_model || 'sonnet';

      // Show the config modal
      const config = await this.analysisConfigModal.show({
        currentModel,
        repoInstructions: repoSettings?.default_instructions || '',
        lastInstructions: lastInstructions,
        rememberModel: !!rememberedModel
      });

      // If user cancelled, do nothing
      if (!config) {
        return;
      }

      // Save remembered model preference if requested
      if (config.rememberModel) {
        localStorage.setItem(modelStorageKey, config.model);
      } else {
        localStorage.removeItem(modelStorageKey);
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

      // Start AI analysis with model and instructions
      // Note: Server handles combining repo default instructions with custom instructions
      const response = await fetch(`/api/analyze/${owner}/${repo}/${number}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.model || 'sonnet',
          customInstructions: config.instructions || null
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start AI analysis');
      }

      const result = await response.json();

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
   * Load and display user comments
   */
  async loadUserComments() {
    if (!this.currentPR) return;

    try {
      let response;
      
      // Use currentPR data if available (preferred approach)
      if (this.currentPR.owner && this.currentPR.repo && this.currentPR.number) {
        response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/user-comments`);
      } else if (this.currentPR.id) {
        // Fallback to legacy endpoint
        response = await fetch(`/api/pr/${this.currentPR.id}/user-comments`);
      } else {
        // Fallback: parse from URL if currentPR data is incomplete
        const urlParts = window.location.pathname.split('/');
        if (urlParts.length >= 4 && urlParts[1] === 'pr') {
          const owner = urlParts[2];
          const repo = urlParts[3];
          const number = urlParts[4];
          response = await fetch(`/api/pr/${owner}/${repo}/${number}/user-comments`);
        } else {
          console.warn('Unable to determine PR information for loading user comments');
          return;
        }
      }
      
      if (!response.ok) {
        console.error('Failed to load user comments');
        return;
      }

      const data = await response.json();
      const rawComments = data.comments || [];

      // Validate and sanitize side field for each comment
      // Legacy data may have missing or invalid side values
      const comments = rawComments.map(comment => {
        if (comment.side !== 'LEFT' && comment.side !== 'RIGHT') {
          if (comment.side) {
            console.warn(`[loadUserComments] Invalid side value "${comment.side}" for comment ${comment.id}, defaulting to RIGHT`);
          }
          return { ...comment, side: 'RIGHT' };
        }
        return comment;
      });

      console.log(`Loaded ${comments.length} user comments`);

      // Store comments for later use (to detect adopted suggestions)
      this.userComments = comments;
      console.log(`[UI] Stored user comments for adoption detection:`, comments.filter(c => c.parent_id));

      // Display comments inline with the diff (async - auto-expands hidden lines)
      await this.displayUserComments(comments);

    } catch (error) {
      console.error('Error loading user comments:', error);
    }
  }
  
  /**
   * Display user comments inline with diff
   */
  async displayUserComments(comments) {
    // Concurrency guard: prevent multiple simultaneous executions
    if (this._isDisplayingComments) {
      console.log('[UI] displayUserComments already in progress, skipping');
      return;
    }
    this._isDisplayingComments = true;

    try {
      console.log(`[UI] Displaying ${comments.length} user comments`);

      // Clear existing user comment rows before displaying new ones
      const existingCommentRows = document.querySelectorAll('.user-comment-row');
      existingCommentRows.forEach(row => row.remove());

      // Auto-expand hidden lines for comments that target non-visible lines
      // Reuse the same logic as AI suggestions - comments have the same structure
      const hiddenComments = this.findHiddenSuggestions(comments);
      if (hiddenComments.length > 0) {
        console.log(`[UI] Found ${hiddenComments.length} user comments targeting hidden lines, expanding...`);
        for (const hidden of hiddenComments) {
          await this.expandForSuggestion(hidden.file, hidden.line, hidden.lineEnd);
        }
        console.log(`[UI] Finished expanding hidden lines for user comments`);
      }

    // Group comments by file and line
    const commentsByLocation = {};

    comments.forEach(comment => {
      const key = `${comment.file}:${comment.line_start}`;
      if (!commentsByLocation[key]) {
        commentsByLocation[key] = [];
      }
      commentsByLocation[key].push(comment);
    });

    // Find diff rows and insert comments
    Object.entries(commentsByLocation).forEach(([location, locationComments]) => {
      const [file, lineStr] = location.split(':');
      const line = parseInt(lineStr);

      // Use helper method for file lookup
      const fileElement = this.findFileElement(file);

      if (!fileElement) {
        console.warn(`[UI] Could not find file element for user comment: ${file}`);
        return;
      }

      // Find the line in the diff using helper method
      const lineRows = fileElement.querySelectorAll('tr');
      let commentInserted = false;

      for (const row of lineRows) {
        if (commentInserted) break;

        const lineNum = this.getLineNumber(row);

        if (lineNum === line) {
          // Insert comments after this row
          locationComments.forEach(comment => {
            this.displayUserComment(comment, row);
          });
          commentInserted = true;
        }
      }

      if (!commentInserted) {
        console.warn(`[UI] Could not find line ${line} in file ${file} for user comment`);
      }
    });

      // Update the comment count in the review button
      this.updateCommentCount();
    } finally {
      // Always clear the guard, even if an error occurred
      this._isDisplayingComments = false;
    }
  }

  /**
   * Load and display AI suggestions
   */
  async loadAISuggestions() {
    if (!this.currentPR) return;

    try {
      let response;

      // Use currentPR data if available (preferred approach)
      if (this.currentPR.owner && this.currentPR.repo && this.currentPR.number) {
        response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/ai-suggestions?levels=${this.selectedLevel}`);
      } else {
        // Fallback: parse from URL if currentPR data is incomplete
        const urlParts = window.location.pathname.split('/');
        if (urlParts.length >= 4 && urlParts[1] === 'pr') {
          const owner = urlParts[2];
          const repo = urlParts[3];
          const number = urlParts[4];
          response = await fetch(`/api/pr/${owner}/${repo}/${number}/ai-suggestions?levels=${this.selectedLevel}`);
        } else {
          throw new Error('Unable to determine PR repository information');
        }
      }

      if (!response.ok) {
        throw new Error('Failed to load AI suggestions');
      }

      const data = await response.json();
      const suggestions = data.suggestions || [];

      console.log(`Loaded ${suggestions.length} AI suggestions for level: ${this.selectedLevel}`);

      // Display suggestions inline with the diff (async - auto-expands hidden lines)
      await this.displayAISuggestions(suggestions);

      // Update AI Panel with findings
      if (window.aiPanel) {
        window.aiPanel.addFindings(suggestions);
      }

    } catch (error) {
      console.error('Error loading AI suggestions:', error);
    }
  }

  /**
   * Find a file wrapper element by file path
   * Tries multiple selectors and partial path matching for robustness
   * @param {string} filePath - File path to find
   * @returns {Element|null} The file wrapper element or null if not found
   */
  findFileElement(filePath) {
    // Try exact match first
    let fileElement = document.querySelector(`[data-file-name="${filePath}"]`);
    if (fileElement) return fileElement;

    fileElement = document.querySelector(`[data-file-path="${filePath}"]`);
    if (fileElement) return fileElement;

    // Try partial match for path segments
    const allFileWrappers = document.querySelectorAll('.d2h-file-wrapper');
    for (const wrapper of allFileWrappers) {
      const fileName = wrapper.dataset.fileName;
      if (fileName && (fileName === filePath || fileName.endsWith('/' + filePath) || filePath.endsWith('/' + fileName))) {
        return wrapper;
      }
    }

    return null;
  }

  /**
   * Get the line number from a diff row
   * Handles both added/context lines (new line numbers) and deleted lines (old line numbers).
   * Priority order:
   * 1. dataset.lineNumber - most reliable, set during renderDiffLine
   * 2. .line-num2: new line numbers for added/context lines
   * 3. .line-num1: old line numbers for deleted lines
   * 4. Nested selectors as fallback
   * @param {Element} row - Table row element
   * @returns {number|null} The line number or null if not found
   */
  getLineNumber(row) {
    // Primary: use dataset.lineNumber if available (set during renderDiffLine)
    // This correctly handles both deleted lines (uses oldNumber) and added/context lines (uses newNumber)
    if (row.dataset?.lineNumber) {
      const datasetNum = parseInt(row.dataset.lineNumber);
      if (!isNaN(datasetNum)) return datasetNum;
    }

    // Fallback: check span elements
    // For added/context lines, check .line-num2 (new line number)
    let lineNum = row.querySelector('.line-num2')?.textContent?.trim();
    if (lineNum) return parseInt(lineNum);

    // For deleted lines, check .line-num1 (old line number)
    lineNum = row.querySelector('.line-num1')?.textContent?.trim();
    if (lineNum) return parseInt(lineNum);

    // Alternative: .line-num-new
    lineNum = row.querySelector('.line-num-new')?.textContent?.trim();
    if (lineNum) return parseInt(lineNum);

    // Nested: inside .d2h-code-linenumber container
    const lineNumCell = row.querySelector('.d2h-code-linenumber');
    if (lineNumCell) {
      const lineNum2 = lineNumCell.querySelector('.line-num2');
      if (lineNum2) {
        lineNum = lineNum2.textContent?.trim();
        if (lineNum) return parseInt(lineNum);
      }
    }

    return null;
  }

  /**
   * Build a set of visible line numbers for a file element
   * This is more efficient than checking each line individually when processing multiple suggestions
   * @param {Element} fileElement - The file wrapper element
   * @returns {Set<number>} Set of visible line numbers
   */
  buildVisibleLinesSet(fileElement) {
    const visibleLines = new Set();
    const lineRows = fileElement.querySelectorAll('tr');

    for (const row of lineRows) {
      const lineNum = this.getLineNumber(row);
      if (lineNum !== null) {
        visibleLines.add(lineNum);
      }
    }

    return visibleLines;
  }

  /**
   * Find items (suggestions or comments) that target lines not currently visible in the DOM.
   * This method is used for both AI suggestions and user comments since they share the same
   * structure (file, line_start, line_end) and both need auto-expansion of collapsed diff sections.
   *
   * Items are considered "hidden" when they target lines that are:
   * - Inside a collapsed gap between diff hunks
   * - Inside a collapsed generated file section
   *
   * @param {Array} items - Array of items with {file, line_start, line_end} properties
   *                        Works with both AI suggestions and user comments
   * @returns {Array} Array of { file, line, lineEnd, suggestions } for hidden lines
   *                  Note: property named "suggestions" for backwards compatibility but contains items
   */
  findHiddenSuggestions(items) {
    const hiddenItems = [];

    // Group items by file first, then by line range
    const itemsByFile = new Map();
    items.forEach(item => {
      if (!itemsByFile.has(item.file)) {
        itemsByFile.set(item.file, []);
      }
      itemsByFile.get(item.file).push(item);
    });

    // Process each file once, building visibility set once per file (O(m) per file)
    for (const [file, fileItems] of itemsByFile) {
      const fileElement = this.findFileElement(file);

      if (!fileElement) {
        console.warn(`[findHiddenSuggestions] Could not find file element for: ${file}`);
        // All items for this file are "hidden" (file not in diff)
        continue;
      }

      // Build visibility set once for this file - O(m) where m is rows
      const visibleLines = this.buildVisibleLinesSet(fileElement);
      console.log(`[findHiddenSuggestions] File ${file}: ${visibleLines.size} visible lines`);

      // Group items by line_start, using max line_end for each group
      // This ensures multi-line items at the same start line are handled together
      const itemsByStart = new Map();
      for (const item of fileItems) {
        const lineStart = item.line_start;
        const lineEnd = item.line_end || lineStart;
        const key = `${lineStart}`;

        if (!itemsByStart.has(key)) {
          itemsByStart.set(key, {
            file,
            line: lineStart,
            lineEnd: lineEnd,
            suggestions: []  // Named "suggestions" for backwards compatibility
          });
        }
        // Use max lineEnd to cover all items at this start line
        const existing = itemsByStart.get(key);
        existing.lineEnd = Math.max(existing.lineEnd, lineEnd);
        existing.suggestions.push(item);
      }

      // Check each unique line range - O(1) lookup per item
      for (const [, location] of itemsByStart) {
        const { line, lineEnd } = location;

        // Check if any line in the range is visible
        let anyLineVisible = false;
        for (let l = line; l <= lineEnd; l++) {
          if (visibleLines.has(l)) {
            anyLineVisible = true;
            break;
          }
        }

        if (!anyLineVisible) {
          console.log(`[findHiddenSuggestions] Hidden: ${file}:${line}-${lineEnd}`);
          hiddenItems.push(location);
        }
      }
    }

    return hiddenItems;
  }

  /**
   * Expand a gap section to reveal a specific line range for an AI suggestion
   * @param {string} file - File path
   * @param {number} lineStart - Start line number to reveal
   * @param {number} lineEnd - End line number to reveal (optional, defaults to lineStart)
   * @returns {Promise<boolean>} True if expansion occurred, false otherwise
   */
  async expandForSuggestion(file, lineStart, lineEnd = lineStart) {
    console.log(`[expandForSuggestion] Attempting to reveal ${file}:${lineStart}-${lineEnd}`);

    // Find the file wrapper using helper method
    const fileElement = this.findFileElement(file);

    if (!fileElement) {
      console.warn(`[expandForSuggestion] Could not find file element for: ${file}`);
      console.log(`[expandForSuggestion] Available files:`,
        Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(w => w.dataset.fileName));
      return false;
    }

    // Check if the file is collapsed (generated files)
    if (fileElement.classList.contains('collapsed')) {
      console.log(`[expandForSuggestion] File is collapsed, expanding first`);
      const filePath = fileElement.dataset.fileName;
      if (filePath && this.generatedFiles.has(filePath)) {
        this.toggleGeneratedFile(filePath);
        // Wait a moment for the UI to update
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Find all gap sections in this file
    const gapRows = fileElement.querySelectorAll('tr.context-expand-row');
    console.log(`[expandForSuggestion] Found ${gapRows.length} gap sections in file`);

    let targetGapRow = null;
    let targetControls = null;

    for (const row of gapRows) {
      const controls = row.expandControls;
      if (!controls) {
        console.log(`[expandForSuggestion] Gap row missing expandControls`);
        continue;
      }

      const gapStart = parseInt(controls.dataset.startLine);
      const gapEnd = parseInt(controls.dataset.endLine);

      // Check if any part of the target line range falls within this gap
      // A range overlaps if: lineStart <= gapEnd AND lineEnd >= gapStart
      if (lineStart <= gapEnd && lineEnd >= gapStart) {
        console.log(`[expandForSuggestion] Found matching gap: ${gapStart}-${gapEnd}`);
        targetGapRow = row;
        targetControls = controls;
        break;
      }
    }

    if (!targetGapRow || !targetControls) {
      console.warn(`[expandForSuggestion] Could not find gap containing lines ${lineStart}-${lineEnd} in file ${file}`);
      // Log all gaps for debugging
      for (const row of gapRows) {
        const controls = row.expandControls;
        if (controls) {
          console.log(`[expandForSuggestion] Available gap: ${controls.dataset.startLine}-${controls.dataset.endLine}`);
        }
      }
      return false;
    }

    // Calculate the range to expand around the target lines
    // Use a context radius of 3 lines
    const contextRadius = 3;
    const gapStart = parseInt(targetControls.dataset.startLine);
    const gapEnd = parseInt(targetControls.dataset.endLine);
    const gapSize = gapEnd - gapStart + 1;

    // We want lines from (lineStart - contextRadius) to (lineEnd + contextRadius)
    // but bounded by the gap boundaries
    const expandStart = Math.max(gapStart, lineStart - contextRadius);
    const expandEnd = Math.min(gapEnd, lineEnd + contextRadius);
    const linesToExpand = expandEnd - expandStart + 1;

    console.log(`[expandForSuggestion] Gap ${gapStart}-${gapEnd} (${gapSize} lines), expanding ${expandStart}-${expandEnd} (${linesToExpand} lines)`);

    // If the gap is small or we're expanding most of it, just expand all
    if (gapSize <= 10 || linesToExpand >= gapSize * 0.7) {
      console.log(`[expandForSuggestion] Expanding entire gap`);
      await this.expandGapContext(targetControls, 'all', gapSize);
    } else {
      // Partial expansion: show only the needed range, keep gaps above/below
      console.log(`[expandForSuggestion] Partial expansion: ${expandStart}-${expandEnd} within gap ${gapStart}-${gapEnd}`);
      await this.expandGapRange(targetGapRow, targetControls, expandStart, expandEnd);
    }

    return true;
  }

  /**
   * Expand a specific range within a gap, creating new gaps above/below as needed
   * @param {Element} gapRow - The gap row element
   * @param {Element} controls - The expand controls element with gap metadata
   * @param {number} expandStart - First line to reveal
   * @param {number} expandEnd - Last line to reveal
   */
  async expandGapRange(gapRow, controls, expandStart, expandEnd) {
    const fileName = controls.dataset.fileName;
    const gapStart = parseInt(controls.dataset.startLine);
    const gapEnd = parseInt(controls.dataset.endLine);
    const tbody = gapRow.closest('tbody');

    if (!tbody) {
      console.error('[expandGapRange] Could not find tbody');
      return;
    }

    try {
      if (!this.currentPR) {
        throw new Error('No current PR data');
      }

      // Fetch the file content
      const { owner, repo, number } = this.currentPR;
      const response = await fetch(`/api/file-content-original/${encodeURIComponent(fileName)}?owner=${owner}&repo=${repo}&number=${number}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch file content');
      }

      if (!data.lines || data.lines.length === 0) {
        console.error('[expandGapRange] Could not fetch file content');
        return;
      }

      // Create a fragment to hold all new elements
      const fragment = document.createDocumentFragment();

      // 1. Create gap section ABOVE the expanded range (if needed)
      const gapAboveStart = gapStart;
      const gapAboveEnd = expandStart - 1;
      const gapAboveSize = gapAboveEnd - gapAboveStart + 1;

      if (gapAboveSize > 0) {
        console.log(`[expandGapRange] Creating gap above: ${gapAboveStart}-${gapAboveEnd} (${gapAboveSize} lines)`);
        const aboveRow = this.createGapRowElement(fileName, gapAboveStart, gapAboveEnd, gapAboveSize, 'above');
        fragment.appendChild(aboveRow);
      }

      // 2. Create the expanded lines
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
          setTimeout(() => {
            if (lineRow && lineRow.classList) {
              lineRow.classList.remove('newly-expanded');
            }
          }, 800);
        }
      });

      // 3. Create gap section BELOW the expanded range (if needed)
      const gapBelowStart = expandEnd + 1;
      const gapBelowEnd = gapEnd;
      const gapBelowSize = gapBelowEnd - gapBelowStart + 1;

      if (gapBelowSize > 0) {
        console.log(`[expandGapRange] Creating gap below: ${gapBelowStart}-${gapBelowEnd} (${gapBelowSize} lines)`);
        const belowRow = this.createGapRowElement(fileName, gapBelowStart, gapBelowEnd, gapBelowSize, 'below');
        fragment.appendChild(belowRow);
      }

      // Replace the original gap row with our new content
      if (gapRow.parentNode) {
        gapRow.parentNode.insertBefore(fragment, gapRow);
        gapRow.remove();
      }

      console.log(`[expandGapRange] Expanded ${linesToShow.length} lines, created ${gapAboveSize > 0 ? 1 : 0} gap above, ${gapBelowSize > 0 ? 1 : 0} gap below`);

    } catch (error) {
      console.error('[expandGapRange] Error:', error);
    }
  }

  /**
   * Create a gap row element for partial expansion
   * Similar to createGapSection but returns the element instead of appending to tbody
   */
  createGapRowElement(fileName, startLine, endLine, gapSize, position = 'between') {
    const row = document.createElement('tr');
    row.className = 'context-expand-row';

    // Create line number cells
    const oldLineCell = document.createElement('td');
    oldLineCell.className = 'diff-line-num';
    oldLineCell.style.padding = '0';
    oldLineCell.style.textAlign = 'center';

    const newLineCell = document.createElement('td');
    newLineCell.className = 'diff-line-num';
    newLineCell.style.padding = '0';
    newLineCell.style.textAlign = 'center';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'expand-button-container';

    // Create expand controls with metadata
    const expandControls = document.createElement('div');
    expandControls.className = 'context-expand-controls';
    expandControls.dataset.fileName = fileName;
    expandControls.dataset.startLine = startLine;
    expandControls.dataset.endLine = endLine;
    expandControls.dataset.hiddenCount = gapSize;
    expandControls.dataset.position = position;
    expandControls.dataset.isGap = 'true';

    // Create expand button
    const expandBtn = document.createElement('button');
    expandBtn.className = 'expand-button expand-all-short';
    expandBtn.title = `Expand ${gapSize} lines`;
    expandBtn.innerHTML = PRManager.FOLD_UP_DOWN_ICON;
    expandBtn.addEventListener('click', () => this.expandGapContext(expandControls, 'all', gapSize));
    buttonContainer.appendChild(expandBtn);
    oldLineCell.appendChild(buttonContainer);

    // Create content cell
    const contentCell = document.createElement('td');
    contentCell.className = 'diff-code expand-content clickable-expand';
    contentCell.colSpan = 2;
    contentCell.title = 'Expand all';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'expand-content-wrapper';

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.innerHTML = PRManager.FOLD_UP_DOWN_ICON;

    const expandInfo = document.createElement('span');
    expandInfo.className = 'expand-info';
    expandInfo.textContent = `${gapSize} hidden lines`;

    contentWrapper.appendChild(expandIcon);
    contentWrapper.appendChild(expandInfo);
    contentCell.appendChild(contentWrapper);

    contentCell.addEventListener('click', () => {
      this.expandGapContext(expandControls, 'all', gapSize);
    });

    row.expandControls = expandControls;
    row.appendChild(oldLineCell);
    row.appendChild(newLineCell);
    row.appendChild(contentCell);

    return row;
  }

  /**
   * Display AI suggestions inline with diff
   * Uses a concurrency guard to prevent multiple simultaneous executions
   */
  async displayAISuggestions(suggestions) {
    // Concurrency guard: prevent multiple simultaneous executions
    // This avoids duplicated/interleaved suggestions when called rapidly
    if (this._isDisplayingSuggestions) {
      console.log('[UI] displayAISuggestions already in progress, skipping');
      return;
    }
    this._isDisplayingSuggestions = true;

    try {
      console.log(`[UI] Displaying ${suggestions.length} AI suggestions`);

      // Clear existing AI suggestion rows before displaying new ones
      const existingSuggestionRows = document.querySelectorAll('.ai-suggestion-row');
      existingSuggestionRows.forEach(row => row.remove());
      console.log(`[UI] Removed ${existingSuggestionRows.length} existing suggestion rows`);

    // Auto-expand hidden lines for suggestions that target non-visible lines
    const hiddenSuggestions = this.findHiddenSuggestions(suggestions);
    if (hiddenSuggestions.length > 0) {
      console.log(`[UI] Found ${hiddenSuggestions.length} suggestions targeting hidden lines, expanding...`);
      for (const hidden of hiddenSuggestions) {
        await this.expandForSuggestion(hidden.file, hidden.line, hidden.lineEnd);
      }
      console.log(`[UI] Finished expanding hidden lines`);
    }

    // Create suggestion navigator if not already created
    if (!this.suggestionNavigator && window.SuggestionNavigator) {
      console.log('[UI] Creating SuggestionNavigator instance');
      this.suggestionNavigator = new window.SuggestionNavigator();
    }

    // Update the suggestion navigator
    if (this.suggestionNavigator) {
      this.suggestionNavigator.updateSuggestions(suggestions);
    }

    // Adjust main content layout when navigator is visible
    const mainContent = document.querySelector('.main-content');
    if (mainContent && this.suggestionNavigator) {
      const visibleSuggestions = suggestions.filter(s => s.status !== 'dismissed');
      // Only add navigator-visible if we have suggestions AND the navigator is not collapsed
      if (visibleSuggestions.length > 0 && !this.suggestionNavigator.isCollapsed) {
        mainContent.classList.add('navigator-visible');
      } else {
        mainContent.classList.remove('navigator-visible');
      }
    }
    
    // Group suggestions by file and line
    const suggestionsByLocation = {};

    suggestions.forEach(suggestion => {
      const key = `${suggestion.file}:${suggestion.line_start}`;
      if (!suggestionsByLocation[key]) {
        suggestionsByLocation[key] = [];
      }
      suggestionsByLocation[key].push(suggestion);
    });

    console.log('[UI] Grouped suggestions by location:', Object.keys(suggestionsByLocation));

    // Find diff rows and insert suggestions
    Object.entries(suggestionsByLocation).forEach(([location, locationSuggestions]) => {
      const [file, lineStr] = location.split(':');
      const line = parseInt(lineStr);

      // Use helper method for file lookup
      const fileElement = this.findFileElement(file);

      if (!fileElement) {
        // This can happen when AI suggests a file path that doesn't exist in the diff
        // Common with level 3 (codebase context) analysis which may reference files outside the PR
        const availableFiles = Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(w => w.dataset.fileName);
        console.warn(`[UI] File not found in diff: "${file}". This suggestion may reference a file outside the PR or an incorrectly analyzed path. Available files:`, availableFiles);
        // Mark these suggestions as needing attention - they'll appear in the navigator but not inline
        locationSuggestions.forEach(s => {
          if (!s._displayError) s._displayError = `File "${file}" not found in diff`;
        });
        return;
      }

      // Find the line in the diff using helper method
      const lineRows = fileElement.querySelectorAll('tr');
      let suggestionInserted = false;

      for (const row of lineRows) {
        if (suggestionInserted) break;

        const lineNum = this.getLineNumber(row);

        if (lineNum === line) {
          console.log(`[UI] Found line ${line} in file ${file}, inserting suggestion`);
          // Insert suggestion after this row
          const suggestionRow = this.createSuggestionRow(locationSuggestions);
          row.parentNode.insertBefore(suggestionRow, row.nextSibling);
          suggestionInserted = true;
        }
      }
      
      if (!suggestionInserted) {
        // Line not found - this could happen if:
        // 1. The expansion didn't reveal the target line
        // 2. The line number is outside the diff hunks
        // 3. The AI suggested an incorrect line number
        console.warn(`[UI] Line ${line} not found in file "${file}" after expansion. The line may be outside the diff context or the AI may have suggested an incorrect line number.`);
        locationSuggestions.forEach(s => {
          if (!s._displayError) s._displayError = `Line ${line} not found in diff for file "${file}"`;
        });
      }
    });
    } finally {
      // Always clear the guard, even if an error occurred
      this._isDisplayingSuggestions = false;
    }
  }

  /**
   * Create a suggestion row for display
   */
  createSuggestionRow(suggestions) {
    const tr = document.createElement('tr');
    tr.className = 'ai-suggestion-row';
    
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'ai-suggestion-cell';
    
    suggestions.forEach(suggestion => {
      const suggestionDiv = document.createElement('div');
      suggestionDiv.className = `ai-suggestion ai-type-${suggestion.type}`;
      suggestionDiv.dataset.suggestionId = suggestion.id;
      // Store original markdown body for adopt functionality
      // Use JSON.stringify to preserve newlines and special characters
      suggestionDiv.dataset.originalBody = JSON.stringify(suggestion.body || '');

      // Convert suggestion.id to number for comparison since parent_id might be a number
      const suggestionIdNum = parseInt(suggestion.id);
      
      // Check if this suggestion was adopted by looking for user comments with matching parent_id
      const wasAdopted = this.userComments && this.userComments.some(comment => 
        comment.parent_id && (comment.parent_id === suggestion.id || comment.parent_id === suggestionIdNum)
      );
      
      // Log when a suggestion is detected as adopted
      if (wasAdopted) {
        console.log(`[UI] Suggestion ${suggestion.id} was adopted - showing as collapsed`);
      }

      // Apply collapsed class if the suggestion is dismissed or was adopted
      // Check both: wasAdopted (from user comments with parent_id) OR status='adopted' (from DB)
      const isAdopted = wasAdopted || suggestion.status === 'adopted';
      if (isAdopted) {
        suggestionDiv.classList.add('collapsed');
        // Mark the row as adopted after it's created
        setTimeout(() => {
          const suggestionRow = suggestionDiv.closest('tr');
          if (suggestionRow) {
            suggestionRow.dataset.hiddenForAdoption = 'true';
          }
        }, 0);
      } else if (suggestion.status === 'dismissed') {
        suggestionDiv.classList.add('collapsed');
      }
      
      // Get category label for display
      const categoryLabel = suggestion.type || suggestion.category || '';

      suggestionDiv.innerHTML = `
        <div class="ai-suggestion-header">
          <div class="ai-suggestion-header-left">
            ${suggestion.type === 'praise'
              ? `<span class="praise-badge" title="Nice Work"><svg viewBox="0 0 16 16"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
              : `<span class="ai-suggestion-badge" data-type="${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}"><svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>AI Suggestion</span>`}
            ${categoryLabel ? `<span class="ai-suggestion-category">${this.escapeHtml(categoryLabel)}</span>` : ''}
            <span class="ai-title">${this.escapeHtml(suggestion.title || '')}</span>
          </div>
        </div>
        <div class="ai-suggestion-collapsed-content">
          ${suggestion.type === 'praise'
            ? `<span class="praise-badge" title="Nice Work"><svg viewBox="0 0 16 16"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
            : `<span class="ai-suggestion-badge collapsed" data-type="${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}"><svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>AI Suggestion</span>`}
          <span class="collapsed-text">${isAdopted ? 'Suggestion adopted' : 'Hidden AI suggestion'}</span>
          <span class="collapsed-title">${this.escapeHtml(suggestion.title || '')}</span>
          <button class="btn-restore" onclick="prManager.restoreSuggestion(${suggestion.id})" title="Show suggestion">
            <svg class="octicon octicon-eye" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"></path>
            </svg>
            <span class="btn-text">Show</span>
          </button>
        </div>
        <div class="ai-suggestion-body">
          ${(() => {
            const body = suggestion.body || '';
            // Debug: Log what we're rendering
            console.log('Rendering AI suggestion body:', body.substring(0, 200));
            return window.renderMarkdown ? window.renderMarkdown(body) : this.escapeHtml(body);
          })()}
        </div>
        <div class="ai-suggestion-actions">
          <button class="ai-action ai-action-adopt" onclick="prManager.adoptSuggestion(${suggestion.id})">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
            Adopt
          </button>
          <button class="ai-action ai-action-edit" onclick="prManager.adoptAndEditSuggestion(${suggestion.id})">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/></svg>
            Edit
          </button>
          <button class="ai-action ai-action-dismiss" onclick="prManager.dismissSuggestion(${suggestion.id})">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>
            Dismiss
          </button>
        </div>
      `;
      
      td.appendChild(suggestionDiv);
    });
    
    tr.appendChild(td);
    return tr;
  }

  /**
   * Helper function to extract suggestion data from DOM
   */
  extractSuggestionData(suggestionDiv) {
    const suggestionText = suggestionDiv.dataset?.originalBody ?
      JSON.parse(suggestionDiv.dataset.originalBody) : '';

    // Get type from ai-suggestion-badge data-type attribute or praise-badge
    const badgeElement = suggestionDiv.querySelector('.ai-suggestion-badge, .praise-badge');
    const titleElement = suggestionDiv.querySelector('.ai-title');
    const suggestionType = badgeElement?.dataset?.type || (badgeElement?.classList?.contains('praise-badge') ? 'praise' : '');
    const suggestionTitle = titleElement?.textContent?.trim() || '';

    return { suggestionText, suggestionType, suggestionTitle };
  }

  /**
   * Helper function to find target row and extract file/line info
   */
  getFileAndLineInfo(suggestionDiv) {
    const suggestionRow = suggestionDiv.closest('tr');
    let targetRow = suggestionRow?.previousElementSibling;

    // Find the actual diff line row (skip other suggestion/comment rows)
    while (targetRow && (targetRow.classList.contains('ai-suggestion-row') || targetRow.classList.contains('user-comment-row'))) {
      targetRow = targetRow.previousElementSibling;
    }

    if (!targetRow) {
      throw new Error('Could not find target line for comment');
    }

    // Get diff position and side from the target row (for GitHub API)
    const diffPosition = targetRow.dataset.diffPosition;
    const side = targetRow.dataset.side || 'RIGHT';

    // Get line number based on side - deleted lines (LEFT) use .line-num1, others use .line-num2
    const lineNumSelector = side === 'LEFT' ? '.line-num1' : '.line-num2';
    const lineNumber = targetRow.querySelector(lineNumSelector)?.textContent?.trim();
    const fileWrapper = targetRow.closest('.d2h-file-wrapper');
    const fileName = fileWrapper?.dataset?.fileName || '';

    if (!lineNumber || !fileName) {
      throw new Error('Could not determine file and line information');
    }

    return { targetRow, suggestionRow, lineNumber, fileName, diffPosition, side };
  }

  /**
   * Helper function to update status and collapse AI suggestion
   */
  async collapseAISuggestion(suggestionId, suggestionRow, collapsedText = 'Suggestion adopted', status = 'dismissed') {
    // Update the AI suggestion status via API
    const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status })
    });

    if (!response.ok) {
      throw new Error('Failed to update suggestion status');
    }

    // Collapse the AI suggestion in the UI
    if (suggestionRow) {
      const suggestionDiv = suggestionRow.querySelector('.ai-suggestion');
      if (suggestionDiv) {
        suggestionDiv.classList.add('collapsed');
        // Update collapsed content text
        const collapsedContent = suggestionDiv.querySelector('.collapsed-text');
        if (collapsedContent) {
          collapsedContent.textContent = collapsedText;
        }
        // Update restore button - should say "Show" since suggestion is now collapsed
        const restoreButton = suggestionDiv.querySelector('.btn-restore');
        if (restoreButton) {
          restoreButton.title = 'Show suggestion';
          const btnText = restoreButton.querySelector('.btn-text');
          if (btnText) {
            btnText.textContent = 'Show';
          }
        }
      }
      suggestionRow.dataset.hiddenForAdoption = 'true';
    }
  }

  /**
   * Get emoji for suggestion category
   */
  getCategoryEmoji(category) {
    return PRManager.CATEGORY_EMOJI_MAP[category] || '💬';
  }

  /**
   * Format adopted comment text with emoji and category prefix
   */
  formatAdoptedComment(text, category) {
    if (!category) {
      return text;
    }
    const emoji = this.getCategoryEmoji(category);
    // Properly capitalize hyphenated categories (e.g., "code-style" -> "Code Style")
    const capitalizedCategory = category
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return `${emoji} **${capitalizedCategory}**: ${text}`;
  }

  /**
   * Helper function to create user comment from AI suggestion
   */
  async createUserCommentFromSuggestion(suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side) {
    // Format the comment text with emoji and category prefix
    const formattedText = this.formatAdoptedComment(suggestionText, suggestionType);

    // Parse diff_position if it's a string (from dataset)
    const parsedDiffPosition = diffPosition ? parseInt(diffPosition) : null;

    const createResponse = await fetch('/api/user-comment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pr_id: this.currentPR.id,
        file: fileName,
        line_start: parseInt(lineNumber),
        line_end: parseInt(lineNumber),
        diff_position: parsedDiffPosition,  // For GitHub API line-level comments
        side: side || 'RIGHT',              // For GitHub API (LEFT for deleted, RIGHT for added/context)
        body: formattedText,
        parent_id: suggestionId,  // Link to original AI suggestion
        type: suggestionType,     // Preserve the type
        title: suggestionTitle,   // Preserve the title
        commit_sha: this.currentPR.head_sha  // Anchor comment to PR head commit
      })
    });

    if (!createResponse.ok) {
      throw new Error('Failed to create user comment');
    }

    const result = await createResponse.json();
    return {
      id: result.commentId,
      file: fileName,
      line_start: parseInt(lineNumber),
      body: formattedText,
      type: suggestionType,
      title: suggestionTitle,
      parent_id: suggestionId,
      diff_position: parsedDiffPosition,  // Include for expanded context warning logic
      created_at: new Date().toISOString()
    };
  }

  /**
   * Adopt an AI suggestion and open it in edit mode
   */
  async adoptAndEditSuggestion(suggestionId) {
    try {
      // Get the suggestion element
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (!suggestionDiv) {
        throw new Error('Suggestion element not found');
      }

      // Extract suggestion data using helper
      const { suggestionText, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
      
      // Get file and line information using helper
      const { suggestionRow, lineNumber, fileName, diffPosition, side } = this.getFileAndLineInfo(suggestionDiv);

      // Collapse the AI suggestion and mark as adopted
      await this.collapseAISuggestion(suggestionId, suggestionRow, 'Suggestion adopted', 'adopted');

      // Create user comment from suggestion (with diff position for GitHub API)
      const newComment = await this.createUserCommentFromSuggestion(
        suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side
      );

      // Display the new user comment in edit mode BELOW the suggestion row
      this.displayUserCommentInEditMode(newComment, suggestionRow);

      // Update the suggestion navigator - mark as 'adopted' (not 'dismissed') to keep visible but de-emphasized
      if (this.suggestionNavigator && this.suggestionNavigator.suggestions) {
        const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
          s.id === suggestionId ? { ...s, status: 'adopted' } : s
        );
        this.suggestionNavigator.updateSuggestions(updatedSuggestions);
      }

      // Update AIPanel sidebar to show as adopted
      if (window.aiPanel) {
        window.aiPanel.updateFindingStatus(suggestionId, 'adopted');
      }

      // Update comment count
      this.updateCommentCount();

    } catch (error) {
      console.error('Error adopting and editing suggestion:', error);
      alert(`Failed to adopt suggestion: ${error.message}`);
    }
  }

  /**
   * Adopt an AI suggestion directly (without edit mode)
   */
  async adoptSuggestion(suggestionId) {
    try {
      // Get the suggestion element
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (!suggestionDiv) {
        throw new Error('Suggestion element not found');
      }

      // Extract suggestion data using helper
      const { suggestionText, suggestionType, suggestionTitle } = this.extractSuggestionData(suggestionDiv);
      
      // Get file and line information using helper
      const { suggestionRow, lineNumber, fileName, diffPosition, side } = this.getFileAndLineInfo(suggestionDiv);

      // Collapse the AI suggestion and mark as adopted
      await this.collapseAISuggestion(suggestionId, suggestionRow, 'Suggestion adopted', 'adopted');

      // Create user comment from suggestion (with diff position for GitHub API)
      const newComment = await this.createUserCommentFromSuggestion(
        suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side
      );

      // Display the new user comment in read-only mode (not edit mode)
      this.displayUserComment(newComment, suggestionRow);

      // Update the suggestion navigator - mark as 'adopted' (not 'dismissed') to keep visible but de-emphasized
      if (this.suggestionNavigator && this.suggestionNavigator.suggestions) {
        const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
          s.id === suggestionId ? { ...s, status: 'adopted' } : s
        );
        this.suggestionNavigator.updateSuggestions(updatedSuggestions);
      }

      // Update AIPanel sidebar to show as adopted
      if (window.aiPanel) {
        window.aiPanel.updateFindingStatus(suggestionId, 'adopted');
      }

      // Update comment count
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
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'dismissed' })
      });

      if (!response.ok) {
        throw new Error('Failed to dismiss suggestion');
      }

      // Add collapsed class to the suggestion to show it as hidden
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (suggestionDiv) {
        suggestionDiv.classList.add('collapsed');
        // Update button text to "Show" since suggestion is now collapsed
        const restoreButton = suggestionDiv.querySelector('.btn-restore');
        if (restoreButton) {
          restoreButton.title = 'Show suggestion';
          const btnText = restoreButton.querySelector('.btn-text');
          if (btnText) {
            btnText.textContent = 'Show';
          }
        }
        console.log(`[UI] Collapsed suggestion ${suggestionId}`);
      }

      // Update the suggestion navigator to mark as dismissed
      if (this.suggestionNavigator && this.suggestionNavigator.suggestions) {
        const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
          s.id === suggestionId ? { ...s, status: 'dismissed' } : s
        );
        this.suggestionNavigator.updateSuggestions(updatedSuggestions);
        console.log(`[UI] Updated navigator with suggestion marked as dismissed`);
      }

      // Update AIPanel sidebar to show as dismissed
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
      
      // Check if this suggestion was adopted (hiddenForAdoption flag)
      if (suggestionRow?.dataset.hiddenForAdoption === 'true') {
        // For adopted suggestions, toggle between collapsed and expanded states
        const suggestionDiv = suggestionRow.querySelector('.ai-suggestion');
        if (suggestionDiv) {
          const isCollapsed = suggestionDiv.classList.contains('collapsed');
          
          if (isCollapsed) {
            // Expand the suggestion
            suggestionDiv.classList.remove('collapsed');
            console.log(`[UI] Expanded adopted suggestion ${suggestionId}`);
          } else {
            // Collapse the suggestion
            suggestionDiv.classList.add('collapsed');
            console.log(`[UI] Collapsed adopted suggestion ${suggestionId}`);
          }
          
          // Update button text
          const button = suggestionRow.querySelector('.btn-restore');
          if (button) {
            const isNowCollapsed = suggestionDiv.classList.contains('collapsed');
            button.title = isNowCollapsed ? 'Show suggestion' : 'Hide suggestion';
            button.querySelector('.btn-text').textContent = isNowCollapsed ? 'Show' : 'Hide';
          }
        }
        return;
      }

      const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'active' })
      });

      if (!response.ok) {
        throw new Error('Failed to restore suggestion');
      }

      // Remove the collapsed class to show the suggestion again
      if (suggestionDiv) {
        suggestionDiv.classList.remove('collapsed');
        console.log(`[UI] Restored suggestion ${suggestionId}`);
      }

      // Update the suggestion navigator to mark as active
      if (this.suggestionNavigator && this.suggestionNavigator.suggestions) {
        const updatedSuggestions = this.suggestionNavigator.suggestions.map(s => 
          s.id === suggestionId ? { ...s, status: 'active' } : s
        );
        this.suggestionNavigator.updateSuggestions(updatedSuggestions);
        console.log(`[UI] Updated navigator with suggestion marked as active`);
      }

    } catch (error) {
      console.error('Error restoring suggestion:', error);
      alert('Failed to restore suggestion');
    }
  }



  /**
   * Show error message
   * @param {string} message - Error message
   */
  showError(message) {
    const container = document.getElementById('pr-container');
    if (!container) return;

    container.innerHTML = `
      <div class="error-container">
        <div class="error-icon">⚠️</div>
        <div class="error-message">${this.escapeHtml(message)}</div>
        <button class="btn btn-secondary" onclick="window.location.reload()">
          Retry
        </button>
      </div>
    `;
    
    container.style.display = 'block';
  }

  /**
   * Format date for display
   * @param {string} dateString - ISO date string
   * @returns {string} Formatted date
   */
  formatDate(dateString) {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch (error) {
      return dateString;
    }
  }

  /**
   * Format description with basic markdown-like support
   * @param {string} description - PR description
   * @returns {string} Formatted HTML
   */
  formatDescription(description) {
    // Basic formatting (can be enhanced with a proper markdown parser later)
    return this.escapeHtml(description)
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }

  /**
   * Initialize the suggestion navigator
   */
  initSuggestionNavigator() {
    // Initialize when SuggestionNavigator is available
    if (window.SuggestionNavigator) {
      this.suggestionNavigator = new window.SuggestionNavigator();
    } else {
      // Wait for component to load
      document.addEventListener('DOMContentLoaded', () => {
        if (window.SuggestionNavigator) {
          this.suggestionNavigator = new window.SuggestionNavigator();
        }
      });
    }
  }

  /**
   * Start line range selection
   */
  startRangeSelection(row, lineNumber, fileName, side = 'RIGHT') {
    // Clear any existing selection
    this.clearRangeSelection();

    // Set start of range (including side for GitHub API)
    this.rangeSelectionStart = {
      row: row,
      lineNumber: lineNumber,
      fileName: fileName,
      side: side
    };

    // Add visual indicator
    row.classList.add('line-range-start');
  }

  /**
   * Complete line range selection and show comment form
   */
  completeRangeSelection(endRow, endLineNumber, fileName) {
    if (!this.rangeSelectionStart) return;

    // Ensure we're in the same file
    if (this.rangeSelectionStart.fileName !== fileName) {
      alert('Cannot select range across different files');
      this.clearRangeSelection();
      return;
    }

    const startLine = this.rangeSelectionStart.lineNumber;
    const endLine = endLineNumber;

    // Ensure start is before end
    const minLine = Math.min(startLine, endLine);
    const maxLine = Math.max(startLine, endLine);

    // Highlight all rows in range (pass side to avoid highlighting both deleted and added lines with same line number)
    const side = this.rangeSelectionStart.side;
    this.highlightLineRange(this.rangeSelectionStart.row, endRow, fileName, minLine, maxLine, side);

    // Store end of range
    this.rangeSelectionEnd = {
      row: endRow,
      lineNumber: endLineNumber,
      fileName: fileName
    };

    // Get diff position from the end row (GitHub uses position at end of range)
    const diffPosition = endRow.dataset.diffPosition;

    this.showCommentForm(endRow, minLine, fileName, diffPosition, maxLine, side || 'RIGHT');
  }

  /**
   * Highlight all lines in a range
   * @param {HTMLElement} startRow - The starting row element
   * @param {HTMLElement} endRow - The ending row element
   * @param {string} fileName - The file name
   * @param {number} minLine - The minimum line number
   * @param {number} maxLine - The maximum line number
   * @param {string} side - The side of the diff ('LEFT' for deleted lines, 'RIGHT' for added/context)
   */
  highlightLineRange(startRow, endRow, fileName, minLine, maxLine, side) {
    // Find all rows in the file between minLine and maxLine
    const fileWrapper = startRow.closest('.d2h-file-wrapper');
    if (!fileWrapper) return;

    const allRows = fileWrapper.querySelectorAll('tr[data-line-number]');

    allRows.forEach(row => {
      const lineNum = parseInt(row.dataset.lineNumber);
      const rowSide = row.dataset.side || 'RIGHT';
      // Match by line number range, file name, and side
      // This prevents deleted lines (LEFT) from matching added/context lines (RIGHT) with same line number
      if (lineNum >= minLine && lineNum <= maxLine &&
          row.dataset.fileName === fileName &&
          rowSide === side) {
        row.classList.add('line-range-selected');
      }
    });
  }

  /**
   * Clear line range selection
   */
  clearRangeSelection() {
    // Remove all selection highlights
    document.querySelectorAll('.line-range-start, .line-range-selected').forEach(row => {
      row.classList.remove('line-range-start', 'line-range-selected');
    });

    // Clean up global listener if it exists
    if (this.handleGlobalMouseUp) {
      document.removeEventListener('mouseup', this.handleGlobalMouseUp);
      this.handleGlobalMouseUp = null;
    }

    // Clear state
    this.rangeSelectionStart = null;
    this.rangeSelectionEnd = null;
    this.isDraggingRange = false;
    this.dragStartLine = null;
    this.dragEndLine = null;
    this.potentialDragStart = null;
  }

  /**
   * Start drag selection
   */
  startDragSelection(row, lineNumber, fileName, side = 'RIGHT') {
    // Clear any existing selection and ensure cleanup
    this.clearRangeSelection();

    // Set dragging state
    this.isDraggingRange = true;
    this.dragStartLine = lineNumber;
    this.dragEndLine = lineNumber;

    // Set start of range, including side for GitHub API
    this.rangeSelectionStart = {
      row: row,
      lineNumber: lineNumber,
      fileName: fileName,
      side: side
    };

    // Add visual indicator
    row.classList.add('line-range-selected');

    // Add global mouse up handler to catch mouseup outside of line numbers
    // Store as bound function for reliable cleanup
    this.handleGlobalMouseUp = (e) => {
      if (this.isDraggingRange) {
        this.completeDragSelection(row, this.dragEndLine || lineNumber, fileName);
      }
    };
    document.addEventListener('mouseup', this.handleGlobalMouseUp);
  }

  /**
   * Update drag selection as mouse moves
   */
  updateDragSelection(row, lineNumber, fileName) {
    if (!this.isDraggingRange || !this.rangeSelectionStart) return;

    // Ensure we're in the same file
    if (this.rangeSelectionStart.fileName !== fileName) return;

    // Update end line
    this.dragEndLine = lineNumber;

    // Update end of range
    this.rangeSelectionEnd = {
      row: row,
      lineNumber: lineNumber,
      fileName: fileName
    };

    // Clear existing highlights
    document.querySelectorAll('.line-range-selected').forEach(r => {
      r.classList.remove('line-range-selected');
    });

    // Highlight all rows in range (pass side to avoid highlighting both deleted and added lines with same line number)
    const minLine = Math.min(this.dragStartLine, lineNumber);
    const maxLine = Math.max(this.dragStartLine, lineNumber);
    const side = this.rangeSelectionStart.side;
    this.highlightLineRange(this.rangeSelectionStart.row, row, fileName, minLine, maxLine, side);
  }

  /**
   * Complete drag selection
   */
  completeDragSelection(row, lineNumber, fileName) {
    if (!this.isDraggingRange) return;

    try {
      // Update end of range
      this.rangeSelectionEnd = {
        row: row,
        lineNumber: lineNumber,
        fileName: fileName
      };

      // If we have a valid range (more than one line), keep selection
      const minLine = Math.min(this.dragStartLine, this.dragEndLine);
      const maxLine = Math.max(this.dragStartLine, this.dragEndLine);

      if (minLine === maxLine) {
        // Single line - clear selection
        this.clearRangeSelection();
      } else {
        // Multi-line - keep selection for user to click + button
        // The selection stays highlighted until they click a comment button or clear it
      }
    } finally {
      // Always clean up the global listener and dragging state
      if (this.handleGlobalMouseUp) {
        document.removeEventListener('mouseup', this.handleGlobalMouseUp);
        this.handleGlobalMouseUp = null;
      }
      this.isDraggingRange = false;
    }
  }

  /**
   * Show comment form inline
   * @param {HTMLElement} targetRow - The row to insert the comment form after
   * @param {number} lineNumber - The starting line number for the comment
   * @param {string} fileName - The file name
   * @param {number} diffPosition - The diff position for GitHub API
   * @param {number} [endLineNumber] - Optional ending line number for multi-line comments
   * @param {string} [side='RIGHT'] - The side of the diff ('LEFT' for deleted lines, 'RIGHT' for added/context)
   */
  showCommentForm(targetRow, lineNumber, fileName, diffPosition, endLineNumber, side = 'RIGHT') {
    // Close any existing comment forms
    this.hideCommentForm();

    // Highlight the line(s) being commented on (if not already highlighted)
    if (!this.rangeSelectionStart || !this.rangeSelectionEnd) {
      // No existing selection, so create one for this comment
      const actualEndLine = endLineNumber || lineNumber;
      const minLine = Math.min(lineNumber, actualEndLine);
      const maxLine = Math.max(lineNumber, actualEndLine);

      // Set selection state (including side for GitHub API)
      this.rangeSelectionStart = {
        row: targetRow,
        lineNumber: minLine,
        fileName: fileName,
        side: side
      };
      this.rangeSelectionEnd = {
        row: targetRow,
        lineNumber: maxLine,
        fileName: fileName,
        side: side
      };

      // Highlight the line(s) (pass side to avoid highlighting both deleted and added lines with same line number)
      this.highlightLineRange(targetRow, targetRow, fileName, minLine, maxLine, side);
    }

    // Create comment form row
    const formRow = document.createElement('tr');
    formRow.className = 'comment-form-row';

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'comment-form-cell';

    // Determine if this is a range comment
    const isRange = endLineNumber && endLineNumber !== lineNumber;
    const lineRangeText = isRange ? `Lines ${lineNumber}-${endLineNumber}` : `Line ${lineNumber}`;

    // Check if this line has a diff position (needed for GitHub submission)
    const hasDiffPosition = diffPosition !== undefined && diffPosition !== null && diffPosition !== '';
    const expandedContextWarning = hasDiffPosition ? '' :
      `<div class="expanded-context-warning">⚠️ Expanded context line - may not submit to GitHub</div>`;

    const formHTML = `
      <div class="user-comment-form">
        <div class="comment-form-header">
          <span class="comment-icon">💬</span>
          <span class="comment-title">Add comment</span>
          ${isRange ? `<span class="line-range-indicator">${lineRangeText}</span>` : ''}
        </div>
        ${expandedContextWarning}
        <div class="comment-form-toolbar">
          <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M14.064 0a8.75 8.75 0 00-6.187 2.563l-.459.458c-.314.314-.616.641-.904.979H3.31a1.75 1.75 0 00-1.49.833L.11 7.607a.75.75 0 00.418 1.11l3.102.954c.037.051.079.1.124.145l2.429 2.428c.046.046.094.088.145.125l.954 3.102a.75.75 0 001.11.418l2.774-1.707a1.75 1.75 0 00.833-1.49V9.485c.338-.288.665-.59.979-.904l.458-.459A8.75 8.75 0 0016 1.936V1.75A1.75 1.75 0 0014.25 0h-.186zM10.5 10.625c-.088.06-.177.118-.266.175l-2.35 1.521.548 1.783 1.949-1.2a.25.25 0 00.119-.213v-2.066zM3.678 8.116L5.2 5.766c.058-.09.117-.178.176-.266H3.31a.25.25 0 00-.213.119l-1.2 1.95 1.782.547zm5.26-4.493A7.25 7.25 0 0114.063 1.5h.186a.25.25 0 01.25.25v.186a7.25 7.25 0 01-2.123 5.127l-.459.458a15.21 15.21 0 01-2.499 2.02l-2.317 1.5-2.143-2.143 1.5-2.317a15.25 15.25 0 012.02-2.5l.458-.458h.002zM12 5a1 1 0 11-2 0 1 1 0 012 0zm-8.44 9.56a1.5 1.5 0 10-2.12-2.12c-.734.73-1.047 2.332-1.15 3.003a.23.23 0 00.265.265c.671-.103 2.273-.416 3.005-1.148z"></path>
            </svg>
          </button>
        </div>
        <textarea
          class="comment-textarea"
          placeholder="Leave a comment... (Cmd/Ctrl+Enter to save)"
          data-line="${lineNumber}"
          data-line-end="${endLineNumber || lineNumber}"
          data-file="${fileName}"
          data-diff-position="${diffPosition || ''}"
          data-side="${side}"
        ></textarea>
        <div class="comment-form-actions">
          <button class="btn btn-sm btn-primary save-comment-btn">Save</button>
          <button class="btn btn-sm btn-secondary cancel-comment-btn">Cancel</button>
          <span class="draft-indicator">Draft saved</span>
        </div>
      </div>
    `;

    td.innerHTML = formHTML;
    formRow.appendChild(td);

    // Insert form after the target row
    targetRow.parentNode.insertBefore(formRow, targetRow.nextSibling);

    // Focus on textarea
    const textarea = td.querySelector('.comment-textarea');
    textarea.focus();

    // Add event listeners
    const saveBtn = td.querySelector('.save-comment-btn');
    const cancelBtn = td.querySelector('.cancel-comment-btn');
    const suggestionBtn = td.querySelector('.suggestion-btn');

    saveBtn.addEventListener('click', () => this.saveUserComment(textarea, formRow));
    cancelBtn.addEventListener('click', () => {
      this.hideCommentForm();
      this.clearRangeSelection();
    });

    // Suggestion button handler
    suggestionBtn.addEventListener('click', () => {
      if (!suggestionBtn.disabled) {
        this.insertSuggestionBlock(textarea, suggestionBtn);
      }
    });

    // Initialize textarea height and suggestion button state
    this.autoResizeTextarea(textarea);
    this.updateSuggestionButtonState(textarea, suggestionBtn);

    // Auto-save on input, auto-resize textarea, and update suggestion button state
    textarea.addEventListener('input', () => {
      this.autoSaveComment(textarea);
      this.autoResizeTextarea(textarea);
      this.updateSuggestionButtonState(textarea, suggestionBtn);
    });

    // Keyboard shortcuts (Escape, Cmd/Ctrl+Enter) are handled by delegated
    // event listener in setupCommentFormDelegation() to avoid memory leaks

    // Store reference for cleanup
    this.currentCommentForm = formRow;
  }
  
  /**
   * Hide any open comment form
   */
  hideCommentForm() {
    if (this.currentCommentForm) {
      this.currentCommentForm.remove();
      this.currentCommentForm = null;
    }
    // Note: Don't clear range selection here - let the caller decide
  }
  
  /**
   * Auto-save comment draft
   */
  autoSaveComment(textarea) {
    const fileName = textarea.dataset.file;
    const lineNumber = textarea.dataset.line;
    const content = textarea.value.trim();
    
    if (!content) return;
    
    // Save to localStorage as draft
    const draftKey = `draft_${this.currentPR?.number}_${fileName}_${lineNumber}`;
    localStorage.setItem(draftKey, content);
    
    // Show draft indicator
    const indicator = textarea.closest('.user-comment-form, .user-comment')?.querySelector('.draft-indicator');
    if (indicator) {
      indicator.style.display = 'inline';
      setTimeout(() => {
        indicator.style.display = 'none';
      }, 2000);
    }
  }

  /**
   * Auto-resize textarea to fit content
   * @param {HTMLTextAreaElement} textarea - The textarea to resize
   * @param {number} minRows - Minimum number of rows (default 4)
   */
  autoResizeTextarea(textarea, minRows = 4) {
    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = 'auto';

    // Get line height from computed styles
    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(computedStyle.lineHeight) || 20;
    const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
    const borderTop = parseFloat(computedStyle.borderTopWidth) || 0;
    const borderBottom = parseFloat(computedStyle.borderBottomWidth) || 0;

    // Calculate minimum height based on minRows
    const minHeight = (lineHeight * minRows) + paddingTop + paddingBottom + borderTop + borderBottom;

    // Set height to max of scrollHeight or minHeight
    const newHeight = Math.max(textarea.scrollHeight, minHeight);
    textarea.style.height = `${newHeight}px`;
  }

  /**
   * Get code content from diff lines in a range
   * @param {string} fileName - The file name
   * @param {number} startLine - Start line number
   * @param {number} endLine - End line number
   * @returns {string} The code content from the lines
   */
  getCodeFromLines(fileName, startLine, endLine) {
    // Find the file wrapper
    const fileWrappers = document.querySelectorAll('.d2h-file-wrapper');
    let targetWrapper = null;

    for (const wrapper of fileWrappers) {
      if (wrapper.dataset.fileName === fileName) {
        targetWrapper = wrapper;
        break;
      }
    }

    if (!targetWrapper) {
      console.warn(`[Suggestion] Could not find file wrapper for ${fileName}`);
      return '';
    }

    // Find all rows in the line range
    const rows = targetWrapper.querySelectorAll('tr[data-line-number]');
    const codeLines = [];

    for (const row of rows) {
      const lineNum = parseInt(row.dataset.lineNumber, 10);
      if (lineNum >= startLine && lineNum <= endLine && row.dataset.fileName === fileName) {
        // Get the code content cell
        const codeCell = row.querySelector('.d2h-code-line-ctn');
        if (codeCell) {
          // Get text content, preserving whitespace but removing any HTML
          codeLines.push(codeCell.textContent);
        }
      }
    }

    return codeLines.join('\n');
  }

  /**
   * Check if a suggestion block already exists in the textarea
   * @param {string} text - The textarea content
   * @returns {boolean} True if a suggestion block exists
   */
  hasSuggestionBlock(text) {
    // Match both ``` and ```` suggestion blocks, allowing leading whitespace
    return /^\s*(`{3,})suggestion\s*$/m.test(text);
  }

  /**
   * Update the suggestion button state based on textarea content
   * Disables the button if a suggestion block already exists
   * @param {HTMLTextAreaElement} textarea - The textarea to check
   * @param {HTMLButtonElement} button - The suggestion button
   */
  updateSuggestionButtonState(textarea, button) {
    if (!button) return;
    const hasSuggestion = this.hasSuggestionBlock(textarea.value);
    button.disabled = hasSuggestion;
    button.title = hasSuggestion ? 'Only one suggestion per comment' : 'Insert a suggestion';
  }

  /**
   * Insert a suggestion block into the textarea at cursor position
   * Pre-fills with code from the selected lines
   * @param {HTMLTextAreaElement} textarea - The textarea to insert into
   * @param {HTMLButtonElement} [button] - Optional suggestion button to disable after insert
   */
  insertSuggestionBlock(textarea, button) {
    // Check if suggestion already exists
    if (this.hasSuggestionBlock(textarea.value)) {
      return;
    }

    const fileName = textarea.dataset.file;
    const startLine = parseInt(textarea.dataset.line, 10);
    const endLine = parseInt(textarea.dataset.lineEnd, 10) || startLine;

    // Get the code from the selected lines
    const code = this.getCodeFromLines(fileName, startLine, endLine);

    // Build the suggestion block
    // Use 4 backticks if the code contains triple backticks
    const backticks = code.includes('```') ? '````' : '```';
    const suggestionBlock = `${backticks}suggestion\n${code}\n${backticks}`;

    // Get current cursor position
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    // Insert at cursor position (or replace selection)
    const before = text.substring(0, start);
    const after = text.substring(end);

    // Add newlines if needed for clean formatting
    const needsNewlineBefore = before.length > 0 && !before.endsWith('\n');
    const needsNewlineAfter = after.length > 0 && !after.startsWith('\n');

    const prefix = needsNewlineBefore ? '\n' : '';
    const suffix = needsNewlineAfter ? '\n' : '';

    textarea.value = before + prefix + suggestionBlock + suffix + after;

    // Position cursor inside the suggestion block (at the start of the code)
    const newCursorPos = start + prefix.length + backticks.length + 'suggestion\n'.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos + code.length);
    textarea.focus();

    // Trigger auto-resize
    this.autoResizeTextarea(textarea);

    // Disable the suggestion button
    if (button) {
      this.updateSuggestionButtonState(textarea, button);
    }
  }

  /**
   * Save user comment
   */
  async saveUserComment(textarea, formRow) {
    const fileName = textarea.dataset.file;
    const lineNumber = parseInt(textarea.dataset.line);
    // Validate endLineNumber, fallback to lineNumber if invalid
    const parsedEndLine = parseInt(textarea.dataset.lineEnd);
    const endLineNumber = !isNaN(parsedEndLine) ? parsedEndLine : lineNumber;
    const diffPosition = textarea.dataset.diffPosition ? parseInt(textarea.dataset.diffPosition) : null;
    // Get the side for GitHub API (LEFT for deleted lines, RIGHT for added/context)
    const side = textarea.dataset.side || 'RIGHT';
    const content = textarea.value.trim();

    if (!content) {
      alert('Please enter a comment');
      return;
    }

    try {
      const response = await fetch('/api/user-comment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          pr_id: this.currentPR.id,
          file: fileName,
          line_start: lineNumber,
          line_end: endLineNumber,
          diff_position: diffPosition,
          side: side,
          commit_sha: this.currentPR.head_sha,  // Anchor comment to PR head commit
          body: content
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save comment');
      }

      const result = await response.json();

      // Clear draft
      const draftKey = `draft_${this.currentPR?.number}_${fileName}_${lineNumber}`;
      localStorage.removeItem(draftKey);

      // Create comment display row
      this.displayUserComment({
        id: result.commentId,
        file: fileName,
        line_start: lineNumber,
        line_end: endLineNumber,
        diff_position: diffPosition,  // Include for expanded context warning logic
        body: content,
        created_at: new Date().toISOString()
      }, formRow.previousElementSibling);

      // Hide form and clear selection
      this.hideCommentForm();
      this.clearRangeSelection();

      // Update comment count
      this.updateCommentCount();
      
    } catch (error) {
      console.error('Error saving comment:', error);
      alert('Failed to save comment');
    }
  }
  
  /**
   * Display a user comment inline
   */
  displayUserComment(comment, targetRow) {
    const commentRow = document.createElement('tr');
    commentRow.className = 'user-comment-row';
    commentRow.dataset.commentId = comment.id;
    // Store file/line data for editing
    commentRow.dataset.file = comment.file;
    commentRow.dataset.lineStart = comment.line_start;
    commentRow.dataset.lineEnd = comment.line_end || comment.line_start;

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'user-comment-cell';
    
    // Format line info
    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    // WORKAROUND: Comments on expanded context lines (outside diff hunks) will be
    // submitted as file-level comments since GitHub's API doesn't support line-level
    // comments on these lines. Show an indicator to inform the user.
    const isExpandedContext = comment.diff_position === null || comment.diff_position === undefined;
    const expandedContextIndicator = isExpandedContext
      ? `<span class="expanded-context-indicator" title="This expanded context comment will be posted to GitHub as a file-level comment">
           <svg viewBox="0 0 16 16" width="14" height="14">
             <path fill-rule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z"></path>
           </svg>
         </span>`
      : '';

    // Build metadata display for adopted comments
    // Only show "Nice Work" badge for praise - skip "AI Suggestion" badge since collapsed original is visible above
    let metadataHTML = '';
    if (comment.parent_id && comment.type && comment.type !== 'comment') {
      const badgeHTML = comment.type === 'praise'
        ? `<span class="adopted-praise-badge" title="Nice Work"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
        : '';
      metadataHTML = `
        ${badgeHTML}
        ${comment.title ? `<span class="adopted-title">${this.escapeHtml(comment.title)}</span>` : ''}
      `;
    }
    
    const commentHTML = `
      <div class="user-comment ${comment.parent_id ? 'adopted-comment' : ''}">
        <div class="user-comment-header">
          <span class="comment-icon">
            <svg class="octicon octicon-comment" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"></path>
            </svg>
          </span>
          <span class="user-comment-line-info">${lineInfo}</span>
          ${expandedContextIndicator}
          ${metadataHTML}
          <span class="user-comment-timestamp">${new Date(comment.created_at).toLocaleString()}</span>
          <div class="user-comment-actions">
            <button class="btn-edit-comment" onclick="prManager.editUserComment(${comment.id})" title="Edit comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"></path>
              </svg>
            </button>
            <button class="btn-delete-comment" onclick="prManager.deleteUserComment(${comment.id})" title="Delete comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="user-comment-body" data-original-markdown="${this.escapeHtml(comment.body)}">${window.renderMarkdown ? window.renderMarkdown(comment.body) : this.escapeHtml(comment.body)}</div>
      </div>
    `;
    
    td.innerHTML = commentHTML;
    commentRow.appendChild(td);
    
    // Insert comment after the target row
    targetRow.parentNode.insertBefore(commentRow, targetRow.nextSibling);
  }
  
  /**
   * Display a user comment in edit mode (for adopted suggestions)
   */
  displayUserCommentInEditMode(comment, targetRow) {
    const commentRow = document.createElement('tr');
    commentRow.className = 'user-comment-row';
    commentRow.dataset.commentId = comment.id;
    // Store file/line data for editing
    commentRow.dataset.file = comment.file;
    commentRow.dataset.lineStart = comment.line_start;
    commentRow.dataset.lineEnd = comment.line_end || comment.line_start;

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'user-comment-cell';

    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    const commentHTML = `
      <div class="user-comment editing-mode ${comment.parent_id ? 'adopted-comment' : ''}">
        <div class="user-comment-header">
          <span class="comment-icon">
            <svg class="octicon octicon-comment" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"></path>
            </svg>
          </span>
          <span class="user-comment-line-info">${lineInfo}</span>
          ${comment.type === 'praise' ? `<span class="adopted-praise-badge" title="Nice Work"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>` : ''}
          ${comment.title ? `<span class="adopted-title">${this.escapeHtml(comment.title)}</span>` : ''}
          <span class="user-comment-timestamp">Editing comment...</span>
          <div class="user-comment-actions">
            <button class="btn-edit-comment" onclick="prManager.editUserComment(${comment.id})" title="Edit comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"></path>
              </svg>
            </button>
            <button class="btn-delete-comment" onclick="prManager.deleteUserComment(${comment.id})" title="Delete comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>
              </svg>
            </button>
          </div>
        </div>
        <!-- Hidden body div for saving - pre-populate with markdown rendered content and store original -->
        <div class="user-comment-body" style="display: none;" data-original-markdown="${this.escapeHtml(comment.body)}">${window.renderMarkdown ? window.renderMarkdown(comment.body) : this.escapeHtml(comment.body)}</div>
        <div class="user-comment-edit-form">
          <div class="comment-form-toolbar">
            <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion (Ctrl+G)">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M14.064 0a8.75 8.75 0 00-6.187 2.563l-.459.458c-.314.314-.616.641-.904.979H3.31a1.75 1.75 0 00-1.49.833L.11 7.607a.75.75 0 00.418 1.11l3.102.954c.037.051.079.1.124.145l2.429 2.428c.046.046.094.088.145.125l.954 3.102a.75.75 0 001.11.418l2.774-1.707a1.75 1.75 0 00.833-1.49V9.485c.338-.288.665-.59.979-.904l.458-.459A8.75 8.75 0 0016 1.936V1.75A1.75 1.75 0 0014.25 0h-.186zM10.5 10.625c-.088.06-.177.118-.266.175l-2.35 1.521.548 1.783 1.949-1.2a.25.25 0 00.119-.213v-2.066zM3.678 8.116L5.2 5.766c.058-.09.117-.178.176-.266H3.31a.25.25 0 00-.213.119l-1.2 1.95 1.782.547zm5.26-4.493A7.25 7.25 0 0114.063 1.5h.186a.25.25 0 01.25.25v.186a7.25 7.25 0 01-2.123 5.127l-.459.458a15.21 15.21 0 01-2.499 2.02l-2.317 1.5-2.143-2.143 1.5-2.317a15.25 15.25 0 012.02-2.5l.458-.458h.002zM12 5a1 1 0 11-2 0 1 1 0 012 0zm-8.44 9.56a1.5 1.5 0 10-2.12-2.12c-.734.73-1.047 2.332-1.15 3.003a.23.23 0 00.265.265c.671-.103 2.273-.416 3.005-1.148z"></path>
              </svg>
            </button>
          </div>
          <textarea
            id="edit-comment-${comment.id}"
            class="comment-edit-textarea"
            placeholder="Enter your comment..."
            data-file="${comment.file}"
            data-line="${comment.line_start}"
            data-line-end="${comment.line_end || comment.line_start}"
          >${this.escapeHtml(comment.body)}</textarea>
          <div class="comment-edit-actions">
            <button class="btn btn-sm btn-primary save-edit-btn">
              Save comment
            </button>
            <button class="btn btn-sm btn-secondary cancel-edit-btn">
              Cancel
            </button>
          </div>
        </div>
      </div>
    `;

    td.innerHTML = commentHTML;
    commentRow.appendChild(td);

    // Insert comment immediately after the target row (suggestion row)
    if (targetRow.nextSibling) {
      targetRow.parentNode.insertBefore(commentRow, targetRow.nextSibling);
    } else {
      targetRow.parentNode.appendChild(commentRow);
    }

    // Get references
    const editForm = td.querySelector('.user-comment-edit-form');
    const textarea = document.getElementById(`edit-comment-${comment.id}`);
    const suggestionBtn = editForm.querySelector('.suggestion-btn');
    const saveBtn = editForm.querySelector('.save-edit-btn');
    const cancelBtn = editForm.querySelector('.cancel-edit-btn');

    if (textarea) {
      // Auto-resize to fit content
      this.autoResizeTextarea(textarea);

      textarea.focus();
      // Position cursor at end of text instead of selecting all
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      // Update suggestion button state based on content
      this.updateSuggestionButtonState(textarea, suggestionBtn);

      // Suggestion button handler
      suggestionBtn.addEventListener('click', () => {
        if (!suggestionBtn.disabled) {
          this.insertSuggestionBlock(textarea, suggestionBtn);
        }
      });

      // Save/cancel handlers
      saveBtn.addEventListener('click', () => this.saveEditedUserComment(comment.id));
      cancelBtn.addEventListener('click', () => this.cancelEditUserComment(comment.id));

      // Auto-resize on input and update suggestion button state
      textarea.addEventListener('input', () => {
        this.autoResizeTextarea(textarea);
        this.updateSuggestionButtonState(textarea, suggestionBtn);
      });

      // Keyboard shortcuts (Escape, Cmd/Ctrl+Enter) are handled by delegated
      // event listener in setupCommentFormDelegation() to avoid memory leaks
    }
  }

  /**
   * Edit user comment
   */
  async editUserComment(commentId) {
    try {
      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (!commentRow) {
        console.error('Comment row not found');
        return;
      }
      
      const commentDiv = commentRow.querySelector('.user-comment');
      const bodyDiv = commentDiv.querySelector('.user-comment-body');
      // Get the original markdown text from data attribute, or fetch from server
      let currentText = bodyDiv.dataset.originalMarkdown || '';
      
      if (!currentText) {
        // If we don't have the original markdown, fetch it from the server
        const response = await fetch(`/api/user-comment/${commentId}`);
        if (response.ok) {
          const data = await response.json();
          currentText = data.body || bodyDiv.textContent.trim();
        } else {
          // Fallback to text content if we can't get the original
          currentText = bodyDiv.textContent.trim();
        }
      }
      
      // Prevent double editor - check if already in editing mode
      if (commentDiv.classList.contains('editing-mode')) {
        console.log('[UI] Already in editing mode, ignoring');
        return;
      }

      // Add editing mode
      commentDiv.classList.add('editing-mode');

      // Get file/line data from comment row
      const fileName = commentRow.dataset.file || '';
      const lineStart = commentRow.dataset.lineStart || '';
      const lineEnd = commentRow.dataset.lineEnd || lineStart;

      // Replace body with edit form
      const editFormHTML = `
        <div class="user-comment-edit-form">
          <div class="comment-form-toolbar">
            <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion (Ctrl+G)">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M14.064 0a8.75 8.75 0 00-6.187 2.563l-.459.458c-.314.314-.616.641-.904.979H3.31a1.75 1.75 0 00-1.49.833L.11 7.607a.75.75 0 00.418 1.11l3.102.954c.037.051.079.1.124.145l2.429 2.428c.046.046.094.088.145.125l.954 3.102a.75.75 0 001.11.418l2.774-1.707a1.75 1.75 0 00.833-1.49V9.485c.338-.288.665-.59.979-.904l.458-.459A8.75 8.75 0 0016 1.936V1.75A1.75 1.75 0 0014.25 0h-.186zM10.5 10.625c-.088.06-.177.118-.266.175l-2.35 1.521.548 1.783 1.949-1.2a.25.25 0 00.119-.213v-2.066zM3.678 8.116L5.2 5.766c.058-.09.117-.178.176-.266H3.31a.25.25 0 00-.213.119l-1.2 1.95 1.782.547zm5.26-4.493A7.25 7.25 0 0114.063 1.5h.186a.25.25 0 01.25.25v.186a7.25 7.25 0 01-2.123 5.127l-.459.458a15.21 15.21 0 01-2.499 2.02l-2.317 1.5-2.143-2.143 1.5-2.317a15.25 15.25 0 012.02-2.5l.458-.458h.002zM12 5a1 1 0 11-2 0 1 1 0 012 0zm-8.44 9.56a1.5 1.5 0 10-2.12-2.12c-.734.73-1.047 2.332-1.15 3.003a.23.23 0 00.265.265c.671-.103 2.273-.416 3.005-1.148z"></path>
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
            <button class="btn btn-sm btn-primary save-edit-btn">
              Save comment
            </button>
            <button class="btn btn-sm btn-secondary cancel-edit-btn">
              Cancel
            </button>
          </div>
        </div>
      `;

      // Hide body and insert edit form
      bodyDiv.style.display = 'none';
      bodyDiv.insertAdjacentHTML('afterend', editFormHTML);

      // Get references
      const editForm = commentDiv.querySelector('.user-comment-edit-form');
      const textarea = document.getElementById(`edit-comment-${commentId}`);
      const suggestionBtn = editForm.querySelector('.suggestion-btn');
      const saveBtn = editForm.querySelector('.save-edit-btn');
      const cancelBtn = editForm.querySelector('.cancel-edit-btn');

      if (textarea) {
        // Auto-resize to fit content
        this.autoResizeTextarea(textarea);

        textarea.focus();
        // Position cursor at end of text instead of selecting all
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);

        // Update suggestion button state based on content
        this.updateSuggestionButtonState(textarea, suggestionBtn);

        // Suggestion button handler
        suggestionBtn.addEventListener('click', () => {
          if (!suggestionBtn.disabled) {
            this.insertSuggestionBlock(textarea, suggestionBtn);
          }
        });

        // Save/cancel handlers
        saveBtn.addEventListener('click', () => this.saveEditedUserComment(commentId));
        cancelBtn.addEventListener('click', () => this.cancelEditUserComment(commentId));

        // Auto-resize on input and update suggestion button state
        textarea.addEventListener('input', () => {
          this.autoResizeTextarea(textarea);
          this.updateSuggestionButtonState(textarea, suggestionBtn);
        });

        // Keyboard shortcuts (Escape, Cmd/Ctrl+Enter) are handled by delegated
        // event listener in setupCommentFormDelegation() to avoid memory leaks
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
      
      // Update via API
      const response = await fetch(`/api/user-comment/${commentId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ body: editedText })
      });
      
      if (!response.ok) {
        throw new Error('Failed to update comment');
      }
      
      // Update the UI
      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      const commentDiv = commentRow.querySelector('.user-comment');
      let bodyDiv = commentDiv.querySelector('.user-comment-body');
      const editForm = commentDiv.querySelector('.user-comment-edit-form');
      
      // If no body div exists (new comment), create one
      if (!bodyDiv) {
        bodyDiv = document.createElement('div');
        bodyDiv.className = 'user-comment-body';
        commentDiv.appendChild(bodyDiv);
      }
      
      // Update body text with markdown rendering and show it
      const trimmedText = editedText.trim();
      bodyDiv.innerHTML = window.renderMarkdown ? window.renderMarkdown(trimmedText) : this.escapeHtml(trimmedText);
      // Store the original markdown for future edits
      bodyDiv.dataset.originalMarkdown = trimmedText;
      bodyDiv.style.display = '';
      
      // Remove edit form and editing class
      if (editForm) {
        editForm.remove();
      }
      commentDiv.classList.remove('editing-mode');
      
      // Update timestamp
      const timestamp = commentDiv.querySelector('.user-comment-timestamp');
      if (timestamp) {
        timestamp.textContent = new Date().toLocaleString();
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

    // Show body and remove edit form
    bodyDiv.style.display = '';
    if (editForm) {
      editForm.remove();
    }

    // Remove editing class
    commentDiv.classList.remove('editing-mode');

    // Fix stale "Editing comment..." timestamp if present
    const timestamp = commentDiv.querySelector('.user-comment-timestamp');
    if (timestamp && timestamp.textContent === 'Editing comment...') {
      timestamp.textContent = 'Draft';
    }
  }
  
  /**
   * Delete user comment
   */
  async deleteUserComment(commentId) {
    // Check that confirmDialog is available
    if (!window.confirmDialog) {
      console.error('ConfirmDialog not loaded');
      alert('Confirmation dialog unavailable. Please refresh the page.');
      return;
    }

    // Show confirmation dialog
    const confirmed = await window.confirmDialog.show({
      title: 'Delete Comment?',
      message: 'Are you sure you want to delete this comment? This action cannot be undone.',
      confirmText: 'Delete',
      confirmClass: 'btn-danger'
    });

    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/user-comment/${commentId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete comment');
      }

      // Remove comment from UI
      const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (commentRow) {
        commentRow.remove();
        // Update comment count
        this.updateCommentCount();
      }

    } catch (error) {
      console.error('Error deleting comment:', error);
      alert('Failed to delete comment');
    }
  }

  /**
   * Clear all user comments for the current PR
   */
  async clearAllUserComments() {
    // Count existing user comments
    const userComments = document.querySelectorAll('.user-comment-row');
    const commentCount = userComments.length;

    if (commentCount === 0) {
      return;
    }

    // Check that confirmDialog is available
    if (!window.confirmDialog) {
      console.error('ConfirmDialog not loaded');
      alert('Confirmation dialog unavailable. Please refresh the page.');
      return;
    }

    // Show confirmation dialog
    const confirmed = await window.confirmDialog.show({
      title: 'Clear All Comments?',
      message: `This will delete all ${commentCount} user comment${commentCount !== 1 ? 's' : ''} from this PR. This action cannot be undone.`,
      confirmText: 'Delete All',
      confirmClass: 'btn-danger'
    });

    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/user-comments`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete comments');
      }

      // Remove all user comment rows from UI
      userComments.forEach(row => row.remove());

      // Update comment count and button state
      this.updateCommentCount();

    } catch (error) {
      console.error('Error clearing user comments:', error);
      alert('Failed to clear comments');
    }
  }

  /**
   * Toggle visibility of original AI suggestion for adopted comments
   */
  toggleOriginalSuggestion(parentId, commentId) {
    try {
      // Find the original AI suggestion row
      const suggestionRow = document.querySelector(`[data-suggestion-id="${parentId}"]`);
      if (!suggestionRow) {
        console.warn('Original suggestion row not found');
        return;
      }
      
      // Toggle visibility
      if (suggestionRow.style.display === 'none') {
        // Show the suggestion
        suggestionRow.style.display = '';
        
        // Update eye icon to indicate it's open
        const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
        if (commentRow) {
          const eyeButton = commentRow.querySelector('.btn-toggle-original');
          if (eyeButton) {
            eyeButton.classList.add('showing-original');
            eyeButton.title = 'Hide original AI suggestion';
          }
        }
      } else {
        // Hide the suggestion
        suggestionRow.style.display = 'none';
        
        // Update eye icon to indicate it's closed
        const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
        if (commentRow) {
          const eyeButton = commentRow.querySelector('.btn-toggle-original');
          if (eyeButton) {
            eyeButton.classList.remove('showing-original');
            eyeButton.title = 'Show original AI suggestion';
          }
        }
      }
    } catch (error) {
      console.error('Error toggling original suggestion:', error);
    }
  }
  
  /**
   * Open review submission modal
   */
  openReviewModal() {
    if (!this.reviewModal) {
      this.reviewModal = new ReviewModal();
    }
    this.reviewModal.show();
  }

  /**
   * Open preview comments modal
   */
  openPreviewModal() {
    if (!this.previewModal) {
      this.previewModal = new PreviewModal();
    }
    this.previewModal.show();
  }

  /**
   * Update comment count in review button
   */
  updateCommentCount() {
    const userComments = document.querySelectorAll('.user-comment-row').length;

    // Update split button if available
    if (this.splitButton) {
      this.splitButton.updateCommentCount(userComments);
    }

    // Fallback: Update legacy review button if it exists (for compatibility)
    const reviewButton = document.getElementById('review-button');
    if (reviewButton) {
      const buttonText = reviewButton.querySelector('.review-button-text');
      if (buttonText) {
        buttonText.textContent = `${userComments} ${userComments === 1 ? 'comment' : 'comments'}`;
      }

      // Update button styling based on comment count
      if (userComments > 0) {
        reviewButton.classList.add('has-comments');
      } else {
        reviewButton.classList.remove('has-comments');
      }
    }

    // Fallback: Update legacy Clear Comments button state if it exists
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
    
    // Validate
    if (reviewEvent === 'REQUEST_CHANGES' && !reviewBody && document.querySelectorAll('.user-comment-row').length === 0) {
      alert('Please add comments or a review summary when requesting changes.');
      return;
    }
    
    // Show loading state
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Submitting...';
    submitBtn.disabled = true;
    
    try {
      const response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/submit-review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event: reviewEvent,
          body: reviewBody
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to submit review');
      }
      
      const result = await response.json();
      
      // Show success message
      alert(`Review submitted successfully! ${result.message}`);
      
      // Reset form
      document.getElementById('review-body').value = '';
      document.getElementById('review-event').value = 'COMMENT';
      
    } catch (error) {
      console.error('Error submitting review:', error);
      alert(`Failed to submit review: ${error.message}`);
      
    } finally {
      // Restore button
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  }

  /**
   * Escape HTML characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get description for suggestion type
   */
  getTypeDescription(type) {
    const descriptions = {
      bug: "Errors, crashes, or incorrect behavior",
      improvement: "Enhancements to make code better",
      praise: "Good practices worth highlighting",
      suggestion: "General recommendations to consider",
      design: "Architecture and structural concerns",
      performance: "Speed and efficiency optimizations",
      security: "Vulnerabilities or safety issues",
      "code-style": "Formatting, naming, and conventions",
      style: "Formatting, naming, and conventions" // backward compatibility
    };
    
    return descriptions[type] || "General feedback";
  }

  /**
   * Build hierarchical file tree from flat file list
   * @param {Array} files - Array of file objects
   * @returns {Object} Tree structure
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
          if (!current[part]) {
            current[part] = {};
          }
          current = current[part];
        }
      }
    });

    return tree;
  }

  /**
   * Determine file status from file data
   * @param {Object} file - File data
   * @returns {string} Status (added, modified, deleted)
   */
  getFileStatus(file) {
    if (file.binary) return 'modified';
    if (!file.deletions || file.deletions === 0) return 'added';
    if (!file.insertions || file.insertions === 0) return 'deleted';
    return 'modified';
  }

  /**
   * Render tree node (folder or file)
   * @param {string} name - Node name
   * @param {Object} node - Node data
   * @param {string} fullPath - Full path to node
   * @param {number} level - Indentation level
   * @returns {Array} Array of DOM elements
   */
  renderTreeNode(name, node, fullPath = '', level = 0) {
    const elements = [];
    const indent = level * 16;
    
    // Render folder
    if (typeof node === 'object' && !Array.isArray(node)) {
      const hasChildren = Object.keys(node).some(key => key !== '_files') || node._files?.length > 0;
      
      if (name) { // Don't render root folder
        const folderDiv = document.createElement('div');
        folderDiv.className = 'tree-item tree-folder';
        folderDiv.style.paddingLeft = `${indent}px`;
        folderDiv.dataset.path = fullPath;
        
        const folderContent = document.createElement('div');
        folderContent.className = 'tree-item-content';
        
        // Chevron icon for expand/collapse
        if (hasChildren) {
          const chevron = document.createElement('span');
          chevron.className = 'tree-chevron';
          chevron.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M4.7 10c-.2 0-.4-.1-.5-.2-.3-.3-.3-.8 0-1.1L6.9 6 4.2 3.3c-.3-.3-.3-.8 0-1.1.3-.3.8-.3 1.1 0l3.3 3.3c.3.3.3.8 0 1.1L5.3 9.8c-.2.1-.4.2-.6.2Z"/>
            </svg>
          `;
          folderContent.appendChild(chevron);
        }
        
        // Folder icon
        const folderIcon = document.createElement('span');
        folderIcon.className = 'tree-icon folder-icon';
        folderIcon.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"></path>
          </svg>
        `;
        
        const folderName = document.createElement('span');
        folderName.className = 'tree-name';
        folderName.textContent = name;
        
        folderContent.appendChild(folderIcon);
        folderContent.appendChild(folderName);
        folderDiv.appendChild(folderContent);
        
        // Add click handler for expand/collapse
        if (hasChildren) {
          folderContent.addEventListener('click', (e) => {
            e.stopPropagation();
            const isExpanded = folderDiv.classList.contains('expanded');
            
            if (isExpanded) {
              folderDiv.classList.remove('expanded');
              this.expandedFolders.delete(fullPath);
            } else {
              folderDiv.classList.add('expanded');
              this.expandedFolders.add(fullPath);
            }
          });
          
          // Expand by default (can be customized later)
          folderDiv.classList.add('expanded');
          this.expandedFolders.add(fullPath);
        }
        
        elements.push(folderDiv);
      }
      
      // Create a container for child elements if folder has children
      const hasChildFolders = Object.keys(node).some(key => key !== '_files');
      const hasFiles = node._files && node._files.length > 0;
      
      if ((hasChildFolders || hasFiles) && name) {
        // For folders with children, wrap them in a tree-child container
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-child';
        childContainer.dataset.parentPath = fullPath;
        
        // Render child folders first
        Object.keys(node).forEach(key => {
          if (key !== '_files') {
            const childPath = fullPath ? `${fullPath}/${key}` : key;
            const childElements = this.renderTreeNode(key, node[key], childPath, level + 1);
            childElements.forEach(el => childContainer.appendChild(el));
          }
        });
        
        // Render files in this folder
        if (node._files) {
          node._files.forEach(file => {
            const fileDiv = document.createElement('div');
            fileDiv.className = 'tree-item tree-file';
            if (file.generated) {
              fileDiv.classList.add('generated');
            }
            fileDiv.style.paddingLeft = `${(level + 1) * 16}px`;
            fileDiv.dataset.path = file.fullPath;

            const fileContent = document.createElement('div');
            fileContent.className = 'tree-item-content';

            // File icon
            const fileIcon = document.createElement('span');
            fileIcon.className = 'tree-icon file-icon';
            fileIcon.innerHTML = `
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>
              </svg>
            `;

            const fileName = document.createElement('span');
            fileName.className = 'tree-name';
            fileName.textContent = file.name;

            // Generated indicator (shows before status)
            if (file.generated) {
              const generatedIndicator = document.createElement('span');
              generatedIndicator.className = 'file-generated-indicator';
              generatedIndicator.title = 'Generated file';
              generatedIndicator.innerHTML = PRManager.GENERATED_FILE_ICON;
              fileContent.appendChild(generatedIndicator);
            }

            // File status indicator
            const statusIndicator = document.createElement('span');
            statusIndicator.className = `file-status ${file.status}`;

            fileContent.appendChild(fileIcon);
            fileContent.appendChild(fileName);
            fileContent.appendChild(statusIndicator);
            fileDiv.appendChild(fileContent);

            // Add click handler to scroll to file
            fileContent.addEventListener('click', (e) => {
              e.stopPropagation();
              this.scrollToFile(file.fullPath);
              this.setActiveFile(file.fullPath);
            });

            childContainer.appendChild(fileDiv);
          });
        }
        
        // Add the child container to elements
        elements.push(childContainer);
      } else if (!name) {
        // For root level, render children without wrapping
        Object.keys(node).forEach(key => {
          if (key !== '_files') {
            const childPath = key;
            const childElements = this.renderTreeNode(key, node[key], childPath, level + 1);
            elements.push(...childElements);
          }
        });
        
        // Render root level files
        if (node._files) {
          node._files.forEach(file => {
            const fileDiv = document.createElement('div');
            fileDiv.className = 'tree-item tree-file';
            fileDiv.style.paddingLeft = `${(level + 1) * 16}px`;
            fileDiv.dataset.path = file.fullPath;
            
            const fileContent = document.createElement('div');
            fileContent.className = 'tree-item-content';
            
            // File icon
            const fileIcon = document.createElement('span');
            fileIcon.className = 'tree-icon file-icon';
            fileIcon.innerHTML = `
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>
              </svg>
            `;
            
            const fileName = document.createElement('span');
            fileName.className = 'tree-name';
            fileName.textContent = file.name;
            
            // File status indicator
            const statusIndicator = document.createElement('span');
            statusIndicator.className = `file-status ${file.status}`;
            
            fileContent.appendChild(fileIcon);
            fileContent.appendChild(fileName);
            fileContent.appendChild(statusIndicator);
            fileDiv.appendChild(fileContent);
            
            // Add click handler to scroll to file
            fileContent.addEventListener('click', (e) => {
              e.stopPropagation();
              this.scrollToFile(file.fullPath);
              this.setActiveFile(file.fullPath);
            });
            
            elements.push(fileDiv);
          });
        }
      }
    }
    
    return elements;
  }

  /**
   * Update file list in sidebar
   * @param {Array} files - Array of changed files
   */
  updateFileList(files) {
    const fileListContainer = document.getElementById('file-list');
    if (!fileListContainer) return;

    if (files.length === 0) {
      fileListContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--color-text-secondary);">No files changed</div>';
      return;
    }

    // Group files by directory using the new prototype-style layout
    const groupedFiles = this.groupFilesByDirectory(files);

    fileListContainer.innerHTML = '';

    // Render each directory group
    for (const [dirPath, dirFiles] of Object.entries(groupedFiles)) {
      const groupElement = this.renderFileGroup(dirPath, dirFiles);
      fileListContainer.appendChild(groupElement);
    }

    // Setup sidebar toggle
    this.setupSidebarToggle();
  }

  /**
   * Group files by their parent directory
   * @param {Array} files - Array of file objects
   * @returns {Object} Files grouped by directory path
   */
  groupFilesByDirectory(files) {
    const groups = {};

    files.forEach(file => {
      const filePath = file.file;
      const lastSlashIndex = filePath.lastIndexOf('/');

      // Get directory path, or '.' for root-level files
      const dirPath = lastSlashIndex === -1 ? '.' : filePath.substring(0, lastSlashIndex);
      const fileName = lastSlashIndex === -1 ? filePath : filePath.substring(lastSlashIndex + 1);

      if (!groups[dirPath]) {
        groups[dirPath] = [];
      }

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

    // Sort groups by directory path
    const sortedGroups = {};
    Object.keys(groups).sort().forEach(key => {
      sortedGroups[key] = groups[key];
    });

    return sortedGroups;
  }

  /**
   * Render a file group with header and file items
   * @param {string} dirPath - Directory path
   * @param {Array} files - Files in this directory
   * @returns {HTMLElement} The file group element
   */
  renderFileGroup(dirPath, files) {
    const group = document.createElement('div');
    group.className = 'file-group';
    group.dataset.path = dirPath;

    // Create group header with chevron and folder icon
    const header = document.createElement('div');
    header.className = 'file-group-header';

    // Chevron for expand/collapse
    const chevron = document.createElement('span');
    chevron.className = 'file-group-chevron';
    chevron.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
        <path d="M4.7 10c-.2 0-.4-.1-.5-.2-.3-.3-.3-.8 0-1.1L6.9 6 4.2 3.3c-.3-.3-.3-.8 0-1.1.3-.3.8-.3 1.1 0l3.3 3.3c.3.3.3.8 0 1.1L5.3 9.8c-.2.1-.4.2-.6.2Z"/>
      </svg>
    `;

    const folderIcon = document.createElement('span');
    folderIcon.className = 'folder-icon';
    folderIcon.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
        <path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/>
      </svg>
    `;

    const dirName = document.createElement('span');
    dirName.textContent = dirPath === '.' ? '(root)' : dirPath;

    header.appendChild(chevron);
    header.appendChild(folderIcon);
    header.appendChild(dirName);
    group.appendChild(header);

    // Create file list container
    const fileList = document.createElement('div');
    fileList.className = 'file-group-items';

    // Render each file item
    files.forEach(file => {
      const fileItem = this.renderFileItem(file);
      fileList.appendChild(fileItem);
    });

    group.appendChild(fileList);

    // Default to expanded
    group.classList.add('expanded');

    // Add click handler for collapse/expand
    header.addEventListener('click', () => {
      group.classList.toggle('expanded');
    });

    return group;
  }

  /**
   * Render a single file item
   * @param {Object} file - File data
   * @returns {HTMLElement} The file item element
   */
  renderFileItem(file) {
    const item = document.createElement('a');
    item.className = 'file-item';
    item.href = `#${file.fullPath}`;
    item.dataset.path = file.fullPath;
    item.dataset.status = file.status;

    if (file.generated) {
      item.classList.add('generated');
    }

    // File name
    const fileName = document.createElement('span');
    fileName.className = 'file-name';
    fileName.textContent = file.name;

    // File changes indicator
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

    // Add click handler
    item.addEventListener('click', (e) => {
      e.preventDefault();
      this.scrollToFile(file.fullPath);
      this.setActiveFileItem(file.fullPath);
    });

    return item;
  }

  /**
   * Set active state on file item
   * @param {string} filePath - Path of the active file
   */
  setActiveFileItem(filePath) {
    // Remove previous active states
    document.querySelectorAll('.file-item.active').forEach(item => {
      item.classList.remove('active');
    });

    // Add active state to clicked file
    const fileItem = document.querySelector(`.file-item[data-path="${filePath}"]`);
    if (fileItem) {
      fileItem.classList.add('active');
    }
  }

  /**
   * Setup sidebar toggle functionality
   */
  setupSidebarToggle() {
    const sidebar = document.getElementById('files-sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const collapsedBtn = document.getElementById('sidebar-toggle-collapsed');
    
    if (!sidebar || !mainContent || !toggleBtn || !collapsedBtn) return;
    
    // Load saved state
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

  /**
   * Scroll to file section in diff
   * @param {string} filePath - Path of file to scroll to
   */
  scrollToFile(filePath) {
    const fileWrapper = document.querySelector(`[data-file-name="${filePath}"]`);
    if (fileWrapper) {
      fileWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /**
   * Set active file in sidebar
   * @param {string} filePath - Path of active file
   */
  setActiveFile(filePath) {
    // Use the new setActiveFileItem for new grouped layout
    this.setActiveFileItem(filePath);

    // Also handle old tree-file elements for backwards compatibility
    document.querySelectorAll('.tree-file.active').forEach(file => {
      file.classList.remove('active');
    });

    const fileElement = document.querySelector(`.tree-file[data-path="${filePath}"]`);
    if (fileElement) {
      fileElement.classList.add('active');
    }
  }

  /**
   * Initialize theme based on saved preference
   */
  initTheme() {
    document.documentElement.setAttribute('data-theme', this.currentTheme);
    this.updateThemeIcon();
  }

  /**
   * Toggle between light and dark theme
   */
  toggleTheme() {
    this.currentTheme = this.currentTheme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', this.currentTheme);
    document.documentElement.setAttribute('data-theme', this.currentTheme);
    this.updateThemeIcon();
  }

  /**
   * Update theme toggle button icon
   */
  updateThemeIcon() {
    const themeButton = document.getElementById('theme-toggle');
    if (themeButton) {
      const icon = this.currentTheme === 'light' ? 
        // Sun icon for light mode
        `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-1.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0-10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 0 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM16 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.061 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Z"/>
        </svg>` :
        // Moon icon for dark mode
        `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"/>
        </svg>`;
      
      themeButton.innerHTML = icon;
      themeButton.title = `Switch to ${this.currentTheme === 'light' ? 'dark' : 'light'} mode`;
    }
  }

  /**
   * Save panel collapsed/expanded states to localStorage
   */
  savePanelStates() {
    const sidebar = document.getElementById('files-sidebar');
    const aiPanel = document.getElementById('ai-panel');

    const panelStates = {
      filesSidebar: sidebar ? sidebar.classList.contains('collapsed') : false,
      aiPanel: aiPanel ? aiPanel.classList.contains('collapsed') : false
    };

    localStorage.setItem('pair-review-panel-states', JSON.stringify(panelStates));
  }

  /**
   * Restore panel collapsed/expanded states from localStorage
   */
  restorePanelStates() {
    const savedStates = localStorage.getItem('pair-review-panel-states');
    if (!savedStates) return;

    try {
      const panelStates = JSON.parse(savedStates);

      const sidebar = document.getElementById('files-sidebar');
      const aiPanel = document.getElementById('ai-panel');

      if (sidebar && panelStates.filesSidebar) {
        sidebar.classList.add('collapsed');
      }

      if (aiPanel && panelStates.aiPanel) {
        aiPanel.classList.add('collapsed');
      }
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