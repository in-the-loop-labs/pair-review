// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Analysis History Manager
 *
 * Manages the analysis history split-panel dropdown for selecting
 * between different AI analysis runs. Works in both PR mode and Local mode.
 *
 * Features:
 * - Split-panel dropdown: left panel shows compact run list, right panel shows preview
 * - Click to select a run and load its suggestions
 * - Preview panel shows details of the currently selected run
 * - Click outside to close dropdown
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
    this.previewingRunId = null; // Track which run ID is currently being previewed to prevent flicker
    this.newRunId = null; // Track a new run that user hasn't viewed yet
    this.councilNameCache = {}; // Cache council name lookups by council UUID
    this._renderVersion = 0; // Monotonic counter to prevent stale async DOM updates in renderDropdown

    // DOM elements (cached after init)
    this.container = null;
    this.emptyState = null;
    this.selector = null;
    this.historyBtn = null;
    this.historyLabel = null;
    this.dropdown = null;
    this.listElement = null;
    this.previewPanel = null;
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
    this.previewPanel = document.getElementById(`${prefix}-preview`);

    if (!this.container || !this.historyBtn) {
      console.warn(`Analysis history elements not found in DOM with prefix: ${prefix}`);
      return;
    }

    // Set up event listeners
    this.historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    // Event delegation for preview panel actions (copy button, repo instructions toggle)
    if (this.previewPanel) {
      this.previewPanel.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('[data-action="copy-instructions"]');
        if (copyBtn) {
          e.stopPropagation();
          this.handleCopyInstructions(copyBtn, e);
          return;
        }

        const repoToggle = e.target.closest('[data-action="toggle-repo-instructions"]');
        if (repoToggle) {
          e.stopPropagation();
          const container = repoToggle.closest('.analysis-preview-repo-instructions');
          if (container) {
            container.classList.toggle('collapsed');
          }
          return;
        }

        const customToggle = e.target.closest('[data-action="toggle-custom-instructions"]');
        if (customToggle) {
          e.stopPropagation();
          const container = customToggle.closest('.analysis-preview-custom-instructions');
          if (container) {
            container.classList.toggle('collapsed');
          }
          return;
        }

        const summaryToggle = e.target.closest('[data-action="toggle-summary"]');
        if (summaryToggle) {
          e.stopPropagation();
          const container = summaryToggle.closest('.analysis-preview-summary');
          if (container) {
            container.classList.toggle('collapsed');
            // Toggle aria-expanded attribute for accessibility
            const isExpanded = !container.classList.contains('collapsed');
            summaryToggle.setAttribute('aria-expanded', isExpanded);
          }
          return;
        }
      });
    }

    // Click outside to close - store handler for cleanup
    this.handleDocumentClick = (e) => {
      if (!this.container.contains(e.target)) {
        this.hideDropdown();
      }
    };
    document.addEventListener('click', this.handleDocumentClick);

    // Escape key to close - store handler for cleanup
    this.handleKeydown = (e) => {
      if (e.key === 'Escape') {
        this.hideDropdown();
      }
    };
    document.addEventListener('keydown', this.handleKeydown);
  }

  /**
   * Fetch analysis runs from the API
   * @returns {Promise<{runs: Array, error: string|null}>} The fetched runs or error
   * @private
   */
  async fetchRuns() {
    if (!this.reviewId) {
      return { runs: [], error: null };
    }

    try {
      const response = await fetch(`/api/analyses/runs?reviewId=${this.reviewId}`);
      if (!response.ok) {
        return { runs: [], error: `HTTP ${response.status}` };
      }

      const data = await response.json();
      return { runs: data.runs || [], error: null };
    } catch (error) {
      return { runs: [], error: error.message };
    }
  }

  /**
   * Resolve a council name from its UUID, with caching.
   * Fetches from /api/councils/:id and caches the result.
   * @param {string} councilId - The council UUID
   * @returns {Promise<string>} The council name, or 'Unknown Council' on failure
   */
  async resolveCouncilName(councilId) {
    if (!councilId) return 'Unknown Council';

    if (this.councilNameCache[councilId] !== undefined) {
      return this.councilNameCache[councilId];
    }

    try {
      const response = await fetch(`/api/councils/${councilId}`);
      if (!response.ok) {
        this.councilNameCache[councilId] = 'Unknown Council';
        return 'Unknown Council';
      }
      const data = await response.json();
      const name = data.council?.name || 'Unknown Council';
      this.councilNameCache[councilId] = name;
      return name;
    } catch {
      this.councilNameCache[councilId] = 'Unknown Council';
      return 'Unknown Council';
    }
  }

  /**
   * Resolve a council name and patch a DOM element with the result.
   * @param {HTMLElement} element - Element to update
   * @param {string} councilId - Council ID to resolve
   * @param {function} formatter - Takes the resolved name, returns the text to set on the element
   */
  async _patchCouncilName(element, councilId, formatter) {
    const name = await this.resolveCouncilName(councilId);
    if (element && element.isConnected) {
      element.textContent = formatter(name);
    }
  }

  /**
   * Load analysis runs from the API (initial load only)
   *
   * This method is intended for initial page load and always selects the latest run.
   * For refreshing after a new analysis completes, use refresh() instead, which has
   * logic to optionally preserve the user's current selection.
   *
   * @returns {Promise<Array>} The loaded runs
   */
  async loadAnalysisRuns() {
    const { runs, error } = await this.fetchRuns();

    if (error) {
      console.warn('Failed to fetch analysis runs:', error);
      this.hide();
      return [];
    }

    this.runs = runs;

    if (this.runs.length === 0) {
      this.hide();
      return [];
    }

    // Always select the latest run (first in the list since they're ordered by date DESC)
    // This ensures that after a new analysis completes, its results are displayed
    const latestRun = this.runs[0];
    const shouldTriggerCallback = !this.selectedRunId || String(this.selectedRunId) !== String(latestRun.id);
    await this.selectRun(latestRun.id, shouldTriggerCallback);

    // Render the dropdown (after selecting so the selected state is correct)
    this.renderDropdown(this.runs);

    this.show();
    return this.runs;
  }

  /**
   * Render the dropdown list with analysis runs
   * @param {Array} runs - Array of analysis run objects
   */
  renderDropdown(runs) {
    if (!this.listElement) return;

    const renderVersion = ++this._renderVersion;

    this.listElement.innerHTML = runs.map((run) => {
      const isSelected = String(run.id) === String(this.selectedRunId);
      const timeAgo = this.formatRelativeTime(run.completed_at || run.started_at);

      const isCouncil = run.provider === 'council';
      const modelName = isCouncil ? 'council' : this.escapeHtml(run.model || 'Unknown');
      const providerName = this.escapeHtml(this.formatProviderName(run.provider));
      const fullTitle = isCouncil
        ? 'council'
        : `${this.formatProviderName(run.provider)} - ${run.model || 'Unknown'}`;

      return `
        <button class="analysis-history-item ${isSelected ? 'selected' : ''}" data-run-id="${run.id}">
          <div class="analysis-history-item-main" title="${this.escapeHtml(fullTitle)}">
            <span class="analysis-history-item-provider">${providerName}</span>
            <span class="analysis-history-item-model" ${isCouncil ? `data-council-id="${this.escapeHtml(run.model)}"` : ''}>&middot; ${modelName}</span>
          </div>
          <div class="analysis-history-item-meta">
            <span>${timeAgo}</span>
          </div>
        </button>
      `;
    }).join('');

    // Async-resolve council names and patch dropdown items
    const councilRuns = runs.filter(r => r.provider === 'council' && r.model);
    if (councilRuns.length > 0) {
      Promise.all(councilRuns.map(async (run) => {
        const modelSpan = this.listElement.querySelector(
          `.analysis-history-item[data-run-id="${run.id}"] .analysis-history-item-model[data-council-id]`
        );
        await this._patchCouncilName(modelSpan, run.model, n => `\u00B7 ${n}`);
        // Skip title update if a newer render has occurred since we started
        if (this._renderVersion !== renderVersion) return;
        // Update the parent title too (name is now cached from _patchCouncilName)
        const mainDiv = modelSpan?.closest('.analysis-history-item-main');
        if (mainDiv && mainDiv.isConnected) {
          mainDiv.title = `council \u00B7 ${this.councilNameCache[run.model] || 'Unknown Council'}`;
        }
      }));
    }

    // Add click and hover handlers to items
    this.listElement.querySelectorAll('.analysis-history-item').forEach(item => {
      // Click to select
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const runId = item.dataset.runId;
        this.selectRun(runId, true);
        this.hideDropdown();
      });

      // Hover to preview
      item.addEventListener('mouseenter', () => {
        const runId = item.dataset.runId;
        // Add previewing class for visual highlighting
        this.listElement.querySelectorAll('.analysis-history-item').forEach(i => {
          i.classList.remove('previewing');
        });
        item.classList.add('previewing');

        // Only update preview if different from currently previewed run (prevents flicker)
        if (String(runId) !== String(this.previewingRunId)) {
          this.previewingRunId = runId;
          this.updatePreviewPanel(runId);
        }
      });

      item.addEventListener('mouseleave', () => {
        item.classList.remove('previewing');
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

    // If selecting the new run, clear the new run indicator
    if (String(runId) === String(this.newRunId)) {
      this.clearNewRunIndicator();
      // Re-render dropdown to remove the NEW badge
      this.renderDropdown(this.runs);
    }

    // Update button label
    this.updateSelectedLabel();

    // Update selected state in dropdown
    if (this.listElement) {
      this.listElement.querySelectorAll('.analysis-history-item').forEach(item => {
        item.classList.toggle('selected', String(item.dataset.runId) === String(runId));
      });
    }

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

    if (run.provider === 'council' && run.model) {
      // Show placeholder immediately, then resolve council name async
      this.historyLabel.textContent = `${timeAgo} \u00B7 council`;
      this._patchCouncilName(this.historyLabel, run.model, name => `${timeAgo} \u00B7 council \u00B7 ${name}`);
    } else {
      const model = run.model || 'Unknown';
      this.historyLabel.textContent = `${timeAgo} \u00B7 ${provider} \u00B7 ${model}`;
    }
  }

  /**
   * Update the preview panel content for a specific run
   * @param {string} runId - The run ID to preview
   */
  updatePreviewPanel(runId) {
    if (!this.previewPanel) return;

    // Find the run in our cached list
    const run = this.runs.find(r => String(r.id) === String(runId));
    if (!run) {
      this.previewPanel.innerHTML = `
        <div class="analysis-preview-empty">
          <svg class="analysis-preview-empty-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
          </svg>
          <span>Select a run to view details</span>
        </div>
      `;
      return;
    }

    const runDate = run.completed_at || run.started_at;
    const formattedDate = runDate ? this.formatDate(runDate) : 'Unknown';
    const duration = this.formatDuration(run.started_at, run.completed_at);
    const suggestionCount = run.total_suggestions || 0;

    // Get the tier for this analysis run's model
    const tier = this.getTierForModel(run.model);

    // Format HEAD SHA - show abbreviated version with full SHA in title
    const headSha = run.head_sha;
    const headShaDisplay = headSha ? headSha.substring(0, 7) : null;

    // Format status
    const statusInfo = this.formatStatus(run.status);

    // Format model in lowercase
    const modelDisplay = run.model ? run.model.toLowerCase() : 'unknown';
    const isCouncil = run.provider === 'council';

    let html = '';

    if (isCouncil) {
      // For council runs, show a single "Council" row with name (resolved async)
      const cachedName = run.model ? this.councilNameCache[run.model] : null;
      const councilDisplay = cachedName || 'Loading\u2026';
      html += `
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Council</span>
        <span class="analysis-preview-value analysis-preview-council-name" data-council-id="${this.escapeHtml(run.model || '')}">${this.escapeHtml(councilDisplay)}</span>
      </div>`;
    } else {
      html += `
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Provider</span>
        <span class="analysis-preview-value">${this.escapeHtml(this.formatProviderName(run.provider))}</span>
      </div>
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Model</span>
        <span class="analysis-preview-value">${this.escapeHtml(modelDisplay)}</span>
      </div>
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Tier</span>
        <span class="analysis-preview-value">${this.escapeHtml(tier || 'unknown')}</span>
      </div>`;
    }

    // Config type row
    const configLabel = this.getConfigTypeLabel(run);
    const configDisplayMap = {
      'single': 'Single Model',
      'council': 'Council',
      'council-voice': 'Council Reviewer',
      'advanced': 'Advanced'
    };
    const configDisplay = configDisplayMap[configLabel] || configLabel;

    html += `
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Config</span>
        <span class="analysis-preview-value">${this.escapeHtml(configDisplay)}</span>
      </div>
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Status</span>
        <span class="analysis-preview-value analysis-preview-status-badge ${statusInfo.cssClass}">${this.escapeHtml(statusInfo.text)}</span>
      </div>
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Run at</span>
        <span class="analysis-preview-value">${formattedDate}</span>
      </div>
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Duration</span>
        <span class="analysis-preview-value">${duration}</span>
      </div>
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Suggestions</span>
        <span class="analysis-preview-value">${suggestionCount}</span>
      </div>
      ${headShaDisplay ? `
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">HEAD SHA</span>
        <span class="analysis-preview-value analysis-preview-sha" title="${this.escapeHtml(headSha)}">${headShaDisplay}</span>
      </div>
      ` : ''}
    `;

    // Level indicators in preview
    if (run.levels_config) {
      html += `
      <div class="analysis-preview-row">
        <span class="analysis-preview-label">Levels</span>
        <span class="analysis-preview-value">${this.renderLevelIndicators(run)}</span>
      </div>
      `;
    }

    // Add collapsible summary section if present
    const hasSummary = run.summary && run.summary.trim();
    if (hasSummary) {
      const summaryContentId = `analysis-summary-content-${run.id}`;
      html += `
        <div class="analysis-preview-summary collapsed">
          <div class="analysis-preview-summary-header">
            <button class="analysis-preview-summary-toggle" data-action="toggle-summary" aria-expanded="false" aria-controls="${summaryContentId}">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"></path>
              </svg>
              Result Summary
            </button>
          </div>
          <div class="analysis-preview-summary-content" id="${summaryContentId}">
            <div class="analysis-preview-summary-text">${this.escapeHtml(run.summary)}</div>
          </div>
        </div>
      `;
    }

    // Handle instructions display - check for new separate fields first, fall back to legacy custom_instructions
    const hasRequestInstructions = run.request_instructions && run.request_instructions.trim();
    const hasLegacyInstructions = run.custom_instructions && run.custom_instructions.trim();
    const hasRepoInstructions = run.repo_instructions && run.repo_instructions.trim();

    // Add collapsible custom instructions section if present (expanded by default)
    if (hasRequestInstructions) {
      // Show request instructions as collapsible with copy button (expanded by default)
      html += `
        <div class="analysis-preview-custom-instructions">
          <div class="analysis-preview-custom-header">
            <button class="analysis-preview-custom-toggle" data-action="toggle-custom-instructions">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"></path>
              </svg>
              Custom Instructions
            </button>
            <button class="analysis-info-copy-btn" data-action="copy-instructions" data-content="${btoa(String.fromCharCode(...new TextEncoder().encode(run.request_instructions)))}" title="Copy to clipboard">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
                <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
              </svg>
              <span class="copy-btn-text">Copy</span>
            </button>
          </div>
          <div class="analysis-preview-custom-content">
            <div class="analysis-preview-instructions-text">${this.escapeHtml(run.request_instructions)}</div>
          </div>
        </div>
      `;
    } else if (hasLegacyInstructions) {
      // Backward compatibility: show legacy custom_instructions as collapsible with copy button (expanded by default)
      html += `
        <div class="analysis-preview-custom-instructions">
          <div class="analysis-preview-custom-header">
            <button class="analysis-preview-custom-toggle" data-action="toggle-custom-instructions">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"></path>
              </svg>
              Custom Instructions
            </button>
            <button class="analysis-info-copy-btn" data-action="copy-instructions" data-content="${btoa(String.fromCharCode(...new TextEncoder().encode(run.custom_instructions)))}" title="Copy to clipboard">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
                <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
              </svg>
              <span class="copy-btn-text">Copy</span>
            </button>
          </div>
          <div class="analysis-preview-custom-content">
            <div class="analysis-preview-instructions-text">${this.escapeHtml(run.custom_instructions)}</div>
          </div>
        </div>
      `;
    }

    // Add collapsible repo instructions section if present
    if (hasRepoInstructions) {
      html += `
        <div class="analysis-preview-repo-instructions collapsed">
          <div class="analysis-preview-repo-header">
            <button class="analysis-preview-repo-toggle" data-action="toggle-repo-instructions">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"></path>
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
          <div class="analysis-preview-repo-content">
            <div class="analysis-preview-instructions-text">${this.escapeHtml(run.repo_instructions)}</div>
          </div>
        </div>
      `;
    }

    this.previewPanel.innerHTML = html;

    // Async-resolve council name and patch the preview panel element
    if (isCouncil && run.model && !this.councilNameCache[run.model]) {
      const el = this.previewPanel.querySelector(`.analysis-preview-council-name[data-council-id="${run.model}"]`);
      this._patchCouncilName(el, run.model, name => name);
    }
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

      // Initialize preview panel with currently selected run and track it
      if (this.selectedRunId) {
        this.previewingRunId = this.selectedRunId;
        this.updatePreviewPanel(this.selectedRunId);
      }

      this.container.classList.add('open');
      this.isDropdownOpen = true;
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
   * Format provider name for display (lowercase)
   * @param {string} provider - Provider identifier
   * @returns {string} Display name in lowercase
   */
  formatProviderName(provider) {
    // Return provider as-is in lowercase, or 'unknown' if not provided
    return provider ? provider.toLowerCase() : 'unknown';
  }

  /**
   * Format status for display
   * @param {string} status - Status identifier (completed, failed, cancelled)
   * @returns {Object} Object with text and cssClass properties
   */
  formatStatus(status) {
    // Note: 'completed' is displayed as 'success' for better UX clarity -
    // users understand "success" more intuitively than "completed"
    const statusMap = {
      'completed': { text: 'success', cssClass: 'analysis-preview-status-success' },
      'failed': { text: 'failed', cssClass: 'analysis-preview-status-failed' },
      'cancelled': { text: 'cancelled', cssClass: 'analysis-preview-status-cancelled' }
    };
    return statusMap[status] || { text: status || 'unknown', cssClass: 'analysis-preview-status-unknown' };
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
      'sonnet-4.5': 'balanced',
      'sonnet-4.6': 'balanced',
      'opus': 'thorough',
      'opus-4.5': 'thorough',
      'opus-4.6-low': 'balanced',
      'opus-4.6-medium': 'balanced',
      'opus-4.6-1m': 'balanced',
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
      'gpt-4': 'balanced',
      // Pi models
      'default': 'balanced',
      'multi-model': 'thorough',
      'review-roulette': 'thorough'
    };

    return modelTiers[modelId] || null;
  }

  /**
   * Format a tier name for display (uppercase, used for badges)
   * @param {string} tier - The tier identifier (e.g., 'fast', 'balanced', 'thorough')
   * @returns {string} Display name in uppercase
   */
  formatTierName(tier) {
    if (!tier) return '';
    return tier.toUpperCase();
  }

  /**
   * Format a tier name for display as plain text (capitalized)
   * @param {string} tier - The tier identifier (e.g., 'fast', 'balanced', 'thorough')
   * @returns {string} Display name with first letter capitalized (e.g., 'Thorough')
   */
  formatTierDisplayName(tier) {
    if (!tier) return '';
    return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
  }

  /**
   * Determine the display config type for a run.
   * @param {Object} run - Analysis run object
   * @returns {string} One of 'single', 'council', 'council-voice', 'advanced'
   */
  getConfigTypeLabel(run) {
    const configType = run.config_type || 'single';
    if (configType === 'council' && run.parent_run_id) {
      return 'council-voice';
    }
    return configType;
  }

  /**
   * Render a config type badge for a run.
   * @param {Object} run - Analysis run object
   * @returns {string} HTML string for the badge
   */
  renderConfigTypeBadge(run) {
    const label = this.getConfigTypeLabel(run);
    const displayMap = {
      'single': 'Single',
      'council': 'Council',
      'council-voice': 'Reviewer',
      'advanced': 'Advanced'
    };
    const display = displayMap[label] || label;
    if (label === 'single') return '';
    return `<span class="analysis-history-config-badge analysis-history-config-${this.escapeHtml(label)}">${this.escapeHtml(display)}</span>`;
  }

  /**
   * Render level indicators (L1/L2/L3) based on levels_config.
   * @param {Object} run - Analysis run object with optional levels_config
   * @returns {string} HTML string for level indicators
   */
  renderLevelIndicators(run) {
    const levelsConfig = run.levels_config;
    if (!levelsConfig) return '';

    // levels_config can be:
    // - An array like [1, 2] (voice-centric: enabled levels)
    // - An object like { level1: true, level2: true, level3: false } (advanced)
    const levels = [1, 2, 3];
    const indicators = levels.map(level => {
      let enabled;
      if (Array.isArray(levelsConfig)) {
        enabled = levelsConfig.includes(level);
      } else {
        const key = `level${level}`;
        enabled = levelsConfig[key] !== false;
      }
      const cls = enabled ? 'level-on' : 'level-off';
      const icon = enabled ? '\u2713' : '\u2717';
      return `<span class="analysis-history-level ${cls}">L${level}${icon}</span>`;
    });
    return `<span class="analysis-history-levels">${indicators.join('')}</span>`;
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
   * @param {Object} options - Refresh options
   * @param {boolean} options.switchToNew - Whether to switch to the new run (default: true)
   * @returns {Promise<{runs: Array, didSwitch: boolean}>} The refreshed runs and whether we switched to a new run
   */
  async refresh({ switchToNew = true } = {}) {
    const previousSelectedId = this.selectedRunId;
    const previousRuns = [...this.runs];
    let didSwitch = false;

    // Fetch the updated runs list
    const { runs, error } = await this.fetchRuns();

    if (error) {
      console.warn('Failed to fetch analysis runs:', error);
      // Restore previous state on failure
      return { runs: previousRuns, didSwitch: false };
    }

    this.runs = runs;

    if (this.runs.length === 0) {
      this.hide();
      return { runs: [], didSwitch: false };
    }

    // Find the new run (newest run that wasn't in the previous list)
    const latestRun = this.runs[0];
    const isNewRun = latestRun && !previousRuns.find(r => String(r.id) === String(latestRun.id));

    if (isNewRun) {
      // Determine whether to switch to new run:
      // - Always switch if explicitly requested (switchToNew = true)
      // - Always switch if there was no previous selection (user wasn't viewing anything)
      // - Don't switch if user was viewing older results and switchToNew = false
      const hadPreviousSelection = previousSelectedId && previousRuns.length > 0;
      const shouldSwitch = switchToNew || !hadPreviousSelection;

      if (shouldSwitch) {
        // Switch to new run immediately
        this.newRunId = null;
        this.selectedRunId = latestRun.id;
        this.selectedRun = latestRun;
        this.clearNewRunIndicator();
        didSwitch = true;
      } else {
        // User was viewing older results - don't switch, but mark new run
        this.newRunId = latestRun.id;
        // Keep previous selection
        const previousRun = this.runs.find(r => String(r.id) === String(previousSelectedId));
        if (previousSelectedId && previousRun) {
          this.selectedRunId = previousSelectedId;
          this.selectedRun = previousRun;
        }
        // Show amber glow indicator on the dropdown button
        this.showNewRunIndicator();
      }
    } else {
      // No new run, keep previous selection if it still exists
      const previousRun = this.runs.find(r => String(r.id) === String(previousSelectedId));
      if (previousSelectedId && previousRun) {
        this.selectedRunId = previousSelectedId;
        this.selectedRun = previousRun;
      } else {
        // Previous selection no longer exists, select latest
        this.selectedRunId = latestRun?.id || null;
        this.selectedRun = latestRun || null;
      }
    }

    // Update the label and render dropdown
    this.updateSelectedLabel();
    this.renderDropdown(this.runs);
    this.show();

    return { runs: this.runs, didSwitch };
  }

  /**
   * Show the amber glow indicator on the dropdown button to indicate new results are available
   */
  showNewRunIndicator() {
    if (this.historyBtn) {
      this.historyBtn.classList.add('has-new-run');
    }
  }

  /**
   * Clear the amber glow indicator from the dropdown button
   */
  clearNewRunIndicator() {
    if (this.historyBtn) {
      this.historyBtn.classList.remove('has-new-run');
    }
    this.newRunId = null;
  }

  /**
   * Check if there's a new run that the user hasn't viewed yet
   * @returns {boolean} True if there's a new run available
   */
  hasNewRun() {
    return this.newRunId !== null;
  }

  /**
   * Get the ID of the new run (if any)
   * @returns {string|null} The new run ID, or null if none
   */
  getNewRunId() {
    return this.newRunId;
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
  }
}

// Export for use in other modules
window.AnalysisHistoryManager = AnalysisHistoryManager;
