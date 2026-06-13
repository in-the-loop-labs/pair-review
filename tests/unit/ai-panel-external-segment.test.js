// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the External segment in the Review (AI) panel.
 *
 * Covers:
 *  - setExternalThreads() stores state and updates segment counts.
 *  - getFilteredItems() returns external threads when segment is 'external'
 *    and includes them in 'all'.
 *  - _normalizeExternalThread() handles outdated → original_line_* fallback.
 *  - renderExternalThreadItem() produces the expected DOM hooks.
 *  - sortItemsByFileOrder() interleaves external + finding + comment items.
 *  - restoreSegmentSelection() falls back to 'ai' when 'external' is hidden
 *    (Local mode) even if localStorage has the value.
 *
 * Uses Object.create(AIPanel.prototype) to test the actual production
 * methods without triggering the constructor's DOM dependencies. Matches
 * the pattern established in ai-panel-collapse.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Minimal globals required for AIPanel module to load
global.window = {};
// renderExternalThreadItem uses window.escapeHtmlAttribute for every value
// it interpolates into a quoted HTML attribute (title, data-*, class). The
// production helper is published on window by public/js/utils/markdown.js;
// stub the same shape here so AIPanel.renderExternalThreadItem can build
// its HTML without depending on the browser bundle load order.
global.window.escapeHtmlAttribute = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
global.document = {
  getElementById: vi.fn(() => null),
  addEventListener: vi.fn(),
  createElement: vi.fn(() => ({
    className: '', innerHTML: '', title: '',
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    insertBefore: vi.fn(),
    appendChild: vi.fn(),
  })),
  documentElement: { style: { setProperty: vi.fn() }, getAttribute: vi.fn(() => null) },
  querySelector: vi.fn(() => null),
  querySelectorAll: vi.fn(() => []),
  dispatchEvent: vi.fn(),
};
global.localStorage = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};
global.CustomEvent = class CustomEvent {};

const { AIPanel } = require('../../public/js/components/AIPanel.js');

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

let mockLocalStorage;

/**
 * Create a minimal AIPanel instance via Object.create to skip the
 * constructor's DOM initialization. Sets up just enough surface for
 * setExternalThreads / getFilteredItems / renderFindings to run.
 */
function createTestPanel(overrides = {}) {
  const panel = Object.create(AIPanel.prototype);

  panel.isCollapsed = false;
  panel.currentPRKey = 'owner/repo#1';
  panel.findings = [];
  panel.comments = [];
  panel.externalThreads = [];
  panel.selectedSegment = 'ai';
  panel.selectedLevel = 'final';
  panel.analysisState = 'unknown';
  panel.currentIndex = -1;
  panel.selectedItemKey = null;
  panel.fileOrder = new Map();
  // Mirror the real constructor: latest-wins token for scrollTo* guards.
  // Without this, ++undefined -> NaN and NaN !== NaN wrongly bails the scroll.
  panel._navGen = 0;

  // DOM stubs — methods we don't care about in these tests are no-ops.
  panel.panel = {
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
  };
  panel.findingsList = {
    innerHTML: '',
    querySelectorAll: vi.fn(() => []),
    querySelector: vi.fn(() => null),
  };
  panel.segmentBtns = [];

  // Inert helpers we don't want to invoke
  panel.updateFindingsHeader = vi.fn();
  panel.highlightCurrentItem = vi.fn();
  panel.updateNavigationCounter = vi.fn();
  panel.saveCurrentSelection = vi.fn();
  panel.restoreSelection = vi.fn(() => false);
  panel.autoSelectFirst = vi.fn();

  // Override escapeHtml with a deterministic implementation that does not
  // rely on document.createElement. The global document is a mock without
  // a real `<div>` implementation, so the production escapeHtml would
  // return empty strings. The semantic contract we care about is "escape
  // HTML-significant characters" — model it directly.
  panel.escapeHtml = function (text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  Object.assign(panel, overrides);
  return panel;
}

function makeThread(overrides = {}) {
  return {
    id: 100,
    source: 'github',
    external_id: 'gh-100',
    author: 'reviewer-alice',
    file: 'src/utils.js',
    side: 'RIGHT',
    line_start: 5,
    line_end: 5,
    is_outdated: 0,
    original_line_start: 5,
    original_line_end: 5,
    body: 'Looks good but consider edge case X',
    replies: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockLocalStorage = {};
  global.localStorage = {
    getItem: vi.fn((key) => mockLocalStorage[key] ?? null),
    setItem: vi.fn((key, val) => { mockLocalStorage[key] = val; }),
    removeItem: vi.fn((key) => { delete mockLocalStorage[key]; }),
  };
});

// -----------------------------------------------------------------------
// setExternalThreads
// -----------------------------------------------------------------------

describe('AIPanel.setExternalThreads', () => {
  it('stores the array on this.externalThreads', () => {
    const panel = createTestPanel();
    panel.updateSegmentCounts = vi.fn();
    panel.renderFindings = vi.fn();

    const threads = [makeThread(), makeThread({ id: 101 })];
    panel.setExternalThreads(threads);

    expect(panel.externalThreads).toHaveLength(2);
    expect(panel.externalThreads[0].id).toBe(100);
    expect(panel.externalThreads[1].id).toBe(101);
  });

  it('replaces previous state on each call (not append)', () => {
    const panel = createTestPanel({ externalThreads: [makeThread()] });
    panel.updateSegmentCounts = vi.fn();
    panel.renderFindings = vi.fn();

    panel.setExternalThreads([makeThread({ id: 200 })]);
    expect(panel.externalThreads).toHaveLength(1);
    expect(panel.externalThreads[0].id).toBe(200);
  });

  it('treats null / undefined / non-array input as empty', () => {
    const panel = createTestPanel({ externalThreads: [makeThread()] });
    panel.updateSegmentCounts = vi.fn();
    panel.renderFindings = vi.fn();

    panel.setExternalThreads(null);
    expect(panel.externalThreads).toEqual([]);

    panel.setExternalThreads(undefined);
    expect(panel.externalThreads).toEqual([]);

    panel.setExternalThreads('not an array');
    expect(panel.externalThreads).toEqual([]);
  });

  it('updates segment counts and re-renders the list', () => {
    const panel = createTestPanel();
    const updateSpy = vi.fn();
    const renderSpy = vi.fn();
    panel.updateSegmentCounts = updateSpy;
    panel.renderFindings = renderSpy;

    panel.setExternalThreads([makeThread()]);

    expect(updateSpy).toHaveBeenCalled();
    expect(renderSpy).toHaveBeenCalled();
  });

  it('preserves selection key for restore across re-render', () => {
    const panel = createTestPanel();
    panel.updateSegmentCounts = vi.fn();
    panel.renderFindings = vi.fn();
    panel.saveCurrentSelection = vi.fn();

    panel.setExternalThreads([makeThread()]);
    expect(panel.saveCurrentSelection).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// updateSegmentCounts
// -----------------------------------------------------------------------

describe('AIPanel.updateSegmentCounts', () => {
  function makeSegmentBtn(segment, countText = '(0)') {
    const span = { textContent: countText, classList: { toggle: vi.fn() } };
    return {
      dataset: { segment },
      querySelector: vi.fn(() => span),
      _countSpan: span,
    };
  }

  it('writes the external count to the External button', () => {
    const externalBtn = makeSegmentBtn('external');
    const panel = createTestPanel({
      externalThreads: [makeThread(), makeThread({ id: 2 })],
      segmentBtns: [makeSegmentBtn('ai'), makeSegmentBtn('comments'), externalBtn, makeSegmentBtn('all')],
    });
    panel.updateSegmentCounts();
    expect(externalBtn._countSpan.textContent).toBe('(2)');
  });

  it('includes external threads in the All count', () => {
    const allBtn = makeSegmentBtn('all');
    const panel = createTestPanel({
      findings: [{ id: 1 }, { id: 2 }],
      comments: [{ id: 10 }],
      externalThreads: [makeThread(), makeThread({ id: 2 }), makeThread({ id: 3 })],
      segmentBtns: [makeSegmentBtn('ai'), makeSegmentBtn('comments'), makeSegmentBtn('external'), allBtn],
    });
    panel.updateSegmentCounts();
    // 2 findings + 1 comment + 3 external = 6
    expect(allBtn._countSpan.textContent).toBe('(6)');
  });

  it('dims the External count when zero', () => {
    const externalBtn = makeSegmentBtn('external');
    const panel = createTestPanel({
      externalThreads: [],
      segmentBtns: [externalBtn],
    });
    panel.updateSegmentCounts();
    expect(externalBtn._countSpan.classList.toggle).toHaveBeenCalledWith('segment-count--zero', true);
  });
});

// -----------------------------------------------------------------------
// getFilteredItems
// -----------------------------------------------------------------------

describe('AIPanel.getFilteredItems', () => {
  it('returns only external threads when segment is "external"', () => {
    const panel = createTestPanel({
      selectedSegment: 'external',
      findings: [{ id: 1, file: 'a.js', line_start: 1 }],
      comments: [{ id: 10, file: 'a.js', line_start: 1 }],
      externalThreads: [makeThread()],
    });
    const items = panel.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0]._itemType).toBe('external');
    expect(items[0].id).toBe(100);
  });

  it('marks each external item with _itemType="external"', () => {
    const panel = createTestPanel({
      selectedSegment: 'external',
      externalThreads: [makeThread(), makeThread({ id: 101 })],
    });
    const items = panel.getFilteredItems();
    for (const item of items) {
      expect(item._itemType).toBe('external');
    }
  });

  it('includes external threads in the "all" segment', () => {
    const panel = createTestPanel({
      selectedSegment: 'all',
      findings: [{ id: 1, file: 'a.js', line_start: 1 }],
      comments: [{ id: 10, file: 'a.js', line_start: 2 }],
      externalThreads: [makeThread({ file: 'a.js', line_start: 3 })],
    });
    const items = panel.getFilteredItems();
    expect(items).toHaveLength(3);
    const types = items.map(i => i._itemType).sort();
    expect(types).toEqual(['comment', 'external', 'finding']);
  });

  it('returns an empty list when external segment has no threads', () => {
    const panel = createTestPanel({
      selectedSegment: 'external',
      externalThreads: [],
    });
    expect(panel.getFilteredItems()).toEqual([]);
  });

  it('does not include external threads in the "ai" segment', () => {
    const panel = createTestPanel({
      selectedSegment: 'ai',
      findings: [{ id: 1, file: 'a.js', line_start: 1 }],
      externalThreads: [makeThread()],
    });
    const items = panel.getFilteredItems();
    expect(items.every(i => i._itemType !== 'external')).toBe(true);
  });

  it('does not include external threads in the "comments" segment', () => {
    const panel = createTestPanel({
      selectedSegment: 'comments',
      comments: [{ id: 10, file: 'a.js', line_start: 1 }],
      externalThreads: [makeThread()],
    });
    const items = panel.getFilteredItems();
    expect(items.every(i => i._itemType !== 'external')).toBe(true);
  });
});

// -----------------------------------------------------------------------
// _normalizeExternalThread
// -----------------------------------------------------------------------

describe('AIPanel._normalizeExternalThread', () => {
  it('prefers live line_start when not outdated', () => {
    const panel = createTestPanel();
    const item = panel._normalizeExternalThread(makeThread({
      is_outdated: 0,
      line_start: 7,
      line_end: 7,
      original_line_start: 3,
      original_line_end: 3,
    }));
    expect(item.line_start).toBe(7);
    expect(item.line_end).toBe(7);
    expect(item.is_outdated).toBe(false);
  });

  it('falls back to original_line_start when outdated', () => {
    const panel = createTestPanel();
    const item = panel._normalizeExternalThread(makeThread({
      is_outdated: 1,
      line_start: null,
      line_end: null,
      original_line_start: 12,
      original_line_end: 14,
    }));
    expect(item.line_start).toBe(12);
    expect(item.line_end).toBe(14);
    expect(item.is_outdated).toBe(true);
  });

  it('falls back to live coordinate when outdated but original missing', () => {
    const panel = createTestPanel();
    const item = panel._normalizeExternalThread(makeThread({
      is_outdated: 1,
      line_start: 9,
      original_line_start: null,
    }));
    expect(item.line_start).toBe(9);
  });

  it('returns null line_start when both live and original are missing', () => {
    const panel = createTestPanel();
    const item = panel._normalizeExternalThread(makeThread({
      line_start: null,
      line_end: null,
      original_line_start: null,
      original_line_end: null,
    }));
    expect(item.line_start).toBeNull();
    expect(item.line_end).toBeNull();
  });

  it('returns _itemType="external" for null thread input', () => {
    const panel = createTestPanel();
    const item = panel._normalizeExternalThread(null);
    expect(item._itemType).toBe('external');
  });
});

// -----------------------------------------------------------------------
// sortItemsByFileOrder with mixed item types
// -----------------------------------------------------------------------

describe('AIPanel.sortItemsByFileOrder with mixed item types', () => {
  it('interleaves external + finding + comment items by file and line', () => {
    const panel = createTestPanel({
      fileOrder: new Map([['src/a.js', 0], ['src/b.js', 1]]),
    });
    const items = [
      { _itemType: 'finding', file: 'src/b.js', line_start: 10 },
      { _itemType: 'comment', file: 'src/a.js', line_start: 5 },
      { _itemType: 'external', file: 'src/a.js', line_start: 2 },
      { _itemType: 'finding', file: 'src/a.js', line_start: 8 },
      { _itemType: 'external', file: 'src/b.js', line_start: 3 },
    ];
    const sorted = panel.sortItemsByFileOrder(items);
    expect(sorted.map(i => `${i.file}:${i.line_start}:${i._itemType}`)).toEqual([
      'src/a.js:2:external',
      'src/a.js:5:comment',
      'src/a.js:8:finding',
      'src/b.js:3:external',
      'src/b.js:10:finding',
    ]);
  });

  it('handles items missing line_start (treated as 0 / file-level)', () => {
    const panel = createTestPanel({
      fileOrder: new Map([['src/a.js', 0]]),
    });
    const items = [
      { _itemType: 'external', file: 'src/a.js', line_start: 5 },
      { _itemType: 'external', file: 'src/a.js' /* no line */ },
    ];
    const sorted = panel.sortItemsByFileOrder(items);
    // Missing line_start (`?? 0`) sorts before the explicit line 5.
    expect(sorted[0].line_start).toBeUndefined();
    expect(sorted[1].line_start).toBe(5);
  });
});

// -----------------------------------------------------------------------
// renderExternalThreadItem
// -----------------------------------------------------------------------

describe('AIPanel.renderExternalThreadItem', () => {
  it('renders source-github class for GitHub threads', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread()),
      0
    );
    expect(html).toContain('source-github');
    expect(html).toContain('ai-panel__list-item--external');
  });

  it('writes data-thread-id, data-source, data-item-type, data-file, data-line', () => {
    const panel = createTestPanel();
    const thread = panel._normalizeExternalThread(makeThread({
      id: 555,
      source: 'github',
      file: 'src/utils.js',
      line_start: 9,
      line_end: 9,
    }));
    const html = panel.renderExternalThreadItem(thread, 2);
    expect(html).toContain('data-thread-id="555"');
    expect(html).toContain('data-source="github"');
    expect(html).toContain('data-item-type="external"');
    expect(html).toContain('data-file="src/utils.js"');
    expect(html).toContain('data-line="9"');
    expect(html).toContain('data-index="2"');
  });

  it('shows total comment count (root + replies) when replies exist', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread({
        replies: [
          { id: 11, body: 'r1' },
          { id: 12, body: 'r2' },
        ],
      })),
      0
    );
    // Root (1) + 2 replies = 3
    expect(html).toContain('external-list-count');
    expect(html).toContain('>3<');
  });

  it('always shows the count badge, including "1" for a thread with no replies', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread({ replies: [] })),
      0
    );
    expect(html).toContain('external-list-count');
    expect(html).toContain('>1<');
  });

  it('renders the is-outdated class when the thread is outdated', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread({ is_outdated: 1 })),
      0
    );
    expect(html).toContain('is-outdated');
    expect(html).toContain('external-list-outdated-badge');
  });

  it('shows author and body snippet (markdown stripped)', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread({
        author: 'octocat',
        body: 'This is **bold** plus `code` text',
      })),
      0
    );
    expect(html).toContain('octocat');
    // stripMarkdown removes ** and ` formatting
    expect(html).toContain('This is bold plus code text');
    expect(html).not.toContain('**');
  });

  it('escapes potentially hostile fields safely', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread({
        author: '<script>alert(1)</script>',
        body: '<img src=x onerror=alert(1)>',
      })),
      0
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
  });
});

// -----------------------------------------------------------------------
// restoreSegmentSelection — falls back when External is hidden
// -----------------------------------------------------------------------

describe('AIPanel.restoreSegmentSelection with hidden external button', () => {
  function makeBtn(segment, hidden = false) {
    return {
      dataset: { segment },
      classList: { toggle: vi.fn() },
      hasAttribute: (name) => name === 'hidden' && hidden,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };
  }

  it('falls back to "ai" when stored value is "external" but button is hidden (Local mode)', () => {
    mockLocalStorage['reviewPanelSegment_owner/repo#1'] = 'external';
    const panel = createTestPanel({
      segmentBtns: [
        makeBtn('ai'),
        makeBtn('comments'),
        makeBtn('external', /* hidden */ true),
        makeBtn('all'),
      ],
      levelFilter: { classList: { add: vi.fn() } },
    });
    panel.renderFindings = vi.fn();
    panel.restoreSegmentSelection();
    expect(panel.selectedSegment).toBe('ai');
  });

  it('honors "external" when the button is visible (PR mode)', () => {
    mockLocalStorage['reviewPanelSegment_owner/repo#1'] = 'external';
    const panel = createTestPanel({
      segmentBtns: [
        makeBtn('ai'),
        makeBtn('comments'),
        makeBtn('external', /* hidden */ false),
        makeBtn('all'),
      ],
      levelFilter: { classList: { add: vi.fn() } },
    });
    panel.renderFindings = vi.fn();
    panel.restoreSegmentSelection();
    expect(panel.selectedSegment).toBe('external');
  });

  it('falls back to "ai" for any unknown legacy stored value', () => {
    mockLocalStorage['reviewPanelSegment_owner/repo#1'] = 'some-future-segment';
    const panel = createTestPanel({
      segmentBtns: [makeBtn('ai'), makeBtn('comments'), makeBtn('all')],
      levelFilter: { classList: { add: vi.fn() } },
    });
    panel.renderFindings = vi.fn();
    panel.restoreSegmentSelection();
    expect(panel.selectedSegment).toBe('ai');
  });
});

// -----------------------------------------------------------------------
// scrollToExternalThread
// -----------------------------------------------------------------------

describe('AIPanel.scrollToExternalThread', () => {
  let originalDocument;

  beforeEach(() => {
    originalDocument = global.document;
    global.window = { ...global.window };
  });

  afterEach(() => {
    global.document = originalDocument;
  });

  function setupDocumentWithRow({ threadId = '101', source = 'github' } = {}) {
    const focusedClass = { add: vi.fn(), remove: vi.fn() };
    const row = {
      classList: focusedClass,
      scrollIntoView: vi.fn(),
      closest: vi.fn(() => null),
    };

    global.document = {
      ...originalDocument,
      querySelector: vi.fn((selector) => {
        // Match the (threadId, source) compound selector
        if (selector.includes(`data-thread-id="${threadId}"`)) return row;
        return null;
      }),
      querySelectorAll: vi.fn(() => []),
    };
    return { row, focusedClass };
  }

  it('finds the row by (threadId, source) and scrolls it into view', () => {
    const { row } = setupDocumentWithRow({ threadId: '42', source: 'github' });
    const panel = createTestPanel();
    panel.expandFileIfCollapsed = vi.fn(() => false);

    panel.scrollToExternalThread('42', 'github', 'src/utils.js', 5);

    expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('adds a transient .external-comment-row--focused class', () => {
    vi.useFakeTimers();
    const { focusedClass } = setupDocumentWithRow({ threadId: '7' });
    const panel = createTestPanel();
    panel.expandFileIfCollapsed = vi.fn(() => false);

    panel.scrollToExternalThread('7', 'github', 'src/x.js', 1);
    expect(focusedClass.add).toHaveBeenCalledWith('external-comment-row--focused');

    vi.advanceTimersByTime(2000);
    expect(focusedClass.remove).toHaveBeenCalledWith('external-comment-row--focused');

    vi.useRealTimers();
  });

  it('is a no-op when no matching row is in the DOM', () => {
    global.document = {
      ...originalDocument,
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    };
    const panel = createTestPanel();
    panel.expandFileIfCollapsed = vi.fn(() => false);
    expect(() => panel.scrollToExternalThread('999', 'github', 'src/x.js', 1)).not.toThrow();
  });
});

// -----------------------------------------------------------------------
// Segment overflow scroll
// -----------------------------------------------------------------------

describe('AIPanel.updateSegmentScrollChevrons', () => {
  function makeScrollContainer({ scrollWidth, clientWidth, scrollLeft = 0 }) {
    return { scrollWidth, clientWidth, scrollLeft };
  }
  function makeChevron() {
    const attrs = {};
    return {
      setAttribute: vi.fn((k, v) => { attrs[k] = v; }),
      removeAttribute: vi.fn((k) => { delete attrs[k]; }),
      _attrs: attrs,
    };
  }

  it('hides both chevrons when content fits the container', () => {
    const panel = createTestPanel({
      segmentControlScroll: makeScrollContainer({ scrollWidth: 200, clientWidth: 300 }),
      segmentScrollLeft: makeChevron(),
      segmentScrollRight: makeChevron(),
    });
    panel.updateSegmentScrollChevrons();
    expect(panel.segmentScrollLeft.setAttribute).toHaveBeenCalledWith('hidden', '');
    expect(panel.segmentScrollRight.setAttribute).toHaveBeenCalledWith('hidden', '');
  });

  it('shows the right chevron and hides the left when at scroll start', () => {
    const panel = createTestPanel({
      segmentControlScroll: makeScrollContainer({ scrollWidth: 600, clientWidth: 300, scrollLeft: 0 }),
      segmentScrollLeft: makeChevron(),
      segmentScrollRight: makeChevron(),
    });
    panel.updateSegmentScrollChevrons();
    expect(panel.segmentScrollLeft.setAttribute).toHaveBeenCalledWith('hidden', '');
    expect(panel.segmentScrollRight.removeAttribute).toHaveBeenCalledWith('hidden');
  });

  it('shows both chevrons when scrolled into the middle', () => {
    const panel = createTestPanel({
      segmentControlScroll: makeScrollContainer({ scrollWidth: 600, clientWidth: 300, scrollLeft: 100 }),
      segmentScrollLeft: makeChevron(),
      segmentScrollRight: makeChevron(),
    });
    panel.updateSegmentScrollChevrons();
    expect(panel.segmentScrollLeft.removeAttribute).toHaveBeenCalledWith('hidden');
    expect(panel.segmentScrollRight.removeAttribute).toHaveBeenCalledWith('hidden');
  });

  it('hides the right chevron when at the end of scroll', () => {
    const panel = createTestPanel({
      segmentControlScroll: makeScrollContainer({ scrollWidth: 600, clientWidth: 300, scrollLeft: 300 }),
      segmentScrollLeft: makeChevron(),
      segmentScrollRight: makeChevron(),
    });
    panel.updateSegmentScrollChevrons();
    expect(panel.segmentScrollLeft.removeAttribute).toHaveBeenCalledWith('hidden');
    expect(panel.segmentScrollRight.setAttribute).toHaveBeenCalledWith('hidden', '');
  });

  it('is a no-op when there is no scroll container', () => {
    const panel = createTestPanel({
      segmentControlScroll: null,
      segmentScrollLeft: makeChevron(),
      segmentScrollRight: makeChevron(),
    });
    expect(() => panel.updateSegmentScrollChevrons()).not.toThrow();
  });
});

describe('AIPanel.scrollSegmentRow', () => {
  it('scrolls right by ~150px', () => {
    const scrollBy = vi.fn();
    const panel = createTestPanel({
      segmentControlScroll: { scrollBy, scrollLeft: 0 },
    });
    panel.scrollSegmentRow(1);
    expect(scrollBy).toHaveBeenCalledWith({ left: 150, behavior: 'smooth' });
  });

  it('scrolls left by ~150px', () => {
    const scrollBy = vi.fn();
    const panel = createTestPanel({
      segmentControlScroll: { scrollBy, scrollLeft: 200 },
    });
    panel.scrollSegmentRow(-1);
    expect(scrollBy).toHaveBeenCalledWith({ left: -150, behavior: 'smooth' });
  });

  it('falls back to scrollLeft assignment when scrollBy is missing', () => {
    const container = { scrollLeft: 0 };
    const panel = createTestPanel({ segmentControlScroll: container });
    panel.scrollSegmentRow(1);
    expect(container.scrollLeft).toBe(150);
  });

  it('is a no-op when there is no scroll container', () => {
    const panel = createTestPanel({ segmentControlScroll: null });
    expect(() => panel.scrollSegmentRow(1)).not.toThrow();
  });
});

// -----------------------------------------------------------------------
// getItemKey — disambiguation for external threads on the same line
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Chat button on external thread items
// -----------------------------------------------------------------------

describe('AIPanel.renderExternalThreadItem chat button', () => {
  let originalDocumentElement;

  beforeEach(() => {
    originalDocumentElement = global.document.documentElement;
    global.document.documentElement = {
      style: { setProperty: vi.fn() },
      getAttribute: vi.fn((name) => (name === 'data-chat' ? 'available' : null)),
    };
  });

  afterEach(() => {
    global.document.documentElement = originalDocumentElement;
  });

  it('renders a chat button when data-chat is "available"', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread()),
      0
    );
    expect(html).toContain('quick-action-chat');
    expect(html).toContain('data-thread-id="100"');
    expect(html).toContain('data-source="github"');
    expect(html).toContain('data-item-type="external"');
  });

  it('does not render a chat button when data-chat is not available', () => {
    global.document.documentElement.getAttribute = vi.fn(() => null);
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread()),
      0
    );
    expect(html).not.toContain('quick-action-chat');
  });
});

describe('AIPanel.openQuickActionChat for external threads', () => {
  it('dispatches threadContext with replies for the external thread', () => {
    const open = vi.fn();
    global.window = { ...global.window, chatPanel: { open }, prManager: { currentPR: { id: 5 } } };

    const panel = createTestPanel({
      externalThreads: [
        {
          id: 42,
          source: 'github',
          author: 'octocat',
          body: 'Root body',
          file: 'src/a.js',
          side: 'RIGHT',
          line_start: 7,
          line_end: 7,
          is_outdated: 0,
          external_url: 'https://example.com/c/42',
          external_created_at: '2026-01-01',
          replies: [
            { author: 'rev', body: 'Reply 1', is_outdated: 0 },
          ],
        },
      ],
    });

    panel.openQuickActionChat({
      dataset: {
        itemType: 'external',
        threadId: '42',
        source: 'github',
      },
    });

    expect(open).toHaveBeenCalledTimes(1);
    const arg = open.mock.calls[0][0];
    expect(arg.reviewId).toBe(5);
    expect(arg.threadContext).toMatchObject({
      rootId: 42,
      source: 'external',
      externalSource: 'github',
      file: 'src/a.js',
      side: 'RIGHT',
      line_start: 7,
      line_end: 7,
    });
    expect(arg.threadContext.comments).toHaveLength(2);
    expect(arg.threadContext.comments[0].body).toBe('Root body');
    expect(arg.threadContext.comments[1].body).toBe('Reply 1');
  });

  it('uses original_line_* when the thread is outdated', () => {
    const open = vi.fn();
    global.window = { ...global.window, chatPanel: { open }, prManager: { currentPR: { id: 1 } } };

    const panel = createTestPanel({
      externalThreads: [
        {
          id: 9,
          source: 'github',
          file: 'src/b.js',
          side: 'RIGHT',
          line_start: null,
          line_end: null,
          original_line_start: 20,
          original_line_end: 22,
          is_outdated: 1,
          replies: [],
        },
      ],
    });

    panel.openQuickActionChat({
      dataset: { itemType: 'external', threadId: '9', source: 'github' },
    });

    const arg = open.mock.calls[0][0];
    expect(arg.threadContext.line_start).toBe(20);
    expect(arg.threadContext.line_end).toBe(22);
    expect(arg.threadContext.comments[0].isOutdated).toBe(true);
  });

  it('is a no-op when no matching thread is in state', () => {
    const open = vi.fn();
    global.window = { ...global.window, chatPanel: { open }, prManager: null };
    const panel = createTestPanel({ externalThreads: [] });
    panel.openQuickActionChat({
      dataset: { itemType: 'external', threadId: '999', source: 'github' },
    });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('AIPanel.getItemKey', () => {
  it('produces distinct keys for two external threads on the same (file, line)', () => {
    const panel = createTestPanel();
    const a = panel._normalizeExternalThread(makeThread({
      id: 1, external_id: 'gh-1', file: 'a.js', line_start: 5,
    }));
    const b = panel._normalizeExternalThread(makeThread({
      id: 2, external_id: 'gh-2', file: 'a.js', line_start: 5,
    }));
    expect(panel.getItemKey(a)).not.toEqual(panel.getItemKey(b));
  });

  it('falls back to thread.id when external_id is missing', () => {
    const panel = createTestPanel();
    const a = panel._normalizeExternalThread(makeThread({
      id: 7, external_id: null, file: 'a.js', line_start: 5,
    }));
    expect(panel.getItemKey(a)).toContain(':7');
  });

  it('preserves stable keys across re-normalization', () => {
    const panel = createTestPanel();
    const t = makeThread({ id: 9, external_id: 'gh-9', file: 'a.js', line_start: 5 });
    const k1 = panel.getItemKey(panel._normalizeExternalThread(t));
    const k2 = panel.getItemKey(panel._normalizeExternalThread(t));
    expect(k1).toEqual(k2);
  });
});
