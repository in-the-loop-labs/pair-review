// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared Export-button behavior for the two council config tabs.
 *
 * VoiceCentricConfigTab and AdvancedConfigTab present the same Export button
 * over two different config formats; the only thing that differs is the council
 * type literal. Both tabs' `_exportCouncil` delegates here so the validity gate,
 * the name resolution, and the clipboard-aware toast exist in exactly one place.
 *
 * Collaborators (`window.CouncilDocument`, `window.toast`) are resolved at CALL
 * time, never at load time — matching how the tabs already reach `window.toast`
 * and `window.confirmDialog`, and keeping script order a non-issue.
 *
 * Loaded in the browser as `window.CouncilExport`; also exported via CommonJS
 * for unit tests. No DOM access at load time.
 */

/**
 * Export a config tab's council as a versioned council document.
 *
 * Identity of the exported document (deliberate, per the council document spec):
 * the CONFIG comes from the live UI (`_readConfigFromUI`) so what you see is
 * what you export, while the NAME comes from the selected council — falling
 * back to 'Untitled Council' when the tab sits on "+ New Council" or the
 * selected id has since disappeared. Export never prompts for a name; naming a
 * council is what Save As is for.
 *
 * Gated on the same `_validateConfig` call Save As uses: an invalid config would
 * produce a document the app itself would refuse to read back, so it is refused
 * here instead, with the validator's own message. The Export button is disabled
 * for the same condition (`_updateSaveButtonStates`); this is the second gate,
 * for keyboard/programmatic paths and stale button state.
 *
 * @param {Object} tab - The config tab instance (VoiceCentricConfigTab or AdvancedConfigTab)
 * @param {string} councilType - 'council' (voice-centric) or 'advanced' (level-centric)
 * @returns {Promise<Object|null>} The exported document, or null when nothing was exported
 */
async function exportCouncilFromTab(tab, councilType) {
  const config = tab._readConfigFromUI();
  const { valid, error: validationError } = tab._validateConfig(config);
  if (!valid) {
    if (window.toast) {
      window.toast.showWarning(validationError || 'Council configuration is not valid.');
    }
    return null;
  }

  const selected = (tab.councils || []).find(c => c.id === tab.selectedCouncilId);
  const name = selected?.name || 'Untitled Council';

  try {
    const { doc, copied } = window.CouncilDocument.exportCouncilToFile({
      name,
      type: councilType,
      config
    });
    // `copied` never rejects; it reports whether the clipboard actually took it.
    const wasCopied = await copied;
    if (window.toast) {
      window.toast.showSuccess(
        wasCopied ? 'Council exported and copied to clipboard' : 'Council exported'
      );
    }
    return doc;
  } catch (error) {
    console.error('Failed to export council:', error);
    if (window.toast) {
      window.toast.showError('Failed to export council');
    }
    return null;
  }
}

const councilExportApi = { exportCouncilFromTab };

if (typeof window !== 'undefined') {
  window.CouncilExport = { ...councilExportApi };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ...councilExportApi };
}
