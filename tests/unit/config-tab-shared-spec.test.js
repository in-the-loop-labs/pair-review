// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for `COUNCIL_CRUD_SPEC` — the descriptor that lets one shared body
 * in public/js/utils/council-crud.js speak for both council config tabs — plus
 * the three shared behaviours that have no test anywhere else in the repo.
 *
 * WHAT BELONGS HERE. A test that reads a value out of the DOM, a request body or
 * another module and compares it to the spec is a BINDING: it fails when the two
 * drift apart, which is the only way a spec value can be wrong. A test that
 * compares `spec.x` to a copy of `x` typed a few lines above it in this same
 * file is a RESTATEMENT: it cannot detect a mistake, only an intentional edit,
 * and it makes the suite look like it covers something it does not. Where a spec
 * value carries real behaviour, the pin lives with the behaviour:
 *
 *   - `councilFilter`'s deliberate asymmetry — config-tab-load-councils.test.js
 *     drives both predicates through the real `loadCouncils()` over every
 *     council shape the API can return.
 *   - `autoSaveNamePrefix` — config-tab-new-council-defaults.test.js reads the
 *     generated name back out of the real `autoSaveIfDirty`.
 *   - the `panelId` literal — council-manager.test.js finds `#tab-panel-council`
 *     in the host CouncilManager actually built.
 *   - `charCountId` / `charCountContainerId` — config-tab-bare-container.test.js.
 *   - a spec read LEXICALLY rather than through `this.constructor` —
 *     config-tab-export.test.js drives these bodies off a plain object literal,
 *     where `this.constructor` is `Object`; so does the timeout case below.
 *
 * WHAT THIS FILE PINS:
 *
 *   1. THE KEY SET, AND THAT EVERY ID RESOLVES. `spec.saveBtnId` is only ever
 *      fed to `querySelector`, so a typo returns null and the shared body's
 *      `if (btn)` guard — which exists for the hosted case, where the button
 *      legitimately is not there — swallows it. The Save button then silently
 *      never enables. Every key is asserted present, every id selector is
 *      asserted well-formed, and every id is resolved against a really-mounted,
 *      NON-hosted tab.
 *   2. THE STATIC ORDERING. `defaultTimeout` is one forward reference away from
 *      `undefined` (the spec is a static field; it must be declared BELOW
 *      `static DEFAULT_TIMEOUT`), and `provider?.defaultTimeout ??
 *      spec.defaultTimeout` would then hand a provider-less tab `undefined` ms.
 *   3. THE SHARED METHODS STAYING ON THE PROTOTYPE. AnalysisConfigModal and
 *      CouncilManager reach for the underscored names directly, and much of the
 *      suite calls them off the prototype.
 *   4. THREE SHARED BEHAVIOURS WITH NO OTHER COVERAGE IN THE REPO:
 *      `_syncTierToModel` (it appears in SHARED_METHODS, but that check only
 *      reads a property descriptor — an empty body satisfies it, while a reader
 *      scanning the list believes the behaviour is pinned); the character
 *      count's NEAR-LIMIT branch together with the `instructionsId` binding (a
 *      spec pointing at any other node in the panel passed every test in the
 *      repo, and the over-limit border would land on the wrong element); and
 *      `onStateChange`, which is how the settings-page footer Save and the
 *      editor header follow the tab's dirty state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  }
};

/** Every key the shared bodies read off a spec. */
const SPEC_KEYS = [
  'type',
  'selectorId',
  'panelId',
  'saveBtnId',
  'saveAsBtnId',
  'exportBtnId',
  'deleteBtnId',
  'charCountId',
  'charCountContainerId',
  'instructionsId',
  'defaultTimeout',
  'autoSaveNamePrefix',
  'councilFilter'
];

/** The spec keys whose value is a CSS selector for a node the tab renders. */
const ID_KEYS = [
  'selectorId',
  'panelId',
  'saveBtnId',
  'saveAsBtnId',
  'exportBtnId',
  'deleteBtnId',
  'charCountId',
  'charCountContainerId',
  'instructionsId'
];

/**
 * The methods extracted into council-crud.js, minus the character-count one,
 * whose NAME differs per tab (`_updateCharCount` vs `_updateCouncilCharCount`)
 * and is carried on the TABS entries below. Each must still resolve as an own
 * property of the tab's prototype: AnalysisConfigModal and CouncilManager reach
 * for the underscored ones directly, and tests call them off the prototype.
 *
 * This is a SHAPE check, not a behaviour one — `_syncTierToModel() {}` would
 * satisfy it. The behavioural pin for that one is at the bottom of this file.
 */
const SHARED_METHODS = [
  'loadCouncils',
  'autoSaveIfDirty',
  'setDefaultCouncilId',
  '_formatTimestamp',
  '_getProviderDefaultTimeout',
  '_syncTierToModel',
  '_isFileCouncil',
  '_renderCouncilSelector',
  '_markDirty',
  '_markClean',
  '_updateSaveButtonStates',
  '_updateDirtyHint'
];

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    charCountMethod: '_updateCharCount'
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    charCountMethod: '_updateCouncilCharCount'
  }
];

/** The bare wrapper both hosts build: one panel, no modal chrome. */
function mount(TabClass, panelId, options) {
  document.body.innerHTML = `<div id="host"><div id="${panelId.slice(1)}"></div></div>`;
  const host = document.getElementById('host');
  const tab = new TabClass(host, options);
  tab.inject(host.querySelector(panelId));
  tab.setProviders(PROVIDERS);
  return { host, tab, panel: host.querySelector(panelId) };
}

beforeEach(() => {
  window.toast = { showError: () => {}, showWarning: () => {}, showSuccess: () => {} };
});

afterEach(() => {
  delete window.toast;
  document.body.innerHTML = '';
});

for (const tabSpec of TABS) {
  const { label, TabClass, charCountMethod } = tabSpec;
  const spec = TabClass.COUNCIL_CRUD_SPEC;

  describe(`${label}.COUNCIL_CRUD_SPEC shape`, () => {
    it('carries exactly the keys the shared bodies read, and no strays', () => {
      expect(Object.keys(spec).sort()).toEqual([...SPEC_KEYS].sort());
    });

    it.each(ID_KEYS)('%s is a non-empty id selector', (key) => {
      expect(typeof spec[key]).toBe('string');
      expect(spec[key].startsWith('#')).toBe(true);
      expect(spec[key].length).toBeGreaterThan(1);
    });

    it('carries the class static DEFAULT_TIMEOUT, not a second copy of the number', () => {
      // A forward reference (spec declared ABOVE `static DEFAULT_TIMEOUT`) would
      // silently evaluate to undefined, and `provider?.defaultTimeout ?? spec
      // .defaultTimeout` would then hand a provider-less tab `undefined` ms.
      // BOTH assertions are needed: the reference alone still passes when both
      // sides are `undefined`, which is the exact failure it guards.
      expect(spec.defaultTimeout).toBe(TabClass.DEFAULT_TIMEOUT);
      expect(spec.defaultTimeout).toBe(600000);
    });

    it('carries a callable council filter', () => {
      // What it SELECTS is pinned end-to-end through the real `loadCouncils()`
      // in config-tab-load-councils.test.js; here it only has to be callable,
      // because `all.filter(c => spec.councilFilter(c))` throws otherwise.
      expect(typeof spec.councilFilter).toBe('function');
    });
  });

  describe(`${label} spec ids match what the tab actually renders`, () => {
    // NON-hosted: a hosted tab deliberately omits the action row and the
    // per-review block, so half of these ids are legitimately absent there.
    // The modal is the host that renders all of them.
    it.each(ID_KEYS.filter(k => k !== 'panelId'))('%s resolves inside the panel', (key) => {
      const { panel } = mount(TabClass, spec.panelId, { hosted: false });
      expect(panel.querySelector(spec[key])).not.toBeNull();
    });

    it('panelId resolves against the host the tab was given', () => {
      const { host } = mount(TabClass, spec.panelId, { hosted: false });
      expect(host.querySelector(spec.panelId)).not.toBeNull();
    });

    it('a hosted tab keeps the selector but drops the action row and char count', () => {
      // Why the assertions above insist on `hosted: false`. The selector stays
      // because `_renderCouncilSelector` is where a pending default council
      // becomes the selection.
      const { panel } = mount(TabClass, spec.panelId, { hosted: true });

      expect(panel.querySelector(spec.selectorId)).not.toBeNull();
      for (const key of ['saveBtnId', 'saveAsBtnId', 'exportBtnId', 'deleteBtnId',
                         'charCountId', 'charCountContainerId', 'instructionsId']) {
        expect(panel.querySelector(spec[key])).toBeNull();
      }
    });
  });

  describe(`${label} shared methods stay on the prototype`, () => {
    it.each([...SHARED_METHODS, charCountMethod])('%s is an own prototype function', (name) => {
      const descriptor = Object.getOwnPropertyDescriptor(TabClass.prototype, name);
      expect(descriptor).toBeDefined();
      expect(typeof descriptor.value).toBe('function');
    });

    it('_getProviderDefaultTimeout falls back to the spec timeout on a plain context', () => {
      // Also the lexical-spec check: nothing links this context to TabClass, so
      // a body reaching for `this.constructor.COUNCIL_CRUD_SPEC` finds `Object`
      // and reads `undefined.defaultTimeout`.
      const timeout = TabClass.prototype._getProviderDefaultTimeout.call({ providers: {} }, 'claude');
      expect(timeout).toBe(TabClass.DEFAULT_TIMEOUT);
    });
  });

  describe(`${label}._syncTierToModel`, () => {
    /** Mount, and hand back the first reviewer/orchestration voice row's pair. */
    function mountRow() {
      const { tab, panel } = mount(TabClass, spec.panelId, { hosted: false });
      const modelSelect = panel.querySelector('.voice-model');
      const tierSelect = modelSelect.closest('.voice-row').querySelector('.voice-tier');
      return { tab, modelSelect, tierSelect };
    }

    it("drags the row's tier <select> to the chosen model's data-tier", () => {
      const { tab, modelSelect, tierSelect } = mountRow();
      // Start the tier somewhere the sync has to move it away from.
      tierSelect.value = 'fast';
      const option = modelSelect.options[0];
      option.dataset.tier = 'thorough';
      modelSelect.value = option.value;

      tab._syncTierToModel(modelSelect);

      expect(tierSelect.value).toBe('thorough');
    });

    it('leaves the tier alone when the chosen model declares none', () => {
      const { tab, modelSelect, tierSelect } = mountRow();
      tierSelect.value = 'fast';
      const option = modelSelect.options[0];
      delete option.dataset.tier;
      modelSelect.value = option.value;

      tab._syncTierToModel(modelSelect);

      expect(tierSelect.value).toBe('fast');
    });

    it('does not throw for a model <select> with no .voice-row ancestor', () => {
      // Both guards exist because this runs off a delegated `change` listener on
      // the whole panel, which will see any `.voice-model` the panel ever grows.
      const { tab } = mount(TabClass, spec.panelId, { hosted: false });
      const orphan = document.createElement('select');
      orphan.className = 'voice-model';
      orphan.innerHTML = '<option value="m1" data-tier="thorough">M1</option>';

      expect(() => tab._syncTierToModel(orphan)).not.toThrow();
    });

    it('does not throw for a .voice-row with no tier <select> in it', () => {
      const { tab } = mount(TabClass, spec.panelId, { hosted: false });
      const row = document.createElement('div');
      row.className = 'voice-row';
      row.innerHTML = '<select class="voice-model"><option value="m1" data-tier="thorough">M1</option></select>';

      expect(() => tab._syncTierToModel(row.querySelector('.voice-model'))).not.toThrow();
    });
  });

  describe(`${label} custom-instructions character count`, () => {
    /**
     * Run the tab's own char-count method and hand back the nodes the SPEC
     * points the chrome at — not nodes this test looked up by literal, which
     * would stop being a binding.
     */
    function run(count) {
      const { tab, panel } = mount(TabClass, spec.panelId, { hosted: false });
      tab[charCountMethod](count);
      return {
        tab,
        panel,
        container: panel.querySelector(spec.charCountContainerId),
        textarea: panel.querySelector(spec.instructionsId),
        countEl: panel.querySelector(spec.charCountId)
      };
    }

    it('binds instructionsId to the textarea the over-limit border lands on', () => {
      const { textarea } = run(6000);

      // "resolves inside the panel" is not enough: a spec pointing at any other
      // node in there resolves too, and the red border would land on it.
      expect(textarea.tagName).toBe('TEXTAREA');
      expect(textarea.classList.contains('textarea-error')).toBe(true);
    });

    it('carries no warning or error chrome well under the limit', () => {
      const { container, textarea, countEl } = run(10);

      expect(countEl.textContent).toBe('10');
      expect(container.classList.contains('char-count-warning')).toBe(false);
      expect(container.classList.contains('char-count-error')).toBe(false);
      expect(textarea.classList.contains('textarea-warning')).toBe(false);
      expect(textarea.classList.contains('textarea-error')).toBe(false);
    });

    it('warns — and only warns — between the threshold and the limit', () => {
      const { tab, container, textarea } = run(4600);

      // The branch nothing in the repo had ever executed: strictly above
      // CHAR_WARNING_THRESHOLD (4,500) and still at or under CHAR_LIMIT (5,000).
      expect(4600).toBeGreaterThan(tab.CHAR_WARNING_THRESHOLD);
      expect(4600).toBeLessThanOrEqual(tab.CHAR_LIMIT);
      expect(container.classList.contains('char-count-warning')).toBe(true);
      expect(container.classList.contains('char-count-error')).toBe(false);
      expect(textarea.classList.contains('textarea-warning')).toBe(true);
      expect(textarea.classList.contains('textarea-error')).toBe(false);
    });

    it('errors — and only errors — over the limit', () => {
      const { tab, container, textarea } = run(6000);

      expect(6000).toBeGreaterThan(tab.CHAR_LIMIT);
      expect(container.classList.contains('char-count-error')).toBe(true);
      expect(container.classList.contains('char-count-warning')).toBe(false);
      expect(textarea.classList.contains('textarea-error')).toBe(true);
      expect(textarea.classList.contains('textarea-warning')).toBe(false);
    });

    it('clears the chrome again when the count comes back down', () => {
      // Each call removes both classes before re-adding one, so a deletion that
      // has to survive is the removal, not the add.
      const { tab, panel } = mount(TabClass, spec.panelId, { hosted: false });
      const container = panel.querySelector(spec.charCountContainerId);
      const textarea = panel.querySelector(spec.instructionsId);

      tab[charCountMethod](6000);
      tab[charCountMethod](4600);
      tab[charCountMethod](10);

      expect(container.className).not.toMatch(/char-count-(warning|error)/);
      expect(textarea.className).not.toMatch(/textarea-(warning|error)/);
    });
  });

  describe(`${label} host subscription (onStateChange)`, () => {
    it('notifies a subscribed host when the save state is refreshed', () => {
      const { tab } = mount(TabClass, spec.panelId, { hosted: false });
      tab.onStateChange = vi.fn();

      tab._updateSaveButtonStates();

      expect(tab.onStateChange).toHaveBeenCalledTimes(1);
    });

    it('notifies BEFORE the missing-panel guard, which is the hosted case', () => {
      // A hosted tab renders no action row, so `panel` is legitimately absent —
      // and that is exactly the case the settings-page footer Save and the
      // editor header depend on hearing about. Move the notify below the
      // `if (!panel) return;` and CouncilManager silently stops following the
      // editor's dirty state while every other unit test stays green.
      const onStateChange = vi.fn();
      const ctx = {
        modal: { querySelector: () => null },
        onStateChange,
        _isDirty: true,
        selectedCouncilId: null,
        councils: [],
        // Reached only if the guard stops short-circuiting.
        _readConfigFromUI: () => { throw new Error('past the panel guard'); },
        _isFileCouncil: TabClass.prototype._isFileCouncil,
        _updateDirtyHint: () => { throw new Error('past the panel guard'); }
      };

      expect(() => TabClass.prototype._updateSaveButtonStates.call(ctx)).not.toThrow();

      expect(onStateChange).toHaveBeenCalledTimes(1);
    });

    it('is optional: an unsubscribed tab is a no-op', () => {
      const { tab } = mount(TabClass, spec.panelId, { hosted: false });

      expect(tab.onStateChange).toBeNull();
      expect(() => tab._updateSaveButtonStates()).not.toThrow();
    });
  });
}
