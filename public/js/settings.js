// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Global Settings Page JavaScript
 *
 * Renders the effective value + source of every global setting from
 * GET /api/settings, lets the user edit dynamic/advanced settings with an
 * immediate per-setting PUT, and reset in-app overrides with DELETE. Also
 * lists configured/known repositories from GET /api/settings/repos.
 *
 * In-app edits persist to the app database (never to config files); the
 * source badge makes "not explicitly set" (source = default) obvious.
 */

/* global window, document, fetch, localStorage */

// Ordered group sections. Each entry: [groupKey, title, description].
const SETTINGS_GROUPS = [
  ['general', 'General', 'Basic application preferences.'],
  ['ai', 'AI Defaults', 'Default provider and model used for analysis and chat.'],
  ['summaries', 'Summaries', 'Automatic PR summary generation.'],
  ['tours', 'Tours', 'Automatic code tour generation.'],
  ['chat', 'Chat', 'The AI chat assistant.'],
  ['advanced', 'Advanced', 'These are captured at startup — changes take effect after you restart pair-review.'],
  ['readonly', 'From config files & environment', 'Read-only here. Set these via config files, CLI flags, or environment variables.']
];

// Keys whose string value should be picked from an ANALYSIS provider dropdown
// (from GET /api/providers) rather than a free-text input.
const PROVIDER_KEYS = new Set([
  'default_provider',
  'tours.provider',
  'summaries.provider'
]);

// Keys whose string value should be picked from a CHAT provider dropdown. Chat
// providers are a separate namespace (GET /api/config → chat_providers) from
// analysis providers, so they must not be sourced from PROVIDER_KEYS.
const CHAT_PROVIDER_KEYS = new Set([
  'chat_provider'
]);

// Model-valued string keys. Rendered as a free-text <input list> backed by a
// <datalist> of known models (union across analysis providers) — discoverable
// and typo-resistant, but still accepts a valid-but-unlisted model id (the
// effective provider can be "inherit" or vary per row, so a hard <select> would
// wrongly reject legitimate ids). Mirrors the PROVIDER_KEYS pattern so the three
// model rows stay consistent.
const MODEL_KEYS = new Set([
  'default_model',
  'summaries.model',
  'tours.model'
]);

// Keys whose value is the "Default for Analysis" selection: EITHER the base
// Default Provider/Model pair (empty value) OR a saved council id. Rendered with
// the shared rich CouncilDropdown component (public/js/components/CouncilDropdown.js),
// mounted after render — not a native <select> — so the picker shows what you're
// selecting (council name + Standard/Advanced type), matching the repo settings
// page. Mirrors PROVIDER_KEYS/CHAT_PROVIDER_KEYS special-casing.
const COUNCIL_KEYS = new Set([
  'default_council_id'
]);

// Map the API `source` enum to a display label + CSS modifier class.
const SOURCE_DISPLAY = {
  app: { label: 'in-app', cls: 'app' },
  env: { label: 'env', cls: 'env' },
  'project.local': { label: 'project config.local', cls: 'file' },
  project: { label: 'project config', cls: 'file' },
  'config.local': { label: 'config.local.json', cls: 'file' },
  config: { label: 'config.json', cls: 'file' },
  managed: { label: 'managed', cls: 'managed' },
  default: { label: 'default', cls: 'default' }
};

// Stable DOM id for the (static) Repositories section, and its nav title.
const REPOS_SECTION_ID = 'repos-section';
const REPOS_NAV_TITLE = 'Repositories';

// Stable DOM id for the (static) Chat Snippets section, and its nav title.
const SNIPPETS_SECTION_ID = 'snippets-section';
const SNIPPETS_NAV_TITLE = 'Chat Snippets';

class SettingsPage {
  constructor() {
    // Map of key -> descriptor from the API (kept in sync after PUT/DELETE).
    this.settingsByKey = {};
    // Array of analysis provider definitions from /api/providers.
    this.providers = [];
    // Array of chat provider definitions from /api/config (chat_providers).
    this.chatProviders = [];
    // Array of saved councils from /api/councils (for the default-council key).
    this.councils = [];
    // Mounted CouncilDropdown instances keyed by setting key, so a re-render can
    // tear down the previous instance (its document outside-click listener)
    // before mounting a fresh one.
    this._councilDropdowns = {};
    // CouncilCard composition-preview instances keyed by setting key (no
    // listeners, so no teardown needed — re-created if the container changes).
    this._councilCards = {};
    // Per-key monotonic sequence for serializing in-flight mutations (PUT/DELETE)
    // so a stale response can never overwrite a newer one. See updateSetting.
    this._seq = {};
    // Ordered section metadata from GET /api/settings (id/title/description/
    // badge). Null until loaded; computeSections falls back to SETTINGS_GROUPS.
    this.apiSections = null;
    // Sections actually rendered (from computeSections); drives the side nav.
    this.sections = [];
    // Whether the Repositories section is visible (loaded successfully).
    this.reposVisible = false;
    // Whether the Chat Snippets section is visible (mounted successfully).
    this.snippetsVisible = false;
    // Mounted SnippetManager instance, if any.
    this._snippetManager = null;
    // Current active nav target id (scrollspy).
    this.activeNavId = null;

    this.init();
  }

  async init() {
    this.initTheme();
    this.setupEventDelegation();

    // Providers are needed to render provider dropdowns; load first but do not
    // block settings rendering fatally if it fails. Analysis providers and chat
    // providers come from different endpoints and are independent — load both
    // before settings so every dropdown can render against the right list.
    await Promise.all([this.loadProviders(), this.loadChatProviders(), this.loadCouncils()]);
    await this.loadSettings();
    await this.loadRepos();
    this.mountSnippets();

    // Build the side navigation once the sections it points at are in the DOM.
    this.buildNavigation();
  }

  // ─── Theme ────────────────────────────────────────────────────────────────

  initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);

    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
      });
    }
  }

  // ─── Data loading ─────────────────────────────────────────────────────────

  async loadProviders() {
    try {
      const response = await fetch('/api/providers');
      if (!response.ok) throw new Error('Failed to fetch providers');
      const data = await response.json();
      // Keep only providers that actually have models configured.
      this.providers = (data.providers || []).filter(p => p.models && p.models.length > 0);
    } catch (error) {
      console.error('Error loading providers:', error);
      this.providers = [];
    }
  }

  async loadChatProviders() {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error('Failed to fetch config');
      const data = await response.json();
      // chat_providers: [{ id, name, type, available }]. Kept as-is; the select
      // renderer only needs id + name and preserves an unknown current value.
      this.chatProviders = Array.isArray(data.chat_providers) ? data.chat_providers : [];
    } catch (error) {
      console.error('Error loading chat providers:', error);
      this.chatProviders = [];
    }
  }

  async loadCouncils() {
    try {
      const response = await fetch('/api/councils');
      if (!response.ok) throw new Error('Failed to fetch councils');
      const data = await response.json();
      // councils: [{ id, name, type }]. The select renderer preserves an
      // unknown current value so a stale/deleted council id still shows.
      this.councils = Array.isArray(data.councils) ? data.councils : [];
    } catch (error) {
      console.error('Error loading councils:', error);
      this.councils = [];
    }
  }

  async loadSettings() {
    const loadingEl = document.getElementById('settings-loading');
    const errorEl = document.getElementById('settings-error');
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error(`Failed to fetch settings (${response.status})`);
      const data = await response.json();
      const settings = data.settings || [];
      // Section metadata (order/titles/descriptions/badges) is additive: older
      // backends omit it, in which case computeSections falls back locally.
      this.apiSections = Array.isArray(data.sections) ? data.sections : null;

      this.settingsByKey = {};
      for (const s of settings) {
        this.settingsByKey[s.key] = s;
      }

      if (loadingEl) loadingEl.style.display = 'none';
      this.renderSections(settings);
    } catch (error) {
      console.error('Error loading settings:', error);
      if (loadingEl) loadingEl.style.display = 'none';
      if (errorEl) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Failed to load settings. Please refresh the page.';
      }
    }
  }

  async loadRepos() {
    const section = document.getElementById('repos-section');
    const list = document.getElementById('repos-list');
    if (!section || !list) return;

    try {
      const response = await fetch('/api/settings/repos');
      if (!response.ok) throw new Error('Failed to fetch repos');
      const data = await response.json();
      this.renderRepos(data.repos || []);
      section.style.display = '';
      this.reposVisible = true;
    } catch (error) {
      console.error('Error loading repositories:', error);
      // Leave the section hidden on error — it is supplementary.
    }
  }

  /**
   * Mount the shared SnippetManager into the (static) Chat Snippets section.
   * The component fetches its own data and renders its own empty/error states,
   * so the section stays visible as long as the component is available. Hidden
   * if the component script failed to load.
   */
  mountSnippets() {
    const section = document.getElementById(SNIPPETS_SECTION_ID);
    const mount = document.getElementById('snippets-manager');
    if (!section || !mount) return;

    if (typeof SnippetManager === 'undefined') {
      section.style.display = 'none';
      return;
    }

    try {
      this._snippetManager = new SnippetManager(mount);
      section.style.display = '';
      this.snippetsVisible = true;
    } catch (error) {
      console.error('Error mounting snippet manager:', error);
      section.style.display = 'none';
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  /**
   * Pure: compute the ordered list of sections that will actually render,
   * skipping groups with no settings. Order/titles/descriptions/badges come
   * from the API `sections` payload when present (the backend is authoritative
   * and already omits empty sections); otherwise they fall back to the built-in
   * SETTINGS_GROUPS derivation. This is the single source of truth shared by
   * renderSections and the side navigation, so the nav can never drift from
   * what's on the page.
   *
   * @param {Array} settings - setting descriptors from GET /api/settings
   * @param {Array} [apiSections] - `sections` payload: {id,title,description,badge}
   * @returns {Array<{groupKey, id, title, description, badge, settings}>}
   */
  computeSections(settings, apiSections) {
    const byGroup = {};
    for (const s of (settings || [])) {
      (byGroup[s.group] = byGroup[s.group] || []).push(s);
    }

    // Metadata + order: prefer the server payload, fall back to SETTINGS_GROUPS.
    // `hidden` is a build-time visibility default carried on the sections
    // payload (registry SECTIONS `hidden: true`); such sections (and their nav
    // entries) are omitted here.
    const groupMeta = (Array.isArray(apiSections) && apiSections.length)
      ? apiSections.map(s => ({
          groupKey: s.id, title: s.title, description: s.description, badge: s.badge || null, hidden: Boolean(s.hidden)
        }))
      : SETTINGS_GROUPS.map(([groupKey, title, description]) => ({
          groupKey, title, description, badge: null, hidden: false
        }));

    const sections = [];
    for (const meta of groupMeta) {
      if (meta.hidden) continue;
      const groupSettings = byGroup[meta.groupKey];
      if (!groupSettings || groupSettings.length === 0) continue;
      sections.push({
        groupKey: meta.groupKey,
        id: `section-${meta.groupKey}`,
        title: meta.title,
        description: meta.description,
        badge: meta.badge || null,
        settings: groupSettings
      });
    }
    return sections;
  }

  renderSections(settings) {
    const container = document.getElementById('settings-sections');
    if (!container) return;

    this.sections = this.computeSections(settings, this.apiSections);

    let html = '';
    for (const section of this.sections) {
      const rows = section.settings.map(s => this.settingRowHtml(s)).join('');
      html += `
        <section class="settings-section" id="${section.id}">
          <div class="section-header">
            <h2>${this.escapeHtml(section.title)}${this.badgePillHtml(section.badge)}</h2>
            ${section.description ? `<p class="section-description">${this.escapeHtml(section.description)}</p>` : ''}
          </div>
          <div class="settings-rows">
            ${rows}
          </div>
        </section>`;
    }

    container.innerHTML = html;
    // Object read-onlys leave their <pre> empty in the HTML string; fill them
    // now via textContent (no HTML escaping of the JSON).
    this.populateObjectValues(container);
    // Council keys render a mount point; instantiate the shared dropdown into it.
    this.mountCouncilDropdowns(container);
  }

  /**
   * Full HTML for one setting row (info column + control column).
   */
  settingRowHtml(setting) {
    return `<div class="setting-row" data-key="${this.escapeHtml(setting.key)}">${this.rowInnerHtml(setting)}</div>`;
  }

  /**
   * Inner HTML of a setting row — regenerated after each PUT/DELETE so the
   * badge, control value, and reset visibility stay in sync with the server.
   */
  rowInnerHtml(setting) {
    const src = SOURCE_DISPLAY[setting.source] || SOURCE_DISPLAY.default;
    const isOverride = setting.source === 'app';
    const isFinal = setting.final === true;
    // A finalized key is locked by configuration: never a resettable override.
    const showReset = isOverride && setting.editable && !isFinal;
    const showRestart = setting.restartRequired && isOverride;

    const badge = `<span class="source-badge source-badge--${src.cls}" data-role="badge" title="Source: ${this.escapeHtml(src.label)}">${this.escapeHtml(src.label)}</span>`;
    const featureBadge = this.badgePillHtml(setting.badge);
    const finalBadge = isFinal ? this.finalBadgeHtml() : '';
    const restart = `<span class="restart-note" data-role="restart"${showRestart ? '' : ' hidden'}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 100 10A5 5 0 008 3zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zm6.5-3.25a.75.75 0 01.75.75v2.5l1.5 1a.75.75 0 11-.83 1.25l-1.84-1.23a.75.75 0 01-.33-.62V5.5A.75.75 0 018 4.75z"/></svg>
        Takes effect after restart</span>`;

    const control = setting.group === 'readonly' || !setting.editable
      ? this.readonlyValueHtml(setting)
      : this.controlHtml(setting);

    const resetBtn = `<button type="button" class="reset-btn" data-role="reset"${showReset ? '' : ' hidden'}>Reset</button>`;

    return `
      <div class="setting-info">
        <div class="setting-label-row">
          <span class="setting-label">${this.escapeHtml(setting.label)}</span>
          ${featureBadge}
          ${badge}
          ${finalBadge}
        </div>
        ${setting.description ? `<p class="setting-description">${this.escapeHtml(setting.description)}</p>` : ''}
        ${restart}
      </div>
      <div class="setting-control">
        ${control}
        ${resetBtn}
      </div>`;
  }

  /**
   * A small feature-status pill ('new' / 'beta'). Unknown badge strings render
   * their text verbatim but adopt the 'beta' styling. Returns '' for no badge.
   */
  badgePillHtml(badge) {
    if (!badge) return '';
    const known = badge === 'new' || badge === 'beta';
    const cls = known ? `feature-badge--${badge}` : 'feature-badge--beta';
    return `<span class="feature-badge ${cls}" data-role="feature-badge">${this.escapeHtml(String(badge))}</span>`;
  }

  /**
   * The lock pill shown next to the source badge on a config-finalized setting.
   */
  finalBadgeHtml() {
    return `<span class="final-badge" data-role="final-badge" title="Locked by configuration">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5V4a4 4 0 118 0v1h.5A1.5 1.5 0 0114 6.5v6A1.5 1.5 0 0112.5 14h-9A1.5 1.5 0 012 12.5v-6A1.5 1.5 0 013.5 5H4zm1.5 0h5V4a2.5 2.5 0 00-5 0v1z"/></svg>
        Final</span>`;
  }

  /**
   * Editable control HTML for a setting, chosen by type.
   */
  controlHtml(setting) {
    const type = setting.type;
    // Config-finalized settings render their real control, but disabled.
    const disabled = setting.final === true ? ' disabled' : '';

    if (type === 'boolean') {
      const checked = setting.value === true ? ' checked' : '';
      return `<label class="toggle">
          <input type="checkbox" data-role="control"${checked}${disabled}>
          <span class="toggle-slider"></span>
        </label>`;
    }

    if (type === 'integer') {
      const val = setting.value == null ? '' : String(setting.value);
      return `<input type="number" class="settings-input settings-input--number" data-role="control" min="0" step="1" value="${this.escapeHtml(val)}"${disabled}>`;
    }

    if (type === 'enum') {
      const values = Array.isArray(setting.values) ? setting.values : [];
      const options = values.map(v =>
        `<option value="${this.escapeHtml(String(v))}"${String(v) === String(setting.value) ? ' selected' : ''}>${this.escapeHtml(String(v))}</option>`
      ).join('');
      return `<select class="settings-select" data-role="control"${disabled}>${options}</select>`;
    }

    // String types.
    if (PROVIDER_KEYS.has(setting.key)) {
      return this.providerSelectHtml(setting, this.providers);
    }
    if (CHAT_PROVIDER_KEYS.has(setting.key)) {
      return this.providerSelectHtml(setting, this.chatProviders);
    }
    if (COUNCIL_KEYS.has(setting.key)) {
      // "Default for Analysis": a mount point for the shared CouncilDropdown
      // plus a preview container beneath it. Neither carries data-role="control"
      // (so the generic change handler ignores them); mountCouncilDropdowns()
      // instantiates the dropdown (which PUTs via its onSelect callback) and
      // renders the composition preview / hint into the preview container.
      return '<div class="council-control-wrap">' +
        '<div class="custom-dropdown council-dropdown-control" data-role="council-mount"></div>' +
        '<div class="council-preview" data-role="council-preview"></div>' +
        '</div>';
    }
    if (MODEL_KEYS.has(setting.key)) {
      return this.modelInputHtml(setting);
    }

    const val = setting.value == null ? '' : String(setting.value);
    return `<input type="text" class="settings-input" data-role="control" value="${this.escapeHtml(val)}" placeholder="${this.escapeHtml(String(setting.default ?? ''))}"${disabled}>`;
  }

  /**
   * A model input: a free-text field with a <datalist> of known model ids so
   * the value is discoverable and typo-resistant while still accepting a
   * valid-but-unlisted id (the effective provider may be "inherit" or differ
   * per row, so a strict <select> would wrongly reject legitimate models). The
   * datalist is the union of every analysis provider's models — simpler and more
   * robust than reactively tracking the selected provider (the provider/model
   * rows PUT independently with no live link).
   */
  modelInputHtml(setting) {
    const disabled = setting.final === true ? ' disabled' : '';
    const val = setting.value == null ? '' : String(setting.value);
    // Stable, attribute-safe datalist id derived from the dot-path key.
    const listId = `models-${String(setting.key).replace(/[^a-z0-9]/gi, '-')}`;

    // Union of model ids across all analysis providers, de-duplicated + sorted.
    const modelIds = new Set();
    for (const p of (this.providers || [])) {
      for (const m of (p.models || [])) {
        const id = m && (m.id != null ? m.id : m);
        if (id != null && id !== '') modelIds.add(String(id));
      }
    }
    const options = [...modelIds]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => `<option value="${this.escapeHtml(id)}"></option>`)
      .join('');

    return `<input type="text" class="settings-input" data-role="control" list="${this.escapeHtml(listId)}" value="${this.escapeHtml(val)}" placeholder="${this.escapeHtml(String(setting.default ?? ''))}"${disabled}>` +
      `<datalist id="${this.escapeHtml(listId)}">${options}</datalist>`;
  }

  /**
   * Instantiate the shared CouncilDropdown into every council mount point under
   * `container`. Called after rows are inserted (renderSections / rerenderRow),
   * mirroring populateObjectValues. Each dropdown's base option is "Default
   * Provider / Model" (empty value): choosing it means analysis uses the
   * provider/model rows; choosing a council makes that council the default. The
   * onSelect callback PUTs immediately via updateSetting, just like every other
   * control. A `final`-locked setting mounts a disabled dropdown.
   */
  mountCouncilDropdowns(container) {
    if (!container) return;
    const Dropdown = (typeof window !== 'undefined' && window.CouncilDropdown) || null;
    if (!Dropdown) return;

    for (const mount of container.querySelectorAll('[data-role="council-mount"]')) {
      const row = mount.closest('.setting-row');
      if (!row) continue;
      const key = row.dataset.key;
      const setting = this.settingsByKey[key];
      if (!setting) continue;

      // Tear down any prior instance for this key so its document-level
      // outside-click listener doesn't leak across re-renders.
      if (this._councilDropdowns[key]) {
        this._councilDropdowns[key].destroy();
        delete this._councilDropdowns[key];
      }

      this._councilDropdowns[key] = new Dropdown({
        container: mount,
        councils: this.councils,
        selectedId: setting.value == null ? '' : String(setting.value),
        includeNone: true,
        noneLabel: 'Default Provider / Model',
        disabled: setting.final === true,
        onSelect: (value) => {
          if (setting.final === true) return;
          this.updateSetting(key, value);
        }
      });

      // Composition preview beneath the dropdown, reflecting the current value.
      this.renderCouncilPreview(row, setting);
    }
  }

  /**
   * Resolve provider/model ids to display names from the loaded analysis
   * providers (GET /api/providers, an array). Falls back to the raw ids when a
   * provider or model is unknown — the CouncilCard component consumes this.
   * @param {string} providerId
   * @param {string} modelId
   * @returns {{ providerName: string, modelName: string }}
   */
  resolveModelDisplay(providerId, modelId) {
    const provider = (this.providers || []).find((p) => p.id === providerId);
    if (!provider) {
      return { providerName: providerId || 'Unknown', modelName: modelId || 'Unknown' };
    }
    const model = (provider.models || []).find((m) => (m && (m.id != null ? m.id : m)) === modelId);
    return {
      providerName: provider.name || provider.id || providerId,
      modelName: model ? (model.name || model.id || modelId) : (modelId || 'Unknown')
    };
  }

  /**
   * Render the composition preview for a council row into its
   * `[data-role="council-preview"]` container: the CouncilCard for a selected
   * council, a short hint for the base "Default Provider / Model" option, or a
   * "not found" note for a stale id.
   * @param {HTMLElement} row - The setting row element.
   * @param {Object} setting - The setting descriptor (value = council id or '').
   */
  renderCouncilPreview(row, setting) {
    if (!row) return;
    const el = row.querySelector('[data-role="council-preview"]');
    if (!el) return;

    const value = setting.value == null ? '' : String(setting.value);
    if (value === '') {
      // Base option chosen — analysis uses the provider/model rows below.
      el.innerHTML = '';
      const hint = document.createElement('p');
      hint.className = 'council-preview-hint';
      hint.textContent = 'Uses the Default Provider / Model rows below.';
      el.appendChild(hint);
      return;
    }

    const council = (this.councils || []).find((c) => c.id === value);
    if (!council) {
      el.innerHTML = '';
      const note = document.createElement('p');
      note.className = 'council-preview-hint';
      note.textContent = 'Selected council was not found.';
      el.appendChild(note);
      return;
    }

    const Card = (typeof window !== 'undefined' && window.CouncilCard) || null;
    if (!Card) { el.innerHTML = ''; return; }
    if (!this._councilCards[setting.key] || this._councilCards[setting.key].container !== el) {
      this._councilCards[setting.key] = new Card({
        container: el,
        resolveModelDisplay: (p, m) => this.resolveModelDisplay(p, m)
      });
    }
    this._councilCards[setting.key].render(council);
  }

  /**
   * A provider dropdown for provider-valued string settings. Includes a blank
   * "inherit" option when the setting's default is empty. Ensures the current
   * value is always selectable even if that provider is unavailable.
   *
   * @param {Object} setting - The setting descriptor.
   * @param {Array} [providers] - Provider list to build options from. Defaults
   *   to the analysis providers; chat-provider keys pass this.chatProviders so
   *   they render from the chat namespace instead.
   */
  providerSelectHtml(setting, providers = this.providers) {
    const current = setting.value == null ? '' : String(setting.value);
    const allowEmpty = setting.default === '' || setting.default == null;
    const disabled = setting.final === true ? ' disabled' : '';

    let options = '';
    if (allowEmpty) {
      options += `<option value=""${current === '' ? ' selected' : ''}>Default (inherit)</option>`;
    }

    const known = new Set();
    for (const p of (providers || [])) {
      known.add(p.id);
      options += `<option value="${this.escapeHtml(p.id)}"${p.id === current ? ' selected' : ''}>${this.escapeHtml(p.name || p.id)}</option>`;
    }
    // Preserve a configured-but-unavailable provider so it still shows.
    if (current && !known.has(current)) {
      options += `<option value="${this.escapeHtml(current)}" selected>${this.escapeHtml(current)} (unavailable)</option>`;
    }

    return `<select class="settings-select" data-role="control"${disabled}>${options}</select>`;
  }

  /**
   * Read-only value display (no control) for the read-only group. Objects
   * (providers / chat_providers / hooks / repos) render as an inline
   * collapsible with their full contents; everything else is a plain code chip.
   */
  readonlyValueHtml(setting) {
    if (setting.sensitive) {
      const text = setting.configured ? 'Configured' : 'Not configured';
      const extraClass = setting.configured ? ' readonly-value--set' : '';
      return `<code class="readonly-value${extraClass}">${this.escapeHtml(text)}</code>`;
    }

    // Object-type read-onlys: the backend ships the full (secret-redacted)
    // object as setting.value. Render it inline and collapsible.
    if (setting.value && typeof setting.value === 'object') {
      return this.readonlyObjectHtml(setting);
    }

    if (setting.value === null || setting.value === undefined || setting.value === '') {
      return `<code class="readonly-value">${this.escapeHtml('Not set')}</code>`;
    }

    return `<code class="readonly-value readonly-value--set">${this.escapeHtml(String(setting.value))}</code>`;
  }

  /**
   * Inline collapsible for an object-type read-only setting. The <pre> is left
   * empty here and filled via textContent by populateObjectValues() after the
   * row is in the DOM — sidestepping HTML-escaping of the JSON entirely.
   */
  readonlyObjectHtml(setting) {
    const obj = setting.value && typeof setting.value === 'object' ? setting.value : {};
    const n = Object.keys(obj).length;
    if (n === 0) {
      return `<code class="readonly-value">${this.escapeHtml('No entries')}</code>`;
    }
    const summary = `${n} ${n === 1 ? 'entry' : 'entries'}`;
    return `<details class="readonly-object">
        <summary class="readonly-object-summary">${this.escapeHtml(summary)}</summary>
        <pre class="readonly-object-json" data-role="object-json"></pre>
      </details>`;
  }

  /**
   * Fill every object-json <pre> under `container` from its setting descriptor,
   * via textContent (never innerHTML). Called after rows are inserted so the
   * pretty-printed JSON needs no HTML escaping.
   */
  populateObjectValues(container) {
    if (!container) return;
    for (const pre of container.querySelectorAll('[data-role="object-json"]')) {
      const row = pre.closest('.setting-row');
      if (!row) continue;
      const setting = this.settingsByKey[row.dataset.key];
      if (!setting || !setting.value || typeof setting.value !== 'object') continue;
      pre.textContent = JSON.stringify(setting.value, null, 2);
    }
  }

  renderRepos(repos) {
    const list = document.getElementById('repos-list');
    if (!list) return;

    if (!repos.length) {
      list.innerHTML = '<div class="repos-empty">No repositories configured yet. Run <code>npx pair-review</code> from a local clone, or open a PR review, to register one.</div>';
      return;
    }

    list.innerHTML = repos.map(repo => {
      const name = repo.repository || '';
      const configured = repo.hasDbSettings || repo.hasFileConfig;
      const badge = configured
        ? '<span class="repo-badge repo-badge--configured">Configured</span>'
        : '<span class="repo-badge repo-badge--known">Known</span>';
      const sources = [];
      if (repo.hasDbSettings) sources.push('settings');
      if (repo.hasFileConfig) sources.push('config file');
      const sourceHint = sources.length
        ? `<span class="repo-source-hint">${this.escapeHtml(sources.join(' · '))}</span>`
        : '';
      const pathHint = repo.localPath
        ? `<code class="repo-path">${this.escapeHtml(repo.localPath)}</code>`
        : '';

      return `<a class="repo-row" href="/settings/${this.escapeHtml(name)}">
          <div class="repo-row-main">
            <span class="repo-row-name">${this.escapeHtml(name)}</span>
            ${pathHint}
          </div>
          <div class="repo-row-badges">
            ${sourceHint}
            ${badge}
          </div>
        </a>`;
    }).join('');
  }

  // ─── Section navigation (side nav + scrollspy) ─────────────────────────────

  /**
   * Pure: build the ordered nav items from the rendered sections plus, when
   * visible, the Repositories section. Derives entirely from `sections` (the
   * same data renderSections used) so it cannot drift from the page.
   *
   * @param {Array} sections - rendered dynamic sections
   * @param {boolean} includeRepos - append the Repositories nav item
   * @param {boolean} [includeSnippets] - append the Chat Snippets nav item
   * @returns {Array<{id: string, title: string}>}
   */
  navItems(sections, includeRepos, includeSnippets) {
    const items = (sections || []).map(s => {
      // Only attach `badge` when the section actually has one, so callers that
      // build sections without badges keep a clean {id, title} shape.
      const item = { id: s.id, title: s.title };
      if (s.badge) item.badge = s.badge;
      return item;
    });
    // Chat Snippets precedes Repositories so Repositories stays the terminal
    // section (both the static markup and the scrollspy depend on this order).
    if (includeSnippets) {
      items.push({ id: SNIPPETS_SECTION_ID, title: SNIPPETS_NAV_TITLE });
    }
    if (includeRepos) {
      items.push({ id: REPOS_SECTION_ID, title: REPOS_NAV_TITLE });
    }
    return items;
  }

  /**
   * Render the side-nav anchors into #settings-nav-list.
   */
  renderNav(items) {
    const list = document.getElementById('settings-nav-list');
    if (!list) return;

    if (!items.length) {
      list.innerHTML = '';
      return;
    }

    list.innerHTML = items.map(item =>
      `<a class="settings-nav-item" href="#${this.escapeHtml(item.id)}" data-target="${this.escapeHtml(item.id)}">${this.escapeHtml(item.title)}${this.badgePillHtml(item.badge)}</a>`
    ).join('');
  }

  /**
   * Wire up rendering, click-to-scroll, and scrollspy for the side nav. Called
   * once after settings + repos have loaded so every target section exists.
   */
  buildNavigation() {
    const items = this.navItems(this.sections, this.reposVisible, this.snippetsVisible);
    this.navItemsList = items;
    this.renderNav(items);
    this.setupNavClickHandler();
    this.setupScrollSpy(items);

    // Start with the first section highlighted (page loads scrolled to top).
    if (items.length) this.setActiveNav(items[0].id);
  }

  setupNavClickHandler() {
    const list = document.getElementById('settings-nav-list');
    if (!list) return;

    list.addEventListener('click', (e) => {
      const item = e.target.closest('.settings-nav-item');
      if (!item) return;
      e.preventDefault();
      const target = document.getElementById(item.dataset.target);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Reflect the click immediately; the observer will keep it in sync after.
      this.setActiveNav(item.dataset.target);
    });
  }

  /**
   * Highlight exactly one nav item. No-op if already active.
   */
  setActiveNav(id) {
    if (this.activeNavId === id) return;
    this.activeNavId = id;

    const list = document.getElementById('settings-nav-list');
    if (!list) return;
    for (const anchor of list.querySelectorAll('.settings-nav-item')) {
      const active = anchor.dataset.target === id;
      anchor.classList.toggle('is-active', active);
      if (active) {
        anchor.setAttribute('aria-current', 'true');
      } else {
        anchor.removeAttribute('aria-current');
      }
    }
  }

  /**
   * Scrollspy via IntersectionObserver. The rootMargin shrinks the detection
   * band to a strip just below the sticky header, so the active section is the
   * one whose heading sits near the top of the viewport. A bottom guard forces
   * the last item active when the page can't scroll any further (the classic
   * "last short section never reaches the top" case).
   */
  setupScrollSpy(items) {
    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') return;

    this.navSections = items
      .map(item => document.getElementById(item.id))
      .filter(Boolean);
    if (!this.navSections.length) return;

    const visible = new Set();
    this.scrollObserver = new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      // The bottom guard owns the active state at the very bottom of the page.
      if (this.isAtPageBottom()) return;
      // Active = first section (document order) currently in the detection band.
      for (const section of this.navSections) {
        if (visible.has(section.id)) {
          this.setActiveNav(section.id);
          break;
        }
      }
    }, { rootMargin: '-72px 0px -55% 0px', threshold: 0 });

    for (const section of this.navSections) this.scrollObserver.observe(section);

    this._onScroll = () => {
      if (this.isAtPageBottom() && this.navSections.length) {
        this.setActiveNav(this.navSections[this.navSections.length - 1].id);
      }
    };
    window.addEventListener('scroll', this._onScroll, { passive: true });
  }

  isAtPageBottom() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    const doc = document.documentElement;
    return (window.innerHeight + window.scrollY) >= (doc.scrollHeight - 2);
  }

  // ─── Event handling ───────────────────────────────────────────────────────

  setupEventDelegation() {
    const container = document.getElementById('settings-sections');
    if (!container) return;

    // Immediate PUT when a control changes. For text/number inputs 'change'
    // fires on blur/Enter, which is the intended debounce.
    container.addEventListener('change', (e) => {
      const control = e.target.closest('[data-role="control"]');
      if (!control) return;
      const row = control.closest('.setting-row');
      if (!row) return;
      const key = row.dataset.key;
      const setting = this.settingsByKey[key];
      if (!setting) return;
      // Finalized settings are locked by configuration — never PUT them (the
      // control is disabled anyway; this guards programmatic change events).
      if (setting.final === true) return;

      const value = this.readControlValue(control, setting);
      if (value === undefined) return; // no-op (e.g. empty integer)
      this.updateSetting(key, value);
    });

    // Reset (DELETE the in-app override).
    container.addEventListener('click', (e) => {
      const resetBtn = e.target.closest('[data-role="reset"]');
      if (!resetBtn) return;
      const row = resetBtn.closest('.setting-row');
      if (!row) return;
      this.resetSetting(row.dataset.key);
    });
  }

  /**
   * Read a typed value out of a control element. Returns `undefined` to signal
   * "do not send" (e.g. an integer field cleared to empty — use Reset instead).
   */
  readControlValue(control, setting) {
    if (setting.type === 'boolean') {
      return control.checked;
    }
    if (setting.type === 'integer') {
      const raw = control.value.trim();
      if (raw === '') return undefined;
      const n = parseInt(raw, 10);
      if (Number.isNaN(n)) return undefined;
      return n;
    }
    // enum / string / provider select
    return control.value;
  }

  async updateSetting(key, value) {
    // Per-key sequence guard: a change event and a Reset (or two rapid changes)
    // on the same key can be in flight at once. Both updateSetting and
    // resetSetting bump the SAME counter, so whichever mutation was issued last
    // owns the final state — an earlier response that lands afterwards is stale
    // and must not overwrite it (or revert on its own error).
    if (!this._seq) this._seq = {};
    const seq = this._seq[key] = (this._seq[key] || 0) + 1;
    try {
      const response = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to save (${response.status})`);
      }

      const data = await response.json();
      if (this._seq[key] !== seq) return; // superseded by a newer mutation
      const setting = data.setting;
      this.settingsByKey[key] = setting;
      this.rerenderRow(setting);
      this.showToast('success', `${setting.label} saved`);
    } catch (error) {
      if (this._seq[key] !== seq) return; // superseded — leave newer state intact
      console.error('Error saving setting:', error);
      this.showToast('error', `Failed to save: ${error.message}`);
      // Revert the control to the last known-good descriptor.
      const known = this.settingsByKey[key];
      if (known) this.rerenderRow(known);
    }
  }

  async resetSetting(key) {
    // Shares the sequence counter with updateSetting so the two serialize
    // against each other (e.g. Reset clicked while a PUT is in flight).
    if (!this._seq) this._seq = {};
    const seq = this._seq[key] = (this._seq[key] || 0) + 1;
    try {
      const response = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to reset (${response.status})`);
      }

      const data = await response.json();
      if (this._seq[key] !== seq) return; // superseded by a newer mutation
      const setting = data.setting;
      this.settingsByKey[key] = setting;
      this.rerenderRow(setting);
      this.showToast('success', `${setting.label} reset`);
    } catch (error) {
      if (this._seq[key] !== seq) return; // superseded — leave newer state intact
      console.error('Error resetting setting:', error);
      this.showToast('error', `Failed to reset: ${error.message}`);
    }
  }

  /**
   * Replace one row's contents with freshly rendered HTML from its descriptor.
   */
  rerenderRow(setting) {
    const container = document.getElementById('settings-sections');
    if (!container) return;
    const row = container.querySelector(`.setting-row[data-key="${this.cssAttrEscape(setting.key)}"]`);
    if (!row) return;
    row.innerHTML = this.rowInnerHtml(setting);
    // Keep any object-json <pre> in this row populated (readonly objects never
    // rerender through here today, but this stays correct if that changes).
    this.populateObjectValues(row);
    // Re-mount a council dropdown if this row hosts one (e.g. after PUT/reset).
    this.mountCouncilDropdowns(row);
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  /**
   * Escape a value for safe use inside a quoted attribute selector.
   */
  cssAttrEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    // Fallback: escape backslashes and double quotes.
    return String(value).replace(/["\\]/g, '\\$&');
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    // Output is injected into double-quoted attribute contexts (data-key, title,
    // value, placeholder, href) as well as text nodes, so quotes MUST be escaped
    // too — a textContent→innerHTML pass only covers & < >.
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  showToast(type, message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <div class="toast-icon">
        ${type === 'success'
          ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 11-2 0 1 1 0 012 0zM6.92 6.085c.081-.16.19-.299.34-.398.145-.097.371-.187.74-.187.302 0 .558.066.743.205a.677.677 0 01.26.514c0 .217-.062.376-.15.495-.083.112-.216.22-.436.345-.205.119-.36.234-.479.364a.788.788 0 00-.19.478v.413a.75.75 0 101.5 0v-.124c0-.05.024-.1.067-.14.052-.047.154-.113.333-.19.188-.083.37-.196.523-.35a1.724 1.724 0 00.437-1.18c0-.515-.177-.914-.504-1.199-.331-.289-.78-.447-1.3-.447-.531 0-.978.164-1.307.465-.323.295-.496.682-.558 1.093a.75.75 0 001.474.28.327.327 0 01.029-.073zM9 11a1 1 0 11-2 0 1 1 0 012 0z"/></svg>'
        }
      </div>
      <span class="toast-message"></span>
      <button class="toast-close" data-role="toast-close" aria-label="Dismiss">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
        </svg>
      </button>
    `;
    // Assign message via textContent to avoid HTML injection.
    toast.querySelector('.toast-message').textContent = message;
    toast.querySelector('[data-role="toast-close"]').addEventListener('click', () => toast.remove());

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
}

// Initialize when DOM is ready (browser only).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', () => {
    window.settingsPage = new SettingsPage();
  });
}

// Export for unit tests (jsdom/vm sandbox), following the repo pattern.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SettingsPage, SETTINGS_GROUPS, PROVIDER_KEYS, CHAT_PROVIDER_KEYS, MODEL_KEYS, COUNCIL_KEYS, SOURCE_DISPLAY };
}
