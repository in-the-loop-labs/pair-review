// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests that clicking a collection PR row (from "My Review Requests" or
 * "My PRs") does NOT persist the tab switch to localStorage, while normal
 * tab clicks DO persist the choice.
 *
 * Loads the actual public/js/index.js IIFE by setting up sufficient DOM
 * mocks so that the module-level code runs and the delegated click handler
 * is registered on `document`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// DOM + browser globals setup
// ---------------------------------------------------------------------------

let clickHandler = null; // captured from document.addEventListener('click', ...)
let documentListeners = {};
let windowListeners = {};

const TAB_STORAGE_KEY = 'pair-review-active-tab';

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
    style: { overflow: '' },
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
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    closest: vi.fn(() => null),
    dispatchEvent: vi.fn(),
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
  clickHandler = null;
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
      if (evt === 'click') clickHandler = fn;
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Index page tab persistence', () => {
  beforeEach(() => {
    setupGlobals();

    // Clear module cache so the IIFE runs fresh each time
    const modulePath = require.resolve('../../public/js/index.js');
    delete require.cache[modulePath];

    // Load the actual production IIFE — this registers the click handler
    require('../../public/js/index.js');

    // Verify we captured the click handler
    expect(clickHandler).toBeTruthy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: simulate a click event originating from an element.
   * Sets up `event.target.closest()` to return the right elements
   * based on selectors the delegation handler checks.
   */
  function simulateCollectionRowClick(prUrl) {
    const row = createMockElement({
      dataset: { prUrl },
      classes: ['collection-pr-row'],
    });

    const eventTarget = createMockElement();
    // event.target.closest('.collection-pr-row') => row
    // event.target.closest('a') => null (not clicking a link)
    // event.target.closest() for other selectors => null
    eventTarget.closest = vi.fn((selector) => {
      if (selector === '.collection-pr-row') return row;
      return null;
    });

    const event = {
      target: eventTarget,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    clickHandler(event);
    return event;
  }

  function simulateTabClick(tabId) {
    const tabBtn = createMockElement({
      dataset: { tab: tabId },
      classes: ['tab-btn'],
    });

    const eventTarget = createMockElement();
    // event.target.closest('#unified-tab-bar .tab-btn') => tabBtn
    // Other selectors => null
    eventTarget.closest = vi.fn((selector) => {
      if (selector === '#unified-tab-bar .tab-btn') return tabBtn;
      return null;
    });

    const event = {
      target: eventTarget,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    clickHandler(event);
    return event;
  }

  it('should NOT persist tab to localStorage when clicking a collection PR row', () => {
    localStorage.setItem.mockClear();

    simulateCollectionRowClick('https://github.com/owner/repo/pull/42');

    // The click handler should NOT have saved 'pr-tab' (or any tab) to localStorage
    const tabSetCalls = localStorage.setItem.mock.calls.filter(
      ([key]) => key === TAB_STORAGE_KEY
    );
    expect(tabSetCalls).toHaveLength(0);
  });

  it('should persist tab to localStorage when clicking a regular tab button', () => {
    localStorage.setItem.mockClear();

    simulateTabClick('local-tab');

    const tabSetCalls = localStorage.setItem.mock.calls.filter(
      ([key]) => key === TAB_STORAGE_KEY
    );
    expect(tabSetCalls).toHaveLength(1);
    expect(tabSetCalls[0][1]).toBe('local-tab');
  });

  it('should persist the correct tab id for any tab clicked normally', () => {
    localStorage.setItem.mockClear();

    simulateTabClick('review-requests-tab');

    const tabSetCalls = localStorage.setItem.mock.calls.filter(
      ([key]) => key === TAB_STORAGE_KEY
    );
    expect(tabSetCalls).toHaveLength(1);
    expect(tabSetCalls[0][1]).toBe('review-requests-tab');
  });

  it('should still switch to PR tab visually when clicking a collection row', () => {
    // The visual switchTab call should still happen (we just don't persist it)
    // We verify by checking that the form input gets populated
    simulateCollectionRowClick('https://github.com/owner/repo/pull/99');

    const input = elementsById['pr-url-input'];
    expect(input.value).toBe('https://github.com/owner/repo/pull/99');
  });

  it('should submit the start-review form when clicking a collection row', () => {
    simulateCollectionRowClick('https://github.com/owner/repo/pull/99');

    const form = elementsById['start-review-form'];
    expect(form.dispatchEvent).toHaveBeenCalled();
  });
});
