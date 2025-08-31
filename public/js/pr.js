/**
 * Pull Request UI Management
 */
class PRManager {
  constructor() {
    this.currentPR = null;
    this.loadingState = false;
    this.expandedFolders = new Set();
    this.expandedSections = new Set();
    this.init();
  }

  /**
   * Initialize PR manager
   */
  init() {
    // Check if we have PR context from URL parameters
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
    
    const container = document.getElementById('pr-container');
    if (!container) return;

    container.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">Fetching pull request...</div>
      </div>
    `;
    
    container.style.display = 'flex';
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
    
    // Add event listeners (placeholder - would need actual expand logic)
    expandAbove.addEventListener('click', (e) => {
      console.log('Expand up clicked');
      // TODO: Implement expand up logic
    });
    expandAll.addEventListener('click', (e) => {
      console.log('Expand all clicked');  
      // TODO: Implement expand all logic
    });
    expandBelow.addEventListener('click', (e) => {
      console.log('Expand down clicked');
      // TODO: Implement expand down logic  
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
    
    // Add click handlers (placeholder - would need actual expand logic)
    expandAbove?.addEventListener('click', (e) => {
      console.log('Expand up clicked (collapsed section)');
      // TODO: Implement expand up logic
    });
    expandAll.addEventListener('click', (e) => {
      console.log('Expand all clicked (collapsed section)');
      // TODO: Implement expand all logic
    });
    expandBelow?.addEventListener('click', (e) => {
      console.log('Expand down clicked (collapsed section)');
      // TODO: Implement expand down logic
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
   * Trigger AI analysis (placeholder)
   */
  async triggerAIAnalysis() {
    // TODO: Implement AI analysis trigger
    alert('AI Analysis will be implemented in the next phase');
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
      
      // Render child folders first
      Object.keys(node).forEach(key => {
        if (key !== '_files') {
          const childPath = fullPath ? `${fullPath}/${key}` : key;
          const childElements = this.renderTreeNode(key, node[key], childPath, level + 1);
          elements.push(...childElements);
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
          
          elements.push(fileDiv);
        });
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
}

// Initialize PR manager when DOM is loaded
let prManager;
document.addEventListener('DOMContentLoaded', () => {
  prManager = new PRManager();
});