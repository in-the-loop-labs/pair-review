// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Host-portability regression tests for the two council config tabs.
 *
 * Both tabs were written as children of AnalysisConfigModal and reach through
 * `this.modal` for two nodes the modal owns, not the tab:
 *
 *   - `#council-footer-left`  — the "unsaved changes" hint (`_updateDirtyHint`)
 *   - `[data-action="submit"]` — the Analyze button the char-limit path disables
 *
 * The settings-page council manager hosts one tab instance in a plain wrapper
 * `<div>` that contains only the tab's own panel, so neither node exists there.
 * Every one of those accesses must tolerate `null`. These tests drive a real
 * tab instance through its whole public lifecycle against such a bare container
 * and assert nothing throws — and, in the mirror-image "modal chrome present"
 * cases, that the guards did not cost the modal any behavior.
 *
 * Note on throw detection: jsdom reports an exception thrown inside an event
 * listener to the virtual console instead of propagating it to `dispatchEvent`.
 * The load-bearing assertions therefore call the methods directly; the event
 * dispatches exist to cover the real user-triggered path.
 *
 * The `AdvancedConfigTab.isDirty` getter is pinned here too: it exists so a
 * non-modal host can read dirty state off the public API (VoiceCentricConfigTab
 * already had one), which is the same "tab outside the modal" contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Sets window.TimeoutSelect. The tabs reference the bare identifier
// `TimeoutSelect` when mounting timeout dropdowns, so it has to resolve on the
// global scope chain, not just on `window`.
require('../../public/js/components/TimeoutSelect.js');
global.TimeoutSelect = window.TimeoutSelect;

// Loads both tabs with `window.CouncilCrud` — which their shared methods resolve
// at call time — already installed. See the helper's header for why.
const { VoiceCentricConfigTab, AdvancedConfigTab } = require('../utils/config-tab-modules.js');

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
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    defaultModel: 'gemini-3.1-pro-low',
    models: [
      { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (low)', tier: 'fast', default: true }
    ]
  }
};

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    panelId: 'tab-panel-council',
    instructionsId: 'vc-custom-instructions',
    charCountId: 'vc-char-count',
    charCountContainerId: 'vc-char-count-container',
    updateCharCount: (tab, n) => tab._updateCharCount(n),
    /** Shape assertions for a config read straight out of the default UI. */
    assertConfig: (config) => {
      expect(Array.isArray(config.voices)).toBe(true);
      expect(config.voices.length).toBeGreaterThan(0);
      for (const voice of config.voices) {
        expect(typeof voice.provider).toBe('string');
        expect(voice.provider.length).toBeGreaterThan(0);
        expect(typeof voice.model).toBe('string');
        expect(Number.isFinite(voice.timeout)).toBe(true);
      }
      expect(Object.keys(config.levels).sort()).toEqual(['1', '2', '3']);
      for (const enabled of Object.values(config.levels)) {
        expect(typeof enabled).toBe('boolean');
      }
      expect(typeof config.consolidation.provider).toBe('string');
      expect(typeof config.consolidation.model).toBe('string');
    }
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    panelId: 'tab-panel-advanced',
    instructionsId: 'council-custom-instructions',
    charCountId: 'council-char-count',
    charCountContainerId: 'council-char-count-container',
    updateCharCount: (tab, n) => tab._updateCouncilCharCount(n),
    assertConfig: (config) => {
      expect(Object.keys(config.levels).sort()).toEqual(['1', '2', '3']);
      for (const level of ['1', '2', '3']) {
        expect(typeof config.levels[level].enabled).toBe('boolean');
        expect(Array.isArray(config.levels[level].voices)).toBe(true);
        for (const voice of config.levels[level].voices) {
          expect(typeof voice.provider).toBe('string');
          expect(voice.provider.length).toBeGreaterThan(0);
          expect(typeof voice.model).toBe('string');
          expect(Number.isFinite(voice.timeout)).toBe(true);
        }
      }
      expect(typeof config.consolidation.provider).toBe('string');
      expect(typeof config.consolidation.model).toBe('string');
    }
  }
];

/**
 * A wrapper div holding only the tab's own panel — exactly what the settings
 * page council manager builds. No `#council-footer-left`, no
 * `[data-action="submit"]`, no repo-instructions chrome.
 */
function mountBare(panelId) {
  document.body.innerHTML = `<div id="host"><div id="${panelId}"></div></div>`;
  return document.getElementById('host');
}

/** The same wrapper plus the two modal-owned nodes, for parity checks. */
function mountWithChrome(panelId) {
  document.body.innerHTML = `
    <div id="host">
      <div id="${panelId}"></div>
      <div id="council-footer-left" style="display: none;"></div>
      <button data-action="submit"></button>
    </div>
  `;
  return document.getElementById('host');
}

/** Construct + inject a tab into `host`, returning the tab. */
function injectInto(TabClass, host, panelId) {
  const tab = new TabClass(host);
  tab.inject(host.querySelector(`#${panelId}`));
  return tab;
}

beforeEach(() => {
  window.toast = {
    showError: () => {},
    showWarning: () => {},
    showSuccess: () => {}
  };
});

afterEach(() => {
  delete window.toast;
  document.body.innerHTML = '';
});

for (const spec of TABS) {
  const { label, TabClass, panelId, instructionsId, charCountId, charCountContainerId } = spec;

  describe(`${label} in a bare container (no modal chrome)`, () => {
    it('survives the full inject -> providers -> reset -> apply -> dirty -> read lifecycle', () => {
      const host = mountBare(panelId);
      let tab;

      expect(() => {
        tab = injectInto(TabClass, host, panelId);
        tab.setProviders(PROVIDERS);
        tab.reset();
        tab._applyConfigToUI(tab._defaultConfig());
        tab._markDirty();
      }).not.toThrow();

      // The modal-owned nodes really are absent — otherwise this test would
      // pass for the wrong reason.
      expect(host.querySelector('#council-footer-left')).toBeNull();
      expect(host.querySelector('[data-action="submit"]')).toBeNull();

      let config;
      expect(() => { config = tab._readConfigFromUI(); }).not.toThrow();
      spec.assertConfig(config);

      expect(() => {
        tab._updateSaveButtonStates();
        tab._updateDirtyHint();
      }).not.toThrow();

      // The dirty flag still tracks — the missing hint container must not
      // short-circuit the state itself.
      expect(tab.isDirty).toBe(true);
      expect(() => tab._markClean()).not.toThrow();
      expect(tab.isDirty).toBe(false);
    });

    it('keeps the tab-owned council buttons wired without the modal footer', () => {
      const host = mountBare(panelId);
      const tab = injectInto(TabClass, host, panelId);
      tab.setProviders(PROVIDERS);
      tab.reset();

      // Save/Save As/Export/Delete live in the tab's own HTML, so their
      // enablement is still driven even with no footer to hint into.
      tab.selectedCouncilId = 'db-council-1';
      tab._markDirty();

      const panel = host.querySelector(`#${panelId}`);
      const saveBtn = panel.querySelector('.btn-save-council');
      expect(saveBtn).not.toBeNull();
      expect(saveBtn.disabled).toBe(false);
    });

    it('runs the over-limit char-count path with no submit button to disable', () => {
      const host = mountBare(panelId);
      const tab = injectInto(TabClass, host, panelId);
      tab.setProviders(PROVIDERS);
      tab.reset();

      const panel = host.querySelector(`#${panelId}`);
      const textarea = panel.querySelector(`#${instructionsId}`);
      expect(textarea).not.toBeNull();

      // Direct call: this is the assertion that would actually catch an
      // unguarded `submitBtn.disabled = ...`.
      expect(() => spec.updateCharCount(tab, 6000)).not.toThrow();
      expect(panel.querySelector(`#${charCountId}`).textContent).toBe((6000).toLocaleString());
      expect(panel.querySelector(`#${charCountContainerId}`).classList.contains('char-count-error')).toBe(true);

      // And the real user-triggered path.
      textarea.value = 'x'.repeat(6001);
      expect(() => {
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
      }).not.toThrow();
      expect(panel.querySelector(`#${charCountId}`).textContent).toBe((6001).toLocaleString());

      // Back under the limit clears the error styling.
      expect(() => spec.updateCharCount(tab, 10)).not.toThrow();
      expect(panel.querySelector(`#${charCountContainerId}`).classList.contains('char-count-error')).toBe(false);
    });

    it('tolerates setRepoInstructions and setLastInstructions on the bare host', () => {
      // The settings page never calls setRepoInstructions, but the banner nodes
      // are tab-owned, so both setters must stay safe wherever the tab is hosted.
      const host = mountBare(panelId);
      const tab = injectInto(TabClass, host, panelId);
      tab.setProviders(PROVIDERS);

      expect(() => {
        tab.setRepoInstructions('Repo guidance');
        tab.setRepoInstructions('');
        tab.setLastInstructions('Last time');
        tab.setLastInstructions('');
      }).not.toThrow();
    });

    it('does not throw when even the panel is missing', () => {
      // Defence in depth: a host that tore down its panel (Back button, re-render)
      // must not make a still-referenced tab explode.
      const host = mountBare(panelId);
      const tab = injectInto(TabClass, host, panelId);
      tab.setProviders(PROVIDERS);
      host.querySelector(`#${panelId}`).remove();

      expect(() => {
        tab._markDirty();
        tab._updateSaveButtonStates();
        tab._updateDirtyHint();
        spec.updateCharCount(tab, 6000);
        tab._applyConfigToUI(tab._defaultConfig());
      }).not.toThrow();
      expect(tab._readConfigFromUI()).toBeTypeOf('object');
    });
  });

  describe(`${label} with modal chrome present (guards changed nothing)`, () => {
    it('still toggles the footer dirty hint', () => {
      const host = mountWithChrome(panelId);
      const tab = injectInto(TabClass, host, panelId);
      tab.setProviders(PROVIDERS);
      tab.reset();

      const footer = host.querySelector('#council-footer-left');
      expect(footer.style.display).toBe('none');

      tab._markDirty();
      expect(footer.style.display).toBe('');

      tab._markClean();
      expect(footer.style.display).toBe('none');
    });

    it('still disables the submit button over the char limit', () => {
      const host = mountWithChrome(panelId);
      const tab = injectInto(TabClass, host, panelId);
      tab.setProviders(PROVIDERS);
      tab.reset();

      const submitBtn = host.querySelector('[data-action="submit"]');

      spec.updateCharCount(tab, 6000);
      expect(submitBtn.disabled).toBe(true);
      expect(submitBtn.title).toBe('Custom instructions exceed 5,000 character limit');

      spec.updateCharCount(tab, 10);
      expect(submitBtn.disabled).toBe(false);
      expect(submitBtn.title).toBe('Start Analysis (Cmd/Ctrl+Enter)');
    });
  });
}

describe('AdvancedConfigTab.isDirty', () => {
  // The modal reads `this.advancedTab._isDirty` directly; the public getter
  // exists for hosts that only have the tab's public API (and to match
  // VoiceCentricConfigTab, which has had one all along).
  it('is defined as a getter on the prototype, like VoiceCentricConfigTab', () => {
    const descriptor = Object.getOwnPropertyDescriptor(AdvancedConfigTab.prototype, 'isDirty');
    expect(descriptor).toBeDefined();
    expect(typeof descriptor.get).toBe('function');
    expect(descriptor.set).toBeUndefined();
  });

  it('reflects the private _isDirty flag', () => {
    expect(AdvancedConfigTab.prototype.__lookupGetter__('isDirty').call({ _isDirty: true })).toBe(true);
    expect(AdvancedConfigTab.prototype.__lookupGetter__('isDirty').call({ _isDirty: false })).toBe(false);
  });

  it('tracks _markDirty() and _markClean()', () => {
    const host = mountBare('tab-panel-advanced');
    const tab = injectInto(AdvancedConfigTab, host, 'tab-panel-advanced');
    tab.setProviders(PROVIDERS);

    // inject() ends with _markClean().
    expect(tab.isDirty).toBe(false);

    tab._markDirty();
    expect(tab.isDirty).toBe(true);

    tab._markClean();
    expect(tab.isDirty).toBe(false);
  });

  it('starts clean on a fresh instance and after reset()', () => {
    const host = mountBare('tab-panel-advanced');
    const tab = injectInto(AdvancedConfigTab, host, 'tab-panel-advanced');
    tab.setProviders(PROVIDERS);

    tab._markDirty();
    tab.reset();
    expect(tab.isDirty).toBe(false);
  });
});
