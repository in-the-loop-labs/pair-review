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
   * @param {string} options.containerPrefix - Prefix for DOM element IDs (default: 'analysis-context')
   */
  constructor({ reviewId, mode, onSelectionChange, containerPrefix = 'analysis-context' }) {
    this.reviewId = reviewId;
    this.mode = mode;
    this.onSelectionChange = onSelectionChange;
    this.containerPrefix = containerPrefix;

    // State
    this.runs = [];
    this.selectedRunId = null;
    this.selectedRun = null;
    this.isDropdownOpen = false;
    this.isPopoverOpen = false;

    // DOM elements (cached after init)
    this.container = null;
    this.emptyState = null;
    this.selector = null;
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
    const prefix = this.containerPrefix;

    // Cache DOM elements using configurable prefix
    this.container = document.getElementById(prefix);
    this.emptyState = document.getElementById(`${prefix}-empty`);
    this.selector = document.getElementById(`${prefix}-selector`);
    this.historyBtn = document.getElementById(`${prefix}-btn`);
    this.historyLabel = document.getElementById(`${prefix}-label`);
    this.dropdown = document.getElementById(`${prefix}-dropdown`);
    this.listElement = document.getElementById(`${prefix}-list`);
    this.infoBtn = document.getElementById(`${prefix}-info-btn`);
    this.infoPopover = document.getElementById(`${prefix}-popover`);
    this.infoContent = document.getElementById(`${prefix}-info-content`);

    if (!this.container || !this.historyBtn) {
      console.warn(`Analysis history elements not found in DOM with prefix: ${prefix}`);
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
        // Handle copy button first - it takes priority and stops propagation
        const copyBtn = e.target.closest('[data-action="copy-instructions"]');
        if (copyBtn) {
          e.stopPropagation();
          this.handleCopyInstructions(copyBtn, e);
          return; // Don't process other actions
        }

        // Handle toggle button for repo instructions
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
      const fullTitle = `${this.formatProviderName(run.provider)} - ${run.model || 'Unknown'}`;

      return `
        <button class="analysis-history-item ${isSelected ? 'selected' : ''}" data-run-id="${run.id}">
          <div class="analysis-history-item-main" title="${this.escapeHtml(fullTitle)}">
            <span class="analysis-history-item-provider">${providerName}</span>
            <span class="analysis-history-item-model">&middot; ${modelName}</span>
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
    this.updateSelectedLabel();

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
   * Update the selected label in the dropdown button
   * Shows: <timestamp> · <provider> · <model>
   */
  updateSelectedLabel() {
    if (!this.historyLabel || !this.selectedRun) return;

    const run = this.selectedRun;
    const timeAgo = this.formatRelativeTime(run.completed_at || run.started_at);
    const provider = this.formatProviderName(run.provider);
    const model = run.model || 'Unknown';

    this.historyLabel.textContent = `${timeAgo} \u00B7 ${provider} \u00B7 ${model}`;
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

    // Get the tier for this analysis run's model
    const tier = this.getTierForModel(run.model);
    const tierBadgeHtml = tier
      ? `<span class="analysis-tier-badge analysis-tier-${tier}">${this.formatTierName(tier)}</span>`
      : '';

    let html = `
      <div class="analysis-info-row">
        <span class="analysis-info-label">Provider</span>
        <span class="analysis-info-value">${this.escapeHtml(this.formatProviderName(run.provider))}</span>
      </div>
      <div class="analysis-info-row">
        <span class="analysis-info-label">Model</span>
        <span class="analysis-info-value">${this.escapeHtml(run.model || 'Unknown')}${tierBadgeHtml ? ` ${tierBadgeHtml}` : ''}</span>
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
      // Show request instructions prominently as "Custom Instructions" with copy button
      // Use base64 encoding for data-content to preserve special characters when copying
      html += `
        <div class="analysis-info-instructions">
          <div class="analysis-info-instructions-header">
            <span class="analysis-info-instructions-label">Custom Instructions</span>
            <button class="analysis-info-copy-btn" data-action="copy-instructions" data-content="${btoa(String.fromCharCode(...new TextEncoder().encode(run.request_instructions)))}" title="Copy to clipboard">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
                <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
              </svg>
              <span class="copy-btn-text">Copy</span>
            </button>
          </div>
          <div class="analysis-info-instructions-text">${this.escapeHtml(run.request_instructions)}</div>
        </div>
      `;
    }

    if (hasRepoInstructions) {
      // Show repo instructions in a collapsible section with copy button
      // Use a wrapper div instead of nested buttons (invalid HTML)
      // Use base64 encoding for data-content to preserve special characters when copying
      html += `
        <div class="analysis-info-repo-section">
          <div class="analysis-info-repo-header">
            <button class="analysis-info-repo-toggle" data-action="toggle-repo-instructions">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Repository Instructions
            </button>
            <button class="analysis-info-copy-btn" data-action="copy-instructions" data-content="${btoa(String.fromCharCode(...new TextEncoder().encode(run.repo_instructions)))}" title="Copy to clipboard">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
                <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
              </svg>
              <span class="copy-btn-text">Copy</span>
            </button>
          </div>
          <div class="analysis-info-repo-content">
            <div class="analysis-info-instructions-text">${this.escapeHtml(run.repo_instructions)}</div>
          </div>
        </div>
      `;
    } else if (hasLegacyInstructions && !hasRequestInstructions) {
      // Backward compatibility: show legacy custom_instructions if no new fields exist
      // Use base64 encoding for data-content to preserve special characters when copying
      html += `
        <div class="analysis-info-instructions">
          <div class="analysis-info-instructions-header">
            <span class="analysis-info-instructions-label">Custom Instructions (Combined)</span>
            <button class="analysis-info-copy-btn" data-action="copy-instructions" data-content="${btoa(String.fromCharCode(...new TextEncoder().encode(run.custom_instructions)))}" title="Copy to clipboard">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
                <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
              </svg>
              <span class="copy-btn-text">Copy</span>
            </button>
          </div>
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
      // Re-render dropdown to get fresh timestamps
      if (this.runs.length > 0) {
        this.renderDropdown(this.runs);
      }
      // Also update the selected label for fresh timestamp
      this.updateSelectedLabel();

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
    // Toggle expanded class on the parent section element
    const section = button.closest('.analysis-info-repo-section');
    if (section) {
      section.classList.toggle('expanded');
    }
  }

  /**
   * Handle copy instructions button click
   * @param {HTMLElement} button - The copy button element
   * @param {Event} e - The click event (optional, for stopPropagation)
   */
  async handleCopyInstructions(button, e) {
    // Stop propagation to prevent the toggle from being triggered
    if (e) {
      e.stopPropagation();
    }

    const encodedContent = button.dataset.content;
    if (!encodedContent) return;

    try {
      // Decode from base64 (handles UTF-8 characters properly)
      const content = new TextDecoder().decode(Uint8Array.from(atob(encodedContent), c => c.charCodeAt(0)));
      await navigator.clipboard.writeText(content);

      // Show "Copied!" feedback
      button.classList.add('copied');
      const textSpan = button.querySelector('.copy-btn-text');
      const originalText = textSpan?.textContent;
      if (textSpan) {
        textSpan.textContent = 'Copied!';
      }

      // Reset after a brief delay
      setTimeout(() => {
        button.classList.remove('copied');
        if (textSpan && originalText) {
          textSpan.textContent = originalText;
        }
      }, 1500);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }

  /**
   * Show the analysis selector (hides empty state, shows selector)
   */
  show() {
    if (this.emptyState) {
      this.emptyState.style.display = 'none';
    }
    if (this.selector) {
      this.selector.style.display = '';
    }
  }

  /**
   * Hide the analysis selector (shows empty state, hides selector)
   */
  hide() {
    if (this.emptyState) {
      this.emptyState.style.display = '';
    }
    if (this.selector) {
      this.selector.style.display = 'none';
    }
  }

  /**
   * Parse a timestamp string, ensuring UTC interpretation for SQLite timestamps.
   * SQLite's CURRENT_TIMESTAMP produces strings like "2024-01-20 15:30:00" without
   * timezone indicator. JavaScript's Date() would interpret these as local time,
   * but they're actually UTC. This helper ensures correct UTC parsing.
   * @param {string} timestamp - Timestamp string (ISO 8601 or SQLite format)
   * @returns {Date} Parsed Date object
   */
  parseTimestamp(timestamp) {
    if (!timestamp) return new Date(NaN);

    // If the timestamp already has timezone info (ends with Z or +/-offset), parse as-is
    if (/Z$|[+-]\d{2}:\d{2}$/.test(timestamp)) {
      return new Date(timestamp);
    }

    // SQLite CURRENT_TIMESTAMP format: "YYYY-MM-DD HH:MM:SS" (no timezone, but is UTC)
    // Append 'Z' to interpret as UTC
    return new Date(timestamp + 'Z');
  }

  /**
   * Format a timestamp to relative time (e.g., "2 hours ago")
   * For timestamps less than 1 hour old, shows actual time (e.g., "3:45 PM")
   * For 1-24 hours, shows "X hours ago"
   * For 1-7 days, shows "X days ago"
   * For older, shows the date (e.g., "Jan 15")
   * @param {string} timestamp - ISO timestamp or SQLite timestamp
   * @returns {string} Relative time string
   */
  formatRelativeTime(timestamp) {
    if (!timestamp) return 'Unknown';

    const now = new Date();
    const date = this.parseTimestamp(timestamp);
    const diffMs = now - date;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) {
      // Less than 1 hour: show actual time (e.g., "3:45 PM")
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
   * @param {string} timestamp - ISO timestamp or SQLite timestamp
   * @returns {string} Formatted date string
   */
  formatDate(timestamp) {
    if (!timestamp) return 'Unknown';

    const date = this.parseTimestamp(timestamp);
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

    const start = this.parseTimestamp(startedAt);
    const end = this.parseTimestamp(completedAt);
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
   * Get the tier for a given model ID
   * Maps model IDs to their corresponding tiers (fast, balanced, thorough)
   * @param {string} modelId - The model identifier (e.g., 'haiku', 'sonnet', 'opus', 'flash', 'pro')
   * @returns {string|null} The tier name or null if unknown
   */
  getTierForModel(modelId) {
    if (!modelId) return null;

    // Model to tier mapping (matches backend provider definitions)
    const modelTiers = {
      // Claude models
      'haiku': 'fast',
      'sonnet': 'balanced',
      'opus': 'thorough',
      // Gemini models
      'flash': 'fast',
      'pro': 'balanced',
      'ultra': 'thorough',
      // Codex/OpenAI models
      'gpt-4o-mini': 'fast',
      'gpt-4o': 'balanced',
      'o1': 'thorough',
      'o1-mini': 'balanced',
      // Copilot models
      'gpt-4': 'balanced'
    };

    return modelTiers[modelId] || null;
  }

  /**
   * Format a tier name for display
   * @param {string} tier - The tier identifier (e.g., 'fast', 'balanced', 'thorough')
   * @returns {string} Display name in uppercase
   */
  formatTierName(tier) {
    if (!tier) return '';
    return tier.toUpperCase();
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
