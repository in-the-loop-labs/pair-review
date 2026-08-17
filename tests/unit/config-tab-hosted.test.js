// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the `hosted` option on both council config tabs.
 *
 * `new TabClass(host, { hosted: true })` is how the settings-page
 * CouncilManager embeds a tab in a page that has no review and owns its own
 * Save/Back footer. Two regions come off:
 *
 *   1. THE PER-REVIEW BLOCK below the "This Review" divider — the
 *      repo-instructions banner and the per-analysis Custom Instructions
 *      textarea with its "0 / 5,000 characters" counter. `_readConfigFromUI()`
 *      never reads that textarea and it carries `data-no-dirty`, so on
 *      /settings a user could type guidance, watch the counter tick up, click
 *      Save, and get no warning and no persistence.
 *
 *   2. THE TAB'S OWN Save / Save As / Export / Delete ROW. Save, Save As and
 *      Delete each write to the server behind the host's back; the host cannot
 *      tell its list went stale, and its panel Delete duplicates the list's
 *      row-level Delete. Removing them leaves the host's footer as the SINGLE
 *      write surface — the manager's mutation signal is then exact rather than
 *      inferred from a list fingerprint.
 *
 * Removing DOM is only safe if everything that queries it tolerates the
 * absence, so every method that reaches for one of those nodes is driven here
 * against a hosted tab and asserted not to throw. The mirror-image
 * non-hosted cases pin that the default host (AnalysisConfigModal) lost
 * nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Sets window.TimeoutSelect. The tabs reference the bare identifier
// `TimeoutSelect` when mounting timeout dropdowns, so it has to resolve on the
// global scope chain, not just on `window`.
require('../../public/js/components/TimeoutSelect.js');
global.TimeoutSelect = window.TimeoutSelect;

const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');

const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude',
    defaultModel: 'sonnet',
    defaultTimeout: 600000,
    models: [
      { id: 'sonnet', name: 'Sonnet', tier: 'balanced', default: true },
      { id: 'opus', name: 'Opus', tier: 'thorough' }
    ]
  }
};

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    panelId: 'tab-panel-council',
    selectorId: 'vc-council-selector',
    instructionsId: 'vc-custom-instructions',
    charCountId: 'vc-char-count',
    charCountContainerId: 'vc-char-count-container',
    repoBannerId: 'vc-repo-instructions-banner',
    // Every control in the tab's own action row. Save / Save As / Delete write
    // to the server; Export writes none but shares the row and the host offers
    // its own.
    writeControlIds: ['vc-council-save-btn', 'vc-council-save-as-btn', 'vc-council-delete-btn'],
    exportId: 'vc-council-export-btn',
    updateCharCount: (tab, n) => tab._updateCharCount(n)
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    panelId: 'tab-panel-advanced',
    selectorId: 'council-selector',
    instructionsId: 'council-custom-instructions',
    charCountId: 'council-char-count',
    charCountContainerId: 'council-char-count-container',
    repoBannerId: 'council-repo-instructions-banner',
    writeControlIds: ['council-save-btn', 'council-save-as-btn', 'council-delete-btn'],
    exportId: 'council-export-btn',
    updateCharCount: (tab, n) => tab._updateCouncilCharCount(n)
  }
];

/** The bare wrapper CouncilManager builds: one panel, no modal chrome. */
function mountHost(panelId) {
  document.body.innerHTML = `<div id="host"><div id="${panelId}"></div></div>`;
  return document.getElementById('host');
}

function injectInto(TabClass, host, panelId, options) {
  const tab = new TabClass(host, options);
  tab.inject(host.querySelector(`#${panelId}`));
  return tab;
}

beforeEach(() => {
  window.toast = { showError: () => {}, showWarning: () => {}, showSuccess: () => {} };
});

afterEach(() => {
  delete window.toast;
  document.body.innerHTML = '';
});

for (const spec of TABS) {
  const {
    label, TabClass, panelId, selectorId, instructionsId, charCountId,
    charCountContainerId, repoBannerId, writeControlIds, exportId
  } = spec;
  const actionIds = [...writeControlIds, exportId];

  describe(`${label} hosted outside a review`, () => {
    function hosted() {
      const host = mountHost(panelId);
      const tab = injectInto(TabClass, host, panelId, { hosted: true });
      tab.setProviders(PROVIDERS);
      tab.reset();
      return { host, tab, panel: host.querySelector(`#${panelId}`) };
    }

    it('records the flag off the option, defaulting to false', () => {
      const host = mountHost(panelId);
      expect(new TabClass(host)._hosted).toBe(false);
      expect(new TabClass(host, {})._hosted).toBe(false);
      expect(new TabClass(host, { hosted: false })._hosted).toBe(false);
      // Strictly `=== true`: a stray truthy option must not silently host.
      expect(new TabClass(host, { hosted: 'yes' })._hosted).toBe(false);
      expect(new TabClass(host, { hosted: true })._hosted).toBe(true);
    });

    it('renders no per-review block', () => {
      const { panel } = hosted();

      expect(panel.querySelector('.council-review-divider')).toBeNull();
      expect(panel.querySelector(`#${instructionsId}`)).toBeNull();
      expect(panel.querySelector(`#${charCountId}`)).toBeNull();
      expect(panel.querySelector(`#${charCountContainerId}`)).toBeNull();
      expect(panel.querySelector(`#${repoBannerId}`)).toBeNull();
      expect(panel.textContent).not.toContain('This Review');
      expect(panel.textContent).not.toContain('5,000 characters');
    });

    it('renders no in-panel write controls, so the host owns every write', () => {
      const { panel } = hosted();

      for (const id of actionIds) {
        expect(panel.querySelector(`#${id}`)).toBeNull();
      }
      // Nothing else in the panel can reach the server either: no button in the
      // council row survives, and the only remaining control there is the
      // selector, which merely repaints the form.
      expect(panel.querySelectorAll('.council-selector-row button')).toHaveLength(0);
      expect(panel.querySelector('.btn-save-council')).toBeNull();
    });

    it('keeps the council selector and the config body', () => {
      const { panel } = hosted();

      expect(panel.querySelector(`#${selectorId}`)).not.toBeNull();
      // The council config itself — reviewers, levels, consolidation — is the
      // whole point of hosting the tab.
      expect(panel.querySelectorAll('.voice-provider').length).toBeGreaterThan(0);
      expect(panel.querySelector('.voice-tier')).not.toBeNull();
    });

    it('reads a complete config with the per-review block gone', () => {
      const { tab } = hosted();

      const config = tab._readConfigFromUI();

      expect(config.consolidation.provider).toBe('claude');
      if (label === 'VoiceCentricConfigTab') {
        expect(config.voices).toHaveLength(1);
      } else {
        expect(config.levels['1'].voices).toHaveLength(1);
      }
    });

    it('survives every method that queries the removed nodes', () => {
      const { tab } = hosted();

      expect(() => {
        // Button-state refresh (runs on every keystroke via _markDirty).
        tab._updateSaveButtonStates();
        tab._markDirty();
        tab._markClean();
        tab._updateDirtyHint();
        // Char count: no textarea, no counter, no submit button.
        spec.updateCharCount(tab, 6000);
        spec.updateCharCount(tab, 0);
        // The per-review setters the modal calls; a host may still call them.
        tab.setRepoInstructions('Repo guidance');
        tab.setRepoInstructions('');
        tab.setLastInstructions('Last time');
        tab.setLastInstructions('');
        // And a full repaint.
        tab._applyConfigToUI(tab._defaultConfig());
        tab.reset();
      }).not.toThrow();

      expect(tab.isDirty).toBe(false);
    });

    it('still tracks dirty state without the buttons it would have toggled', () => {
      const { tab } = hosted();

      tab._markDirty();
      expect(tab.isDirty).toBe(true);
      tab._markClean();
      expect(tab.isDirty).toBe(false);
    });
  });

  describe(`${label} not hosted (the modal's arrangement)`, () => {
    function unhosted() {
      const host = mountHost(panelId);
      const tab = injectInto(TabClass, host, panelId);
      tab.setProviders(PROVIDERS);
      tab.reset();
      return { tab, panel: host.querySelector(`#${panelId}`) };
    }

    it('still renders the per-review block', () => {
      const { panel } = unhosted();

      expect(panel.querySelector('.council-review-divider')).not.toBeNull();
      expect(panel.querySelector(`#${instructionsId}`)).not.toBeNull();
      expect(panel.querySelector(`#${charCountId}`)).not.toBeNull();
      expect(panel.querySelector(`#${repoBannerId}`)).not.toBeNull();
    });

    it('still renders its own action row, wired up', () => {
      const { tab, panel } = unhosted();

      for (const id of actionIds) {
        expect(panel.querySelector(`#${id}`)).not.toBeNull();
      }
      // And the enablement logic still drives them.
      tab.selectedCouncilId = 'db-council-1';
      tab._markDirty();
      expect(panel.querySelector('.btn-save-council').disabled).toBe(false);
    });
  });
}
