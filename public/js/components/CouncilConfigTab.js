// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Review Council Configuration Tab
 *
 * Provides a "Review Council (BETA)" tab alongside the existing "Single Model" tab
 * in the AnalysisConfigModal. Enables multi-voice, multi-provider analysis configuration.
 */
class CouncilConfigTab {
  /** Info circle SVG icon for section tooltips */
  static INFO_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`;

  /**
   * Build an info-tip toggle button
   * @param {string} id - Unique identifier for aria-controls linkage
   * @returns {string} HTML string
   */
  static buildInfoTipButton(id) {
    return `<button class="info-tip-toggle" aria-controls="info-tip-${id}" aria-expanded="false" title="More info">${CouncilConfigTab.INFO_ICON_SVG}</button>`;
  }

  /**
   * Build a hidden info-tip content block
   * @param {string} id - Unique identifier matching the toggle button
   * @param {string} text - Explanation text (may contain HTML)
   * @returns {string} HTML string
   */
  static buildInfoTipContent(id, text) {
    return `<div class="info-tip-content" id="info-tip-${id}" style="display:none">${text}</div>`;
  }

  /** Speech bubble SVG icon (outline) used for per-participant and custom instruction rows */
  static SPEECH_BUBBLE_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.5 0v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25H2.75a.25.25 0 0 0-.25.25Z"/></svg>`;

  /** Speech bubble SVG icon (solid/filled) — indicates instructions are present */
  static SPEECH_BUBBLE_SVG_SOLID = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 1C1.784 1 1 1.784 1 2.75v7.5c0 .966.784 1.75 1.75 1.75H4v1.543a1.458 1.458 0 0 0 2.487 1.03L9.06 12h4.19A1.75 1.75 0 0 0 15 10.25v-7.5A1.75 1.75 0 0 0 13.25 1H2.75Z"/></svg>`;

  constructor(modal) {
    this.modal = modal;
    this.councils = [];
    this.selectedCouncilId = null;
    this.providers = {};
    this.activeTab = 'single'; // 'single' or 'council'
    this._injected = false;
    this._councilsLoaded = false;

    // Dirty state tracking
    this._isDirty = false;

    // Character limit constants for council custom instructions
    this.CHAR_LIMIT = 5000;
    this.CHAR_WARNING_THRESHOLD = 4500;
  }

  /**
   * Inject the council tab into the analysis config modal
   * Adds tabs at the top of the modal body and the council content panel
   */
  inject() {
    if (this._injected) return;
    const modalBody = this.modal.querySelector('.analysis-config-body');
    if (!modalBody) return;

    // Wrap existing content in a "Single Model" tab panel
    const existingContent = Array.from(modalBody.children);
    const singlePanel = document.createElement('div');
    singlePanel.id = 'tab-panel-single';
    singlePanel.className = 'tab-panel active';
    existingContent.forEach(child => singlePanel.appendChild(child));

    // Create council tab panel
    const councilPanel = document.createElement('div');
    councilPanel.id = 'tab-panel-council';
    councilPanel.className = 'tab-panel';
    councilPanel.style.display = 'none';
    councilPanel.innerHTML = this._buildCouncilHTML();

    // Create tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'analysis-tab-bar';
    tabBar.innerHTML = `
      <button class="analysis-tab active" data-tab="single">Single Model</button>
      <button class="analysis-tab" data-tab="council">Review Council <span class="beta-badge">BETA</span></button>
    `;

    // Assemble
    modalBody.innerHTML = '';
    modalBody.appendChild(tabBar);
    modalBody.appendChild(singlePanel);
    modalBody.appendChild(councilPanel);

    this._setupTabListeners(tabBar);
    this._setupCouncilListeners(councilPanel);
    this._injected = true;

    // Initial state: clean, buttons disabled
    this._markClean();
  }

  /**
   * Load providers data (reuses the modal's loaded providers)
   * @param {Object} providers - Provider definitions from AnalysisConfigModal
   */
  setProviders(providers) {
    this.providers = providers || {};
    if (this._injected) {
      this._updateAllVoiceDropdowns();
    }
  }

  /**
   * Load saved councils from the API
   */
  async loadCouncils() {
    try {
      const response = await fetch('/api/councils');
      if (!response.ok) throw new Error('Failed to fetch councils');
      const data = await response.json();
      this.councils = data.councils || [];
      this._councilsLoaded = true;
      this._renderCouncilSelector();
    } catch (error) {
      console.error('Error loading councils:', error);
      this.councils = [];
      if (window.toast) {
        window.toast.showError('Failed to load saved councils');
      }
    }
  }

  /**
   * Get the active tab
   * @returns {string} 'single' or 'council'
   */
  getActiveTab() {
    return this.activeTab;
  }

  /**
   * Get the current council config for submission
   * @returns {Object|null} Council config or null if not on council tab
   */
  getCouncilConfig() {
    if (this.activeTab !== 'council') return null;
    return this._readConfigFromUI();
  }

  /**
   * Get selected council ID (if using a saved council)
   * @returns {string|null}
   */
  getSelectedCouncilId() {
    return this.selectedCouncilId;
  }

  /**
   * Set repo instructions in the council tab
   * @param {string} text - Repository instructions text
   */
  setRepoInstructions(text) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const banner = panel.querySelector('#council-repo-instructions-banner');
    const repoText = panel.querySelector('#council-repo-instructions-text');

    if (text) {
      if (banner) banner.style.display = 'flex';
      if (repoText) repoText.textContent = text;
    } else {
      if (banner) banner.style.display = 'none';
    }
  }

  /**
   * Set last used custom instructions in the council tab
   * @param {string} text - Last used custom instructions
   */
  setLastInstructions(text) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const textarea = panel.querySelector('#council-custom-instructions');
    if (textarea) {
      textarea.value = text || '';
      this._updateCouncilCharCount(textarea.value.length);
    }
  }

  /**
   * Set default orchestration provider/model for new councils.
   * Falls back to 'claude'/'sonnet' if not provided.
   * @param {string} provider - Default provider ID (e.g., 'claude', 'gemini')
   * @param {string} model - Default model ID (e.g., 'sonnet', 'opus')
   */
  setDefaultOrchestration(provider, model) {
    this._defaultProvider = provider || 'claude';
    this._defaultModel = model || 'sonnet';
  }

  /**
   * Set the default council ID to pre-select when councils load.
   * Stores the ID as pending; it will be applied in _renderCouncilSelector().
   * @param {string} councilId - Council ID to pre-select
   */
  setDefaultCouncilId(councilId) {
    this._pendingDefaultCouncilId = councilId;
  }

  /**
   * Validate council config. At least one level must be enabled.
   * @param {Object} config - Council config to validate
   * @returns {{ valid: boolean, error: string|null }}
   */
  _validateConfig(config) {
    const hasEnabledLevel = Object.values(config.levels).some(l => l.enabled);
    if (!hasEnabledLevel) {
      return { valid: false, error: 'At least one review level must be enabled.' };
    }
    return { valid: true, error: null };
  }

  /**
   * Validate the current council configuration.
   * Shows a warning toast if invalid.
   * @returns {boolean} true if valid
   */
  validate() {
    const config = this._readConfigFromUI();
    const result = this._validateConfig(config);
    if (!result.valid && window.toast) {
      window.toast.showWarning(result.error);
    }
    return result.valid;
  }

  /**
   * Auto-save council if there are unsaved changes.
   * Called before analysis starts. Errors are caught and logged, never block analysis.
   * Always saves unsaved councils so the config is persisted for history/reuse.
   * @returns {Promise<void>}
   */
  async autoSaveIfDirty() {
    // Skip saving when the council is clean AND already persisted (has an ID).
    // Unsaved councils (no selectedCouncilId) always proceed so the config is persisted.
    if (!this._isDirty && this.selectedCouncilId) return;

    const config = this._readConfigFromUI();
    const { valid } = this._validateConfig(config);
    if (!valid) return; // Don't auto-save invalid configs

    try {
      const timestamp = this._formatTimestamp(new Date());

      let name;
      if (this.selectedCouncilId) {
        // Fork: create new council based on existing, don't mutate the original
        const existing = this.councils.find(c => c.id === this.selectedCouncilId);
        const baseName = (existing?.name || 'Council').replace(/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/, '').trim();
        name = `${baseName} ${timestamp}`;
      } else {
        name = `Council ${timestamp}`;
      }
      await this._postCouncil(name, config);
    } catch (error) {
      console.error('Auto-save council failed (non-blocking):', error);
      if (window.toast) {
        window.toast.showWarning('Council auto-save failed');
      }
    }
  }

  // --- Private methods ---

  /**
   * Format a Date as "YYYY-MM-DD HH:MM" for council naming.
   * @param {Date} date
   * @returns {string}
   */
  _formatTimestamp(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  _defaultConfig() {
    return {
      levels: {
        '1': { enabled: false, voices: [] },
        '2': { enabled: false, voices: [] },
        '3': { enabled: false, voices: [] }
      },
      orchestration: { provider: this._defaultProvider || 'claude', model: this._defaultModel || 'sonnet', tier: 'balanced' }
    };
  }

  _buildCouncilHTML() {
    return `
      <section class="config-section">
        <h4 class="section-title">Council ${CouncilConfigTab.buildInfoTipButton('council')}</h4>
        ${CouncilConfigTab.buildInfoTipContent('council', 'A Review Council runs your code review through multiple AI models in parallel, then consolidates their findings. Different models catch different issues, giving you broader coverage than a single reviewer.')}
        <div class="council-selector-row">
          <select id="council-selector" class="council-select">
            <option value="">New Council</option>
          </select>
          <button class="btn btn-sm btn-secondary" id="council-save-btn" title="Save" disabled>Save</button>
          <button class="btn btn-sm btn-secondary" id="council-save-as-btn" title="Save As" disabled>Save As</button>
          <button class="btn btn-sm btn-secondary" id="council-export-btn" title="Export JSON">Export</button>
        </div>
      </section>

      ${this._buildLevelSection(1, 'Changes in Isolation', true)}
      ${this._buildLevelSection(2, 'File Context', false)}
      ${this._buildLevelSection(3, 'Codebase Context', false)}

      <section class="config-section">
        <h4 class="section-title">Orchestration ${CouncilConfigTab.buildInfoTipButton('orchestration')}</h4>
        ${CouncilConfigTab.buildInfoTipContent('orchestration', 'The orchestration model consolidates findings from all participants into a single coherent review. <strong>Fast</strong> tier gives concise output, <strong>Balanced</strong> is the recommended default, and <strong>Thorough</strong> produces the most detailed consolidation.')}
        <p class="section-hint-text">Model used for consolidation passes</p>
        <div class="voice-row" id="orchestration-voice">
          <select class="voice-provider" data-target="orchestration"></select>
          <select class="voice-model" data-target="orchestration"></select>
          <select class="voice-tier" data-target="orchestration">
            <option value="fast">Fast</option>
            <option value="balanced" selected>Balanced</option>
            <option value="thorough">Thorough</option>
          </select>
        </div>
      </section>

      ${this._buildInstructionsHTML()}
    `;
  }

  /**
   * Build the level section with slider toggle instead of checkbox
   */
  _buildLevelSection(level, description, enabledByDefault) {
    const levelTips = {
      1: 'Analyzes only the changed lines themselves. Catches bugs, typos, and logic errors in the diff without needing surrounding context.',
      2: 'Analyzes changes within their full file context. Catches inconsistencies with nearby code, naming conventions, and patterns within the same file.',
      3: 'Analyzes changes against the broader codebase. Catches architectural issues, duplicated logic elsewhere, and violations of project-wide conventions.'
    };
    return `
      <section class="config-section council-level-section" data-level="${level}">
        <h4 class="section-title">
          <label class="remember-toggle level-toggle">
            <input type="checkbox" class="level-checkbox" data-level="${level}" ${enabledByDefault ? 'checked' : ''} />
            <span class="toggle-switch"></span>
            <span class="toggle-label">Level ${level} &mdash; ${description}</span>
          </label>
          ${CouncilConfigTab.buildInfoTipButton('level-' + level)}
        </h4>
        ${CouncilConfigTab.buildInfoTipContent('level-' + level, levelTips[level])}
        <div class="level-voices" id="level-${level}-voices" ${!enabledByDefault ? 'style="display:none"' : ''}>
          <div class="voice-list" id="level-${level}-voice-list">
            ${enabledByDefault ? this._buildVoiceRowHTML(level, 0) : ''}
          </div>
          <button class="btn btn-sm btn-icon add-voice-btn" data-level="${level}" title="Add Participant">+</button>
        </div>
      </section>
    `;
  }

  /**
   * Build a single participant row with card container layout
   */
  _buildVoiceRowHTML(level, index) {
    return `
      <div class="participant-wrapper" data-level="${level}" data-index="${index}">
        <div class="participant-card">
          <div class="voice-row" data-level="${level}" data-index="${index}">
            <select class="voice-provider" data-level="${level}" data-index="${index}"></select>
            <select class="voice-model" data-level="${level}" data-index="${index}"></select>
            <select class="voice-tier" data-level="${level}" data-index="${index}">
              <option value="fast">Fast</option>
              <option value="balanced" selected>Balanced</option>
              <option value="thorough">Thorough</option>
            </select>
            <button class="toggle-instructions-icon" data-level="${level}" data-index="${index}" title="Per-participant instructions">${CouncilConfigTab.SPEECH_BUBBLE_SVG}</button>
          </div>
          <div class="voice-instructions-area" data-level="${level}" data-index="${index}" style="display:none">
            <textarea class="voice-instructions-input" data-level="${level}" data-index="${index}" placeholder="Per-participant instructions (e.g., Focus on security)" rows="2"></textarea>
          </div>
        </div>
        <button class="btn btn-sm btn-icon remove-voice-btn" data-level="${level}" data-index="${index}" title="Remove Participant">&minus;</button>
      </div>
    `;
  }

  /**
   * Build the Custom Instructions + Repo Instructions section for council tab
   */
  _buildInstructionsHTML() {
    return `
      <div class="council-review-divider">
        <span class="divider-label">This Review</span>
      </div>
      <section class="config-section">
        <h4 class="section-title">
          Custom Instructions
          <span class="section-hint">(optional)</span>
          ${CouncilConfigTab.buildInfoTipButton('custom-instructions')}
        </h4>
        ${CouncilConfigTab.buildInfoTipContent('custom-instructions', 'Free-form guidance sent to every participant in this review. Use this to focus the review on what matters most &mdash; e.g., "Pay extra attention to error handling" or "This is a security-critical change."')}
        <div class="instructions-container">
          <div class="repo-instructions-banner" id="council-repo-instructions-banner" style="display: none;">
            <div class="banner-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-8a1 1 0 00-1 1v6.708A2.486 2.486 0 014.5 9h8V1.5zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/>
              </svg>
            </div>
            <div class="banner-content">
              <span class="banner-label">Repository default instructions active</span>
              <button class="banner-toggle" id="council-toggle-repo-instructions" title="Show repository instructions">
                <span>View</span>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="repo-instructions-expanded" id="council-repo-instructions-expanded" style="display: none;">
            <div class="expanded-header">
              <span>Repository Instructions</span>
              <button class="collapse-btn" id="council-collapse-repo-instructions" title="Collapse">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 8.72a.75.75 0 011.06 0L8 11.94l3.22-3.22a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.72 9.78a.75.75 0 010-1.06z"/>
                </svg>
              </button>
            </div>
            <div class="expanded-content" id="council-repo-instructions-text"></div>
          </div>
          <textarea
            id="council-custom-instructions"
            class="instructions-textarea"
            data-no-dirty
            placeholder="Add specific guidance for this review...&#10;&#10;Examples:&#10;&#8226; Pay extra attention to the authentication logic&#10;&#8226; Check for proper error handling in the API calls&#10;&#8226; This is a performance-critical section"
            rows="4"
          ></textarea>
          <div class="instructions-footer">
            <span class="char-count" id="council-char-count-container">
              <span id="council-char-count">0</span> / 5,000 characters
            </span>
          </div>
        </div>
      </section>
    `;
  }

  _setupTabListeners(tabBar) {
    tabBar.querySelectorAll('.analysis-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabId = tab.dataset.tab;
        this.activeTab = tabId;

        // Update tab buttons
        tabBar.querySelectorAll('.analysis-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Switch panels
        const singlePanel = this.modal.querySelector('#tab-panel-single');
        const councilPanel = this.modal.querySelector('#tab-panel-council');

        if (tabId === 'single') {
          // Sync: copy council instructions to single tab
          const councilTextarea = this.modal.querySelector('#council-custom-instructions');
          const singleTextarea = this.modal.querySelector('#custom-instructions');
          if (councilTextarea && singleTextarea) {
            singleTextarea.value = councilTextarea.value;
          }

          if (singlePanel) singlePanel.style.display = '';
          if (councilPanel) councilPanel.style.display = 'none';
          // Trigger input event to update char count display and validation via existing listener
          if (singleTextarea) {
            singleTextarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          // Sync: copy single instructions to council tab
          const singleTextarea = this.modal.querySelector('#custom-instructions');
          const councilTextarea = this.modal.querySelector('#council-custom-instructions');
          if (singleTextarea && councilTextarea) {
            councilTextarea.value = singleTextarea.value;
          }

          if (singlePanel) singlePanel.style.display = 'none';
          if (councilPanel) councilPanel.style.display = '';
          // Load councils on first switch (skip if already loaded)
          if (!this._councilsLoaded) {
            this.loadCouncils();
          }
          this._updateAllVoiceDropdowns();
          // Re-validate submit button for the council tab's char count
          if (councilTextarea) {
            this._updateCouncilCharCount(councilTextarea.value.length);
          }
        }

        // Update submit button text
        const submitBtn = this.modal.querySelector('[data-action="submit"] span');
        if (submitBtn) {
          submitBtn.textContent = tabId === 'council' ? 'Analyze with Council' : 'Start Analysis';
        }

        // Show/hide the dirty hint based on active tab
        this._updateDirtyHint();
      });
    });
  }

  _setupCouncilListeners(panel) {
    // Council selector
    panel.querySelector('#council-selector')?.addEventListener('change', (e) => {
      this.selectedCouncilId = e.target.value || null;
      if (this.selectedCouncilId) {
        const council = this.councils.find(c => c.id === this.selectedCouncilId);
        if (council) {
          this._applyConfigToUI(council.config);
          this._markClean();
        }
      } else {
        // "New Council" selected — reset UI to blank defaults
        this._applyConfigToUI(this._defaultConfig());
        this._markDirty();
      }
      this._updateSaveButtonStates();
    });

    // Save button
    panel.querySelector('#council-save-btn')?.addEventListener('click', () => this._saveCouncil());

    // Save As button
    panel.querySelector('#council-save-as-btn')?.addEventListener('click', () => this._saveCouncilAs());

    // Export button
    panel.querySelector('#council-export-btn')?.addEventListener('click', () => this._exportCouncil());

    // Level toggles (slider toggles that still use .level-checkbox class)
    panel.querySelectorAll('.level-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const level = e.target.dataset.level;
        const voicesContainer = panel.querySelector(`#level-${level}-voices`);
        if (voicesContainer) {
          voicesContainer.style.display = e.target.checked ? '' : 'none';
        }
        // Add a default voice if enabling a level with no voices
        if (e.target.checked) {
          const voiceList = panel.querySelector(`#level-${level}-voice-list`);
          if (voiceList && voiceList.children.length === 0) {
            this._addVoice(level);
          }
        }
        this._markDirty();
      });
    });

    // Add voice buttons
    panel.querySelectorAll('.add-voice-btn').forEach(btn => {
      btn.addEventListener('click', () => this._addVoice(btn.dataset.level));
    });

    // Delegate remove voice and toggle instructions icon
    panel.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.remove-voice-btn');
      if (removeBtn) {
        this._removeVoice(removeBtn.dataset.level, removeBtn.dataset.index);
      }

      const toggleBtn = e.target.closest('.toggle-instructions-icon');
      if (toggleBtn) {
        const { level, index } = toggleBtn.dataset;
        const wrapper = panel.querySelector(`.participant-wrapper[data-level="${level}"][data-index="${index}"]`);
        const area = wrapper?.querySelector(`.voice-instructions-area[data-level="${level}"][data-index="${index}"]`);
        if (area) {
          const isHidden = area.style.display === 'none';
          area.style.display = isHidden ? '' : 'none';
          // Focus textarea when opening
          if (isHidden) {
            const textarea = area.querySelector('.voice-instructions-input');
            if (textarea) textarea.focus();
          }
        }
      }

      // Info-tip toggle (section help icons)
      const infoBtn = e.target.closest('.info-tip-toggle');
      if (infoBtn) {
        const targetId = infoBtn.getAttribute('aria-controls');
        const content = panel.querySelector(`#${targetId}`);
        if (content) {
          const isHidden = content.style.display === 'none';
          content.style.display = isHidden ? '' : 'none';
          infoBtn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
          infoBtn.classList.toggle('active', isHidden);
        }
      }
    });

    // Update speech bubble icon (outline vs solid) based on textarea content
    panel.addEventListener('input', (e) => {
      if (e.target.classList.contains('voice-instructions-input')) {
        const { level, index } = e.target.dataset;
        this._updateInstructionsIcon(panel, level, index, e.target.value);
      }
    });

    // Provider change -> update model dropdowns
    panel.addEventListener('change', (e) => {
      if (e.target.classList.contains('voice-provider')) {
        this._updateModelDropdown(e.target);
      }
    });

    // Dirty state tracking via event delegation
    panel.addEventListener('change', (e) => {
      if (e.target.matches('select, input[type="checkbox"]')) {
        this._markDirty();
      }
    });
    panel.addEventListener('input', (e) => {
      // Mark dirty for per-participant instruction textareas (part of council config),
      // but NOT textareas with data-no-dirty (e.g., per-request custom instructions)
      if (e.target.matches('textarea') && !('noDirty' in e.target.dataset)) {
        this._markDirty();
      }
    });

    // Council custom instructions character count
    const councilTextarea = panel.querySelector('#council-custom-instructions');
    councilTextarea?.addEventListener('input', () => {
      this._updateCouncilCharCount(councilTextarea.value.length);
    });

    // Council repo instructions toggle
    panel.querySelector('#council-toggle-repo-instructions')?.addEventListener('click', () => {
      panel.querySelector('#council-repo-instructions-banner').style.display = 'none';
      panel.querySelector('#council-repo-instructions-expanded').style.display = 'block';
    });

    panel.querySelector('#council-collapse-repo-instructions')?.addEventListener('click', () => {
      panel.querySelector('#council-repo-instructions-banner').style.display = 'flex';
      panel.querySelector('#council-repo-instructions-expanded').style.display = 'none';
    });
  }

  _renderCouncilSelector() {
    const selector = this.modal.querySelector('#council-selector');
    if (!selector) return;

    const currentValue = selector.value;
    selector.innerHTML = '<option value="">New Council</option>';
    for (const council of this.councils) {
      const opt = document.createElement('option');
      opt.value = council.id;
      opt.textContent = council.name;
      selector.appendChild(opt);
    }

    // Apply pending default council ID if set (from last-used or repo default)
    if (this._pendingDefaultCouncilId) {
      const pendingId = this._pendingDefaultCouncilId;
      this._pendingDefaultCouncilId = null;

      // Only apply if the council exists in the loaded list (handles deleted councils gracefully)
      const council = this.councils.find(c => c.id === pendingId);
      if (council) {
        selector.value = pendingId;
        this.selectedCouncilId = pendingId;
        this._applyConfigToUI(council.config);
        this._markClean();
        return;
      }
    }

    if (currentValue) selector.value = currentValue;
  }

  _updateAllVoiceDropdowns() {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    panel.querySelectorAll('.voice-provider').forEach(select => {
      this._populateProviderDropdown(select);
    });
  }

  _populateProviderDropdown(select) {
    const currentValue = select.value;
    select.innerHTML = '';
    const providerIds = Object.keys(this.providers).filter(id => {
      const p = this.providers[id];
      return !p.availability || p.availability.available;
    });

    for (const id of providerIds) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = this.providers[id].name;
      select.appendChild(opt);
    }

    if (currentValue && providerIds.includes(currentValue)) {
      select.value = currentValue;
    } else if (providerIds.length > 0) {
      select.value = providerIds[0];
    }

    this._updateModelDropdown(select);
  }

  _updateModelDropdown(providerSelect) {
    const providerId = providerSelect.value;
    const provider = this.providers[providerId];
    if (!provider) return;

    // Find sibling model select
    const container = providerSelect.closest('.voice-row');
    const modelSelect = container?.querySelector('.voice-model');
    if (!modelSelect) return;

    const currentModel = modelSelect.value;
    const models = provider.models || [];
    modelSelect.innerHTML = '';
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.name;
      opt.dataset.tier = model.tier;
      modelSelect.appendChild(opt);
    }

    // Try to preserve current selection or use default
    if (currentModel && models.some(m => m.id === currentModel)) {
      modelSelect.value = currentModel;
    } else {
      const defaultModel = models.find(m => m.default) || models[0];
      if (defaultModel) modelSelect.value = defaultModel.id;
    }

    // Auto-set tier based on model
    const tierSelect = container?.querySelector('.voice-tier');
    if (tierSelect) {
      const selectedModel = models.find(m => m.id === modelSelect.value);
      if (selectedModel) tierSelect.value = selectedModel.tier || 'balanced';
    }
  }

  _addVoice(level) {
    const voiceList = this.modal.querySelector(`#level-${level}-voice-list`);
    if (!voiceList) return;

    // Count existing participant wrappers
    const existingWrappers = voiceList.querySelectorAll(`.participant-wrapper[data-level="${level}"]`);
    const index = existingWrappers.length;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = this._buildVoiceRowHTML(level, index);
    // The _buildVoiceRowHTML returns a single .participant-wrapper, append it
    while (wrapper.firstChild) {
      voiceList.appendChild(wrapper.firstChild);
    }

    // Populate the new provider dropdown
    const newProviderSelect = voiceList.querySelector(`.voice-provider[data-level="${level}"][data-index="${index}"]`);
    if (newProviderSelect) {
      this._populateProviderDropdown(newProviderSelect);
    }

    // Update remove button visibility for this level
    this._updateRemoveButtonVisibility(level);

    // Mark dirty
    this._markDirty();
  }

  _removeVoice(level, index) {
    const voiceList = this.modal.querySelector(`#level-${level}-voice-list`);
    if (!voiceList) return;

    // Don't remove if it's the last voice
    const wrappers = voiceList.querySelectorAll(`.participant-wrapper[data-level="${level}"]`);
    if (wrappers.length <= 1) return;

    // Remove the participant wrapper (card + remove button)
    const wrapper = voiceList.querySelector(`.participant-wrapper[data-level="${level}"][data-index="${index}"]`);
    if (wrapper) wrapper.remove();

    // Re-index remaining voices so indices are sequential starting from 0
    this._reindexVoices(level);

    // Update remove button visibility for this level
    this._updateRemoveButtonVisibility(level);

    // Mark dirty
    this._markDirty();
  }

  _reindexVoices(level) {
    const voiceList = this.modal.querySelector(`#level-${level}-voice-list`);
    if (!voiceList) return;

    const wrappers = voiceList.querySelectorAll(`.participant-wrapper[data-level="${level}"]`);
    wrappers.forEach((wrapper, newIndex) => {
      const oldIndex = wrapper.dataset.index;
      if (String(newIndex) === oldIndex) return;

      // Update the wrapper itself
      wrapper.dataset.index = newIndex;

      // Update all child elements with data-index within this wrapper
      wrapper.querySelectorAll('[data-index]').forEach(el => {
        el.dataset.index = newIndex;
      });
    });
  }

  /**
   * Update remove button visibility - hide when only 1 participant in level.
   * Uses visibility: hidden to preserve layout
   */
  _updateRemoveButtonVisibility(level) {
    const voiceList = this.modal.querySelector(`#level-${level}-voice-list`);
    if (!voiceList) return;

    const wrappers = voiceList.querySelectorAll(`.participant-wrapper[data-level="${level}"]`);
    const singleParticipant = wrappers.length <= 1;

    wrappers.forEach(wrapper => {
      const removeBtn = wrapper.querySelector('.remove-voice-btn');
      if (removeBtn) {
        removeBtn.style.visibility = singleParticipant ? 'hidden' : 'visible';
      }
    });
  }

  /**
   * Update the instructions icon for a participant to outline or solid
   * based on whether the textarea has content.
   * @param {Element} panel - The council panel element
   * @param {string} level - Level number
   * @param {string} index - Voice index
   * @param {string} value - Current textarea value
   */
  _updateInstructionsIcon(panel, level, index, value) {
    const wrapper = panel.querySelector(`.participant-wrapper[data-level="${level}"][data-index="${index}"]`);
    const iconBtn = wrapper?.querySelector(`.toggle-instructions-icon[data-level="${level}"][data-index="${index}"]`);
    if (!iconBtn) return;

    const hasContent = value.trim().length > 0;
    iconBtn.innerHTML = hasContent
      ? CouncilConfigTab.SPEECH_BUBBLE_SVG_SOLID
      : CouncilConfigTab.SPEECH_BUBBLE_SVG;
    iconBtn.classList.toggle('has-instructions', hasContent);
  }

  // --- Dirty state tracking ---

  _markDirty() {
    this._isDirty = true;
    this._updateSaveButtonStates();
  }

  _markClean() {
    this._isDirty = false;
    this._updateSaveButtonStates();
  }

  _updateSaveButtonStates() {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const saveBtn = panel.querySelector('#council-save-btn');
    const saveAsBtn = panel.querySelector('#council-save-as-btn');

    if (saveBtn) {
      saveBtn.disabled = !this._isDirty || !this.selectedCouncilId;
    }
    if (saveAsBtn) {
      saveAsBtn.disabled = !this._isDirty;
    }

    // Toggle the "unsaved changes" hint in the modal footer
    this._updateDirtyHint();
  }

  /**
   * Toggle the "unsaved changes" hint in the modal footer.
   * Visible only when council tab is active AND config is dirty.
   */
  _updateDirtyHint() {
    const hint = this.modal.querySelector('#council-dirty-hint');
    if (!hint) return;
    hint.style.display = (this.activeTab === 'council' && this._isDirty) ? '' : 'none';
  }

  /**
   * Update council custom instructions character count
   * @param {number} count - Current character count
   */
  _updateCouncilCharCount(count) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const charCountEl = panel.querySelector('#council-char-count');
    const charCountContainer = panel.querySelector('#council-char-count-container');
    const textarea = panel.querySelector('#council-custom-instructions');
    const submitBtn = this.modal.querySelector('[data-action="submit"]');

    if (charCountEl) {
      charCountEl.textContent = count.toLocaleString();
    }

    const isOverLimit = count > this.CHAR_LIMIT;
    const isNearLimit = count > this.CHAR_WARNING_THRESHOLD && count <= this.CHAR_LIMIT;

    if (charCountContainer) {
      charCountContainer.classList.remove('char-count-warning', 'char-count-error');
      if (isOverLimit) {
        charCountContainer.classList.add('char-count-error');
      } else if (isNearLimit) {
        charCountContainer.classList.add('char-count-warning');
      }
    }

    if (textarea) {
      textarea.classList.remove('textarea-warning', 'textarea-error');
      if (isOverLimit) {
        textarea.classList.add('textarea-error');
      } else if (isNearLimit) {
        textarea.classList.add('textarea-warning');
      }
    }

    // Only disable submit when on council tab and over limit
    if (submitBtn && this.activeTab === 'council') {
      submitBtn.disabled = isOverLimit;
      if (isOverLimit) {
        submitBtn.title = 'Custom instructions exceed 5,000 character limit';
      } else {
        submitBtn.title = 'Start Analysis (Cmd/Ctrl+Enter)';
      }
    }
  }

  _readConfigFromUI() {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return this._defaultConfig();

    const config = { levels: {}, orchestration: {} };

    for (const level of [1, 2, 3]) {
      const checkbox = panel.querySelector(`.level-checkbox[data-level="${level}"]`);
      const enabled = checkbox?.checked || false;
      const voices = [];

      if (enabled) {
        const wrappers = panel.querySelectorAll(`.participant-wrapper[data-level="${level}"]`);
        wrappers.forEach(wrapper => {
          const row = wrapper.querySelector('.voice-row');
          const provider = row?.querySelector('.voice-provider')?.value;
          const model = row?.querySelector('.voice-model')?.value;
          const tier = row?.querySelector('.voice-tier')?.value;
          const idx = wrapper.dataset.index;
          const instructionsArea = wrapper.querySelector(`.voice-instructions-input[data-level="${level}"][data-index="${idx}"]`);
          const customInstructions = instructionsArea?.value?.trim() || undefined;

          if (provider && model) {
            const voice = { provider, model, tier };
            if (customInstructions) voice.customInstructions = customInstructions;
            voices.push(voice);
          }
        });
      }

      config.levels[String(level)] = { enabled, voices };
    }

    // Orchestration
    const orchRow = panel.querySelector('#orchestration-voice');
    if (orchRow) {
      config.orchestration = {
        provider: orchRow.querySelector('.voice-provider')?.value || 'claude',
        model: orchRow.querySelector('.voice-model')?.value || 'sonnet',
        tier: orchRow.querySelector('.voice-tier')?.value || 'balanced'
      };
    }

    return config;
  }

  _applyConfigToUI(config) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    for (const level of [1, 2, 3]) {
      const levelConfig = config.levels?.[String(level)];
      const checkbox = panel.querySelector(`.level-checkbox[data-level="${level}"]`);
      const voicesContainer = panel.querySelector(`#level-${level}-voices`);
      const voiceList = panel.querySelector(`#level-${level}-voice-list`);

      if (checkbox) checkbox.checked = !!levelConfig?.enabled;
      if (voicesContainer) voicesContainer.style.display = levelConfig?.enabled ? '' : 'none';

      if (voiceList && levelConfig?.voices?.length > 0) {
        voiceList.innerHTML = '';
        levelConfig.voices.forEach((voice, i) => {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = this._buildVoiceRowHTML(level, i);
          while (wrapper.firstChild) {
            voiceList.appendChild(wrapper.firstChild);
          }

          // Set values after adding to DOM
          const participantWrapper = voiceList.querySelector(`.participant-wrapper[data-level="${level}"][data-index="${i}"]`);
          const row = participantWrapper?.querySelector('.voice-row');
          const providerSelect = row?.querySelector('.voice-provider');
          if (providerSelect) {
            this._populateProviderDropdown(providerSelect);
            providerSelect.value = voice.provider;
            this._updateModelDropdown(providerSelect);
            const modelSelect = row.querySelector('.voice-model');
            if (modelSelect) modelSelect.value = voice.model;
            const tierSelect = row.querySelector('.voice-tier');
            if (tierSelect) tierSelect.value = voice.tier || 'balanced';
          }

          if (voice.customInstructions) {
            const instrInput = participantWrapper?.querySelector(`.voice-instructions-input[data-level="${level}"][data-index="${i}"]`);
            if (instrInput) instrInput.value = voice.customInstructions;
            const instrArea = participantWrapper?.querySelector(`.voice-instructions-area[data-level="${level}"][data-index="${i}"]`);
            if (instrArea) instrArea.style.display = '';
            // Set solid icon to indicate instructions are present
            this._updateInstructionsIcon(panel, String(level), String(i), voice.customInstructions);
          }
        });

        // Update remove button visibility after loading
        this._updateRemoveButtonVisibility(level);
      } else if (voiceList) {
        voiceList.innerHTML = '';
      }
    }

    // Orchestration
    if (config.orchestration) {
      const orchRow = panel.querySelector('#orchestration-voice');
      if (orchRow) {
        const providerSelect = orchRow.querySelector('.voice-provider');
        if (providerSelect) {
          this._populateProviderDropdown(providerSelect);
          providerSelect.value = config.orchestration.provider;
          this._updateModelDropdown(providerSelect);
          const modelSelect = orchRow.querySelector('.voice-model');
          if (modelSelect) modelSelect.value = config.orchestration.model;
          const tierSelect = orchRow.querySelector('.voice-tier');
          if (tierSelect) tierSelect.value = config.orchestration.tier || 'balanced';
        }
      }
    }
  }

  async _saveCouncil() {
    const config = this._readConfigFromUI();
    const { valid } = this._validateConfig(config);
    if (!valid) {
      if (window.toast) window.toast.showWarning('At least one review level must be enabled.');
      return;
    }
    if (this.selectedCouncilId) {
      try {
        await this._putCouncil(this.selectedCouncilId, config);
      } catch (error) {
        console.error('Error saving council:', error);
        if (window.toast) {
          window.toast.showError('Failed to save council');
        }
      }
    } else {
      this._saveCouncilAs();
    }
  }

  async _saveCouncilAs() {
    const config = this._readConfigFromUI();
    const { valid } = this._validateConfig(config);
    if (!valid) {
      if (window.toast) window.toast.showWarning('At least one review level must be enabled.');
      return;
    }

    const name = prompt('Council name:');
    if (!name?.trim()) return;
    try {
      await this._postCouncil(name.trim(), config);
    } catch (error) {
      console.error('Error saving council:', error);
      if (window.toast) {
        window.toast.showError('Failed to save council');
      }
    }
  }

  /**
   * PUT (update) an existing council by ID.
   * Handles fetch, response check, markClean, and selector refresh.
   * @param {string} councilId - The council ID to update
   * @param {Object} config - The council configuration to save
   */
  async _putCouncil(councilId, config) {
    const response = await fetch(`/api/councils/${councilId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    });
    if (!response.ok) {
      throw new Error(`PUT /api/councils/${councilId} failed: ${response.status}`);
    }
    this._markClean();
    await this.loadCouncils();
  }

  /**
   * POST (create) a new council with the given name.
   * Handles fetch, response check, markClean, selector refresh, and selection update.
   * @param {string} name - The name for the new council
   * @param {Object} config - The council configuration to save
   */
  async _postCouncil(name, config) {
    const response = await fetch('/api/councils', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config })
    });
    if (!response.ok) {
      throw new Error(`POST /api/councils failed: ${response.status}`);
    }
    const data = await response.json();
    this.selectedCouncilId = data.council.id;
    this._markClean();
    await this.loadCouncils();
    const selector = this.modal.querySelector('#council-selector');
    if (selector) selector.value = this.selectedCouncilId;
  }

  _exportCouncil() {
    const config = this._readConfigFromUI();
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'council-config.json';
    a.click();
    URL.revokeObjectURL(url);
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.CouncilConfigTab = CouncilConfigTab;
}
