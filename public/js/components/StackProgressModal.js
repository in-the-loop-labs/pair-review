// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stack Progress Modal Component
 * Displays per-PR progress during stack analysis.
 * Subscribes to WebSocket for live updates and shows level detail for
 * the currently-running PR.
 */
class StackProgressModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.isRunningInBackground = false;
    this.stackAnalysisId = null;
    this.prList = [];
    this.owner = null;
    this.repo = null;
    this._wsStackUnsub = null;
    this._wsAnalysisUnsubs = new Map();
    this._onReconnect = null;
    this._prStatuses = [];
    this._onComplete = null;

    this._createModal();
    this._setupEventListeners();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Show the modal and begin tracking stack analysis progress.
   * @param {string} stackAnalysisId - The stack analysis tracking ID
   * @param {Array<{prNumber: number, title?: string}>} prList - Ordered list of PRs being analyzed
   * @param {Object} context - Additional context
   * @param {string} context.owner - Repository owner
   * @param {string} context.repo - Repository name
   */
  open(stackAnalysisId, prList, context = {}) {
    this.stackAnalysisId = stackAnalysisId;
    this.prList = prList;
    this.owner = context.owner || null;
    this.repo = context.repo || null;
    this._onComplete = context.onComplete || null;
    this._prStatuses = prList.map(pr => ({
      prNumber: pr.prNumber,
      title: pr.title || `PR #${pr.prNumber}`,
      status: 'pending',
      analysisId: null,
      suggestionsCount: null,
      error: null
    }));

    this.isVisible = true;
    this.isRunningInBackground = false;

    this._rebuildBody();
    this._updateFooter('running');
    this.modal.style.display = 'flex';

    this._startMonitoring();
  }

  /**
   * Hide the modal. Keeps subscriptions alive if analysis is still running
   * so it can be reopened later.
   */
  hide() {
    this.isVisible = false;
    this.isRunningInBackground = !!this._wsStackUnsub;
    this.modal.style.display = 'none';
  }

  /**
   * Run the analysis in the background (same as hide — kept for API clarity).
   */
  runInBackground() {
    this.hide();
  }

  /**
   * Reopen the progress modal after it was hidden/backgrounded.
   */
  reopenFromBackground() {
    if (this.stackAnalysisId) {
      this.isRunningInBackground = false;
      this.isVisible = true;
      this.modal.style.display = 'flex';
      // Re-fetch status in case we missed updates
      this._fetchStatus();
    }
  }

  /**
   * Whether a stack analysis is actively running (for external callers).
   */
  get isActive() {
    return !!this.stackAnalysisId && (this.isVisible || this.isRunningInBackground);
  }

  /**
   * Cancel the stack analysis.
   */
  async cancel() {
    if (!this.stackAnalysisId) {
      this.hide();
      return;
    }

    try {
      await fetch(`/api/analyses/stack/${this.stackAnalysisId}/cancel`, { method: 'POST' });
    } catch (error) {
      console.warn('Stack cancel request failed:', error.message);
    }

    this._stopMonitoring();
    this.stackAnalysisId = null;
    this.isRunningInBackground = false;
    if (this._onComplete) {
      this._onComplete('cancelled');
    }
    this.isVisible = false;
    this.modal.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // DOM creation
  // ---------------------------------------------------------------------------

  _createModal() {
    const existing = document.getElementById('stack-progress-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'stack-progress-modal';
    overlay.className = 'stack-progress-overlay';
    overlay.style.display = 'none';

    overlay.innerHTML = `
      <div class="stack-progress-backdrop" data-action="close"></div>
      <div class="stack-progress-modal">
        <div class="stack-progress-header">
          <h3>Stack Analysis Progress</h3>
          <button class="modal-close-btn" data-action="close" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>
        <div class="stack-progress-body">
          <!-- Rebuilt dynamically -->
        </div>
        <div class="stack-progress-footer">
          <button class="btn btn-danger stack-progress-cancel-btn" data-action="cancel">Cancel</button>
          <button class="btn btn-secondary stack-progress-bg-btn" data-action="background">Run in Background</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.modal = overlay;
  }

  _setupEventListeners() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });

    document.addEventListener('click', (e) => {
      if (!this.modal) return;

      const actionEl = e.target.closest('#stack-progress-modal [data-action]');
      if (!actionEl) return;

      const action = actionEl.dataset.action;
      if (action === 'close') {
        this.hide();
      } else if (action === 'cancel') {
        this.cancel();
      } else if (action === 'background') {
        this.runInBackground();
      }
    });

    // Handle clicks on completed PR links
    document.addEventListener('click', (e) => {
      const link = e.target.closest('#stack-progress-modal .stack-progress-pr-link');
      if (link) {
        const href = link.dataset.href;
        if (href) {
          window.location.href = href;
        }
      }
    });
  }

  _rebuildBody() {
    const body = this.modal?.querySelector('.stack-progress-body');
    if (!body) return;

    let html = '<div class="stack-progress-pr-list">';

    for (const pr of this._prStatuses) {
      html += this._renderPRRow(pr);
    }

    html += '</div>';
    body.innerHTML = html;
  }

  _renderPRRow(pr) {
    const statusIcon = this._getStatusIcon(pr.status);
    const statusClass = `status-${pr.status}`;
    const detailText = this._getDetailText(pr);

    return `
      <div class="stack-progress-pr-row ${statusClass}" data-pr-number="${pr.prNumber}">
        <span class="stack-progress-status-icon ${statusClass}">${statusIcon}</span>
        <span class="stack-progress-pr-label">
          PR #${pr.prNumber}: ${this._escapeHtml(pr.title)}
        </span>
        <span class="stack-progress-pr-detail">${detailText}</span>
      </div>
    `;
  }

  _getStatusIcon(status) {
    switch (status) {
      case 'completed': return '\u2713';
      case 'running': return '<span class="council-spinner"></span>';
      case 'setting_up': return '<span class="council-spinner"></span>';
      case 'pending': return '\u25CB';
      case 'failed': return '\u2717';
      case 'cancelled': return '\u2298';
      default: return '\u25CB';
    }
  }

  _getDetailText(pr) {
    switch (pr.status) {
      case 'completed':
        return pr.suggestionsCount != null ? `${pr.suggestionsCount} suggestions` : 'Complete';
      case 'running':
        return 'Analyzing...';
      case 'setting_up':
        return 'Setting up...';
      case 'pending':
        return 'Pending';
      case 'failed':
        return pr.error ? this._escapeHtml(pr.error) : 'Failed';
      case 'cancelled':
        return 'Cancelled';
      default:
        return '';
    }
  }

  _updatePRRow(prNumber) {
    const pr = this._prStatuses.find(p => p.prNumber === prNumber);
    if (!pr) return;

    const row = this.modal?.querySelector(`.stack-progress-pr-row[data-pr-number="${prNumber}"]`);
    if (!row) return;

    const iconEl = row.querySelector('.stack-progress-status-icon');
    const detailEl = row.querySelector('.stack-progress-pr-detail');

    // Update status class
    row.className = `stack-progress-pr-row status-${pr.status}`;

    // Update icon
    if (iconEl) {
      iconEl.className = `stack-progress-status-icon status-${pr.status}`;
      iconEl.innerHTML = this._getStatusIcon(pr.status);
    }

    // Update detail text
    if (detailEl) {
      detailEl.innerHTML = this._getDetailText(pr);
    }

    // Make completed PRs clickable links
    if (pr.status === 'completed' && this.owner && this.repo) {
      const labelEl = row.querySelector('.stack-progress-pr-label');
      if (labelEl && !labelEl.classList.contains('stack-progress-pr-link')) {
        const href = `/pr/${this.owner}/${this.repo}/${prNumber}`;
        labelEl.classList.add('stack-progress-pr-link');
        labelEl.dataset.href = href;
        labelEl.title = 'Click to view this PR\'s review';
      }
    }
  }

  _updateFooter(overallStatus) {
    const cancelBtn = this.modal?.querySelector('.stack-progress-cancel-btn');
    const bgBtn = this.modal?.querySelector('.stack-progress-bg-btn');

    if (!cancelBtn || !bgBtn) return;

    const isTerminal = ['completed', 'failed', 'cancelled'].includes(overallStatus);

    if (isTerminal) {
      cancelBtn.style.display = 'none';
      bgBtn.textContent = 'Close';
      bgBtn.dataset.action = 'close';
      bgBtn.className = 'btn btn-secondary stack-progress-bg-btn';
    } else {
      cancelBtn.style.display = '';
      bgBtn.textContent = 'Run in Background';
      bgBtn.dataset.action = 'background';
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket monitoring
  // ---------------------------------------------------------------------------

  _startMonitoring() {
    this._stopMonitoring();
    if (!this.stackAnalysisId) return;

    window.wsClient.connect();

    // Subscribe to stack-level progress
    this._wsStackUnsub = window.wsClient.subscribe(
      `stack-analysis:${this.stackAnalysisId}`,
      (msg) => this._handleStackProgress(msg)
    );

    // Fetch initial status via HTTP (covers startup race)
    this._fetchStatus();

    // Listen for reconnects
    this._onReconnect = () => { this._fetchStatus(); };
    window.addEventListener('wsReconnected', this._onReconnect);
  }

  _stopMonitoring() {
    if (this._wsStackUnsub) {
      this._wsStackUnsub();
      this._wsStackUnsub = null;
    }
    if (this._wsAnalysisUnsubs) {
      for (const unsub of this._wsAnalysisUnsubs.values()) {
        unsub();
      }
      this._wsAnalysisUnsubs.clear();
    }
    if (this._onReconnect) {
      window.removeEventListener('wsReconnected', this._onReconnect);
      this._onReconnect = null;
    }
  }

  _handleStackProgress(msg) {
    if (msg.type !== 'stack-progress') return;

    // Update internal state from the server message
    if (msg.prStatuses && Array.isArray(msg.prStatuses)) {
      for (const serverPR of msg.prStatuses) {
        const local = this._prStatuses.find(p => p.prNumber === serverPR.prNumber);
        if (local) {
          local.status = serverPR.status || local.status;
          local.analysisId = serverPR.analysisId || local.analysisId;
          if (serverPR.suggestionsCount != null) {
            local.suggestionsCount = serverPR.suggestionsCount;
          }
          if (serverPR.error) {
            local.error = serverPR.error;
          }
          this._updatePRRow(local.prNumber);
        }
      }
    }

    // Track per-PR analysis subscriptions for all running PRs
    this._subscribeToRunningPRs(msg.prStatuses);

    // Update footer based on overall status
    this._updateFooter(msg.status || 'running');

    // Handle terminal states
    if (['completed', 'failed', 'cancelled'].includes(msg.status)) {
      this.isRunningInBackground = false;
      this._stopMonitoring();
      if (this._onComplete) {
        this._onComplete(msg.status);
      }
    }
  }

  /**
   * Subscribe to analysis WebSocket topics for all currently running PRs,
   * so we can show inline level progress for each.
   */
  _subscribeToRunningPRs(prStatuses) {
    if (!prStatuses || !window.wsClient) return;

    const runningPRs = prStatuses.filter(p => p.status === 'running' && p.analysisId);
    const runningAnalysisIds = new Set(runningPRs.map(p => p.analysisId));

    // Unsubscribe from analyses no longer running
    for (const [analysisId, unsub] of this._wsAnalysisUnsubs) {
      if (!runningAnalysisIds.has(analysisId)) {
        unsub();
        this._wsAnalysisUnsubs.delete(analysisId);
      }
    }

    // Subscribe to new running analyses
    for (const pr of runningPRs) {
      if (!this._wsAnalysisUnsubs.has(pr.analysisId)) {
        const unsub = window.wsClient.subscribe(
          `analysis:${pr.analysisId}`,
          (msg) => this._handleAnalysisProgress(pr.prNumber, msg)
        );
        this._wsAnalysisUnsubs.set(pr.analysisId, unsub);
      }
    }
  }

  /**
   * Handle individual PR analysis progress (placeholder for future detail).
   * Level-by-level detail (L1/L2/L3) was removed as it cluttered the UI
   * without adding value in the stack context.
   */
  _handleAnalysisProgress(_prNumber, _msg) {
    // No-op: the stack-level progress handler already shows status per PR.
    // Per-analysis subscriptions are kept for potential future use (e.g. %).
  }

  /**
   * Fetch stack analysis status via HTTP for initial state / reconnect.
   */
  _fetchStatus() {
    if (!this.stackAnalysisId) return;

    fetch(`/api/analyses/stack/${this.stackAnalysisId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          this._handleStackProgress({
            type: 'stack-progress',
            ...data
          });
        }
      })
      .catch(err => {
        console.warn('Failed to fetch stack analysis status:', err);
      });
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
  window.StackProgressModal = StackProgressModal;
}

// Export for Node.js/test environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StackProgressModal };
}
