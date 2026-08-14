// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CouncilManager — full council CRUD outside a review.
 *
 * Mounted inline by the global settings page's "Councils" section:
 * `new CouncilManager(container, { onChange })`. Modeled on SnippetManager: one
 * container it owns end to end, all DOM built with createElement (council names,
 * descriptions and file paths are untrusted text and are never interpolated into
 * innerHTML), the list re-fetched after every successful mutation, and
 * `onChange()` fired after each success so the host page can refresh anything
 * derived from the council list (e.g. the "Default for Analysis" dropdown).
 *
 * Two modes share the container:
 *
 *   - LIST: `GET /api/councils` rows with a type badge (Standard/Advanced), a
 *     File badge for the read-only `~/.pair-review/councils/` overlay, the
 *     description as a subtitle, and a click-to-expand CouncilCard preview.
 *     DB councils offer Edit / Duplicate / Export / Delete; file councils offer
 *     Duplicate / Export only — the API refuses PUT and DELETE on `file:` ids by
 *     design, so those buttons are not rendered at all.
 *   - EDITOR: hosts ONE instance of the existing config tab
 *     (VoiceCentricConfigTab for `type === 'council'`, AdvancedConfigTab for
 *     legacy/`'advanced'`) in a plain wrapper div that plays the modal's role as
 *     the tab's query root. CouncilManager owns only the Save/Back footer; the
 *     tab keeps rendering its own Save / Save As / Export / Delete row inside the
 *     panel — the same duplication AnalysisConfigModal already ships.
 *
 * >>> CONSTRAINT: ONE INSTANCE PER PAGE, AND NEVER ALONGSIDE AnalysisConfigModal.
 * The config tabs query hardcoded, page-global element ids — `#tab-panel-council`,
 * `#tab-panel-advanced`, `#vc-council-selector`, `#council-selector` and the
 * tab-owned button ids. Two CouncilManagers on one page, or a CouncilManager on a
 * page that also loads AnalysisConfigModal, would give those ids two owners and
 * the tabs would read/write each other's DOM. Instantiate exactly one, on a page
 * that does not load the analysis modal (today: /settings).
 *
 * Collaborators are resolved at CALL time on `window` — `CouncilDropdown`
 * (badges), `CouncilCard` (preview), `ProviderMap`, `resolveProviderModelPair` /
 * `buildProviderModelScopes` (the default pair a new council starts from),
 * `CouncilDocument` (export), `textInputDialog`, `confirmDialog`, `toast`, and
 * the two tab classes — so script order is a non-issue.
 */

/* global window, document, fetch, module, console */

class CouncilManager {
  /**
   * @param {HTMLElement} container - Mount point; its contents are managed here.
   * @param {Object} [options]
   * @param {Function} [options.onChange] - Called after any successful mutation.
   */
  constructor(container, { onChange } = {}) {
    this.container = container;
    this.onChange = typeof onChange === 'function' ? onChange : null;

    // View state: 'list' | 'chooser' | 'editor'.
    this._mode = 'list';
    // Latest council list from the API (DB rows first, file rows appended).
    this._councils = [];
    // Provider map ({ [providerId]: provider }) for the tabs and the preview.
    this._providers = {};
    // The raw /api/providers array — resolveProviderModelPair needs the list
    // form (with each provider's `defaultModel` and model aliases), which the
    // map form drops.
    this._providerList = [];
    // /api/config, for the page's default provider/model pair.
    this._appConfig = {};
    // Id of the row whose CouncilCard preview is expanded (null = none).
    this._expandedId = null;
    // Guards against overlapping saves/deletes/duplicates.
    this._busy = false;
    // Last error message to surface in the banner (null when clear).
    this._error = null;

    // Editor state.
    this._tab = null;          // the hosted config tab instance
    this._tabType = null;      // 'council' | 'advanced'
    this._editingId = null;    // council id being edited (null for Add)

    // Document-level listeners we attach (currently none — the tabs and their
    // TimeoutSelects manage their own — but tracked so destroy() can always tear
    // them down safely).
    this._docListeners = [];

    if (this.container) {
      this._renderLoading();
      this._init();
    }
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  /** First paint: providers, app defaults and councils in parallel, then render. */
  async _init() {
    await Promise.all([this._loadProviders(), this._loadAppConfig(), this._loadCouncils()]);
    this._render();
  }

  /**
   * Load the provider map used by both the hosted tab (`setProviders`) and the
   * preview's model-name resolution. A failure is non-fatal: the map stays empty
   * and ids are displayed raw, exactly like CouncilCard's default resolver.
   */
  async _loadProviders() {
    try {
      const response = await fetch('/api/providers');
      if (!response.ok) throw new Error(`Failed to load providers (${response.status})`);
      const data = await response.json();
      const providerMap = window.ProviderMap;
      this._providerList = Array.isArray(data.providers) ? data.providers : [];
      this._providers = providerMap ? providerMap.buildProviderMap(data.providers) : {};
    } catch (error) {
      console.error('Error loading providers:', error);
      this._providerList = [];
      this._providers = {};
    }
  }

  /**
   * Load /api/config for the page's default provider/model. Only used to seed a
   * NEW council's first reviewer (see `_defaultOrchestration`), so a failure is
   * non-fatal — the tab keeps its own hardcoded fallback.
   */
  async _loadAppConfig() {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error(`Failed to load config (${response.status})`);
      this._appConfig = await response.json();
    } catch (error) {
      console.error('Error loading config:', error);
      this._appConfig = {};
    }
  }

  /**
   * The provider/model pair a brand-new council starts with.
   *
   * REQUIRED, not cosmetic: the tabs' `_defaultConfig()` falls back to the
   * hardcoded pair `claude`/`sonnet`, and `sonnet` is an alias that is not a
   * model `<option>` value. `_applyConfigToUI` assigns it to the model
   * `<select>`, the assignment silently selects nothing, and `_readConfigFromUI`
   * then drops the reviewer entirely (it only keeps rows with BOTH a provider
   * and a model) — so saving a new council posted `voices: []` and the API
   * rejected it with 400. AnalysisConfigModal avoids this by calling
   * `setDefaultOrchestration(currentProvider, currentModel)` before `reset()`
   * (AnalysisConfigModal.js:928); this is the same call with the same shared
   * resolver, which also validates the configured model against the provider's
   * ids AND aliases before accepting it.
   *
   * @returns {{provider: (string|null), model: (string|null)}}
   */
  _defaultOrchestration() {
    const resolvePair = window.resolveProviderModelPair;
    const buildScopes = window.buildProviderModelScopes;
    if (!resolvePair || !buildScopes) return { provider: null, model: null };
    // No repo scope on a global page: config defaults (and any CLI override).
    const pair = resolvePair(buildScopes(null, this._appConfig || {}), this._providerList || []);
    return { provider: pair.provider, model: this._canonicalModelId(pair.provider, pair.model) };
  }

  /**
   * Map a model id to the id the model `<select>` actually carries as an option.
   *
   * The resolver deliberately PRESERVES a configured alias (`sonnet`) when it
   * belongs to the provider — right for anything that hands the pair to a
   * backend, wrong for a `<select>`, whose options are canonical ids only.
   * Assigning an alias selects nothing, which is the same empty-model failure
   * the resolver call above exists to prevent. Unknown ids pass through
   * unchanged (a custom provider has no metadata to canonicalize against).
   *
   * @param {string|null} providerId
   * @param {string|null} modelId
   * @returns {string|null}
   */
  _canonicalModelId(providerId, modelId) {
    if (!providerId || !modelId) return modelId;
    const provider = (this._providerList || []).find(p => p && p.id === providerId);
    const models = provider && Array.isArray(provider.models) ? provider.models : [];
    const match = models.find(m => m && (m.id === modelId || (m.aliases || []).includes(modelId)));
    return match ? match.id : modelId;
  }

  async _loadCouncils() {
    try {
      const response = await fetch('/api/councils');
      if (!response.ok) throw new Error(`Failed to load councils (${response.status})`);
      const data = await response.json();
      this._councils = Array.isArray(data.councils) ? data.councils : [];
      this._error = null;
    } catch (error) {
      this._councils = [];
      this._error = error && error.message ? error.message : 'Failed to load councils';
    }
  }

  async _fetchAndRender() {
    await this._loadCouncils();
    this._render();
  }

  /**
   * A cheap fingerprint of the current list, used to notice mutations made
   * through the hosted tab's OWN buttons (Save As / Delete inside the panel),
   * which CouncilManager never sees. Best-effort by design: `updated_at` has
   * one-second resolution in SQLite, so a same-second in-place edit can look
   * unchanged. The Save button we own reports its success explicitly instead.
   */
  _listSignature() {
    return this._councils
      .map(c => `${c.id}\u0000${c.name}\u0000${c.updated_at || ''}`)
      .join('\u0001');
  }

  // ─── Council helpers ───────────────────────────────────────────────────────

  /** File-overlay councils are read-only: no Edit, no Delete (the API 400s). */
  _isReadOnly(council) {
    return council?.readOnly === true || council?.source === 'file';
  }

  /**
   * The type literal to send to the API / the document builder. Legacy rows
   * predate the `type` column and are level-centric, matching
   * `AdvancedConfigTab.loadCouncils`' `!c.type || c.type === 'advanced'` filter.
   */
  _effectiveType(council) {
    return council?.type === 'council' ? 'council' : 'advanced';
  }

  /**
   * Resolve provider/model ids to display names from the loaded provider map,
   * falling back to the raw ids. Handed to CouncilCard, which has no page
   * knowledge of its own. Mirrors `settings.js#resolveModelDisplay`, which reads
   * the same data as an array.
   */
  _resolveModelDisplay(providerId, modelId) {
    const provider = this._providers ? this._providers[providerId] : null;
    if (!provider) {
      return { providerName: providerId || 'Unknown', modelName: modelId || 'Unknown' };
    }
    const model = (provider.models || []).find(m => (m && (m.id != null ? m.id : m)) === modelId);
    return {
      providerName: provider.name || provider.id || providerId,
      modelName: model ? (model.name || model.id || modelId) : (modelId || 'Unknown')
    };
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  _renderLoading() {
    if (!this.container) return;
    this.container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'council-manager__loading';
    loading.textContent = 'Loading councils…';
    this.container.appendChild(loading);
  }

  _render() {
    if (!this.container) return;
    // The editor's DOM hosts a live tab instance; it is built (and replaced)
    // only by _openEditor, never by a list re-render that would orphan the tab.
    if (this._mode === 'editor') return;

    this.container.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'council-manager';

    if (this._error) {
      const err = document.createElement('div');
      err.className = 'council-manager__error';
      err.textContent = this._error;
      root.appendChild(err);
    }

    root.appendChild(this._mode === 'chooser' ? this._buildTypeChooser() : this._buildList());

    this.container.appendChild(root);
  }

  _buildList() {
    const wrap = document.createElement('div');
    wrap.className = 'council-manager__list-wrap';

    if (this._councils.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'council-manager__empty';
      empty.textContent = 'No councils yet.';
      wrap.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'council-manager__list';
      for (const council of this._councils) {
        list.appendChild(this._buildRow(council));
      }
      wrap.appendChild(list);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'council-manager__add-btn';
    addBtn.textContent = 'Add council';
    addBtn.addEventListener('click', () => this._showTypeChooser());
    wrap.appendChild(addBtn);

    return wrap;
  }

  /**
   * One council row: a DIV wrapper holding the expand button (name + badges +
   * description), the sibling action buttons, and — when expanded — the
   * CouncilCard preview. The expander is a <button> for keyboard access and the
   * actions are its SIBLINGS, never nested inside it (public/js/CONVENTIONS.md).
   */
  _buildRow(council) {
    const wrap = document.createElement('div');
    wrap.className = 'council-manager__row-wrap';
    wrap.dataset.id = String(council.id);

    const row = document.createElement('div');
    row.className = 'council-manager__row';

    const expanded = this._expandedId === council.id;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'council-manager__row-main';
    main.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    const heading = document.createElement('span');
    heading.className = 'council-manager__row-heading';

    const name = document.createElement('span');
    name.className = 'council-manager__name';
    name.textContent = council.name || '';
    heading.appendChild(name);

    const dropdown = window.CouncilDropdown;
    if (dropdown) {
      // typeBadge takes the TYPE, sourceBadge takes the COUNCIL — see
      // public/js/components/CouncilDropdown.js. We build the elements ourselves
      // (the dropdown only returns { label, cssClass }) so the untrusted parts
      // of the row stay textContent-only.
      //
      // The badge is fed the EFFECTIVE type, so a legacy untyped row badges as
      // "Advanced" — which is what it is, and what this row's Edit button opens.
      // `typeBadge` normalizes untyped rows the same way, so this is belt and
      // braces; it stays explicit because `_effectiveType` is also what the
      // Edit / Duplicate / Export paths below send.
      const type = dropdown.typeBadge(this._effectiveType(council));
      if (type) heading.appendChild(this._buildBadge(type));

      const source = dropdown.sourceBadge(council);
      if (source) {
        const badge = this._buildBadge(source);
        // The file path is the only place the user can go to edit this council.
        if (council.filePath) badge.title = String(council.filePath);
        heading.appendChild(badge);
      }
    }

    main.appendChild(heading);

    const description = typeof council.description === 'string' ? council.description.trim() : '';
    if (description) {
      const subtitle = document.createElement('span');
      subtitle.className = 'council-manager__description';
      subtitle.textContent = description;
      main.appendChild(subtitle);
    }

    main.addEventListener('click', () => this._toggleExpanded(council.id));
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'council-manager__row-actions';

    const readOnly = this._isReadOnly(council);
    if (!readOnly) {
      actions.appendChild(this._buildActionButton('Edit', 'council-manager__edit-btn', () => {
        this._openEditor({ type: this._effectiveType(council), councilId: council.id });
      }));
    }
    actions.appendChild(this._buildActionButton('Duplicate', 'council-manager__duplicate-btn', () => {
      this._duplicate(council);
    }));
    actions.appendChild(this._buildActionButton('Export', 'council-manager__export-btn', () => {
      this._export(council);
    }));
    if (!readOnly) {
      actions.appendChild(this._buildActionButton('Delete', 'council-manager__delete-btn', () => {
        this._delete(council);
      }));
    }

    row.appendChild(actions);
    wrap.appendChild(row);

    if (expanded) {
      const preview = document.createElement('div');
      preview.className = 'council-manager__preview';
      wrap.appendChild(preview);
      const Card = window.CouncilCard;
      if (Card) {
        // Pass the row through as-is: CouncilCard.render applies the same
        // type→layout rule `_effectiveType` encodes for the badge, so the card
        // and the badge above it always agree without normalizing twice.
        new Card({
          container: preview,
          resolveModelDisplay: (providerId, modelId) => this._resolveModelDisplay(providerId, modelId)
        }).render(council);
      }
    }

    return wrap;
  }

  /** A `{ label, cssClass }` badge descriptor as a span the row can own. */
  _buildBadge({ label, cssClass }) {
    const badge = document.createElement('span');
    // Base class carries layout, the compound modifier carries only color —
    // see public/css/council-dropdown.css.
    badge.className = `council-type-badge ${cssClass}`;
    badge.textContent = label;
    return badge;
  }

  _buildActionButton(label, className, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `council-manager__row-btn ${className}`;
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      // The row's expander is a sibling, not an ancestor, but stop here anyway
      // so a future wrapper-level handler can never double-fire.
      e.stopPropagation();
      handler();
    });
    return btn;
  }

  /** Add flow, step 1: which kind of council is this going to be? */
  _buildTypeChooser() {
    const wrap = document.createElement('div');
    wrap.className = 'council-manager__chooser';

    const heading = document.createElement('div');
    heading.className = 'council-manager__chooser-heading';
    heading.textContent = 'What kind of council?';
    wrap.appendChild(heading);

    const options = document.createElement('div');
    options.className = 'council-manager__chooser-options';
    options.appendChild(this._buildChooserOption(
      'Council',
      'One set of reviewers, applied to every enabled level.',
      'council-manager__chooser-council',
      'council'
    ));
    options.appendChild(this._buildChooserOption(
      'Advanced',
      'Reviewers configured separately for each level.',
      'council-manager__chooser-advanced',
      'advanced'
    ));
    wrap.appendChild(options);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'council-manager__cancel-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      this._mode = 'list';
      this._render();
    });
    wrap.appendChild(cancel);

    return wrap;
  }

  _buildChooserOption(label, description, className, type) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `council-manager__chooser-option ${className}`;

    const title = document.createElement('span');
    title.className = 'council-manager__chooser-option-title';
    title.textContent = label;
    btn.appendChild(title);

    const desc = document.createElement('span');
    desc.className = 'council-manager__chooser-option-description';
    desc.textContent = description;
    btn.appendChild(desc);

    btn.addEventListener('click', () => this._openEditor({ type }));
    return btn;
  }

  // ─── View transitions ──────────────────────────────────────────────────────

  _showTypeChooser() {
    this._mode = 'chooser';
    this._error = null; // don't carry a stale banner across the transition
    this._render();
  }

  _toggleExpanded(id) {
    this._expandedId = this._expandedId === id ? null : id;
    this._render();
  }

  /**
   * Enter editor mode, hosting one config tab.
   *
   * THE CALL ORDER BELOW IS LOAD-BEARING and mirrors AnalysisConfigModal's tab
   * initialisation: setProviders() AND setDefaultOrchestration() must both run
   * before reset(), because reset() repaints the UI from _defaultConfig(), which
   * reads _defaultProvider/_defaultModel and the provider dropdown data;
   * setDefaultCouncilId() records a PENDING id that _renderCouncilSelector()
   * applies, so it has to precede loadCouncils().
   *
   *   inject(panel) → setProviders(map) → setDefaultOrchestration(pair) →
   *   reset() → [setDefaultCouncilId(id)] → loadCouncils()
   *
   * The wrapper div — not the panel — is the tab's constructor argument: the tab
   * plays `this.modal.querySelector('#tab-panel-…')` against it.
   *
   * @param {Object} params
   * @param {string} params.type - 'council' (voice-centric) or 'advanced'
   * @param {string|null} [params.councilId] - Council to edit; null = new council
   */
  async _openEditor({ type, councilId = null }) {
    if (!this.container) return;
    const TabClass = type === 'council' ? window.VoiceCentricConfigTab : window.AdvancedConfigTab;
    if (!TabClass) {
      this._error = 'Council editor is unavailable on this page.';
      this._mode = 'list';
      this._render();
      return;
    }

    this._mode = 'editor';
    this._tabType = type;
    this._editingId = councilId;
    this._expandedId = null;

    this.container.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'council-manager council-manager--editor';

    const header = document.createElement('div');
    header.className = 'council-manager__editor-header';
    header.textContent = councilId ? 'Edit council' : 'New council';
    root.appendChild(header);

    // The tab's query root. It holds exactly one panel, so the ids the tab looks
    // up resolve to this instance's DOM and nothing else on the page.
    const wrapper = document.createElement('div');
    wrapper.className = 'council-manager__tab-host';

    const panel = document.createElement('div');
    // Hardcoded inside the tabs (VoiceCentricConfigTab._updateSaveButtonStates
    // queries '#tab-panel-council'; AdvancedConfigTab queries
    // '#tab-panel-advanced'). They are not configurable.
    panel.id = type === 'council' ? 'tab-panel-council' : 'tab-panel-advanced';
    wrapper.appendChild(panel);
    root.appendChild(wrapper);

    const footer = document.createElement('div');
    footer.className = 'council-manager__editor-footer';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'council-manager__save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => this._saveFromEditor());
    footer.appendChild(saveBtn);

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'council-manager__back-btn';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', () => this._backFromEditor());
    footer.appendChild(backBtn);

    root.appendChild(footer);
    this.container.appendChild(root);

    try {
      const tab = new TabClass(wrapper);
      this._tab = tab;
      tab.inject(panel);
      tab.setProviders(this._providers);
      const { provider, model } = this._defaultOrchestration();
      tab.setDefaultOrchestration(provider, model);
      tab.reset();
      if (councilId) tab.setDefaultCouncilId(councilId);
      await tab.loadCouncils();
    } catch (error) {
      // A half-mounted tab is worse than none: drop it and go back to the list
      // rather than leave a dead editor (and an unhandled rejection) behind.
      console.error('Error opening the council editor:', error);
      if (window.toast) window.toast.showError('Failed to open the council editor');
      this._tab = null;
      this._tabType = null;
      this._editingId = null;
      this._mode = 'list';
      this._render();
    }
  }

  /**
   * Leave the editor: drop the tab, re-fetch the list (a rename or a brand-new
   * council has to show up), and notify the host once if anything changed.
   *
   * @param {Object} [options]
   * @param {boolean} [options.mutated] - A save we own succeeded; notify
   *   unconditionally instead of relying on the list fingerprint.
   */
  async _exitEditor({ mutated = false } = {}) {
    const before = this._listSignature();

    this._tab = null;
    this._tabType = null;
    this._editingId = null;
    this._mode = 'list';
    this._expandedId = null;
    this._error = null;

    await this._fetchAndRender();

    if (mutated || this._listSignature() !== before) {
      this._notifyChanged();
    }
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Save the hosted tab through the same private entry point AnalysisConfigModal
   * uses. `_saveCouncil` resolves to `true` ONLY when a write reached the server
   * and succeeded (see the RETURN CONTRACT in public/js/utils/council-crud.js);
   * every refusal — invalid config, cancelled Save As prompt, swallowed
   * PUT/POST failure — resolves to `false`.
   *
   * REGRESSION GUARD: success used to be inferred from `tab.isDirty` going
   * false. That is wrong on a CLEAN editor, which every refusal path leaves
   * untouched: Add council → Save → cancel the name prompt read as "saved",
   * exited to the list and fired onChange for a council that was never created.
   * Only the explicit signal may unlock the exit.
   */
  async _saveFromEditor() {
    const tab = this._tab;
    if (!tab || this._busy) return;
    this._busy = true;
    let saved = false;
    try {
      saved = await tab._saveCouncil();
    } catch (error) {
      console.error('Error saving council:', error);
      if (window.toast) window.toast.showError('Failed to save council');
      return;
    } finally {
      this._busy = false;
    }
    if (!saved) return;
    await this._exitEditor({ mutated: true });
  }

  /** Back: confirm before discarding unsaved edits, then return to the list. */
  async _backFromEditor() {
    const tab = this._tab;
    if (tab && tab.isDirty) {
      const confirmed = await this._confirm({
        title: 'Discard changes',
        message: 'Discard unsaved changes?',
        confirmText: 'Discard',
        confirmClass: 'btn-danger'
      });
      if (!confirmed) return;
    }
    await this._exitEditor();
  }

  /**
   * Duplicate a council into a new DB council. Mirrors `saveCouncilAs` in
   * public/js/utils/council-crud.js: prefill "<name> (copy)", loop on a
   * case-insensitive name collision so a rejected name is re-offered rather than
   * lost, and POST the ORIGINAL stored config (not a re-read of any UI).
   *
   * File councils are duplicated with their own type — and a legacy row with no
   * type is 'advanced', matching what POST /api/councils defaults to.
   *
   * NOTE: a file council's `description` is DROPPED by the copy. The `councils`
   * table has no description column (src/database.js), so there is nowhere to
   * put it — the field only exists on the file overlay and in the export
   * document format, which is why Export keeps it and this does not.
   */
  async _duplicate(council) {
    if (this._busy) return;

    const dialog = window.textInputDialog;
    if (!dialog) return;

    // Claim the guard BEFORE the first await. Setting it after the name prompt
    // let a double-click enter the handler twice and open a second prompt whose
    // promise could then never settle (the dialog is a singleton).
    this._busy = true;
    try {
      const defaultName = `${council.name} (copy)`;
      let name;
      while (true) {
        name = await dialog.show({
          title: 'Duplicate Council',
          label: 'Council name',
          placeholder: 'Enter a name for this council',
          value: name || defaultName,
          confirmText: 'Save',
          confirmClass: 'btn-primary'
        });
        if (!name) return;
        // DELIBERATE: scans the WHOLE list, across both types and both sources.
        // The tabs' Save As (`saveCouncilAs` in public/js/utils/council-crud.js)
        // scans only its own type-filtered `tab.councils`. There is no
        // server-side UNIQUE on councils.name, so neither is authoritative;
        // do not "align" them without deciding which one is right.
        const duplicate = this._councils.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
        if (!duplicate) break;
        if (window.toast) window.toast.showWarning('A council with that name already exists.');
      }

      const response = await fetch('/api/councils', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config: council.config, type: this._effectiveType(council) })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to duplicate council (${response.status})`);
      }
      this._error = null;
      if (window.toast) window.toast.showSuccess('Council duplicated');
      this._notifyChanged();
      await this._fetchAndRender();
    } catch (error) {
      console.error('Error duplicating council:', error);
      if (window.toast) window.toast.showError('Failed to duplicate council');
      this._error = error && error.message ? error.message : 'Failed to duplicate council';
      this._render();
    } finally {
      this._busy = false;
    }
  }

  /**
   * Export a council as a versioned council document (download + best-effort
   * clipboard copy), straight from the row data — no UI round-trip, so what is
   * exported is exactly what is stored. Legacy untyped rows export as
   * 'advanced'; the document format requires a type.
   */
  async _export(council) {
    const documentApi = window.CouncilDocument;
    if (!documentApi) return;
    try {
      const payload = {
        name: council.name,
        type: this._effectiveType(council),
        config: council.config
      };
      // File councils can carry a description; the format preserves it, so a
      // round-trip through export does too.
      const description = typeof council.description === 'string' ? council.description.trim() : '';
      if (description) payload.description = description;

      const { copied } = documentApi.exportCouncilToFile(payload);
      // `copied` never rejects; it reports whether the clipboard actually took it.
      const wasCopied = await copied;
      if (window.toast) {
        window.toast.showSuccess(
          wasCopied ? 'Council exported and copied to clipboard' : 'Council exported'
        );
      }
    } catch (error) {
      console.error('Failed to export council:', error);
      if (window.toast) window.toast.showError('Failed to export council');
    }
  }

  /** Confirm and DELETE a DB council. File councils never render this button. */
  async _delete(council) {
    if (this._busy) return;

    // Claim the guard BEFORE awaiting the confirmation, not after it resolves:
    // otherwise a double-click runs the handler twice and the second run is only
    // saved from a double DELETE by confirmDialog happening to be a singleton.
    this._busy = true;
    try {
      const confirmed = await this._confirm({
        title: 'Delete Council',
        message: `Are you sure you want to delete "${council.name}"?`,
        confirmText: 'Delete',
        confirmClass: 'btn-danger'
      });
      if (!confirmed) return;

      const response = await fetch(`/api/councils/${encodeURIComponent(council.id)}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to delete council (${response.status})`);
      }
      this._error = null;
      if (window.toast) window.toast.showSuccess('Council deleted');
      this._notifyChanged();
      await this._fetchAndRender();
    } catch (error) {
      console.error('Error deleting council:', error);
      if (window.toast) window.toast.showError('Failed to delete council');
      this._error = error && error.message ? error.message : 'Failed to delete council';
      this._render();
    } finally {
      this._busy = false;
    }
  }

  /**
   * Confirm a destructive action. Prefers the repo's styled confirmDialog (whose
   * result must equal 'confirm' — the repo-wide convention) and falls back to
   * native confirm on a page that does not load it. Returns true to proceed.
   */
  async _confirm({ title, message, confirmText, confirmClass }) {
    const dialog = typeof window !== 'undefined' ? window.confirmDialog : null;
    if (dialog && typeof dialog.show === 'function') {
      const choice = await dialog.show({ title, message, confirmText, confirmClass });
      return choice === 'confirm';
    }
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message);
    }
    return true;
  }

  _notifyChanged() {
    if (this.onChange) {
      try { this.onChange(); } catch (_) { /* callback errors must not break the UI */ }
    }
  }

  // ─── Teardown ──────────────────────────────────────────────────────────────

  destroy() {
    for (const { target, type, handler } of this._docListeners) {
      target.removeEventListener(type, handler);
    }
    this._docListeners = [];
    // The hosted tab has no destroy() of its own (AnalysisConfigModal caches and
    // reuses its tabs the same way); dropping the DOM drops its listeners, and
    // its TimeoutSelects only hold a document listener while they are open.
    this._tab = null;
    this._tabType = null;
    this._editingId = null;
    this._expandedId = null;
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// Make CouncilManager available globally.
if (typeof window !== 'undefined') {
  window.CouncilManager = CouncilManager;
}

// Export for CommonJS testing environments.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CouncilManager };
}
