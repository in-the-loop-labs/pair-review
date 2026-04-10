// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests the Open/Analyze button behavior on the index page.
 *
 * Covers:
 * - PR Open button navigates without analyze param
 * - PR Analyze button navigates with analyze=true param
 * - Local Open button navigates without analyze param
 * - Local Analyze button navigates with analyze=true param
 * - setFormLoading disables both PR buttons
 * - setFormLoading re-enables both PR buttons after failed parse
 * - Open button label is restored to 'Open' after loading resolves
 *
 * Uses the same DOM mock pattern as index-tab-persistence.test.js:
 * global DOM mocks are set up BEFORE requiring the IIFE so that all
 * getElementById calls during module initialisation succeed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// DOM + browser globals setup
// ---------------------------------------------------------------------------

let documentListeners = {};
let windowListeners = {};

function createMockElement(overrides = {}) {
  const classes = new Set(overrides.classes || []);
  const children = [];
  const listeners = {};
  const attrs = { ...(overrides.attrs || {}) };

  const el = {
    tagName: (overrides.tagName || 'DIV').toUpperCase(),
    id: overrides.id || '',
    dataset: { ...(overrides.dataset || {}) },
    value: overrides.value || '',
    disabled: false,
    style: { overflow: '', display: '' },
    innerHTML: '',
    _textContent: '',
    get textContent() { return this._textContent; },
    set textContent(val) {
      this._textContent = val;
      this.innerHTML = String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    classList: {
      add: vi.fn((...cls) => cls.forEach(c => classes.add(c))),
      remove: vi.fn((...cls) => cls.forEach(c => classes.delete(c))),
      contains: vi.fn((c) => classes.has(c)),
      toggle: vi.fn((c) => { if (classes.has(c)) classes.delete(c); else classes.add(c); }),
    },
    setAttribute: vi.fn((k, v) => { attrs[k] = v; }),
    getAttribute: vi.fn((k) => attrs[k] ?? null),
    addEventListener: vi.fn((evt, fn) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    }),
    removeEventListener: vi.fn(),
    appendChild: vi.fn((child) => children.push(child)),
    insertBefore: vi.fn((newNode, refNode) => children.push(newNode)),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    closest: vi.fn(() => null),
    dispatchEvent: vi.fn(),
    focus: vi.fn(),
    _listeners: listeners,
    _children: children,
  };
  return el;
}

// Track all elements by id so getElementById works
let elementsById = {};

function registerElement(el) {
  if (el.id) elementsById[el.id] = el;
  return el;
}

function setupGlobals() {
  documentListeners = {};
  windowListeners = {};
  elementsById = {};

  // Create all elements that the IIFE accesses via getElementById at load time
  const themeToggle = registerElement(createMockElement({ id: 'theme-toggle' }));
  const helpBtn = registerElement(createMockElement({ id: 'help-btn' }));
  const helpModalClose = registerElement(createMockElement({ id: 'help-modal-close' }));
  const helpModalOverlay = registerElement(createMockElement({ id: 'help-modal-overlay' }));

  // Tab bar with tab buttons
  const prTabBtn = createMockElement({ id: 'pr-tab-btn', dataset: { tab: 'pr-tab' }, classes: ['tab-btn', 'active'] });
  const localTabBtn = createMockElement({ id: 'local-tab-btn', dataset: { tab: 'local-tab' }, classes: ['tab-btn'] });
  const reviewRequestsTabBtn = createMockElement({ id: 'rr-tab-btn', dataset: { tab: 'review-requests-tab' }, classes: ['tab-btn'] });
  const myPrsTabBtn = createMockElement({ id: 'mp-tab-btn', dataset: { tab: 'my-prs-tab' }, classes: ['tab-btn'] });

  const allTabBtns = [prTabBtn, localTabBtn, reviewRequestsTabBtn, myPrsTabBtn];

  const tabBar = registerElement(createMockElement({ id: 'unified-tab-bar' }));
  tabBar.querySelectorAll = vi.fn((selector) => {
    if (selector === '.tab-btn') return allTabBtns;
    return [];
  });
  tabBar.querySelector = vi.fn((selector) => {
    const match = selector.match(/\[data-tab="([^"]+)"\]/);
    if (match) {
      return allTabBtns.find(b => b.dataset.tab === match[1]) || null;
    }
    return null;
  });
  // switchTab calls tabBar.closest('.recent-reviews-section')
  const recentReviewsSection = createMockElement({ id: 'recent-reviews-section', classes: ['recent-reviews-section'] });
  recentReviewsSection.querySelectorAll = vi.fn(() => []);
  recentReviewsSection.querySelector = vi.fn(() => null);
  tabBar.closest = vi.fn((sel) => {
    if (sel === '.recent-reviews-section') return recentReviewsSection;
    return null;
  });

  // PR form elements
  const prUrlInput = registerElement(createMockElement({ id: 'pr-url-input' }));
  const startReviewForm = registerElement(createMockElement({ id: 'start-review-form' }));
  const startReviewBtn = registerElement(createMockElement({ id: 'start-review-btn' }));

  // Loading/error elements accessed by setFormLoading
  registerElement(createMockElement({ id: 'start-review-loading-pr' }));
  registerElement(createMockElement({ id: 'start-review-loading-text-pr' }));
  registerElement(createMockElement({ id: 'start-review-error-pr' }));
  registerElement(createMockElement({ id: 'start-local-btn' }));
  registerElement(createMockElement({ id: 'local-path-input' }));
  registerElement(createMockElement({ id: 'start-review-loading-local' }));
  registerElement(createMockElement({ id: 'start-review-loading-text-local' }));
  registerElement(createMockElement({ id: 'start-review-error-local' }));
  registerElement(createMockElement({ id: 'start-local-form' }));
  registerElement(createMockElement({ id: 'browse-local-btn' }));

  // Collection containers accessed by loadCollectionPrs on lazy-load
  registerElement(createMockElement({ id: 'review-requests-container' }));
  registerElement(createMockElement({ id: 'my-prs-container' }));

  // Analyze buttons (new for this test file)
  registerElement(createMockElement({ id: 'analyze-review-btn' }));
  registerElement(createMockElement({ id: 'analyze-local-btn' }));

  // Tab pane elements needed by DOMContentLoaded select-button creation
  registerElement(createMockElement({ id: 'pr-tab' }));
  registerElement(createMockElement({ id: 'local-tab' }));

  // Container elements accessed by loadRecentReviews / loadLocalReviews
  registerElement(createMockElement({ id: 'recent-reviews-container' }));
  registerElement(createMockElement({ id: 'local-reviews-container' }));

  // localStorage mock
  const store = {};
  global.localStorage = {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = String(value); }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]); }),
    _store: store,
  };

  global.document = {
    documentElement: {
      setAttribute: vi.fn(),
      getAttribute: vi.fn(() => 'light'),
    },
    body: { style: { overflow: '' } },
    getElementById: vi.fn((id) => elementsById[id] || null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    createElement: vi.fn((tag) => createMockElement({ tagName: tag })),
    addEventListener: vi.fn((evt, fn) => {
      if (!documentListeners[evt]) documentListeners[evt] = [];
      documentListeners[evt].push(fn);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    contains: vi.fn(() => true),
  };

  global.window = {
    matchMedia: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
    })),
    addEventListener: vi.fn((evt, fn) => {
      if (!windowListeners[evt]) windowListeners[evt] = [];
      windowListeners[evt].push(fn);
    }),
    dispatchEvent: vi.fn(),
    location: { href: '', pathname: '/' },
  };

  global.fetch = vi.fn(() => Promise.resolve({ ok: false }));
  global.Event = class Event {
    constructor(type, opts = {}) {
      this.type = type;
      this.cancelable = opts.cancelable || false;
    }
  };
  global.CustomEvent = class CustomEvent extends global.Event {
    constructor(type, opts = {}) {
      super(type, opts);
      this.detail = opts.detail || null;
    }
  };
  global.confirm = vi.fn(() => false);
  global.CSS = { escape: vi.fn((s) => s) };
  global.URLSearchParams = URLSearchParams;
  global.console = { ...console, error: vi.fn(), log: vi.fn(), warn: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Index page Open/Analyze buttons', () => {
  beforeEach(async () => {
    setupGlobals();

    // Clear module cache so the IIFE runs fresh each time
    const modulePath = require.resolve('../../public/js/index.js');
    delete require.cache[modulePath];

    // Load the actual production IIFE — this registers the document click
    // handler and the DOMContentLoaded listener (but does NOT trigger it)
    require('../../public/js/index.js');

    // Trigger DOMContentLoaded so that form submit and analyze-button click
    // handlers are registered on the elements.
    // The DOMContentLoaded handler is async (it awaits loadConfigAndUpdateUI)
    // so we must await it and flush microtasks.
    const domContentLoadedFns = documentListeners['DOMContentLoaded'] || [];
    for (const fn of domContentLoadedFns) {
      await fn();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: mock fetch to return a valid parsed PR response
  function mockFetchValidPR() {
    global.fetch = vi.fn((url) => {
      if (typeof url === 'string' && url.includes('/api/parse-pr-url')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            valid: true,
            owner: 'testowner',
            repo: 'testrepo',
            prNumber: 42,
          }),
        });
      }
      // Default: return ok: false for any other fetch
      return Promise.resolve({ ok: false });
    });
  }

  // Helper: mock fetch to return a failed (invalid) parse response
  function mockFetchInvalidPR() {
    global.fetch = vi.fn((url) => {
      if (typeof url === 'string' && url.includes('/api/parse-pr-url')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ valid: false }),
        });
      }
      return Promise.resolve({ ok: false });
    });
  }

  // ─── Test 1: PR Open button navigates without analyze param ──────────────

  it('PR Open button navigates without analyze param', async () => {
    const form = elementsById['start-review-form'];
    const input = elementsById['pr-url-input'];
    input.value = 'https://github.com/testowner/testrepo/pull/42';

    mockFetchValidPR();

    const submitHandler = form._listeners.submit[0];
    await submitHandler({ preventDefault: vi.fn() });

    expect(global.window.location.href).toBe('/pr/testowner/testrepo/42');
  });

  // ─── Test 2: PR Analyze button navigates with analyze param ──────────────

  it('PR Analyze button navigates with analyze param', async () => {
    const analyzeBtn = elementsById['analyze-review-btn'];
    const input = elementsById['pr-url-input'];
    input.value = 'https://github.com/testowner/testrepo/pull/42';

    mockFetchValidPR();

    // The IIFE wraps handleStartReview in an anonymous function that does NOT
    // return the promise, so `await clickHandler(...)` resolves immediately.
    // Flush microtasks so the inner async handleStartReview completes.
    const clickHandler = analyzeBtn._listeners.click[0];
    clickHandler({ preventDefault: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));

    expect(global.window.location.href).toBe('/pr/testowner/testrepo/42?analyze=true');
  });

  // ─── Test 3: Local Open button navigates without analyze param ───────────

  it('Local Open button navigates without analyze param', async () => {
    const form = elementsById['start-local-form'];
    const input = elementsById['local-path-input'];
    input.value = '/tmp/myproject';

    const submitHandler = form._listeners.submit[0];
    await submitHandler({ preventDefault: vi.fn() });

    expect(global.window.location.href).toBe('/local?path=%2Ftmp%2Fmyproject');
  });

  // ─── Test 4: Local Analyze button navigates with analyze param ───────────

  it('Local Analyze button navigates with analyze param', async () => {
    const analyzeBtn = elementsById['analyze-local-btn'];
    const input = elementsById['local-path-input'];
    input.value = '/tmp/myproject';

    const clickHandler = analyzeBtn._listeners.click[0];
    await clickHandler({ preventDefault: vi.fn() });

    expect(global.window.location.href).toBe('/local?path=%2Ftmp%2Fmyproject&analyze=true');
  });

  // ─── Test 5: setFormLoading disables both PR buttons ─────────────────────

  it('setFormLoading disables both PR buttons during fetch', async () => {
    const input = elementsById['pr-url-input'];
    const startBtn = elementsById['start-review-btn'];
    const analyzeBtn = elementsById['analyze-review-btn'];

    input.value = 'https://github.com/testowner/testrepo/pull/42';

    // Use a fetch mock that we can control timing on — resolve later
    let resolveFetch;
    global.fetch = vi.fn((url) => {
      if (typeof url === 'string' && url.includes('/api/parse-pr-url')) {
        return new Promise((resolve) => { resolveFetch = resolve; });
      }
      return Promise.resolve({ ok: false });
    });

    const form = elementsById['start-review-form'];
    const submitHandler = form._listeners.submit[0];
    // Start the handler (don't await yet — fetch is pending)
    const promise = submitHandler({ preventDefault: vi.fn() });

    // At this point setFormLoading('pr', true) has been called,
    // but parsePRUrl is still waiting for the fetch.
    // Use a microtask tick so the code up to `await fetch(...)` runs.
    await new Promise((r) => setTimeout(r, 0));

    expect(startBtn.disabled).toBe(true);
    expect(analyzeBtn.disabled).toBe(true);

    // Resolve fetch so the handler completes (avoid dangling promise)
    resolveFetch({
      ok: true,
      json: () => Promise.resolve({ valid: true, owner: 'testowner', repo: 'testrepo', prNumber: 42 }),
    });
    await promise;
  });

  // ─── Test 6: setFormLoading re-enables both PR buttons after failed parse ─

  it('setFormLoading re-enables both PR buttons after failed parse', async () => {
    const input = elementsById['pr-url-input'];
    const startBtn = elementsById['start-review-btn'];
    const analyzeBtn = elementsById['analyze-review-btn'];

    input.value = 'https://github.com/testowner/testrepo/pull/42';

    mockFetchInvalidPR();

    const form = elementsById['start-review-form'];
    const submitHandler = form._listeners.submit[0];
    await submitHandler({ preventDefault: vi.fn() });

    // After failed parse, setFormLoading('pr', false) should have been called
    expect(startBtn.disabled).toBe(false);
    expect(analyzeBtn.disabled).toBe(false);
  });

  // ─── Test 7: Open button label is restored to 'Open' ────────────────────

  it('Open button label is restored to Open after loading resolves', async () => {
    const input = elementsById['pr-url-input'];
    const startBtn = elementsById['start-review-btn'];

    input.value = 'https://github.com/testowner/testrepo/pull/42';

    mockFetchInvalidPR();

    const form = elementsById['start-review-form'];
    const submitHandler = form._listeners.submit[0];
    await submitHandler({ preventDefault: vi.fn() });

    expect(startBtn.textContent).toBe('Open');
  });
});
