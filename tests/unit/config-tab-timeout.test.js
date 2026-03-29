// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for provider-specific timeout logic in AdvancedConfigTab
 * and VoiceCentricConfigTab.
 *
 * Covers:
 * - _getProviderDefaultTimeout: provider-specific default vs static fallback
 * - _defaultConfig: uses provider-specific timeout for consolidation/orchestration
 * - _applyProviderDefaultTimeout: smart logic preserving user overrides
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DOM helpers — just enough for _applyProviderDefaultTimeout's DOM access
// ---------------------------------------------------------------------------

function createMockElement(tag) {
  const children = [];
  const classList = new Set();
  const attributes = {};
  const dataset = {};
  const listeners = {};

  const el = {
    tagName: tag?.toUpperCase() || 'DIV',
    id: '',
    value: '',
    style: {},
    innerHTML: '',
    textContent: '',
    parentNode: null,
    dataset,
    _children: children,
    _listeners: listeners,

    classList: {
      add(...classes) { classes.forEach(c => classList.add(c)); },
      remove(...classes) { classes.forEach(c => classList.delete(c)); },
      contains(c) { return classList.has(c); },
      toggle(c, force) {
        if (force === undefined) { if (classList.has(c)) classList.delete(c); else classList.add(c); }
        else if (force) classList.add(c);
        else classList.delete(c);
      },
    },

    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },

    appendChild(child) {
      children.push(child);
      child.parentNode = el;
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    contains(other) {
      if (other === el) return true;
      return children.some(c => c === other || (c.contains && c.contains(other)));
    },

    querySelector(selector) {
      return queryAll(el, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return queryAll(el, selector);
    },

    addEventListener(event, handler) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    removeEventListener(event, handler) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter(h => h !== handler);
    },
    dispatchEvent() { return true; },

    closest(selector) {
      let cur = el;
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    focus: vi.fn(),
    insertBefore(newChild, refChild) {
      const idx = children.indexOf(refChild);
      if (idx >= 0) children.splice(idx, 0, newChild);
      else children.push(newChild);
      newChild.parentNode = el;
      return newChild;
    },
    scrollIntoView: vi.fn(),
    click() {},
  };
  return el;
}

/** Very simple selector matching. */
function matchesSelector(el, selector) {
  if (selector.startsWith('.')) return el.classList && el.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  const attrMatch = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
  if (attrMatch) {
    const val = el.getAttribute(attrMatch[1]);
    if (attrMatch[2] !== undefined) return val === attrMatch[2];
    return val != null;
  }
  // compound: .class1.class2
  if (selector.includes('.') && !selector.startsWith('.')) {
    const parts = selector.split('.').filter(Boolean);
    return parts.every(p => el.classList && el.classList.contains(p));
  }
  return el.tagName === selector.toUpperCase();
}

function queryAll(root, selector) {
  const results = [];
  function walk(node) {
    if (!node._children) return;
    for (const child of node._children) {
      if (matchesSelector(child, selector)) results.push(child);
      walk(child);
    }
  }
  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Global stubs for browser environment
// ---------------------------------------------------------------------------

global.window = global.window || {};
global.Event = class MockEvent {
  constructor(type) { this.type = type; this.bubbles = false; this.target = null; }
  preventDefault() {}
  stopPropagation() {}
};
global.document = {
  createElement: (tag) => createMockElement(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
};

// TimeoutSelect is referenced in methods but we stub it on window so class-level
// references don't blow up during module load.
global.window.TimeoutSelect = {
  mount: vi.fn(() => ({ el: createMockElement('div'), value: '600000' })),
  TIMEOUT_OPTIONS: [
    { value: '300000', label: '5m' },
    { value: '600000', label: '10m', selected: true },
    { value: '900000', label: '15m' },
    { value: '1800000', label: '30m' },
    { value: '2700000', label: '45m' },
    { value: '3600000', label: '60m' },
  ],
};

// Load browser components
require('../../public/js/components/AdvancedConfigTab.js');
require('../../public/js/components/VoiceCentricConfigTab.js');

const { AdvancedConfigTab, VoiceCentricConfigTab } = global.window;

// ---------------------------------------------------------------------------
// Shared test provider definitions
// ---------------------------------------------------------------------------

const PROVIDERS = {
  claude: { id: 'claude', name: 'Claude', models: [], defaultModel: 'sonnet' },
  pi: { id: 'pi', name: 'Pi', models: [], defaultModel: 'default', defaultTimeout: 900000 },
  gemini: { id: 'gemini', name: 'Gemini', models: [], defaultModel: 'gemini-2.5-pro' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdvancedConfigTab timeout logic', () => {
  let tab;
  let mockModal;

  beforeEach(() => {
    mockModal = createMockElement('div');
    tab = new AdvancedConfigTab(mockModal);
    tab.providers = PROVIDERS;
  });

  describe('_getProviderDefaultTimeout', () => {
    it('should return provider-specific timeout when provider defines one', () => {
      expect(tab._getProviderDefaultTimeout('pi')).toBe(900000);
    });

    it('should return DEFAULT_TIMEOUT when provider has no defaultTimeout', () => {
      expect(tab._getProviderDefaultTimeout('claude')).toBe(AdvancedConfigTab.DEFAULT_TIMEOUT);
      expect(tab._getProviderDefaultTimeout('claude')).toBe(600000);
    });

    it('should return DEFAULT_TIMEOUT for unknown provider', () => {
      expect(tab._getProviderDefaultTimeout('nonexistent')).toBe(AdvancedConfigTab.DEFAULT_TIMEOUT);
    });

    it('should return DEFAULT_TIMEOUT for null/undefined provider', () => {
      expect(tab._getProviderDefaultTimeout(null)).toBe(AdvancedConfigTab.DEFAULT_TIMEOUT);
      expect(tab._getProviderDefaultTimeout(undefined)).toBe(AdvancedConfigTab.DEFAULT_TIMEOUT);
    });
  });

  describe('_defaultConfig', () => {
    it('should use provider-specific timeout when default provider has one', () => {
      tab._defaultProvider = 'pi';
      tab._defaultModel = 'default';

      const config = tab._defaultConfig();
      expect(config.consolidation.timeout).toBe(900000);
    });

    it('should use DEFAULT_TIMEOUT when default provider has no defaultTimeout', () => {
      tab._defaultProvider = 'claude';
      tab._defaultModel = 'sonnet';

      const config = tab._defaultConfig();
      expect(config.consolidation.timeout).toBe(600000);
    });

    it('should fall back to claude when _defaultProvider is not set', () => {
      // _defaultProvider is not set by constructor on AdvancedConfigTab
      // (it gets set via setDefaultOrchestration), so it defaults to 'claude'
      const config = tab._defaultConfig();
      expect(config.consolidation.timeout).toBe(600000);
      expect(config.consolidation.provider).toBe('claude');
    });
  });

  describe('_applyProviderDefaultTimeout', () => {
    /**
     * Helper: set up a mock panel with timeout elements for a voice or orchestration.
     * Returns { panel, timeoutEl, providerSelect }.
     */
    function setupForVoice({ providerId, level, index, currentTimeout, previousProvider }) {
      const panel = createMockElement('div');
      panel.id = 'tab-panel-advanced';

      const wrapper = createMockElement('div');
      wrapper.classList.add('participant-wrapper');
      wrapper.setAttribute('data-level', level);
      wrapper.setAttribute('data-index', index);
      wrapper.dataset.level = level;
      wrapper.dataset.index = index;

      const providerSelect = createMockElement('select');
      providerSelect.classList.add('voice-provider');
      providerSelect.value = providerId;
      providerSelect.dataset.level = level;
      providerSelect.dataset.index = index;
      if (previousProvider) {
        providerSelect.dataset.previousProvider = previousProvider;
      }
      wrapper.appendChild(providerSelect);

      const timeoutEl = createMockElement('div');
      timeoutEl.classList.add('adv-timeout');
      timeoutEl.value = String(currentTimeout);
      wrapper.appendChild(timeoutEl);

      // Also add timeout icon button stub
      const iconBtn = createMockElement('button');
      iconBtn.classList.add('toggle-timeout-icon');
      iconBtn.dataset.level = level;
      iconBtn.dataset.index = index;
      wrapper.appendChild(iconBtn);

      panel.appendChild(wrapper);
      mockModal.appendChild(panel);

      return { panel, timeoutEl, providerSelect };
    }

    function setupForOrchestration({ providerId, currentTimeout, previousProvider }) {
      const panel = createMockElement('div');
      panel.id = 'tab-panel-advanced';

      const orchRow = createMockElement('div');
      orchRow.id = 'orchestration-voice';

      const providerSelect = createMockElement('select');
      providerSelect.classList.add('voice-provider');
      providerSelect.value = providerId;
      providerSelect.dataset.target = 'orchestration';
      if (previousProvider) {
        providerSelect.dataset.previousProvider = previousProvider;
      }
      orchRow.appendChild(providerSelect);
      panel.appendChild(orchRow);

      const timeoutEl = createMockElement('div');
      timeoutEl.id = 'adv-orchestration-timeout';
      timeoutEl.classList.add('adv-timeout');
      timeoutEl.value = String(currentTimeout);
      panel.appendChild(timeoutEl);

      // Orchestration timeout icon stub
      const iconBtn = createMockElement('button');
      iconBtn.id = 'adv-orchestration-timeout-toggle';
      panel.appendChild(iconBtn);

      mockModal.appendChild(panel);

      return { panel, timeoutEl, providerSelect };
    }

    // ---- Voice (non-orchestration) tests ----

    it('should apply new provider default when timeout matches old default', () => {
      const { timeoutEl, providerSelect } = setupForVoice({
        providerId: 'pi',
        level: '1',
        index: '0',
        currentTimeout: 600000,    // matches claude default
        previousProvider: 'claude',
      });

      tab._applyProviderDefaultTimeout(providerSelect);

      // Switching from claude (600000) to pi (900000), current matches old default
      // -> should apply new default directly
      expect(timeoutEl.value).toBe('900000');
    });

    it('should use Math.max when user has customized timeout', () => {
      const { timeoutEl, providerSelect } = setupForVoice({
        providerId: 'claude',
        level: '1',
        index: '0',
        currentTimeout: 1800000,   // user customized to 30min
        previousProvider: 'pi',
      });

      tab._applyProviderDefaultTimeout(providerSelect);

      // Switching from pi (900000) to claude (600000), current (1800000) != old default (900000)
      // -> should use Math.max(1800000, 600000) = 1800000
      expect(timeoutEl.value).toBe('1800000');
    });

    it('should apply new default when current is higher than old default but matches old default', () => {
      const { timeoutEl, providerSelect } = setupForVoice({
        providerId: 'claude',
        level: '1',
        index: '0',
        currentTimeout: 900000,    // matches pi default
        previousProvider: 'pi',
      });

      tab._applyProviderDefaultTimeout(providerSelect);

      // Switching from pi (900000) to claude (600000), current matches old default
      // -> should apply new default directly: 600000
      expect(timeoutEl.value).toBe('600000');
    });

    it('should apply new default when no previous provider is set', () => {
      const { timeoutEl, providerSelect } = setupForVoice({
        providerId: 'pi',
        level: '1',
        index: '0',
        currentTimeout: 600000,
        previousProvider: null,
      });

      tab._applyProviderDefaultTimeout(providerSelect);

      // No previous provider -> oldDefault is null -> apply new default directly
      expect(timeoutEl.value).toBe('900000');
    });

    it('should use Math.max to preserve user override that exceeds new default', () => {
      const { timeoutEl, providerSelect } = setupForVoice({
        providerId: 'pi',
        level: '1',
        index: '0',
        currentTimeout: 1800000,   // user customized to 30min
        previousProvider: 'claude',
      });

      tab._applyProviderDefaultTimeout(providerSelect);

      // Switching from claude (600000) to pi (900000), current (1800000) != old default (600000)
      // -> should use Math.max(1800000, 900000) = 1800000
      expect(timeoutEl.value).toBe('1800000');
    });

    it('should raise timeout to new default when user override is below new default', () => {
      // Simulate a provider with custom high timeout
      tab.providers = {
        ...PROVIDERS,
        'slow-provider': { id: 'slow-provider', defaultTimeout: 2700000 }
      };

      const { timeoutEl, providerSelect } = setupForVoice({
        providerId: 'slow-provider',
        level: '1',
        index: '0',
        currentTimeout: 900000,    // user had customized above claude's 600000
        previousProvider: 'claude',
      });

      tab._applyProviderDefaultTimeout(providerSelect);

      // current (900000) != old default (600000) -> Math.max(900000, 2700000) = 2700000
      expect(timeoutEl.value).toBe('2700000');
    });

    it('should set data-previous-provider after applying', () => {
      const { providerSelect } = setupForVoice({
        providerId: 'pi',
        level: '1',
        index: '0',
        currentTimeout: 600000,
        previousProvider: 'claude',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(providerSelect.dataset.previousProvider).toBe('pi');
    });

    // ---- Orchestration tests ----

    it('should apply new provider default to orchestration timeout', () => {
      const { timeoutEl, providerSelect } = setupForOrchestration({
        providerId: 'pi',
        currentTimeout: 600000,
        previousProvider: 'claude',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(timeoutEl.value).toBe('900000');
    });

    it('should use Math.max for orchestration when user customized timeout', () => {
      const { timeoutEl, providerSelect } = setupForOrchestration({
        providerId: 'claude',
        currentTimeout: 1800000,
        previousProvider: 'pi',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      // current (1800000) != pi default (900000) -> Math.max(1800000, 600000) = 1800000
      expect(timeoutEl.value).toBe('1800000');
    });

    it('should apply orchestration default when no previous provider', () => {
      const { timeoutEl, providerSelect } = setupForOrchestration({
        providerId: 'pi',
        currentTimeout: 600000,
        previousProvider: null,
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(timeoutEl.value).toBe('900000');
    });
  });
});


describe('VoiceCentricConfigTab timeout logic', () => {
  let tab;
  let mockModal;

  beforeEach(() => {
    mockModal = createMockElement('div');
    tab = new VoiceCentricConfigTab(mockModal);
    tab.providers = PROVIDERS;
  });

  describe('_getProviderDefaultTimeout', () => {
    it('should return provider-specific timeout when provider defines one', () => {
      expect(tab._getProviderDefaultTimeout('pi')).toBe(900000);
    });

    it('should return DEFAULT_TIMEOUT when provider has no defaultTimeout', () => {
      expect(tab._getProviderDefaultTimeout('claude')).toBe(VoiceCentricConfigTab.DEFAULT_TIMEOUT);
      expect(tab._getProviderDefaultTimeout('claude')).toBe(600000);
    });

    it('should return DEFAULT_TIMEOUT for unknown provider', () => {
      expect(tab._getProviderDefaultTimeout('nonexistent')).toBe(VoiceCentricConfigTab.DEFAULT_TIMEOUT);
    });
  });

  describe('_defaultConfig', () => {
    it('should use provider-specific timeout when default provider has one', () => {
      tab._defaultProvider = 'pi';
      tab._defaultModel = 'default';

      const config = tab._defaultConfig();
      expect(config.voices[0].timeout).toBe(900000);
      expect(config.orchestration.timeout).toBe(900000);
    });

    it('should use DEFAULT_TIMEOUT when default provider has no defaultTimeout', () => {
      tab._defaultProvider = 'claude';
      tab._defaultModel = 'sonnet';

      const config = tab._defaultConfig();
      expect(config.voices[0].timeout).toBe(600000);
      expect(config.orchestration.timeout).toBe(600000);
    });

    it('should use the same timeout for both voices and orchestration', () => {
      tab._defaultProvider = 'pi';
      tab._defaultModel = 'default';

      const config = tab._defaultConfig();
      expect(config.voices[0].timeout).toBe(config.orchestration.timeout);
    });
  });

  describe('_applyProviderDefaultTimeout', () => {
    function setupForReviewer({ providerId, index, currentTimeout, previousProvider }) {
      const panel = createMockElement('div');
      panel.id = 'tab-panel-council';

      const wrapper = createMockElement('div');
      wrapper.classList.add('vc-reviewer');

      const providerSelect = createMockElement('select');
      providerSelect.classList.add('voice-provider');
      providerSelect.value = providerId;
      providerSelect.dataset.index = index;
      if (previousProvider) {
        providerSelect.dataset.previousProvider = previousProvider;
      }
      wrapper.appendChild(providerSelect);

      const timeoutEl = createMockElement('div');
      timeoutEl.classList.add('vc-timeout');
      timeoutEl.value = String(currentTimeout);
      wrapper.appendChild(timeoutEl);

      // Timeout icon stub
      const iconBtn = createMockElement('button');
      iconBtn.classList.add('toggle-timeout-icon');
      iconBtn.dataset.index = index;
      wrapper.appendChild(iconBtn);

      panel.appendChild(wrapper);
      mockModal.appendChild(panel);

      return { panel, timeoutEl, providerSelect };
    }

    function setupForOrchestration({ providerId, currentTimeout, previousProvider }) {
      const panel = createMockElement('div');
      panel.id = 'tab-panel-council';

      const orchRow = createMockElement('div');
      orchRow.id = 'vc-orchestration-voice';

      const providerSelect = createMockElement('select');
      providerSelect.classList.add('voice-provider');
      providerSelect.value = providerId;
      providerSelect.dataset.target = 'orchestration';
      if (previousProvider) {
        providerSelect.dataset.previousProvider = previousProvider;
      }
      orchRow.appendChild(providerSelect);
      panel.appendChild(orchRow);

      const timeoutEl = createMockElement('div');
      timeoutEl.id = 'vc-orchestration-timeout';
      timeoutEl.classList.add('vc-timeout');
      timeoutEl.value = String(currentTimeout);
      panel.appendChild(timeoutEl);

      // Orchestration timeout icon stub
      const iconBtn = createMockElement('button');
      iconBtn.id = 'vc-orchestration-timeout-toggle';
      panel.appendChild(iconBtn);

      mockModal.appendChild(panel);

      return { panel, timeoutEl, providerSelect };
    }

    // ---- Reviewer tests ----

    it('should apply new provider default when timeout matches old default', () => {
      const { timeoutEl, providerSelect } = setupForReviewer({
        providerId: 'pi',
        index: '0',
        currentTimeout: 600000,
        previousProvider: 'claude',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(timeoutEl.value).toBe('900000');
    });

    it('should use Math.max when user has customized timeout', () => {
      const { timeoutEl, providerSelect } = setupForReviewer({
        providerId: 'claude',
        index: '0',
        currentTimeout: 1800000,
        previousProvider: 'pi',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      // current (1800000) != pi default (900000) -> Math.max(1800000, 600000) = 1800000
      expect(timeoutEl.value).toBe('1800000');
    });

    it('should apply new default when current matches old default exactly', () => {
      const { timeoutEl, providerSelect } = setupForReviewer({
        providerId: 'claude',
        index: '0',
        currentTimeout: 900000,
        previousProvider: 'pi',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      // current (900000) matches pi default -> apply claude default directly: 600000
      expect(timeoutEl.value).toBe('600000');
    });

    it('should apply new default when no previous provider is set', () => {
      const { timeoutEl, providerSelect } = setupForReviewer({
        providerId: 'pi',
        index: '0',
        currentTimeout: 600000,
        previousProvider: null,
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(timeoutEl.value).toBe('900000');
    });

    it('should set data-previous-provider after applying', () => {
      const { providerSelect } = setupForReviewer({
        providerId: 'pi',
        index: '0',
        currentTimeout: 600000,
        previousProvider: 'claude',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(providerSelect.dataset.previousProvider).toBe('pi');
    });

    // ---- Orchestration tests ----

    it('should apply new provider default to orchestration timeout', () => {
      const { timeoutEl, providerSelect } = setupForOrchestration({
        providerId: 'pi',
        currentTimeout: 600000,
        previousProvider: 'claude',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(timeoutEl.value).toBe('900000');
    });

    it('should use Math.max for orchestration when user customized timeout', () => {
      const { timeoutEl, providerSelect } = setupForOrchestration({
        providerId: 'claude',
        currentTimeout: 1800000,
        previousProvider: 'pi',
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(timeoutEl.value).toBe('1800000');
    });

    it('should apply orchestration default when no previous provider', () => {
      const { timeoutEl, providerSelect } = setupForOrchestration({
        providerId: 'pi',
        currentTimeout: 600000,
        previousProvider: null,
      });

      tab._applyProviderDefaultTimeout(providerSelect);
      expect(timeoutEl.value).toBe('900000');
    });
  });
});
