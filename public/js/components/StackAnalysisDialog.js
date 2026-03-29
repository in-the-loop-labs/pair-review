// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stack Analysis Dialog Component
 * Modal showing stack PRs with checkboxes for selection before analysis.
 * Returns a Promise resolving to { selectedPRNumbers } or null if cancelled.
 */
class StackAnalysisDialog {
  constructor(container) {
    this.container = container || document.body;
    this.overlay = null;
    this._resolve = null;
    this._stackData = null;
    this._currentPRNumber = null;

    // Bind methods
    this.handleKeydown = this.handleKeydown.bind(this);
  }

  /**
   * Open the dialog, fetch stack info, and let the user select PRs.
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - Current PR number
   * @returns {Promise<{selectedPRNumbers: number[]}|null>} Selected PR numbers or null if cancelled
   */
  open(owner, repo, number) {
    this._currentPRNumber = number;

    return new Promise((resolve) => {
      this._resolve = resolve;
      this._createOverlay();
      this._showLoading();
      this._attachListeners();
      this._fetchStackInfo(owner, repo, number);
    });
  }

  // ---------------------------------------------------------------------------
  // DOM creation
  // ---------------------------------------------------------------------------

  _createOverlay() {
    // Remove any existing overlay
    this._removeOverlay();

    const overlay = document.createElement('div');
    overlay.className = 'stack-dialog-overlay';

    overlay.innerHTML = `
      <div class="stack-dialog-backdrop" data-action="cancel"></div>
      <div class="stack-dialog">
        <div class="stack-dialog-header">
          <h3>Analyze Stack</h3>
          <button class="modal-close-btn" data-action="cancel" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>
        <div class="stack-dialog-body">
          <!-- Populated dynamically -->
        </div>
        <div class="stack-dialog-footer">
          <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn btn-primary stack-dialog-submit" data-action="submit" disabled>Configure &amp; Analyze</button>
        </div>
      </div>
    `;

    this.container.appendChild(overlay);
    this.overlay = overlay;

    // Event delegation for clicks
    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') {
        this._cancel();
        return;
      }
      if (action === 'submit') {
        this._submit();
        return;
      }
      if (action === 'select-all') {
        this._setAllChecked(true);
        return;
      }
      if (action === 'select-none') {
        this._setAllChecked(false);
        return;
      }

      // Checkbox change via clicking the row
      const checkbox = e.target.closest('.stack-dialog-pr-checkbox');
      if (checkbox) {
        // Let the native checkbox toggle, then update button state
        setTimeout(() => this._updateSubmitButton(), 0);
      }
    });

    // Handle checkbox changes (covers keyboard toggle too)
    overlay.addEventListener('change', () => {
      this._updateSubmitButton();
    });
  }

  _showLoading() {
    const body = this.overlay?.querySelector('.stack-dialog-body');
    if (!body) return;

    body.innerHTML = `
      <div class="stack-dialog-loading">
        <span class="council-spinner"></span>
        <span>Loading stack info...</span>
      </div>
    `;
  }

  _showError(message) {
    const body = this.overlay?.querySelector('.stack-dialog-body');
    if (!body) return;

    body.innerHTML = `
      <div class="stack-dialog-error">
        <p>${this._escapeHtml(message)}</p>
      </div>
    `;
  }

  _renderPRList(stack) {
    const body = this.overlay?.querySelector('.stack-dialog-body');
    if (!body) return;

    // Filter to non-trunk entries with PR numbers
    const prs = stack.filter(entry => !entry.isTrunk && entry.prNumber);
    if (prs.length === 0) {
      this._showError('No PRs found in this stack.');
      return;
    }

    this._stackData = prs;

    // Find the lowest PR number for the bottom-up note
    const lowestPR = Math.min(...prs.map(p => p.prNumber));

    let html = `
      <div class="stack-dialog-controls">
        <button class="btn btn-sm btn-secondary" data-action="select-all">Select All</button>
        <button class="btn btn-sm btn-secondary" data-action="select-none">Select None</button>
      </div>
      <div class="stack-dialog-pr-list">
    `;

    for (const pr of prs) {
      const isCurrent = pr.prNumber === this._currentPRNumber;
      const currentClass = isCurrent ? ' stack-dialog-pr-current' : '';
      const currentBadge = isCurrent ? ' <span class="stack-dialog-current-badge">\u2605</span>' : '';
      const analysisBadge = pr.hasAnalysis
        ? ' <span class="stack-dialog-analyzed-badge" title="Has existing analysis">\u2022 analyzed</span>'
        : '';

      html += `
        <label class="stack-dialog-pr-item${currentClass}">
          <input type="checkbox" class="stack-dialog-pr-checkbox" data-pr-number="${pr.prNumber}" checked />
          <span class="stack-dialog-pr-number">#${pr.prNumber}</span>
          <span class="stack-dialog-pr-title">${this._escapeHtml(pr.title || pr.branch || '')}</span>
          <span class="stack-dialog-pr-branch">${this._escapeHtml(pr.branch || '')}</span>
          ${currentBadge}
          ${analysisBadge}
        </label>
      `;
    }

    html += `
      </div>
      <div class="stack-dialog-note">
        Bottom-up order: analysis starts from #${lowestPR}
      </div>
    `;

    body.innerHTML = html;

    // Enable submit button
    this._updateSubmitButton();
  }

  // ---------------------------------------------------------------------------
  // Fetch
  // ---------------------------------------------------------------------------

  async _fetchStackInfo(owner, repo, number) {
    try {
      const response = await fetch(`/api/pr/${owner}/${repo}/${number}/stack-info`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to fetch stack info (${response.status})`);
      }

      const data = await response.json();
      this._renderPRList(data.stack || []);
    } catch (error) {
      console.error('Error fetching stack info:', error);
      this._showError(error.message || 'Failed to load stack information.');
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  _getSelectedPRNumbers() {
    if (!this.overlay) return [];
    const checkboxes = this.overlay.querySelectorAll('.stack-dialog-pr-checkbox:checked');
    return Array.from(checkboxes).map(cb => Number(cb.dataset.prNumber));
  }

  _setAllChecked(checked) {
    if (!this.overlay) return;
    const checkboxes = this.overlay.querySelectorAll('.stack-dialog-pr-checkbox');
    checkboxes.forEach(cb => { cb.checked = checked; });
    this._updateSubmitButton();
  }

  _updateSubmitButton() {
    const submitBtn = this.overlay?.querySelector('.stack-dialog-submit');
    if (!submitBtn) return;
    const selected = this._getSelectedPRNumbers();
    submitBtn.disabled = selected.length === 0;
  }

  _submit() {
    const selectedPRNumbers = this._getSelectedPRNumbers();
    if (selectedPRNumbers.length === 0) return;

    this._cleanup();
    if (this._resolve) {
      this._resolve({ selectedPRNumbers });
      this._resolve = null;
    }
  }

  _cancel() {
    this._cleanup();
    if (this._resolve) {
      this._resolve(null);
      this._resolve = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Listeners & cleanup
  // ---------------------------------------------------------------------------

  _attachListeners() {
    document.addEventListener('keydown', this.handleKeydown);
  }

  handleKeydown(e) {
    if (e.key === 'Escape') {
      this._cancel();
    }
  }

  _cleanup() {
    document.removeEventListener('keydown', this.handleKeydown);
    this._removeOverlay();
    this._stackData = null;
    this._currentPRNumber = null;
  }

  _removeOverlay() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.StackAnalysisDialog = StackAnalysisDialog;
}

// Export for Node.js/test environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StackAnalysisDialog };
}
