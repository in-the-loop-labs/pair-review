// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared council CRUD for the two council config tabs.
 *
 * VoiceCentricConfigTab and AdvancedConfigTab present the same Save / Save As /
 * Delete affordances over two different config formats. Everything about the
 * flow is the same — the validity gate, the file-council fork, the duplicate
 * name scan, the request shapes, and the post-write selector refresh. Only two
 * things differ, and both are carried in the per-tab `spec`:
 *
 *   - `type`: the council type literal sent to the API ('council' | 'advanced'),
 *   - `selectorId`: the tab's own council `<select>` ('#council-selector' vs
 *     '#vc-council-selector').
 *
 * Both tabs' `_saveCouncil` / `_saveCouncilAs` / `_putCouncil` / `_postCouncil`
 * / `_deleteCouncil` delegate here, so the flow exists in exactly one place.
 * See `council-export.js` for the same arrangement over the Export button.
 *
 * Dispatch runs BACK THROUGH THE TAB (`tab._saveCouncilAs()`, not
 * `saveCouncilAs(tab, spec)`): the tab methods are the public, overridable
 * surface, and the tabs' own callers (AnalysisConfigModal, autoSaveIfDirty)
 * already reach them that way.
 *
 * Collaborators (`window.toast`, `window.textInputDialog`,
 * `window.confirmDialog`) are resolved at CALL time, never at load time —
 * matching how the tabs already reach them, and keeping script order a
 * non-issue.
 *
 * >>> RETURN CONTRACT: every function here resolves to a BOOLEAN — `true` iff a
 * write actually reached the server and succeeded, `false` on every refusal
 * (invalid config, cancelled name prompt, missing dialog, swallowed request
 * error). Nothing rejects. Callers that only fire-and-forget (the tabs' own
 * panel buttons, AnalysisConfigModal) may keep ignoring it; a caller that has to
 * know whether the write happened — CouncilManager's editor footer, which exits
 * to the list and fires onChange — MUST read it. Deducing success from
 * `tab.isDirty` does not work: a Save on an already-clean editor is refused
 * without ever going dirty, so "not dirty" reads as "saved".
 *
 * Loaded in the browser as `window.CouncilCrud`; also exported via CommonJS for
 * unit tests. No DOM access at load time.
 *
 * @typedef {Object} CouncilCrudSpec
 * @property {string} type - Council type literal for the API ('council' | 'advanced')
 * @property {string} selectorId - CSS selector for the tab's council <select>
 */

const INVALID_CONFIG_MESSAGE = 'At least one review level must be enabled.';

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
  if (selector) {
    selector.value = tab.selectedCouncilId;
    selector.classList.remove('new-council-selected');
  }
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
  const { valid } = tab._validateConfig(config);
  if (!valid) {
    if (window.toast) window.toast.showWarning(INVALID_CONFIG_MESSAGE);
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
      if (window.toast) window.toast.showError('Failed to save council');
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
  const { valid } = tab._validateConfig(config);
  if (!valid) {
    if (window.toast) window.toast.showWarning(INVALID_CONFIG_MESSAGE);
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
    // DELIBERATE: scans only `tab.councils`, which the tab has already filtered
    // to its own type — so a "Standard" name may collide with an existing
    // "Advanced" council and still be accepted. CouncilManager._duplicate scans
    // the WHOLE list instead. There is no server-side UNIQUE on councils.name,
    // so neither is authoritative and the difference is harmless; do not
    // "align" them without deciding which one is right.
    const duplicate = tab.councils.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!duplicate) break;
    if (window.toast) window.toast.showWarning('A council with that name already exists.');
  }
  try {
    await tab._postCouncil(name, config);
  } catch (error) {
    console.error('Error saving council:', error);
    if (window.toast) window.toast.showError('Failed to save council');
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
 * @returns {Promise<boolean>} always true — a failed request REJECTS here (the
 *   callers above translate that into `false`)
 */
async function putCouncil(tab, spec, councilId, config) {
  const response = await fetch(`/api/councils/${councilId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, type: spec.type })
  });
  if (!response.ok) {
    throw new Error(`PUT /api/councils/${councilId} failed: ${response.status}`);
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
 * @returns {Promise<boolean>} always true — a failed request REJECTS here (the
 *   callers above translate that into `false`)
 */
async function postCouncil(tab, spec, name, config) {
  const response = await fetch('/api/councils', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config, type: spec.type })
  });
  if (!response.ok) {
    throw new Error(`POST /api/councils failed: ${response.status}`);
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
 * @param {CouncilCrudSpec} spec - The tab's CRUD descriptor
 * @returns {Promise<boolean>} true iff the council was deleted (see RETURN CONTRACT)
 */
async function deleteCouncil(tab, spec) {
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
      throw new Error(`DELETE /api/councils/${tab.selectedCouncilId} failed: ${response.status}`);
    }

    // Reset to "+ New Council" state
    tab.selectedCouncilId = null;
    tab._applyConfigToUI(tab._defaultConfig());
    tab._markClean();
    await tab.loadCouncils();

    const selector = tab.modal.querySelector(spec.selectorId);
    if (selector) {
      selector.value = '';
      selector.classList.add('new-council-selected');
    }
    tab._updateSaveButtonStates();

    if (window.toast) window.toast.showSuccess('Council deleted');
    return true;
  } catch (error) {
    console.error('Error deleting council:', error);
    if (window.toast) window.toast.showError('Failed to delete council');
    return false;
  }
}

const councilCrudApi = {
  saveCouncil,
  saveCouncilAs,
  putCouncil,
  postCouncil,
  deleteCouncil
};

if (typeof window !== 'undefined') {
  window.CouncilCrud = { ...councilCrudApi };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ...councilCrudApi };
}
