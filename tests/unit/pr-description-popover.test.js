// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the PR description popover (the (i) button next to the PR title).
 *
 * Regression coverage for the bug where `overflow: hidden` on `.header-center`
 * clipped the popover when it was appended inside `.pr-title-wrapper`.
 * The fix appends the popover to `document.body` with fixed positioning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ──────────────────────────────────────────────────────
// Minimal DOM mock
// ──────────────────────────────────────────────────────

function createMockElement(tag) {
  const children = [];
  const classList = new Set();
  const eventListeners = {};
  const attributes = {};

  const element = {
    tagName: tag?.toUpperCase(),
    className: '',
    innerHTML: '',
    textContent: '',
    title: '',
    dataset: {},
    style: {},
    _children: children,
    _eventListeners: eventListeners,
    appendChild: vi.fn((child) => {
      children.push(child);
      child.parentNode = element;
      return child;
    }),
    append: vi.fn((...items) => {
      items.forEach(child => {
        children.push(child);
        if (typeof child === 'object' && child !== null) child.parentNode = element;
      });
    }),
    remove: vi.fn(function () {
      if (this.parentNode) {
        const idx = this.parentNode._children.indexOf(this);
        if (idx !== -1) this.parentNode._children.splice(idx, 1);
      }
    }),
    querySelector: vi.fn().mockReturnValue(null),
    querySelectorAll: vi.fn().mockReturnValue([]),
    addEventListener: vi.fn((event, handler) => {
      if (!eventListeners[event]) eventListeners[event] = [];
      eventListeners[event].push(handler);
    }),
    setAttribute: vi.fn((name, value) => { attributes[name] = value; }),
    getAttribute: vi.fn((name) => attributes[name] ?? null),
    closest: vi.fn().mockReturnValue(null),
    classList: {
      add: vi.fn((...cls) => cls.forEach(c => classList.add(c))),
      remove: vi.fn((...cls) => cls.forEach(c => classList.delete(c))),
      contains: vi.fn((cls) => classList.has(cls)),
      _set: classList
    },
    parentNode: null,
    parentElement: null,
    getBoundingClientRect: vi.fn(() => ({
      top: 40, bottom: 56, left: 200, right: 228, width: 28, height: 16
    }))
  };

  return element;
}

// ──────────────────────────────────────────────────────
// Globals & production code import
// ──────────────────────────────────────────────────────

const documentListeners = {};
const bodyChildren = [];

// Mock toggle button and wrapper
const mockToggle = createMockElement('button');
mockToggle.className = 'btn btn-icon pr-description-toggle';

global.document = {
  readyState: 'complete',
  createElement: vi.fn((tag) => createMockElement(tag)),
  getElementById: vi.fn((id) => {
    if (id === 'pr-description-toggle') return mockToggle;
    return null;
  }),
  querySelector: vi.fn((sel) => {
    if (sel === '.pr-description-popover') {
      return bodyChildren.find(c => c.className === 'pr-description-popover') || null;
    }
    return null;
  }),
  querySelectorAll: vi.fn().mockReturnValue([]),
  addEventListener: vi.fn((event, handler) => {
    if (!documentListeners[event]) documentListeners[event] = [];
    documentListeners[event].push(handler);
  }),
  body: {
    appendChild: vi.fn((child) => {
      bodyChildren.push(child);
      child.parentNode = global.document.body;
      return child;
    }),
    _children: bodyChildren
  }
};

global.window = global.window || {};
global.window.renderMarkdown = undefined;
global.window.EventSource = vi.fn();
global.window.WebSocket = vi.fn(() => ({
  addEventListener: vi.fn(),
  close: vi.fn()
}));

const { PRManager } = require('../../public/js/pr.js');

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('PR description popover', () => {
  let prManager;

  beforeEach(() => {
    vi.clearAllMocks();
    bodyChildren.length = 0;

    // Clear accumulated event listeners and classList state from prior tests
    mockToggle._eventListeners = {};
    mockToggle.classList._set.clear();
    for (const key of Object.keys(documentListeners)) {
      delete documentListeners[key];
    }

    // Re-wire mocks that clearAllMocks stripped
    global.document.body.appendChild = vi.fn((child) => {
      bodyChildren.push(child);
      child.parentNode = global.document.body;
      return child;
    });
    global.document.getElementById = vi.fn((id) => {
      if (id === 'pr-description-toggle') return mockToggle;
      return null;
    });
    global.document.querySelector = vi.fn((sel) => {
      if (sel === '.pr-description-popover') {
        return bodyChildren.find(c => c.className === 'pr-description-popover') || null;
      }
      return null;
    });
    global.document.createElement = vi.fn((tag) => createMockElement(tag));
    global.document.addEventListener = vi.fn((event, handler) => {
      if (!documentListeners[event]) documentListeners[event] = [];
      documentListeners[event].push(handler);
    });
    mockToggle.addEventListener = vi.fn((event, handler) => {
      if (!mockToggle._eventListeners[event]) mockToggle._eventListeners[event] = [];
      mockToggle._eventListeners[event].push(handler);
    });

    // Create PRManager without running full constructor
    prManager = Object.create(PRManager.prototype);
    prManager._prBody = '## Hello\nThis is a test PR description.';
    prManager.escapeHtml = (s) => s;

    // Run the method under test
    prManager.setupPRDescriptionPopover();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Simulate a click on the toggle button */
  function clickToggle() {
    const clickHandlers = mockToggle._eventListeners['click'] || [];
    const mockEvent = { stopPropagation: vi.fn() };
    clickHandlers.forEach(handler => handler(mockEvent));
  }

  /** Simulate a click on the document (click-outside) */
  function clickDocument() {
    const handlers = documentListeners['click'] || [];
    handlers.forEach(handler => handler());
  }

  it('should append popover to document.body, not to .pr-title-wrapper (regression)', () => {
    clickToggle();

    // The popover must be appended to document.body (not a wrapper element)
    // to avoid clipping by overflow:hidden on ancestor containers.
    expect(global.document.body.appendChild).toHaveBeenCalledTimes(1);
    const popover = global.document.body.appendChild.mock.calls[0][0];
    expect(popover.className).toBe('pr-description-popover');
  });

  it('should use fixed positioning based on toggle bounding rect', () => {
    clickToggle();

    const popover = global.document.body.appendChild.mock.calls[0][0];
    expect(popover.style.position).toBe('fixed');
    // bottom (56) + 8px gap
    expect(popover.style.top).toBe('64px');
    // left (200) + width/2 (14) = 214
    expect(popover.style.left).toBe('214px');
    expect(popover.style.transform).toBe('translateX(-50%)');
  });

  it('should toggle popover off when clicking toggle a second time', () => {
    clickToggle();
    const popover = bodyChildren[0];
    expect(popover).toBeDefined();

    clickToggle();
    expect(popover.remove).toHaveBeenCalled();
  });

  it('should close popover on click-outside', () => {
    clickToggle();
    const popover = bodyChildren[0];
    // Mark toggle as active so the document handler fires
    mockToggle.classList._set.add('active');

    clickDocument();
    expect(popover.remove).toHaveBeenCalled();
  });

  it('should close popover on Escape key', () => {
    clickToggle();
    const popover = bodyChildren[0];
    mockToggle.classList._set.add('active');

    const keyHandlers = documentListeners['keydown'] || [];
    keyHandlers.forEach(handler => handler({ key: 'Escape' }));

    expect(popover.remove).toHaveBeenCalled();
  });

  it('should render markdown content when renderMarkdown is available', () => {
    window.renderMarkdown = vi.fn((md) => `<p>${md}</p>`);
    clickToggle();

    const popover = global.document.body.appendChild.mock.calls[0][0];
    // The content div is the third child (arrow, header, content)
    const contentDiv = popover._children[2];
    expect(window.renderMarkdown).toHaveBeenCalledWith('## Hello\nThis is a test PR description.');
    expect(contentDiv.innerHTML).toContain('## Hello');
  });

  it('should fall back to escapeHtml when renderMarkdown is unavailable', () => {
    window.renderMarkdown = undefined;
    prManager.escapeHtml = vi.fn((s) => s.replace(/</g, '&lt;'));
    clickToggle();

    expect(prManager.escapeHtml).toHaveBeenCalled();
  });
});
