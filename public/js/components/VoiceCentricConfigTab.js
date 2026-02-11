// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Voice-Centric Council Configuration Tab
 *
 * Provides the "Council" tab in the AnalysisConfigModal. This is a simpler
 * alternative to the Advanced (level-centric) tab: reviewers are listed flat,
 * and global level toggles (L1/L2/L3) apply to every reviewer uniformly.
 */
class VoiceCentricConfigTab {
  /** Info circle SVG icon for section tooltips */
  static INFO_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`;

  /**
   * Build an info-tip toggle button
   * @param {string} id - Unique identifier for aria-controls linkage
   * @returns {string} HTML string
   */
  static buildInfoTipButton(id) {
    return `<button class="info-tip-toggle" aria-controls="info-tip-vc-${id}" aria-expanded="false" title="More info">${VoiceCentricConfigTab.INFO_ICON_SVG}</button>`;
  }

  /**
   * Build a hidden info-tip content block
   * @param {string} id - Unique identifier matching the toggle button
   * @param {string} text - Explanation text (may contain HTML)
   * @returns {string} HTML string
   */
  static buildInfoTipContent(id, text) {
    return `<div class="info-tip-content" id="info-tip-vc-${id}" style="display:none">${text}</div>`;
  }

  /** Speech bubble SVG icon (outline) */
  static SPEECH_BUBBLE_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.5 0v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25H2.75a.25.25 0 0 0-.25.25Z"/></svg>`;

  /** Speech bubble SVG icon (solid/filled) */
  static SPEECH_BUBBLE_SVG_SOLID = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 1C1.784 1 1 1.784 1 2.75v7.5c0 .966.784 1.75 1.75 1.75H4v1.543a1.458 1.458 0 0 0 2.487 1.03L9.06 12h4.19A1.75 1.75 0 0 0 15 10.25v-7.5A1.75 1.75 0 0 0 13.25 1H2.75Z"/></svg>`;

  /** Clock SVG icon for per-voice timeout toggle */
  static CLOCK_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z"/></svg>`;

  /** Default timeout in milliseconds (10 minutes) */
  static DEFAULT_TIMEOUT = 600000;

  constructor(modal) {
    this.modal = modal;
    this.councils = [];
    this.selectedCouncilId = null;
    this.providers = {};
    this._injected = false;
    this._councilsLoaded = false;

    // Dirty state tracking
    this._isDirty = false;

    // Character limit constants for custom instructions
    this.CHAR_LIMIT = 5000;
    this.CHAR_WARNING_THRESHOLD = 4500;

    // Default orchestration fallback
    this._defaultProvider = 'claude';
    this._defaultModel = 'sonnet';
  }

  /**
   * Inject the voice-centric council panel into the modal.
   * Called by AnalysisConfigModal after the tab panels are created.
   * @param {HTMLElement} panel - The #tab-panel-council element
   */
  inject(panel) {
    if (this._injected) return;
    if (!panel) return;

    panel.innerHTML = this._buildHTML();
    this._setupListeners(panel);
    this._injected = true;
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
   * Load saved councils from the API, filtering to type === 'council'
   */
  async loadCouncils() {
    try {
      const response = await fetch('/api/councils');
      if (!response.ok) throw new Error('Failed to fetch councils');
      const data = await response.json();
      // Only show voice-centric councils (type === 'council' or missing type for backwards compat)
      this.councils = (data.councils || []).filter(c => c.type === 'council');
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
   * Get the current council config for submission.
   * Converts voice-centric flat list + global levels into the levels format
   * the backend expects: { levels: { '1': { enabled, voices }, ... }, consolidation }
   * @returns {Object} Council config in levels format
   */
  getCouncilConfig() {
    return this._readConfigFromUI();
  }

  /**
   * Get selected council ID
   * @returns {string|null}
   */
  getSelectedCouncilId() {
    return this.selectedCouncilId;
  }

  /**
   * Validate the current config.
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
   * @param {Object} config
   * @returns {{ valid: boolean, error: string|null }}
   */
  _validateConfig(config) {
    // At least one level must be enabled
    const hasEnabledLevel = Object.values(config.levels).some(l => l.enabled);
    if (!hasEnabledLevel) {
      return { valid: false, error: 'At least one review level must be enabled.' };
    }
    // Must have at least one reviewer
    const reviewerCount = this._getReviewerCount();
    if (reviewerCount === 0) {
      return { valid: false, error: 'At least one reviewer is required.' };
    }
    return { valid: true, error: null };
  }

  /**
   * Auto-save council if dirty before analysis starts.
   */
  async autoSaveIfDirty() {
    if (!this._isDirty && this.selectedCouncilId) return;

    const config = this._readConfigFromUI();
    const { valid } = this._validateConfig(config);
    if (!valid) return;

    try {
      const timestamp = this._formatTimestamp(new Date());
      let name;
      if (this.selectedCouncilId) {
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

  /**
   * Set repo instructions in the council tab
   */
  setRepoInstructions(text) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const banner = panel.querySelector('#vc-repo-instructions-banner');
    const repoText = panel.querySelector('#vc-repo-instructions-text');

    if (text) {
      if (banner) banner.style.display = 'flex';
      if (repoText) repoText.textContent = text;
    } else {
      if (banner) banner.style.display = 'none';
    }
  }

  /**
   * Set last used custom instructions
   */
  setLastInstructions(text) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const textarea = panel.querySelector('#vc-custom-instructions');
    if (textarea) {
      textarea.value = text || '';
      this._updateCharCount(textarea.value.length);
    }
  }

  /**
   * Set default orchestration provider/model
   */
  setDefaultOrchestration(provider, model) {
    this._defaultProvider = provider || 'claude';
    this._defaultModel = model || 'sonnet';
  }

  /**
   * Set the default council ID to pre-select
   */
  setDefaultCouncilId(councilId) {
    this._pendingDefaultCouncilId = councilId;
  }

  /**
   * Whether the config has unsaved changes
   */
  get isDirty() {
    return this._isDirty;
  }

  // --- Private methods ---

  _formatTimestamp(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  _buildHTML() {
    return `
      <section class="config-section">
        <h4 class="section-title">Council ${VoiceCentricConfigTab.buildInfoTipButton('council')}</h4>
        ${VoiceCentricConfigTab.buildInfoTipContent('council', 'A Review Council runs your code review through multiple AI models in parallel, then consolidates their findings. Different models catch different issues, giving you broader coverage than a single reviewer.')}
        <div class="council-selector-row">
          <select id="vc-council-selector" class="council-select new-council-selected">
            <option value="" class="council-option-new">+ New Council</option>
          </select>
          <button class="btn btn-sm btn-secondary" id="vc-council-save-btn" title="Save" disabled>Save</button>
          <button class="btn btn-sm btn-secondary" id="vc-council-save-as-btn" title="Save As" disabled>Save As</button>
          <button class="btn btn-sm btn-secondary" id="vc-council-export-btn" title="Copy config JSON to clipboard">Export</button>
          <button class="btn btn-sm btn-icon-danger" id="vc-council-delete-btn" title="Delete council" disabled>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 011.492.149l-.66 6.6A1.748 1.748 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 111.492-.15z"/>
            </svg>
          </button>
        </div>
      </section>

      <section class="config-section">
        <h4 class="section-title">Reviewers ${VoiceCentricConfigTab.buildInfoTipButton('reviewers')}</h4>
        ${VoiceCentricConfigTab.buildInfoTipContent('reviewers', 'Each reviewer runs the analysis independently using its own AI model. Adding multiple reviewers with different models gives broader coverage &mdash; different models catch different issues.')}
        <div class="voice-list" id="vc-reviewer-list">
          ${this._buildReviewerRowHTML(0)}
        </div>
        <button class="btn btn-sm btn-icon add-voice-btn" id="vc-add-reviewer-btn" title="Add Reviewer">+</button>
      </section>

      <section class="config-section">
        <h4 class="section-title">Review Levels ${VoiceCentricConfigTab.buildInfoTipButton('levels')}</h4>
        ${VoiceCentricConfigTab.buildInfoTipContent('levels', 'Select which analysis levels to run. All reviewers will run the same levels. Level 1 focuses on the diff itself, Level 2 adds file context, and Level 3 analyzes against the full codebase.')}
        <div class="vc-level-toggles">
          <label class="remember-toggle vc-level-toggle">
            <input type="checkbox" class="vc-level-checkbox" data-level="1" checked />
            <span class="toggle-switch"></span>
            <span class="toggle-label">Level 1 &mdash; Changes in Isolation</span>
          </label>
          <label class="remember-toggle vc-level-toggle">
            <input type="checkbox" class="vc-level-checkbox" data-level="2" checked />
            <span class="toggle-switch"></span>
            <span class="toggle-label">Level 2 &mdash; File Context</span>
          </label>
          <label class="remember-toggle vc-level-toggle">
            <input type="checkbox" class="vc-level-checkbox" data-level="3" checked />
            <span class="toggle-switch"></span>
            <span class="toggle-label">Level 3 &mdash; Codebase Context</span>
          </label>
        </div>
      </section>

      <section class="config-section">
        <h4 class="section-title">Consolidation ${VoiceCentricConfigTab.buildInfoTipButton('consolidation')}</h4>
        ${VoiceCentricConfigTab.buildInfoTipContent('consolidation', 'The consolidation model merges findings from all reviewers into a single coherent review. <strong>Fast</strong> tier gives concise output, <strong>Balanced</strong> is the recommended default, and <strong>Thorough</strong> produces the most detailed consolidation.')}
        <p class="section-hint-text">Model used for cross-reviewer consolidation</p>
        <div class="orchestration-card" id="vc-orchestration-card">
          <div class="voice-row" id="vc-orchestration-voice">
            <select class="voice-provider" data-target="orchestration"></select>
            <select class="voice-model" data-target="orchestration"></select>
            <select class="voice-tier" data-target="orchestration">
              <option value="fast">Fast</option>
              <option value="balanced" selected>Balanced</option>
              <option value="thorough">Thorough</option>
            </select>
            <select class="vc-timeout" id="vc-orchestration-timeout" title="Consolidation timeout" style="display:none">
              <option value="300000">5m</option>
              <option value="600000" selected>10m</option>
              <option value="900000">15m</option>
              <option value="1800000">30m</option>
            </select>
            <button class="toggle-timeout-icon" id="vc-orchestration-timeout-toggle" title="Consolidation timeout">${VoiceCentricConfigTab.CLOCK_SVG}</button>
            <button class="toggle-instructions-icon" id="vc-orchestration-instructions-toggle" title="Consolidation instructions">${VoiceCentricConfigTab.SPEECH_BUBBLE_SVG}</button>
          </div>
          <div class="voice-instructions-area" id="vc-orchestration-instructions-area" style="display:none">
            <textarea class="voice-instructions-input" id="vc-orchestration-instructions" placeholder="Consolidation instructions (e.g., Prefer security findings over style nits)" rows="2"></textarea>
          </div>
        </div>
      </section>

      ${this._buildInstructionsHTML()}
    `;
  }

  _buildReviewerRowHTML(index) {
    return `
      <div class="participant-wrapper vc-reviewer" data-index="${index}">
        <div class="participant-card">
          <div class="voice-row" data-index="${index}">
            <select class="voice-provider" data-index="${index}"></select>
            <select class="voice-model" data-index="${index}"></select>
            <select class="voice-tier" data-index="${index}">
              <option value="fast">Fast</option>
              <option value="balanced" selected>Balanced</option>
              <option value="thorough">Thorough</option>
            </select>
            <select class="vc-timeout" data-index="${index}" title="Per-reviewer timeout" style="display:none">
              <option value="300000">5m</option>
              <option value="600000" selected>10m</option>
              <option value="900000">15m</option>
              <option value="1800000">30m</option>
            </select>
            <button class="toggle-timeout-icon" data-index="${index}" title="Per-reviewer timeout">${VoiceCentricConfigTab.CLOCK_SVG}</button>
            <button class="toggle-instructions-icon" data-index="${index}" title="Per-reviewer instructions">${VoiceCentricConfigTab.SPEECH_BUBBLE_SVG}</button>
          </div>
          <div class="voice-instructions-area" data-index="${index}" style="display:none">
            <textarea class="voice-instructions-input" data-index="${index}" placeholder="Per-reviewer instructions (e.g., Focus on security)" rows="2"></textarea>
          </div>
        </div>
        <button class="btn btn-sm btn-icon remove-voice-btn" data-index="${index}" title="Remove Reviewer">&minus;</button>
      </div>
    `;
  }

  _buildInstructionsHTML() {
    return `
      <div class="council-review-divider">
        <span class="divider-label">This Review</span>
      </div>
      <section class="config-section">
        <h4 class="section-title">
          Custom Instructions
          <span class="section-hint">(optional)</span>
          ${VoiceCentricConfigTab.buildInfoTipButton('custom-instructions')}
        </h4>
        ${VoiceCentricConfigTab.buildInfoTipContent('custom-instructions', 'Free-form guidance sent to every reviewer in this review. Use this to focus the review on what matters most &mdash; e.g., "Pay extra attention to error handling" or "This is a security-critical change."')}
        <div class="instructions-container">
          <div class="repo-instructions-banner" id="vc-repo-instructions-banner" style="display: none;">
            <div class="banner-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-8a1 1 0 00-1 1v6.708A2.486 2.486 0 014.5 9h8V1.5zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/>
              </svg>
            </div>
            <div class="banner-content">
              <span class="banner-label">Repository default instructions active</span>
              <button class="banner-toggle" id="vc-toggle-repo-instructions" title="Show repository instructions">
                <span>View</span>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="repo-instructions-expanded" id="vc-repo-instructions-expanded" style="display: none;">
            <div class="expanded-header">
              <span>Repository Instructions</span>
              <button class="collapse-btn" id="vc-collapse-repo-instructions" title="Collapse">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 8.72a.75.75 0 011.06 0L8 11.94l3.22-3.22a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.72 9.78a.75.75 0 010-1.06z"/>
                </svg>
              </button>
            </div>
            <div class="expanded-content" id="vc-repo-instructions-text"></div>
          </div>
          <textarea
            id="vc-custom-instructions"
            class="instructions-textarea"
            data-no-dirty
            placeholder="Add specific guidance for this review...&#10;&#10;Examples:&#10;&#8226; Pay extra attention to the authentication logic&#10;&#8226; Check for proper error handling in the API calls&#10;&#8226; This is a performance-critical section"
            rows="4"
          ></textarea>
          <div class="instructions-footer">
            <span class="char-count" id="vc-char-count-container">
              <span id="vc-char-count">0</span> / 5,000 characters
            </span>
          </div>
        </div>
      </section>
    `;
  }

  _setupListeners(panel) {
    // Council selector
    panel.querySelector('#vc-council-selector')?.addEventListener('change', (e) => {
      this.selectedCouncilId = e.target.value || null;
      e.target.classList.toggle('new-council-selected', !this.selectedCouncilId);
      if (this.selectedCouncilId) {
        const council = this.councils.find(c => c.id === this.selectedCouncilId);
        if (council) {
          this._applyConfigToUI(council.config);
          this._markClean();
        }
      } else {
        this._applyConfigToUI(this._defaultConfig());
        this._markDirty();
      }
      this._updateSaveButtonStates();
    });

    // Save button
    panel.querySelector('#vc-council-save-btn')?.addEventListener('click', () => this._saveCouncil());
    // Save As button
    panel.querySelector('#vc-council-save-as-btn')?.addEventListener('click', () => this._saveCouncilAs());
    // Export button
    panel.querySelector('#vc-council-export-btn')?.addEventListener('click', () => this._exportCouncil());
    // Delete button
    panel.querySelector('#vc-council-delete-btn')?.addEventListener('click', () => this._deleteCouncil());

    // Footer save button (lives in modal footer, not council panel)
    this.modal.querySelector('#council-footer-save-btn')?.addEventListener('click', () => {
      if (this.selectedCouncilId) {
        this._saveCouncil();
      } else {
        this._saveCouncilAs();
      }
    });

    // Add reviewer button
    panel.querySelector('#vc-add-reviewer-btn')?.addEventListener('click', () => this._addReviewer());

    // Delegate remove reviewer and toggle instructions
    panel.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.remove-voice-btn');
      if (removeBtn) {
        this._removeReviewer(removeBtn.dataset.index);
      }

      const toggleBtn = e.target.closest('.toggle-instructions-icon');
      if (toggleBtn) {
        // Orchestration instructions toggle (no data-index)
        if (toggleBtn.id === 'vc-orchestration-instructions-toggle') {
          const area = panel.querySelector('#vc-orchestration-instructions-area');
          if (area) {
            const isHidden = area.style.display === 'none';
            area.style.display = isHidden ? '' : 'none';
            if (isHidden) {
              const textarea = area.querySelector('#vc-orchestration-instructions');
              if (textarea) textarea.focus();
            }
          }
        } else {
          // Per-reviewer instructions toggle
          const idx = toggleBtn.dataset.index;
          const wrapper = panel.querySelector(`.vc-reviewer[data-index="${idx}"]`);
          const area = wrapper?.querySelector(`.voice-instructions-area[data-index="${idx}"]`);
          if (area) {
            const isHidden = area.style.display === 'none';
            area.style.display = isHidden ? '' : 'none';
            if (isHidden) {
              const textarea = area.querySelector('.voice-instructions-input');
              if (textarea) textarea.focus();
            }
          }
        }
      }

      // Toggle timeout dropdown via clock icon
      const clockBtn = e.target.closest('.toggle-timeout-icon');
      if (clockBtn) {
        // Orchestration timeout toggle
        if (clockBtn.id === 'vc-orchestration-timeout-toggle') {
          const timeoutSelect = panel.querySelector('#vc-orchestration-timeout');
          if (timeoutSelect) {
            const isHidden = timeoutSelect.style.display === 'none';
            timeoutSelect.style.display = isHidden ? '' : 'none';
          }
        } else {
          const idx = clockBtn.dataset.index;
          const wrapper = panel.querySelector(`.vc-reviewer[data-index="${idx}"]`);
          const timeoutSelect = wrapper?.querySelector(`.vc-timeout[data-index="${idx}"]`);
          if (timeoutSelect) {
            const isHidden = timeoutSelect.style.display === 'none';
            timeoutSelect.style.display = isHidden ? '' : 'none';
          }
        }
      }

      // Info-tip toggles
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

    // Update speech bubble icon based on textarea content
    panel.addEventListener('input', (e) => {
      if (e.target.classList.contains('voice-instructions-input')) {
        // Orchestration instructions textarea
        if (e.target.id === 'vc-orchestration-instructions') {
          this._updateOrchestrationInstructionsIcon(panel, e.target.value);
        } else {
          const idx = e.target.dataset.index;
          this._updateInstructionsIcon(panel, idx, e.target.value);
        }
      }
    });

    // Provider change -> update model dropdowns
    panel.addEventListener('change', (e) => {
      if (e.target.classList.contains('voice-provider')) {
        this._updateModelDropdown(e.target);
      }
      // Model change -> update tier to match model's recommended tier
      if (e.target.classList.contains('voice-model')) {
        this._syncTierToModel(e.target);
      }
      // Timeout change -> update clock icon styling
      if (e.target.classList.contains('vc-timeout')) {
        if (e.target.id === 'vc-orchestration-timeout') {
          this._updateOrchestrationTimeoutIcon(panel, e.target.value);
        } else {
          const idx = e.target.dataset.index;
          this._updateTimeoutIcon(panel, idx, e.target.value);
        }
      }
    });

    // Dirty state tracking
    panel.addEventListener('change', (e) => {
      if (e.target.matches('select, input[type="checkbox"]')) {
        this._markDirty();
      }
    });
    panel.addEventListener('input', (e) => {
      if (e.target.matches('textarea') && !('noDirty' in e.target.dataset)) {
        this._markDirty();
      }
    });

    // Custom instructions char count
    const customTextarea = panel.querySelector('#vc-custom-instructions');
    customTextarea?.addEventListener('input', () => {
      this._updateCharCount(customTextarea.value.length);
    });

    // Repo instructions toggle
    panel.querySelector('#vc-toggle-repo-instructions')?.addEventListener('click', () => {
      panel.querySelector('#vc-repo-instructions-banner').style.display = 'none';
      panel.querySelector('#vc-repo-instructions-expanded').style.display = 'block';
    });
    panel.querySelector('#vc-collapse-repo-instructions')?.addEventListener('click', () => {
      panel.querySelector('#vc-repo-instructions-banner').style.display = 'flex';
      panel.querySelector('#vc-repo-instructions-expanded').style.display = 'none';
    });
  }

  _getReviewerCount() {
    const list = this.modal.querySelector('#vc-reviewer-list');
    return list ? list.querySelectorAll('.vc-reviewer').length : 0;
  }

  _addReviewer() {
    const list = this.modal.querySelector('#vc-reviewer-list');
    if (!list) return;

    const index = list.querySelectorAll('.vc-reviewer').length;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = this._buildReviewerRowHTML(index);
    while (wrapper.firstChild) {
      list.appendChild(wrapper.firstChild);
    }

    // Populate provider dropdown
    const newProviderSelect = list.querySelector(`.voice-provider[data-index="${index}"]`);
    if (newProviderSelect) {
      this._populateProviderDropdown(newProviderSelect);
    }

    this._updateRemoveButtonVisibility();
    this._markDirty();
  }

  _removeReviewer(index) {
    const list = this.modal.querySelector('#vc-reviewer-list');
    if (!list) return;

    const reviewers = list.querySelectorAll('.vc-reviewer');
    if (reviewers.length <= 1) return;

    const wrapper = list.querySelector(`.vc-reviewer[data-index="${index}"]`);
    if (wrapper) wrapper.remove();

    this._reindexReviewers();
    this._updateRemoveButtonVisibility();
    this._markDirty();
  }

  _reindexReviewers() {
    const list = this.modal.querySelector('#vc-reviewer-list');
    if (!list) return;

    list.querySelectorAll('.vc-reviewer').forEach((wrapper, newIndex) => {
      wrapper.dataset.index = newIndex;
      wrapper.querySelectorAll('[data-index]').forEach(el => {
        el.dataset.index = newIndex;
      });
    });
  }

  _updateRemoveButtonVisibility() {
    const list = this.modal.querySelector('#vc-reviewer-list');
    if (!list) return;

    const reviewers = list.querySelectorAll('.vc-reviewer');
    const single = reviewers.length <= 1;
    reviewers.forEach(wrapper => {
      const btn = wrapper.querySelector('.remove-voice-btn');
      if (btn) btn.style.visibility = single ? 'hidden' : 'visible';
    });
  }

  _updateInstructionsIcon(panel, index, value) {
    const wrapper = panel.querySelector(`.vc-reviewer[data-index="${index}"]`);
    const iconBtn = wrapper?.querySelector(`.toggle-instructions-icon[data-index="${index}"]`);
    if (!iconBtn) return;

    const hasContent = value.trim().length > 0;
    iconBtn.innerHTML = hasContent
      ? VoiceCentricConfigTab.SPEECH_BUBBLE_SVG_SOLID
      : VoiceCentricConfigTab.SPEECH_BUBBLE_SVG;
    iconBtn.classList.toggle('has-instructions', hasContent);
  }

  _updateOrchestrationInstructionsIcon(panel, value) {
    const iconBtn = panel.querySelector('#vc-orchestration-instructions-toggle');
    if (!iconBtn) return;

    const hasContent = value.trim().length > 0;
    iconBtn.innerHTML = hasContent
      ? VoiceCentricConfigTab.SPEECH_BUBBLE_SVG_SOLID
      : VoiceCentricConfigTab.SPEECH_BUBBLE_SVG;
    iconBtn.classList.toggle('has-instructions', hasContent);
  }

  /**
   * Update the clock/timeout icon styling to indicate non-default timeout.
   * @param {Element} panel - The council panel element
   * @param {string} index - Reviewer index
   * @param {string} value - Current timeout value (as string of ms)
   */
  _updateTimeoutIcon(panel, index, value) {
    const wrapper = panel.querySelector(`.vc-reviewer[data-index="${index}"]`);
    const iconBtn = wrapper?.querySelector(`.toggle-timeout-icon[data-index="${index}"]`);
    if (!iconBtn) return;

    const isNonDefault = parseInt(value, 10) !== VoiceCentricConfigTab.DEFAULT_TIMEOUT;
    iconBtn.classList.toggle('has-custom-timeout', isNonDefault);
  }

  _updateOrchestrationTimeoutIcon(panel, value) {
    const iconBtn = panel.querySelector('#vc-orchestration-timeout-toggle');
    if (!iconBtn) return;

    const isNonDefault = parseInt(value, 10) !== VoiceCentricConfigTab.DEFAULT_TIMEOUT;
    iconBtn.classList.toggle('has-custom-timeout', isNonDefault);
  }

  // --- Dropdown / model management ---

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

    if (currentModel && models.some(m => m.id === currentModel)) {
      modelSelect.value = currentModel;
    } else {
      const defaultModel = models.find(m => m.default) || models[0];
      if (defaultModel) modelSelect.value = defaultModel.id;
    }

    // Auto-set tier
    const tierSelect = container?.querySelector('.voice-tier');
    if (tierSelect) {
      const selectedModel = models.find(m => m.id === modelSelect.value);
      if (selectedModel) tierSelect.value = selectedModel.tier || 'balanced';
    }
  }

  /**
   * Sync the tier dropdown to the selected model's recommended tier.
   * Called when the user manually changes the model dropdown.
   * @param {HTMLSelectElement} modelSelect - The model dropdown that changed
   */
  _syncTierToModel(modelSelect) {
    const container = modelSelect.closest('.voice-row');
    const tierSelect = container?.querySelector('.voice-tier');
    if (!tierSelect) return;

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const tier = selectedOption?.dataset?.tier;
    if (tier) {
      tierSelect.value = tier;
    }
  }

  // --- Config read/write ---

  _defaultConfig() {
    return {
      voices: [{ provider: this._defaultProvider, model: this._defaultModel, tier: 'balanced', timeout: VoiceCentricConfigTab.DEFAULT_TIMEOUT }],
      enabledLevels: [1, 2, 3],
      orchestration: { provider: this._defaultProvider, model: this._defaultModel, tier: 'balanced', timeout: VoiceCentricConfigTab.DEFAULT_TIMEOUT }
    };
  }

  /**
   * Read voice-centric config from UI and convert to the levels format the backend expects.
   * Voice-centric config stores: { voices: [...], enabledLevels: [1,2,3], orchestration: {...} }
   * Backend expects: { levels: { '1': { enabled, voices }, ... }, consolidation: {...} }
   */
  _readConfigFromUI() {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return this._convertToLevelsFormat(this._defaultConfig());

    // Read reviewers
    const voices = [];
    const reviewers = panel.querySelectorAll('.vc-reviewer');
    reviewers.forEach(wrapper => {
      const row = wrapper.querySelector('.voice-row');
      const provider = row?.querySelector('.voice-provider')?.value;
      const model = row?.querySelector('.voice-model')?.value;
      const tier = row?.querySelector('.voice-tier')?.value;
      const timeoutSelect = row?.querySelector('.vc-timeout');
      const timeout = timeoutSelect ? parseInt(timeoutSelect.value, 10) : VoiceCentricConfigTab.DEFAULT_TIMEOUT;
      const idx = wrapper.dataset.index;
      const instrInput = wrapper.querySelector(`.voice-instructions-input[data-index="${idx}"]`);
      const customInstructions = instrInput?.value?.trim() || undefined;

      if (provider && model) {
        const voice = { provider, model, tier, timeout };
        if (customInstructions) voice.customInstructions = customInstructions;
        voices.push(voice);
      }
    });

    // Read enabled levels
    const enabledLevels = [];
    panel.querySelectorAll('.vc-level-checkbox:checked').forEach(cb => {
      enabledLevels.push(parseInt(cb.dataset.level, 10));
    });

    // Read orchestration
    const orchRow = panel.querySelector('#vc-orchestration-voice');
    const orchTimeoutSelect = panel.querySelector('#vc-orchestration-timeout');
    const orchInstrInput = panel.querySelector('#vc-orchestration-instructions');
    const orchTimeout = orchTimeoutSelect ? parseInt(orchTimeoutSelect.value, 10) : VoiceCentricConfigTab.DEFAULT_TIMEOUT;
    const orchCustomInstructions = orchInstrInput?.value?.trim() || undefined;
    const orchestration = orchRow ? {
      provider: orchRow.querySelector('.voice-provider')?.value || 'claude',
      model: orchRow.querySelector('.voice-model')?.value || 'sonnet',
      tier: orchRow.querySelector('.voice-tier')?.value || 'balanced',
      timeout: orchTimeout,
      ...(orchCustomInstructions ? { customInstructions: orchCustomInstructions } : {})
    } : { provider: 'claude', model: 'sonnet', tier: 'balanced', timeout: VoiceCentricConfigTab.DEFAULT_TIMEOUT };

    return this._convertToLevelsFormat({ voices, enabledLevels, orchestration });
  }

  /**
   * Convert voice-centric format to levels format for the backend.
   * Every enabled level gets the same set of voices.
   */
  _convertToLevelsFormat(vcConfig) {
    const levels = {};
    for (const level of [1, 2, 3]) {
      const enabled = (vcConfig.enabledLevels || []).includes(level);
      levels[String(level)] = {
        enabled,
        voices: enabled ? (vcConfig.voices || []).map(v => ({
          provider: v.provider,
          model: v.model,
          tier: v.tier,
          timeout: v.timeout,
          ...(v.customInstructions ? { customInstructions: v.customInstructions } : {})
        })) : []
      };
    }
    return { levels, consolidation: vcConfig.orchestration || {} };
  }

  /**
   * Apply config to UI. Accepts either voice-centric format or levels format.
   */
  _applyConfigToUI(config) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    // Detect format: voice-centric has 'voices' array, levels-format has 'levels' object
    let vcConfig;
    if (config.voices && Array.isArray(config.voices)) {
      vcConfig = config;
    } else if (config.levels) {
      // Convert levels format back to voice-centric
      vcConfig = this._convertFromLevelsFormat(config);
    } else {
      vcConfig = this._defaultConfig();
    }

    // Apply reviewers
    const list = panel.querySelector('#vc-reviewer-list');
    if (list) {
      list.innerHTML = '';
      const voices = vcConfig.voices || [];
      if (voices.length === 0) {
        voices.push({ provider: this._defaultProvider, model: this._defaultModel, tier: 'balanced', timeout: VoiceCentricConfigTab.DEFAULT_TIMEOUT });
      }
      voices.forEach((voice, i) => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = this._buildReviewerRowHTML(i);
        while (wrapper.firstChild) {
          list.appendChild(wrapper.firstChild);
        }

        const reviewerWrapper = list.querySelector(`.vc-reviewer[data-index="${i}"]`);
        const row = reviewerWrapper?.querySelector('.voice-row');
        const providerSelect = row?.querySelector('.voice-provider');
        if (providerSelect) {
          this._populateProviderDropdown(providerSelect);
          providerSelect.value = voice.provider;
          this._updateModelDropdown(providerSelect);
          const modelSelect = row.querySelector('.voice-model');
          if (modelSelect) modelSelect.value = voice.model;
          const tierSelect = row.querySelector('.voice-tier');
          if (tierSelect) tierSelect.value = voice.tier || 'balanced';
          const timeoutSelect = row.querySelector('.vc-timeout');
          if (timeoutSelect && voice.timeout) {
            timeoutSelect.value = String(voice.timeout);
            // Show the dropdown if non-default
            if (voice.timeout !== VoiceCentricConfigTab.DEFAULT_TIMEOUT) {
              timeoutSelect.style.display = '';
            }
            this._updateTimeoutIcon(panel, String(i), String(voice.timeout));
          }
        }

        if (voice.customInstructions) {
          const instrInput = reviewerWrapper?.querySelector(`.voice-instructions-input[data-index="${i}"]`);
          if (instrInput) instrInput.value = voice.customInstructions;
          const instrArea = reviewerWrapper?.querySelector(`.voice-instructions-area[data-index="${i}"]`);
          if (instrArea) instrArea.style.display = '';
          this._updateInstructionsIcon(panel, String(i), voice.customInstructions);
        }
      });

      this._updateRemoveButtonVisibility();
    }

    // Apply level toggles
    const enabledLevels = vcConfig.enabledLevels || [];
    for (const level of [1, 2, 3]) {
      const checkbox = panel.querySelector(`.vc-level-checkbox[data-level="${level}"]`);
      if (checkbox) checkbox.checked = enabledLevels.includes(level);
    }

    // Apply orchestration
    if (vcConfig.orchestration) {
      const orchRow = panel.querySelector('#vc-orchestration-voice');
      if (orchRow) {
        const providerSelect = orchRow.querySelector('.voice-provider');
        if (providerSelect) {
          this._populateProviderDropdown(providerSelect);
          providerSelect.value = vcConfig.orchestration.provider;
          this._updateModelDropdown(providerSelect);
          const modelSelect = orchRow.querySelector('.voice-model');
          if (modelSelect) modelSelect.value = vcConfig.orchestration.model;
          const tierSelect = orchRow.querySelector('.voice-tier');
          if (tierSelect) tierSelect.value = vcConfig.orchestration.tier || 'balanced';
        }
      }

      // Restore orchestration timeout
      const orchTimeoutSelect = panel.querySelector('#vc-orchestration-timeout');
      if (orchTimeoutSelect && vcConfig.orchestration.timeout) {
        orchTimeoutSelect.value = String(vcConfig.orchestration.timeout);
        // Show the dropdown if non-default
        if (vcConfig.orchestration.timeout !== VoiceCentricConfigTab.DEFAULT_TIMEOUT) {
          orchTimeoutSelect.style.display = '';
        }
        this._updateOrchestrationTimeoutIcon(panel, String(vcConfig.orchestration.timeout));
      }

      // Restore orchestration custom instructions
      const orchInstrInput = panel.querySelector('#vc-orchestration-instructions');
      const orchInstrArea = panel.querySelector('#vc-orchestration-instructions-area');
      if (vcConfig.orchestration.customInstructions) {
        if (orchInstrInput) orchInstrInput.value = vcConfig.orchestration.customInstructions;
        if (orchInstrArea) orchInstrArea.style.display = '';
        this._updateOrchestrationInstructionsIcon(panel, vcConfig.orchestration.customInstructions);
      } else {
        if (orchInstrInput) orchInstrInput.value = '';
        if (orchInstrArea) orchInstrArea.style.display = 'none';
        this._updateOrchestrationInstructionsIcon(panel, '');
      }
    }
  }

  /**
   * Convert levels format back to voice-centric format.
   * Takes the voices from the first enabled level as the shared reviewer set.
   */
  _convertFromLevelsFormat(config) {
    const enabledLevels = [];
    let voices = [];

    for (const level of [1, 2, 3]) {
      const levelConfig = config.levels?.[String(level)];
      if (levelConfig?.enabled) {
        enabledLevels.push(level);
        // Use the voices from the first enabled level
        if (voices.length === 0 && levelConfig.voices?.length > 0) {
          voices = levelConfig.voices;
        }
      }
    }

    return {
      voices,
      enabledLevels,
      orchestration: config.consolidation || config.orchestration || {}
    };
  }

  // --- Council selector ---

  _renderCouncilSelector() {
    const selector = this.modal.querySelector('#vc-council-selector');
    if (!selector) return;

    const currentValue = selector.value;
    selector.innerHTML = '<option value="" class="council-option-new">+ New Council</option>';
    for (const council of this.councils) {
      const opt = document.createElement('option');
      opt.value = council.id;
      opt.textContent = council.name;
      selector.appendChild(opt);
    }

    // Apply pending default
    if (this._pendingDefaultCouncilId) {
      const pendingId = this._pendingDefaultCouncilId;
      this._pendingDefaultCouncilId = null;

      const council = this.councils.find(c => c.id === pendingId);
      if (council) {
        selector.value = pendingId;
        this.selectedCouncilId = pendingId;
        selector.classList.remove('new-council-selected');
        this._applyConfigToUI(council.config);
        this._markClean();
        return;
      }
    }

    if (currentValue) selector.value = currentValue;
    selector.classList.toggle('new-council-selected', !selector.value);
  }

  // --- Dirty state ---

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

    const saveBtn = panel.querySelector('#vc-council-save-btn');
    const saveAsBtn = panel.querySelector('#vc-council-save-as-btn');
    const deleteBtn = panel.querySelector('#vc-council-delete-btn');

    if (saveBtn) {
      saveBtn.disabled = !this._isDirty || !this.selectedCouncilId;
    }
    if (saveAsBtn) {
      const config = this._readConfigFromUI();
      const { valid } = this._validateConfig(config);
      saveAsBtn.disabled = !valid;
    }
    if (deleteBtn) {
      deleteBtn.disabled = !this.selectedCouncilId;
    }

    this._updateDirtyHint();
  }

  _updateDirtyHint() {
    const container = this.modal.querySelector('#council-footer-left');
    if (!container) return;
    // The activeTab check is handled by AnalysisConfigModal now
    container.style.display = this._isDirty ? '' : 'none';
  }

  // --- Char count ---

  _updateCharCount(count) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const charCountEl = panel.querySelector('#vc-char-count');
    const charCountContainer = panel.querySelector('#vc-char-count-container');
    const textarea = panel.querySelector('#vc-custom-instructions');
    const submitBtn = this.modal.querySelector('[data-action="submit"]');

    if (charCountEl) {
      charCountEl.textContent = count.toLocaleString();
    }

    const isOverLimit = count > this.CHAR_LIMIT;
    const isNearLimit = count > this.CHAR_WARNING_THRESHOLD && count <= this.CHAR_LIMIT;

    if (charCountContainer) {
      charCountContainer.classList.remove('char-count-warning', 'char-count-error');
      if (isOverLimit) charCountContainer.classList.add('char-count-error');
      else if (isNearLimit) charCountContainer.classList.add('char-count-warning');
    }

    if (textarea) {
      textarea.classList.remove('textarea-warning', 'textarea-error');
      if (isOverLimit) textarea.classList.add('textarea-error');
      else if (isNearLimit) textarea.classList.add('textarea-warning');
    }

    if (submitBtn) {
      submitBtn.disabled = isOverLimit;
      submitBtn.title = isOverLimit
        ? 'Custom instructions exceed 5,000 character limit'
        : 'Start Analysis (Cmd/Ctrl+Enter)';
    }
  }

  // --- Council CRUD ---

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
        if (window.toast) window.toast.showError('Failed to save council');
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

    const dialog = window.textInputDialog;
    if (!dialog) return;
    const currentCouncil = this.selectedCouncilId
      ? this.councils.find(c => c.id === this.selectedCouncilId)
      : null;
    let name;
    while (true) {
      name = await dialog.show({
        title: 'Save Council As',
        label: 'Council name',
        placeholder: 'Enter a name for this council',
        value: name || currentCouncil?.name || '',
        confirmText: 'Save',
        confirmClass: 'btn-primary'
      });
      if (!name) return;
      const duplicate = this.councils.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (!duplicate) break;
      if (window.toast) window.toast.showWarning('A council with that name already exists.');
    }
    try {
      await this._postCouncil(name, config);
    } catch (error) {
      console.error('Error saving council:', error);
      if (window.toast) window.toast.showError('Failed to save council');
    }
  }

  async _putCouncil(councilId, config) {
    const response = await fetch(`/api/councils/${councilId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, type: 'council' })
    });
    if (!response.ok) {
      throw new Error(`PUT /api/councils/${councilId} failed: ${response.status}`);
    }
    this._markClean();
    await this.loadCouncils();
  }

  async _postCouncil(name, config) {
    const response = await fetch('/api/councils', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config, type: 'council' })
    });
    if (!response.ok) {
      throw new Error(`POST /api/councils failed: ${response.status}`);
    }
    const data = await response.json();
    this.selectedCouncilId = data.council.id;
    this._markClean();
    await this.loadCouncils();
    const selector = this.modal.querySelector('#vc-council-selector');
    if (selector) {
      selector.value = this.selectedCouncilId;
      selector.classList.remove('new-council-selected');
    }
  }

  async _exportCouncil() {
    const config = this._readConfigFromUI();
    try {
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      if (window.toast) window.toast.showSuccess('Council config copied to clipboard');
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      if (window.toast) window.toast.showError('Failed to copy to clipboard');
    }
  }

  async _deleteCouncil() {
    if (!this.selectedCouncilId) return;

    const council = this.councils.find(c => c.id === this.selectedCouncilId);
    const councilName = council?.name || 'this council';

    const confirmDlg = window.confirmDialog;
    if (!confirmDlg) return;
    const result = await confirmDlg.show({
      title: 'Delete Council',
      message: `Are you sure you want to delete "${councilName}"?`,
      confirmText: 'Delete',
      confirmClass: 'btn-danger'
    });
    if (result !== 'confirm') return;

    try {
      const response = await fetch(`/api/councils/${this.selectedCouncilId}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`DELETE /api/councils/${this.selectedCouncilId} failed: ${response.status}`);
      }

      this.selectedCouncilId = null;
      this._applyConfigToUI(this._defaultConfig());
      this._markClean();
      await this.loadCouncils();

      const selector = this.modal.querySelector('#vc-council-selector');
      if (selector) {
        selector.value = '';
        selector.classList.add('new-council-selected');
      }
      this._updateSaveButtonStates();

      if (window.toast) window.toast.showSuccess('Council deleted');
    } catch (error) {
      console.error('Error deleting council:', error);
      if (window.toast) window.toast.showError('Failed to delete council');
    }
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.VoiceCentricConfigTab = VoiceCentricConfigTab;
}
