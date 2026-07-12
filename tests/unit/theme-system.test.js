// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */

/**
 * Tests for system theme support (issue #487).
 *
 * Adds a "system" option to the theme toggle that follows
 * `prefers-color-scheme`, cycling: light → dark → system → light.
 *
 * The TDD order:
 * 1. Pure helpers (resolveTheme, nextTheme) — tested first, implemented first
 * 2. Landing page (index.js) integration — toggle click cycles 3 states,
 *    matchMedia listener responds when saved = 'system'
 * 3. PR page (pr.js) — toggleTheme cycles light→dark→system→light
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// 1. Pure helpers — resolveTheme  /  nextTheme
// ────────────────────────────────────────────────────────────────────────────

// We'll require from the index.js exports once implemented.
const INDEX_PATH = '../../public/js/index.js';

function loadExports() {
  delete require.cache[require.resolve(INDEX_PATH)];
  // getElementById must return a stub with addEventListener so the IIFE
  // init code at module scope doesn't crash on null.addEventListener.
  function el() { return { addEventListener() {}, classList: { add() {}, remove() {} } }; }
  const sandbox = {
    window: { matchMedia: vi.fn(() => ({ matches: false, addEventListener() {} })), addEventListener() {}, dispatchEvent() {}, location: { href: '' }, encodeBase64Utf8: () => '', getRepoStorageKey: () => '' },
    document: {
      documentElement: { setAttribute() {}, getAttribute() { return 'light'; } },
      getElementById: el,
      addEventListener() {},
      querySelector: el,
      querySelectorAll: () => [],
      createElement: () => ({ classList: { add() {} } }),
      body: { style: {}, appendChild() {} },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    console,
    module: { exports: {} },
    URLSearchParams,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    navigator: { clipboard: {} },
  };
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  const code = fs.readFileSync(path.resolve(__dirname, INDEX_PATH), 'utf8');
  try { vm.runInNewContext(code, sandbox, { filename: 'index.js' }); } catch (e) { console.error(e.message); }
  return sandbox.module.exports;
}

describe('resolveTheme (pure helper)', () => {
  // This will fail until resolveTheme is exported from index.js
  it('is exported from index.js', () => {
    const exp = loadExports();
    expect(exp).toHaveProperty('resolveTheme');
    expect(typeof exp.resolveTheme).toBe('function');
  });

  it('returns "light" when preference is "light" regardless of system', () => {
    const { resolveTheme } = loadExports();
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('returns "dark" when preference is "dark" regardless of system', () => {
    const { resolveTheme } = loadExports();
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('returns system-dark when preference is "system" and OS is dark', () => {
    const { resolveTheme } = loadExports();
    expect(resolveTheme('system', true)).toBe('dark');
  });

  it('returns system-light when preference is "system" and OS is light', () => {
    const { resolveTheme } = loadExports();
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('falls back to system when no preference stored (null)', () => {
    const { resolveTheme } = loadExports();
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
  });

  it('falls back to system when preference is undefined', () => {
    const { resolveTheme } = loadExports();
    expect(resolveTheme(undefined, true)).toBe('dark');
    expect(resolveTheme(undefined, false)).toBe('light');
  });
});

describe('nextTheme (pure helper)', () => {
  it('is exported from index.js', () => {
    const exp = loadExports();
    expect(exp).toHaveProperty('nextTheme');
    expect(typeof exp.nextTheme).toBe('function');
  });

  it('cycles light → dark → system → light', () => {
    const { nextTheme } = loadExports();
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    expect(nextTheme('system')).toBe('light');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Landing page (index.js) toggle click integration
// ────────────────────────────────────────────────────────────────────────────

describe('Landing page theme toggle', () => {
  /** @type {import('vm').Context} */
  let sandbox;
  let exports;

  function setup(initialStoredTheme) {
    delete require.cache[require.resolve(INDEX_PATH)];

    // Capture matchMedia listeners to simulate OS theme changes.
    /** @type {Array<Function>} */
    const matchMediaChangeListeners = [];
    let osPrefersDark = false;

    function el() { return { addEventListener() {}, classList: { add() {}, remove() {} } }; }

    sandbox = {
      window: {
        matchMedia: vi.fn((query) => ({
          matches: osPrefersDark,
          addEventListener: (_event, fn) => matchMediaChangeListeners.push(fn),
          removeEventListener: () => {},
        })),
        addEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        location: { href: '' },
        // Allow tests to toggle OS preference
        set _osDark(v) {
          osPrefersDark = v;
          for (const fn of matchMediaChangeListeners) fn({ matches: v });
        },
      },
      document: {
        documentElement: {
          _attr: {},
          setAttribute(name, val) { this._attr[name] = val; },
          getAttribute(name) { return this._attr[name] || null; },
        },
        getElementById: el,
        addEventListener: vi.fn(),
        querySelector: el,
        querySelectorAll: () => [],
        createElement: () => ({ classList: { add() {} } }),
        body: { style: {}, appendChild() {} },
      },
      localStorage: {
        _store: {},
        getItem(key) { return key in this._store ? this._store[key] : null; },
        setItem(key, val) { this._store[key] = val; },
      },
      console,
      module: { exports: {} },
      URLSearchParams,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      navigator: { clipboard: {} },
    };

    if (initialStoredTheme !== undefined) {
      sandbox.localStorage.setItem('theme', initialStoredTheme);
    }

    const vm = require('vm');
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.resolve(__dirname, INDEX_PATH), 'utf8');
    try { vm.runInNewContext(code, sandbox, { filename: 'index.js' }); } catch (_) {}
    return sandbox.module.exports;
  }

  describe('initTheme', () => {
    it('is exported from index.js', () => {
      const exp = setup();
      expect(exp).toHaveProperty('initTheme');
      expect(typeof exp.initTheme).toBe('function');
    });

    it('resolves "system" to OS preference on init', () => {
      const exp = setup('system');
      exp.initTheme();
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('resolves "dark" directly on init', () => {
      const exp = setup('dark');
      exp.initTheme();
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('toggleTheme', () => {
    it('is exported from index.js', () => {
      const exp = setup();
      expect(exp).toHaveProperty('toggleTheme');
      expect(typeof exp.toggleTheme).toBe('function');
    });

    it('cycles light → dark → system → light', () => {
      const exp = setup('light');
      exp.initTheme();

      exp.toggleTheme();
      expect(sandbox.localStorage.getItem('theme')).toBe('dark');
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('dark');

      exp.toggleTheme();
      expect(sandbox.localStorage.getItem('theme')).toBe('system');
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('light'); // OS is light

      exp.toggleTheme();
      expect(sandbox.localStorage.getItem('theme')).toBe('light');
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('when OS is dark, "system" resolves to dark', () => {
      const exp = setup('light');
      sandbox.window._osDark = true;
      exp.initTheme();

      exp.toggleTheme(); // light → dark
      exp.toggleTheme(); // dark → system → resolves to 'dark' because OS is dark
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(sandbox.localStorage.getItem('theme')).toBe('system');
    });
  });

  describe('matchMedia listener', () => {
    it('updates theme when system changes and preference is "system"', () => {
      const exp = setup('system');
      exp.initTheme();

      // OS was light on init
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('light');

      // OS switches to dark
      sandbox.window._osDark = true;
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('dark');

      // OS switches back to light
      sandbox.window._osDark = false;
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('ignores system changes when user picked light or dark', () => {
      const exp = setup('dark');
      exp.initTheme();

      sandbox.window._osDark = false; // OS switches to light
      // User picked 'dark' — should NOT change
      expect(sandbox.document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. PR page (pr.js) toggleTheme method
// ────────────────────────────────────────────────────────────────────────────

const PR_PATH = '../../public/js/pr.js';

function loadPRManager() {
  delete require.cache[require.resolve(PR_PATH)];

  let osPrefersDark = false;
  /** @type {Array<Function>} */
  const matchMediaChangeListeners = [];

  const sandbox = {
    window: {
      matchMedia: vi.fn((query) => ({
        matches: osPrefersDark,
        addEventListener: (_event, fn) => matchMediaChangeListeners.push(fn),
        removeEventListener: () => {},
        get listeners() { return matchMediaChangeListeners; },
      })),
      getRepoStorageKey: () => '',
    },
    document: {
      documentElement: {
        _attr: { 'data-theme': 'light' },
        setAttribute(name, val) { this._attr[name] = val; },
        getAttribute(name) { return this._attr[name] || null; },
      },
      getElementById: vi.fn(() => ({ addEventListener() {} })),
      addEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      createElement: vi.fn(() => ({ classList: { add: vi.fn() }, appendChild: vi.fn(), style: {} })),
      body: { appendChild: vi.fn(), style: {} },
    },
    localStorage: {
      _store: {},
      getItem(key) { return key in this._store ? this._store[key] : null; },
      setItem(key, val) { this._store[key] = val; },
    },
    fetch: vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })),
    navigator: { clipboard: {} },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    console,
    module: { exports: {} },
  };
  // PR.js accesses `window.matchMedia`; since sandbox.window = sandbox,
  // copy matchMedia up to the sandbox level.
  sandbox.matchMedia = sandbox.window.matchMedia;
  sandbox.getRepoStorageKey = sandbox.window.getRepoStorageKey;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;

  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  const code = fs.readFileSync(path.resolve(__dirname, PR_PATH), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'pr.js' });

  return {
    PRManager: sandbox.module.exports.PRManager,
    sandbox,
    setOsDark(v) {
      osPrefersDark = v;
      for (const fn of matchMediaChangeListeners) fn({ matches: v });
    },
  };
}

describe('PR page toggleTheme with system support', () => {
  it('cycles stored preference light → dark → system → light', () => {
    const { PRManager, sandbox } = loadPRManager();
    const mgr = Object.create(PRManager.prototype);
    mgr.currentTheme = 'light';
    mgr.updateThemeIcon = vi.fn();
    mgr.pierreBridge = null;

    // light → dark
    mgr.toggleTheme();
    expect(sandbox.localStorage.getItem('theme')).toBe('dark');

    // dark → system
    mgr.toggleTheme();
    expect(sandbox.localStorage.getItem('theme')).toBe('system');

    // system → light
    mgr.toggleTheme();
    expect(sandbox.localStorage.getItem('theme')).toBe('light');
  });

  it('resolves system to OS preference when toggling to system', () => {
    const { PRManager, sandbox, setOsDark } = loadPRManager();
    const mgr = Object.create(PRManager.prototype);
    mgr.currentTheme = 'dark';
    mgr.updateThemeIcon = vi.fn();
    mgr.pierreBridge = null;

    setOsDark(true); // OS is dark
    sandbox.localStorage.setItem('theme', 'dark'); // start with explicit dark
    mgr.toggleTheme(); // dark → system
    expect(sandbox.localStorage.getItem('theme')).toBe('system');
    // currentTheme should resolve to 'dark' because OS is dark
    expect(mgr.currentTheme).toBe('dark');
  });

  it('saves "system" to localStorage when toggled to system', () => {
    const { PRManager, sandbox } = loadPRManager();
    const mgr = Object.create(PRManager.prototype);
    mgr.currentTheme = 'dark';
    mgr.updateThemeIcon = vi.fn();
    mgr.pierreBridge = null;

    sandbox.localStorage.setItem('theme', 'dark'); // start with explicit dark
    mgr.toggleTheme(); // dark → system
    expect(sandbox.localStorage.getItem('theme')).toBe('system');
  });
});
