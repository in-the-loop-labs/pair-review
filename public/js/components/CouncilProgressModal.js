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
   * Show the modal for an analysis.
   * Supports three rendering modes:
   * - Single model: pass null/undefined for councilConfig
   * - Voice-centric council: pass councilConfig with configType 'council'
   * - Level-centric (advanced) council: pass councilConfig with configType 'advanced' (or no configType)
   *
   * @param {string} analysisId - Analysis ID to track
   * @param {Object} [councilConfig] - Council configuration (levels + orchestration), or null for single model
   * @param {string} [councilName] - Display name for the council
   * @param {Object} [options] - Additional options
   * @param {string} [options.configType] - 'single', 'council', or 'advanced'
   * @param {Array} [options.enabledLevels] - For single model: which levels are enabled [1,2,3]
   */
  show(analysisId, councilConfig, councilName, options = {}) {
    this.currentAnalysisId = analysisId;
    this.councilConfig = councilConfig;
    this.isVisible = true;
    this._voiceStates = {};

    // Detect rendering mode
    const configType = options.configType || (councilConfig ? 'advanced' : 'single');
    this._renderMode = configType;

    // Rebuild DOM based on mode
    if (configType === 'single') {
      const enabledLevels = options.enabledLevels || [1, 2, 3];
      this._rebuildBodySingleModel(enabledLevels);
    } else if (configType === 'council') {
      this._rebuildBodyVoiceCentric(councilConfig);
    } else {
      this._rebuildBody(councilConfig);
    }

    // Update the header
    const titleEl = this.modal.querySelector('#council-progress-title');
    if (titleEl) {
      if (configType === 'single') {
        titleEl.textContent = 'Review progress';
      } else if (councilName) {
        titleEl.textContent = `Review progress \u00b7 ${councilName}`;
      } else {
        titleEl.textContent = 'Review progress';
      }
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

    if (this._renderMode === 'single') {
      // Single-model: update level headers directly
      for (let level = 1; level <= 3; level++) {
        const levelStatus = status.levels[level];
        if (!levelStatus) continue;
        this._updateSingleModelLevel(level, levelStatus);
      }
      const level4 = status.levels[4];
      if (level4) {
        this._updateConsolidation(level4);
      }
    } else if (this._renderMode === 'council') {
      // Voice-centric council: transpose level-first SSE data to voice-first DOM
      this._updateVoiceCentric(status);
    } else {
      // Advanced (level-centric): update voices within levels
      for (let level = 1; level <= 3; level++) {
        const levelStatus = status.levels[level];
        if (!levelStatus) continue;
        this._updateVoiceFromLevelStatus(level, levelStatus);
        this._refreshLevelHeader(level);
      }
      const level4 = status.levels[4];
      if (level4) {
        this._updateConsolidation(level4);
      }
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
   * Update a level header directly for single-model mode (no voice children).
   */
  _updateSingleModelLevel(level, levelStatus) {
    const header = this.modal.querySelector(`.council-level-header[data-level="${level}"]`);
    if (!header) return;
    if (header.dataset.skipped === 'true') return;

    const iconEl = header.querySelector('.council-level-icon');
    const statusEl = header.querySelector('.council-level-status');
    if (!iconEl || !statusEl) return;

    const state = levelStatus.status || 'pending';
    this._renderState(iconEl, statusEl, state, 'council-level');

    // Show stream event text in the snippet element (mirrors _setVoiceState logic)
    const levelEl = header.closest('.council-level');
    const snippetEl = levelEl?.querySelector('.council-level-snippet');
    if (snippetEl) {
      if (state === 'running' && levelStatus.streamEvent?.text) {
        snippetEl.textContent = levelStatus.streamEvent.text;
        snippetEl.style.display = 'block';
      } else if (state !== 'running') {
        snippetEl.style.display = 'none';
      }
    }
  }

  /**
   * Given a level's status (which may include a voiceId), update the right voice row.
   */
  _updateVoiceFromLevelStatus(level, levelStatus) {
    // Per-voice statuses map: tracks all voices, prevents clobbering when
    // multiple voices on the same level complete concurrently
    if (levelStatus.voices) {
      for (const [vid, vStatus] of Object.entries(levelStatus.voices)) {
        this._setVoiceState(vid, vStatus.status || 'running', vStatus);
      }
      // Don't fall through to bulk completion — individual voice states are
      // authoritative. Overall completion is handled by _handleCompletion().
      return;
    }

    const voiceId = levelStatus.voiceId;

    if (voiceId) {
      // Single voiceId without voices map (stream events or legacy path)
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
    } else if (anyFailed) {
      derivedState = 'failed';
    } else if (anyRunning) {
      derivedState = 'running';
    } else {
      derivedState = 'pending';
    }

    this._renderState(iconEl, statusEl, derivedState, 'council-level');
  }

  // ---------------------------------------------------------------------------
  // Voice-centric progress updates
  // ---------------------------------------------------------------------------

  /**
   * Update voice-centric DOM from level-first SSE data.
   * Transposes levels -> voices: for each level in SSE data, update the
   * corresponding level-child under each voice parent.
   * @param {Object} status - SSE status object with levels map
   */
  _updateVoiceCentric(status) {
    for (let level = 1; level <= 3; level++) {
      const levelStatus = status.levels[level];
      if (!levelStatus) continue;

      if (levelStatus.voices) {
        // Update each voice's level child
        for (const [voiceId, vStatus] of Object.entries(levelStatus.voices)) {
          this._setVoiceCentricLevelState(voiceId, level, vStatus.status || 'running', vStatus);
        }
      }

      // Update stream event text for the currently active voice
      if (levelStatus.streamEvent?.text && levelStatus.voiceId) {
        this._setVoiceCentricStreamText(levelStatus.voiceId, level, levelStatus.streamEvent.text);
      }
    }

    // Refresh all voice headers based on their children states
    this._refreshAllVoiceHeaders();

    // Handle consolidation (level 4)
    const level4 = status.levels[4];
    if (level4) {
      this._updateConsolidation(level4);
    }
  }

  /**
   * Set the state of a level-child element within a voice-centric parent.
   * @param {string} voiceId - Voice key (e.g. 'claude-opus')
   * @param {number} level - Level number (1-4)
   * @param {string} state - State string
   * @param {Object} levelStatus - Level status data (may contain streamEvent)
   */
  _setVoiceCentricLevelState(voiceId, level, state, levelStatus) {
    const el = this.modal.querySelector(`[data-vc-voice="${voiceId}"][data-vc-level="${level}"]`);
    if (!el) return;

    // Track state
    const stateKey = `${voiceId}:${level}`;
    this._voiceStates[stateKey] = state;

    const iconEl = el.querySelector('.council-voice-icon');
    const statusEl = el.querySelector('.council-voice-status');
    this._renderState(iconEl, statusEl, state, 'council-voice');

    // Show/hide snippet
    const snippetEl = el.querySelector('.council-voice-snippet');
    if (snippetEl) {
      if (state === 'running' && levelStatus?.streamEvent?.text) {
        snippetEl.textContent = levelStatus.streamEvent.text;
        snippetEl.style.display = 'block';
      } else if (state !== 'running') {
        snippetEl.style.display = 'none';
      }
    }
  }

  /**
   * Update the stream text snippet for a voice-centric level child.
   * @param {string} voiceId - Voice key
   * @param {number} level - Level number
   * @param {string} text - Stream event text
   */
  _setVoiceCentricStreamText(voiceId, level, text) {
    const el = this.modal.querySelector(`[data-vc-voice="${voiceId}"][data-vc-level="${level}"]`);
    if (!el) return;
    const snippetEl = el.querySelector('.council-voice-snippet');
    if (snippetEl) {
      snippetEl.textContent = text;
      snippetEl.style.display = 'block';
    }
  }

  /**
   * Refresh all voice parent headers based on the aggregate state
   * of their level children.
   */
  _refreshAllVoiceHeaders() {
    const voiceContainers = this.modal.querySelectorAll('[data-voice-key]');
    voiceContainers.forEach(container => {
      const voiceKey = container.dataset.voiceKey;
      const header = container.querySelector('.council-level-header');
      if (!header) return;

      const iconEl = header.querySelector('.council-level-icon');
      const statusEl = header.querySelector('.council-level-status');
      if (!iconEl || !statusEl) return;

      // Collect states for all level children of this voice
      const levelEls = container.querySelectorAll('[data-vc-level]');
      const states = Array.from(levelEls).map(el => {
        const key = `${voiceKey}:${el.dataset.vcLevel}`;
        return this._voiceStates[key] || 'pending';
      });

      const allComplete = states.every(s => s === 'completed');
      const anyRunning = states.some(s => s === 'running');
      const anyFailed = states.some(s => s === 'failed');
      const allCancelled = states.every(s => s === 'cancelled');

      let derivedState;
      if (allComplete) {
        derivedState = 'completed';
      } else if (allCancelled) {
        derivedState = 'cancelled';
      } else if (anyFailed) {
        derivedState = 'failed';
      } else if (anyRunning) {
        derivedState = 'running';
      } else {
        derivedState = states.some(s => s !== 'pending') ? 'running' : 'pending';
      }

      this._renderState(iconEl, statusEl, derivedState, 'council-level');
    });
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

    // Per-step updates: update individual consolidation children based on
    // the steps map or consolidationStep identifier
    if (level4Status.steps) {
      this._updateConsolidationChildrenFromSteps(level4Status.steps);
    } else if (level4Status.consolidationStep) {
      this._updateConsolidationChild(level4Status.consolidationStep, state);
    } else {
      // Terminal states (completed/failed/cancelled): bulk-update all children
      this._updateConsolidationChildrenBulk(state);
    }

    // Derive the parent header state from children
    this._refreshConsolidationHeader(iconEl, statusEl, state);
  }

  /**
   * Update individual consolidation children based on per-step status map.
   * @param {Object} steps - Map of step ID (e.g. 'L1', 'orchestration') to { status, progress }
   */
  _updateConsolidationChildrenFromSteps(steps) {
    for (const [stepId, stepStatus] of Object.entries(steps)) {
      this._updateConsolidationChild(stepId, stepStatus.status || 'running');
    }
  }

  /**
   * Update a single consolidation child by its step ID.
   * @param {string} stepId - 'L1', 'L2', 'L3', or 'orchestration'
   * @param {string} state - 'running', 'completed', 'failed', etc.
   */
  _updateConsolidationChild(stepId, state) {
    const child = this.modal.querySelector(`.council-consolidation-child[data-consolidation="${stepId}"]`);
    if (!child) return;

    const iconEl = child.querySelector('.council-voice-icon');
    const statusEl = child.querySelector('.council-voice-status');
    if (!iconEl || !statusEl) return;

    this._renderState(iconEl, statusEl, state, 'council-voice');
  }

  /**
   * Bulk-update all consolidation children with the same state.
   * Used for terminal states (completed, failed, cancelled).
   * @param {string} state
   */
  _updateConsolidationChildrenBulk(state) {
    const children = this.modal.querySelectorAll('.council-consolidation-child');
    children.forEach(child => {
      const iconEl = child.querySelector('.council-voice-icon');
      const statusEl = child.querySelector('.council-voice-status');
      if (!iconEl || !statusEl) return;

      this._renderState(iconEl, statusEl, state, 'council-voice');
    });
  }

  /**
   * Refresh the consolidation header state based on children states.
   * @param {HTMLElement} iconEl - Header icon element
   * @param {HTMLElement} statusEl - Header status element
   * @param {string} fallbackState - State to use if no children exist
   */
  _refreshConsolidationHeader(iconEl, statusEl, fallbackState) {
    if (!iconEl || !statusEl) return;

    const children = this.modal.querySelectorAll('.council-consolidation-child');
    if (children.length === 0) {
      // No children (simple consolidation) — use the state directly
      this._renderState(iconEl, statusEl, fallbackState, 'council-level');
      return;
    }

    // Derive state from children via CSS classes (set by _renderState)
    const childStates = Array.from(children).map(child => {
      const childStatusEl = child.querySelector('.council-voice-status');
      if (!childStatusEl) return 'pending';
      if (childStatusEl.classList.contains('completed')) return 'completed';
      if (childStatusEl.classList.contains('running')) return 'running';
      if (childStatusEl.classList.contains('failed')) return 'failed';
      if (childStatusEl.classList.contains('cancelled')) return 'cancelled';
      if (childStatusEl.classList.contains('skipped')) return 'skipped';
      return 'pending';
    });

    const allComplete = childStates.every(s => s === 'completed');
    const anyRunning = childStates.some(s => s === 'running');
    const anyFailed = childStates.some(s => s === 'failed');
    const allCancelled = childStates.every(s => s === 'cancelled');

    let derivedState;
    if (allComplete) {
      derivedState = 'completed';
    } else if (allCancelled) {
      derivedState = 'cancelled';
    } else if (anyFailed) {
      derivedState = 'failed';
    } else if (anyRunning) {
      derivedState = 'running';
    } else {
      derivedState = childStates.some(s => s !== 'pending') ? 'running' : 'pending';
    }

    this._renderState(iconEl, statusEl, derivedState, 'council-level');
  }

  // ---------------------------------------------------------------------------
  // Terminal state handlers
  // ---------------------------------------------------------------------------

  _handleCompletion(status) {
    if (this._renderMode === 'council') {
      // Voice-centric: mark all voice-level children as complete
      const vcEls = this.modal.querySelectorAll('[data-vc-voice][data-vc-level]');
      vcEls.forEach(el => {
        const key = `${el.dataset.vcVoice}:${el.dataset.vcLevel}`;
        if (this._voiceStates[key] !== 'completed' && this._voiceStates[key] !== 'failed') {
          this._voiceStates[key] = 'completed';
          const iconEl = el.querySelector('.council-voice-icon');
          const statusEl = el.querySelector('.council-voice-status');
          this._renderState(iconEl, statusEl, 'completed', 'council-voice');
          const snippetEl = el.querySelector('.council-voice-snippet');
          if (snippetEl) snippetEl.style.display = 'none';
        }
      });
      this._refreshAllVoiceHeaders();
    } else {
      // Level-centric / single: mark all remaining voices/levels as complete
      for (let level = 1; level <= 3; level++) {
        this._completeAllVoicesForLevel(level);
        this._refreshLevelHeader(level);
      }
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
    if (this._renderMode === 'council') {
      // Voice-centric: mark all non-completed voice-level children as failed
      const vcEls = this.modal.querySelectorAll('[data-vc-voice][data-vc-level]');
      vcEls.forEach(el => {
        const key = `${el.dataset.vcVoice}:${el.dataset.vcLevel}`;
        if (this._voiceStates[key] !== 'completed') {
          this._voiceStates[key] = 'failed';
          const iconEl = el.querySelector('.council-voice-icon');
          const statusEl = el.querySelector('.council-voice-status');
          this._renderState(iconEl, statusEl, 'failed', 'council-voice');
          const snippetEl = el.querySelector('.council-voice-snippet');
          if (snippetEl) snippetEl.style.display = 'none';
        }
      });
      this._refreshAllVoiceHeaders();
    } else {
      // Level-centric / single: clean up any remaining running voices
      for (let level = 1; level <= 3; level++) {
        this._failAllVoicesForLevel(level);
        this._refreshLevelHeader(level);
      }
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
    if (this._renderMode === 'council') {
      // Voice-centric: mark all non-completed voice-level children as cancelled
      const vcEls = this.modal.querySelectorAll('[data-vc-voice][data-vc-level]');
      vcEls.forEach(el => {
        const key = `${el.dataset.vcVoice}:${el.dataset.vcLevel}`;
        if (this._voiceStates[key] !== 'completed') {
          this._voiceStates[key] = 'cancelled';
          const iconEl = el.querySelector('.council-voice-icon');
          const statusEl = el.querySelector('.council-voice-status');
          this._renderState(iconEl, statusEl, 'cancelled', 'council-voice');
          const snippetEl = el.querySelector('.council-voice-snippet');
          if (snippetEl) snippetEl.style.display = 'none';
        }
      });
      this._refreshAllVoiceHeaders();
    } else {
      // Level-centric / single: clean up any remaining running voices
      for (let level = 1; level <= 3; level++) {
        this._cancelAllVoicesForLevel(level);
        this._refreshLevelHeader(level);
      }
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
          <h3 id="council-progress-title">Review progress</h3>
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

  /**
   * Rebuild the modal body for voice-centric council mode.
   * Transposes the level-first config into a voice-first tree:
   *   - Unique voices as parent rows
   *   - Enabled levels (+ orchestration) as child rows under each voice
   *   - Cross-Reviewer Consolidation section at the bottom
   *
   * @param {Object} config - Council config in levels-format
   */
  _rebuildBodyVoiceCentric(config) {
    const body = this.modal.querySelector('.council-progress-body');
    if (!body) return;

    const levelNames = {
      1: 'Changes in Isolation',
      2: 'File Context',
      3: 'Codebase Context'
    };

    // Deduplicate voices across enabled levels using the same signature-based
    // approach as the backend (runVoiceCentricCouncil in analyzer.js).
    // The backend deduplicates by provider|model|tier|customInstructions, then
    // generates keys from the index into the global deduplicated array.
    // We must mirror this exactly so voice keys match SSE progress events.
    const uniqueVoices = [];
    const seenSignatures = new Set();
    const enabledLevelNums = [];
    for (const levelKey of ['1', '2', '3']) {
      const levelConfig = config.levels?.[levelKey];
      if (!levelConfig?.enabled) continue;
      enabledLevelNums.push(parseInt(levelKey));
      for (const voice of (levelConfig.voices || [])) {
        const sig = `${voice.provider}|${voice.model}|${voice.tier || 'balanced'}|${voice.customInstructions || ''}`;
        if (!seenSignatures.has(sig)) {
          seenSignatures.add(sig);
          uniqueVoices.push(voice);
        }
      }
    }

    // Build voiceMap: voiceKey -> { voice, levels } using deduplicated array indices
    const voiceMap = new Map();
    uniqueVoices.forEach((voice, idx) => {
      const voiceKey = `${voice.provider}-${voice.model}${idx > 0 ? `-${idx}` : ''}`;
      voiceMap.set(voiceKey, { voice, levels: enabledLevelNums });
    });

    let html = '<div class="council-progress-tree">';

    // Build a parent row for each unique voice
    for (const [voiceKey, { voice, levels }] of voiceMap) {
      const label = this._formatVoiceLabel(voice);

      html += `
        <div class="council-level" data-voice-key="${voiceKey}">
          <div class="council-level-header">
            <span class="council-level-icon running"><span class="council-spinner"></span></span>
            <span class="council-level-title">${label}</span>
            <span class="council-level-status running"></span>
          </div>
          <div class="council-level-children">
      `;

      // Level children (orchestration row is always last, added separately below)
      levels.forEach((levelNum) => {
        const connectorClass = 'connector-mid';
        html += `
          <div class="council-voice ${connectorClass}" data-vc-voice="${voiceKey}" data-vc-level="${levelNum}">
            <span class="council-voice-connector ${connectorClass}"></span>
            <span class="council-voice-icon running"><span class="council-spinner"></span></span>
            <span class="council-voice-label">Level ${levelNum} \u2014 ${levelNames[levelNum]}</span>
            <span class="council-voice-status running">Running...</span>
            <div class="council-voice-detail">
              <div class="council-voice-snippet" style="display: none;"></div>
            </div>
          </div>
        `;
      });

      // Orchestration child (always last)
      html += `
          <div class="council-voice connector-last" data-vc-voice="${voiceKey}" data-vc-level="4">
            <span class="council-voice-connector connector-last"></span>
            <span class="council-voice-icon pending">\u25CB</span>
            <span class="council-voice-label">Consolidation</span>
            <span class="council-voice-status pending">Pending</span>
          </div>
      `;

      html += `
          </div>
        </div>
      `;
    }

    // Cross-Reviewer Consolidation section (simple, no per-level children)
    html += `
      <div class="council-consolidation council-level">
        <div class="council-level-header">
          <span class="council-level-icon pending">\u25CB</span>
          <span class="council-level-title">Cross-Reviewer Consolidation</span>
          <span class="council-level-status pending">Pending</span>
        </div>
      </div>
    `;

    html += '</div>';
    body.innerHTML = html;
  }

  /**
   * Rebuild the modal body for single-model analysis.
   * Shows a simple level list without voice nesting.
   * @param {Array<number>} enabledLevels - Which levels are enabled, e.g. [1, 2, 3]
   */
  _rebuildBodySingleModel(enabledLevels) {
    const body = this.modal.querySelector('.council-progress-body');
    if (!body) return;

    const levelNames = {
      1: 'Changes in Isolation',
      2: 'File Context',
      3: 'Codebase Context'
    };

    let html = '<div class="council-progress-tree">';

    for (const level of [1, 2, 3]) {
      const enabled = enabledLevels.includes(level);
      const title = `Level ${level} \u2014 ${levelNames[level]}`;

      if (!enabled) {
        html += `
          <div class="council-level" data-level="${level}">
            <div class="council-level-header" data-level="${level}" data-skipped="true">
              <span class="council-level-icon skipped">\u2014</span>
              <span class="council-level-title">${title}</span>
              <span class="council-level-status skipped">Skipped</span>
            </div>
          </div>
        `;
      } else {
        html += `
          <div class="council-level" data-level="${level}">
            <div class="council-level-header" data-level="${level}">
              <span class="council-level-icon pending">\u25CB</span>
              <span class="council-level-title">${title}</span>
              <span class="council-level-status pending">Pending</span>
            </div>
            <div class="council-level-snippet" style="display: none;"></div>
          </div>
        `;
      }
    }

    // Orchestration row
    html += `
      <div class="council-consolidation council-level">
        <div class="council-level-header">
          <span class="council-level-icon pending">\u25CB</span>
          <span class="council-level-title">Consolidation</span>
          <span class="council-level-status pending">Pending</span>
        </div>
      </div>
    `;

    html += '</div>';
    body.innerHTML = html;
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
          <span class="council-voice-label">Level ${levelNum} (${voiceCount} reviewers)</span>
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
          <span class="council-voice-label">Cross-level consolidation</span>
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
if (typeof window !== 'undefined' && !window.councilProgressModal) {
  window.councilProgressModal = new CouncilProgressModal();
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CouncilProgressModal };
}
