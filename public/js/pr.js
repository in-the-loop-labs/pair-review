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
            <h1 class="pr-title">${this.escapeHtml(pr.title)}</h1>
            <div class="pr-meta">
              <span class="pr-number">#${pr.number}</span>
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
          // Add block header
          const headerRow = document.createElement('tr');
          headerRow.className = 'd2h-info';
          headerRow.innerHTML = `<td colspan="2" class="d2h-info">${block.header}</td>`;
          tbody.appendChild(headerRow);
          
          // Add expandable context at the beginning of first block if not starting at line 1
          if (blockIndex === 0 && block.lines.length > 0 && (block.lines[0].oldNumber > 1 || block.lines[0].newNumber > 1)) {
            const startLine = Math.min(block.lines[0].oldNumber || 1, block.lines[0].newNumber || 1);
            if (startLine > 1) {
              this.createGapSection(tbody, file.newName || file.oldName, 1, startLine - 1, startLine - 1);
            }
          }
          
          // Process lines within block
          block.lines.forEach((line) => {
            this.renderDiffLine(tbody, line);
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
                this.createGapSection(tbody, file.newName || file.oldName, currentEnd + 1, nextStart - 1, nextStart - currentEnd - 1);
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
   * Render a single diff line
   * @param {HTMLElement} tbody - Table body element
   * @param {Object} line - Diff line data
   */
  renderDiffLine(tbody, line) {
    const row = document.createElement('tr');
    row.className = line.type === 'insert' ? 'd2h-ins' : 
                   line.type === 'delete' ? 'd2h-del' : 
                   'd2h-cntx';
    
    // Line numbers
    const lineNumCell = document.createElement('td');
    lineNumCell.className = 'd2h-code-linenumber';
    lineNumCell.innerHTML = `<span class="line-num1">${line.oldNumber || ''}</span><span class="line-num2">${line.newNumber || ''}</span>`;
    
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
        this.renderDiffLine(tbody, line);
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
    const expandAbove = position !== 'above' ? document.createElement('button') : null;
    if (expandAbove) {
      expandAbove.className = 'expand-button expand-up';
      expandAbove.title = 'Expand up';
      expandAbove.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path fill-rule="evenodd" d="M7.47 5.47a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1-1.06 1.06L8 7.06 4.78 10.28a.75.75 0 0 1-1.06-1.06l3.75-3.75Z"/>
        </svg>
      `;
    }
    
    const expandBelow = position !== 'below' ? document.createElement('button') : null;
    if (expandBelow) {
      expandBelow.className = 'expand-button expand-down';
      expandBelow.title = 'Expand down';
      expandBelow.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path fill-rule="evenodd" d="M8.53 10.53a.75.75 0 0 1-1.06 0l-3.75-3.75a.75.75 0 0 1 1.06-1.06L8 8.94l3.22-3.22a.75.75 0 1 1 1.06 1.06l-3.75 3.75Z"/>
        </svg>
      `;
    }
    
    // Stack only up/down buttons compactly in the gutter based on position
    if (position === 'above') {
      // At the top - only show expand below
      buttonContainer.appendChild(expandBelow);
    } else if (position === 'below') {
      // At the bottom - only show expand above
      buttonContainer.appendChild(expandAbove);
    } else {
      // Between changes - show both buttons
      buttonContainer.appendChild(expandAbove);
      buttonContainer.appendChild(expandBelow);
    }
    
    oldLineCell.appendChild(buttonContainer);
    
    // Create content cell for hidden lines text with inline expand-all
    const contentCell = document.createElement('td');
    contentCell.className = 'diff-code expand-content';
    contentCell.colSpan = 2;
    
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'expand-content-wrapper';
    
    const expandInfo = document.createElement('span');
    expandInfo.className = 'expand-info';
    expandInfo.innerHTML = `${hiddenCount} hidden lines`;
    
    const expandAll = document.createElement('button');
    expandAll.className = 'expand-button-inline expand-all';
    expandAll.title = `Expand all ${hiddenCount} lines`;
    expandAll.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="evenodd" d="M8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM8 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 1 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM16 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.061 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Z"/>
      </svg>
    `;
    
    contentWrapper.appendChild(expandInfo);
    contentWrapper.appendChild(expandAll);
    contentCell.appendChild(contentWrapper);
    
    // Store the hidden lines data for expansion
    expandControls.hiddenLines = allLines.slice(startIdx, endIdx);
    
    // Add click handlers for collapsed section expansion
    expandAbove?.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      this.expandContext(row.expandControls, 'up', 20);
    });
    expandAll.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      const hiddenCountValue = parseInt(expandControls.dataset.hiddenCount) || hiddenCount;
      this.expandContext(row.expandControls, 'all', hiddenCountValue);
    });
    expandBelow?.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      this.expandContext(row.expandControls, 'down', 20);
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
    linesToShow.forEach(line => {
      const lineRow = this.renderDiffLine(fragment, line);
      // Add data attributes for selection
      const fileName = controlsElement.dataset.fileName;
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
        
        const lineRow = this.renderDiffLine(fragment, lineData);
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
      this.showError('Failed to start AI analysis: ' + error.message);
      
      // Reset button
      const btn = document.querySelector('button[onclick*="triggerAIAnalysis"]');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'Analyze with AI';
      }
    }
  }


  /**
   * Load and display AI suggestions
   */
  async loadAISuggestions() {
    if (!this.currentPR) return;

    const { owner, repo, number } = this.currentPR;

    try {
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/ai-suggestions`);
      
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
    if (mainContent) {
      const visibleSuggestions = suggestions.filter(s => s.status !== 'dismissed');
      if (visibleSuggestions.length > 0) {
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
          if (fileName && (fileName === file || fileName.endsWith('/' + file))) {
            fileElement = wrapper;
            break;
          }
        }
      }
      
      if (!fileElement) {
        console.warn(`[UI] Could not find file element for: ${file}`);
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
      
      // Apply collapsed class if the suggestion is dismissed
      if (suggestion.status === 'dismissed') {
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
            <span class="type-badge type-${suggestion.type}">${suggestion.type}</span>
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
          <span class="collapsed-text">Hidden AI suggestion</span>
          <span class="type-badge type-${suggestion.type}">${suggestion.type}</span>
          <span class="collapsed-title">${this.escapeHtml(suggestion.title || '')}</span>
          <button class="btn-restore" onclick="prManager.restoreSuggestion(${suggestion.id})" title="Show suggestion">
            <svg class="octicon octicon-eye" viewBox="0 0 16 16" width="20" height="20">
              <path fill-rule="evenodd" d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"></path>
            </svg>
          </button>
        </div>
        <div class="ai-suggestion-body">
          ${this.escapeHtml(suggestion.body || '')}
        </div>
        <div class="ai-suggestion-actions">
          <button class="btn btn-sm btn-primary" onclick="prManager.adoptSuggestion(${suggestion.id})">
            Adopt
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
   * Adopt an AI suggestion
   */
  async adoptSuggestion(suggestionId) {
    try {
      const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'adopted' })
      });

      if (!response.ok) {
        throw new Error('Failed to adopt suggestion');
      }

      // Hide the suggestion and show as adopted
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (suggestionDiv) {
        suggestionDiv.classList.add('adopted');
        suggestionDiv.querySelector('.ai-suggestion-actions').innerHTML = '<span class="adopted-label">✓ Adopted</span>';
      }

      // Refresh the navigator
      await this.loadAISuggestions();

    } catch (error) {
      console.error('Error adopting suggestion:', error);
      alert('Failed to adopt suggestion');
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
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
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
    
    toggleBtn.addEventListener('click', () => {
      sidebar.style.display = 'none';
      collapsedBtn.style.display = 'flex';
      mainContent.classList.add('sidebar-collapsed');
    });
    
    collapsedBtn.addEventListener('click', () => {
      sidebar.style.display = 'block';
      collapsedBtn.style.display = 'none';
      mainContent.classList.remove('sidebar-collapsed');
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
}

// Initialize PR manager when DOM is loaded
let prManager;
document.addEventListener('DOMContentLoaded', () => {
  prManager = new PRManager();
});