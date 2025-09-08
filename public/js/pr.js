/**
 * Pull Request UI Management
 */
class PRManager {
  constructor() {
    this.currentPR = null;
    this.loadingState = false;
    this.expandedFolders = new Set();
    this.expandedSections = new Set();
    this.currentTheme = localStorage.getItem('theme') || 'light';
    this.suggestionNavigator = null;
    this.init();
    this.initTheme();
    this.initSuggestionNavigator();
  }

  /**
   * Initialize PR manager
   */
  init() {
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
   * Load pull request data
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   */
  async loadPR(owner, repo, number) {
    if (this.loadingState) {
      return;
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
      
      // Check for auto-ai parameter after successful PR display
      this.checkAutoAITrigger();
      
    } catch (error) {
      console.error('Error loading PR:', error);
      this.showError(error.message);
    } finally {
      this.hideLoadingState();
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
    
    // Format dates
    const createdDate = this.formatDate(pr.created_at);
    const updatedDate = this.formatDate(pr.updated_at);
    
    // Create state badge
    const stateBadge = this.createStateBadge(pr.state);
    
    // Create stats display
    const stats = this.createStatsDisplay(pr);
    
    // First, ensure the container has the proper structure
    if (!document.getElementById('pr-header-container')) {
      // Create the full structure if it doesn't exist
      container.innerHTML = `
        <div id="pr-header-container"></div>
        <div class="container">
          <div class="files-sidebar" id="files-sidebar">
            <div class="sidebar-header">
              <h3>Files Changed</h3>
              <button class="sidebar-toggle" id="sidebar-toggle" title="Toggle sidebar">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6.823 7.823a.25.25 0 0 1 0 .354l-2.396 2.396A.25.25 0 0 1 4 10.396V5.604a.25.25 0 0 1 .427-.177Z"></path>
                  <path d="M1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0ZM1.5 1.75v12.5c0 .138.112.25.25.25H9.5v-13H1.75a.25.25 0 0 0-.25.25ZM11 14.5h3.25a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H11Z"></path>
                </svg>
              </button>
            </div>
            <div id="file-list" class="file-list"></div>
          </div>
          <button class="sidebar-toggle-collapsed" id="sidebar-toggle-collapsed" title="Show sidebar" style="display: none;">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="m4.177 7.823 2.396-2.396A.25.25 0 0 1 7 5.604v4.792a.25.25 0 0 1-.427.177L4.177 8.177a.25.25 0 0 1 0-.354Z"></path>
              <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25H9.5v-13Zm12.5 13a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H11v13Z"></path>
            </svg>
          </button>
          <div class="main-content">
            <div class="diff-header">
              <h2>Changes</h2>
              <div class="diff-stats" id="diff-stats"></div>
            </div>
            <div id="diff-container" class="diff-container">
              <div class="loading">Loading changes...</div>
            </div>
          </div>
        </div>
      `;
    }
    
    // Update the header container
    const headerContainer = document.getElementById('pr-header-container');
    if (headerContainer) {
      headerContainer.innerHTML = `
        <div class="pr-header">
          <div class="pr-title-section">
            <h1 class="pr-title">
              ${this.escapeHtml(pr.title)}
              <span class="pr-number">#${pr.number}</span>
              ${pr.html_url ? `
                <a href="${pr.html_url}" target="_blank" class="github-link" title="View on GitHub">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                  </svg>
                </a>
              ` : ''}
            </h1>
            <div class="pr-meta">
              ${stateBadge}
              <span class="pr-author">opened by <strong>${this.escapeHtml(pr.author)}</strong></span>
              <span class="pr-dates">on ${createdDate}</span>
              ${updatedDate !== createdDate ? `<span class="pr-updated">• updated ${updatedDate}</span>` : ''}
            </div>
          </div>
          <div class="pr-actions">
            <button class="btn btn-secondary" id="theme-toggle" onclick="prManager.toggleTheme()" title="Toggle theme">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-1.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0-10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 0 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM16 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.061 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Z"/>
              </svg>
            </button>
            <button class="btn btn-primary" onclick="prManager.triggerAIAnalysis()">
              Analyze with AI
            </button>
            <button class="btn review-button" id="review-button" onclick="prManager.openReviewModal()">
              <span class="review-button-text">0 comments</span>
            </button>
          </div>
        </div>
        
        ${stats}
        
        ${pr.description ? `
          <div class="pr-description">
            <h3>Description</h3>
            <div class="pr-description-content">${this.formatDescription(pr.description)}</div>
          </div>
        ` : ''}
      `;
    }

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
    
    container.style.display = 'block';
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
    
    // Store files data for expand functionality
    this.filesData = diffJson;
    
    // Create our own simple unified diff display
    container.innerHTML = '';
    
    try {
      diffJson.forEach(file => {
        // Track diff position per file (resets for each file, matches GitHub behavior)
        let fileDiffPosition = 0;
        let foundFirstHunk = false;
        const fileWrapper = document.createElement('div');
        fileWrapper.className = 'd2h-file-wrapper';
        fileWrapper.dataset.fileName = file.newName || file.oldName;
        fileWrapper.setAttribute('data-file-name', file.newName || file.oldName);
        
        // File header
        const fileHeader = document.createElement('div');
        fileHeader.className = 'd2h-file-header';
        const fileName = document.createElement('span');
        fileName.className = 'd2h-file-name';
        fileName.textContent = file.newName || file.oldName;
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
          // Add block header with GitHub-style expand controls
          const headerRow = document.createElement('tr');
          headerRow.className = 'd2h-info';
          
          // Create separate cells for gutter and code
          const gutterCell = document.createElement('td');
          gutterCell.className = 'chunk-expand-gutter';
          gutterCell.colSpan = 1;
          
          const codeCell = document.createElement('td');
          codeCell.className = 'd2h-info';
          codeCell.colSpan = 1;
          
          // Container for expand controls in the gutter
          const expandContainer = document.createElement('div');
          expandContainer.className = 'chunk-expand-container';
          
          // Check if there's a gap before this chunk
          let hasGap = false;
          let gapInfo = null;
          
          if (blockIndex === 0 && block.lines.length > 0) {
            // Gap at the beginning of the file
            const firstLine = block.lines[0];
            const startLine = Math.min(firstLine.oldNumber || 1, firstLine.newNumber || 1);
            if (startLine > 1) {
              hasGap = true;
              gapInfo = {
                start: 1,
                end: startLine - 1,
                position: 'above',
                fileName: file.newName || file.oldName
              };
            }
          } else if (blockIndex > 0) {
            // Gap between chunks
            const prevBlock = file.blocks[blockIndex - 1];
            const prevLastLine = prevBlock.lines[prevBlock.lines.length - 1];
            const currentFirstLine = block.lines[0];
            
            if (prevLastLine && currentFirstLine) {
              const prevEnd = Math.max(prevLastLine.oldNumber || 0, prevLastLine.newNumber || 0);
              const currentStart = Math.min(currentFirstLine.oldNumber || Infinity, currentFirstLine.newNumber || Infinity);
              
              if (currentStart > prevEnd + 1) {
                hasGap = true;
                gapInfo = {
                  start: prevEnd + 1,
                  end: currentStart - 1,
                  position: 'between',
                  fileName: file.newName || file.oldName
                };
              }
            }
          }
          
          // Add expand button if there's a gap
          if (hasGap && gapInfo) {
            const hiddenCount = gapInfo.end - gapInfo.start + 1;
            const isSmallGap = hiddenCount < 20;
            
            if (gapInfo.position === 'above') {
              // At beginning of file - use fold-up icon to expand upward
              const expandBtn = document.createElement('button');
              expandBtn.className = 'expand-button chunk-expand';
              expandBtn.title = `Load ${hiddenCount} lines`;
              expandBtn.dataset.start = gapInfo.start;
              expandBtn.dataset.end = gapInfo.end;
              expandBtn.dataset.fileName = gapInfo.fileName;
              expandBtn.dataset.position = 'above';
              expandBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.823 1.677L4.927 4.573A.25.25 0 005.104 5H7.25v3.236a.75.75 0 101.5 0V5h2.146a.25.25 0 00.177-.427L8.177 1.677a.25.25 0 00-.354 0zM13.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5zm-3.75.75a.75.75 0 01.75-.75h.5a.75.75 0 010 1.5h-.5a.75.75 0 01-.75-.75zM7.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5zM4 11.75a.75.75 0 01.75-.75h.5a.75.75 0 010 1.5h-.5a.75.75 0 01-.75-.75zM1.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5z"></path>
              </svg>`;
              
              expandBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.expandChunkGap(e.target.closest('button'), headerRow);
              });
              
              expandContainer.appendChild(expandBtn);
            } else if (isSmallGap) {
              // Small gap between chunks - use single fold icon
              const expandBtn = document.createElement('button');
              expandBtn.className = 'expand-button chunk-expand';
              expandBtn.title = `Load ${hiddenCount} lines`;
              expandBtn.dataset.start = gapInfo.start;
              expandBtn.dataset.end = gapInfo.end;
              expandBtn.dataset.fileName = gapInfo.fileName;
              expandBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M10.896 2H8.75V.75a.75.75 0 00-1.5 0V2H5.104a.25.25 0 00-.177.427l2.896 2.896a.25.25 0 00.354 0l2.896-2.896A.25.25 0 0010.896 2zM8.75 15.25a.75.75 0 01-1.5 0V14H5.104a.25.25 0 01-.177-.427l2.896-2.896a.25.25 0 01.354 0l2.896 2.896a.25.25 0 01-.177.427H8.75v1.25zm-6.5-6.5a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5zM6 8a.75.75 0 01-.75.75h-.5a.75.75 0 010-1.5h.5A.75.75 0 016 8zm2.25.75a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5zM12 8a.75.75 0 01-.75.75h-.5a.75.75 0 010-1.5h.5A.75.75 0 0112 8zm2.25.75a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5z"></path>
              </svg>`;
              
              expandBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.expandChunkGap(e.target.closest('button'), headerRow);
              });
              
              expandContainer.appendChild(expandBtn);
            } else {
              // Large gap between chunks - use fold-up and fold-down icons
              const btnGroup = document.createElement('div');
              btnGroup.className = 'expand-button-group';
              
              // Fold-up button
              const expandUp = document.createElement('button');
              expandUp.className = 'expand-button chunk-expand';
              expandUp.title = `Load more above`;
              expandUp.dataset.start = gapInfo.start;
              expandUp.dataset.end = Math.min(gapInfo.start + 19, gapInfo.end);
              expandUp.dataset.fileName = gapInfo.fileName;
              expandUp.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.823 1.677L4.927 4.573A.25.25 0 005.104 5H7.25v3.236a.75.75 0 101.5 0V5h2.146a.25.25 0 00.177-.427L8.177 1.677a.25.25 0 00-.354 0zM13.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5zm-3.75.75a.75.75 0 01.75-.75h.5a.75.75 0 010 1.5h-.5a.75.75 0 01-.75-.75zM7.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5zM4 11.75a.75.75 0 01.75-.75h.5a.75.75 0 010 1.5h-.5a.75.75 0 01-.75-.75zM1.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5z"></path>
              </svg>`;
              
              // Fold-down button
              const expandDown = document.createElement('button');
              expandDown.className = 'expand-button chunk-expand';
              expandDown.title = `Load more below`;
              expandDown.dataset.start = Math.max(gapInfo.end - 19, gapInfo.start);
              expandDown.dataset.end = gapInfo.end;
              expandDown.dataset.fileName = gapInfo.fileName;
              expandDown.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8.177 14.323l2.896-2.896a.25.25 0 00-.177-.427H8.75V7.764a.75.75 0 10-1.5 0V11H5.104a.25.25 0 00-.177.427l2.896 2.896a.25.25 0 00.354 0zM2.25 5a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5zM6 4.25a.75.75 0 01-.75.75h-.5a.75.75 0 010-1.5h.5a.75.75 0 01.75.75zM8.25 5a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5zM12 4.25a.75.75 0 01-.75.75h-.5a.75.75 0 010-1.5h.5a.75.75 0 01.75.75zm2.25.75a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5z"></path>
              </svg>`;
              
              expandUp.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.expandChunkGap(e.target.closest('button'), headerRow);
              });
              
              expandDown.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.expandChunkGap(e.target.closest('button'), headerRow);
              });
              
              btnGroup.appendChild(expandUp);
              btnGroup.appendChild(expandDown);
              expandContainer.appendChild(btnGroup);
            }
          }
          
          // Add expand container to gutter cell
          gutterCell.appendChild(expandContainer);
          
          // Add header text to code cell
          codeCell.textContent = block.header;
          
          // Add cells to row
          headerRow.appendChild(gutterCell);
          headerRow.appendChild(codeCell);
          tbody.appendChild(headerRow);
          
          // Reset position counter for the first hunk in the file only
          if (!foundFirstHunk) {
            fileDiffPosition = 0;
            foundFirstHunk = true;
          } else {
            // Subsequent block headers (@@) count as positions according to GitHub spec
            fileDiffPosition++;
          }
          
          // Context expansion is now handled in the chunk header above
          
          // Process lines within block and track positions
          block.lines.forEach((line) => {
            fileDiffPosition++; // Increment position for each diff line within this file
            this.renderDiffLine(tbody, line, file.newName || file.oldName, fileDiffPosition);
          });
          
          // Gaps between blocks are now handled by the next block's header
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
    if (line.newNumber) {
      row.dataset.lineNumber = line.newNumber;
      row.dataset.fileName = fileName;
      // Add diff position for GitHub API positioning
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
    
    // Add comment button (only for insert and context lines)
    if (line.type === 'insert' || line.type === 'context') {
      const commentButton = document.createElement('button');
      commentButton.className = 'add-comment-btn';
      commentButton.innerHTML = '+';
      commentButton.title = 'Add comment';
      commentButton.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const diffPos = row.dataset.diffPosition;
        this.showCommentForm(row, line.newNumber, tbody.closest('.d2h-file-wrapper').dataset.fileName, diffPos);
      };
      lineNumContent.appendChild(commentButton);
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
    contentCell.textContent = content;
    
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
   */
  createGapSection(tbody, fileName, startLine, endLine, gapSize) {
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
    expandControls.dataset.isGap = 'true'; // Mark this as a gap section
    
    // Create the expand buttons with GitHub Octicons
    const expandAbove = document.createElement('button');
    expandAbove.className = 'expand-button expand-up';
    expandAbove.title = 'Expand up';
    expandAbove.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="evenodd" d="M7.47 5.47a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1-1.06 1.06L8 7.06 4.78 10.28a.75.75 0 0 1-1.06-1.06l3.75-3.75Z"/>
      </svg>
    `;
    
    const expandBelow = document.createElement('button');
    expandBelow.className = 'expand-button expand-down';
    expandBelow.title = 'Expand down';
    expandBelow.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="evenodd" d="M8.53 10.53a.75.75 0 0 1-1.06 0l-3.75-3.75a.75.75 0 0 1 1.06-1.06L8 8.94l3.22-3.22a.75.75 0 1 1 1.06 1.06l-3.75 3.75Z"/>
      </svg>
    `;
    
    // Stack only up/down buttons compactly in the gutter
    buttonContainer.appendChild(expandAbove);
    buttonContainer.appendChild(expandBelow);
    oldLineCell.appendChild(buttonContainer);
    
    // Create content cell for hidden lines text with inline expand-all
    const contentCell = document.createElement('td');
    contentCell.className = 'diff-code expand-content';
    contentCell.colSpan = 2;
    
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'expand-content-wrapper';
    
    const expandInfo = document.createElement('span');
    expandInfo.className = 'expand-info';
    expandInfo.innerHTML = `${gapSize} hidden lines`;
    
    const expandAll = document.createElement('button');
    expandAll.className = 'expand-button-inline expand-all';
    expandAll.title = `Expand all ${gapSize} lines`;
    expandAll.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="evenodd" d="M8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM8 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 1 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM16 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.061 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Z"/>
      </svg>
    `;
    
    contentWrapper.appendChild(expandInfo);
    contentWrapper.appendChild(expandAll);
    contentCell.appendChild(contentWrapper);
    
    // Add event listeners for gap expansion
    expandAbove.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      this.expandGapContext(row.expandControls, 'up', 20);
    });
    expandAll.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      const hiddenCount = parseInt(expandControls.dataset.hiddenCount) || gapSize;
      this.expandGapContext(row.expandControls, 'all', hiddenCount);
    });
    expandBelow.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      this.expandGapContext(row.expandControls, 'down', 20);
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
    
    // GitHub-style expand buttons - use single icon for small ranges, separate for large
    const isSmallRange = hiddenCount <= 20;
    
    if (isSmallRange && position === 'between') {
      // For small ranges between changes, use single expand-both icon (unfold)
      const expandBoth = document.createElement('button');
      expandBoth.className = 'expand-button expand-both';
      expandBoth.title = `Expand ${hiddenCount} lines`;
      expandBoth.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8.177.677l2.896 2.896a.25.25 0 01-.177.427H8.75v1.25a.75.75 0 01-1.5 0V4H5.104a.25.25 0 01-.177-.427L7.823.677a.25.25 0 01.354 0zM7.25 10.75a.75.75 0 011.5 0V12h2.146a.25.25 0 01.177.427l-2.896 2.896a.25.25 0 01-.354 0l-2.896-2.896A.25.25 0 015.104 12H7.25v-1.25zm-5-2a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5zM6 8a.75.75 0 01-.75.75h-.5a.75.75 0 010-1.5h.5A.75.75 0 016 8zm2.25.75a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5zM12 8a.75.75 0 01-.75.75h-.5a.75.75 0 010-1.5h.5A.75.75 0 0112 8zm2.25.75a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5z"></path>
        </svg>
      `;
      buttonContainer.appendChild(expandBoth);
    } else {
      // For large ranges or at edges, use separate fold-up/fold-down icons
      const expandAbove = position !== 'above' ? document.createElement('button') : null;
      if (expandAbove) {
        expandAbove.className = 'expand-button expand-up';
        expandAbove.title = 'Load more above';
        expandAbove.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.823 1.677L4.927 4.573A.25.25 0 005.104 5H7.25v3.236a.75.75 0 101.5 0V5h2.146a.25.25 0 00.177-.427L8.177 1.677a.25.25 0 00-.354 0zM13.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5zm-3.75.75a.75.75 0 01.75-.75h.5a.75.75 0 010 1.5h-.5a.75.75 0 01-.75-.75zM7.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5zM4 11.75a.75.75 0 01.75-.75h.5a.75.75 0 010 1.5h-.5a.75.75 0 01-.75-.75zM1.75 11a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5z"></path>
          </svg>
        `;
      }
      
      const expandBelow = position !== 'below' ? document.createElement('button') : null;
      if (expandBelow) {
        expandBelow.className = 'expand-button expand-down';
        expandBelow.title = 'Load more below';
        expandBelow.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8.177 14.323l2.896-2.896a.25.25 0 00-.177-.427H8.75V7.764a.75.75 0 10-1.5 0V11H5.104a.25.25 0 00-.177.427l2.896 2.896a.25.25 0 00.354 0zM2.25 5a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5zM6 4.25a.75.75 0 01-.75.75h-.5a.75.75 0 010-1.5h.5a.75.75 0 01.75.75zM8.25 5a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5zM12 4.25a.75.75 0 01-.75.75h-.5a.75.75 0 010-1.5h.5a.75.75 0 01.75.75zm2.25.75a.75.75 0 000-1.5h-.5a.75.75 0 000 1.5h.5z"></path>
          </svg>
        `;
      }
      
      // Add buttons based on position
      if (position === 'above') {
        // At the top - only show expand below
        buttonContainer.appendChild(expandBelow);
      } else if (position === 'below') {
        // At the bottom - only show expand above
        buttonContainer.appendChild(expandAbove);
      } else {
        // Between changes - show both buttons stacked
        buttonContainer.style.flexDirection = 'column';
        buttonContainer.appendChild(expandAbove);
        buttonContainer.appendChild(expandBelow);
      }
    }
    
    oldLineCell.appendChild(buttonContainer);
    
    // Create content cell for hidden lines text (GitHub style - no inline button)
    const contentCell = document.createElement('td');
    contentCell.className = 'diff-code expand-content';
    contentCell.colSpan = 2;
    
    const expandInfo = document.createElement('span');
    expandInfo.className = 'expand-info';
    // Use ellipsis icon like GitHub
    expandInfo.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: text-bottom; margin-right: 4px;">
        <path d="M0 5.75C0 4.784.784 4 1.75 4h12.5c.966 0 1.75.784 1.75 1.75v4.5A1.75 1.75 0 0114.25 12H1.75A1.75 1.75 0 010 10.25v-4.5zM4 7a1 1 0 100 2 1 1 0 000-2zm3 1a1 1 0 112 0 1 1 0 01-2 0zm5-1a1 1 0 100 2 1 1 0 000-2z"></path>
      </svg>
    `;
    
    contentCell.appendChild(expandInfo);
    
    // Store the hidden lines data for expansion
    expandControls.hiddenLines = allLines.slice(startIdx, endIdx);
    
    // Add click handlers for collapsed section expansion
    if (isSmallRange && position === 'between') {
      // For the single expand-both button
      const expandBoth = buttonContainer.querySelector('.expand-both');
      expandBoth?.addEventListener('click', (e) => {
        const row = e.currentTarget.closest('tr');
        const hiddenCountValue = parseInt(expandControls.dataset.hiddenCount) || hiddenCount;
        this.expandContext(row.expandControls, 'all', hiddenCountValue);
      });
    } else {
      // For separate expand buttons
      const expandAbove = buttonContainer.querySelector('.expand-up');
      const expandBelow = buttonContainer.querySelector('.expand-down');
      
      expandAbove?.addEventListener('click', (e) => {
        const row = e.currentTarget.closest('tr');
        this.expandContext(row.expandControls, 'up', 20);
      });
      
      expandBelow?.addEventListener('click', (e) => {
        const row = e.currentTarget.closest('tr');
        this.expandContext(row.expandControls, 'down', 20);
      });
    }
    
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
   * Trigger AI analysis
   */
  async triggerAIAnalysis() {
    if (!this.currentPR) {
      this.showError('No PR loaded');
      return;
    }

    const { owner, repo, number } = this.currentPR;
    
    try {
      // Update button to show loading state
      const btn = document.querySelector('button[onclick*="triggerAIAnalysis"]');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Starting...';
      }

      // Start AI analysis
      const response = await fetch(`/api/analyze/${owner}/${repo}/${number}`, {
        method: 'POST'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start AI analysis');
      }

      const result = await response.json();
      
      // Show progress modal
      if (window.progressModal) {
        window.progressModal.show(result.analysisId);
      }
      
      // Reset button
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'Analyze with AI';
      }
      
    } catch (error) {
      console.error('Error triggering AI analysis:', error);
      this.showError(`Failed to start AI analysis: ${error.message}`);
      
      // Reset button
      const btn = document.querySelector('button[onclick*="triggerAIAnalysis"]');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'Analyze with AI';
      }
    }
  }

  /**
   * Check for auto-ai parameter and trigger analysis automatically
   */
  checkAutoAITrigger() {
    const urlParams = new URLSearchParams(window.location.search);
    const autoAI = urlParams.get('auto-ai');
    
    if (autoAI === 'true') {
      console.log('Auto-triggering AI analysis...');
      
      // Clean up URL parameter using history.replaceState()
      const url = new URL(window.location);
      url.searchParams.delete('auto-ai');
      window.history.replaceState({}, document.title, url.toString());
      
      // Trigger AI analysis with a small delay to ensure UI is ready
      setTimeout(() => {
        this.triggerAIAnalysis().catch(error => {
          console.error('Auto-triggered AI analysis failed:', error);
          this.showError(`Auto-triggered AI analysis failed: ${error.message}`);
        });
      }, 500);
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
      const comments = data.comments || [];

      console.log(`Loaded ${comments.length} user comments`);

      // Store comments for later use (to detect adopted suggestions)
      this.userComments = comments;
      console.log(`[UI] Stored user comments for adoption detection:`, comments.filter(c => c.parent_id));

      // Display comments inline with the diff
      this.displayUserComments(comments);

    } catch (error) {
      console.error('Error loading user comments:', error);
    }
  }
  
  /**
   * Display user comments inline with diff
   */
  displayUserComments(comments) {
    console.log(`[UI] Displaying ${comments.length} user comments`);
    
    // Clear existing user comment rows before displaying new ones
    const existingCommentRows = document.querySelectorAll('.user-comment-row');
    existingCommentRows.forEach(row => row.remove());
    
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
      
      // Find the diff wrapper for this file
      let fileElement = document.querySelector(`[data-file-name="${file}"]`);
      if (!fileElement) {
        // Try to find by partial match
        const allFileWrappers = document.querySelectorAll('.d2h-file-wrapper');
        for (const wrapper of allFileWrappers) {
          const fileName = wrapper.dataset.fileName;
          if (fileName && (fileName === file || fileName.endsWith('/' + file) || file.endsWith('/' + fileName))) {
            fileElement = wrapper;
            break;
          }
        }
      }
      
      if (!fileElement) {
        console.warn(`[UI] Could not find file element for user comment: ${file}`);
        return;
      }

      // Find the line in the diff
      const lineRows = fileElement.querySelectorAll('tr');
      let commentInserted = false;
      
      lineRows.forEach(row => {
        if (commentInserted) return;
        
        // Try different selectors for line numbers
        let lineNum = row.querySelector('.line-num2')?.textContent?.trim();
        if (!lineNum) {
          const lineNumCell = row.querySelector('.d2h-code-linenumber');
          if (lineNumCell) {
            const lineNum2 = lineNumCell.querySelector('.line-num2');
            if (lineNum2) {
              lineNum = lineNum2.textContent?.trim();
            }
          }
        }
        
        if (lineNum && parseInt(lineNum) === line) {
          // Insert comments after this row
          locationComments.forEach(comment => {
            this.displayUserComment(comment, row);
          });
          commentInserted = true;
        }
      });
      
      if (!commentInserted) {
        console.warn(`[UI] Could not find line ${line} in file ${file} for user comment`);
      }
    });
    
    // Update the comment count in the review button
    this.updateCommentCount();
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
        response = await fetch(`/api/pr/${this.currentPR.owner}/${this.currentPR.repo}/${this.currentPR.number}/ai-suggestions`);
      } else {
        // Fallback: parse from URL if currentPR data is incomplete
        const urlParts = window.location.pathname.split('/');
        if (urlParts.length >= 4 && urlParts[1] === 'pr') {
          const owner = urlParts[2];
          const repo = urlParts[3];
          const number = urlParts[4];
          response = await fetch(`/api/pr/${owner}/${repo}/${number}/ai-suggestions`);
        } else {
          throw new Error('Unable to determine PR repository information');
        }
      }
      
      if (!response.ok) {
        throw new Error('Failed to load AI suggestions');
      }

      const data = await response.json();
      const suggestions = data.suggestions || [];

      console.log(`Loaded ${suggestions.length} AI suggestions`);

      // Display suggestions inline with the diff
      this.displayAISuggestions(suggestions);

    } catch (error) {
      console.error('Error loading AI suggestions:', error);
    }
  }

  /**
   * Display AI suggestions inline with diff
   */
  displayAISuggestions(suggestions) {
    console.log(`[UI] Displaying ${suggestions.length} AI suggestions`);
    
    // Clear existing AI suggestion rows before displaying new ones
    const existingSuggestionRows = document.querySelectorAll('.ai-suggestion-row');
    existingSuggestionRows.forEach(row => row.remove());
    console.log(`[UI] Removed ${existingSuggestionRows.length} existing suggestion rows`);
    
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
      
      console.log(`[UI] Looking for file: ${file}, line: ${line}`);
      
      // Debug: Log all available file wrappers
      const allWrappers = document.querySelectorAll('.d2h-file-wrapper');
      console.log(`[UI] Available file wrappers:`, Array.from(allWrappers).map(w => w.dataset.fileName));
      
      // Find the diff wrapper for this file - try multiple selectors
      let fileElement = document.querySelector(`[data-file-name="${file}"]`);
      if (!fileElement) {
        fileElement = document.querySelector(`[data-file-path="${file}"]`);
      }
      if (!fileElement) {
        // Try to find by partial match in the file wrapper
        const allFileWrappers = document.querySelectorAll('.d2h-file-wrapper');
        for (const wrapper of allFileWrappers) {
          const fileName = wrapper.dataset.fileName;
          if (fileName && (fileName === file || fileName.endsWith('/' + file) || file.endsWith('/' + fileName))) {
            fileElement = wrapper;
            break;
          }
        }
      }
      
      if (!fileElement) {
        console.warn(`[UI] Could not find file element for: ${file}. Available files:`, Array.from(allWrappers).map(w => w.dataset.fileName));
        return;
      }

      console.log(`[UI] Found file element for: ${file}`);

      // Find the line in the diff - check both line-num2 and line-num-new
      const lineRows = fileElement.querySelectorAll('tr');
      let suggestionInserted = false;
      
      lineRows.forEach(row => {
        if (suggestionInserted) return;
        
        // Try different selectors for line numbers
        let lineNum = row.querySelector('.line-num2')?.textContent?.trim();
        if (!lineNum) {
          lineNum = row.querySelector('.line-num-new')?.textContent?.trim();
        }
        if (!lineNum) {
          // For custom diff rendering, check the line number cell
          const lineNumCell = row.querySelector('.d2h-code-linenumber');
          if (lineNumCell) {
            const lineNum2 = lineNumCell.querySelector('.line-num2');
            if (lineNum2) {
              lineNum = lineNum2.textContent?.trim();
            }
          }
        }
        
        if (lineNum && parseInt(lineNum) === line) {
          console.log(`[UI] Found line ${line} in file ${file}, inserting suggestion`);
          // Insert suggestion after this row
          const suggestionRow = this.createSuggestionRow(locationSuggestions);
          row.parentNode.insertBefore(suggestionRow, row.nextSibling);
          suggestionInserted = true;
        }
      });
      
      if (!suggestionInserted) {
        console.warn(`[UI] Could not find line ${line} in file ${file}`);
      }
    });
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
      // Priority: adopted > dismissed
      if (wasAdopted) {
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
      
      suggestionDiv.innerHTML = `
        <div class="ai-suggestion-header">
          <div class="ai-suggestion-header-left">
            <span class="ai-indicator">
              <svg viewBox="0 0 16 16">
                <path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901l-.203.556a.213.213 0 0 1-.4 0l-.203-.556a3.2 3.2 0 0 0-1.901-1.901l-.556-.203a.213.213 0 0 1 0-.4l.556-.203a3.2 3.2 0 0 0 1.901-1.901L2.8.14Z"/>
              </svg>
            </span>
            <span class="type-badge type-${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}">${suggestion.type}</span>
            ${suggestion.ai_level === 2 ? '<span class="level-badge level-2">File Context</span>' : ''}
            ${suggestion.ai_level === 3 ? '<span class="level-badge level-3">Codebase Context</span>' : ''}
            <span class="ai-title">${this.escapeHtml(suggestion.title || '')}</span>
            ${suggestion.ai_confidence ? `<span class="confidence">${Math.round(suggestion.ai_confidence * 100)}% confident</span>` : ''}
          </div>
        </div>
        <div class="ai-suggestion-collapsed-content">
          <span class="ai-indicator">
            <svg viewBox="0 0 16 16">
              <path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901l-.203.556a.213.213 0 0 1-.4 0l-.203-.556a3.2 3.2 0 0 0-1.901-1.901l-.556-.203a.213.213 0 0 1 0-.4l.556-.203a3.2 3.2 0 0 0 1.901-1.901L2.8.14Z"/>
            </svg>
          </span>
          <span class="collapsed-text">${wasAdopted ? 'Suggestion adopted' : 'Hidden AI suggestion'}</span>
          <span class="type-badge type-${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}">${suggestion.type}</span>
          <span class="collapsed-title">${this.escapeHtml(suggestion.title || '')}</span>
          <button class="btn-restore" onclick="prManager.restoreSuggestion(${suggestion.id})" title="${wasAdopted ? 'Hide suggestion' : 'Show suggestion'}">
            <svg class="octicon octicon-eye" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"></path>
            </svg>
            <span class="btn-text">${wasAdopted ? 'Hide' : 'Show'}</span>
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
          <button class="btn btn-sm btn-primary" onclick="prManager.adoptSuggestion(${suggestion.id})">
            Adopt
          </button>
          <button class="btn btn-sm btn-primary" onclick="prManager.adoptAndEditSuggestion(${suggestion.id})">
            Adopt & Edit
          </button>
          <button class="btn btn-sm btn-secondary" onclick="prManager.dismissSuggestion(${suggestion.id})">
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
    
    const typeElement = suggestionDiv.querySelector('.type-badge');
    const titleElement = suggestionDiv.querySelector('.ai-title');
    const suggestionType = typeElement?.textContent?.trim() || '';
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
    
    const lineNumber = targetRow.querySelector('.line-num2')?.textContent?.trim();
    const fileWrapper = targetRow.closest('.d2h-file-wrapper');
    const fileName = fileWrapper?.dataset?.fileName || '';
    
    if (!lineNumber || !fileName) {
      throw new Error('Could not determine file and line information');
    }
    
    return { targetRow, suggestionRow, lineNumber, fileName };
  }

  /**
   * Helper function to dismiss and collapse AI suggestion
   */
  async dismissAndCollapseAISuggestion(suggestionId, suggestionRow, adoptedText = 'Suggestion adopted') {
    // Dismiss the AI suggestion via API
    const dismissResponse = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'dismissed' })
    });

    if (!dismissResponse.ok) {
      throw new Error('Failed to dismiss suggestion');
    }

    // Collapse the AI suggestion in the UI
    if (suggestionRow) {
      const suggestionDiv = suggestionRow.querySelector('.ai-suggestion');
      if (suggestionDiv) {
        suggestionDiv.classList.add('collapsed');
        // Update collapsed content text
        const collapsedContent = suggestionDiv.querySelector('.collapsed-text');
        if (collapsedContent) {
          collapsedContent.textContent = adoptedText;
        }
        // Update restore button for adopted suggestions
        const restoreButton = suggestionDiv.querySelector('.btn-restore');
        if (restoreButton) {
          restoreButton.title = 'Hide suggestion';
          const btnText = restoreButton.querySelector('.btn-text');
          if (btnText) {
            btnText.textContent = 'Hide';
          }
        }
      }
      suggestionRow.dataset.hiddenForAdoption = 'true';
    }
  }

  /**
   * Helper function to create user comment from AI suggestion
   */
  async createUserCommentFromSuggestion(suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle) {
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
        body: suggestionText,
        parent_id: suggestionId,  // Link to original AI suggestion
        type: suggestionType,     // Preserve the type
        title: suggestionTitle    // Preserve the title
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
      body: suggestionText,
      type: suggestionType,
      title: suggestionTitle,
      parent_id: suggestionId,
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
      const { suggestionRow, lineNumber, fileName } = this.getFileAndLineInfo(suggestionDiv);

      // Dismiss and collapse the AI suggestion
      await this.dismissAndCollapseAISuggestion(suggestionId, suggestionRow);
      
      // Create user comment from suggestion
      const newComment = await this.createUserCommentFromSuggestion(
        suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle
      );
      
      // Display the new user comment in edit mode BELOW the suggestion row
      this.displayUserCommentInEditMode(newComment, suggestionRow);
      
      // Update the suggestion navigator
      if (this.suggestionNavigator && this.suggestionNavigator.suggestions) {
        const updatedSuggestions = this.suggestionNavigator.suggestions.map(s => 
          s.id === suggestionId ? { ...s, status: 'dismissed' } : s
        );
        this.suggestionNavigator.updateSuggestions(updatedSuggestions);
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
      const { suggestionRow, lineNumber, fileName } = this.getFileAndLineInfo(suggestionDiv);

      // Dismiss and collapse the AI suggestion
      await this.dismissAndCollapseAISuggestion(suggestionId, suggestionRow);
      
      // Create user comment from suggestion
      const newComment = await this.createUserCommentFromSuggestion(
        suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle
      );
      
      // Display the new user comment in read-only mode (not edit mode)
      this.displayUserComment(newComment, suggestionRow);
      
      // Update the suggestion navigator
      if (this.suggestionNavigator && this.suggestionNavigator.suggestions) {
        const updatedSuggestions = this.suggestionNavigator.suggestions.map(s => 
          s.id === suggestionId ? { ...s, status: 'dismissed' } : s
        );
        this.suggestionNavigator.updateSuggestions(updatedSuggestions);
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
   * Show comment form inline
   */
  showCommentForm(targetRow, lineNumber, fileName, diffPosition) {
    // Close any existing comment forms
    this.hideCommentForm();
    
    // Create comment form row
    const formRow = document.createElement('tr');
    formRow.className = 'comment-form-row';
    
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'comment-form-cell';
    
    const formHTML = `
      <div class="user-comment-form">
        <div class="comment-form-header">
          <span class="comment-icon">💬</span>
          <span class="comment-title">Add comment</span>
        </div>
        <textarea 
          class="comment-textarea" 
          placeholder="Leave a comment..."
          rows="3"
          data-line="${lineNumber}"
          data-file="${fileName}"
          data-diff-position="${diffPosition || ''}"
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
    
    saveBtn.addEventListener('click', () => this.saveUserComment(textarea, formRow));
    cancelBtn.addEventListener('click', () => this.hideCommentForm());
    
    // Auto-save on input
    textarea.addEventListener('input', () => this.autoSaveComment(textarea));
    
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
    const indicator = textarea.closest('.user-comment-form').querySelector('.draft-indicator');
    indicator.style.display = 'inline';
    setTimeout(() => {
      indicator.style.display = 'none';
    }, 2000);
  }
  
  /**
   * Save user comment
   */
  async saveUserComment(textarea, formRow) {
    const fileName = textarea.dataset.file;
    const lineNumber = parseInt(textarea.dataset.line);
    const diffPosition = textarea.dataset.diffPosition ? parseInt(textarea.dataset.diffPosition) : null;
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
          line_end: lineNumber,
          diff_position: diffPosition,
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
        body: content,
        created_at: new Date().toISOString()
      }, formRow.previousElementSibling);
      
      // Hide form
      this.hideCommentForm();
      
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
    
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'user-comment-cell';
    
    // Format line info
    const lineInfo = comment.line_end && comment.line_end !== comment.line_start 
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;
    
    // Build metadata display for adopted comments
    let metadataHTML = '';
    if (comment.parent_id && comment.type && comment.type !== 'comment') {
      metadataHTML = `
        <button class="btn-toggle-original" onclick="prManager.toggleOriginalSuggestion(${comment.parent_id}, ${comment.id})" title="Show/hide original AI suggestion">
          <svg class="octicon octicon-eye" viewBox="0 0 16 16" width="20" height="20">
            <path fill-rule="evenodd" d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"></path>
          </svg>
        </button>
        <span class="adopted-type-badge type-${comment.type}">${comment.type}</span>
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
    
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'user-comment-cell';
    
    const commentHTML = `
      <div class="user-comment editing-mode ${comment.parent_id ? 'adopted-comment' : ''}">
        <div class="user-comment-header">
          <span class="comment-icon">
            <svg class="octicon octicon-comment" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"></path>
            </svg>
          </span>
          <span class="user-comment-line-info">Line ${comment.line_start}</span>
          ${comment.type && comment.type !== 'comment' ? `
            <button class="btn-toggle-original" onclick="prManager.toggleOriginalSuggestion(${comment.parent_id}, ${comment.id})" title="Show/hide original AI suggestion">
              <svg class="octicon octicon-eye" viewBox="0 0 16 16" width="20" height="20">
                <path fill-rule="evenodd" d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"></path>
              </svg>
            </button>
            <span class="adopted-type-badge type-${comment.type}">${comment.type}</span>
            ${comment.title ? `<span class="adopted-title">${this.escapeHtml(comment.title)}</span>` : ''}
          ` : ''}
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
          <textarea 
            id="edit-comment-${comment.id}" 
            class="comment-edit-textarea"
            placeholder="Enter your comment..."
            rows="3">${this.escapeHtml(comment.body)}</textarea>
          <div class="comment-edit-actions">
            <button class="btn btn-sm btn-primary" onclick="prManager.saveEditedUserComment(${comment.id})">
              Save comment
            </button>
            <button class="btn btn-sm btn-secondary" onclick="prManager.cancelEditUserComment(${comment.id})">
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
    
    // Focus and select the textarea
    const textarea = document.getElementById(`edit-comment-${comment.id}`);
    if (textarea) {
      textarea.focus();
      textarea.select();
      
      // Add keyboard shortcuts
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.cancelEditUserComment(comment.id);
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.saveEditedUserComment(comment.id);
        }
      });
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
      
      // Add editing mode
      commentDiv.classList.add('editing-mode');
      
      // Replace body with edit form
      const editFormHTML = `
        <div class="user-comment-edit-form">
          <textarea 
            id="edit-comment-${commentId}" 
            class="comment-edit-textarea"
            placeholder="Enter your comment..."
            rows="3">${this.escapeHtml(currentText)}</textarea>
          <div class="comment-edit-actions">
            <button class="btn btn-sm btn-primary" onclick="prManager.saveEditedUserComment(${commentId})">
              Save comment
            </button>
            <button class="btn btn-sm btn-secondary" onclick="prManager.cancelEditUserComment(${commentId})">
              Cancel
            </button>
          </div>
        </div>
      `;
      
      // Hide body and insert edit form
      bodyDiv.style.display = 'none';
      bodyDiv.insertAdjacentHTML('afterend', editFormHTML);
      
      // Focus textarea
      const textarea = document.getElementById(`edit-comment-${commentId}`);
      if (textarea) {
        textarea.focus();
        textarea.select();
        
        // Add keyboard shortcuts
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            this.cancelEditUserComment(commentId);
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this.saveEditedUserComment(commentId);
          }
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
  }
  
  /**
   * Delete user comment
   */
  async deleteUserComment(commentId) {
    if (!confirm('Are you sure you want to delete this comment?')) {
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
   * Update comment count in review button
   */
  updateCommentCount() {
    const userComments = document.querySelectorAll('.user-comment-row').length;
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
            binary: file.binary
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
    
    // Build tree and render
    const tree = this.buildFileTree(files);
    const elements = this.renderTreeNode('', tree);
    
    fileListContainer.innerHTML = '';
    elements.forEach(element => {
      fileListContainer.appendChild(element);
    });
    
    // Setup sidebar toggle
    this.setupSidebarToggle();
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
      collapsedBtn.style.display = 'flex';
      mainContent.classList.add('sidebar-collapsed');
    }
    
    toggleBtn.addEventListener('click', () => {
      sidebar.style.display = 'none';
      collapsedBtn.style.display = 'flex';
      mainContent.classList.add('sidebar-collapsed');
      localStorage.setItem('file-sidebar-collapsed', 'true');
    });
    
    collapsedBtn.addEventListener('click', () => {
      sidebar.style.display = 'block';
      collapsedBtn.style.display = 'none';
      mainContent.classList.remove('sidebar-collapsed');
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
    // Remove previous active states
    document.querySelectorAll('.tree-file.active').forEach(file => {
      file.classList.remove('active');
    });
    
    // Add active state to clicked file
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
   * Expand gap in chunk header
   * @param {HTMLElement} button - The expand button
   * @param {HTMLElement} headerRow - The chunk header row
   */
  expandChunkGap(button, headerRow) {
    const start = parseInt(button.dataset.start);
    const end = parseInt(button.dataset.end);
    const fileName = button.dataset.fileName;
    const position = button.dataset.position || 'between';
    
    console.log(`Expanding lines ${start}-${end} in ${fileName}`);
    
    // Find the file data
    const fileData = this.filesData ? this.filesData.find(f => (f.newName || f.oldName) === fileName) : null;
    if (!fileData) {
      console.error('File data not found for', fileName);
      return;
    }
    
    // Create fragment to hold new rows
    const fragment = document.createDocumentFragment();
    
    // Create rows for the expanded lines (context lines that were hidden)
    for (let lineNum = start; lineNum <= end; lineNum++) {
      const row = document.createElement('tr');
      row.className = 'd2h-code-line d2h-cntx';
      
      // Line number cell
      const lineNumCell = document.createElement('td');
      lineNumCell.className = 'd2h-code-linenumber d2h-cntx';
      
      // Create line number spans to match diff2html structure
      const lineNum1Span = document.createElement('span');
      lineNum1Span.className = 'line-num1';
      lineNum1Span.textContent = lineNum;
      
      const lineNum2Span = document.createElement('span');
      lineNum2Span.className = 'line-num2';
      lineNum2Span.textContent = lineNum;
      
      lineNumCell.appendChild(lineNum1Span);
      lineNumCell.appendChild(lineNum2Span);
      
      // Code content cell
      const codeCell = document.createElement('td');
      codeCell.className = 'd2h-code-line-ctn';
      
      // For now, show ellipsis for hidden context lines
      // In a real implementation, we'd fetch the actual file content
      const codeContent = document.createElement('span');
      codeContent.textContent = `    // ... line ${lineNum} ...`;
      codeContent.style.color = '#656d76';
      codeContent.style.fontStyle = 'italic';
      
      codeCell.appendChild(codeContent);
      
      row.appendChild(lineNumCell);
      row.appendChild(codeCell);
      fragment.appendChild(row);
    }
    
    // Insert the new rows after the header row
    if (headerRow.nextSibling) {
      headerRow.parentNode.insertBefore(fragment, headerRow.nextSibling);
    } else {
      headerRow.parentNode.appendChild(fragment);
    }
    
    // Remove the expand button or button group
    const buttonContainer = button.closest('.expand-button-group');
    if (buttonContainer) {
      // If it's part of a button group, just remove this button
      button.remove();
      // If the group is now empty, remove it too
      if (buttonContainer.children.length === 0) {
        buttonContainer.remove();
      }
    } else {
      // Single button - remove it
      button.remove();
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