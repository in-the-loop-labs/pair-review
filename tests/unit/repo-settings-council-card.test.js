// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for council card rendering in RepoSettingsPage.
 *
 * Tests resolveModelDisplay, renderCouncilCard dispatch,
 * renderVoiceCouncilCard, renderAdvancedCouncilCard,
 * setAnalysisMode (council card integration), and
 * selectCouncilOption (council card rendering on selection).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DOM helpers (same pattern as TimeoutSelect.test.js)
// ---------------------------------------------------------------------------

/**
 * Escape HTML entities — mirrors browser textContent→innerHTML behavior.
 * Used by the mock element to simulate `el.textContent = str; return el.innerHTML`.
 */
function escapeEntities(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createMockElement(tag) {
  const children = [];
  const classList = new Set();
  const attributes = {};
  const listeners = {};
  const dataset = {};

  // Track raw textContent so that innerHTML getter can return escaped version
  let _textContent = '';
  let _innerHTML = '';
  let _textContentWasSet = false;

  const el = {
    tagName: tag?.toUpperCase() || 'DIV',
    id: '',
    className: '',
    style: {},
    value: '',
    disabled: false,
    parentNode: null,
    dataset,
    _children: children,
    _listeners: listeners,

    classList: {
      add(...classes) { classes.forEach(c => classList.add(c)); el.className = [...classList].join(' '); },
      remove(...classes) { classes.forEach(c => classList.delete(c)); el.className = [...classList].join(' '); },
      contains(c) { return classList.has(c); },
      toggle(c, force) {
        if (force === undefined) { if (classList.has(c)) classList.delete(c); else classList.add(c); }
        else if (force) classList.add(c);
        else classList.delete(c);
        el.className = [...classList].join(' ');
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

    querySelector: vi.fn().mockReturnValue(null),
    querySelectorAll: vi.fn().mockReturnValue([]),

    addEventListener: vi.fn((event, handler) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push({ handler });
    }),
    removeEventListener: vi.fn((event, handler) => {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter(l => l.handler !== handler);
    }),
    dispatchEvent: vi.fn(),

    closest: vi.fn().mockReturnValue(null),
    focus: vi.fn(),
    scrollIntoView: vi.fn(),
  };

  // Simulate browser behavior: setting textContent escapes HTML in innerHTML.
  // Setting innerHTML directly stores the raw HTML string.
  Object.defineProperty(el, 'textContent', {
    get() { return _textContent; },
    set(val) {
      _textContent = val;
      _innerHTML = escapeEntities(val);
      _textContentWasSet = true;
    },
    configurable: true,
  });

  Object.defineProperty(el, 'innerHTML', {
    get() { return _innerHTML; },
    set(val) {
      _innerHTML = val;
      _textContentWasSet = false;
    },
    configurable: true,
  });

  return el;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockProviders = {
  claude: {
    id: 'claude',
    name: 'Claude',
    models: [
      { id: 'sonnet', name: 'Claude Sonnet', tier: 'balanced', default: true },
      { id: 'opus', name: 'Claude Opus', tier: 'premium' },
      { id: 'haiku', name: 'Claude Haiku', tier: 'fast' }
    ]
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    models: [
      { id: 'flash', name: 'Gemini Flash', tier: 'fast', default: true },
      { id: 'pro', name: 'Gemini Pro', tier: 'thorough' }
    ]
  }
};

const mockStandardCouncil = {
  id: 'council-1',
  name: 'Speed Council',
  type: 'council',
  config: {
    voices: [
      { provider: 'claude', model: 'sonnet', tier: 'balanced' },
      { provider: 'gemini', model: 'flash', tier: 'fast' }
    ],
    levels: { '1': true, '2': true, '3': false },
    consolidation: { provider: 'claude', model: 'sonnet', tier: 'balanced' }
  }
};

const mockAdvancedCouncil = {
  id: 'council-2',
  name: 'Deep Review',
  type: 'advanced',
  config: {
    levels: {
      '1': { enabled: true, voices: [{ provider: 'claude', model: 'haiku', tier: 'fast' }] },
      '2': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }, { provider: 'gemini', model: 'pro', tier: 'thorough' }] },
      '3': { enabled: false, voices: [] }
    },
    consolidation: { provider: 'claude', model: 'opus', tier: 'thorough' }
  }
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let RepoSettingsPage;
let elementsById;

// We need global.window and global.document to exist before requiring the module.
global.window = global.window || {};

global.document = {
  createElement: (tag) => createMockElement(tag),
  getElementById: () => null,
  querySelectorAll: () => [],
  documentElement: { getAttribute: () => 'light', setAttribute: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
};

// Load the production file — it defines the class and sets up DOMContentLoaded listener
require('../../public/js/repo-settings.js');
RepoSettingsPage = global.window.RepoSettingsPage || global.RepoSettingsPage;

// The file doesn't attach to window directly, but creates an instance on DOMContentLoaded.
// Since it's a plain class declaration in the module scope, Node makes it available via the
// require cache. We need to extract it differently — the file evaluates the class as a
// local, so we obtain it from the DOMContentLoaded handler by triggering it.
// Actually the class is in the global scope of the file, which in Node's require means it's
// local to the module. Let's use a workaround: read the source and eval it.

// The cleanest approach for this non-module file: create an instance via the
// DOMContentLoaded handler that was registered, then grab the class from it.
// But actually, since `class RepoSettingsPage` is a block-scoped declaration,
// Node's require wraps it in a function scope. Let's use a different approach.

// We'll construct a minimal RepoSettingsPage by extracting it. The DOMContentLoaded
// listener sets `window.repoSettings = new RepoSettingsPage()`. So the class is in
// closure scope. We need to make it accessible.

// The simplest reliable approach: eval the class definition in global scope.
// Let's read and eval just the class (skip the DOMContentLoaded listener).

const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(
  path.join(__dirname, '../../public/js/repo-settings.js'),
  'utf8'
);
// Extract just the class body (from "class RepoSettingsPage" to the closing brace
// before the DOMContentLoaded listener)
const classEndMarker = '\n// Initialize when DOM is ready';
const classSource = source.substring(
  source.indexOf('class RepoSettingsPage'),
  source.indexOf(classEndMarker)
);
// Evaluate in a function to capture the class
RepoSettingsPage = new Function(`${classSource}\nreturn RepoSettingsPage;`)();

beforeEach(() => {
  vi.resetAllMocks();

  elementsById = {};

  global.document = {
    createElement: vi.fn((tag) => createMockElement(tag)),
    getElementById: vi.fn((id) => elementsById[id] || null),
    querySelectorAll: vi.fn(() => []),
    documentElement: { getAttribute: vi.fn(() => 'light'), setAttribute: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  global.window = {
    location: { pathname: '/settings/test-owner/test-repo', search: '' },
    addEventListener: vi.fn(),
    getTierIcon: vi.fn((tier) => `<svg class="tier-${tier}"></svg>`),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a RepoSettingsPage instance without triggering init()
 * (init is async and calls fetch, so we bypass the constructor).
 */
function createInstance(overrides = {}) {
  const instance = Object.create(RepoSettingsPage.prototype);
  instance.owner = 'test-owner';
  instance.repo = 'test-repo';
  instance.originalSettings = {};
  instance.currentSettings = {};
  instance.hasUnsavedChanges = false;
  instance.providers = { ...mockProviders };
  instance.selectedProvider = 'claude';
  instance.councils = [];

  // Apply overrides
  Object.assign(instance, overrides);

  return instance;
}

/**
 * Register a mock element that document.getElementById can find.
 */
function registerElement(id, el) {
  if (!el) el = createMockElement('div');
  el.id = id;
  elementsById[id] = el;
  return el;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepoSettingsPage - Council Card', () => {

  // -- resolveModelDisplay --------------------------------------------------

  describe('resolveModelDisplay', () => {
    it('should return display names for known provider and model', () => {
      const instance = createInstance();
      const result = instance.resolveModelDisplay('claude', 'sonnet');
      expect(result.providerName).toBe('Claude');
      expect(result.modelName).toBe('Claude Sonnet');
    });

    it('should return display names for a different known provider', () => {
      const instance = createInstance();
      const result = instance.resolveModelDisplay('gemini', 'pro');
      expect(result.providerName).toBe('Gemini');
      expect(result.modelName).toBe('Gemini Pro');
    });

    it('should fall back to raw IDs when provider is not found', () => {
      const instance = createInstance();
      const result = instance.resolveModelDisplay('unknown-provider', 'some-model');
      expect(result.providerName).toBe('unknown-provider');
      expect(result.modelName).toBe('some-model');
    });

    it('should fall back to raw model ID when model is not found in provider', () => {
      const instance = createInstance();
      const result = instance.resolveModelDisplay('claude', 'nonexistent-model');
      expect(result.providerName).toBe('Claude');
      expect(result.modelName).toBe('nonexistent-model');
    });

    it('should return "Unknown" for null provider and model', () => {
      const instance = createInstance();
      const result = instance.resolveModelDisplay(null, null);
      expect(result.providerName).toBe('Unknown');
      expect(result.modelName).toBe('Unknown');
    });

    it('should return "Unknown" for undefined provider and model', () => {
      const instance = createInstance();
      const result = instance.resolveModelDisplay(undefined, undefined);
      expect(result.providerName).toBe('Unknown');
      expect(result.modelName).toBe('Unknown');
    });

    it('should return "Unknown" model when provider exists but model is null', () => {
      const instance = createInstance();
      const result = instance.resolveModelDisplay('claude', null);
      expect(result.providerName).toBe('Claude');
      expect(result.modelName).toBe('Unknown');
    });

    it('should return raw IDs when providers object is empty', () => {
      const instance = createInstance({ providers: {} });
      const result = instance.resolveModelDisplay('claude', 'sonnet');
      expect(result.providerName).toBe('claude');
      expect(result.modelName).toBe('sonnet');
    });
  });

  // -- renderCouncilCard (dispatch) -----------------------------------------

  describe('renderCouncilCard', () => {
    it('should dispatch to renderVoiceCouncilCard for type "council"', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');
      instance.renderVoiceCouncilCard = vi.fn();
      instance.renderAdvancedCouncilCard = vi.fn();

      instance.renderCouncilCard(mockStandardCouncil);

      expect(instance.renderVoiceCouncilCard).toHaveBeenCalledWith(mockStandardCouncil);
      expect(instance.renderAdvancedCouncilCard).not.toHaveBeenCalled();
    });

    it('should dispatch to renderAdvancedCouncilCard for type "advanced"', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');
      instance.renderVoiceCouncilCard = vi.fn();
      instance.renderAdvancedCouncilCard = vi.fn();

      instance.renderCouncilCard(mockAdvancedCouncil);

      expect(instance.renderAdvancedCouncilCard).toHaveBeenCalledWith(mockAdvancedCouncil);
      expect(instance.renderVoiceCouncilCard).not.toHaveBeenCalled();
    });

    it('should default to renderVoiceCouncilCard for unknown type', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');
      instance.renderVoiceCouncilCard = vi.fn();
      instance.renderAdvancedCouncilCard = vi.fn();

      const unknownTypeCouncil = { ...mockStandardCouncil, type: 'unknown' };
      instance.renderCouncilCard(unknownTypeCouncil);

      expect(instance.renderVoiceCouncilCard).toHaveBeenCalledWith(unknownTypeCouncil);
      expect(instance.renderAdvancedCouncilCard).not.toHaveBeenCalled();
    });

    it('should return early for null council', () => {
      const instance = createInstance();
      instance.renderVoiceCouncilCard = vi.fn();
      instance.renderAdvancedCouncilCard = vi.fn();

      instance.renderCouncilCard(null);

      expect(instance.renderVoiceCouncilCard).not.toHaveBeenCalled();
      expect(instance.renderAdvancedCouncilCard).not.toHaveBeenCalled();
    });

    it('should return early for undefined council', () => {
      const instance = createInstance();
      instance.renderVoiceCouncilCard = vi.fn();
      instance.renderAdvancedCouncilCard = vi.fn();

      instance.renderCouncilCard(undefined);

      expect(instance.renderVoiceCouncilCard).not.toHaveBeenCalled();
      expect(instance.renderAdvancedCouncilCard).not.toHaveBeenCalled();
    });
  });

  // -- renderVoiceCouncilCard -----------------------------------------------

  describe('renderVoiceCouncilCard', () => {
    it('should render council name', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderVoiceCouncilCard(mockStandardCouncil);

      expect(container.innerHTML).toContain('Speed Council');
    });

    it('should show enabled levels summary', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderVoiceCouncilCard(mockStandardCouncil);

      // Levels 1 and 2 are enabled, 3 is not
      expect(container.innerHTML).toContain('Levels 1, 2');
      expect(container.innerHTML).not.toContain('Levels 1, 2, 3');
    });

    it('should show all levels when all are enabled', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const allLevelsCouncil = {
        ...mockStandardCouncil,
        config: {
          ...mockStandardCouncil.config,
          levels: { '1': true, '2': true, '3': true }
        }
      };

      instance.renderVoiceCouncilCard(allLevelsCouncil);

      expect(container.innerHTML).toContain('Levels 1, 2, 3');
    });

    it('should show "No levels configured" when none are enabled', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const noLevelsCouncil = {
        ...mockStandardCouncil,
        config: {
          ...mockStandardCouncil.config,
          levels: { '1': false, '2': false, '3': false }
        }
      };

      instance.renderVoiceCouncilCard(noLevelsCouncil);

      expect(container.innerHTML).toContain('No levels configured');
    });

    it('should render each voice with tier text and provider/model name', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderVoiceCouncilCard(mockStandardCouncil);

      // Check provider/model names appear
      expect(container.innerHTML).toContain('Claude');
      expect(container.innerHTML).toContain('Claude Sonnet');
      expect(container.innerHTML).toContain('Gemini');
      expect(container.innerHTML).toContain('Gemini Flash');

      // Check tier labels appear as text
      expect(container.innerHTML).toContain('council-card-tier');
      expect(container.innerHTML).toContain('balanced');
      expect(container.innerHTML).toContain('fast');
    });

    it('should render consolidation section when present', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderVoiceCouncilCard(mockStandardCouncil);

      expect(container.innerHTML).toContain('Consolidation');
      expect(container.innerHTML).toContain('council-card-consolidation');
      expect(container.innerHTML).toContain('council-card-divider');
    });

    it('should omit consolidation when not present', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const noConsolidation = {
        ...mockStandardCouncil,
        config: {
          voices: mockStandardCouncil.config.voices,
          levels: mockStandardCouncil.config.levels
          // no consolidation
        }
      };

      instance.renderVoiceCouncilCard(noConsolidation);

      expect(container.innerHTML).not.toContain('Consolidation');
      expect(container.innerHTML).not.toContain('council-card-divider');
    });

    it('should omit consolidation when provider is missing', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const noConsolProvider = {
        ...mockStandardCouncil,
        config: {
          voices: mockStandardCouncil.config.voices,
          levels: mockStandardCouncil.config.levels,
          consolidation: { model: 'sonnet' } // no provider
        }
      };

      instance.renderVoiceCouncilCard(noConsolProvider);

      expect(container.innerHTML).not.toContain('Consolidation');
    });

    it('should handle single-voice council', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const singleVoice = {
        id: 'single',
        name: 'Solo Council',
        type: 'council',
        config: {
          voices: [{ provider: 'claude', model: 'opus', tier: 'premium' }],
          levels: { '1': true, '2': false, '3': false },
          consolidation: null
        }
      };

      instance.renderVoiceCouncilCard(singleVoice);

      expect(container.innerHTML).toContain('Solo Council');
      expect(container.innerHTML).toContain('Claude Opus');
      expect(container.innerHTML).toContain('Levels 1');
    });

    it('should handle council with empty voices array', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const emptyVoices = {
        id: 'empty',
        name: 'Empty Council',
        type: 'council',
        config: {
          voices: [],
          levels: { '1': true },
        }
      };

      instance.renderVoiceCouncilCard(emptyVoices);

      expect(container.innerHTML).toContain('Empty Council');
      expect(container.innerHTML).toContain('council-card');
    });

    it('should handle council with missing config', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const noConfig = {
        id: 'no-config',
        name: 'No Config',
        type: 'council'
        // no config
      };

      instance.renderVoiceCouncilCard(noConfig);

      expect(container.innerHTML).toContain('No Config');
      expect(container.innerHTML).toContain('No levels configured');
    });

    it('should return early when container is missing', () => {
      const instance = createInstance();
      // Do not register model-card-preview

      // Should not throw
      expect(() => instance.renderVoiceCouncilCard(mockStandardCouncil)).not.toThrow();
    });

    it('should use escapeHtml for council name to prevent XSS', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const xssCouncil = {
        id: 'xss',
        name: '<script>alert("xss")</script>',
        type: 'council',
        config: {
          voices: [],
          levels: {},
        }
      };

      instance.renderVoiceCouncilCard(xssCouncil);

      // The raw script tag should not appear in the output
      expect(container.innerHTML).not.toContain('<script>');
      // The escapeHtml function uses DOM textContent/innerHTML, so it will produce
      // entity-escaped output
      expect(container.innerHTML).toContain('&lt;script&gt;');
    });

    it('should omit tier label when voice has no tier', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const noTierCouncil = {
        id: 'no-tier',
        name: 'No Tier',
        type: 'council',
        config: {
          voices: [{ provider: 'claude', model: 'sonnet' }],
          levels: { '1': true },
        }
      };

      instance.renderVoiceCouncilCard(noTierCouncil);

      expect(container.innerHTML).not.toContain('council-card-tier');
    });
  });

  // -- renderAdvancedCouncilCard --------------------------------------------

  describe('renderAdvancedCouncilCard', () => {
    it('should render council name with Advanced badge', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderAdvancedCouncilCard(mockAdvancedCouncil);

      expect(container.innerHTML).toContain('Deep Review');
      expect(container.innerHTML).toContain('Advanced');
      expect(container.innerHTML).toContain('council-card-badge-advanced');
    });

    it('should show level headers for enabled levels only', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderAdvancedCouncilCard(mockAdvancedCouncil);

      // Level 1 and 2 are enabled
      expect(container.innerHTML).toContain('Level 1 — Isolation');
      expect(container.innerHTML).toContain('Level 2 — File Context');
      // Level 3 is disabled
      expect(container.innerHTML).not.toContain('Level 3 — Codebase');
    });

    it('should render voices grouped by level', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderAdvancedCouncilCard(mockAdvancedCouncil);

      // Level 1 has Claude Haiku
      expect(container.innerHTML).toContain('Claude Haiku');
      // Level 2 has Claude Sonnet and Gemini Pro
      expect(container.innerHTML).toContain('Claude Sonnet');
      expect(container.innerHTML).toContain('Gemini Pro');
    });

    it('should render tier text for each voice', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderAdvancedCouncilCard(mockAdvancedCouncil);

      expect(container.innerHTML).toContain('council-card-tier');
      expect(container.innerHTML).toContain('fast');
      expect(container.innerHTML).toContain('balanced');
      expect(container.innerHTML).toContain('thorough');
    });

    it('should render consolidation as "Orchestration"', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderAdvancedCouncilCard(mockAdvancedCouncil);

      expect(container.innerHTML).toContain('Orchestration');
      expect(container.innerHTML).toContain('council-card-consolidation');
      // Claude Opus is the consolidation model
      expect(container.innerHTML).toContain('Claude Opus');
    });

    it('should omit consolidation when not present', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const noConsol = {
        ...mockAdvancedCouncil,
        config: {
          ...mockAdvancedCouncil.config,
          consolidation: null
        }
      };

      instance.renderAdvancedCouncilCard(noConsol);

      expect(container.innerHTML).not.toContain('Orchestration');
      expect(container.innerHTML).not.toContain('council-card-divider');
    });

    it('should handle all three levels enabled', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const allLevels = {
        id: 'all',
        name: 'Full Council',
        type: 'advanced',
        config: {
          levels: {
            '1': { enabled: true, voices: [{ provider: 'claude', model: 'haiku', tier: 'fast' }] },
            '2': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
            '3': { enabled: true, voices: [{ provider: 'claude', model: 'opus', tier: 'premium' }] }
          },
          consolidation: { provider: 'claude', model: 'opus' }
        }
      };

      instance.renderAdvancedCouncilCard(allLevels);

      expect(container.innerHTML).toContain('Level 1 — Isolation');
      expect(container.innerHTML).toContain('Level 2 — File Context');
      expect(container.innerHTML).toContain('Level 3 — Codebase');
    });

    it('should handle levels with empty voices array', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const emptyVoicesLevel = {
        id: 'empty-voices',
        name: 'Empty Voices',
        type: 'advanced',
        config: {
          levels: {
            '1': { enabled: true, voices: [] },
            '2': { enabled: false, voices: [] },
            '3': { enabled: false, voices: [] }
          }
        }
      };

      instance.renderAdvancedCouncilCard(emptyVoicesLevel);

      expect(container.innerHTML).toContain('Level 1 — Isolation');
      // No voices, but the level header should still be shown
      expect(container.innerHTML).toContain('council-card-level-header');
    });

    it('should handle missing config gracefully', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const noConfig = {
        id: 'no-config',
        name: 'No Config',
        type: 'advanced'
      };

      instance.renderAdvancedCouncilCard(noConfig);

      expect(container.innerHTML).toContain('No Config');
      expect(container.innerHTML).toContain('Advanced');
    });

    it('should return early when container is missing', () => {
      const instance = createInstance();
      // Do not register model-card-preview

      expect(() => instance.renderAdvancedCouncilCard(mockAdvancedCouncil)).not.toThrow();
    });

    it('should use escapeHtml for council name to prevent XSS', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const xssCouncil = {
        id: 'xss',
        name: '"><img src=x onerror=alert(1)>',
        type: 'advanced',
        config: {
          levels: {},
        }
      };

      instance.renderAdvancedCouncilCard(xssCouncil);

      // The dangerous HTML should be escaped
      expect(container.innerHTML).not.toContain('<img');
      expect(container.innerHTML).toContain('&lt;img');
    });

    it('should escape level header via escapeHtml', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      // The level labels are hardcoded ('Level 1 — Isolation', etc.), but escapeHtml
      // is still called on them. Verify the standard labels pass through safely.
      instance.renderAdvancedCouncilCard(mockAdvancedCouncil);

      expect(container.innerHTML).toContain('Level 1 — Isolation');
      expect(container.innerHTML).toContain('Level 2 — File Context');
    });

    it('should omit tier label when voice has no tier', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const noTierAdvanced = {
        id: 'no-tier',
        name: 'No Tier',
        type: 'advanced',
        config: {
          levels: {
            '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] }
          }
        }
      };

      instance.renderAdvancedCouncilCard(noTierAdvanced);

      expect(container.innerHTML).not.toContain('council-card-tier');
    });

    it('should handle levels with multiple voices', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderAdvancedCouncilCard(mockAdvancedCouncil);

      // Level 2 has two voices
      const html = container.innerHTML;
      // Match the reviewer div class exactly (not the name/tier subclasses)
      const reviewerMatches = html.match(/class="council-card-reviewer"/g);
      // 1 from L1 (haiku) + 2 from L2 (sonnet + pro) + 1 consolidation = 4
      expect(reviewerMatches).toHaveLength(4);
    });
  });

  // -- setAnalysisMode (council card integration) ---------------------------

  describe('setAnalysisMode - council card integration', () => {
    function setupModePanels() {
      const singlePanel = registerElement('mode-panel-single');
      const councilPanel = registerElement('mode-panel-council');
      const cardPreview = registerElement('model-card-preview');
      return { singlePanel, councilPanel, cardPreview };
    }

    it('should show model card preview in single mode', () => {
      const instance = createInstance();
      instance.renderModelCard = vi.fn();
      instance.checkForChanges = vi.fn();
      const { cardPreview } = setupModePanels();

      instance.setAnalysisMode('single');

      expect(cardPreview.style.display).toBe('');
      expect(instance.renderModelCard).toHaveBeenCalled();
    });

    it('should show single panel and hide council panel in single mode', () => {
      const instance = createInstance();
      instance.renderModelCard = vi.fn();
      instance.checkForChanges = vi.fn();
      const { singlePanel, councilPanel } = setupModePanels();

      instance.setAnalysisMode('single');

      expect(singlePanel.style.display).toBe('');
      expect(councilPanel.style.display).toBe('none');
    });

    it('should show council panel and hide single panel in council mode', () => {
      const instance = createInstance();
      instance.checkForChanges = vi.fn();
      const { singlePanel, councilPanel } = setupModePanels();

      instance.setAnalysisMode('council');

      expect(singlePanel.style.display).toBe('none');
      expect(councilPanel.style.display).toBe('');
    });

    it('should show council card when council mode with selected council', () => {
      const instance = createInstance({
        currentSettings: { default_council_id: 'council-1' },
        councils: [mockStandardCouncil]
      });
      instance.checkForChanges = vi.fn();
      const { cardPreview } = setupModePanels();

      instance.setAnalysisMode('council');

      expect(cardPreview.style.display).toBe('');
      // Should have rendered the council card
      expect(cardPreview.innerHTML).toContain('Speed Council');
    });

    it('should hide preview when council mode without selected council', () => {
      const instance = createInstance({
        currentSettings: { default_council_id: null },
        councils: [mockStandardCouncil]
      });
      instance.checkForChanges = vi.fn();
      const { cardPreview } = setupModePanels();

      instance.setAnalysisMode('council');

      expect(cardPreview.style.display).toBe('none');
    });

    it('should hide preview when council mode with non-existent council ID', () => {
      const instance = createInstance({
        currentSettings: { default_council_id: 'nonexistent' },
        councils: [mockStandardCouncil]
      });
      instance.checkForChanges = vi.fn();
      const { cardPreview } = setupModePanels();

      instance.setAnalysisMode('council');

      expect(cardPreview.style.display).toBe('none');
    });

    it('should set default_tab to "council" in council mode', () => {
      const instance = createInstance();
      instance.checkForChanges = vi.fn();
      setupModePanels();

      instance.setAnalysisMode('council');

      expect(instance.currentSettings.default_tab).toBe('council');
    });

    it('should set default_tab to "single" in single mode', () => {
      const instance = createInstance();
      instance.renderModelCard = vi.fn();
      instance.checkForChanges = vi.fn();
      setupModePanels();

      instance.setAnalysisMode('single');

      expect(instance.currentSettings.default_tab).toBe('single');
    });

    it('should call checkForChanges when markChanged is true', () => {
      const instance = createInstance();
      instance.renderModelCard = vi.fn();
      instance.checkForChanges = vi.fn();
      setupModePanels();

      instance.setAnalysisMode('single', true);

      expect(instance.checkForChanges).toHaveBeenCalled();
    });

    it('should not call checkForChanges when markChanged is false', () => {
      const instance = createInstance();
      instance.renderModelCard = vi.fn();
      instance.checkForChanges = vi.fn();
      setupModePanels();

      instance.setAnalysisMode('single', false);

      expect(instance.checkForChanges).not.toHaveBeenCalled();
    });
  });

  // -- selectCouncilOption (council card integration) -----------------------

  describe('selectCouncilOption - council card integration', () => {
    it('should render council card when a council is selected', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil, mockAdvancedCouncil],
        currentSettings: {}
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      const cardPreview = registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, 'council-1');

      expect(cardPreview.style.display).toBe('');
      expect(cardPreview.innerHTML).toContain('Speed Council');
    });

    it('should render advanced council card when advanced council selected', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil, mockAdvancedCouncil],
        currentSettings: {}
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      const cardPreview = registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, 'council-2');

      expect(cardPreview.style.display).toBe('');
      expect(cardPreview.innerHTML).toContain('Deep Review');
      expect(cardPreview.innerHTML).toContain('Advanced');
    });

    it('should hide preview when deselecting (empty value)', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: { default_council_id: 'council-1' }
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      const cardPreview = registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, '');

      expect(cardPreview.style.display).toBe('none');
    });

    it('should hide preview when selecting non-existent council', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: {}
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      const cardPreview = registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, 'nonexistent-id');

      expect(cardPreview.style.display).toBe('none');
    });

    it('should update currentSettings.default_council_id', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: {}
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      const cardPreview = registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, 'council-1');

      expect(instance.currentSettings.default_council_id).toBe('council-1');
    });

    it('should set default_council_id to null for empty value', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: { default_council_id: 'council-1' }
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      const cardPreview = registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, '');

      expect(instance.currentSettings.default_council_id).toBeNull();
    });

    it('should call checkForChanges after selection', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: {}
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, 'council-1');

      expect(instance.checkForChanges).toHaveBeenCalled();
    });

    it('should re-render the dropdown after selection', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: {}
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, 'council-1');

      expect(instance.renderCouncilDropdown).toHaveBeenCalled();
    });

    it('should close the dropdown after selection', () => {
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: {}
      });
      instance.renderCouncilDropdown = vi.fn();
      instance.closeCouncilDropdown = vi.fn();
      instance.checkForChanges = vi.fn();
      registerElement('model-card-preview');
      const container = createMockElement('div');

      instance.selectCouncilOption(container, 'council-1');

      expect(instance.closeCouncilDropdown).toHaveBeenCalledWith(container);
    });
  });

  // -- escapeHtml (XSS protection) ------------------------------------------

  describe('escapeHtml', () => {
    it('should escape angle brackets', () => {
      const instance = createInstance();
      const result = instance.escapeHtml('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should escape ampersands', () => {
      const instance = createInstance();
      const result = instance.escapeHtml('foo & bar');
      expect(result).toContain('&amp;');
    });

    it('should return empty string for null input', () => {
      const instance = createInstance();
      expect(instance.escapeHtml(null)).toBe('');
    });

    it('should return empty string for undefined input', () => {
      const instance = createInstance();
      expect(instance.escapeHtml(undefined)).toBe('');
    });

    it('should return empty string for empty string input', () => {
      const instance = createInstance();
      expect(instance.escapeHtml('')).toBe('');
    });

    it('should pass through safe strings unchanged', () => {
      const instance = createInstance();
      expect(instance.escapeHtml('Hello World')).toBe('Hello World');
    });
  });
});
