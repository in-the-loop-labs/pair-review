// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Advanced (Level-Centric) Council Configuration Tab
 *
 * Provides the "Advanced" tab in the AnalysisConfigModal. An advanced council
 * configuration that enables per-level, multi-voice, multi-provider analysis
 * where each review level can have different participants.
 *
 * This was formerly the only council tab ("Review Council"); the simpler
 * voice-centric tab is now the default "Council" tab.
 */
class AdvancedConfigTab {
  /**
   * What the shared council CRUD (public/js/utils/council-crud.js) needs to
   * speak for THIS tab: the API type literal and this tab's own council
   * `<select>`. Read off the class (not `this`) so the delegations work on any
   * tab-like context.
   */
  static COUNCIL_CRUD_SPEC = { type: 'advanced', selectorId: '#council-selector' };

  /** Info circle SVG icon for section tooltips */
  static INFO_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`;

  /**
   * Build an info-tip toggle button
   * @param {string} id - Unique identifier for aria-controls linkage
   * @returns {string} HTML string
   */
  static buildInfoTipButton(id) {
    return `<button class="info-tip-toggle" aria-controls="info-tip-${id}" aria-expanded="false" title="More info">${AdvancedConfigTab.INFO_ICON_SVG}</button>`;
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

  /** Clock SVG icon for per-voice timeout toggle */
  static CLOCK_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z"/></svg>`;

  /** Default timeout in milliseconds (10 minutes) */
  static DEFAULT_TIMEOUT = 600000;


  /**
   * @param {HTMLElement} modal - The tab's query root (the modal, or any host
   *   element containing exactly one `#tab-panel-advanced`).
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
    // filtered to this tab's own types for the selector; the duplicate-name scan
    // in Save As needs every name, of every type (see council-crud.js).
    this._allCouncils = [];
    this.selectedCouncilId = null;
    this.providers = {};
    this._injected = false;
    this._councilsLoaded = false;

    // Default orchestration provider/model for new councils, updated via
    // setDefaultOrchestration(). Seeded here so _defaultConfig() is coherent
    // even if reset() runs before setDefaultOrchestration().
    this._defaultProvider = 'claude';
    this._defaultModel = 'sonnet';

    // Dirty state tracking
    this._isDirty = false;

    // Host subscription: fired whenever the state that gates saving moves.
    // Set by CouncilManager when it hosts this tab; null everywhere else.
    this.onStateChange = null;

    // Character limit constants for council custom instructions
    this.CHAR_LIMIT = 5000;
    this.CHAR_WARNING_THRESHOLD = 4500;
  }

  /**
   * Inject the advanced council panel into the modal.
   * Called by AnalysisConfigModal after the tab panels are created.
   * @param {HTMLElement} panel - The #tab-panel-advanced element
   */
  inject(panel) {
    if (this._injected) return;
    if (!panel) return;

    panel.innerHTML = this._buildCouncilHTML();
    this._mountTimeoutSelects(panel);
    this._setupCouncilListeners(panel);
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
   * Load saved councils from the API, filtering the SELECTOR to advanced and
   * legacy-untyped rows.
   *
   * That filter is asymmetric with `VoiceCentricConfigTab.loadCouncils`, which
   * takes `c.type === 'council'` only, and the asymmetry is load-bearing:
   * untyped rows predate the `type` column and are level-centric, so THIS tab
   * is the only one that can render them. Tighten this to
   * `c.type === 'advanced'` and every legacy council disappears from both
   * selectors. `CouncilCard`, `CouncilDropdown` and `CouncilManager` all cite
   * this rule. Do not "unify" it.
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
      // Only show advanced (level-centric) councils, or councils with no type (legacy)
      this.councils = all.filter(c => !c.type || c.type === 'advanced');
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
   * Get the current council config for submission
   * @returns {Object} Council config
   */
  getCouncilConfig() {
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
    const panel = this.modal.querySelector('#tab-panel-advanced');
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
    const panel = this.modal.querySelector('#tab-panel-advanced');
    if (!panel) return;

    const textarea = panel.querySelector('#council-custom-instructions');
    if (textarea) {
      textarea.value = text || '';
      this._updateCouncilCharCount(textarea.value.length);
    }
  }

  /**
   * Set the default provider/model pair used to seed a NEW council.
   * Falls back to 'claude'/'sonnet' if nothing can be resolved.
   *
   * ORDERING: `setProviders()` MUST have run first. The pair is canonicalized
   * against `this.providers`, and with no provider metadata loaded there is
   * nothing to canonicalize against — the arguments are kept as-is. Both
   * existing hosts honour this: AnalysisConfigModal and CouncilManager each
   * call setProviders, then setDefaultOrchestration, then reset().
   *
   * Canonicalization is not cosmetic. Callers hand us the output of
   * `resolveProviderModelPair`, which deliberately PRESERVES a configured alias
   * (`pair-review <pr> --model opus` reaches here as `opus`) and resolves
   * against the raw `/api/providers` array rather than the map this tab renders
   * from. `_defaultConfig()` assigns the pair straight onto `<select>` elements
   * whose options are canonical ids of available providers only, so either half
   * can select nothing — and an empty select makes `_readConfigFromUI` drop the
   * reviewer row, which POSTs an enabled level with no voices and 400s. See
   * `resolveDefaultOrchestration` in public/js/utils/provider-map.js.
   *
   * `window.ProviderMap` is resolved at CALL time, never at module-eval time
   * (this codebase's rule — see public/js/utils/council-export.js), and its
   * absence degrades to the previous behavior instead of throwing.
   *
   * @param {string|null} provider - Desired provider ID (may be unavailable)
   * @param {string|null} model - Desired model ID (may be an alias, e.g. 'opus')
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
   * Set the default council ID to pre-select when councils load.
   * Stores the ID as pending; it will be applied in _renderCouncilSelector().
   * @param {string} councilId - Council ID to pre-select
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
    const selector = this.modal.querySelector('#council-selector');
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

  /**
   * Validate council config: at least one level enabled, and every enabled
   * level carrying at least one reviewer.
   *
   * Mirrors `validateAdvancedFormat` in src/councils/council-validation.js,
   * which is what the API applies — its
   * `levels.${key}.voices must be a non-empty array when enabled` was reachable
   * from a panel this validator called valid. A reviewer row survives
   * `_readConfigFromUI` only `if (provider && model)`, so a row whose provider
   * or model `<select>` is empty (the state a saved council lands in when its
   * provider is no longer available) leaves an enabled level with `voices: []`.
   * The check runs on every keystroke via `_updateSaveButtonStates`, so it stays
   * O(3) over the argument and never touches the DOM.
   *
   * @param {Object} config - Council config to validate
   * @returns {{ valid: boolean, error: string|null }}
   */
  _validateConfig(config) {
    const levels = config?.levels || {};
    const hasEnabledLevel = Object.values(levels).some(l => l?.enabled);
    if (!hasEnabledLevel) {
      return { valid: false, error: 'At least one review level must be enabled.' };
    }
    for (const [key, level] of Object.entries(levels)) {
      if (level?.enabled && (level.voices || []).length === 0) {
        return {
          valid: false,
          error: `Level ${key} needs at least one reviewer with both a provider and a model selected.`
        };
      }
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
   *
   * Editing a file council and then hitting Analyze deliberately forks a
   * timestamped DB copy here rather than writing back: file councils are
   * read-only, and the config that actually ran has to be persisted. The fork
   * is lazy — a clean file council returns early on the guard below and keeps
   * its `file:` attribution, so tweaks that are abandoned without analyzing
   * leave no junk rows behind.
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
        const baseName = (existing?.name || 'Advanced').replace(/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/, '').trim();
        name = `${baseName} ${timestamp}`;
      } else {
        // 'Advanced' is the persisted `type` column literal for this tab, so the
        // name stays meaningful if the badge wording ever changes. Only reachable
        // with NO council selected; otherwise the branch above takes
        // `existing.name` (and only falls back here when the selected id is
        // missing from `this.councils`, i.e. after a failed loadCouncils).
        name = `Advanced ${timestamp}`;
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

  /**
   * Mount all TimeoutSelect instances on the panel.
   * Called after HTML is injected into the DOM.
   * @param {HTMLElement} panel
   */
  _mountTimeoutSelects(panel) {
    // Orchestration timeout (mounted first so its mount-point is removed from the DOM)
    const orchMount = panel.querySelector('#adv-orchestration-timeout-mount');
    if (orchMount) {
      TimeoutSelect.mount(orchMount, {
        className: 'adv-timeout',
        id: 'adv-orchestration-timeout',
        title: 'Orchestration timeout',
      });
    }

    // Per-reviewer timeouts (any that exist from default config).
    // The orchestration mount is already removed above, so no exclusion needed.
    panel.querySelectorAll('.adv-timeout-mount').forEach(mount => {
      TimeoutSelect.mount(mount, {
        className: 'adv-timeout',
        title: 'Per-reviewer timeout',
      });
    });
  }

  _defaultConfig() {
    const provider = this._defaultProvider || 'claude';
    const model = this._defaultModel || 'sonnet';
    const timeout = this._getProviderDefaultTimeout(provider);
    // Seed one reviewer voice per enabled level. The server validator rejects an
    // enabled level with an empty voices array (councils.js: "voices must be a
    // non-empty array when enabled"), and _applyConfigToUI() wipes a level's row
    // list when voices is empty — so an empty default would leave every level
    // enabled with zero reviewer rows and fail at analysis kickoff. A fresh voice
    // object per level avoids shared-reference aliasing.
    const seedVoice = () => ({ provider, model, tier: 'balanced', timeout });
    return {
      levels: {
        '1': { enabled: true, voices: [seedVoice()] },
        '2': { enabled: true, voices: [seedVoice()] },
        '3': { enabled: true, voices: [seedVoice()] }
      },
      consolidation: { provider, model, tier: 'balanced', timeout }
    };
  }

  /**
   * The tab's OWN write controls: Save, Save As, Export, Delete.
   *
   * Omitted entirely when the tab is hosted (see the constructor). Save, Save As
   * and Delete each write to the server, and a host that cannot see those writes
   * cannot know its list went stale; the settings-page manager therefore owns
   * Save in its own footer and offers Delete per row. Export is dropped with
   * them because it is part of this control row and the host offers its own —
   * it writes no server state either way.
   *
   * @returns {string} HTML string
   */
  static buildCouncilActionsHTML() {
    return `
      <button class="btn btn-sm btn-save-council" id="council-save-btn" title="Save" disabled>Save</button>
      <button class="btn btn-sm btn-secondary" id="council-save-as-btn" title="Save As" disabled>Save As</button>
      <button class="btn btn-sm btn-secondary" id="council-export-btn" title="Download as a .council.json document">Export</button>
      <button class="btn btn-sm btn-icon-danger" id="council-delete-btn" title="Delete council" disabled>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 011.492.149l-.66 6.6A1.748 1.748 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 111.492-.15z"/>
        </svg>
      </button>
    `;
  }

  _buildCouncilHTML() {
    return `
      <section class="config-section">
        <h4 class="section-title">Council ${AdvancedConfigTab.buildInfoTipButton('council')}</h4>
        ${AdvancedConfigTab.buildInfoTipContent('council', 'An advanced council configuration that runs your code review through multiple AI models in parallel at each review level, then consolidates their findings. Different models catch different issues, giving you broader coverage than a single reviewer.')}
        <div class="council-selector-row">
          <select id="council-selector" class="council-select new-council-selected">
            <option value="" class="council-option-new">+ New Council</option>
          </select>
          ${this._hosted ? '' : AdvancedConfigTab.buildCouncilActionsHTML()}
        </div>
      </section>

      ${this._buildLevelSection(1, 'Changes in Isolation', true)}
      ${this._buildLevelSection(2, 'File Context', true)}
      ${this._buildLevelSection(3, 'Codebase Context', true)}

      <section class="config-section">
        <h4 class="section-title">Consolidation ${AdvancedConfigTab.buildInfoTipButton('orchestration')}</h4>
        ${AdvancedConfigTab.buildInfoTipContent('orchestration', 'The consolidation model merges findings from all reviewers into a single coherent review.')}
        <p class="section-hint-text">Model used for consolidation passes</p>
        <div class="participant-wrapper consolidation-wrapper" id="adv-orchestration-card">
          <div class="participant-card">
            <div class="voice-row" id="orchestration-voice">
              <select class="voice-provider" data-target="orchestration"></select>
              <select class="voice-model" data-target="orchestration"></select>
              <select class="voice-tier" data-target="orchestration">
                <option value="fast">Fast</option>
                <option value="balanced" selected>Balanced</option>
                <option value="thorough">Thorough</option>
              </select>
              <span class="adv-timeout-mount" id="adv-orchestration-timeout-mount"></span>
              <button class="toggle-timeout-icon" id="adv-orchestration-timeout-toggle" title="Orchestration timeout">${AdvancedConfigTab.CLOCK_SVG}</button>
              <button class="toggle-instructions-icon" id="adv-orchestration-instructions-toggle" title="Orchestration instructions">${AdvancedConfigTab.SPEECH_BUBBLE_SVG}</button>
            </div>
            <div class="voice-instructions-area" id="adv-orchestration-instructions-area" style="display:none">
              <textarea class="voice-instructions-input" id="adv-orchestration-instructions" placeholder="Orchestration instructions (e.g., Prefer security findings over style nits)" rows="2"></textarea>
            </div>
          </div>
          <div class="remove-voice-btn-spacer"></div>
        </div>
      </section>

      ${this._hosted ? '' : this._buildInstructionsHTML()}
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
          ${AdvancedConfigTab.buildInfoTipButton('level-' + level)}
        </h4>
        ${AdvancedConfigTab.buildInfoTipContent('level-' + level, levelTips[level])}
        <div class="level-voices" id="level-${level}-voices" ${!enabledByDefault ? 'style="display:none"' : ''}>
          <div class="voice-list" id="level-${level}-voice-list">
            ${enabledByDefault ? this._buildVoiceRowHTML(level, 0) : ''}
          </div>
          <button class="btn btn-sm btn-icon add-voice-btn" data-level="${level}" title="Add Reviewer">+</button>
        </div>
      </section>
    `;
  }

  /**
   * Build a single participant row with card container layout.
   * Includes a clock icon that toggles an inline timeout dropdown.
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
            <span class="adv-timeout-mount" data-level="${level}" data-index="${index}"></span>
            <button class="toggle-timeout-icon" data-level="${level}" data-index="${index}" title="Per-reviewer timeout">${AdvancedConfigTab.CLOCK_SVG}</button>
            <button class="toggle-instructions-icon" data-level="${level}" data-index="${index}" title="Per-reviewer instructions">${AdvancedConfigTab.SPEECH_BUBBLE_SVG}</button>
          </div>
          <div class="voice-instructions-area" data-level="${level}" data-index="${index}" style="display:none">
            <textarea class="voice-instructions-input" data-level="${level}" data-index="${index}" placeholder="Per-reviewer instructions (e.g., Focus on security)" rows="2"></textarea>
          </div>
        </div>
        <button class="btn btn-sm btn-icon remove-voice-btn" data-level="${level}" data-index="${index}" title="Remove Reviewer">&minus;</button>
      </div>
    `;
  }

  /**
   * Build the Custom Instructions + Repo Instructions section for council tab:
   * the per-review block below the "This Review" divider.
   *
   * Not rendered when the tab is hosted (see the constructor). Everything here
   * belongs to one analysis run, not to the council: `_readConfigFromUI()`
   * returns only `{ levels, consolidation }` and never reads
   * `#council-custom-instructions`, and the textarea carries `data-no-dirty` so
   * typing in it does not even mark the tab dirty. On a page with no review the
   * whole block is a promise the save cannot keep.
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
          ${AdvancedConfigTab.buildInfoTipButton('custom-instructions')}
        </h4>
        ${AdvancedConfigTab.buildInfoTipContent('custom-instructions', 'Free-form guidance sent to every reviewer in this review. Use this to focus the review on what matters most &mdash; e.g., "Pay extra attention to error handling" or "This is a security-critical change."')}
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

  _setupCouncilListeners(panel) {
    // Council selector
    panel.querySelector('#council-selector')?.addEventListener('change', (e) => {
      this.selectedCouncilId = e.target.value || null;
      e.target.classList.toggle('new-council-selected', !this.selectedCouncilId);
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

    // Delete button
    panel.querySelector('#council-delete-btn')?.addEventListener('click', () => this._deleteCouncil());

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

    // Delegate remove voice, toggle instructions icon, and toggle timeout icon
    panel.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.remove-voice-btn');
      if (removeBtn) {
        this._removeVoice(removeBtn.dataset.level, removeBtn.dataset.index);
      }

      const toggleBtn = e.target.closest('.toggle-instructions-icon');
      if (toggleBtn) {
        // Orchestration instructions toggle (no data-level)
        if (toggleBtn.id === 'adv-orchestration-instructions-toggle') {
          const area = panel.querySelector('#adv-orchestration-instructions-area');
          if (area) {
            const isHidden = area.style.display === 'none';
            area.style.display = isHidden ? '' : 'none';
            if (isHidden) {
              const textarea = area.querySelector('#adv-orchestration-instructions');
              if (textarea) textarea.focus();
            }
          }
        } else {
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
      }

      // Toggle timeout dropdown via clock icon
      const clockBtn = e.target.closest('.toggle-timeout-icon');
      if (clockBtn) {
        // Orchestration timeout toggle (no data-level)
        if (clockBtn.id === 'adv-orchestration-timeout-toggle') {
          const timeoutEl = panel.querySelector('#adv-orchestration-timeout');
          if (timeoutEl) {
            const isHidden = timeoutEl.style.display === 'none';
            timeoutEl.style.display = isHidden ? '' : 'none';
          }
        } else {
          const { level, index } = clockBtn.dataset;
          const wrapper = panel.querySelector(`.participant-wrapper[data-level="${level}"][data-index="${index}"]`);
          const timeoutEl = wrapper?.querySelector(`.adv-timeout[data-level="${level}"][data-index="${index}"]`);
          if (timeoutEl) {
            const isHidden = timeoutEl.style.display === 'none';
            timeoutEl.style.display = isHidden ? '' : 'none';
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
        // Orchestration instructions textarea
        if (e.target.id === 'adv-orchestration-instructions') {
          this._updateOrchestrationInstructionsIcon(panel, e.target.value);
        } else {
          const { level, index } = e.target.dataset;
          this._updateInstructionsIcon(panel, level, index, e.target.value);
        }
      }
    });

    // Provider change -> update model dropdowns + timeout default
    panel.addEventListener('change', (e) => {
      if (e.target.classList.contains('voice-provider')) {
        this._updateModelDropdown(e.target);
        this._applyProviderDefaultTimeout(e.target);
      }
      // Model change -> update tier to match model's recommended tier
      if (e.target.classList.contains('voice-model')) {
        this._syncTierToModel(e.target);
      }
      // Timeout change -> update clock icon styling
      if (e.target.classList.contains('adv-timeout')) {
        // Orchestration timeout (no data-level)
        if (e.target.id === 'adv-orchestration-timeout') {
          this._updateOrchestrationTimeoutIcon(panel, e.target.value);
        } else {
          const { level, index } = e.target.dataset;
          this._updateTimeoutIcon(panel, level, index, e.target.value);
        }
      }
    });

    // Dirty state tracking via event delegation
    panel.addEventListener('change', (e) => {
      if (e.target.id === 'council-selector') return; // council selector has its own clean/dirty logic
      if (e.target.matches('select, input[type="checkbox"]') || e.target.classList.contains('adv-timeout')) {
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
    const selector = this.modal.querySelector('#council-selector');
    if (!selector) return;

    const currentValue = selector.value;
    selector.innerHTML = '<option value="" class="council-option-new">+ New Council</option>';
    for (const council of this.councils) {
      const opt = document.createElement('option');
      opt.value = council.id;
      opt.textContent = this._isFileCouncil(council.id) ? `${council.name} (file)` : council.name;
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
        selector.classList.remove('new-council-selected');
        this._applyConfigToUI(council.config);
        this._markClean();
        return;
      }
    }

    if (currentValue) selector.value = currentValue;
    selector.classList.toggle('new-council-selected', !selector.value);
  }

  _updateAllVoiceDropdowns() {
    const panel = this.modal.querySelector('#tab-panel-advanced');
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

    // Find sibling model select
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

    // Mount the TimeoutSelect for the new voice
    const mount = voiceList.querySelector(`.adv-timeout-mount[data-level="${level}"][data-index="${index}"]`);
    if (mount) {
      TimeoutSelect.mount(mount, { className: 'adv-timeout', title: 'Per-reviewer timeout' });
    }

    // Populate the new provider dropdown
    const newProviderSelect = voiceList.querySelector(`.voice-provider[data-level="${level}"][data-index="${index}"]`);
    if (newProviderSelect) {
      this._populateProviderDropdown(newProviderSelect);
      this._applyProviderDefaultTimeout(newProviderSelect);
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
      ? AdvancedConfigTab.SPEECH_BUBBLE_SVG_SOLID
      : AdvancedConfigTab.SPEECH_BUBBLE_SVG;
    iconBtn.classList.toggle('has-instructions', hasContent);
  }

  /**
   * Get the default timeout for a provider, falling back to the static DEFAULT_TIMEOUT.
   * @param {string} providerId - Provider ID (e.g., 'pi', 'claude')
   * @returns {number} Default timeout in ms
   */
  _getProviderDefaultTimeout(providerId) {
    const provider = this.providers[providerId];
    return provider?.defaultTimeout ?? AdvancedConfigTab.DEFAULT_TIMEOUT;
  }

  /**
   * Update the clock/timeout icon styling to indicate non-default timeout.
   * @param {Element} panel - The council panel element
   * @param {string} level - Level number
   * @param {string} index - Voice index
   * @param {string} value - Current timeout value (as string of ms)
   */
  _updateTimeoutIcon(panel, level, index, value) {
    const wrapper = panel.querySelector(`.participant-wrapper[data-level="${level}"][data-index="${index}"]`);
    const iconBtn = wrapper?.querySelector(`.toggle-timeout-icon[data-level="${level}"][data-index="${index}"]`);
    if (!iconBtn) return;

    const providerId = wrapper?.querySelector('.voice-provider')?.value;
    const defaultTimeout = this._getProviderDefaultTimeout(providerId);
    const isNonDefault = parseInt(value, 10) !== defaultTimeout;
    iconBtn.classList.toggle('has-custom-timeout', isNonDefault);
  }

  _updateOrchestrationTimeoutIcon(panel, value) {
    const iconBtn = panel.querySelector('#adv-orchestration-timeout-toggle');
    if (!iconBtn) return;

    const orchRow = panel.querySelector('#orchestration-voice');
    const providerId = orchRow?.querySelector('.voice-provider')?.value;
    const defaultTimeout = this._getProviderDefaultTimeout(providerId);
    const isNonDefault = parseInt(value, 10) !== defaultTimeout;
    iconBtn.classList.toggle('has-custom-timeout', isNonDefault);
  }

  _updateOrchestrationInstructionsIcon(panel, value) {
    const iconBtn = panel.querySelector('#adv-orchestration-instructions-toggle');
    if (!iconBtn) return;

    const hasContent = value.trim().length > 0;
    iconBtn.innerHTML = hasContent
      ? AdvancedConfigTab.SPEECH_BUBBLE_SVG_SOLID
      : AdvancedConfigTab.SPEECH_BUBBLE_SVG;
    iconBtn.classList.toggle('has-instructions', hasContent);
  }

  /**
   * When a voice's provider changes, update its timeout to the new provider's default,
   * preserving explicit user overrides via Math.max when the user had customized the value.
   * @param {HTMLSelectElement} providerSelect - The provider dropdown that changed
   */
  _applyProviderDefaultTimeout(providerSelect) {
    const panel = this.modal.querySelector('#tab-panel-advanced');
    if (!panel) return;

    const providerId = providerSelect.value;
    const newDefault = this._getProviderDefaultTimeout(providerId);
    const oldProviderId = providerSelect.dataset.previousProvider;
    const oldDefault = oldProviderId ? this._getProviderDefaultTimeout(oldProviderId) : null;

    const isOrchestration = providerSelect.dataset.target === 'orchestration';
    if (isOrchestration) {
      const timeoutEl = panel.querySelector('#adv-orchestration-timeout');
      if (timeoutEl) {
        const currentValue = parseInt(timeoutEl.value, 10);
        const resolvedTimeout = (oldDefault !== null && currentValue !== oldDefault)
          ? Math.max(currentValue, newDefault)
          : newDefault;
        timeoutEl.value = String(resolvedTimeout);
        this._updateOrchestrationTimeoutIcon(panel, String(resolvedTimeout));
      }
    } else {
      const { level, index } = providerSelect.dataset;
      const wrapper = providerSelect.closest('.participant-wrapper');
      const timeoutEl = wrapper?.querySelector('.adv-timeout');
      if (timeoutEl) {
        const currentValue = parseInt(timeoutEl.value, 10);
        const resolvedTimeout = (oldDefault !== null && currentValue !== oldDefault)
          ? Math.max(currentValue, newDefault)
          : newDefault;
        timeoutEl.value = String(resolvedTimeout);
        this._updateTimeoutIcon(panel, level, index, String(resolvedTimeout));
      }
    }

    providerSelect.dataset.previousProvider = providerId;
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
    // The hosted editor (CouncilManager) renders the footer that replaces this
    // tab's own write row, and its Save has to follow the same state this
    // method gates on — dirty, and which council is selected. Every transition
    // funnels through here (_markDirty, _markClean, the selector's change
    // handler), so this is the one place a host can subscribe to and see all of
    // them. No-op when nothing subscribed.
    if (typeof this.onStateChange === 'function') this.onStateChange();

    const panel = this.modal.querySelector('#tab-panel-advanced');
    if (!panel) return;

    const saveBtn = panel.querySelector('#council-save-btn');
    const saveAsBtn = panel.querySelector('#council-save-as-btn');
    const exportBtn = panel.querySelector('#council-export-btn');
    const deleteBtn = panel.querySelector('#council-delete-btn');

    // File councils are read-only: no in-place save, no delete. Save As stays
    // enabled — it POSTs a copy, which is the duplicate-to-my-councils flow.
    const isFile = this._isFileCouncil(this.selectedCouncilId);

    if (saveBtn) {
      saveBtn.disabled = !this._isDirty || !this.selectedCouncilId || isFile;
    }
    // Reuse _validateConfig to keep enablement in sync with actual save
    // validation. Export shares the check: an invalid config can be neither
    // saved nor exported (the exported document would not read back).
    if (saveAsBtn || exportBtn) {
      const config = this._readConfigFromUI();
      const { valid } = this._validateConfig(config);
      if (saveAsBtn) saveAsBtn.disabled = !valid;
      if (exportBtn) exportBtn.disabled = !valid;
    }
    if (deleteBtn) {
      // Delete is only available when viewing a saved, non-file council
      deleteBtn.disabled = !this.selectedCouncilId || isFile;
    }

    // Toggle the "unsaved changes" hint in the modal footer
    this._updateDirtyHint();
  }

  /**
   * Toggle the "unsaved changes" hint + save button container in the modal footer.
   * Visible only when council tab is active AND config is dirty.
   */
  _updateDirtyHint() {
    const container = this.modal.querySelector('#council-footer-left');
    if (!container) return;
    container.style.display = this._isDirty ? '' : 'none';
  }

  /**
   * Update council custom instructions character count
   * @param {number} count - Current character count
   */
  _updateCouncilCharCount(count) {
    const panel = this.modal.querySelector('#tab-panel-advanced');
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

    if (submitBtn) {
      submitBtn.disabled = isOverLimit;
      if (isOverLimit) {
        submitBtn.title = 'Custom instructions exceed 5,000 character limit';
      } else {
        submitBtn.title = 'Start Analysis (Cmd/Ctrl+Enter)';
      }
    }
  }

  _readConfigFromUI() {
    const panel = this.modal.querySelector('#tab-panel-advanced');
    if (!panel) return this._defaultConfig();

    const config = { levels: {}, consolidation: {} };

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
          const timeoutSelect = row?.querySelector('.adv-timeout');
          const timeout = timeoutSelect ? parseInt(timeoutSelect.value, 10) : AdvancedConfigTab.DEFAULT_TIMEOUT;
          const idx = wrapper.dataset.index;
          const instructionsArea = wrapper.querySelector(`.voice-instructions-input[data-level="${level}"][data-index="${idx}"]`);
          const customInstructions = instructionsArea?.value?.trim() || undefined;

          if (provider && model) {
            const voice = { provider, model, tier, timeout };
            if (customInstructions) voice.customInstructions = customInstructions;
            voices.push(voice);
          }
        });
      }

      config.levels[String(level)] = { enabled, voices };
    }

    // Orchestration
    const orchRow = panel.querySelector('#orchestration-voice');
    const orchTimeoutSelect = panel.querySelector('#adv-orchestration-timeout');
    const orchInstrInput = panel.querySelector('#adv-orchestration-instructions');
    const orchTimeout = orchTimeoutSelect ? parseInt(orchTimeoutSelect.value, 10) : AdvancedConfigTab.DEFAULT_TIMEOUT;
    const orchCustomInstructions = orchInstrInput?.value?.trim() || undefined;
    if (orchRow) {
      config.consolidation = {
        provider: orchRow.querySelector('.voice-provider')?.value || 'claude',
        model: orchRow.querySelector('.voice-model')?.value || 'sonnet',
        tier: orchRow.querySelector('.voice-tier')?.value || 'balanced',
        timeout: orchTimeout,
        ...(orchCustomInstructions ? { customInstructions: orchCustomInstructions } : {})
      };
    }

    return config;
  }

  _applyConfigToUI(config) {
    const panel = this.modal.querySelector('#tab-panel-advanced');
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
            providerSelect.dataset.previousProvider = voice.provider;
            this._updateModelDropdown(providerSelect);
            const modelSelect = row.querySelector('.voice-model');
            this._applyModelSelection(modelSelect, voice.provider, voice.model);
            const tierSelect = row.querySelector('.voice-tier');
            if (tierSelect) tierSelect.value = voice.tier || 'balanced';
          }

          // Mount and restore timeout value
          const mount = row?.querySelector(`.adv-timeout-mount[data-level="${level}"][data-index="${i}"]`);
          if (mount) {
            TimeoutSelect.mount(mount, { className: 'adv-timeout', title: 'Per-reviewer timeout' });
          }
          const timeoutEl = row?.querySelector('.adv-timeout');
          const providerDefaultTimeout = this._getProviderDefaultTimeout(voice.provider);
          if (timeoutEl && voice.timeout) {
            timeoutEl.value = String(voice.timeout);
            // Show the dropdown if non-default for this provider
            if (voice.timeout !== providerDefaultTimeout) {
              timeoutEl.style.display = '';
            }
            this._updateTimeoutIcon(panel, String(level), String(i), String(voice.timeout));
          } else if (timeoutEl) {
            // No saved timeout — apply the provider's default
            timeoutEl.value = String(providerDefaultTimeout);
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

    // Consolidation (read from 'consolidation' key, fall back to legacy 'orchestration')
    const consolSection = config.consolidation || config.orchestration;
    if (consolSection) {
      const orchRow = panel.querySelector('#orchestration-voice');
      if (orchRow) {
        const providerSelect = orchRow.querySelector('.voice-provider');
        if (providerSelect) {
          this._populateProviderDropdown(providerSelect);
          providerSelect.value = consolSection.provider;
          providerSelect.dataset.previousProvider = consolSection.provider;
          this._updateModelDropdown(providerSelect);
          const modelSelect = orchRow.querySelector('.voice-model');
          this._applyModelSelection(modelSelect, consolSection.provider, consolSection.model);
          const tierSelect = orchRow.querySelector('.voice-tier');
          if (tierSelect) tierSelect.value = consolSection.tier || 'balanced';
        }
      }

      // Restore consolidation timeout
      const orchTimeoutSelect = panel.querySelector('#adv-orchestration-timeout');
      const orchProviderDefaultTimeout = this._getProviderDefaultTimeout(consolSection.provider);
      if (orchTimeoutSelect && consolSection.timeout) {
        orchTimeoutSelect.value = String(consolSection.timeout);
        // Show the dropdown if non-default for this provider
        if (consolSection.timeout !== orchProviderDefaultTimeout) {
          orchTimeoutSelect.style.display = '';
        }
        this._updateOrchestrationTimeoutIcon(panel, String(consolSection.timeout));
      } else if (orchTimeoutSelect) {
        // No saved timeout — apply the provider's default
        orchTimeoutSelect.value = String(orchProviderDefaultTimeout);
        this._updateOrchestrationTimeoutIcon(panel, String(orchProviderDefaultTimeout));
      }

      // Restore consolidation custom instructions
      const orchInstrInput = panel.querySelector('#adv-orchestration-instructions');
      const orchInstrArea = panel.querySelector('#adv-orchestration-instructions-area');
      if (consolSection.customInstructions) {
        if (orchInstrInput) orchInstrInput.value = consolSection.customInstructions;
        if (orchInstrArea) orchInstrArea.style.display = '';
        this._updateOrchestrationInstructionsIcon(panel, consolSection.customInstructions);
      } else {
        if (orchInstrInput) orchInstrInput.value = '';
        if (orchInstrArea) orchInstrArea.style.display = 'none';
        this._updateOrchestrationInstructionsIcon(panel, '');
      }
    }
  }

  /**
   * Save the live config over the selected council, forking a copy when the
   * selection is a read-only file council or when nothing is selected.
   *
   * The whole body is shared with VoiceCentricConfigTab — only the type literal
   * and the selector id differ. See `saveCouncil` in
   * public/js/utils/council-crud.js.
   *
   * @returns {Promise<boolean>} true iff a council was written. Never rejects.
   */
  async _saveCouncil() {
    return window.CouncilCrud.saveCouncil(this, AdvancedConfigTab.COUNCIL_CRUD_SPEC);
  }

  /**
   * Prompt for a name and POST the live config as a new council.
   * @returns {Promise<boolean>} true iff a council was created. Never rejects.
   */
  async _saveCouncilAs() {
    return window.CouncilCrud.saveCouncilAs(this, AdvancedConfigTab.COUNCIL_CRUD_SPEC);
  }

  /**
   * PUT (update) an existing council by ID.
   * Handles fetch, response check, markClean, and selector refresh.
   * @param {string} councilId - The council ID to update
   * @param {Object} config - The council configuration to save
   */
  async _putCouncil(councilId, config) {
    return window.CouncilCrud.putCouncil(this, AdvancedConfigTab.COUNCIL_CRUD_SPEC, councilId, config);
  }

  /**
   * POST (create) a new council with the given name.
   * Handles fetch, response check, markClean, selector refresh, and selection update.
   * @param {string} name - The name for the new council
   * @param {Object} config - The council configuration to save
   */
  async _postCouncil(name, config) {
    return window.CouncilCrud.postCouncil(this, AdvancedConfigTab.COUNCIL_CRUD_SPEC, name, config);
  }

  /**
   * Export the council as a versioned council document: downloads
   * `<slug>.council.json` and, best-effort, copies the same JSON to the
   * clipboard.
   *
   * The whole body is shared with VoiceCentricConfigTab — only the type literal
   * differs. See `exportCouncilFromTab` in public/js/utils/council-export.js for
   * the validity gate and the deliberate live-config / selected-name identity.
   */
  async _exportCouncil() {
    return window.CouncilExport.exportCouncilFromTab(this, 'advanced');
  }

  /** Confirm and DELETE the selected council, then reset to "+ New Council". */
  async _deleteCouncil() {
    return window.CouncilCrud.deleteCouncil(this, AdvancedConfigTab.COUNCIL_CRUD_SPEC);
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.AdvancedConfigTab = AdvancedConfigTab;
}

// Export for unit testing (Node/CommonJS environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AdvancedConfigTab };
}
