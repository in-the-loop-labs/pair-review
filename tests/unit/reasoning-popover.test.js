// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for the reasoning popover feature in SuggestionManager and FileCommentManager.
 *
 * Tests cover:
 * - Reasoning button rendering in expanded and collapsed suggestion states
 * - Absence of reasoning button when reasoning data is null/undefined/empty
 * - Popover creation (_openReasoningPopover)
 * - Popover cleanup (_closeReasoningPopover)
 * - Popover toggle behavior (open/close on same button)
 *
 * IMPORTANT: These tests import the actual production classes to verify real behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ──────────────────────────────────────────────────────
// Minimal DOM mock for Node environment
// ──────────────────────────────────────────────────────

/**
 * Create a mock DOM element that supports the subset of DOM APIs used by
 * SuggestionManager.createSuggestionRow and _openReasoningPopover.
 */
function createMockElement(tag) {
  const children = [];
  const classList = new Set();

  /**
   * Minimal stub element for querySelector results.
   * Supports addEventListener (no-op) so wiring up event handlers doesn't throw.
   */
  function createStubElement() {
    return {
      addEventListener: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn() },
      querySelector: vi.fn().mockReturnValue(null),
      querySelectorAll: vi.fn().mockReturnValue([]),
      dataset: {},
      textContent: '',
      style: {},
      remove: vi.fn()
    };
  }

  const element = {
    tagName: tag?.toUpperCase(),
    className: '',
    innerHTML: '',
    textContent: '',
    colSpan: 0,
    dataset: {},
    _children: children,
    appendChild: vi.fn((child) => {
      children.push(child);
      return child;
    }),
    remove: vi.fn(),
    // Return a stub element for any querySelector call so addEventListener never throws
    querySelector: vi.fn().mockImplementation(() => createStubElement()),
    querySelectorAll: vi.fn().mockReturnValue([]),
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    getAttribute: vi.fn(),
    closest: vi.fn().mockReturnValue(null),
    classList: {
      add: vi.fn((...cls) => cls.forEach(c => classList.add(c))),
      remove: vi.fn((...cls) => cls.forEach(c => classList.delete(c))),
      contains: vi.fn((cls) => classList.has(cls))
    },
    parentNode: null,
    parentElement: null,
    after: vi.fn(),
    insertBefore: vi.fn((newChild, refChild) => {
      children.push(newChild);
      return newChild;
    })
  };

  return element;
}

// Set up global.document before importing production code
global.document = {
  readyState: 'complete',
  createElement: vi.fn((tag) => createMockElement(tag)),
  querySelector: vi.fn().mockReturnValue(null),
  querySelectorAll: vi.fn().mockReturnValue([]),
  addEventListener: vi.fn(),
  body: { appendChild: vi.fn() }
};

// Set up global.window
global.window = global.window || {};

// Import the actual production classes
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');

/**
 * Create a SuggestionManager instance WITHOUT running the constructor
 * (avoids the document.addEventListener('click', ...) setup).
 */
function createTestSuggestionManager(prManagerConfig = {}) {
  const sm = Object.create(SuggestionManager.prototype);
  sm.prManager = {
    escapeHtml: (s) => s,
    userComments: [],
    ...prManagerConfig
  };
  sm._isDisplayingSuggestions = false;
  return sm;
}

// ──────────────────────────────────────────────────────
// SuggestionManager: Reasoning button rendering
// ──────────────────────────────────────────────────────

describe('SuggestionManager reasoning popover', () => {
  let sm;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = createTestSuggestionManager();
    window.renderMarkdown = undefined;

    // Reset document.createElement to return fresh mock elements
    global.document.createElement = vi.fn((tag) => createMockElement(tag));
    global.document.querySelector = vi.fn().mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: call createSuggestionRow and return the concatenated innerHTML
   * from the tr > td > div chain. The mock elements store innerHTML as a string.
   */
  function getRenderedHtml(suggestions) {
    const row = sm.createSuggestionRow(suggestions);
    // row is a mock <tr>. Its first child (via appendChild) is the <td>.
    // The <td> has children (suggestion divs) appended via appendChild.
    // Each suggestion div has innerHTML set by the production code.
    const td = row._children[0];
    if (!td) return '';

    // Collect innerHTML from all suggestion divs
    return td._children.map(child => child.innerHTML).join('\n');
  }

  // ── Expanded state ──

  describe('Reasoning button in expanded (active) state', () => {
    it('should render .btn-reasoning-toggle when suggestion has reasoning array', () => {
      const html = getRenderedHtml([{
        id: 1,
        type: 'bug',
        title: 'Null pointer',
        body: 'Check for null',
        reasoning: ['step one', 'step two'],
        status: 'active'
      }]);

      expect(html).toContain('btn-reasoning-toggle');
      expect(html).toContain('data-reasoning');

      const encoded = encodeURIComponent(JSON.stringify(['step one', 'step two']));
      expect(html).toContain(encoded);
    });

    it('should NOT render .btn-reasoning-toggle when reasoning is null', () => {
      const html = getRenderedHtml([{
        id: 2,
        type: 'improvement',
        title: 'Better naming',
        body: 'Rename variable',
        reasoning: null,
        status: 'active'
      }]);

      expect(html).not.toContain('btn-reasoning-toggle');
    });

    it('should NOT render .btn-reasoning-toggle when reasoning is undefined', () => {
      const html = getRenderedHtml([{
        id: 3,
        type: 'suggestion',
        title: 'Use const',
        body: 'Prefer const',
        // reasoning intentionally omitted
        status: 'active'
      }]);

      expect(html).not.toContain('btn-reasoning-toggle');
    });

    it('should NOT render .btn-reasoning-toggle when reasoning is empty array', () => {
      const html = getRenderedHtml([{
        id: 4,
        type: 'design',
        title: 'Decouple modules',
        body: 'Extract interface',
        reasoning: [],
        status: 'active'
      }]);

      expect(html).not.toContain('btn-reasoning-toggle');
    });

    it('should include suggestion id in reasoning button data attribute', () => {
      const html = getRenderedHtml([{
        id: 42,
        type: 'bug',
        title: 'Test',
        body: 'Body',
        reasoning: ['one'],
        status: 'active'
      }]);

      expect(html).toContain('data-suggestion-id="42"');
    });
  });

  // ── Collapsed state ──

  describe('Reasoning button in collapsed (adopted/dismissed) state', () => {
    it('should render .collapsed-reasoning button when adopted suggestion has reasoning', () => {
      const html = getRenderedHtml([{
        id: 5,
        type: 'bug',
        title: 'Off-by-one',
        body: 'Fix loop bound',
        reasoning: ['analyzed loop', 'found off-by-one'],
        status: 'adopted'
      }]);

      // Collapsed content section should have the collapsed-reasoning class
      expect(html).toContain('collapsed-reasoning');
      expect(html).toContain('btn-reasoning-toggle');
    });

    it('should render .collapsed-reasoning button when dismissed suggestion has reasoning', () => {
      const html = getRenderedHtml([{
        id: 50,
        type: 'performance',
        title: 'Cache result',
        body: 'Memoize computation',
        reasoning: ['profiled hot path'],
        status: 'dismissed'
      }]);

      expect(html).toContain('collapsed-reasoning');
    });

    it('should NOT render collapsed reasoning button when reasoning is null', () => {
      const html = getRenderedHtml([{
        id: 6,
        type: 'improvement',
        title: 'Simplify',
        body: 'Reduce complexity',
        reasoning: null,
        status: 'dismissed'
      }]);

      expect(html).not.toContain('btn-reasoning-toggle');
      expect(html).not.toContain('collapsed-reasoning');
    });

    it('should NOT render collapsed reasoning button when reasoning is empty array', () => {
      const html = getRenderedHtml([{
        id: 60,
        type: 'suggestion',
        title: 'Cleanup',
        body: 'Remove unused imports',
        reasoning: [],
        status: 'adopted'
      }]);

      expect(html).not.toContain('btn-reasoning-toggle');
      expect(html).not.toContain('collapsed-reasoning');
    });

    it('should encode reasoning data identically in both expanded and collapsed sections', () => {
      const reasoning = ['check input validation', 'verify error handling'];
      const html = getRenderedHtml([{
        id: 7,
        type: 'security',
        title: 'Input validation',
        body: 'Validate user input',
        reasoning,
        status: 'adopted'
      }]);

      const encoded = encodeURIComponent(JSON.stringify(reasoning));
      // data-reasoning should appear twice: once in the expanded header,
      // once in the collapsed content
      const occurrences = html.split(encoded).length - 1;
      expect(occurrences).toBe(2);
    });
  });

  // ── Popover creation (_openReasoningPopover) ──

  describe('_openReasoningPopover', () => {
    let mockToggleBtn;
    let mockHeaderRight;

    beforeEach(() => {
      mockHeaderRight = {
        appendChild: vi.fn()
      };

      mockToggleBtn = {
        dataset: {
          reasoning: encodeURIComponent(JSON.stringify(['reason A', 'reason B']))
        },
        classList: {
          add: vi.fn(),
          remove: vi.fn()
        },
        closest: vi.fn((selector) => {
          if (selector === '.ai-suggestion-header-right') return mockHeaderRight;
          return null;
        }),
        parentElement: {
          appendChild: vi.fn()
        }
      };

      // _openReasoningPopover does not call _closeReasoningPopover,
      // but document.querySelector is used by _closeReasoningPopover.
      // The production code in _openReasoningPopover calls document.createElement('div').
      global.document.querySelector = vi.fn(() => null);
    });

    it('should create a .reasoning-popover element with rendered reasoning', () => {
      sm._openReasoningPopover(mockToggleBtn);

      expect(mockHeaderRight.appendChild).toHaveBeenCalledTimes(1);

      const popover = mockHeaderRight.appendChild.mock.calls[0][0];
      expect(popover.className).toBe('reasoning-popover');
      expect(popover.innerHTML).toContain('Reasoning');
      // Without renderMarkdown, should fall back to <ul>/<li> rendering
      expect(popover.innerHTML).toContain('reason A');
      expect(popover.innerHTML).toContain('reason B');
    });

    it('should render reasoning as bullet list items in fallback mode', () => {
      sm._openReasoningPopover(mockToggleBtn);

      const popover = mockHeaderRight.appendChild.mock.calls[0][0];
      expect(popover.innerHTML).toContain('<ul>');
      expect(popover.innerHTML).toContain('<li>reason A</li>');
      expect(popover.innerHTML).toContain('<li>reason B</li>');
    });

    it('should mark the toggle button as active', () => {
      sm._openReasoningPopover(mockToggleBtn);

      expect(mockToggleBtn.classList.add).toHaveBeenCalledWith('active');
    });

    it('should store the trigger button reference on the popover', () => {
      sm._openReasoningPopover(mockToggleBtn);

      const popover = mockHeaderRight.appendChild.mock.calls[0][0];
      expect(popover._triggerBtn).toBe(mockToggleBtn);
    });

    it('should include a close button in the popover', () => {
      sm._openReasoningPopover(mockToggleBtn);

      const popover = mockHeaderRight.appendChild.mock.calls[0][0];
      expect(popover.innerHTML).toContain('reasoning-popover-close');
    });

    it('should include popover arrow element', () => {
      sm._openReasoningPopover(mockToggleBtn);

      const popover = mockHeaderRight.appendChild.mock.calls[0][0];
      expect(popover.innerHTML).toContain('reasoning-popover-arrow');
    });

    it('should include reasoning-popover-header and reasoning-popover-content', () => {
      sm._openReasoningPopover(mockToggleBtn);

      const popover = mockHeaderRight.appendChild.mock.calls[0][0];
      expect(popover.innerHTML).toContain('reasoning-popover-header');
      expect(popover.innerHTML).toContain('reasoning-popover-content');
      expect(popover.innerHTML).toContain('reasoning-popover-title');
    });

    it('should use renderMarkdown when available', () => {
      window.renderMarkdown = vi.fn((md) => `<div class="rendered">${md}</div>`);

      sm._openReasoningPopover(mockToggleBtn);

      expect(window.renderMarkdown).toHaveBeenCalledWith('- reason A\n- reason B');

      const popover = mockHeaderRight.appendChild.mock.calls[0][0];
      expect(popover.innerHTML).toContain('class="rendered"');
    });

    it('should not create popover when reasoning data is empty string', () => {
      mockToggleBtn.dataset.reasoning = '';

      sm._openReasoningPopover(mockToggleBtn);

      expect(mockHeaderRight.appendChild).not.toHaveBeenCalled();
    });

    it('should not create popover when reasoning data is invalid JSON', () => {
      mockToggleBtn.dataset.reasoning = 'not%20valid%20json';

      sm._openReasoningPopover(mockToggleBtn);

      expect(mockHeaderRight.appendChild).not.toHaveBeenCalled();
    });

    it('should not create popover when decoded reasoning is not an array', () => {
      mockToggleBtn.dataset.reasoning = encodeURIComponent(JSON.stringify('just a string'));

      sm._openReasoningPopover(mockToggleBtn);

      expect(mockHeaderRight.appendChild).not.toHaveBeenCalled();
    });

    it('should not create popover when decoded reasoning is an object', () => {
      mockToggleBtn.dataset.reasoning = encodeURIComponent(JSON.stringify({ key: 'value' }));

      sm._openReasoningPopover(mockToggleBtn);

      expect(mockHeaderRight.appendChild).not.toHaveBeenCalled();
    });

    it('should fall back to parentElement when no .ai-suggestion-header-right found', () => {
      mockToggleBtn.closest = vi.fn(() => null);

      sm._openReasoningPopover(mockToggleBtn);

      expect(mockToggleBtn.parentElement.appendChild).toHaveBeenCalledTimes(1);
      const popover = mockToggleBtn.parentElement.appendChild.mock.calls[0][0];
      expect(popover.className).toBe('reasoning-popover');
    });
  });

  // ── Popover cleanup (_closeReasoningPopover) ──

  describe('_closeReasoningPopover', () => {
    it('should remove existing popover and deactivate toggle button', () => {
      const mockTriggerBtn = {
        classList: { remove: vi.fn() }
      };

      const mockPopover = {
        _triggerBtn: mockTriggerBtn,
        remove: vi.fn()
      };

      global.document.querySelector = vi.fn((selector) => {
        if (selector === '.reasoning-popover') return mockPopover;
        return null;
      });

      sm._closeReasoningPopover();

      expect(mockPopover.remove).toHaveBeenCalled();
      expect(mockTriggerBtn.classList.remove).toHaveBeenCalledWith('active');
    });

    it('should do nothing when no popover exists', () => {
      global.document.querySelector = vi.fn(() => null);

      expect(() => sm._closeReasoningPopover()).not.toThrow();
    });

    it('should handle popover without trigger button gracefully', () => {
      const mockPopover = {
        _triggerBtn: undefined,
        remove: vi.fn()
      };

      global.document.querySelector = vi.fn((selector) => {
        if (selector === '.reasoning-popover') return mockPopover;
        return null;
      });

      expect(() => sm._closeReasoningPopover()).not.toThrow();
      expect(mockPopover.remove).toHaveBeenCalled();
    });

    it('should handle popover with null trigger button gracefully', () => {
      const mockPopover = {
        _triggerBtn: null,
        remove: vi.fn()
      };

      global.document.querySelector = vi.fn((selector) => {
        if (selector === '.reasoning-popover') return mockPopover;
        return null;
      });

      expect(() => sm._closeReasoningPopover()).not.toThrow();
      expect(mockPopover.remove).toHaveBeenCalled();
    });
  });

  // ── Popover toggle behavior ──

  describe('Popover toggle behavior', () => {
    it('should close existing popover when same button toggles off', () => {
      // Simulate the toggle scenario: button is clicked, popover is already open for it
      const toggleBtn = {
        classList: { add: vi.fn(), remove: vi.fn() }
      };

      const existingPopover = {
        _triggerBtn: toggleBtn,
        remove: vi.fn()
      };

      global.document.querySelector = vi.fn((selector) => {
        if (selector === '.reasoning-popover') return existingPopover;
        return null;
      });

      // Check that it IS the same button's popover
      const isOwnPopover = existingPopover._triggerBtn === toggleBtn;
      expect(isOwnPopover).toBe(true);

      // Close it
      sm._closeReasoningPopover();

      expect(existingPopover.remove).toHaveBeenCalled();
      expect(toggleBtn.classList.remove).toHaveBeenCalledWith('active');
    });

    it('should close old popover and open new when different button is clicked', () => {
      const oldToggleBtn = {
        classList: { add: vi.fn(), remove: vi.fn() }
      };

      const newToggleBtn = {
        dataset: {
          reasoning: encodeURIComponent(JSON.stringify(['new step']))
        },
        classList: { add: vi.fn(), remove: vi.fn() },
        closest: vi.fn((sel) => {
          if (sel === '.ai-suggestion-header-right') return { appendChild: vi.fn() };
          return null;
        }),
        parentElement: { appendChild: vi.fn() }
      };

      const existingPopover = {
        _triggerBtn: oldToggleBtn,
        remove: vi.fn()
      };

      // First check that it's a different button
      const isOwnPopover = existingPopover._triggerBtn === newToggleBtn;
      expect(isOwnPopover).toBe(false);

      // Close existing
      global.document.querySelector = vi.fn((selector) => {
        if (selector === '.reasoning-popover') return existingPopover;
        return null;
      });

      sm._closeReasoningPopover();
      expect(existingPopover.remove).toHaveBeenCalled();

      // Open new
      global.document.querySelector = vi.fn(() => null);
      sm._openReasoningPopover(newToggleBtn);

      expect(newToggleBtn.classList.add).toHaveBeenCalledWith('active');
    });
  });
});

// ──────────────────────────────────────────────────────
// FileCommentManager: Reasoning button rendering
// ──────────────────────────────────────────────────────

describe('FileCommentManager reasoning popover rendering', () => {
  /**
   * FileCommentManager.displayAISuggestion() uses document.createElement and innerHTML
   * assignment, then calls querySelector on the result to wire up event listeners.
   * Since we don't have a full DOM, we test the template output by examining the
   * innerHTML that would be set on the card element.
   *
   * Strategy: We build the HTML template string the same way displayAISuggestion does
   * (by inspecting the source), but we test via the actual production code by spying
   * on createElement and capturing the innerHTML set on the card element.
   */

  let fcm;
  let capturedCards;

  beforeEach(() => {
    vi.clearAllMocks();

    fcm = Object.create(FileCommentManager.prototype);
    fcm.prManager = {
      currentPR: { id: 'test-review', reviewType: 'local', head_sha: 'abc' },
      userComments: []
    };
    fcm.fileComments = new Map();

    window.renderMarkdown = undefined;

    capturedCards = [];

    // Override document.createElement to capture card elements
    global.document.createElement = vi.fn((tag) => {
      const el = createMockElement(tag);

      // When displayAISuggestion sets innerHTML and calls querySelector,
      // we need querySelector to work on the card. Since we can't parse HTML
      // in a mock, we intercept and track the card.
      if (tag === 'div') {
        capturedCards.push(el);
      }

      return el;
    });

    global.document.querySelector = vi.fn(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Call displayAISuggestion and return the innerHTML of the card element.
   * displayAISuggestion calls container.querySelector('.file-comments-container')
   * on the zone, so we need to mock that.
   */
  function renderSuggestionAndGetHtml(suggestion) {
    // Create mock container and zone
    const appendedChildren = [];
    const mockContainer = {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      appendChild: vi.fn((child) => appendedChildren.push(child)),
      insertBefore: vi.fn((child) => appendedChildren.push(child))
    };

    const mockZone = {
      querySelector: vi.fn((selector) => {
        if (selector === '.file-comments-container') return mockContainer;
        return null;
      }),
      dataset: { fileName: suggestion.file || 'test.js' }
    };

    fcm.displayAISuggestion(mockZone, suggestion);

    // The card is the element that was appended/insertedBefore to the container.
    // It should be the div with className containing 'ai-suggestion'.
    const card = appendedChildren.find(c =>
      c.className && c.className.includes('ai-suggestion')
    );

    return card ? card.innerHTML : '';
  }

  it('should render reasoning button in expanded file-level suggestion header', () => {
    const html = renderSuggestionAndGetHtml({
      id: 10,
      type: 'improvement',
      title: 'Refactor module',
      body: 'Extract helper function',
      file: 'test-file.js',
      reasoning: ['analyzed dependencies', 'found duplication'],
      status: 'active',
      is_file_level: 1
    });

    // Expanded header should have reasoning toggle
    expect(html).toContain('btn-reasoning-toggle');
    expect(html).toContain('data-reasoning');

    const encoded = encodeURIComponent(JSON.stringify(['analyzed dependencies', 'found duplication']));
    expect(html).toContain(encoded);
  });

  it('should NOT render reasoning button when file-level suggestion has null reasoning', () => {
    const html = renderSuggestionAndGetHtml({
      id: 11,
      type: 'bug',
      title: 'Fix edge case',
      body: 'Handle empty input',
      file: 'test-file.js',
      reasoning: null,
      status: 'active',
      is_file_level: 1
    });

    expect(html).not.toContain('btn-reasoning-toggle');
  });

  it('should NOT render reasoning button when file-level suggestion has empty reasoning', () => {
    const html = renderSuggestionAndGetHtml({
      id: 110,
      type: 'design',
      title: 'Separate concerns',
      body: 'Split module',
      file: 'test-file.js',
      reasoning: [],
      status: 'active',
      is_file_level: 1
    });

    expect(html).not.toContain('btn-reasoning-toggle');
  });

  it('should render collapsed-reasoning button in dismissed file-level suggestion', () => {
    const html = renderSuggestionAndGetHtml({
      id: 12,
      type: 'suggestion',
      title: 'Add logging',
      body: 'Add debug logging',
      file: 'test-file.js',
      reasoning: ['reviewed error handling'],
      status: 'dismissed',
      is_file_level: 1
    });

    expect(html).toContain('collapsed-reasoning');
    expect(html).toContain('btn-reasoning-toggle');
  });

  it('should NOT render collapsed-reasoning button when dismissed suggestion has no reasoning', () => {
    const html = renderSuggestionAndGetHtml({
      id: 13,
      type: 'performance',
      title: 'Optimize query',
      body: 'Use index',
      file: 'test-file.js',
      reasoning: null,
      status: 'dismissed',
      is_file_level: 1
    });

    expect(html).not.toContain('collapsed-reasoning');
    expect(html).not.toContain('btn-reasoning-toggle');
  });

  it('should encode reasoning data in both expanded and collapsed sections for adopted suggestion', () => {
    const reasoning = ['step alpha', 'step beta'];
    const html = renderSuggestionAndGetHtml({
      id: 14,
      type: 'security',
      title: 'Sanitize input',
      body: 'Use parameterized query',
      file: 'test-file.js',
      reasoning,
      status: 'adopted',
      is_file_level: 1
    });

    const encoded = encodeURIComponent(JSON.stringify(reasoning));
    // Should appear twice: once in expanded header, once in collapsed content
    const occurrences = html.split(encoded).length - 1;
    expect(occurrences).toBe(2);
  });
});
