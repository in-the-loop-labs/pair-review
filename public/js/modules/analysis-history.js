// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Analysis History Manager
 *
 * Manages the analysis history dropdown and info popover for selecting
 * between different AI analysis runs. Works in both PR mode and Local mode.
 *
 * Features:
 * - Displays list of analysis runs with model, provider, and timestamp
 * - Allows selecting a specific run to view its suggestions
 * - Shows detailed info popover with duration, suggestion count, and custom instructions
 * - Click outside to close dropdown/popover
 */
class AnalysisHistoryManager {
  /**
   * Create an AnalysisHistoryManager instance
   * @param {Object} options - Configuration options
   * @param {number} options.reviewId - The database review ID
   * @param {string} options.mode - 'pr' or 'local'
   * @param {Function} options.onSelectionChange - Callback when a run is selected, receives (runId, run)
   */
  constructor({ reviewId, mode, onSelectionChange }) {
    this.reviewId = reviewId;
    this.mode = mode;
    this.onSelectionChange = onSelectionChange;

    // State
    this.runs = [];
    this.selectedRunId = null;
    this.selectedRun = null;
    this.isDropdownOpen = false;
    this.isPopoverOpen = false;

    // DOM elements (cached after init)
    this.container = null;
    this.historyBtn = null;
    this.historyLabel = null;
    this.dropdown = null;
    this.listElement = null;
    this.infoBtn = null;
    this.infoPopover = null;
    this.infoContent = null;
  }

  /**
   * Initialize the manager - set up event listeners and cache DOM elements
   */
  init() {
    // Cache DOM elements
    this.container = document.getElementById('analysis-history-container');
    this.historyBtn = document.getElementById('analysis-history-btn');
    this.historyLabel = document.getElementById('analysis-history-label');
    this.dropdown = document.getElementById('analysis-history-dropdown');
    this.listElement = document.getElementById('analysis-history-list');
    this.infoBtn = document.getElementById('analysis-info-btn');
    this.infoPopover = document.getElementById('analysis-info-popover');
    this.infoContent = document.getElementById('analysis-info-content');

    if (!this.container || !this.historyBtn) {
      console.warn('Analysis history elements not found in DOM');
      return;
    }

    // Set up event listeners
    this.historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    if (this.infoBtn) {
      this.infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleInfoPopover();
      });
    }

    // Event delegation for info popover actions
    if (this.infoPopover) {
      this.infoPopover.addEventListener('click', (e) => {
        const toggleBtn = e.target.closest('[data-action="toggle-repo-instructions"]');
        if (toggleBtn) {
          this.handleRepoInstructionsToggle(toggleBtn);
        }
      });
    }

    // Click outside to close - store handler for cleanup
    this.handleDocumentClick = (e) => {
      if (!this.container.contains(e.target)) {
        this.hideDropdown();
        this.hideInfoPopover();
      }
    };
    document.addEventListener('click', this.handleDocumentClick);

    // Escape key to close - store handler for cleanup
    this.handleKeydown = (e) => {
      if (e.key === 'Escape') {
        this.hideDropdown();
        this.hideInfoPopover();
      }
    };
    document.addEventListener('keydown', this.handleKeydown);
  }

  /**
   * Load analysis runs from the API
   * @returns {Promise<Array>} The loaded runs
   */
  async loadAnalysisRuns() {
    if (!this.reviewId) {
      this.hide();
      return [];
    }

    try {
      const response = await fetch(`/api/analysis-runs/${this.reviewId}`);
      if (!response.ok) {
        console.warn('Failed to fetch analysis runs:', response.status);
        this.hide();
        return [];
      }

      const data = await response.json();
      this.runs = data.runs || [];

      if (this.runs.length === 0) {
        this.hide();
        return [];
      }

      // Render the dropdown
      this.renderDropdown(this.runs);

      // Select the latest run by default (first in the list since they're ordered by date DESC)
      if (this.runs.length > 0 && !this.selectedRunId) {
        const latestRun = this.runs[0];
        await this.selectRun(latestRun.id, true); // Trigger callback to load suggestions on initial load
      }

      this.show();
      return this.runs;
    } catch (error) {
      console.error('Error loading analysis runs:', error);
      this.hide();
      return [];
    }
  }

  /**
   * Render the dropdown list with analysis runs
   * @param {Array} runs - Array of analysis run objects
   */
  renderDropdown(runs) {
    if (!this.listElement) return;

    this.listElement.innerHTML = runs.map((run, index) => {
      const isLatest = index === 0;
      const isSelected = run.id === this.selectedRunId;
      const timeAgo = this.formatRelativeTime(run.completed_at || run.started_at);
      const suggestionCount = run.total_suggestions || 0;

      const modelName = this.escapeHtml(run.model || 'Unknown');
      const providerName = this.escapeHtml(this.formatProviderName(run.provider));
      const fullTitle = `${run.model || 'Unknown'} - ${this.formatProviderName(run.provider)}`;

      return `
        <button class="analysis-history-item ${isSelected ? 'selected' : ''}" data-run-id="${run.id}">
          <div class="analysis-history-item-main" title="${this.escapeHtml(fullTitle)}">
            <span class="analysis-history-item-model">${modelName}</span>
            <span class="analysis-history-item-provider">&bull; ${providerName}</span>
            ${isLatest ? '<span class="analysis-latest-badge">LATEST</span>' : ''}
          </div>
          <div class="analysis-history-item-meta">
            <span>${timeAgo}</span>
            <span>${suggestionCount} suggestion${suggestionCount !== 1 ? 's' : ''}</span>
          </div>
        </button>
      `;
    }).join('');

    // Add click handlers to items
    this.listElement.querySelectorAll('.analysis-history-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const runId = item.dataset.runId;
        this.selectRun(runId, true);
        this.hideDropdown();
      });
    });
  }

  /**
   * Select a specific analysis run
   * @param {string} runId - The run ID to select
   * @param {boolean} triggerCallback - Whether to call onSelectionChange
   */
  async selectRun(runId, triggerCallback = true) {
    this.selectedRunId = runId;

    // Find the run in our cached list (handle both string and number IDs)
    this.selectedRun = this.runs.find(r => String(r.id) === String(runId)) || null;

    // Update button label
    if (this.historyLabel && this.selectedRun) {
      this.historyLabel.textContent = `${this.selectedRun.model || 'Unknown'} \u2022 ${this.formatProviderName(this.selectedRun.provider)}`;
    }

    // Update selected state in dropdown
    if (this.listElement) {
      this.listElement.querySelectorAll('.analysis-history-item').forEach(item => {
        item.classList.toggle('selected', item.dataset.runId === runId);
      });
    }

    // Update info popover content
    this.updateInfoPopover();

    // Trigger callback to load suggestions for this run
    if (triggerCallback && this.onSelectionChange) {
      this.onSelectionChange(runId, this.selectedRun);
    }
  }

  /**
   * Update the info popover content with the selected run's details
   */
  updateInfoPopover() {
    if (!this.infoContent || !this.selectedRun) return;

    const run = this.selectedRun;
    const runDate = run.completed_at || run.started_at;
    const formattedDate = runDate ? this.formatDate(runDate) : 'Unknown';
    const duration = this.formatDuration(run.started_at, run.completed_at);
    const suggestionCount = run.total_suggestions || 0;

    let html = `
      <div class="analysis-info-row">
        <span class="analysis-info-label">Model</span>
        <span class="analysis-info-value">${this.escapeHtml(run.model || 'Unknown')}</span>
      </div>
      <div class="analysis-info-row">
        <span class="analysis-info-label">Provider</span>
        <span class="analysis-info-value">${this.escapeHtml(this.formatProviderName(run.provider))}</span>
      </div>
      <div class="analysis-info-row">
        <span class="analysis-info-label">Run at</span>
        <span class="analysis-info-value">${formattedDate}</span>
      </div>
      <div class="analysis-info-row">
        <span class="analysis-info-label">Duration</span>
        <span class="analysis-info-value">${duration}</span>
      </div>
      <div class="analysis-info-row">
        <span class="analysis-info-label">Suggestions</span>
        <span class="analysis-info-value">${suggestionCount}</span>
      </div>
    `;

    // Handle instructions display - check for new separate fields first, fall back to legacy custom_instructions
    const hasRequestInstructions = run.request_instructions && run.request_instructions.trim();
    const hasRepoInstructions = run.repo_instructions && run.repo_instructions.trim();
    const hasLegacyInstructions = run.custom_instructions && run.custom_instructions.trim();

    if (hasRequestInstructions) {
      // Show request instructions prominently as "Custom Instructions"
      html += `
        <div class="analysis-info-instructions">
          <div class="analysis-info-instructions-label">Custom Instructions</div>
          <div class="analysis-info-instructions-text">${this.escapeHtml(run.request_instructions)}</div>
        </div>
      `;
    }

    if (hasRepoInstructions) {
      // Show repo instructions in a collapsible section
      html += `
        <div class="analysis-info-repo-section">
          <button class="analysis-info-repo-toggle" data-action="toggle-repo-instructions">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Repository Instructions
          </button>
          <div class="analysis-info-repo-content">
            <div class="analysis-info-instructions-text">${this.escapeHtml(run.repo_instructions)}</div>
          </div>
        </div>
      `;
    } else if (hasLegacyInstructions && !hasRequestInstructions) {
      // Backward compatibility: show legacy custom_instructions if no new fields exist
      html += `
        <div class="analysis-info-instructions">
          <div class="analysis-info-instructions-label">Custom Instructions (Combined)</div>
          <div class="analysis-info-instructions-text">${this.escapeHtml(run.custom_instructions)}</div>
        </div>
      `;
    }

    this.infoContent.innerHTML = html;
  }

  /**
   * Toggle the dropdown visibility
   */
  toggleDropdown() {
    if (this.isDropdownOpen) {
      this.hideDropdown();
    } else {
      this.showDropdown();
    }
  }

  /**
   * Show the dropdown
   */
  showDropdown() {
    if (this.container) {
      this.container.classList.add('open');
      this.isDropdownOpen = true;
      // Close popover when opening dropdown
      this.hideInfoPopover();
    }
  }

  /**
   * Hide the dropdown
   */
  hideDropdown() {
    if (this.container) {
      this.container.classList.remove('open');
      this.isDropdownOpen = false;
    }
  }

  /**
   * Toggle the info popover visibility
   */
  toggleInfoPopover() {
    if (this.isPopoverOpen) {
      this.hideInfoPopover();
    } else {
      this.showInfoPopover();
    }
  }

  /**
   * Show the info popover
   */
  showInfoPopover() {
    if (this.container) {
      this.container.classList.add('popover-open');
      this.isPopoverOpen = true;
      // Close dropdown when opening popover
      this.hideDropdown();
    }
  }

  /**
   * Hide the info popover
   */
  hideInfoPopover() {
    if (this.container) {
      this.container.classList.remove('popover-open');
      this.isPopoverOpen = false;
    }
  }

  /**
   * Handle repo instructions toggle button click
   * @param {HTMLElement} button - The toggle button element
   */
  handleRepoInstructionsToggle(button) {
    button.classList.toggle('expanded');
  }

  /**
   * Show the container
   */
  show() {
    if (this.container) {
      this.container.style.display = '';
    }
  }

  /**
   * Hide the container
   */
  hide() {
    if (this.container) {
      this.container.style.display = 'none';
    }
  }

  /**
   * Format a timestamp to relative time (e.g., "2 hours ago")
   * @param {string} timestamp - ISO timestamp
   * @returns {string} Relative time string
   */
  formatRelativeTime(timestamp) {
    if (!timestamp) return 'Unknown';

    const now = new Date();
    const date = new Date(timestamp);
    const diffMs = now - date;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
      return 'just now';
    } else if (diffMinutes < 60) {
      return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } else {
      // For older dates, show the actual date
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }

  /**
   * Format a timestamp to a readable date string
   * @param {string} timestamp - ISO timestamp
   * @returns {string} Formatted date string
   */
  formatDate(timestamp) {
    if (!timestamp) return 'Unknown';

    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  /**
   * Format duration between two timestamps
   * @param {string} startedAt - Start timestamp
   * @param {string} completedAt - End timestamp
   * @returns {string} Duration string (e.g., "12.3s", "1m 23s")
   */
  formatDuration(startedAt, completedAt) {
    if (!startedAt || !completedAt) return 'Unknown';

    const start = new Date(startedAt);
    const end = new Date(completedAt);
    const durationMs = end - start;

    if (durationMs < 0) return 'Unknown';

    const seconds = durationMs / 1000;

    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    } else {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.floor(seconds % 60);
      return `${minutes}m ${remainingSeconds}s`;
    }
  }

  /**
   * Format provider name for display
   * @param {string} provider - Provider identifier
   * @returns {string} Display name
   */
  formatProviderName(provider) {
    const providerNames = {
      'claude': 'Claude',
      'gemini': 'Gemini',
      'codex': 'Codex',
      'openai': 'OpenAI'
    };
    return providerNames[provider] || provider || 'Unknown';
  }

  /**
   * Escape HTML special characters
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
   * Get the currently selected run ID
   * @returns {string|null} The selected run ID
   */
  getSelectedRunId() {
    return this.selectedRunId;
  }

  /**
   * Get the currently selected run object
   * @returns {Object|null} The selected run
   */
  getSelectedRun() {
    return this.selectedRun;
  }

  /**
   * Refresh the analysis runs list (e.g., after a new analysis completes)
   * @returns {Promise<Array>} The refreshed runs
   */
  async refresh() {
    const previousSelectedId = this.selectedRunId;
    this.runs = [];
    this.selectedRunId = null;
    this.selectedRun = null;

    const runs = await this.loadAnalysisRuns();

    // If the previously selected run still exists, keep it selected
    // Otherwise, the latest run will be selected by default
    if (previousSelectedId && runs.find(r => String(r.id) === String(previousSelectedId))) {
      await this.selectRun(previousSelectedId, false);
    }

    return runs;
  }

  /**
   * Destroy the manager - remove event listeners for cleanup
   * Call this when the manager is no longer needed (e.g., before recreating)
   */
  destroy() {
    // Remove document-level event listeners
    if (this.handleDocumentClick) {
      document.removeEventListener('click', this.handleDocumentClick);
      this.handleDocumentClick = null;
    }

    if (this.handleKeydown) {
      document.removeEventListener('keydown', this.handleKeydown);
      this.handleKeydown = null;
    }

    // Clear state
    this.runs = [];
    this.selectedRunId = null;
    this.selectedRun = null;
    this.isDropdownOpen = false;
    this.isPopoverOpen = false;
  }
}

// Export for use in other modules
window.AnalysisHistoryManager = AnalysisHistoryManager;
