// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Export affordance on both council config tabs.
 *
 * The two tabs present the same Export button over two different config
 * formats, so the whole body lives in the shared CouncilExport helper (covered
 * in council-export.test.js). What is pinned here is what remains tab-specific:
 *
 *   1. `_exportCouncil` delegates to the shared helper with the tab's OWN type
 *      literal ('council' vs 'advanced') and resolves the collaborator at call
 *      time, and
 *   2. `_updateSaveButtonStates` disables the Export button for exactly the
 *      configs the click-time gate would refuse — the state is visible before
 *      the click, not only after it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    expectedType: 'council',
    panelSelector: '#tab-panel-council',
    ids: {
      save: '#vc-council-save-btn',
      saveAs: '#vc-council-save-as-btn',
      export: '#vc-council-export-btn',
      delete: '#vc-council-delete-btn'
    },
    // Voice-centric validity also depends on the voices the config carries —
    // `_validateConfig` reads the argument, never the DOM.
    validConfig: {
      voices: [{ provider: 'claude', model: 'sonnet' }],
      levels: { 1: true, 2: false, 3: false }
    },
    invalidConfig: {
      voices: [{ provider: 'claude', model: 'sonnet' }],
      levels: { 1: false, 2: false, 3: false }
    },
    extraCtx: {}
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    expectedType: 'advanced',
    panelSelector: '#tab-panel-advanced',
    ids: {
      save: '#council-save-btn',
      saveAs: '#council-save-as-btn',
      export: '#council-export-btn',
      delete: '#council-delete-btn'
    },
    // An ENABLED level must carry at least one voice, mirroring the server's
    // `levels.N.voices must be a non-empty array when enabled`.
    validConfig: {
      levels: {
        1: { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
        2: { enabled: false, voices: [] }
      }
    },
    invalidConfig: {
      levels: { 1: { enabled: false, voices: [] }, 2: { enabled: false, voices: [] } }
    },
    extraCtx: {}
  }
];

/** `_exportCouncil` is a thin delegation — pin what it delegates with. */
function describeDelegation({ label, TabClass, expectedType }) {
  describe(`${label}._exportCouncil`, () => {
    let exportCouncilFromTab;
    let originalWindow;

    beforeEach(() => {
      originalWindow = global.window;
      exportCouncilFromTab = vi.fn(async () => ({ pair_review_council: 1 }));
      global.window = { CouncilExport: { exportCouncilFromTab } };
    });

    afterEach(() => {
      if (originalWindow === undefined) {
        delete global.window;
      } else {
        global.window = originalWindow;
      }
    });

    it('delegates to the shared helper with the tab instance and its own type', async () => {
      const tab = { marker: 'the tab instance' };

      await TabClass.prototype._exportCouncil.call(tab);

      expect(exportCouncilFromTab).toHaveBeenCalledTimes(1);
      expect(exportCouncilFromTab).toHaveBeenCalledWith(tab, expectedType);
    });

    it('returns whatever the shared helper resolves to', async () => {
      const doc = { pair_review_council: 1, name: 'Dream Team' };
      exportCouncilFromTab.mockResolvedValue(doc);

      await expect(TabClass.prototype._exportCouncil.call({})).resolves.toBe(doc);
    });

    it('resolves the helper at call time, not at load time', async () => {
      // The tab modules were required long before this replacement.
      const later = vi.fn(async () => null);
      global.window.CouncilExport = { exportCouncilFromTab: later };

      await TabClass.prototype._exportCouncil.call({});

      expect(later).toHaveBeenCalledTimes(1);
      expect(exportCouncilFromTab).not.toHaveBeenCalled();
    });
  });
}

/** The Export button must be disabled for exactly the configs the gate refuses. */
function describeExportButtonState(tabSpec) {
  const { label, TabClass, panelSelector, ids, validConfig, invalidConfig, extraCtx } = tabSpec;

  describe(`${label}._updateSaveButtonStates (Export button)`, () => {
    /**
     * Minimal tab context: a modal whose querySelector yields the panel (and
     * nothing else, so `_updateDirtyHint` finds no footer and no-ops), a panel
     * whose querySelector yields plain `{ disabled }` stand-ins, and the REAL
     * `_validateConfig` / `_updateDirtyHint` off the prototype.
     */
    function makeCtx({ config, buttons = Object.keys(ids), ...overrides } = {}) {
      const elements = {};
      for (const key of buttons) {
        elements[ids[key]] = { disabled: undefined };
      }
      const panel = { querySelector: (sel) => elements[sel] || null };
      return {
        ctx: {
          modal: { querySelector: (sel) => (sel === panelSelector ? panel : null) },
          _readConfigFromUI: vi.fn(() => config),
          _validateConfig: TabClass.prototype._validateConfig,
          _updateDirtyHint: TabClass.prototype._updateDirtyHint,
          _isFileCouncil: TabClass.prototype._isFileCouncil,
          _isDirty: false,
          selectedCouncilId: null,
          councils: [],
          ...extraCtx,
          ...overrides
        },
        elements
      };
    }

    function run(setup) {
      TabClass.prototype._updateSaveButtonStates.call(setup.ctx);
      return setup.elements;
    }

    it('disables Export when the live config would not validate', () => {
      const setup = makeCtx({ config: invalidConfig });

      const elements = run(setup);

      expect(elements[ids.export].disabled).toBe(true);
      // Same verdict as Save As — one validity check drives both.
      expect(elements[ids.saveAs].disabled).toBe(true);
    });

    it('enables Export when the live config validates', () => {
      const setup = makeCtx({ config: validConfig });

      const elements = run(setup);

      expect(elements[ids.export].disabled).toBe(false);
      expect(elements[ids.saveAs].disabled).toBe(false);
    });

    it('reads the config from the UI exactly once for both buttons', () => {
      const setup = makeCtx({ config: validConfig });

      run(setup);

      expect(setup.ctx._readConfigFromUI).toHaveBeenCalledTimes(1);
    });

    it('still sets Export when the Save As button is absent', () => {
      const setup = makeCtx({ config: invalidConfig, buttons: ['export'] });

      const elements = run(setup);

      expect(elements[ids.export].disabled).toBe(true);
    });

    it('does not read the UI when neither Save As nor Export is present', () => {
      const setup = makeCtx({ config: validConfig, buttons: ['save', 'delete'] });

      run(setup);

      expect(setup.ctx._readConfigFromUI).not.toHaveBeenCalled();
    });

    it('leaves the other buttons on their own conditions', () => {
      const setup = makeCtx({ config: validConfig, _isDirty: true, selectedCouncilId: 'c1' });

      const elements = run(setup);

      expect(elements[ids.save].disabled).toBe(false);
      expect(elements[ids.delete].disabled).toBe(false);
      expect(elements[ids.export].disabled).toBe(false);
    });

    it('no-ops when the panel is not injected', () => {
      const setup = makeCtx({ config: validConfig });
      setup.ctx.modal = { querySelector: () => null };

      expect(() => run(setup)).not.toThrow();
      expect(setup.ctx._readConfigFromUI).not.toHaveBeenCalled();
    });
  });
}

for (const tabSpec of TABS) {
  describeDelegation(tabSpec);
  describeExportButtonState(tabSpec);
}

describe('VoiceCentricConfigTab._updateSaveButtonStates (reviewer count)', () => {
  it('disables Export when a level is enabled but the config carries no voices', () => {
    // The count that matters is `config.voices.length`, not the number of
    // `.vc-reviewer` rows on screen: `_readConfigFromUI` drops any row whose
    // provider or model select is empty, so a panel showing one reviewer still
    // produces `voices: []` and the server refuses the save.
    const exportBtn = { disabled: undefined };
    const panel = { querySelector: (sel) => (sel === '#vc-council-export-btn' ? exportBtn : null) };
    const ctx = {
      modal: { querySelector: (sel) => (sel === '#tab-panel-council' ? panel : null) },
      _readConfigFromUI: () => ({ voices: [], levels: { 1: true } }),
      _validateConfig: VoiceCentricConfigTab.prototype._validateConfig,
      _updateDirtyHint: VoiceCentricConfigTab.prototype._updateDirtyHint,
      _isFileCouncil: VoiceCentricConfigTab.prototype._isFileCouncil,
      _isDirty: false,
      selectedCouncilId: null,
      councils: []
    };

    VoiceCentricConfigTab.prototype._updateSaveButtonStates.call(ctx);

    expect(exportBtn.disabled).toBe(true);
  });
});
