// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the alias round trip through the two council config tabs:
 * `_applyConfigToUI` paints a STORED council onto the form, `_readConfigFromUI`
 * reads it back, and Save writes whatever comes out.
 *
 * The two halves were asymmetric. Apply did a bare `modelSelect.value =
 * voice.model` against a `<select>` whose options carry canonical ids only
 * (`opt.value = model.id`), and it ran AFTER `_updateModelDropdown` had already
 * selected a valid default — so a stored ALIAS overwrote a good value with `""`.
 * Read then keeps a reviewer only `if (provider && model)`, so the row vanished
 * from the pushed array with no error: `_validateConfig` passes on partial loss
 * and the save toasts success. Aliases are not exotic — `opus`, `fable`,
 * `opus-4.5`, `gpt-5.4`, `gemini-3.5-flash` and `muse-spark` are all real, and
 * they exist precisely so councils saved against older catalogs keep resolving.
 *
 * Harmless while nothing could save an untouched council; the settings-page
 * CouncilManager's footer Save made a zero-edit round trip reachable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

require('../../public/js/utils/provider-map.js');
// The tabs reference the bare identifier `TimeoutSelect` when mounting timeout
// dropdowns, so it has to resolve on the global scope chain, not just window.
require('../../public/js/components/TimeoutSelect.js');
global.TimeoutSelect = window.TimeoutSelect;

// Loads both tabs with `window.CouncilCrud` — which their shared methods resolve
// at call time — already installed. See the helper's header for why.
const { VoiceCentricConfigTab, AdvancedConfigTab } = require('../utils/config-tab-modules.js');

// `gpt-5.4` is an alias of a canonical id, exactly as codex-provider.js ships
// it; `sonnet-4.6` is the option the dropdown would default to on its own.
const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude',
    defaultModel: 'sonnet-4.6',
    defaultTimeout: 600000,
    models: [
      { id: 'sonnet-4.6', name: 'Sonnet 4.6', tier: 'balanced', aliases: ['sonnet'], default: true },
      { id: 'opus-5', name: 'Opus 5', tier: 'thorough', aliases: ['opus'] }
    ]
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    defaultModel: 'gpt-5.4-medium',
    defaultTimeout: 600000,
    models: [
      { id: 'gpt-5.4-medium', name: 'GPT-5.4 (medium)', tier: 'balanced', aliases: ['gpt-5.4'], default: true },
      { id: 'gpt-5.4-high', name: 'GPT-5.4 (high)', tier: 'thorough' }
    ]
  }
};

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    panelId: 'tab-panel-council',
    // A council stored against an older catalog: both reviewers and the
    // consolidation slot name aliases.
    storedConfig: () => ({
      voices: [
        { provider: 'codex', model: 'gpt-5.4', tier: 'balanced' },
        { provider: 'claude', model: 'opus', tier: 'thorough' }
      ],
      levels: { 1: true, 2: true, 3: false },
      consolidation: { provider: 'claude', model: 'opus', tier: 'thorough' }
    }),
    reviewersOf: (config) => config.voices,
    orchestrationOf: (config) => config.consolidation
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    panelId: 'tab-panel-advanced',
    storedConfig: () => ({
      levels: {
        1: {
          enabled: true,
          voices: [
            { provider: 'codex', model: 'gpt-5.4', tier: 'balanced' },
            { provider: 'claude', model: 'opus', tier: 'thorough' }
          ]
        },
        2: { enabled: false, voices: [] },
        3: { enabled: false, voices: [] }
      },
      consolidation: { provider: 'claude', model: 'opus', tier: 'thorough' }
    }),
    reviewersOf: (config) => config.levels['1'].voices,
    orchestrationOf: (config) => config.consolidation
  }
];

beforeEach(() => {
  window.toast = { showError: () => {}, showWarning: () => {}, showSuccess: () => {} };
});

afterEach(() => {
  delete window.toast;
  document.body.innerHTML = '';
});

for (const spec of TABS) {
  const { label, TabClass, panelId, storedConfig, reviewersOf, orchestrationOf } = spec;

  describe(`${label} alias round trip`, () => {
    /** The bare wrapper CouncilManager builds: one panel, no modal chrome. */
    function mounted() {
      document.body.innerHTML = `<div id="host"><div id="${panelId}"></div></div>`;
      const host = document.getElementById('host');
      const tab = new TabClass(host, { hosted: true });
      tab.inject(host.querySelector(`#${panelId}`));
      tab.setProviders(PROVIDERS);
      tab.reset();
      return { host, tab };
    }

    it('keeps every reviewer when the stored models are aliases', () => {
      const { tab } = mounted();
      const stored = storedConfig();

      tab._applyConfigToUI(stored);
      const read = tab._readConfigFromUI();

      // The defect dropped rows, so count first: partial loss is what passes
      // validation and toasts success.
      expect(reviewersOf(read)).toHaveLength(2);
      // Aliases come back CANONICAL — that is what the dropdown offers, and it
      // resolves to the same model.
      expect(reviewersOf(read)[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.4-medium' });
      expect(reviewersOf(read)[1]).toMatchObject({ provider: 'claude', model: 'opus-5' });
      expect(orchestrationOf(read)).toMatchObject({ provider: 'claude', model: 'opus-5' });
    });

    it('selects the canonical model in the dropdown, never nothing', () => {
      const { host, tab } = mounted();

      tab._applyConfigToUI(storedConfig());

      const modelSelects = [...host.querySelectorAll('.voice-model')];
      expect(modelSelects.length).toBeGreaterThan(0);
      for (const select of modelSelects) {
        expect(select.value).not.toBe('');
      }
    });

    it('leaves the dropdown default in place when the stored model resolves to nothing', () => {
      // A model retired from the catalog entirely. Blanking the select would
      // drop the reviewer on the next save; keeping the default preserves it.
      const { host, tab } = mounted();
      const stored = storedConfig();
      reviewersOf(stored)[0].model = 'gone-from-the-catalog';

      tab._applyConfigToUI(stored);
      const read = tab._readConfigFromUI();

      expect(host.querySelector('.voice-model').value).toBe('gpt-5.4-medium');
      expect(reviewersOf(read)).toHaveLength(2);
    });

    it('still honours a canonical id exactly as stored', () => {
      const { tab } = mounted();
      const stored = storedConfig();
      reviewersOf(stored)[0].model = 'gpt-5.4-high';

      tab._applyConfigToUI(stored);

      expect(reviewersOf(tab._readConfigFromUI())[0].model).toBe('gpt-5.4-high');
    });
  });
}
