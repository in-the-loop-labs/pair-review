// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared behaviour for the two council config tabs.
 *
 * VoiceCentricConfigTab and AdvancedConfigTab present the same council editor
 * over two different config formats. Everything about it is the same — the
 * council `<select>` and how a pending default lands in it, the validity gate,
 * the file-council fork, the duplicate name scan, the request shapes, the
 * post-write selector refresh, the dirty-state bookkeeping, the Save / Save As
 * / Export / Delete enablement, the character-count chrome, the council-list
 * load and the pre-analysis auto-save. What differs is a handful of values,
 * and every one of them is carried in the per-tab `spec`
 * (`TabClass.COUNCIL_CRUD_SPEC`): the API type literal, the tab's own element
 * ids, its static default timeout, its auto-save name prefix, and its
 * council-list filter.
 *
 * >>> TWO SPEC VALUES CARRY BEHAVIOUR AND MUST STAY PER-TAB. They look like
 * incidental drift and are not:
 *
 *   - `councilFilter` is ASYMMETRIC on purpose. Voice takes
 *     `c.type === 'council'`; Advanced takes `!c.type || c.type === 'advanced'`.
 *     The `!c.type` half is NOT about legacy data — no current write path can
 *     produce an untyped row. `councils.type` is declared `TEXT DEFAULT
 *     'advanced'` (src/database.js), migration 18 added the column with that
 *     same constant default and SQLite applies a constant ADD COLUMN default to
 *     every pre-existing row, so the very rows a "legacy" reading would be about
 *     read back as `'advanced'`; the only create call site defaults
 *     `type = 'advanced'` (`CouncilRepository.create`), POST /api/councils
 *     coerces `type || 'advanced'`, and a file-overlay council cannot be untyped
 *     either (`parseCouncilDocument` throws unless the document says exactly
 *     'council' or 'advanced'). `!c.type` is defensive tolerance for a row
 *     nothing writes.
 *
 *     What the asymmetry actually protects is the LITERALS. The two tabs render
 *     two different config shapes (voice-centric vs level-centric), and a
 *     council of the other shape has nothing for this tab's inputs to bind to —
 *     it would open as blank defaults, and the next Save would write those
 *     defaults back over it. So each predicate must keep claiming exactly its
 *     own shape: widen either one and a council surfaces in the tab that cannot
 *     edit it. `CouncilCard`, `CouncilDropdown` and `CouncilManager` all cite
 *     this rule (they name `COUNCIL_CRUD_SPEC.councilFilter`). Do not "unify"
 *     it.
 *   - `autoSaveNamePrefix` is 'Council' for Voice and 'Advanced' for Advanced —
 *     the persisted `type` column literals, so a generated name survives a badge
 *     rename (CouncilDropdown renders type 'council' as the badge "Standard").
 *
 * Both tabs keep a method of their own for each of these and delegate from
 * inside the body, so each flow exists in exactly one place while the tab
 * methods stay the public, overridable surface. See `council-export.js` for the
 * same arrangement over the Export button.
 *
 * >>> FOUR EXPORTS SIT OUTSIDE THAT REMIT. They are not council-flow functions
 * and they do not all take `(tab, spec)`. They live here for one reason — both
 * tabs need them and there is no better home yet:
 *
 *   - `syncTierToModel(modelSelect)` takes NEITHER `tab` NOR `spec`, and that is
 *     deliberate: it is a pure DOM helper over `.voice-row` / `.voice-tier` with
 *     nothing per-tab to parameterise, so it breaks this module's calling
 *     convention on purpose rather than carrying two arguments it would ignore.
 *     It is also the TAIL of `_updateModelDropdown`, which is STILL DUPLICATED
 *     in both tabs — so the extraction boundary currently cuts through the
 *     middle of one flow (the dropdown repaint does the same tier sync inline,
 *     off the model list rather than off the option's `data-tier`). Pulling
 *     `_updateModelDropdown` across is tracked as a follow-up.
 *   - `applyModelSelection(tab, modelSelect, providerId, modelId)` needs
 *     `tab.providers` and nothing from the spec.
 *   - `getProviderDefaultTimeout(tab, spec, providerId)` is provider/timeout
 *     resolution; `spec.defaultTimeout` exists solely to serve it.
 *   - `formatTimestamp(date)` is date formatting that only happens to be used by
 *     `autoSaveIfDirty`.
 *
 * Dispatch runs BACK THROUGH THE TAB (`tab._saveCouncilAs()`, not
 * `saveCouncilAs(tab, spec)`): the tab methods are the public, overridable
 * surface, and the tabs' own callers (AnalysisConfigModal, CouncilManager,
 * autoSaveIfDirty) already reach them that way.
 *
 * Collaborators (`window.toast`, `window.textInputDialog`,
 * `window.confirmDialog`) are resolved at CALL time, never at load time —
 * matching how the tabs already reach them, and keeping script order a
 * non-issue.
 *
 * >>> NULL TOLERANCE: `updateDirtyHint`, `updateSaveButtonStates` and
 * `updateCharCount` reach for nodes the MODAL owns, not the tab —
 * `#council-footer-left`, `[data-action="submit"]`, and (when hosted) the tab's
 * whole action row. The settings-page host has none of them. Every one of those
 * lookups must keep its guard; dropping one turns /settings into a throw.
 *
 * >>> ERROR REPORTING: a failed write surfaces the SERVER's message when it
 * sent one (see `errorFromResponse`), and the tab validator's own `error` when
 * the refusal is local. The fixed 'Failed to save council' string is the last
 * resort, not the default — on /settings that toast is the only feedback there
 * is.
 *
 * >>> RETURN CONTRACT: every WRITE function here — `saveCouncil`,
 * `saveCouncilAs`, `putCouncil`, `postCouncil`, `deleteCouncil` — resolves to a
 * BOOLEAN: `true` iff a write actually reached the server and succeeded,
 * `false` on every refusal (invalid config, cancelled name prompt, missing
 * dialog, swallowed request error). Nothing rejects. Callers that only
 * fire-and-forget (the tabs' own panel buttons, AnalysisConfigModal) may keep
 * ignoring it; a caller that has to know whether the write happened —
 * CouncilManager's editor footer, which exits to the list and fires onChange —
 * MUST read it. Deducing success from `tab.isDirty` does not work: a Save on an
 * already-clean editor is refused without ever going dirty, so "not dirty"
 * reads as "saved". `loadCouncils` carries its own boolean contract (documented
 * on it); the remaining helpers return what their names imply.
 *
 * Loaded in the browser as `window.CouncilCrud`; also exported via CommonJS for
 * unit tests. No DOM access at load time.
 *
 * @typedef {Object} CouncilCrudSpec
 * @property {string} type - Council type literal for the API ('council' | 'advanced')
 * @property {string} selectorId - CSS selector for the tab's council <select>
 * @property {string} panelId - CSS selector for the tab's own panel inside the host
 * @property {string} saveBtnId - CSS selector for the tab's Save button
 * @property {string} saveAsBtnId - CSS selector for the tab's Save As button
 * @property {string} exportBtnId - CSS selector for the tab's Export button
 * @property {string} deleteBtnId - CSS selector for the tab's Delete button
 * @property {string} charCountId - CSS selector for the custom-instructions character counter
 * @property {string} charCountContainerId - CSS selector for the counter's container (carries the warning/error class)
 * @property {string} instructionsId - CSS selector for the custom-instructions <textarea>
 * @property {number} defaultTimeout - The tab class's static DEFAULT_TIMEOUT, used when a provider declares none
 * @property {string} autoSaveNamePrefix - Prefix for an auto-saved council's generated name ('Council' | 'Advanced')
 * @property {function(Object): boolean} councilFilter - Predicate choosing which councils this tab's selector shows
 */

/**
 * Last-resort text when the tab's validator reports invalid without saying why.
 * `_validateConfig` returns `{ valid, error }` and its `error` is always
 * preferred — this only covers a stub/subclass that answers `{ valid: false }`
 * bare.
 */
const INVALID_CONFIG_MESSAGE = 'At least one review level must be enabled.';

/**
 * Build the Error for a non-ok council request, preferring the server's own
 * diagnosis over the bare status line.
 *
 * The API answers a 400 with `{ error: '...' }` naming the actual problem
 * ('config.voices must be a non-empty array', "Existing config is incompatible
 * with type 'council': …"). Throwing on the status alone discards all of it,
 * and on the settings page — where the council editor is the primary place
 * people author councils and no console is open — that message is the entire
 * feedback the user gets.
 *
 * An error response is NOT guaranteed to be JSON: a proxy's 502 is HTML, an
 * aborted request has no body at all, and a caller's stub response may not even
 * have a `.json` method. Every one of those is a parse failure, so the read is
 * best-effort and falls back to the status line. Mirrors
 * `CouncilManager._duplicate`.
 *
 * @param {Response} response - The failed response
 * @param {string} fallbackMessage - Status-line message when the body says nothing
 * @returns {Promise<Error>} Never rejects
 */
async function errorFromResponse(response, fallbackMessage) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const serverMessage = data && typeof data.error === 'string' ? data.error.trim() : '';
  return new Error(serverMessage || fallbackMessage);
}

/**
 * The message to show for a write that failed. Surfaces whatever
 * `errorFromResponse` (or a thrown network error) carried; the fixed string is
 * only for an error with no message at all.
 *
 * @param {*} error - The caught value
 * @param {string} fallbackMessage
 * @returns {string}
 */
function failureMessage(error, fallbackMessage) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  return message || fallbackMessage;
}

/**
 * Point a council `<select>` at an id and carry the "+ New Council" styling with
 * it. The two steps always travel together — a `<select>` sitting on '' without
 * the class (or on a real council with it) is the visual half of a model/view
 * disagreement — so they live in one place rather than in the four that used to
 * spell them out: `syncSelectorToSelection`, `deleteCouncil`'s reset, and both
 * branches of `renderCouncilSelector`.
 *
 * DOM only, on purpose: `tab.selectedCouncilId` is written by whoever DECIDED
 * the id, not by the helper that paints it. `renderCouncilSelector` is the one
 * caller that decides, and it verifies the id against `tab.councils` first.
 *
 * @param {HTMLSelectElement} selector - The tab's council <select>
 * @param {string|null|undefined} councilId - Id to select; falsy means "+ New Council"
 */
function applySelectorValue(selector, councilId) {
  const value = councilId || '';
  selector.value = value;
  selector.classList.toggle('new-council-selected', !value);
}

/**
 * Point the tab's council `<select>` at the currently selected council and drop
 * the "+ New Council" styling. Runs after a successful write, once the reloaded
 * list has repopulated the options.
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 */
function syncSelectorToSelection(tab, spec) {
  const selector = tab.modal.querySelector(spec.selectorId);
  if (selector) applySelectorValue(selector, tab.selectedCouncilId);
}

/**
 * Save the live config over the selected council.
 *
 * Forks a copy (Save As) rather than updating in place in two cases: nothing is
 * selected, and — the file-overlay case — the selection is a read-only file
 * council, which the API refuses to PUT. Both forks are RETURNED, so a caller
 * that awaits Save does not race the POST the fork performs.
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @returns {Promise<boolean>} true iff a council was written (see RETURN CONTRACT)
 */
async function saveCouncil(tab, spec) {
  const config = tab._readConfigFromUI();
  const { valid, error: validationError } = tab._validateConfig(config);
  if (!valid) {
    if (window.toast) window.toast.showWarning(validationError || INVALID_CONFIG_MESSAGE);
    return false;
  }
  if (tab.selectedCouncilId) {
    // A file council cannot be PUT — fork a copy instead (mirrors the
    // no-selection branch below).
    // `await` (not a bare `return`) so the boolean contract holds even if a
    // subclass/stub returns something else; the fork is still awaited either
    // way, so a caller that awaits Save never races the POST.
    if (tab._isFileCouncil(tab.selectedCouncilId)) {
      return Boolean(await tab._saveCouncilAs());
    }
    try {
      await tab._putCouncil(tab.selectedCouncilId, config);
    } catch (error) {
      console.error('Error saving council:', error);
      if (window.toast) window.toast.showError(failureMessage(error, 'Failed to save council'));
      return false;
    }
    return true;
  }
  return Boolean(await tab._saveCouncilAs());
}

/**
 * Prompt for a name and POST the live config as a new council.
 *
 * The prompt loops until the name is free or the user cancels; a rejected name
 * is re-offered so an edit is never lost to the bounce.
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @returns {Promise<boolean>} true iff a council was created (see RETURN CONTRACT)
 */
async function saveCouncilAs(tab, spec) {
  const config = tab._readConfigFromUI();
  const { valid, error: validationError } = tab._validateConfig(config);
  if (!valid) {
    if (window.toast) window.toast.showWarning(validationError || INVALID_CONFIG_MESSAGE);
    return false;
  }

  const dialog = window.textInputDialog;
  if (!dialog) return false;
  const currentCouncil = tab.selectedCouncilId
    ? tab.councils.find(c => c.id === tab.selectedCouncilId)
    : null;
  // A file council is forked, not renamed: offering its own name would trip
  // the duplicate scan below on the very first prompt, so seed "<name> (copy)".
  const isFile = tab._isFileCouncil(tab.selectedCouncilId);
  const defaultName = isFile && currentCouncil
    ? `${currentCouncil.name} (copy)`
    : (currentCouncil?.name || '');
  let name;
  while (true) {
    name = await dialog.show({
      title: 'Save Council As',
      label: 'Council name',
      placeholder: 'Enter a name for this council',
      value: name || defaultName,
      confirmText: 'Save',
      confirmClass: 'btn-primary'
    });
    if (!name) return false;
    // Scans the WHOLE council list — both types, both sources — matching
    // `CouncilManager._duplicate`. Scanning only `tab.councils` (already
    // filtered to this tab's own type) is not harmless: `--council <name>`
    // resolves by name in src/councils/resolve-council.js at tier 3 (exact,
    // case-insensitive), tier 4 (normalized) and tier 5 (fragment), and EVERY
    // one of those throws `_ambiguityError` on more than one match. So a
    // Standard council saved here under a name an Advanced council already
    // holds permanently breaks the handle for BOTH; only the raw uuid still
    // works. A UNIQUE constraint on councils.name was considered and rejected —
    // it needs a migration against DBs that may already hold duplicates, and it
    // still would not cover tiers 4 and 5 ("Dream Team" and "dream-team" are
    // distinct under UNIQUE, identical under normalizeForMatch).
    //
    // NOTE the deliberate asymmetry with the CLI. `pair-review council` runs
    // every create/rename through `findCouncilNameCollision`
    // (src/councils/resolve-council.js), which rejects the WIDER slug space the
    // resolver actually matches in: exact name, slugified name, and a file
    // council's filename stem. This scan and `CouncilManager._duplicate` still
    // use the narrower name-equality rule, so the UI accepts a name the CLI
    // would refuse ("dream-team" alongside "Dream Team"). Widening them is a
    // frontend change with its own E2E surface; until then, do not read either
    // client-side scan as the guarantee — the CLI's helper is the stricter one.
    //
    // `_allCouncils` is the unfiltered response stashed by `loadCouncils`; a tab
    // that never loaded (or a stubbed context) falls back to the filtered list,
    // which is the strictly narrower scan it used to do.
    const scanList = tab._allCouncils || tab.councils || [];
    const duplicate = scanList.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
    if (!duplicate) break;
    if (window.toast) window.toast.showWarning('A council with that name already exists.');
  }
  try {
    await tab._postCouncil(name, config);
  } catch (error) {
    console.error('Error saving council:', error);
    if (window.toast) window.toast.showError(failureMessage(error, 'Failed to save council'));
    return false;
  }
  return true;
}

/**
 * PUT (update) an existing council by ID.
 * Handles fetch, response check, markClean, and selector refresh.
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @param {string} councilId - The council ID to update
 * @param {Object} config - The council configuration to save
 * @returns {Promise<boolean>} always true — a failed request REJECTS here,
 *   carrying the server's own message when it sent one (the callers above
 *   translate that into `false` and toast the message)
 */
async function putCouncil(tab, spec, councilId, config) {
  const response = await fetch(`/api/councils/${councilId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, type: spec.type })
  });
  if (!response.ok) {
    throw await errorFromResponse(response, `PUT /api/councils/${councilId} failed: ${response.status}`);
  }
  tab._markClean();
  await tab.loadCouncils();
  syncSelectorToSelection(tab, spec);
  return true;
}

/**
 * POST (create) a new council with the given name.
 * Handles fetch, response check, markClean, selector refresh, and selection update.
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @param {string} name - The name for the new council
 * @param {Object} config - The council configuration to save
 * @returns {Promise<boolean>} always true — a failed request REJECTS here,
 *   carrying the server's own message when it sent one (the callers above
 *   translate that into `false` and toast the message)
 */
async function postCouncil(tab, spec, name, config) {
  const response = await fetch('/api/councils', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config, type: spec.type })
  });
  if (!response.ok) {
    throw await errorFromResponse(response, `POST /api/councils failed: ${response.status}`);
  }
  const data = await response.json();
  tab.selectedCouncilId = data.council.id;
  tab._markClean();
  await tab.loadCouncils();
  syncSelectorToSelection(tab, spec);
  return true;
}

/**
 * Confirm and DELETE the selected council, then reset the tab to its
 * "+ New Council" state.
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} _spec - Unused: the repaint goes through
 *   `tab._renderCouncilSelector()`, which carries the tab's own spec. Kept so
 *   every CRUD helper takes the same pair and the tabs delegate uniformly.
 * @returns {Promise<boolean>} true iff the council was deleted (see RETURN CONTRACT)
 */
async function deleteCouncil(tab, _spec) {
  if (!tab.selectedCouncilId) return false;

  const council = tab.councils.find(c => c.id === tab.selectedCouncilId);
  const councilName = council?.name || 'this council';

  const confirmDlg = window.confirmDialog;
  if (!confirmDlg) return false;
  const result = await confirmDlg.show({
    title: 'Delete Council',
    message: `Are you sure you want to delete "${councilName}"?`,
    confirmText: 'Delete',
    confirmClass: 'btn-danger'
  });
  if (result !== 'confirm') return false;

  try {
    const response = await fetch(`/api/councils/${tab.selectedCouncilId}`, { method: 'DELETE' });
    if (!response.ok) {
      throw await errorFromResponse(
        response,
        `DELETE /api/councils/${tab.selectedCouncilId} failed: ${response.status}`
      );
    }

    // Reset to "+ New Council" state
    const deletedId = tab.selectedCouncilId;
    tab.selectedCouncilId = null;
    tab._applyConfigToUI(tab._defaultConfig());
    tab._markClean();

    // Drop the row LOCALLY before the refresh. `loadCouncils` deliberately
    // keeps the previous lists when it fails (see its catch) — right for a
    // plain read failure, wrong here: the DELETE returned ok, so this is the
    // one caller whose "previous" is KNOWN to be stale. Retained, the deleted
    // council stays selectable in the `<select>` and keeps its name reserved in
    // `saveCouncilAs`'s duplicate scan.
    const alive = c => c.id !== deletedId;
    tab.councils = tab.councils.filter(alive);
    // Truthy check, not `Array.isArray`, to match the `tab._allCouncils ||
    // tab.councils` fallback in `saveCouncilAs`: with no `_allCouncils` the
    // scan reads `tab.councils`, which the line above already pruned.
    if (tab._allCouncils) tab._allCouncils = tab._allCouncils.filter(alive);

    // A failed refresh repaints NOTHING, which would leave the deleted
    // `<option>` on screen; repaint here instead. With the row pruned and
    // `selectedCouncilId` already null, the target resolves to '' — the view
    // lands on "+ New Council" either way.
    if (!(await tab.loadCouncils())) tab._renderCouncilSelector();
    tab._updateSaveButtonStates();

    if (window.toast) window.toast.showSuccess('Council deleted');
    return true;
  } catch (error) {
    console.error('Error deleting council:', error);
    if (window.toast) window.toast.showError(failureMessage(error, 'Failed to delete council'));
    return false;
  }
}

/**
 * Load saved councils from the API and repaint the tab's selector.
 *
 * `spec.councilFilter` decides which rows this tab shows, and the two tabs'
 * predicates are ASYMMETRIC on purpose — see the module header. The unfiltered
 * response is kept as `tab._allCouncils` for the duplicate-name scan in
 * `saveCouncilAs`, which must see every name regardless of type.
 *
 * A FAILED load leaves both lists exactly as they were — see the catch block.
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @returns {Promise<boolean>} true iff the fetch succeeded and the selector was
 *   re-rendered. NEVER rejects — several callers fire and forget.
 */
async function loadCouncils(tab, spec) {
  try {
    const response = await fetch('/api/councils');
    if (!response.ok) throw new Error('Failed to fetch councils');
    const data = await response.json();
    const all = Array.isArray(data.councils) ? data.councils : [];
    tab._allCouncils = all;
    tab.councils = all.filter(c => spec.councilFilter(c));
    tab._councilsLoaded = true;
    tab._renderCouncilSelector();
    return true;
  } catch (error) {
    console.error('Error loading councils:', error);
    // >>> A FAILED REFRESH KEEPS THE PREVIOUS LISTS. Both of them, untouched,
    // alongside a selector that was never repainted: the list, the duplicate-name
    // scan and the `<option>` nodes then all describe the same last known-good
    // data, which is the only combination in which the model and the view agree.
    //
    // Emptying them here did NOT make the tab safer, because nothing repaints
    // the `<select>` on this path — the real `<option>` nodes stay on screen
    // offering councils no JS believes in any more. This path is reachable:
    // `putCouncil` and `postCouncil` both `await tab.loadCouncils()` AFTER a
    // successful write, so one transient 500 on that follow-up GET used to leave
    // the tab with (a) an empty `_allCouncils`, so `saveCouncilAs`'s duplicate
    // scan finds nothing and happily creates a SECOND council under an existing
    // name — which permanently breaks `--council <name>` for both (see the
    // ambiguity note in `saveCouncilAs`); (b) a delete confirm degraded to "this
    // council"; (c) an export named "Untitled Council"; and worst (d) the tabs'
    // selector `change` handler assigning `selectedCouncilId = e.target.value`
    // BEFORE its `if (council)` guard, so picking X from the stale dropdown
    // repoints the id at X while the editor still shows Y — and the next Save
    // PUTs Y's config over X. `[]` is truthy, so the
    // `tab._allCouncils || tab.councils || []` fallback rescues none of it.
    //
    // Both sibling implementations already made this call, and for the same
    // reason — this is codebase policy, not a local preference:
    // `SettingsPage.loadCouncils` (public/js/settings.js) leaves the previous
    // list ALONE and raises `councilsLoadFailed`, so "we could not load" stays
    // distinguishable from "there are none"; `CouncilManager._loadCouncils`
    // (public/js/components/CouncilManager.js) keeps its rows under an error
    // banner because stale rows are "truthful (they are what we last knew) and
    // recoverable (the next mutation re-fetches)".
    //
    // This also covers the other way in: if `_renderCouncilSelector()` throws
    // AFTER a successful fetch, the catch no longer discards a list that loaded
    // perfectly well.
    if (window.toast) {
      window.toast.showError('Failed to load saved councils');
    }
    return false;
  }
}

/**
 * Auto-save the council if there are unsaved changes.
 *
 * Called before analysis starts. Errors are caught and logged, never block
 * analysis. Always saves unsaved councils so the config is persisted for
 * history/reuse.
 *
 * Editing a file council and then hitting Analyze deliberately forks a
 * timestamped DB copy here rather than writing back: file councils are
 * read-only, and the config that actually ran has to be persisted. The fork is
 * lazy — a clean file council returns early on the guard below and keeps its
 * `file:` attribution, so tweaks that are abandoned without analyzing leave no
 * junk rows behind.
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @returns {Promise<void>}
 */
async function autoSaveIfDirty(tab, spec) {
  // Skip saving when the council is clean AND already persisted (has an ID).
  // Unsaved councils (no selectedCouncilId) always proceed so the config is persisted.
  if (!tab._isDirty && tab.selectedCouncilId) return;

  const config = tab._readConfigFromUI();
  const { valid } = tab._validateConfig(config);
  if (!valid) return; // Don't auto-save invalid configs

  try {
    const timestamp = tab._formatTimestamp(new Date());

    let name;
    if (tab.selectedCouncilId) {
      // Fork: create new council based on existing, don't mutate the original
      const existing = tab.councils.find(c => c.id === tab.selectedCouncilId);
      const baseName = (existing?.name || spec.autoSaveNamePrefix)
        .replace(/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/, '')
        .trim();
      name = `${baseName} ${timestamp}`;
    } else {
      // `spec.autoSaveNamePrefix` is the persisted `type` column literal for
      // this tab ('Council' / 'Advanced'), not the badge text — so the name
      // stays meaningful if the badge wording ever changes. Only reachable with
      // NO council selected; otherwise the branch above takes `existing.name`,
      // falling back to the prefix only when the selected id is missing from
      // `tab.councils`. A failed `loadCouncils` is no longer a way in (it keeps
      // the previous list), and neither is a council deleted elsewhere (a
      // successful reload drops it, and `renderCouncilSelector` then clears the
      // selection to match). What remains: a POST whose follow-up refresh
      // failed, leaving `selectedCouncilId` on a council the retained list
      // predates; and a tab with no `<select>` in its DOM, where
      // `renderCouncilSelector` bails before it can reconcile the selection.
      name = `${spec.autoSaveNamePrefix} ${timestamp}`;
    }
    await tab._postCouncil(name, config);
  } catch (error) {
    console.error('Auto-save council failed (non-blocking):', error);
    if (window.toast) {
      window.toast.showWarning('Council auto-save failed');
    }
  }
}

/**
 * Set the default council ID to pre-select when councils load.
 * Stores the ID as pending; it is applied in `renderCouncilSelector`.
 *
 * On a cached reopen the councils are already loaded, so `loadCouncils()` — and
 * the `_renderCouncilSelector()` call that applies the pending default — will
 * not run again (the modal instance is reused; see AnalysisConfigModal caching
 * on window.analysisConfigModal). Apply it now so the saved/default council is
 * restored instead of being silently dropped onto a blank "+ New Council"
 * selection.
 *
 * @param {Object} tab - The config tab instance
 * @param {string} councilId - Council ID to pre-select
 */
function setDefaultCouncilId(tab, councilId) {
  tab._pendingDefaultCouncilId = councilId;
  if (tab._councilsLoaded && tab._injected) {
    tab._renderCouncilSelector();
  }
}

/**
 * Format a Date as "YYYY-MM-DD HH:MM" for council naming.
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Get the default timeout for a provider, falling back to the tab class's
 * static DEFAULT_TIMEOUT (carried on the spec so there is only one copy of it).
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @param {string} providerId - Provider ID (e.g., 'pi', 'claude')
 * @returns {number} Default timeout in ms
 */
function getProviderDefaultTimeout(tab, spec, providerId) {
  const provider = tab.providers[providerId];
  return provider?.defaultTimeout ?? spec.defaultTimeout;
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
 * @param {Object} tab - The config tab instance (read for `tab.providers`)
 * @param {HTMLSelectElement|null} modelSelect - The model dropdown to set
 * @param {string} providerId - Provider the stored model belongs to
 * @param {string} modelId - Stored model id (may be an alias)
 */
function applyModelSelection(tab, modelSelect, providerId, modelId) {
  if (!modelSelect || !modelId) return;
  const providerMap = typeof window !== 'undefined' ? window.ProviderMap : null;
  const canonical = providerMap?.findModelWithAliases
    ? providerMap.findModelWithAliases(tab.providers[providerId], modelId)
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
function syncTierToModel(modelSelect) {
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
 * Whether a council id belongs to the read-only file overlay
 * (`~/.pair-review/councils/`).
 *
 * Mirrors isFileCouncilId() in src/councils/council-store.js, which is what the
 * API gates PUT/DELETE on. Testing the id (not a joined `source` field) means
 * the check still holds when the council list is empty or stale — a tab that
 * has not loaded yet has no list at all, and `loadCouncils` swallows fetch
 * failures by KEEPING the last one, however old.
 *
 * @param {string|null|undefined} councilId
 * @returns {boolean}
 */
function isFileCouncilId(councilId) {
  return typeof councilId === 'string' && councilId.startsWith('file:');
}

/**
 * Repaint the tab's council `<select>` from `tab.councils`, then apply any
 * pending default council.
 *
 * This is where `_pendingDefaultCouncilId` becomes `selectedCouncilId`, which
 * is why a hosted tab keeps its `<select>` even though the rest of its action
 * row is suppressed.
 *
 * >>> IT IS ALSO WHERE A VANISHED SELECTION IS CLEARED. Every candidate id is
 * checked against `tab.councils` and the loser is '' — because assigning
 * `select.value = x` when no `<option>` carries `x` neither throws nor sticks:
 * the browser deselects and shows the first option ("+ New Council"). Leaving
 * `tab.selectedCouncilId` on the vanished id then puts the model and the view in
 * open disagreement — `saveCouncil` takes the PUT branch against an id the
 * server no longer has, `updateSaveButtonStates` keeps Delete enabled, and
 * CouncilManager's header keeps reading "Edit council".
 *
 * ACCEPTED BEHAVIOUR CHANGE: once the selected council is gone, Save stops
 * meaning "update" and starts meaning "create". It used to PUT to a dead id — a
 * 404 the user did nothing to earn; now the form's contents are POSTed as a new
 * council, so the edits are not lost, they land in a new row. NO TOAST,
 * deliberately: the state is rare, this function runs after every save and every
 * list refresh, and the `<select>` visibly drops to "+ New Council" on its own,
 * so nothing about the UI is misleading.
 *
 * A cleared selection is written as `null`, not '': '' is the `<option>` value
 * the view falls back to, `null` is what every other writer of
 * `selectedCouncilId` uses for "no council".
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 */
function renderCouncilSelector(tab, spec) {
  const selector = tab.modal.querySelector(spec.selectorId);
  if (!selector) return;

  const currentValue = selector.value;
  selector.innerHTML = '<option value="" class="council-option-new">+ New Council</option>';
  for (const council of tab.councils) {
    const opt = document.createElement('option');
    opt.value = council.id;
    opt.textContent = tab._isFileCouncil(council.id) ? `${council.name} (file)` : council.name;
    selector.appendChild(opt);
  }

  // ONE target for the whole function, applied in ONE place. The candidates, in
  // order: the pending default (from last-used or repo default), then the tab's
  // own selection, then whatever the `<select>` was showing before the repaint
  // wiped it. Each must exist in `tab.councils` to win; '' — "+ New Council" —
  // is the floor.
  //
  // The model outranks the DOM because it can legitimately be AHEAD of it:
  // `postCouncil` assigns the new id and only then reloads the list, so at this
  // point `currentValue` is still the selection the user saved FROM. Restoring
  // that would hand the freshly created council straight back to its source.
  const pendingId = tab._pendingDefaultCouncilId;
  tab._pendingDefaultCouncilId = null;
  const pending = pendingId ? tab.councils.find(c => c.id === pendingId) : null;
  const known = id => Boolean(id) && tab.councils.some(c => c.id === id);
  const target = pending ? pendingId
    : (known(tab.selectedCouncilId) ? tab.selectedCouncilId
      : (known(currentValue) ? currentValue : ''));

  // '' is the `<option>` value; `null` is what the rest of the codebase means by
  // "no council" (the constructor, `reset()` and the tabs' `change` handler all
  // normalise to it). One decision, spelled the way each side reads it.
  applySelectorValue(selector, target);
  tab.selectedCouncilId = target || null;

  // ONLY on the pending branch. The restore path repaints a selector whose
  // config is already sitting in the form, so re-applying it would be pointless
  // and `_markClean()` would silently discard the user's unsaved edits.
  if (pending) {
    tab._applyConfigToUI(pending.config);
    tab._markClean();
  }
}

/**
 * Mark the editor dirty and refresh everything gated on dirty state.
 * @param {Object} tab - The config tab instance
 */
function markDirty(tab) {
  tab._isDirty = true;
  tab._updateSaveButtonStates();
}

/**
 * Mark the editor clean and refresh everything gated on dirty state.
 * @param {Object} tab - The config tab instance
 */
function markClean(tab) {
  tab._isDirty = false;
  tab._updateSaveButtonStates();
}

/**
 * Refresh the tab's own Save / Save As / Export / Delete enablement, notify a
 * subscribed host, and toggle the modal's dirty hint.
 *
 * Every node touched here is optional: a hosted tab renders no action row and
 * the settings page has no modal footer (see NULL TOLERANCE in the header).
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 */
function updateSaveButtonStates(tab, spec) {
  // The hosted editor (CouncilManager) renders the footer that replaces this
  // tab's own write row, and its Save has to follow the same state this
  // method gates on — dirty, and which council is selected. Every transition
  // funnels through here (_markDirty, _markClean, the selector's change
  // handler), so this is the one place a host can subscribe to and see all of
  // them. No-op when nothing subscribed.
  if (typeof tab.onStateChange === 'function') tab.onStateChange();

  const panel = tab.modal.querySelector(spec.panelId);
  if (!panel) return;

  const saveBtn = panel.querySelector(spec.saveBtnId);
  const saveAsBtn = panel.querySelector(spec.saveAsBtnId);
  const exportBtn = panel.querySelector(spec.exportBtnId);
  const deleteBtn = panel.querySelector(spec.deleteBtnId);

  // File councils are read-only: no in-place save, no delete. Save As stays
  // enabled — it POSTs a copy, which is the duplicate-to-my-councils flow.
  const isFile = tab._isFileCouncil(tab.selectedCouncilId);

  if (saveBtn) {
    saveBtn.disabled = !tab._isDirty || !tab.selectedCouncilId || isFile;
  }
  // Reuse _validateConfig to keep enablement in sync with actual save
  // validation. Export shares the check: an invalid config can be neither
  // saved nor exported (the exported document would not read back).
  if (saveAsBtn || exportBtn) {
    const config = tab._readConfigFromUI();
    const { valid } = tab._validateConfig(config);
    if (saveAsBtn) saveAsBtn.disabled = !valid;
    if (exportBtn) exportBtn.disabled = !valid;
  }
  if (deleteBtn) {
    // Delete is only available when viewing a saved, non-file council
    deleteBtn.disabled = !tab.selectedCouncilId || isFile;
  }

  // Toggle the "unsaved changes" hint in the modal footer
  tab._updateDirtyHint();
}

/**
 * Toggle the "unsaved changes" hint + save button container in the modal
 * footer. Visible only when the council tab is active AND the config is dirty
 * (AnalysisConfigModal owns the active-tab half).
 *
 * `#council-footer-left` belongs to the modal, not the tab — a hosted tab has
 * no such node and must no-op.
 *
 * @param {Object} tab - The config tab instance
 */
function updateDirtyHint(tab) {
  const container = tab.modal.querySelector('#council-footer-left');
  if (!container) return;
  container.style.display = tab._isDirty ? '' : 'none';
}

/**
 * Update the council custom-instructions character count, its warning/error
 * styling, and the modal's submit button (which the over-limit state disables).
 *
 * @param {Object} tab - The config tab instance
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @param {number} count - Current character count
 */
function updateCharCount(tab, spec, count) {
  const panel = tab.modal.querySelector(spec.panelId);
  if (!panel) return;

  const charCountEl = panel.querySelector(spec.charCountId);
  const charCountContainer = panel.querySelector(spec.charCountContainerId);
  const textarea = panel.querySelector(spec.instructionsId);
  const submitBtn = tab.modal.querySelector('[data-action="submit"]');

  if (charCountEl) {
    charCountEl.textContent = count.toLocaleString();
  }

  const isOverLimit = count > tab.CHAR_LIMIT;
  const isNearLimit = count > tab.CHAR_WARNING_THRESHOLD && count <= tab.CHAR_LIMIT;

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
    submitBtn.title = isOverLimit
      ? `Custom instructions exceed ${tab.CHAR_LIMIT.toLocaleString()} character limit`
      : 'Start Analysis (Cmd/Ctrl+Enter)';
  }
}

const councilCrudApi = {
  saveCouncil,
  saveCouncilAs,
  putCouncil,
  postCouncil,
  deleteCouncil,
  loadCouncils,
  autoSaveIfDirty,
  setDefaultCouncilId,
  formatTimestamp,
  getProviderDefaultTimeout,
  applyModelSelection,
  syncTierToModel,
  isFileCouncilId,
  renderCouncilSelector,
  markDirty,
  markClean,
  updateSaveButtonStates,
  updateDirtyHint,
  updateCharCount
};

if (typeof window !== 'undefined') {
  window.CouncilCrud = { ...councilCrudApi };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ...councilCrudApi };
}
