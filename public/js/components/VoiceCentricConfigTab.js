// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Voice-Centric Council Configuration Tab
 *
 * Provides the "Council" tab in the AnalysisConfigModal. This is a simpler
 * alternative to the Advanced (level-centric) tab: reviewers are listed flat,
 * and global level toggles (L1/L2/L3) apply to every reviewer uniformly.
 */
class VoiceCentricConfigTab {
  /**
   * What the shared council CRUD (public/js/utils/council-crud.js) needs to
   * speak for THIS tab: the API type literal and this tab's own council
   * `<select>`. Read off the class (not `this`) so the delegations work on any
   * tab-like context.
   */
  static COUNCIL_CRUD_SPEC = { type: 'council', selectorId: '#vc-council-selector' };

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


  /**
   * @param {HTMLElement} modal - The tab's query root (the modal, or any host
   *   element containing exactly one `#tab-panel-council`).
   * @param {Object} [options]
   * @param {boolean} [options.hosted=false] - True when the tab is embedded in a
   *   host that owns the save affordances and has no review of its own (the
   *   settings-page CouncilManager). A hosted tab renders neither the per-review
   *   "This Review" block — there is no review to attach instructions to, and
   *   `_readConfigFromUI` never reads that textarea, so anything typed there
   *   would be silently discarded — nor its own Save / Save As / Export /
   *   Delete row, so the host's footer is the single write surface.
   */
  constructor(modal, options = {}) {
    this.modal = modal;
    this._hosted = options.hosted === true;
    this.councils = [];
    // The UNFILTERED council list from the last successful load. `councils` is
    // filtered to this tab's own type for the selector; the duplicate-name scan
    // in Save As needs every name, of every type (see council-crud.js).
    this._allCouncils = [];
    this.selectedCouncilId = null;
    this.providers = {};
    this._injected = false;
    this._councilsLoaded = false;

    // Dirty state tracking
    this._isDirty = false;

    // Host subscription: fired whenever the state that gates saving moves.
    // Set by CouncilManager when it hosts this tab; null everywhere else.
    this.onStateChange = null;

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
    this._mountTimeoutSelects(panel);
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
   * Load saved councils from the API, filtering the SELECTOR to
   * `type === 'council'`.
   *
   * That filter is asymmetric with `AdvancedConfigTab.loadCouncils`, which also
   * claims untyped legacy rows (`!c.type || c.type === 'advanced'`), and the
   * asymmetry is load-bearing: legacy rows predate the `type` column and are
   * level-centric, so Advanced is the only tab that can render them.
   * `CouncilCard` and `CouncilDropdown` both cite this rule. Do not "unify" it.
   *
   * The unfiltered response is kept as `_allCouncils` for the duplicate-name
   * scan, which must see every name regardless of type.
   *
   * @returns {Promise<boolean>} true iff the fetch succeeded and the selector
   *   was re-rendered. NEVER rejects — several callers fire and forget.
   */
  async loadCouncils() {
    try {
      const response = await fetch('/api/councils');
      if (!response.ok) throw new Error('Failed to fetch councils');
      const data = await response.json();
      const all = Array.isArray(data.councils) ? data.councils : [];
      this._allCouncils = all;
      // Only show voice-centric councils (legacy councils without a type are level-centric, shown in Advanced tab)
      this.councils = all.filter(c => c.type === 'council');
      this._councilsLoaded = true;
      this._renderCouncilSelector();
      return true;
    } catch (error) {
      console.error('Error loading councils:', error);
      // Both lists are cleared together: a stale name scan is no more trustworthy
      // than a stale selector.
      this.councils = [];
      this._allCouncils = [];
      if (window.toast) {
        window.toast.showError('Failed to load saved councils');
      }
      return false;
    }
  }

  /**
   * Get the current council config for submission.
   * Returns voice-centric format: { voices: [...], levels: { '1': true, ... }, consolidation: {...} }
   * @returns {Object} Council config in voice-centric format
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
    // Voice-centric format: levels values are booleans (true/false)
    const hasEnabledLevel = Object.values(config?.levels || {}).some(l =>
      typeof l === 'boolean' ? l : l?.enabled
    );
    if (!hasEnabledLevel) {
      return { valid: false, error: 'At least one review level must be enabled.' };
    }
    // Validate the ARGUMENT, not the document. This used to count `.vc-reviewer`
    // DOM rows via `_getReviewerCount()`, which is not the same number:
    // `_readConfigFromUI` keeps a reviewer only `if (provider && model)`, so a
    // row whose provider or model <select> is empty — the state a saved council
    // lands in when its provider is no longer available — vanishes from
    // `voices` while still counting as a row. Validation passed, the POST sent
    // `voices: []`, and the server answered
    // 'config.voices must be a non-empty array' (src/councils/council-validation.js).
    // Reading the same object the request will carry is the only way the two
    // can agree.
    if ((config?.voices || []).length === 0) {
      return {
        valid: false,
        error: 'Add at least one reviewer with both a provider and a model selected.'
      };
    }
    return { valid: true, error: null };
  }

  /**
   * Auto-save council if dirty before analysis starts.
   *
   * Editing a file council and then hitting Analyze deliberately forks a
   * timestamped DB copy here rather than writing back: file councils are
   * read-only, and the config that actually ran has to be persisted for
   * history and reuse. The fork is lazy — a clean file council returns early
   * on the guard below and keeps its `file:` attribution, so tweaks that are
   * abandoned without analyzing leave no junk rows behind.
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
        // 'Council' is the persisted `type` column literal for this tab
        // ('council'), not the badge text — CouncilDropdown.typeBadge renders
        // that type as "Standard". Naming after the stored type keeps the name
        // meaningful if the badge is ever reworded. Only reachable with NO
        // council selected; otherwise the branch above takes `existing.name`.
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
   * Set the default provider/model pair used to seed a NEW council.
   *
   * ORDERING: `setProviders()` MUST have run first. The pair is canonicalized
   * against `this.providers`, and with no provider metadata loaded there is
   * nothing to canonicalize against — the arguments are kept as-is (the
   * constructor's claude/sonnet seed still covers empties). Both existing hosts
   * honour this: AnalysisConfigModal and CouncilManager each call setProviders,
   * then setDefaultOrchestration, then reset().
   *
   * Canonicalization is not cosmetic. Callers hand us the output of
   * `resolveProviderModelPair`, which deliberately PRESERVES a configured alias
   * (`pair-review <pr> --model opus` reaches here as `opus`) and resolves
   * against the raw `/api/providers` array rather than the map this tab renders
   * from. `_defaultConfig()` assigns the pair straight onto two `<select>`
   * elements whose options are canonical ids of available providers only, so
   * either half can select nothing — and an empty select makes
   * `_readConfigFromUI` drop the reviewer row, which POSTs `voices: []` and
   * 400s. See `resolveDefaultOrchestration` in public/js/utils/provider-map.js.
   *
   * `window.ProviderMap` is resolved at CALL time, never at module-eval time
   * (this codebase's rule — see public/js/utils/council-export.js), and its
   * absence degrades to the previous behavior instead of throwing.
   *
   * @param {string|null} provider - Desired provider id (may be unavailable)
   * @param {string|null} model - Desired model id (may be an alias)
   */
  setDefaultOrchestration(provider, model) {
    const providerMap = typeof window !== 'undefined' ? window.ProviderMap : null;
    const pair = providerMap?.resolveDefaultOrchestration
      ? providerMap.resolveDefaultOrchestration(this.providers, provider, model)
      : { provider, model };
    this._defaultProvider = pair.provider || 'claude';
    this._defaultModel = pair.model || 'sonnet';
  }

  /**
   * Set the default council ID to pre-select
   */
  setDefaultCouncilId(councilId) {
    this._pendingDefaultCouncilId = councilId;
    // On a cached reopen the councils are already loaded, so loadCouncils() —
    // and the _renderCouncilSelector() call that applies the pending default —
    // will not run again (the modal instance is reused; see AnalysisConfigModal
    // caching on window.analysisConfigModal). Apply it now so the saved/default
    // council is restored instead of being silently dropped onto a blank
    // "+ New Council" selection.
    if (this._councilsLoaded && this._injected) {
      this._renderCouncilSelector();
    }
  }

  /**
   * Reset selection and editor state for a fresh modal open.
   *
   * The AnalysisConfigModal (and therefore this tab) is reused across runs — and
   * in the index/bulk flow, across different repositories. Without this reset a
   * council selected in a previous run (or its pending default / dirty edits)
   * would carry over and could be displayed or submitted for the next batch.
   */
  reset() {
    this.selectedCouncilId = null;
    this._pendingDefaultCouncilId = null;
    this._isDirty = false;
    if (!this._injected) return;
    const selector = this.modal.querySelector('#vc-council-selector');
    if (selector) {
      selector.value = '';
      selector.classList.add('new-council-selected');
    }
    this._applyConfigToUI(this._defaultConfig());
    this._markClean();
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

  /**
   * The tab's OWN write controls: Save, Save As, Export, Delete.
   *
   * Omitted entirely when the tab is hosted (see the constructor). Save and
   * Save As and Delete each write to the server, and a host that cannot see
   * those writes cannot know its list went stale; the settings-page manager
   * therefore owns Save in its own footer and offers Delete per row. Export is
   * dropped with them because it is part of this control row and the host
   * offers its own — it writes no server state either way.
   *
   * @returns {string} HTML string
   */
  static buildCouncilActionsHTML() {
    return `
      <button class="btn btn-sm btn-save-council" id="vc-council-save-btn" title="Save" disabled>Save</button>
      <button class="btn btn-sm btn-secondary" id="vc-council-save-as-btn" title="Save As" disabled>Save As</button>
      <button class="btn btn-sm btn-secondary" id="vc-council-export-btn" title="Download as a .council.json document">Export</button>
      <button class="btn btn-sm btn-icon-danger" id="vc-council-delete-btn" title="Delete council" disabled>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 011.492.149l-.66 6.6A1.748 1.748 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 111.492-.15z"/>
        </svg>
      </button>
    `;
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
          ${this._hosted ? '' : VoiceCentricConfigTab.buildCouncilActionsHTML()}
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
        ${VoiceCentricConfigTab.buildInfoTipContent('consolidation', 'The consolidation model merges findings from all reviewers into a single coherent review.')}
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
            <span class="vc-timeout-mount" id="vc-orchestration-timeout-mount"></span>
            <button class="toggle-timeout-icon" id="vc-orchestration-timeout-toggle" title="Consolidation timeout">${VoiceCentricConfigTab.CLOCK_SVG}</button>
            <button class="toggle-instructions-icon" id="vc-orchestration-instructions-toggle" title="Consolidation instructions">${VoiceCentricConfigTab.SPEECH_BUBBLE_SVG}</button>
          </div>
          <div class="voice-instructions-area" id="vc-orchestration-instructions-area" style="display:none">
            <textarea class="voice-instructions-input" id="vc-orchestration-instructions" placeholder="Consolidation instructions (e.g., Prefer security findings over style nits)" rows="2"></textarea>
          </div>
        </div>
      </section>

      ${this._hosted ? '' : this._buildInstructionsHTML()}
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
            <span class="vc-timeout-mount" data-index="${index}"></span>
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

  /**
   * The per-review block below the "This Review" divider: the repo-instructions
   * banner and the per-analysis Custom Instructions textarea.
   *
   * Not rendered when the tab is hosted (see the constructor). Everything here
   * belongs to one analysis run, not to the council: `_readConfigFromUI()`
   * returns only `{ voices, levels, consolidation }` and never reads
   * `#vc-custom-instructions`, and the textarea carries `data-no-dirty` so
   * typing in it does not even mark the tab dirty. On a page with no review the
   * whole block is a promise the save cannot keep.
   *
   * @returns {string} HTML string
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

    // Provider change -> update model dropdowns + executable state + timeout default
    panel.addEventListener('change', (e) => {
      if (e.target.classList.contains('voice-provider')) {
        this._updateModelDropdown(e.target);
        this._updateExecutableState(e.target);
        this._updateLevelToggleState();
        this._applyProviderDefaultTimeout(e.target);
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
      if (e.target.id === 'vc-council-selector') return; // council selector has its own clean/dirty logic
      if (e.target.matches('select, input[type="checkbox"]') || e.target.classList.contains('vc-timeout')) {
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

  _addReviewer() {
    const list = this.modal.querySelector('#vc-reviewer-list');
    if (!list) return;

    const index = list.querySelectorAll('.vc-reviewer').length;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = this._buildReviewerRowHTML(index);
    while (wrapper.firstChild) {
      list.appendChild(wrapper.firstChild);
    }

    // Mount the TimeoutSelect for the new reviewer
    const mount = list.querySelector(`.vc-timeout-mount[data-index="${index}"]`);
    if (mount) {
      TimeoutSelect.mount(mount, { className: 'vc-timeout', title: 'Per-reviewer timeout' });
    }

    // Populate provider dropdown and update executable state
    const newProviderSelect = list.querySelector(`.voice-provider[data-index="${index}"]`);
    if (newProviderSelect) {
      this._populateProviderDropdown(newProviderSelect);
      this._applyProviderDefaultTimeout(newProviderSelect);
      this._updateExecutableState(newProviderSelect);
    }

    this._updateRemoveButtonVisibility();
    this._updateLevelToggleState();
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
    this._updateLevelToggleState();
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
   * Get the default timeout for a provider, falling back to the static DEFAULT_TIMEOUT.
   * @param {string} providerId - Provider ID (e.g., 'pi', 'claude')
   * @returns {number} Default timeout in ms
   */
  _getProviderDefaultTimeout(providerId) {
    const provider = this.providers[providerId];
    return provider?.defaultTimeout ?? VoiceCentricConfigTab.DEFAULT_TIMEOUT;
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

    const providerId = wrapper?.querySelector('.voice-provider')?.value;
    const defaultTimeout = this._getProviderDefaultTimeout(providerId);
    const isNonDefault = parseInt(value, 10) !== defaultTimeout;
    iconBtn.classList.toggle('has-custom-timeout', isNonDefault);
  }

  _updateOrchestrationTimeoutIcon(panel, value) {
    const iconBtn = panel.querySelector('#vc-orchestration-timeout-toggle');
    if (!iconBtn) return;

    const orchRow = panel.querySelector('#vc-orchestration-voice');
    const providerId = orchRow?.querySelector('.voice-provider')?.value;
    const defaultTimeout = this._getProviderDefaultTimeout(providerId);
    const isNonDefault = parseInt(value, 10) !== defaultTimeout;
    iconBtn.classList.toggle('has-custom-timeout', isNonDefault);
  }

  /**
   * When a voice's provider changes, update its timeout to the new provider's default,
   * preserving explicit user overrides via Math.max when the user had customized the value.
   * @param {HTMLSelectElement} providerSelect - The provider dropdown that changed
   */
  _applyProviderDefaultTimeout(providerSelect) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const providerId = providerSelect.value;
    const newDefault = this._getProviderDefaultTimeout(providerId);
    const oldProviderId = providerSelect.dataset.previousProvider;
    const oldDefault = oldProviderId ? this._getProviderDefaultTimeout(oldProviderId) : null;

    // Determine which timeout element to update
    const isOrchestration = providerSelect.dataset.target === 'orchestration';
    if (isOrchestration) {
      const timeoutEl = panel.querySelector('#vc-orchestration-timeout');
      if (timeoutEl) {
        const currentValue = parseInt(timeoutEl.value, 10);
        const resolvedTimeout = (oldDefault !== null && currentValue !== oldDefault)
          ? Math.max(currentValue, newDefault)
          : newDefault;
        timeoutEl.value = String(resolvedTimeout);
        this._updateOrchestrationTimeoutIcon(panel, String(resolvedTimeout));
      }
    } else {
      const idx = providerSelect.dataset.index;
      const wrapper = providerSelect.closest('.vc-reviewer');
      const timeoutEl = wrapper?.querySelector('.vc-timeout');
      if (timeoutEl) {
        const currentValue = parseInt(timeoutEl.value, 10);
        const resolvedTimeout = (oldDefault !== null && currentValue !== oldDefault)
          ? Math.max(currentValue, newDefault)
          : newDefault;
        timeoutEl.value = String(resolvedTimeout);
        this._updateTimeoutIcon(panel, idx, String(resolvedTimeout));
      }
    }

    providerSelect.dataset.previousProvider = providerId;
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
    const isConsolidation = select.dataset.target === 'orchestration';
    select.innerHTML = '';
    const providerIds = Object.keys(this.providers).filter(id => {
      const p = this.providers[id];
      if (p.availability && !p.availability.available) return false;
      if (isConsolidation && p.capabilities?.consolidation === false) return false;
      return true;
    }).sort((a, b) => (this.providers[a].name || a).localeCompare(this.providers[b].name || b));

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
    const models = [...(provider.models || [])].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
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
   * Assign a STORED model id onto a `<select>` whose options carry canonical
   * ids only, resolving legacy aliases on the way in.
   *
   * A bare `modelSelect.value = voice.model` selects NOTHING when the stored id
   * is an alias — `opus`, `fable`, `opus-4.5`, `gpt-5.4`, `gemini-3.5-flash`,
   * `muse-spark` are all real, and aliases exist precisely so old councils keep
   * resolving. Worse, it runs AFTER `_updateModelDropdown` has already picked a
   * valid default, so the alias overwrites a good value with `""` — and
   * `_readConfigFromUI` keeps a reviewer only `if (provider && model)`, so the
   * row is silently DROPPED from the config the next Save writes.
   *
   * Two rules, in order: resolve the alias through the shared, alias-aware
   * `ProviderMap.findModelWithAliases`, and refuse to assign anything the
   * dropdown does not actually offer — leaving `_updateModelDropdown`'s valid
   * default in place is strictly better than blanking the field.
   *
   * `window.ProviderMap` is resolved at CALL time (this codebase's rule), and
   * its absence degrades to the raw id rather than throwing.
   *
   * @param {HTMLSelectElement|null} modelSelect - The model dropdown to set
   * @param {string} providerId - Provider the stored model belongs to
   * @param {string} modelId - Stored model id (may be an alias)
   */
  _applyModelSelection(modelSelect, providerId, modelId) {
    if (!modelSelect || !modelId) return;
    const providerMap = typeof window !== 'undefined' ? window.ProviderMap : null;
    const canonical = providerMap?.findModelWithAliases
      ? providerMap.findModelWithAliases(this.providers[providerId], modelId)
      : null;
    const resolved = canonical ? canonical.id : modelId;
    if (Array.from(modelSelect.options).some(opt => opt.value === resolved)) {
      modelSelect.value = resolved;
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

  /**
   * Update UI state for a reviewer row based on whether its provider is executable.
   * Hides the tier dropdown and shows a note for executable providers.
   * @param {HTMLSelectElement} providerSelect - The provider dropdown that changed
   */
  _updateExecutableState(providerSelect) {
    const providerId = providerSelect.value;
    const provider = this.providers[providerId];
    const isExecutable = provider?.isExecutable || false;
    const noCustomInstructions = provider?.capabilities?.custom_instructions === false;
    const container = providerSelect.closest('.voice-row');
    if (!container) return;

    const tierSelect = container.querySelector('.voice-tier');
    if (tierSelect) {
      tierSelect.style.display = isExecutable ? 'none' : '';
    }

    // Hide per-reviewer instructions toggle and area when provider doesn't support them
    const idx = providerSelect.dataset?.index;
    const instrToggle = container.querySelector(`.toggle-instructions-icon[data-index="${idx}"]`);
    if (instrToggle) {
      instrToggle.style.display = noCustomInstructions ? 'none' : '';
    }
    const instrArea = container.querySelector(`.voice-instructions-area[data-index="${idx}"]`);
    if (instrArea && noCustomInstructions) {
      instrArea.style.display = 'none';
    }

    // Add or remove the executable note
    let note = container.querySelector('.executable-note');
    if (isExecutable && !note) {
      note = document.createElement('span');
      note.className = 'executable-note';
      note.textContent = 'External tool';
      note.title = 'External tool \u2014 runs its own analysis pipeline';
      container.appendChild(note);
    } else if (!isExecutable && note) {
      note.remove();
    }
  }

  /**
   * Update level toggle state based on whether all voices are executable.
   * If all voices are executable, disable level checkboxes and show a note.
   * If any native voice is present, re-enable.
   */
  _updateLevelToggleState() {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const reviewers = panel.querySelectorAll('.vc-reviewer');
    let allExecutable = reviewers.length > 0;
    reviewers.forEach(wrapper => {
      const providerSelect = wrapper.querySelector('.voice-provider');
      const providerId = providerSelect?.value;
      const provider = this.providers[providerId];
      if (!provider?.isExecutable) {
        allExecutable = false;
      }
    });

    const checkboxes = panel.querySelectorAll('.vc-level-checkbox');
    checkboxes.forEach(cb => {
      cb.disabled = allExecutable;
    });

    // Add or remove the all-executable note
    const togglesContainer = panel.querySelector('.vc-level-toggles');
    if (!togglesContainer) return;
    let note = togglesContainer.querySelector('.vc-levels-disabled-note');
    if (allExecutable && !note) {
      note = document.createElement('p');
      note.className = 'vc-levels-disabled-note section-hint-text';
      note.textContent = 'Level selection does not apply when all reviewers are external tools';
      togglesContainer.appendChild(note);
    } else if (!allExecutable && note) {
      note.remove();
    }
  }

  /**
   * Mount all TimeoutSelect instances on the panel.
   * Called after HTML is injected into the DOM.
   * @param {HTMLElement} panel
   */
  _mountTimeoutSelects(panel) {
    // Orchestration timeout (mounted first so its mount-point is removed from the DOM)
    const orchMount = panel.querySelector('#vc-orchestration-timeout-mount');
    if (orchMount) {
      TimeoutSelect.mount(orchMount, {
        className: 'vc-timeout',
        id: 'vc-orchestration-timeout',
        title: 'Consolidation timeout',
      });
    }

    // Per-reviewer timeouts (any that exist from default config).
    // The orchestration mount is already removed above, so no exclusion needed.
    panel.querySelectorAll('.vc-timeout-mount').forEach(mount => {
      TimeoutSelect.mount(mount, {
        className: 'vc-timeout',
        title: 'Per-reviewer timeout',
      });
    });
  }

  // --- Config read/write ---

  _defaultConfig() {
    const defaultTimeout = this._getProviderDefaultTimeout(this._defaultProvider);
    return {
      voices: [{ provider: this._defaultProvider, model: this._defaultModel, tier: 'balanced', timeout: defaultTimeout }],
      enabledLevels: [1, 2, 3],
      orchestration: { provider: this._defaultProvider, model: this._defaultModel, tier: 'balanced', timeout: defaultTimeout }
    };
  }

  /**
   * Read voice-centric config from UI.
   * Returns the voice-centric API format:
   *   { voices: [...], levels: { '1': true/false, ... }, consolidation: {...} }
   */
  _readConfigFromUI() {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return this._toVoiceCentricAPIFormat(this._defaultConfig());

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
      const providerInfo = this.providers[provider];
      const supportsCustomInstructions = providerInfo?.capabilities?.custom_instructions !== false;
      const customInstructions = supportsCustomInstructions ? (instrInput?.value?.trim() || undefined) : undefined;

      if (provider && model) {
        const voice = { provider, model, tier, timeout };
        if (customInstructions) voice.customInstructions = customInstructions;
        voices.push(voice);
      }
    });

    // Read enabled levels as boolean map
    const levels = {};
    for (const level of [1, 2, 3]) {
      const checkbox = panel.querySelector(`.vc-level-checkbox[data-level="${level}"]`);
      levels[String(level)] = checkbox ? checkbox.checked : false;
    }

    // Read consolidation (orchestration)
    const orchRow = panel.querySelector('#vc-orchestration-voice');
    const orchTimeoutSelect = panel.querySelector('#vc-orchestration-timeout');
    const orchInstrInput = panel.querySelector('#vc-orchestration-instructions');
    const orchTimeout = orchTimeoutSelect ? parseInt(orchTimeoutSelect.value, 10) : VoiceCentricConfigTab.DEFAULT_TIMEOUT;
    const orchCustomInstructions = orchInstrInput?.value?.trim() || undefined;
    const consolidation = orchRow ? {
      provider: orchRow.querySelector('.voice-provider')?.value || 'claude',
      model: orchRow.querySelector('.voice-model')?.value || 'sonnet-4.6',
      tier: orchRow.querySelector('.voice-tier')?.value || 'balanced',
      timeout: orchTimeout,
      ...(orchCustomInstructions ? { customInstructions: orchCustomInstructions } : {})
    } : { provider: 'claude', model: 'sonnet-4.6', tier: 'balanced', timeout: VoiceCentricConfigTab.DEFAULT_TIMEOUT };

    return { voices, levels, consolidation };
  }

  /**
   * Convert internal default config format to voice-centric API format.
   * Internal: { voices, enabledLevels: [1,2,3], orchestration }
   * API:      { voices, levels: { '1': true, ... }, consolidation }
   */
  _toVoiceCentricAPIFormat(vcConfig) {
    const levels = {};
    for (const level of [1, 2, 3]) {
      levels[String(level)] = (vcConfig.enabledLevels || []).includes(level);
    }
    return {
      voices: vcConfig.voices || [],
      levels,
      consolidation: vcConfig.orchestration || {}
    };
  }

  /**
   * Normalize a voice-centric config to internal format for UI rendering.
   * Handles both API format (levels as boolean map, consolidation) and
   * internal format (enabledLevels array, orchestration).
   */
  _normalizeVoiceCentricConfig(config) {
    // If it already has enabledLevels, it's the internal format
    if (Array.isArray(config.enabledLevels)) {
      return config;
    }

    // Convert API format (levels boolean map) to internal format (enabledLevels array)
    const enabledLevels = [];
    if (config.levels && typeof config.levels === 'object') {
      for (const [key, val] of Object.entries(config.levels)) {
        if (val === true) enabledLevels.push(parseInt(key, 10));
      }
    }

    return {
      voices: config.voices || [],
      enabledLevels,
      orchestration: config.consolidation || config.orchestration || {}
    };
  }

  /**
   * Apply config to UI. Accepts either voice-centric format or levels format.
   */
  _applyConfigToUI(config) {
    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    // Detect format and normalize to internal voice-centric format
    // Internal format: { voices, enabledLevels: [1,2,3], orchestration }
    let vcConfig;
    if (config.voices && Array.isArray(config.voices)) {
      // Voice-centric format — may be API format (levels as boolean map, consolidation)
      // or internal format (enabledLevels array, orchestration). Normalize to internal.
      vcConfig = this._normalizeVoiceCentricConfig(config);
    } else if (config.levels) {
      // Level-centric (advanced) format — convert back to voice-centric
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
        voices.push({ provider: this._defaultProvider, model: this._defaultModel, tier: 'balanced', timeout: this._getProviderDefaultTimeout(this._defaultProvider) });
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
          providerSelect.dataset.previousProvider = voice.provider;
          this._updateModelDropdown(providerSelect);
          this._updateExecutableState(providerSelect);
          const modelSelect = row.querySelector('.voice-model');
          this._applyModelSelection(modelSelect, voice.provider, voice.model);
          const tierSelect = row.querySelector('.voice-tier');
          if (tierSelect) tierSelect.value = voice.tier || 'balanced';
          // Mount the TimeoutSelect from its placeholder
          const mount = row.querySelector(`.vc-timeout-mount[data-index="${i}"]`);
          if (mount) {
            TimeoutSelect.mount(mount, { className: 'vc-timeout', title: 'Per-reviewer timeout' });
          }
          const timeoutEl = row.querySelector('.vc-timeout');
          const providerDefaultTimeout = this._getProviderDefaultTimeout(voice.provider);
          if (timeoutEl && voice.timeout) {
            timeoutEl.value = String(voice.timeout);
            // Show the dropdown if non-default for this provider
            if (voice.timeout !== providerDefaultTimeout) {
              timeoutEl.style.display = '';
            }
            this._updateTimeoutIcon(panel, String(i), String(voice.timeout));
          } else if (timeoutEl) {
            // No saved timeout — apply the provider's default
            timeoutEl.value = String(providerDefaultTimeout);
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
      this._updateLevelToggleState();
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
          providerSelect.dataset.previousProvider = vcConfig.orchestration.provider;
          this._updateModelDropdown(providerSelect);
          const modelSelect = orchRow.querySelector('.voice-model');
          this._applyModelSelection(modelSelect, vcConfig.orchestration.provider, vcConfig.orchestration.model);
          const tierSelect = orchRow.querySelector('.voice-tier');
          if (tierSelect) tierSelect.value = vcConfig.orchestration.tier || 'balanced';
        }
      }

      // Restore orchestration timeout
      const orchTimeoutSelect = panel.querySelector('#vc-orchestration-timeout');
      const orchProviderDefaultTimeout = this._getProviderDefaultTimeout(vcConfig.orchestration.provider);
      if (orchTimeoutSelect && vcConfig.orchestration.timeout) {
        orchTimeoutSelect.value = String(vcConfig.orchestration.timeout);
        // Show the dropdown if non-default for this provider
        if (vcConfig.orchestration.timeout !== orchProviderDefaultTimeout) {
          orchTimeoutSelect.style.display = '';
        }
        this._updateOrchestrationTimeoutIcon(panel, String(vcConfig.orchestration.timeout));
      } else if (orchTimeoutSelect) {
        // No saved timeout — apply the provider's default
        orchTimeoutSelect.value = String(orchProviderDefaultTimeout);
        this._updateOrchestrationTimeoutIcon(panel, String(orchProviderDefaultTimeout));
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

  /**
   * Whether a council id belongs to the read-only file overlay
   * (`~/.pair-review/councils/`).
   *
   * Mirrors isFileCouncilId() in src/councils/council-store.js, which is what
   * the API gates PUT/DELETE on. Testing the id (not a joined `source` field)
   * means the check still holds when the council list is empty or stale
   * (loadCouncils() swallows fetch failures by setting this.councils = []).
   *
   * @param {string|null|undefined} councilId
   * @returns {boolean}
   */
  _isFileCouncil(councilId) {
    return typeof councilId === 'string' && councilId.startsWith('file:');
  }

  _renderCouncilSelector() {
    const selector = this.modal.querySelector('#vc-council-selector');
    if (!selector) return;

    const currentValue = selector.value;
    selector.innerHTML = '<option value="" class="council-option-new">+ New Council</option>';
    for (const council of this.councils) {
      const opt = document.createElement('option');
      opt.value = council.id;
      opt.textContent = this._isFileCouncil(council.id) ? `${council.name} (file)` : council.name;
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
    // The hosted editor (CouncilManager) renders the footer that replaces this
    // tab's own write row, and its Save has to follow the same state this
    // method gates on — dirty, and which council is selected. Every transition
    // funnels through here (_markDirty, _markClean, the selector's change
    // handler), so this is the one place a host can subscribe to and see all of
    // them. No-op when nothing subscribed.
    if (typeof this.onStateChange === 'function') this.onStateChange();

    const panel = this.modal.querySelector('#tab-panel-council');
    if (!panel) return;

    const saveBtn = panel.querySelector('#vc-council-save-btn');
    const saveAsBtn = panel.querySelector('#vc-council-save-as-btn');
    const exportBtn = panel.querySelector('#vc-council-export-btn');
    const deleteBtn = panel.querySelector('#vc-council-delete-btn');

    // File councils are read-only: no in-place save, no delete. Save As stays
    // enabled — it POSTs a copy, which is the duplicate-to-my-councils flow.
    const isFile = this._isFileCouncil(this.selectedCouncilId);

    if (saveBtn) {
      saveBtn.disabled = !this._isDirty || !this.selectedCouncilId || isFile;
    }
    // Save As and Export share one validity check: an invalid config can be
    // neither saved nor exported (the exported document would not read back).
    if (saveAsBtn || exportBtn) {
      const config = this._readConfigFromUI();
      const { valid } = this._validateConfig(config);
      if (saveAsBtn) saveAsBtn.disabled = !valid;
      if (exportBtn) exportBtn.disabled = !valid;
    }
    if (deleteBtn) {
      deleteBtn.disabled = !this.selectedCouncilId || isFile;
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

  /**
   * Save the live config over the selected council, forking a copy when the
   * selection is a read-only file council or when nothing is selected.
   *
   * The whole body is shared with AdvancedConfigTab — only the type literal and
   * the selector id differ. See `saveCouncil` in
   * public/js/utils/council-crud.js.
   *
   * @returns {Promise<boolean>} true iff a council was written. Never rejects.
   */
  async _saveCouncil() {
    return window.CouncilCrud.saveCouncil(this, VoiceCentricConfigTab.COUNCIL_CRUD_SPEC);
  }

  /**
   * Prompt for a name and POST the live config as a new council.
   * @returns {Promise<boolean>} true iff a council was created. Never rejects.
   */
  async _saveCouncilAs() {
    return window.CouncilCrud.saveCouncilAs(this, VoiceCentricConfigTab.COUNCIL_CRUD_SPEC);
  }

  /**
   * PUT (update) an existing council by ID.
   * Handles fetch, response check, markClean, and selector refresh.
   * @param {string} councilId - The council ID to update
   * @param {Object} config - The council configuration to save
   */
  async _putCouncil(councilId, config) {
    return window.CouncilCrud.putCouncil(this, VoiceCentricConfigTab.COUNCIL_CRUD_SPEC, councilId, config);
  }

  /**
   * POST (create) a new council with the given name.
   * Handles fetch, response check, markClean, selector refresh, and selection update.
   * @param {string} name - The name for the new council
   * @param {Object} config - The council configuration to save
   */
  async _postCouncil(name, config) {
    return window.CouncilCrud.postCouncil(this, VoiceCentricConfigTab.COUNCIL_CRUD_SPEC, name, config);
  }

  /**
   * Export the council as a versioned council document: downloads
   * `<slug>.council.json` and, best-effort, copies the same JSON to the
   * clipboard.
   *
   * The whole body is shared with AdvancedConfigTab — only the type literal
   * differs. See `exportCouncilFromTab` in public/js/utils/council-export.js for
   * the validity gate and the deliberate live-config / selected-name identity.
   */
  async _exportCouncil() {
    return window.CouncilExport.exportCouncilFromTab(this, 'council');
  }

  /** Confirm and DELETE the selected council, then reset to "+ New Council". */
  async _deleteCouncil() {
    return window.CouncilCrud.deleteCouncil(this, VoiceCentricConfigTab.COUNCIL_CRUD_SPEC);
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.VoiceCentricConfigTab = VoiceCentricConfigTab;
}

// Export for unit testing (Node/CommonJS environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceCentricConfigTab };
}
