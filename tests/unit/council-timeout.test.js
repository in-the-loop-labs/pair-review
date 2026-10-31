// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for the shared council timeout mixin (public/js/utils/council-timeout.js).
 *
 * Both council tabs mix in the same methods but address voices differently:
 * AdvancedConfigTab by { level, index }, VoiceCentricConfigTab by { index }.
 * Each shape is exercised against the tab's real markup (its own HTML builders
 * and TimeoutSelect mounts), so a TIMEOUT_DOM that drifts from the markup fails
 * here. config-tab-timeout.test.js covers the same methods with a minimal mock
 * DOM.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const CouncilTimeout = require('../../public/js/utils/council-timeout.js');
require('../../public/js/components/TimeoutSelect.js');
// The tabs reference TimeoutSelect as a bare global, as in the browser.
globalThis.TimeoutSelect = window.TimeoutSelect;
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');
const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');

const PROVIDERS = {
  claude: { id: 'claude', name: 'Claude', models: [], defaultModel: 'sonnet' },
  pi: { id: 'pi', name: 'Pi', models: [], defaultModel: 'default', defaultTimeout: 900000 },
};

/** Give every provider dropdown real options so setting .value sticks in jsdom. */
function fillProviderSelects(panel) {
  panel.querySelectorAll('.voice-provider').forEach(select => {
    select.innerHTML = Object.keys(PROVIDERS).map(id => `<option value="${id}">${id}</option>`).join('');
    select.value = 'claude';
  });
}

/**
 * Per-tab fixtures. Each renders the tab's own markup with two voices whose
 * keys differ only where that tab's addressing matters.
 */
const SHAPES = [
  {
    name: 'AdvancedConfigTab ({ level, index })',
    create() {
      const modal = document.createElement('div');
      const panel = document.createElement('div');
      panel.id = 'tab-panel-advanced';
      modal.appendChild(panel);
      const tab = new AdvancedConfigTab(modal);
      tab.providers = PROVIDERS;
      panel.innerHTML = tab._buildCouncilHTML();
      // Level 1 and level 2 both render voice index 0: only the level tells them apart.
      tab._mountTimeoutSelects(panel);
      fillProviderSelects(panel);
      return { tab, panel };
    },
    keyA: { level: '1', index: '0' },
    keyB: { level: '2', index: '0' },
    wrapper: (panel, key) => panel.querySelector(`.participant-wrapper[data-level="${key.level}"][data-index="${key.index}"]`),
    orchTimeoutId: 'adv-orchestration-timeout',
    orchToggleId: 'adv-orchestration-timeout-toggle',
  },
  {
    name: 'VoiceCentricConfigTab ({ index })',
    create() {
      const modal = document.createElement('div');
      const panel = document.createElement('div');
      panel.id = 'tab-panel-council';
      modal.appendChild(panel);
      const tab = new VoiceCentricConfigTab(modal);
      tab.providers = PROVIDERS;
      panel.innerHTML = tab._buildHTML();
      const list = panel.querySelector('.vc-reviewer').parentNode;
      list.insertAdjacentHTML('beforeend', tab._buildReviewerRowHTML(1));
      tab._mountTimeoutSelects(panel);
      fillProviderSelects(panel);
      return { tab, panel };
    },
    keyA: { index: '0' },
    keyB: { index: '1' },
    wrapper: (panel, key) => panel.querySelector(`.vc-reviewer[data-index="${key.index}"]`),
    orchTimeoutId: 'vc-orchestration-timeout',
    orchToggleId: 'vc-orchestration-timeout-toggle',
  },
];

describe('CouncilTimeout.resolveProviderSwitchTimeout', () => {
  const { resolveProviderSwitchTimeout } = CouncilTimeout;

  it('follows the new default when the value was at the old default', () => {
    expect(resolveProviderSwitchTimeout(600000, 600000, 900000)).toBe(900000);
    expect(resolveProviderSwitchTimeout(900000, 900000, 600000)).toBe(600000);
  });

  it('keeps a customised value unless the new default is longer', () => {
    expect(resolveProviderSwitchTimeout(1800000, 600000, 900000)).toBe(1800000);
    expect(resolveProviderSwitchTimeout(300000, 600000, 900000)).toBe(900000);
  });

  it('uses the new default when the old default is unknown', () => {
    expect(resolveProviderSwitchTimeout(1800000, null, 900000)).toBe(900000);
  });
});

describe('CouncilTimeout mixin wiring', () => {
  it('gives both tabs the same shared methods', () => {
    for (const [name, fn] of Object.entries(CouncilTimeout.methods)) {
      expect(AdvancedConfigTab.prototype[name]).toBe(fn);
      expect(VoiceCentricConfigTab.prototype[name]).toBe(fn);
    }
  });
});

describe.each(SHAPES)('CouncilTimeout on $name', (shape) => {
  let tab;
  let panel;

  const timeoutEl = (key) => shape.wrapper(panel, key).querySelector(`.${tab.constructor.TIMEOUT_DOM.timeoutClass}`);
  const iconBtn = (key) => shape.wrapper(panel, key).querySelector('.toggle-timeout-icon');
  const providerSelect = (key) => shape.wrapper(panel, key).querySelector('.voice-provider');
  const orchTimeoutEl = () => panel.querySelector(`#${shape.orchTimeoutId}`);
  const orchIcon = () => panel.querySelector(`#${shape.orchToggleId}`);
  const orchProviderSelect = () => panel.querySelector('.voice-provider[data-target="orchestration"]');

  beforeEach(() => {
    ({ tab, panel } = shape.create());
  });

  it('renders the markup its TIMEOUT_DOM describes', () => {
    for (const key of [shape.keyA, shape.keyB]) {
      expect(timeoutEl(key)).not.toBeNull();
      expect(iconBtn(key)).not.toBeNull();
    }
    expect(orchTimeoutEl()).not.toBeNull();
    expect(orchIcon()).not.toBeNull();
  });

  describe('_updateTimeoutIcon', () => {
    it('marks only the addressed voice as custom', () => {
      tab._updateTimeoutIcon(panel, shape.keyB, '1800000');
      expect(iconBtn(shape.keyB).classList.contains('has-custom-timeout')).toBe(true);
      expect(iconBtn(shape.keyA).classList.contains('has-custom-timeout')).toBe(false);
    });

    it('compares against the voice provider default', () => {
      providerSelect(shape.keyA).value = 'pi';
      tab._updateTimeoutIcon(panel, shape.keyA, '900000');
      expect(iconBtn(shape.keyA).classList.contains('has-custom-timeout')).toBe(false);
      tab._updateTimeoutIcon(panel, shape.keyA, '600000');
      expect(iconBtn(shape.keyA).classList.contains('has-custom-timeout')).toBe(true);
    });
  });

  describe('_updateOrchestrationTimeoutIcon', () => {
    it('compares against the orchestration provider default', () => {
      tab._updateOrchestrationTimeoutIcon(panel, '900000');
      expect(orchIcon().classList.contains('has-custom-timeout')).toBe(true);
      orchProviderSelect().value = 'pi';
      tab._updateOrchestrationTimeoutIcon(panel, '900000');
      expect(orchIcon().classList.contains('has-custom-timeout')).toBe(false);
    });
  });

  describe('_applyProviderDefaultTimeout', () => {
    it('moves a voice at the old default to the new default', () => {
      const select = providerSelect(shape.keyB);
      select.dataset.previousProvider = 'claude';
      timeoutEl(shape.keyB).value = '600000';
      select.value = 'pi';

      tab._applyProviderDefaultTimeout(select);

      expect(timeoutEl(shape.keyB).value).toBe('900000');
      expect(timeoutEl(shape.keyA).value).toBe('600000');
      expect(iconBtn(shape.keyB).classList.contains('has-custom-timeout')).toBe(false);
      expect(select.dataset.previousProvider).toBe('pi');
    });

    it('keeps a customised voice timeout and flags it', () => {
      const select = providerSelect(shape.keyB);
      select.dataset.previousProvider = 'claude';
      timeoutEl(shape.keyB).value = '1800000';
      select.value = 'pi';

      tab._applyProviderDefaultTimeout(select);

      expect(timeoutEl(shape.keyB).value).toBe('1800000');
      expect(iconBtn(shape.keyB).classList.contains('has-custom-timeout')).toBe(true);
    });

    it('updates the orchestration timeout for the orchestration provider', () => {
      const select = orchProviderSelect();
      select.dataset.previousProvider = 'claude';
      orchTimeoutEl().value = '600000';
      select.value = 'pi';

      tab._applyProviderDefaultTimeout(select);

      expect(orchTimeoutEl().value).toBe('900000');
      expect(orchIcon().classList.contains('has-custom-timeout')).toBe(false);
    });
  });

  describe('_restoreVoiceTimeout', () => {
    it('shows and flags a saved non-default timeout', () => {
      const el = timeoutEl(shape.keyB);
      el.style.display = 'none';

      tab._restoreVoiceTimeout(panel, shape.keyB, el, { provider: 'claude', timeout: 1800000 });

      expect(el.value).toBe('1800000');
      expect(el.style.display).toBe('');
      expect(iconBtn(shape.keyB).classList.contains('has-custom-timeout')).toBe(true);
    });

    it('keeps the select hidden when the saved timeout is the provider default', () => {
      providerSelect(shape.keyB).value = 'pi';
      const el = timeoutEl(shape.keyB);
      el.style.display = 'none';

      tab._restoreVoiceTimeout(panel, shape.keyB, el, { provider: 'pi', timeout: 900000 });

      expect(el.value).toBe('900000');
      expect(el.style.display).toBe('none');
      expect(iconBtn(shape.keyB).classList.contains('has-custom-timeout')).toBe(false);
    });

    it('applies the provider default when nothing was saved', () => {
      const el = timeoutEl(shape.keyB);
      tab._restoreVoiceTimeout(panel, shape.keyB, el, { provider: 'pi' });
      expect(el.value).toBe('900000');
    });

    it('tolerates a missing timeout element', () => {
      expect(() => tab._restoreVoiceTimeout(panel, shape.keyB, null, { provider: 'pi', timeout: 1 })).not.toThrow();
    });
  });

  describe('_restoreOrchestrationTimeout', () => {
    it('shows and flags a saved non-default timeout', () => {
      orchTimeoutEl().style.display = 'none';
      tab._restoreOrchestrationTimeout(panel, { provider: 'claude', timeout: 1800000 });
      expect(orchTimeoutEl().value).toBe('1800000');
      expect(orchTimeoutEl().style.display).toBe('');
      expect(orchIcon().classList.contains('has-custom-timeout')).toBe(true);
    });

    it('applies the provider default when nothing was saved', () => {
      orchProviderSelect().value = 'pi';
      tab._restoreOrchestrationTimeout(panel, { provider: 'pi' });
      expect(orchTimeoutEl().value).toBe('900000');
      expect(orchIcon().classList.contains('has-custom-timeout')).toBe(false);
    });
  });
});
