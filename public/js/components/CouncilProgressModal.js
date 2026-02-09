// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Council AI Analysis Progress Modal Component
 *
 * Displays a hierarchical tree view of council analysis progress:
 *   - Levels as parent rows (1, 2, 3)
 *   - Voice participants as child rows under each level
 *   - Consolidation section at the bottom
 *
 * Replaces ProgressModal when a council analysis is running.
 * The existing ProgressModal remains for single-model analysis.
 */
class CouncilProgressModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.currentAnalysisId = null;
    this.eventSource = null;
    this.statusCheckInterval = null;
    this.isRunningInBackground = false;
    this.councilConfig = null;

    // Track per-voice completion state
    this._voiceStates = {};
    // Track SSE endpoint mode
    this._useLocalEndpoint = false;
    this._localReviewId = null;

    this._createModal();
    this._setupEventListeners();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Show the modal for a council analysis.
   * @param {string} analysisId - Analysis ID to track
   * @param {Object} councilConfig - Council configuration (levels + orchestration)
   */
  show(analysisId, councilConfig, councilName) {
    this.currentAnalysisId = analysisId;
    this.councilConfig = councilConfig;
    this.isVisible = true;
    this._voiceStates = {};

    // Rebuild DOM for this config
    this._rebuildBody(councilConfig);

    // Update the header with the council name if provided
    const titleEl = this.modal.querySelector('#council-progress-title');
    if (titleEl) {
      titleEl.textContent = councilName
        ? `Review Council Analysis \u00b7 ${councilName}`
        : 'Review Council Analysis';
    }

    this.modal.style.display = 'flex';
    this._resetFooter();

    this.startProgressMonitoring();
  }

  /**
   * Hide the modal.
   */
  hide() {
    this.isVisible = false;
    this.modal.style.display = 'none';

    if (!this.isRunningInBackground) {
      this.stopProgressMonitoring();
    }
  }

  /**
   * Run analysis in background.
   */
  runInBackground() {
    this.isRunningInBackground = true;
    this.hide();
  }

  /**
   * Reopen the modal from background execution.
   */
  reopenFromBackground() {
    this.isRunningInBackground = false;
    if (this.currentAnalysisId && this.councilConfig) {
      // Don't rebuild — just re-show the existing DOM
      this.isVisible = true;
      this.modal.style.display = 'flex';
    }

    if (window.statusIndicator) {
      window.statusIndicator.hide();
    }
  }

  /**
   * Cancel the analysis.
   */
  async cancel() {
    if (!this.currentAnalysisId) {
      this.hide();
      return;
    }

    try {
      await fetch(`/api/analyze/cancel/${this.currentAnalysisId}`, { method: 'POST' });
    } catch (error) {
      console.warn('Cancel not available on server:', error.message);
    }

    this.stopProgressMonitoring();
    this.hide();

    if (window.prManager) {
      window.prManager.resetButton();
    }
    if (window.aiPanel?.setAnalysisState) {
      window.aiPanel.setAnalysisState('unknown');
    }
  }

  /**
   * Configure for local mode SSE endpoint.
   * @param {string|number} reviewId
   */
  setLocalMode(reviewId) {
    this._useLocalEndpoint = true;
    this._localReviewId = reviewId;
  }

  /**
   * Configure for PR mode SSE endpoint (default).
   */
  setPRMode() {
    this._useLocalEndpoint = false;
    this._localReviewId = null;
  }

  // ---------------------------------------------------------------------------
  // SSE / Polling
  // ---------------------------------------------------------------------------

  startProgressMonitoring() {
    if (this.eventSource) {
      this.eventSource.close();
    }
    if (!this.currentAnalysisId) return;

    const sseUrl = this._useLocalEndpoint
      ? `/api/local/${this._localReviewId}/ai-suggestions/status`
      : `/api/pr/${this.currentAnalysisId}/ai-suggestions/status`;

    this.eventSource = new EventSource(sseUrl);

    this.eventSource.onopen = () => {
      console.log('Council progress: connected to SSE stream');
    };

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') return;
        if (data.type === 'progress') {
          this.updateProgress(data);
          if (['completed', 'failed', 'cancelled'].includes(data.status)) {
            this.stopProgressMonitoring();
          }
        }
      } catch (error) {
        console.error('Error parsing council SSE data:', error);
      }
    };

    this.eventSource.onerror = () => {
      console.error('Council SSE connection error, falling back to polling');
      this._fallbackToPolling();
    };
  }

  stopProgressMonitoring() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  _fallbackToPolling() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }

    this.statusCheckInterval = setInterval(async () => {
      if (!this.currentAnalysisId) return;
      try {
        const response = await fetch(`/api/analyze/status/${this.currentAnalysisId}`);
        if (!response.ok) throw new Error('Failed to fetch status');
        const status = await response.json();
        this.updateProgress(status);
        if (['completed', 'failed', 'cancelled'].includes(status.status)) {
          this.stopProgressMonitoring();
        }
      } catch (error) {
        console.error('Error polling council analysis status:', error);
      }
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Progress update
  // ---------------------------------------------------------------------------

  /**
   * Main handler for incoming progress events.
   * Routes updates to per-level, per-voice, and consolidation sections.
   * @param {Object} status
   */
  updateProgress(status) {
    if (!status.levels || typeof status.levels !== 'object') {
      console.warn('Council progress: invalid status structure', status);
      return;
    }

    // Update each level and its voices
    for (let level = 1; level <= 3; level++) {
      const levelStatus = status.levels[level];
      if (!levelStatus) continue;
      this._updateVoiceFromLevelStatus(level, levelStatus);
      this._refreshLevelHeader(level);
    }

    // Update consolidation / orchestration (level 4)
    const level4 = status.levels[4];
    if (level4) {
      this._updateConsolidation(level4);
    }

    // Update toolbar progress dots
    const manager = window.prManager || window.localManager;
    if (manager?.updateProgressDot) {
      for (let level = 1; level <= 4; level++) {
        if (status.levels[level]) {
          manager.updateProgressDot(level, status.levels[level].status);
        }
      }
    }

    // Terminal states
    if (status.status === 'completed') {
      this._handleCompletion(status);
    } else if (status.status === 'failed') {
      this._handleFailure(status);
    } else if (status.status === 'cancelled') {
      this._handleCancellation(status);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-voice progress
  // ---------------------------------------------------------------------------

  /**
   * Given a level's status (which may include a voiceId), update the right voice row.
   */
  _updateVoiceFromLevelStatus(level, levelStatus) {
    const voiceId = levelStatus.voiceId;

    if (voiceId) {
      // Update specific voice
      this._setVoiceState(voiceId, levelStatus.status || 'running', levelStatus);
    } else if (levelStatus.status === 'completed') {
      // Level completed without a voiceId — mark all pending/running voices as complete
      this._completeAllVoicesForLevel(level);
    } else if (levelStatus.status === 'failed') {
      this._failAllVoicesForLevel(level);
    } else if (levelStatus.status === 'cancelled') {
      this._cancelAllVoicesForLevel(level);
    } else if (levelStatus.status === 'skipped') {
      // Already handled by DOM construction
    }
  }

  /**
   * Shared state rendering helper.
   * Maps a state string to the appropriate icon, CSS class, and label,
   * then applies them to the given icon and status elements.
   *
   * @param {HTMLElement} iconEl  - Element that shows the state icon
   * @param {HTMLElement} statusEl - Element that shows the state label
   * @param {string} state - One of 'pending', 'running', 'completed', 'failed', 'cancelled', 'skipped'
   * @param {string} cssPrefix - CSS class prefix (e.g. 'council-voice' or 'council-level')
   */
  _renderState(iconEl, statusEl, state, cssPrefix) {
    const stateMap = {
      pending:   { icon: '\u25CB', label: 'Pending' },
      running:   { icon: null,     label: 'Running...' },   // null = spinner HTML
      completed: { icon: '\u2713', label: 'Complete' },
      failed:    { icon: '\u2717', label: 'Failed' },
      cancelled: { icon: '\u2298', label: 'Cancelled' },
      skipped:   { icon: '\u2014', label: 'Skipped' }
    };

    const entry = stateMap[state] || stateMap.pending;
    const resolvedState = stateMap[state] ? state : 'pending';

    iconEl.className = `${cssPrefix}-icon ${resolvedState}`;
    if (entry.icon === null) {
      iconEl.innerHTML = '<span class="council-spinner"></span>';
    } else {
      iconEl.textContent = entry.icon;
    }

    statusEl.textContent = entry.label;
    statusEl.className = `${cssPrefix}-status ${resolvedState}`;
  }

  /**
   * Set the display state for a voice element.
   */
  _setVoiceState(voiceId, state, levelStatus) {
    const el = this.modal.querySelector(`[data-voice-id="${voiceId}"]`);
    if (!el) return;

    this._voiceStates[voiceId] = state;

    const iconEl = el.querySelector('.council-voice-icon');
    const statusEl = el.querySelector('.council-voice-status');
    const snippetEl = el.querySelector('.council-voice-snippet');

    this._renderState(iconEl, statusEl, state, 'council-voice');

    // State-specific detail visibility
    if (state === 'running') {
      if (snippetEl && levelStatus?.streamEvent?.text) {
        snippetEl.textContent = levelStatus.streamEvent.text;
        snippetEl.style.display = 'block';
      }
    } else {
      if (snippetEl) snippetEl.style.display = 'none';
    }
  }

  _completeAllVoicesForLevel(level) {
    const voiceEls = this.modal.querySelectorAll(`.council-voice[data-level="${level}"]`);
    voiceEls.forEach(el => {
      const vid = el.dataset.voiceId;
      if (this._voiceStates[vid] !== 'completed' && this._voiceStates[vid] !== 'failed') {
        this._setVoiceState(vid, 'completed', {});
      }
    });
  }

  _failAllVoicesForLevel(level) {
    const voiceEls = this.modal.querySelectorAll(`.council-voice[data-level="${level}"]`);
    voiceEls.forEach(el => {
      const vid = el.dataset.voiceId;
      if (this._voiceStates[vid] !== 'completed') {
        this._setVoiceState(vid, 'failed', {});
      }
    });
  }

  _cancelAllVoicesForLevel(level) {
    const voiceEls = this.modal.querySelectorAll(`.council-voice[data-level="${level}"]`);
    voiceEls.forEach(el => {
      const vid = el.dataset.voiceId;
      if (this._voiceStates[vid] !== 'completed') {
        this._setVoiceState(vid, 'cancelled', {});
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Level header state
  // ---------------------------------------------------------------------------

  /**
   * Refresh the level header icon/status based on child voice states.
   */
  _refreshLevelHeader(level) {
    const header = this.modal.querySelector(`.council-level-header[data-level="${level}"]`);
    if (!header) return;

    const iconEl = header.querySelector('.council-level-icon');
    const statusEl = header.querySelector('.council-level-status');
    if (!iconEl || !statusEl) return;

    // Check if this level is skipped
    if (header.dataset.skipped === 'true') return;

    const voiceEls = this.modal.querySelectorAll(`.council-voice[data-level="${level}"]`);
    if (voiceEls.length === 0) return;

    const states = Array.from(voiceEls).map(el => this._voiceStates[el.dataset.voiceId] || 'pending');

    const allComplete = states.every(s => s === 'completed');
    const anyRunning = states.some(s => s === 'running');
    const anyFailed = states.some(s => s === 'failed');
    const allCancelled = states.every(s => s === 'cancelled');

    let derivedState;
    if (allComplete) {
      derivedState = 'completed';
    } else if (allCancelled) {
      derivedState = 'cancelled';
    } else if (anyFailed && !anyRunning) {
      derivedState = 'failed';
    } else if (anyRunning) {
      derivedState = 'running';
    } else {
      derivedState = 'pending';
    }

    this._renderState(iconEl, statusEl, derivedState, 'council-level');
  }

  // ---------------------------------------------------------------------------
  // Consolidation section
  // ---------------------------------------------------------------------------

  _updateConsolidation(level4Status) {
    const section = this.modal.querySelector('.council-consolidation');
    if (!section) return;

    const iconEl = section.querySelector('.council-level-icon');
    const statusEl = section.querySelector('.council-level-status');

    const state = level4Status.status;
    if (state === 'pending') return; // default DOM state

    this._renderState(iconEl, statusEl, state, 'council-level');
    this._updateConsolidationChildren(state);
  }

  _updateConsolidationChildren(state) {
    const children = this.modal.querySelectorAll('.council-consolidation-child');
    children.forEach(child => {
      const iconEl = child.querySelector('.council-voice-icon');
      const statusEl = child.querySelector('.council-voice-status');
      if (!iconEl || !statusEl) return;

      this._renderState(iconEl, statusEl, state, 'council-voice');
    });
  }

  // ---------------------------------------------------------------------------
  // Terminal state handlers
  // ---------------------------------------------------------------------------

  _handleCompletion(status) {
    // Mark all remaining voices/levels as complete
    for (let level = 1; level <= 3; level++) {
      this._completeAllVoicesForLevel(level);
      this._refreshLevelHeader(level);
    }
    this._updateConsolidation({ status: 'completed' });

    // Update footer
    const bgBtn = this.modal.querySelector('.council-bg-btn');
    const cancelBtn = this.modal.querySelector('.council-cancel-btn');
    if (bgBtn) {
      bgBtn.textContent = 'Analysis Complete';
      bgBtn.disabled = true;
    }
    if (cancelBtn) {
      cancelBtn.textContent = 'Close';
    }

    // Update button
    if (window.prManager) {
      window.prManager.setButtonComplete();
    }

    // Reload suggestions
    const manager = window.prManager || window.localManager;
    if (manager && typeof manager.loadAISuggestions === 'function') {
      const shouldSwitchToNew = this.isVisible;

      const refreshHistory = async () => {
        if (manager.analysisHistoryManager) {
          const result = await manager.analysisHistoryManager.refresh({ switchToNew: shouldSwitchToNew });
          return result.didSwitch;
        }
        return true;
      };

      refreshHistory()
        .then((didSwitch) => {
          if (didSwitch) {
            return manager.loadAISuggestions();
          }
          console.log('Council analysis complete — user will see indicator on dropdown');
          return Promise.resolve();
        })
        .then(() => {
          console.log('AI suggestions reloaded after council analysis');
          if (this.isVisible) {
            setTimeout(() => this.hide(), 2000);
          }
        })
        .catch(error => {
          console.error('Error reloading AI suggestions:', error);
          if (this.isVisible) {
            setTimeout(() => this.hide(), 5000);
          }
        });
    } else {
      if (this.isVisible) {
        setTimeout(() => this.hide(), 3000);
      }
    }
  }

  _handleFailure(_status) {
    // Clean up any remaining running voices
    for (let level = 1; level <= 3; level++) {
      this._failAllVoicesForLevel(level);
      this._refreshLevelHeader(level);
    }
    this._updateConsolidation({ status: 'failed' });

    const bgBtn = this.modal.querySelector('.council-bg-btn');
    const cancelBtn = this.modal.querySelector('.council-cancel-btn');
    if (bgBtn) {
      bgBtn.textContent = 'Analysis Failed';
      bgBtn.disabled = true;
    }
    if (cancelBtn) {
      cancelBtn.textContent = 'Close';
    }

    if (window.prManager) {
      window.prManager.resetButton();
    }
  }

  _handleCancellation(_status) {
    // Clean up any remaining running voices
    for (let level = 1; level <= 3; level++) {
      this._cancelAllVoicesForLevel(level);
      this._refreshLevelHeader(level);
    }
    this._updateConsolidation({ status: 'cancelled' });

    const bgBtn = this.modal.querySelector('.council-bg-btn');
    const cancelBtn = this.modal.querySelector('.council-cancel-btn');
    if (bgBtn) {
      bgBtn.textContent = 'Analysis Cancelled';
      bgBtn.disabled = true;
    }
    if (cancelBtn) {
      cancelBtn.textContent = 'Close';
    }

    if (window.prManager) {
      window.prManager.resetButton();
    }
    if (window.aiPanel?.setAnalysisState) {
      window.aiPanel.setAnalysisState('unknown');
    }

    if (this.isVisible) {
      setTimeout(() => this.hide(), 1500);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  _createModal() {
    const existing = document.getElementById('council-progress-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'council-progress-modal';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';

    overlay.innerHTML = `
      <div class="modal-backdrop" data-action="close"></div>
      <div class="modal-container council-progress-modal">
        <div class="modal-header">
          <h3 id="council-progress-title">Review Council Analysis</h3>
          <button class="modal-close-btn" data-action="close" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>
        <div class="modal-body council-progress-body">
          <!-- Rebuilt by _rebuildBody -->
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary council-bg-btn">Run in Background</button>
          <button class="btn btn-danger council-cancel-btn">Cancel</button>
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

    // Delegate clicks
    document.addEventListener('click', (e) => {
      if (!this.modal) return;

      // Backdrop / close button
      if (e.target.closest('#council-progress-modal [data-action="close"]')) {
        this.hide();
        return;
      }

      // Background button
      if (e.target.closest('#council-progress-modal .council-bg-btn')) {
        this.runInBackground();
        return;
      }

      // Cancel button
      if (e.target.closest('#council-progress-modal .council-cancel-btn')) {
        this.cancel();
      }
    });
  }

  /**
   * Rebuild the modal body for the given council config.
   */
  _rebuildBody(config) {
    const body = this.modal.querySelector('.council-progress-body');
    if (!body) return;

    body.innerHTML = this._buildTreeHTML(config);
  }

  _resetFooter() {
    const bgBtn = this.modal.querySelector('.council-bg-btn');
    const cancelBtn = this.modal.querySelector('.council-cancel-btn');
    if (bgBtn) {
      bgBtn.textContent = 'Run in Background';
      bgBtn.disabled = false;
    }
    if (cancelBtn) {
      cancelBtn.textContent = 'Cancel';
    }
    this.isRunningInBackground = false;
  }

  // ---------------------------------------------------------------------------
  // HTML generation
  // ---------------------------------------------------------------------------

  _buildTreeHTML(config) {
    const levelNames = {
      1: 'Changes in Isolation',
      2: 'File Context',
      3: 'Codebase Context'
    };

    let html = '<div class="council-progress-tree">';

    // Levels 1-3
    for (const levelKey of ['1', '2', '3']) {
      const levelConfig = config.levels?.[levelKey];
      const enabled = levelConfig?.enabled;
      const levelNum = parseInt(levelKey);
      const title = `Level ${levelKey} \u2014 ${levelNames[levelNum]}`;

      if (!enabled) {
        html += this._buildSkippedLevel(levelNum, title);
      } else {
        html += this._buildActiveLevel(levelNum, title, levelConfig.voices || []);
      }
    }

    // Consolidation section
    html += this._buildConsolidationSection(config);

    html += '</div>';
    return html;
  }

  _buildSkippedLevel(level, title) {
    return `
      <div class="council-level" data-level="${level}">
        <div class="council-level-header" data-level="${level}" data-skipped="true">
          <span class="council-level-icon skipped">\u2014</span>
          <span class="council-level-title">${title}</span>
          <span class="council-level-status skipped">Skipped</span>
        </div>
      </div>
    `;
  }

  _buildActiveLevel(level, title, voices) {
    let html = `
      <div class="council-level" data-level="${level}">
        <div class="council-level-header" data-level="${level}">
          <span class="council-level-icon running"><span class="council-spinner"></span></span>
          <span class="council-level-title">${title}</span>
          <span class="council-level-status running"></span>
        </div>
        <div class="council-level-children">
    `;

    voices.forEach((voice, idx) => {
      const voiceId = `L${level}-${voice.provider}-${voice.model}${idx > 0 ? `-${idx}` : ''}`;
      const label = this._formatVoiceLabel(voice);
      const isLast = idx === voices.length - 1;

      html += this._buildVoiceRow(voiceId, label, level, isLast);
    });

    html += `
        </div>
      </div>
    `;
    return html;
  }

  _buildVoiceRow(voiceId, label, level, isLast) {
    const connectorClass = isLast ? 'connector-last' : 'connector-mid';
    return `
      <div class="council-voice ${connectorClass}" data-voice-id="${voiceId}" data-level="${level}">
        <span class="council-voice-connector ${connectorClass}"></span>
        <span class="council-voice-icon running"><span class="council-spinner"></span></span>
        <span class="council-voice-label">${label}</span>
        <span class="council-voice-status running">Running...</span>
        <div class="council-voice-detail">
          <div class="council-voice-snippet" style="display: none;"></div>
        </div>
      </div>
    `;
  }

  _buildConsolidationSection(config) {
    // Determine which levels have > 1 voice (need intra-level consolidation)
    const levelsNeedingConsolidation = [];
    const enabledLevels = [];
    for (const [levelKey, levelConfig] of Object.entries(config.levels || {})) {
      if (!levelConfig.enabled) continue;
      enabledLevels.push(parseInt(levelKey));
      if ((levelConfig.voices || []).length > 1) {
        levelsNeedingConsolidation.push(parseInt(levelKey));
      }
    }

    const needsCrossLevel = enabledLevels.length > 1;
    const hasChildren = levelsNeedingConsolidation.length > 0 || needsCrossLevel;

    if (!hasChildren) {
      // Single level, single voice — no consolidation needed, but still show the section
      // as a simple row for the orchestration step
      return `
        <div class="council-consolidation council-level">
          <div class="council-level-header">
            <span class="council-level-icon pending">\u25CB</span>
            <span class="council-level-title">Consolidation</span>
            <span class="council-level-status pending">Pending</span>
          </div>
        </div>
      `;
    }

    let html = `
      <div class="council-consolidation council-level">
        <div class="council-level-header">
          <span class="council-level-icon pending">\u25CB</span>
          <span class="council-level-title">Consolidation</span>
          <span class="council-level-status pending">Pending</span>
        </div>
        <div class="council-level-children">
    `;

    const totalChildren = levelsNeedingConsolidation.length + (needsCrossLevel ? 1 : 0);
    let childIdx = 0;

    // Intra-level consolidation items
    for (const levelNum of levelsNeedingConsolidation) {
      childIdx++;
      const voiceCount = config.levels[String(levelNum)].voices.length;
      const isLast = childIdx === totalChildren;
      const connectorClass = isLast ? 'connector-last' : 'connector-mid';
      html += `
        <div class="council-voice council-consolidation-child ${connectorClass}" data-consolidation="L${levelNum}">
          <span class="council-voice-connector ${connectorClass}"></span>
          <span class="council-voice-icon pending">\u25CB</span>
          <span class="council-voice-label">Level ${levelNum} (${voiceCount} participants)</span>
          <span class="council-voice-status pending">Pending</span>
        </div>
      `;
    }

    // Cross-level orchestration
    if (needsCrossLevel) {
      childIdx++;
      const isLast = childIdx === totalChildren;
      const connectorClass = isLast ? 'connector-last' : 'connector-mid';
      html += `
        <div class="council-voice council-consolidation-child ${connectorClass}" data-consolidation="orchestration">
          <span class="council-voice-connector ${connectorClass}"></span>
          <span class="council-voice-icon pending">\u25CB</span>
          <span class="council-voice-label">Cross-level orchestration</span>
          <span class="council-voice-status pending">Pending</span>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;
    return html;
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  /**
   * Format a voice config into a display label.
   * Example: { provider: 'claude', model: 'sonnet-4-5', tier: 'balanced' }
   *       -> "Claude sonnet-4-5 (Balanced)"
   */
  _formatVoiceLabel(voice) {
    const provider = this._capitalize(voice.provider || 'unknown');
    const model = voice.model || 'default';
    const tier = this._capitalize(voice.tier || 'balanced');
    return `${provider} ${model} (${tier})`;
  }

  _capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

// Initialize global instance
window.councilProgressModal = new CouncilProgressModal();
