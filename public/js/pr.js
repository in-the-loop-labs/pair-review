/**
 * Pull Request UI Management
 */
class PRManager {
  constructor() {
    this.currentPR = null;
    this.loadingState = false;
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
    
    container.innerHTML = `
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
      
      <div class="pr-tabs">
        <div class="tab-nav">
          <button class="tab-btn active" data-tab="files">Files Changed</button>
          <button class="tab-btn" data-tab="diff">Diff View</button>
          <button class="tab-btn" data-tab="comments">Comments</button>
        </div>
        
        <div class="tab-content">
          <div id="files-tab" class="tab-pane active">
            <div class="loading-placeholder">Loading files...</div>
          </div>
          <div id="diff-tab" class="tab-pane">
            <div class="loading-placeholder">Loading diff...</div>
          </div>
          <div id="comments-tab" class="tab-pane">
            <div class="loading-placeholder">Loading comments...</div>
          </div>
        </div>
      </div>
    `;

    // Setup tab navigation
    this.setupTabs();
    
    // Load initial tab content
    this.loadFilesTab();
    
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
   * Setup tab navigation
   */
  setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');
        
        // Update active states
        tabBtns.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => p.classList.remove('active'));
        
        btn.classList.add('active');
        document.getElementById(`${tabId}-tab`).classList.add('active');
        
        // Load tab content if needed
        if (tabId === 'diff') {
          this.loadDiffTab();
        } else if (tabId === 'comments') {
          this.loadCommentsTab();
        }
      });
    });
  }

  /**
   * Load files tab content
   */
  async loadFilesTab() {
    if (!this.currentPR) return;

    try {
      const owner = this.currentPR.owner || this.currentPR.repository?.split('/')[0];
      const repo = this.currentPR.repo || this.currentPR.repository?.split('/')[1];
      const response = await fetch(`/api/pr/${owner}/${repo}/${this.currentPR.number}/diff`);
      
      if (response.ok) {
        const data = await response.json();
        this.displayFiles(data.changed_files || []);
      } else {
        document.getElementById('files-tab').innerHTML = '<div class="error-message">Failed to load files</div>';
      }
    } catch (error) {
      document.getElementById('files-tab').innerHTML = '<div class="error-message">Error loading files</div>';
    }
  }

  /**
   * Load diff tab content
   */
  async loadDiffTab() {
    if (!this.currentPR) return;

    const diffTab = document.getElementById('diff-tab');
    if (diffTab.dataset.loaded) return; // Already loaded

    try {
      const owner = this.currentPR.owner || this.currentPR.repository?.split('/')[0];
      const repo = this.currentPR.repo || this.currentPR.repository?.split('/')[1];
      const response = await fetch(`/api/pr/${owner}/${repo}/${this.currentPR.number}/diff`);
      
      if (response.ok) {
        const data = await response.json();
        this.displayDiff(data.diff || '');
        diffTab.dataset.loaded = 'true';
      } else {
        diffTab.innerHTML = '<div class="error-message">Failed to load diff</div>';
      }
    } catch (error) {
      diffTab.innerHTML = '<div class="error-message">Error loading diff</div>';
    }
  }

  /**
   * Load comments tab content
   */
  async loadCommentsTab() {
    if (!this.currentPR) return;

    const commentsTab = document.getElementById('comments-tab');
    if (commentsTab.dataset.loaded) return; // Already loaded

    try {
      const owner = this.currentPR.owner || this.currentPR.repository?.split('/')[0];
      const repo = this.currentPR.repo || this.currentPR.repository?.split('/')[1];
      const response = await fetch(`/api/pr/${owner}/${repo}/${this.currentPR.number}/comments`);
      
      if (response.ok) {
        const data = await response.json();
        this.displayComments(data.comments || []);
        commentsTab.dataset.loaded = 'true';
      } else {
        commentsTab.innerHTML = '<div class="error-message">Failed to load comments</div>';
      }
    } catch (error) {
      commentsTab.innerHTML = '<div class="error-message">Error loading comments</div>';
    }
  }

  /**
   * Display files list
   * @param {Array} files - Changed files data
   */
  displayFiles(files) {
    const filesTab = document.getElementById('files-tab');
    
    if (files.length === 0) {
      filesTab.innerHTML = '<div class="empty-state">No changed files found</div>';
      return;
    }

    const filesHtml = files.map(file => `
      <div class="file-item">
        <div class="file-name">${this.escapeHtml(file.file)}</div>
        <div class="file-stats">
          ${file.insertions ? `<span class="additions">+${file.insertions}</span>` : ''}
          ${file.deletions ? `<span class="deletions">-${file.deletions}</span>` : ''}
          ${file.binary ? '<span class="binary">binary</span>' : ''}
        </div>
      </div>
    `).join('');

    filesTab.innerHTML = `<div class="files-list">${filesHtml}</div>`;
  }

  /**
   * Display diff content
   * @param {string} diff - Unified diff content
   */
  displayDiff(diff) {
    const diffTab = document.getElementById('diff-tab');
    
    if (!diff || diff.trim() === '') {
      diffTab.innerHTML = '<div class="empty-state">No diff available</div>';
      return;
    }

    // Simple diff display (can be enhanced with syntax highlighting later)
    const escapedDiff = this.escapeHtml(diff);
    diffTab.innerHTML = `<pre class="diff-content"><code>${escapedDiff}</code></pre>`;
  }

  /**
   * Display comments
   * @param {Array} comments - Comments data
   */
  displayComments(comments) {
    const commentsTab = document.getElementById('comments-tab');
    
    if (comments.length === 0) {
      commentsTab.innerHTML = '<div class="empty-state">No comments yet</div>';
      return;
    }

    const commentsHtml = comments.map(comment => `
      <div class="comment-item ${comment.comment_type}">
        <div class="comment-header">
          <span class="comment-type">${comment.comment_type}</span>
          ${comment.file_path ? `<span class="comment-file">${this.escapeHtml(comment.file_path)}:${comment.line_number || '?'}</span>` : ''}
          <span class="comment-date">${this.formatDate(comment.created_at)}</span>
        </div>
        <div class="comment-content">${this.escapeHtml(comment.comment_text)}</div>
      </div>
    `).join('');

    commentsTab.innerHTML = `<div class="comments-list">${commentsHtml}</div>`;
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
}

// Initialize PR manager when DOM is loaded
let prManager;
document.addEventListener('DOMContentLoaded', () => {
  prManager = new PRManager();
});