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
 *     the tab's query root. The tab is constructed with `{ hosted: true }`, which
 *     drops the two regions that only make sense inside AnalysisConfigModal: the
 *     per-review "This Review" block (repo-instructions banner + custom
 *     instructions) and the tab's OWN Save / Save As / Delete row. That leaves
 *     the Save/Back footer below as the SINGLE write surface in editor mode,
 *     which is why `onChange` fires on an explicit mutation signal only — there
 *     is no longer any out-of-band write to infer from the list.
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
   * @param {Array<Object>} [options.providers] - The host page's already-loaded
   *   `GET /api/providers` array. Supplying it skips this component's own fetch
   *   ("pass resolved values down, don't reach up"); omitting it keeps the
   *   component independently mountable on a page that has not loaded them.
   * @param {Object} [options.appConfig] - The host page's already-loaded
   *   `GET /api/config` object, same deal.
   */
  constructor(container, { onChange, providers, appConfig } = {}) {
    this.container = container;
    this.onChange = typeof onChange === 'function' ? onChange : null;

    // View state: 'list' | 'chooser' | 'editor'.
    this._mode = 'list';
    // Latest council list from the API (DB rows first, file rows appended).
    this._councils = [];
    // The raw /api/providers array — resolveProviderModelPair needs the list
    // form (with each provider's `defaultModel` and model aliases), which the
    // map form drops, and so does the preview's name resolution: the map DROPS
    // providers that declare no models, and a council can legitimately name one.
    this._providerList = Array.isArray(providers) ? providers : [];
    // Provider map ({ [providerId]: provider }) for the tabs.
    this._providers = this._buildProviderMap(this._providerList);
    // /api/config, for the page's default provider/model pair.
    this._appConfig = appConfig && typeof appConfig === 'object' ? appConfig : {};
    // Whether the host handed us those two, so _init() can skip the fetches.
    this._providersPreloaded = Array.isArray(providers);
    this._appConfigPreloaded = Boolean(appConfig && typeof appConfig === 'object');
    // Id of the row whose CouncilCard preview is expanded (null = none).
    this._expandedId = null;
    // Guards against overlapping saves/deletes/duplicates.
    this._busy = false;
    // Last error message to surface in the banner (null when clear).
    this._error = null;

    // Editor state.
    this._tab = null;          // the hosted config tab instance, PUBLISHED ONLY
                               // once its async mount has fully resolved
    // Bumped by every editor open and every exit. A mount that spans an await
    // compares it before publishing, so an editor the user has already left (or
    // replaced) can never install its tab over the current view.
    this._editorEpoch = 0;

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

  /**
   * First paint: providers, app defaults and councils in parallel, then render.
   * The two the host already loaded (see the constructor options) are not
   * re-fetched — the page would otherwise hit /api/providers and /api/config
   * twice on every settings load.
   */
  async _init() {
    const loads = [this._loadCouncils()];
    if (!this._providersPreloaded) loads.push(this._loadProviders());
    if (!this._appConfigPreloaded) loads.push(this._loadAppConfig());
    await Promise.all(loads);
    this._render();
  }

  /** `window.ProviderMap.buildProviderMap`, resolved at call time. */
  _buildProviderMap(providerList) {
    const providerMap = window.ProviderMap;
    return providerMap ? providerMap.buildProviderMap(providerList) : {};
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
      this._providerList = Array.isArray(data.providers) ? data.providers : [];
      this._providers = this._buildProviderMap(this._providerList);
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
    // The pair is handed to setDefaultOrchestration as-is: canonicalizing a
    // configured alias to the id the model `<select>` carries as an option is
    // the TAB's job (it owns the select), and doing it here as well produced two
    // copies of the same alias table that could disagree.
    return { provider: pair.provider, model: pair.model };
  }

  /**
   * Refresh the council list.
   *
   * A FAILED refresh leaves `this._councils` alone. "The request failed" and
   * "you have no councils" are different states, and every mutation path ends
   * in `_fetchAndRender()` — so collapsing them meant one flaky GET right after
   * a successful delete wiped every known-good row off the screen and captioned
   * it "No councils yet." The stale rows under the error banner are truthful
   * (they are what we last knew) and recoverable (the next mutation re-fetches).
   * `_buildList` suppresses the empty state while `_error` is set, so the two
   * messages can never contradict each other.
   */
  async _loadCouncils() {
    try {
      const response = await fetch('/api/councils');
      if (!response.ok) throw new Error(`Failed to load councils (${response.status})`);
      const data = await response.json();
      this._councils = Array.isArray(data.councils) ? data.councils : [];
      this._error = null;
    } catch (error) {
      this._error = error && error.message ? error.message : 'Failed to load councils';
    }
  }

  async _fetchAndRender() {
    await this._loadCouncils();
    this._render();
  }

  // ─── Council helpers ───────────────────────────────────────────────────────

  /** File-overlay councils are read-only: no Edit, no Delete (the API 400s). */
  _isReadOnly(council) {
    return council?.readOnly === true || council?.source === 'file';
  }

  /**
   * The type literal to send to the API / the document builder. Anything that
   * is not exactly `'council'` — including an untyped row — is level-centric
   * here, matching `AdvancedConfigTab.COUNCIL_CRUD_SPEC.councilFilter`'s
   * `!c.type || c.type === 'advanced'`. Untyped rows do not come from any
   * current write path (every one of them defaults the column to 'advanced');
   * tolerating them is defensive, and Advanced is where they belong because
   * level-keyed config is the shape they would hold.
   */
  _effectiveType(council) {
    return council?.type === 'council' ? 'council' : 'advanced';
  }

  /**
   * Resolve provider/model ids to display names for the CouncilCard preview,
   * which has no page knowledge of its own.
   *
   * Delegates to the ONE shared, alias-aware implementation in
   * public/js/utils/provider-map.js — repo-settings.js, settings.js and this
   * file each grew their own copy and the three had already drifted apart
   * (alias-blindness here and in settings.js, and a map-vs-array split that made
   * two cards on the SAME settings page disagree about a provider's name).
   *
   * The RAW `_providerList` goes in, not `_providers`: `buildProviderMap` drops
   * providers that declare no models, and a council may name one — resolving
   * from the map printed the bare id (`opencode`) where the card above it
   * printed `OpenCode`.
   */
  _resolveModelDisplay(providerId, modelId) {
    const providerMap = window.ProviderMap;
    if (providerMap && typeof providerMap.resolveModelDisplay === 'function') {
      return providerMap.resolveModelDisplay(this._providerList, providerId, modelId);
    }
    return { providerName: providerId || 'Unknown', modelName: modelId || 'Unknown' };
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

    // "No councils yet." is a claim about the account, and only a SUCCESSFUL
    // load can make it. While `_error` is set the list is unknown, not empty:
    // the banner above already says what went wrong, and whatever rows we last
    // knew about stay on screen under it (see `_loadCouncils`).
    if (this._councils.length === 0 && !this._error) {
      const empty = document.createElement('div');
      empty.className = 'council-manager__empty';
      empty.textContent = 'No councils yet.';
      wrap.appendChild(empty);
    } else if (this._councils.length > 0) {
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
      // The badge is fed the EFFECTIVE type, so an untyped row badges as
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
   *   new TabClass(wrapper, { hosted: true }) → inject(panel) →
   *   setProviders(map) → setDefaultOrchestration(pair) → reset() →
   *   [setDefaultCouncilId(id)] → await loadCouncils() → PUBLISH `this._tab`
   *
   * The wrapper div — not the panel — is the tab's constructor argument: the tab
   * plays `this.modal.querySelector('#tab-panel-…')` against it. `hosted: true`
   * drops the per-review "This Review" region and the tab's own Save / Save As /
   * Delete row, neither of which belongs on a global settings page.
   *
   * >>> THE TAB IS PUBLISHED LAST, AND THE FOOTER SAVE STARTS DISABLED.
   * `loadCouncils()` is a round trip, and `setDefaultCouncilId(id)` only records
   * a PENDING id until `_renderCouncilSelector()` runs at the END of it — so for
   * the whole GET the tab's `selectedCouncilId` is still null and its UI still
   * shows `reset()` defaults. A Save in that window would fail `saveCouncil`'s
   * selection test and fork a BRAND NEW council out of default config while the
   * header said "Edit council". Publishing late makes `_saveFromEditor`'s null
   * check inert-by-construction; the disabled button makes it visible.
   *
   * A load that FAILS tears the editor back down (see the C3 boolean contract on
   * `loadCouncils`): the alternative is an "Edit council" pane permanently stuck
   * in the no-selection state, where every later Save forks a copy instead.
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

    // Claim this open. Anything still in flight from a previous one (or from an
    // exit that happened while we were mounting) is now stale and must not
    // publish itself over the editor we are about to build.
    const epoch = ++this._editorEpoch;

    this._mode = 'editor';
    this._tab = null;
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
    // The tab looks its own panel up by id, so this node has to be named
    // exactly what the tab will query for. The canonical id lives on the tab's
    // `COUNCIL_CRUD_SPEC.panelId`; it is repeated rather than read from there
    // deliberately, because everything up to the try/catch below runs
    // unguarded and `TabClass` is whatever was on `window` — reaching into a
    // static here turns a broken tab class into an unhandled throw instead of
    // the "Failed to open the council editor" recovery. The two copies are
    // pinned together by council-manager.test.js, and divergence is silent
    // (the tab finds no panel; every button-state refresh no-ops).
    panel.id = type === 'council' ? 'tab-panel-council' : 'tab-panel-advanced';
    wrapper.appendChild(panel);
    root.appendChild(wrapper);

    const footer = document.createElement('div');
    footer.className = 'council-manager__editor-footer';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'council-manager__save-btn';
    saveBtn.textContent = 'Save';
    // Armed by _syncFooterButtons() once the mount below resolves.
    saveBtn.disabled = true;
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

    // Set at the two failure sites below that have something a user can act on;
    // the catch puts it in the list banner. Stays null for anything unexpected.
    let userMessage = null;

    try {
      const tab = new TabClass(wrapper, { hosted: true });
      tab.inject(panel);
      tab.setProviders(this._providers);
      const { provider, model } = this._defaultOrchestration();
      tab.setDefaultOrchestration(provider, model);
      tab.reset();
      if (councilId) tab.setDefaultCouncilId(councilId);
      // `loadCouncils` swallows its own fetch error, so the promise resolving is
      // NOT proof the selector rendered — only the boolean is. An explicit
      // `false` is the failure signal; anything else (including a tab that
      // predates the contract) counts as mounted.
      const loaded = await tab.loadCouncils();
      if (loaded === false) {
        userMessage = 'Could not load your councils. Please try again.';
        throw new Error(userMessage);
      }
      // Asked to EDIT something the tab could not select. `loadCouncils`
      // succeeded, so this is not a transport failure: the council was deleted
      // (another tab, another window, a file-overlay reload) between the list
      // paint that drew the Edit button and this load, and
      // `_renderCouncilSelector` consumes the pending id whether or not it
      // finds a match. Leaving the editor up would label it "Edit council" over
      // a NULL selection, and the next Save would fail council-crud's selection
      // test and fork a brand-new council from whatever the UI happens to show
      // — the same silent Edit-becomes-Create this mount order exists to
      // prevent, arriving through a different door.
      if (councilId && tab.selectedCouncilId !== councilId) {
        userMessage = 'That council is no longer available.';
        throw new Error(userMessage);
      }
      // The user left (or re-opened) the editor while the GET was in flight —
      // that view owns the container now; this tab is garbage.
      if (this._editorEpoch !== epoch) return;
      this._tab = tab;
      // Dirty state and the selected council both move under the tab's own
      // hand; the footer Save and the header both gate on them. The tab fires
      // this on every such transition. The identity check drops callbacks from
      // a tab this manager has already dropped (`_exitEditor` nulls `_tab`).
      tab.onStateChange = () => { if (this._tab === tab) this._syncEditorState(); };
      this._syncEditorState();
    } catch (error) {
      // A half-mounted tab is worse than none: drop it and go back to the list
      // rather than leave a dead editor (and an unhandled rejection) behind.
      //
      // `userMessage` separates the two kinds of failure. A council that was
      // deleted elsewhere, or a council list that would not load, is an
      // EXPECTED condition this component handles and explains in the banner —
      // a warning. Anything else is a real defect and keeps its error trace.
      if (userMessage) {
        console.warn('Council editor not opened:', error);
      } else {
        console.error('Error opening the council editor:', error);
      }
      // A mount that lost its claim has no UI left to complain about — the view
      // on screen belongs to a later open (or to the list).
      if (this._editorEpoch !== epoch) return;
      if (window.toast) window.toast.showError('Failed to open the council editor');
      this._tab = null;
      this._mode = 'list';
      // The toast is transient; the banner says WHY the editor closed. Only the
      // two messages this method authored qualify — an internal exception
      // ("boom" from a broken tab class) belongs in the console, not in the UI.
      this._error = userMessage;
      this._render();
    }
  }

  /**
   * Leave the editor: drop the tab, re-fetch the list (a rename or a brand-new
   * council has to show up), and notify the host iff a write actually happened.
   *
   * `mutated` is the ONLY signal. This used to fall back to diffing a
   * `{id, name, updated_at}` fingerprint of the list, because the hosted tab
   * rendered its own Save / Save As / Delete row and wrote behind our back. Two
   * things were wrong with that: SQLite's `CURRENT_TIMESTAMP` has one-second
   * resolution and the fingerprint ignored config content, so a same-second
   * in-place edit read as "nothing changed" and the settings page's
   * Default-for-Analysis picker silently kept stale rows. The hosted tab no
   * longer renders that row at all (`hosted: true`), so the footer Save below is
   * the only write surface and the heuristic has nothing left to guess at.
   *
   * @param {Object} [options]
   * @param {boolean} [options.mutated] - A save we own succeeded.
   */
  async _exitEditor({ mutated = false } = {}) {
    // Any mount still in flight belongs to an editor that no longer exists.
    this._editorEpoch++;

    this._tab = null;
    this._mode = 'list';
    this._expandedId = null;
    this._error = null;

    await this._fetchAndRender();

    if (mutated) this._notifyChanged();
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Claim or release the single-mutation guard, keeping the editor footer in
   * step with it. Every path that sets `_busy` goes through here so the guard is
   * VISIBLE — a live-looking Save or Back that silently no-ops reads as a broken
   * button. The row buttons in list mode are left alone: `_busy` is only ever
   * held there across a modal dialog, which already blocks the page.
   *
   * @param {boolean} busy
   */
  _setBusy(busy) {
    this._busy = busy;
    this._syncFooterButtons();
  }

  /**
   * Footer button states. Save is live only when no mutation is in flight and
   * the published tab holds a writable change (see `_canSave`); Back only when
   * nothing is in flight. Queried rather than cached: in list mode there is no
   * footer and both lookups are a harmless null.
   */
  _syncFooterButtons() {
    if (!this.container) return;
    const saveBtn = this.container.querySelector('.council-manager__save-btn');
    if (saveBtn) saveBtn.disabled = this._busy || !this._canSave();
    const backBtn = this.container.querySelector('.council-manager__back-btn');
    if (backBtn) backBtn.disabled = this._busy;
  }

  /**
   * Is there something Save can legitimately write?
   *
   * This footer REPLACES the tab's own write row, so it has to carry the gates
   * that row carried: `!isDirty || !selectedCouncilId || isFile`. Without them
   * an Edit → Save with zero edits rewrites the whole config from
   * `_readConfigFromUI()` — something no surface in the app could do before —
   * and every stored value that does not round-trip is lost on the way.
   *
   * The `selectedCouncilId` half is INVERTED here, deliberately. In the tab, no
   * selection meant "nothing to update, use Save As". Here there is no Save As:
   * this button IS the create path, and `reset()` leaves a brand-new editor
   * CLEAN — so gating on dirty alone would make creating a council impossible.
   * Hence: no selection => always live; a selection => only when dirty.
   *
   * File councils are refused outright, and the proof is the ID, not a row from
   * `this._councils`. `tab._isFileCouncil` -> `CouncilCrud.isFileCouncilId` is
   * the same helper the tab's own Save row gates on, so the two gates cannot
   * disagree, and it still holds when the list is empty or stale — which it can
   * be: `_loadCouncils` deliberately keeps the previous array on a failed
   * refresh, and it is a different array from `tab.councils`, fetched at a
   * different moment. A list lookup would answer a MISS as `undefined`, and
   * `_isReadOnly(undefined)` is falsy — so "not in my list" would silently read
   * as "writable". The hosted tab keeps its council `<select>`, so the user can
   * point the editor at a council this list does not contain; Save would light
   * up on a `file:` id the API then 403s. `_isReadOnly` stays where the fetched
   * `source`/`readOnly` fields are authoritative: rendering the list rows.
   *
   * The API 400s PUT and DELETE on `file:` ids, so an in-place save there cannot
   * succeed; the list's Duplicate button is the path that turns one into an
   * editable copy.
   *
   * @returns {boolean}
   */
  _canSave() {
    const tab = this._tab;
    if (!tab) return false;
    const selectedId = tab.selectedCouncilId;
    if (!selectedId) return true;
    if (tab._isFileCouncil(selectedId)) return false;
    return Boolean(tab.isDirty);
  }

  /**
   * Keep the editor header on the council Save actually writes to.
   *
   * The header is set once at `_openEditor`, but the tab's council `<select>`
   * survives in hosted mode (only the write row is dropped) and its change
   * handler reassigns `selectedCouncilId` — which is the only thing
   * `CouncilCrud.saveCouncil` branches on. So Add → pick "Dream Team" → Save
   * updates Dream Team under a header still reading "New council". The write is
   * what the selector implies; the stale label is the defect.
   */
  _syncEditorHeader() {
    if (!this.container || !this._tab) return;
    const header = this.container.querySelector('.council-manager__editor-header');
    if (header) header.textContent = this._tab.selectedCouncilId ? 'Edit council' : 'New council';
  }

  /** Both halves of the editor chrome, for the tab's state subscription. */
  _syncEditorState() {
    this._syncEditorHeader();
    this._syncFooterButtons();
  }

  /**
   * The tail every successful mutation shares: clear the banner, confirm it to
   * the user, repaint from the server, and only THEN tell the host.
   *
   * >>> NOTIFY AFTER THE REFETCH, NOT BEFORE.
   * `_duplicate` and `_delete` used to notify first, which put the host's
   * `refreshCouncilRows()` GET in flight alongside our own — two parallel
   * `GET /api/councils` per mutation, and a host repainting from a response
   * that raced ours. `_exitEditor` already notified last, so the same
   * three-step sequence existed in two orders. Notifying last also means the
   * host is called with this component's view already settled, which is the
   * only order that makes "onChange fires when the change is visible" true.
   * The cost is that the host's refresh starts one round trip later; that is
   * deliberate, and cheap next to a duplicated fetch.
   *
   * @param {string} successMessage - Toast text for the completed mutation.
   */
  async _afterMutation(successMessage) {
    this._error = null;
    if (window.toast) window.toast.showSuccess(successMessage);
    await this._fetchAndRender();
    this._notifyChanged();
  }

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
   *
   * The guard is held across `_exitEditor` too, not released at the end of the
   * write: the exit is itself a round trip (`_fetchAndRender`), and releasing
   * early re-opened the window where Back could run over a save in progress.
   */
  async _saveFromEditor() {
    const tab = this._tab;
    if (!tab || this._busy) return;
    this._setBusy(true);
    try {
      let saved = false;
      try {
        saved = await tab._saveCouncil();
      } catch (error) {
        console.error('Error saving council:', error);
        if (window.toast) window.toast.showError('Failed to save council');
        return;
      }
      if (!saved) return;
      if (this._tab !== tab) {
        // The editor we saved is no longer the one on screen (a destroy(), or a
        // re-open driven straight through _openEditor). The write DID land, so
        // the host still has to hear about it — but tearing down whatever is
        // mounted now would discard an unrelated edit.
        this._notifyChanged();
        return;
      }
      await this._exitEditor({ mutated: true });
    } finally {
      this._setBusy(false);
    }
  }

  /**
   * Back: confirm before discarding unsaved edits, then return to the list.
   *
   * Guarded by `_busy` like every other mutation path. Without it Back stayed
   * live for the whole duration of a save: "Discard unsaved changes?" would pop
   * over a POST that was already committing, and answering Discard ran
   * `_exitEditor()` once immediately and again when the save resolved — two
   * re-fetches and two onChange notifications for one write.
   */
  async _backFromEditor() {
    if (this._busy) return;
    this._setBusy(true);
    try {
      const tab = this._tab;
      if (tab && tab.isDirty) {
        const confirmed = await this._confirm({
          title: 'Discard changes',
          message: 'Discard unsaved changes?',
          confirmText: 'Discard',
          confirmClass: 'btn-danger'
        });
        if (!confirmed) return;
        // The editor could have been replaced while the dialog was open.
        if (this._tab !== tab) return;
      }
      await this._exitEditor();
    } finally {
      this._setBusy(false);
    }
  }

  /**
   * Duplicate a council into a new DB council. Mirrors `saveCouncilAs` in
   * public/js/utils/council-crud.js: prefill "<name> (copy)", loop on a
   * case-insensitive name collision so a rejected name is re-offered rather than
   * lost, and POST the ORIGINAL stored config (not a re-read of any UI).
   *
   * File councils are duplicated with their own type — and a row with no type
   * is 'advanced', matching what POST /api/councils defaults to.
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
    this._setBusy(true);
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
        // Scans the WHOLE list, across both types and both sources — and the
        // tabs' Save As (`saveCouncilAs` in public/js/utils/council-crud.js) now
        // does the same, via the unfiltered `tab._allCouncils`. The two used to
        // disagree, Save As scanning only its own type-filtered `tab.councils`.
        //
        // Whole-list is the correct rule, and the reason is outside this file:
        // `--council <name>` resolves by name in src/councils/resolve-council.js
        // at tier 3 (exact, case-insensitive), tier 4 (normalized) and tier 5
        // (fragment), and every one of those throws on more than one match. A
        // Standard council saved under a name an Advanced council already holds
        // therefore breaks the handle for BOTH; only the raw uuid still works.
        // There is no server-side UNIQUE on councils.name to catch it, so these
        // two client-side scans are the only guard — keep them aligned.
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
      await this._afterMutation('Council duplicated');
    } catch (error) {
      console.error('Error duplicating council:', error);
      if (window.toast) window.toast.showError('Failed to duplicate council');
      this._error = error && error.message ? error.message : 'Failed to duplicate council';
      this._render();
    } finally {
      this._setBusy(false);
    }
  }

  /**
   * Export a council as a versioned council document (download + best-effort
   * clipboard copy), straight from the row data — no UI round-trip, so what is
   * exported is exactly what is stored. An untyped row exports as
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
    this._setBusy(true);
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
      await this._afterMutation('Council deleted');
    } catch (error) {
      console.error('Error deleting council:', error);
      if (window.toast) window.toast.showError('Failed to delete council');
      this._error = error && error.message ? error.message : 'Failed to delete council';
      this._render();
    } finally {
      this._setBusy(false);
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
    // Abandon any editor mount still in flight, so it cannot publish a tab into
    // a component that has already been torn down.
    this._editorEpoch++;
    // The hosted tab has no destroy() of its own (AnalysisConfigModal caches and
    // reuses its tabs the same way); dropping the DOM drops its listeners, and
    // its TimeoutSelects only hold a document listener while they are open.
    this._tab = null;
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
