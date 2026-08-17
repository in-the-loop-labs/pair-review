// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for council card rendering in RepoSettingsPage.
 *
 * Tests resolveModelDisplay, renderCouncilCard (layout dispatch and the markup
 * each layout produces), setAnalysisMode (council card integration), and
 * selectCouncilOption (council card rendering on selection).
 *
 * renderCouncilCard is the page's ONLY council-preview entry point: it looks up
 * #model-card-preview, binds the page's alias-aware resolveModelDisplay, and
 * hands the council to CouncilCard.render, which owns the type→layout rule for
 * every council surface in the app. The page used to re-implement that dispatch
 * in renderVoiceCouncilCard/renderAdvancedCouncilCard and drifted from it.
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
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    models: [
      { id: 'flash', name: 'Antigravity Flash', tier: 'fast', default: true },
      { id: 'pro', name: 'Antigravity Pro', tier: 'thorough' }
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
      { provider: 'antigravity', model: 'flash', tier: 'fast' }
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
      '2': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }, { provider: 'antigravity', model: 'pro', tier: 'thorough' }] },
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

// The council card is rendered by the shared CouncilCard component, which the
// page's renderCouncilCard delegates to. Expose it as a global so the eval'd
// class methods can resolve it (they look up window.CouncilCard || CouncilCard).
global.CouncilCard = require('../../public/js/components/CouncilCard.js').CouncilCard;

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
    // Both are resolved off `window` at call time by the page, exactly as
    // repo-settings.html's script order provides them: the alias-aware
    // display-name resolver, and the component that owns the shared
    // "council no longer exists" sentence.
    ProviderMap: require('../../public/js/utils/provider-map.js'),
    CouncilDropdown: require('../../public/js/components/CouncilDropdown.js').CouncilDropdown,
    CouncilCard: global.CouncilCard,
  };
});

const STALE_LABEL = require('../../public/js/components/CouncilDropdown.js').CouncilDropdown.STALE_COUNCIL_LABEL;
const UNAVAILABLE_LABEL = require('../../public/js/components/CouncilDropdown.js').CouncilDropdown.COUNCILS_UNAVAILABLE_LABEL;

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
      const result = instance.resolveModelDisplay('antigravity', 'pro');
      expect(result.providerName).toBe('Antigravity');
      expect(result.modelName).toBe('Antigravity Pro');
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
    // The layout is now chosen inside CouncilCard.render, so these assert on
    // the markup each layout produces rather than on which page method ran.
    // `.council-card-summary` is emitted only by the voice layout;
    // `.council-card-badge-advanced` only by the advanced one.
    const VOICE_MARKER = 'council-card-summary';
    const ADVANCED_MARKER = 'council-card-badge-advanced';

    it('should render the voice layout for type "council"', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockStandardCouncil);

      expect(container.innerHTML).toContain(VOICE_MARKER);
      expect(container.innerHTML).not.toContain(ADVANCED_MARKER);
    });

    it('should render the advanced layout for type "advanced"', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockAdvancedCouncil);

      expect(container.innerHTML).toContain(ADVANCED_MARKER);
      expect(container.innerHTML).not.toContain(VOICE_MARKER);
    });

    // REGRESSION: this used to assert unknown/untyped ⇒ VOICE, which is what let
    // the page render a voice layout under a CouncilDropdown badge reading
    // "Advanced". Untyped rows predate the `type` column and are level-centric
    // (AdvancedConfigTab.loadCouncils claims `!c.type || c.type === 'advanced'`,
    // VoiceCentricConfigTab takes only `c.type === 'council'`, and
    // POST /api/councils stores `type || 'advanced'`), so advanced is correct.
    it('should render the advanced layout for a legacy untyped council', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      const untypedCouncil = {
        id: 'legacy',
        name: 'Legacy Council',
        // no `type` — a row written before the column existed
        config: {
          levels: {
            '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] }
          }
        }
      };
      instance.renderCouncilCard(untypedCouncil);

      expect(container.innerHTML).toContain(ADVANCED_MARKER);
      expect(container.innerHTML).not.toContain(VOICE_MARKER);
      // The level-keyed config actually renders, rather than collapsing to an
      // empty reviewer list the way the voice layout rendered it.
      expect(container.innerHTML).toContain('Level 1 — Isolation');
      expect(container.innerHTML).toContain('Claude / Claude Sonnet');
    });

    it('should render the advanced layout for an unrecognized type', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard({ ...mockStandardCouncil, type: 'unknown' });

      expect(container.innerHTML).toContain(ADVANCED_MARKER);
      expect(container.innerHTML).not.toContain(VOICE_MARKER);
    });

    it('should return early for null council, leaving the card untouched', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');
      container.innerHTML = 'sentinel';

      instance.renderCouncilCard(null);

      // Deliberately NOT cleared — callers hide the container instead.
      expect(container.innerHTML).toBe('sentinel');
    });

    it('should return early for undefined council, leaving the card untouched', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');
      container.innerHTML = 'sentinel';

      instance.renderCouncilCard(undefined);

      expect(container.innerHTML).toBe('sentinel');
    });

    it('should be a no-op when the preview container is absent', () => {
      const instance = createInstance();
      // No registerElement('model-card-preview') — getElementById returns null.
      expect(() => instance.renderCouncilCard(mockStandardCouncil)).not.toThrow();
    });
  });

  // -- standard (voice) layout ----------------------------------------------

  describe('renderCouncilCard — standard (voice) layout', () => {
    it('should render council name', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockStandardCouncil);

      expect(container.innerHTML).toContain('Speed Council');
    });

    it('should show enabled levels summary', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockStandardCouncil);

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

      instance.renderCouncilCard(allLevelsCouncil);

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

      instance.renderCouncilCard(noLevelsCouncil);

      expect(container.innerHTML).toContain('No levels configured');
    });

    it('should render each voice with tier text and provider/model name', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockStandardCouncil);

      // Check provider/model names appear
      expect(container.innerHTML).toContain('Claude');
      expect(container.innerHTML).toContain('Claude Sonnet');
      expect(container.innerHTML).toContain('Antigravity');
      expect(container.innerHTML).toContain('Antigravity Flash');

      // Check tier labels appear as text
      expect(container.innerHTML).toContain('council-card-tier');
      expect(container.innerHTML).toContain('balanced');
      expect(container.innerHTML).toContain('fast');
    });

    it('should render consolidation section when present', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockStandardCouncil);

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

      instance.renderCouncilCard(noConsolidation);

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

      instance.renderCouncilCard(noConsolProvider);

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

      instance.renderCouncilCard(singleVoice);

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

      instance.renderCouncilCard(emptyVoices);

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

      instance.renderCouncilCard(noConfig);

      expect(container.innerHTML).toContain('No Config');
      expect(container.innerHTML).toContain('No levels configured');
    });

    it('should return early when container is missing', () => {
      const instance = createInstance();
      // Do not register model-card-preview

      // Should not throw
      expect(() => instance.renderCouncilCard(mockStandardCouncil)).not.toThrow();
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

      instance.renderCouncilCard(xssCouncil);

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

      instance.renderCouncilCard(noTierCouncil);

      expect(container.innerHTML).not.toContain('council-card-tier');
    });
  });

  // -- advanced layout ------------------------------------------------------

  describe('renderCouncilCard — advanced layout', () => {
    it('should render council name with Advanced badge', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockAdvancedCouncil);

      expect(container.innerHTML).toContain('Deep Review');
      expect(container.innerHTML).toContain('Advanced');
      expect(container.innerHTML).toContain('council-card-badge-advanced');
    });

    it('should show level headers for enabled levels only', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockAdvancedCouncil);

      // Level 1 and 2 are enabled
      expect(container.innerHTML).toContain('Level 1 — Isolation');
      expect(container.innerHTML).toContain('Level 2 — File Context');
      // Level 3 is disabled
      expect(container.innerHTML).not.toContain('Level 3 — Codebase');
    });

    it('should render voices grouped by level', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockAdvancedCouncil);

      // Level 1 has Claude Haiku
      expect(container.innerHTML).toContain('Claude Haiku');
      // Level 2 has Claude Sonnet and Antigravity Pro
      expect(container.innerHTML).toContain('Claude Sonnet');
      expect(container.innerHTML).toContain('Antigravity Pro');
    });

    it('should render tier text for each voice', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockAdvancedCouncil);

      expect(container.innerHTML).toContain('council-card-tier');
      expect(container.innerHTML).toContain('fast');
      expect(container.innerHTML).toContain('balanced');
      expect(container.innerHTML).toContain('thorough');
    });

    it('should render consolidation as "Orchestration"', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockAdvancedCouncil);

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

      instance.renderCouncilCard(noConsol);

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

      instance.renderCouncilCard(allLevels);

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

      instance.renderCouncilCard(emptyVoicesLevel);

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

      instance.renderCouncilCard(noConfig);

      expect(container.innerHTML).toContain('No Config');
      expect(container.innerHTML).toContain('Advanced');
    });

    it('should return early when container is missing', () => {
      const instance = createInstance();
      // Do not register model-card-preview

      expect(() => instance.renderCouncilCard(mockAdvancedCouncil)).not.toThrow();
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

      instance.renderCouncilCard(xssCouncil);

      // The dangerous HTML should be escaped
      expect(container.innerHTML).not.toContain('<img');
      expect(container.innerHTML).toContain('&lt;img');
    });

    it('should escape level header via escapeHtml', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      // The level labels are hardcoded ('Level 1 — Isolation', etc.), but escapeHtml
      // is still called on them. Verify the standard labels pass through safely.
      instance.renderCouncilCard(mockAdvancedCouncil);

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

      instance.renderCouncilCard(noTierAdvanced);

      expect(container.innerHTML).not.toContain('council-card-tier');
    });

    it('should handle levels with multiple voices', () => {
      const instance = createInstance();
      const container = registerElement('model-card-preview');

      instance.renderCouncilCard(mockAdvancedCouncil);

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

    // REGRESSION: this used to HIDE the preview, so a repo whose default council
    // had been deleted opened in Council mode looking exactly like "you never
    // configured one" — while the dead id sat in currentSettings and was
    // re-saved on the next Save. Now that the dropdown trigger names the dead
    // council, hiding here would also contradict the trigger 30px above it.
    it('should name a deleted council instead of hiding the preview', () => {
      const instance = createInstance({
        currentSettings: { default_council_id: 'nonexistent' },
        councils: [mockStandardCouncil]
      });
      instance.checkForChanges = vi.fn();
      const { cardPreview } = setupModePanels();

      instance.setAnalysisMode('council');

      expect(cardPreview.style.display).toBe('');
      expect(cardPreview.innerHTML).toContain(STALE_LABEL);
      expect(cardPreview.innerHTML).toContain('council-preview-hint--stale');
    });

    // Aligned with SettingsPage#renderCouncilPreview: a chosen-but-unresolvable
    // council always gets a note, never a silently empty box. The wording is the
    // neutral "could not load" one — we cannot claim the id is dead.
    it('should explain an unloadable list rather than hiding the preview', () => {
      const instance = createInstance({
        currentSettings: { default_council_id: 'maybe-fine' },
        councils: [],
        councilsLoadFailed: true
      });
      instance.checkForChanges = vi.fn();
      const { cardPreview } = setupModePanels();

      instance.setAnalysisMode('council');

      expect(cardPreview.style.display).toBe('');
      expect(cardPreview.innerHTML).toContain(UNAVAILABLE_LABEL);
      expect(cardPreview.innerHTML).not.toContain(STALE_LABEL);
      // Neutral grey, not the warning colour reserved for a deleted council.
      expect(cardPreview.innerHTML).not.toContain('council-preview-hint--stale');
    });

    it('should still hide the preview when no council is chosen at all', () => {
      const instance = createInstance({
        currentSettings: { default_council_id: null },
        councils: [],
        councilsLoadFailed: true
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

    // Same miss-site as setAnalysisMode's, and it must tell the same story —
    // both now route through _renderCouncilPreviewFor.
    it('should name a deleted council instead of hiding the preview', () => {
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

      expect(cardPreview.style.display).toBe('');
      expect(cardPreview.innerHTML).toContain(STALE_LABEL);
      expect(cardPreview.innerHTML).toContain('council-preview-hint--stale');
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

  // -- loadCouncils: "could not load" is not "there are none" ----------------

  describe('loadCouncils', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubFetch(impl) {
      vi.stubGlobal('fetch', vi.fn(impl));
    }

    it('populates the list and clears the failure flag', async () => {
      registerElement('default-council-dropdown');
      const instance = createInstance({ councilsLoadFailed: true });
      stubFetch(async () => ({ ok: true, json: async () => ({ councils: [mockStandardCouncil] }) }));

      await instance.loadCouncils();

      expect(instance.councils).toEqual([mockStandardCouncil]);
      expect(instance.councilsLoadFailed).toBe(false);
    });

    // Mirrors SettingsPage#loadCouncils: emptying the list on failure would make
    // every stored default_council_id look deleted.
    it('keeps the previous list and records the failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      registerElement('default-council-dropdown');
      const instance = createInstance({ councils: [mockStandardCouncil] });
      stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));

      await instance.loadCouncils();

      expect(instance.councils).toEqual([mockStandardCouncil]);
      expect(instance.councilsLoadFailed).toBe(true);
    });

    it('isStaleCouncilId: only a non-empty id absent from a list we DID load', async () => {
      const instance = createInstance({ councils: [mockStandardCouncil] });
      expect(instance.isStaleCouncilId('council-1')).toBe(false);
      expect(instance.isStaleCouncilId('ghost')).toBe(true);
      expect(instance.isStaleCouncilId('')).toBe(false);
      expect(instance.isStaleCouncilId(null)).toBe(false);

      instance.councilsLoadFailed = true;
      expect(instance.isStaleCouncilId('ghost')).toBe(false);
    });
  });

  // -- renderCouncilDropdown: the trigger names a deleted council -------------

  describe('renderCouncilDropdown', () => {
    /** Record the options the page hands the shared component. */
    function stubDropdown() {
      const seen = [];
      class FakeDropdown {
        // The real component carries the shared sentences as statics, and the
        // page reads them off the same global it constructs from.
        static STALE_COUNCIL_LABEL = STALE_LABEL;
        static COUNCILS_UNAVAILABLE_LABEL = UNAVAILABLE_LABEL;
        constructor(opts) { Object.assign(this, opts); seen.push(this); }
        render() { this.rendered = (this.rendered || 0) + 1; }
      }
      global.window.CouncilDropdown = FakeDropdown;
      return seen;
    }

    it('passes the generic placeholder when the selection resolves', () => {
      registerElement('default-council-dropdown');
      const seen = stubDropdown();
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: { default_council_id: 'council-1' }
      });

      instance.renderCouncilDropdown();

      expect(seen[0].placeholder).toBe('Select a council...');
      expect(seen[0].emptyText).not.toContain('no longer exists');
    });

    // REGRESSION: the repo page passed the generic 'Select a council...' for a
    // dangling id, so a deleted default read as "you never configured one" —
    // while the global settings page named it. Same setting, same component,
    // two stories.
    it('names a deleted council in BOTH the placeholder and the empty text', () => {
      registerElement('default-council-dropdown');
      const seen = stubDropdown();
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: { default_council_id: 'deleted' }
      });

      instance.renderCouncilDropdown();

      expect(seen[0].placeholder).toBe(STALE_LABEL);
      // Deleting the LAST council empties the list — emptyText covers that.
      expect(seen[0].emptyText).toBe(STALE_LABEL);
    });

    it('re-applies the wording on refresh, not just on first construction', () => {
      registerElement('default-council-dropdown');
      const seen = stubDropdown();
      const instance = createInstance({
        councils: [mockStandardCouncil],
        currentSettings: { default_council_id: 'council-1' }
      });
      instance.renderCouncilDropdown();
      expect(seen).toHaveLength(1);

      // The council is deleted elsewhere and the list refreshes; the instance is
      // reused (its outside-click listener must not be re-stacked).
      instance.councils = [];
      instance.renderCouncilDropdown();

      expect(seen).toHaveLength(1);
      expect(seen[0].placeholder).toBe(STALE_LABEL);
      expect(seen[0].emptyText).toBe(STALE_LABEL);
      expect(seen[0].rendered).toBe(1);
    });

    // REGRESSION (integration review): with the list unloadable AND empty, the
    // generic fallbacks are claims this page cannot support — and the empty-list
    // one is an INSTRUCTION ("create one in Settings › Councils") resting on one.
    it('names the unloadable list instead of claiming there are none', () => {
      registerElement('default-council-dropdown');
      const seen = stubDropdown();
      const instance = createInstance({
        councils: [],
        councilsLoadFailed: true,
        currentSettings: { default_council_id: 'council-1' }
      });

      instance.renderCouncilDropdown();

      expect(seen[0].placeholder).toBe(UNAVAILABLE_LABEL);
      expect(seen[0].emptyText).toBe(UNAVAILABLE_LABEL);
      // Never the stale wording: absence from a list we could not load is not
      // evidence of deletion.
      expect(seen[0].placeholder).not.toBe(STALE_LABEL);
    });

    it('points an empty list at where councils are actually created now', () => {
      registerElement('default-council-dropdown');
      const seen = stubDropdown();
      const instance = createInstance({ councils: [], currentSettings: {} });

      instance.renderCouncilDropdown();

      // Councils are no longer created only from the analysis config modal.
      expect(seen[0].emptyText).not.toContain('analysis config');
      expect(seen[0].emptyText).toContain('Settings');
    });

    // Both pages read the sentence off the same static; neither re-types it.
    it('uses the shared CouncilDropdown constant, not a local literal', () => {
      const { CouncilDropdown } = require('../../public/js/components/CouncilDropdown.js');
      const instance = createInstance();
      expect(instance._staleCouncilLabel()).toBe(CouncilDropdown.STALE_COUNCIL_LABEL);

      const saved = global.window.CouncilDropdown;
      delete global.window.CouncilDropdown;
      try {
        // Nothing to read it from ⇒ omit the wording rather than duplicate it.
        expect(instance._staleCouncilLabel()).toBe('');
      } finally {
        global.window.CouncilDropdown = saved;
      }
    });
  });

  // -- shared provider-map delegation ----------------------------------------

  describe('resolveModelDisplay / findModelWithAliases delegate to ProviderMap', () => {
    it('calls the shared util rather than re-implementing the lookup', () => {
      const instance = createInstance();
      const spy = vi.spyOn(global.window.ProviderMap, 'resolveModelDisplay');
      try {
        instance.resolveModelDisplay('claude', 'sonnet');
        expect(spy).toHaveBeenCalledWith(instance.providers, 'claude', 'sonnet');
      } finally {
        spy.mockRestore();
      }
    });

    it('findModelWithAliases delegates too (one alias implementation)', () => {
      const instance = createInstance();
      const spy = vi.spyOn(global.window.ProviderMap, 'findModelWithAliases');
      try {
        const provider = instance.providers.claude;
        instance.findModelWithAliases(provider, 'sonnet');
        expect(spy).toHaveBeenCalledWith(provider, 'sonnet');
      } finally {
        spy.mockRestore();
      }
    });

    it('still resolves a legacy alias to the canonical model name', () => {
      const instance = createInstance({
        providers: {
          claude: {
            id: 'claude',
            name: 'Claude',
            models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', aliases: ['sonnet'] }]
          }
        }
      });
      expect(instance.resolveModelDisplay('claude', 'sonnet'))
        .toEqual({ providerName: 'Claude', modelName: 'Claude Sonnet 4.5' });
    });

    it('degrades to raw ids when the util is not loaded (never throws)', () => {
      const instance = createInstance();
      const saved = global.window.ProviderMap;
      delete global.window.ProviderMap;
      try {
        expect(instance.resolveModelDisplay('claude', 'sonnet'))
          .toEqual({ providerName: 'claude', modelName: 'sonnet' });
        expect(instance.findModelWithAliases(instance.providers.claude, 'sonnet')).toBeUndefined();
      } finally {
        global.window.ProviderMap = saved;
      }
    });

    // REGRESSION (integration review): this page passed its provider MAP, which
    // loadProviders builds WITHOUT providers that declare no models. A council
    // naming `opencode` therefore rendered "OpenCode" on /settings and in the
    // Councils preview, but a bare "opencode" here — the exact cross-surface
    // divergence the shared util exists to kill. Both other consumers pass the
    // unfiltered array; so does this one now.
    it('names a provider that declares no models, like the other two surfaces', () => {
      const raw = [
        { id: 'claude', name: 'Claude', models: [{ id: 'sonnet', name: 'Claude Sonnet' }] },
        { id: 'opencode', name: 'OpenCode', models: [] }
      ];
      const instance = createInstance({
        allProviders: raw,
        providers: { claude: raw[0] }   // what buildProviderMap leaves behind
      });

      expect(instance.resolveModelDisplay('opencode', 'gpt-x'))
        .toEqual({ providerName: 'OpenCode', modelName: 'gpt-x' });
      // The util is handed the raw list, not the filtered map.
      const spy = vi.spyOn(global.window.ProviderMap, 'resolveModelDisplay');
      try {
        instance.resolveModelDisplay('claude', 'sonnet');
        expect(spy).toHaveBeenCalledWith(raw, 'claude', 'sonnet');
      } finally {
        spy.mockRestore();
      }
    });

    it('falls back to the map when the raw list is unavailable', () => {
      const instance = createInstance({ allProviders: [] });
      expect(instance.resolveModelDisplay('claude', 'sonnet'))
        .toEqual({ providerName: 'Claude', modelName: 'Claude Sonnet' });
    });
  });

  // -- loadProviders: one array→map conversion, in the shared util ------------

  describe('loadProviders', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    const payload = {
      providers: [
        { id: 'claude', name: 'Claude', models: [{ id: 'sonnet', name: 'Claude Sonnet' }] },
        { id: 'opencode', name: 'OpenCode', models: [] }
      ]
    };

    it('keeps the raw array AND the filtered map, via ProviderMap.buildProviderMap', async () => {
      const instance = createInstance({ providers: {}, allProviders: [] });
      instance.renderProviderSelect = vi.fn();
      const spy = vi.spyOn(global.window.ProviderMap, 'buildProviderMap');
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));

      await instance.loadProviders();

      expect(spy).toHaveBeenCalledWith(payload.providers);
      expect(instance.allProviders).toEqual(payload.providers);
      expect(Object.keys(instance.providers)).toEqual(['claude']);
      spy.mockRestore();
    });

    it('empties both on failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const instance = createInstance({ allProviders: payload.providers });
      instance.renderProviderSelect = vi.fn();
      instance.showToast = vi.fn();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

      await instance.loadProviders();

      expect(instance.allProviders).toEqual([]);
      expect(instance.providers).toEqual({});
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
