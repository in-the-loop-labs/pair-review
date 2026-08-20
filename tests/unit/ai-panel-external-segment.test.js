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
 *  - restoreSegmentSelection() falls back to 'ai' when the External button is
 *    hidden, even if localStorage has the value.
 *  - setExternalSegmentVisible() reveals/hides the External button and never
 *    strands the panel on an invisible segment.
 *  - The constructor hides the External button ONLY for the
 *    `external_comments` kill switch — visibility per review is a capability
 *    (`canViewPRComments`), pushed in later by PRManager, never a mode sniff.
 *  - scrollToExternalThread's `notify` flag: the off-diff handling (context
 *    file + toast) is opt-in for deliberate clicks, so positional j/k
 *    navigation across off-diff threads stays silent and side-effect free.
 *  - The off-diff click path: ensureContextFile → externalCommentManager
 *    .render() → retry the row lookup → toast only on genuine failure.
 *
 * Most tests use Object.create(AIPanel.prototype) to exercise the actual
 * production methods without triggering the constructor's DOM dependencies
 * (the pattern established in ai-panel-collapse.test.js). The constructor
 * describe near the bottom is the exception: it builds a real AIPanel against
 * a stubbed DOM, because what the constructor itself decides is the thing
 * under test.
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
// The REAL manager: openQuickActionChat delegates external-thread chats to
// ExternalCommentManager.openThreadChat so the Review-panel quick action
// shares the anchor-trust gate with the inline card button. Tests below
// route through the production method — never a re-implementation.
const { ExternalCommentManager } = require('../../public/js/modules/external-comment-manager.js');

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

  it('labels a file-level thread "(file)" instead of a line number', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread({
        is_file_level: 1,
        line_start: null,
        line_end: null,
        original_line_start: null,
        original_line_end: null,
        file: 'src/utils.js',
      })),
      0
    );
    // Location shows the basename + "(file)" marker, no ":<line>".
    expect(html).toContain('utils.js (file)');
    expect(html).not.toMatch(/utils\.js:\d/);
    // No line anchor to write to data-line.
    expect(html).toContain('data-line=""');
  });

  it('still shows a line number for ordinary line-level threads', () => {
    const panel = createTestPanel();
    const html = panel.renderExternalThreadItem(
      panel._normalizeExternalThread(makeThread({ file: 'src/utils.js', line_start: 9, line_end: 9 })),
      0
    );
    expect(html).toContain('utils.js:9');
    expect(html).not.toContain('(file)');
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

  it('falls back to "ai" when stored value is "external" but the button is hidden', () => {
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

  it('honors "external" when the button is visible', () => {
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
// setExternalSegmentVisible — the setter PRManager drives
//
// AIPanel is deliberately dumb here: the policy (capability × feature
// toggle) lives in PRManager._updateExternalCommentsAffordances. What this
// method owes its caller is (a) the `hidden` attribute follows the argument,
// (b) an actual change re-runs restoreSegmentSelection so the panel is never
// stranded on an invisible segment, and (c) a no-change call costs nothing.
// -----------------------------------------------------------------------

describe('AIPanel.setExternalSegmentVisible', () => {
  /** Segment button whose `hidden` attribute actually mutates. */
  function makeToggleBtn(segment, hidden = false) {
    const attrs = new Set(hidden ? ['hidden'] : []);
    return {
      dataset: { segment },
      classList: { toggle: vi.fn() },
      hasAttribute: (name) => attrs.has(name),
      setAttribute: vi.fn((name) => attrs.add(name)),
      removeAttribute: vi.fn((name) => attrs.delete(name)),
    };
  }

  function makePanel({ externalHidden = false, selectedSegment = 'ai' } = {}) {
    const external = makeToggleBtn('external', externalHidden);
    const panel = createTestPanel({
      segmentBtns: [makeToggleBtn('ai'), makeToggleBtn('comments'), external, makeToggleBtn('all')],
      segmentExternalBtn: external,
      selectedSegment,
      levelFilter: { classList: { add: vi.fn() } },
    });
    panel.renderFindings = vi.fn();
    return { panel, external };
  }

  it('reveals a hidden button and re-runs the segment restore', () => {
    const { panel, external } = makePanel({ externalHidden: true });
    const restore = vi.spyOn(panel, 'restoreSegmentSelection');

    panel.setExternalSegmentVisible(true);

    expect(external.hasAttribute('hidden')).toBe(false);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('hides a visible button and re-runs the segment restore', () => {
    const { panel, external } = makePanel({ externalHidden: false });
    const restore = vi.spyOn(panel, 'restoreSegmentSelection');

    panel.setExternalSegmentVisible(false);

    expect(external.hasAttribute('hidden')).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when visibility is unchanged — no attribute churn, no restore', () => {
    // Called on every capability refresh (PR load, local metadata warm-up,
    // scope change), so an unchanged call must not clobber the user's current
    // segment selection.
    const { panel, external } = makePanel({ externalHidden: false, selectedSegment: 'external' });
    const restore = vi.spyOn(panel, 'restoreSegmentSelection');

    panel.setExternalSegmentVisible(true);

    expect(restore).not.toHaveBeenCalled();
    expect(external.setAttribute).not.toHaveBeenCalled();
    expect(external.removeAttribute).not.toHaveBeenCalled();
    expect(panel.selectedSegment).toBe('external');
  });

  it('hiding while "external" is selected leaves a selectable segment (no stranding)', () => {
    // The strand-prevention contract: without the restoreSegmentSelection
    // call the panel would keep filtering on an invisible segment and render
    // an empty list with no visible way back.
    mockLocalStorage['reviewPanelSegment_owner/repo#1'] = 'external';
    const { panel } = makePanel({ externalHidden: false, selectedSegment: 'external' });

    panel.setExternalSegmentVisible(false);

    expect(panel.selectedSegment).not.toBe('external');
    expect(panel.selectedSegment).toBe('ai');
  });
});

// -----------------------------------------------------------------------
// Constructor — what AIPanel itself is allowed to decide
//
// These build a REAL AIPanel against a stubbed DOM (rather than
// Object.create) because the thing under test is the constructor's own
// decision. Duplicating that decision in the test would assert nothing.
// -----------------------------------------------------------------------

describe('AIPanel constructor: External segment visibility', () => {
  let savedWindow;
  let savedDocument;

  beforeEach(() => {
    savedWindow = global.window;
    savedDocument = global.document;
  });

  afterEach(() => {
    global.window = savedWindow;
    global.document = savedDocument;
  });

  function makeSegmentBtn(segment, hidden = false) {
    const attrs = new Set(hidden ? ['hidden'] : []);
    return {
      dataset: { segment },
      classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() },
      hasAttribute: (name) => attrs.has(name),
      setAttribute: vi.fn((name) => attrs.add(name)),
      removeAttribute: vi.fn((name) => attrs.delete(name)),
      addEventListener: vi.fn(),
    };
  }

  /**
   * Construct a real AIPanel over a minimal DOM: an #ai-panel shell and a
   * #segment-control holding the four segment buttons. Everything else the
   * constructor reaches for resolves to null, which its own guards handle.
   *
   * @param {Object} [options]
   * @param {boolean} [options.killSwitch] - `external_comments_enabled: false`
   * @param {boolean} [options.localMode] - legacy `PAIR_REVIEW_LOCAL_MODE`
   * @param {boolean} [options.externalHiddenInMarkup] - local.html ships the
   *   button `hidden`; pr.html ships it visible.
   * @param {boolean} [options.withExternalBtn] - false models markup with no
   *   External button at all.
   */
  function constructPanel({
    killSwitch = false,
    localMode = false,
    externalHiddenInMarkup = false,
    withExternalBtn = true,
  } = {}) {
    const externalBtn = withExternalBtn ? makeSegmentBtn('external', externalHiddenInMarkup) : null;
    const segmentBtns = [makeSegmentBtn('ai'), makeSegmentBtn('comments'), makeSegmentBtn('all')];
    if (externalBtn) segmentBtns.splice(2, 0, externalBtn);

    const segmentControl = {
      querySelectorAll: vi.fn(() => segmentBtns),
      querySelector: vi.fn((sel) => (sel.includes('data-segment="external"') ? externalBtn : null)),
      appendChild: vi.fn(),
    };
    const panelEl = {
      classList: { contains: vi.fn(() => false), add: vi.fn(), remove: vi.fn() },
    };

    global.document = {
      ...savedDocument,
      getElementById: vi.fn((id) => {
        if (id === 'ai-panel') return panelEl;
        if (id === 'segment-control') return segmentControl;
        return null;
      }),
    };
    global.window = {
      ...savedWindow,
      PAIR_REVIEW_LOCAL_MODE: localMode,
      PAIR_REVIEW_RUNTIME_CONFIG: killSwitch
        ? { external_comments_enabled: false }
        : { external_comments_enabled: true },
    };

    const panel = new AIPanel();
    return { panel, externalBtn };
  }

  it('hides the External segment when the external_comments kill switch is off', () => {
    const { panel, externalBtn } = constructPanel({ killSwitch: true });

    expect(panel.segmentExternalBtn).toBe(externalBtn);
    expect(externalBtn.hasAttribute('hidden')).toBe(true);
  });

  it('does NOT hide it in local mode when the kill switch is off — the mode sniff is gone', () => {
    // Regression for Phase 2: the constructor used to read
    // `window.PAIR_REVIEW_LOCAL_MODE` and hide the segment outright, which
    // made a local review with an associated PR unable to show its comments.
    // Visibility is now a capability PRManager pushes in afterwards.
    const { externalBtn } = constructPanel({ localMode: true, killSwitch: false });

    expect(externalBtn.hasAttribute('hidden')).toBe(false);
    expect(externalBtn.setAttribute).not.toHaveBeenCalledWith('hidden', '');
  });

});

// -----------------------------------------------------------------------
// scrollToExternalThread
// -----------------------------------------------------------------------

describe('AIPanel.scrollToExternalThread', () => {
  let originalDocument;
  let originalWindow;

  beforeEach(() => {
    originalDocument = global.document;
    originalWindow = global.window;
    global.window = { ...global.window };
  });

  afterEach(() => {
    global.document = originalDocument;
    // Restore the pristine window too: these tests install toast doubles on
    // it, and the clone above would otherwise carry them into later suites.
    global.window = originalWindow;
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

  /** A document where no `.external-comment-row` matches anything. */
  function setupEmptyDocument() {
    global.document = {
      ...originalDocument,
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    };
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

  it('does not throw when no matching row is in the DOM and no toast is installed', () => {
    setupEmptyDocument();
    const panel = createTestPanel();
    panel.expandFileIfCollapsed = vi.fn(() => false);
    expect(() => panel.scrollToExternalThread('999', 'github', 'src/x.js', 1)).not.toThrow();
  });

  // The panel lists every thread the review has, but only files present in
  // the rendered diff can hold a row. In local mode that gap is routine (a
  // scoped review, or a PR comment on a file you haven't touched). A CLICK
  // resolves it by adding the file as a context file; only a genuine failure
  // to bring the file into view falls through to a toast.
  //
  // NOTE: every case below passes `{ notify: true }` because the toast is now
  // opt-in. The default-false behaviour has its own describe further down.
  describe('no matching row: last-resort toast', () => {
    const MESSAGE = 'Could not bring that file into view';

    it('uses window.toast.showInfo — an object of level methods, not a callable', async () => {
      setupEmptyDocument();
      const showInfo = vi.fn();
      global.window.toast = { showInfo, showError: vi.fn(), showWarning: vi.fn(), showSuccess: vi.fn() };
      global.window.showToast = vi.fn();
      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('999', 'github', 'src/x.js', 1, { notify: true });

      expect(showInfo).toHaveBeenCalledWith(MESSAGE);
      // Preferred path wins; the legacy shim is not also fired.
      expect(global.window.showToast).not.toHaveBeenCalled();
    });

    it('falls back to the legacy window.showToast(message, level) shim', async () => {
      setupEmptyDocument();
      delete global.window.toast;
      global.window.showToast = vi.fn();
      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('999', 'github', 'src/x.js', 1, { notify: true });

      expect(global.window.showToast).toHaveBeenCalledWith(MESSAGE, 'info');
    });

    it('stays silent when the row IS found', async () => {
      setupDocumentWithRow({ threadId: '42', source: 'github' });
      const showInfo = vi.fn();
      global.window.toast = { showInfo };
      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('42', 'github', 'src/utils.js', 5, { notify: true });

      expect(showInfo).not.toHaveBeenCalled();
    });

  });

  // -------------------------------------------------------------------
  // notify: the toast (and the context-file round trip) is opt-in
  //
  // scrollToExternalThread has two callers: onFindingClick (a deliberate
  // click) and scrollToCurrentItem (positional j/k navigation). Navigation
  // walks every item in the segment, including threads whose files aren't in
  // the rendered diff, so per-miss side effects must NOT fire there.
  // -------------------------------------------------------------------
  describe('notify flag', () => {
    it('does NOT toast or add a context file on a miss when notify is left at its default', async () => {
      setupEmptyDocument();
      const showInfo = vi.fn();
      const ensureContextFile = vi.fn(async () => ({ type: 'context', contextFile: { id: 1 } }));
      const render = vi.fn(async () => {});
      global.window.toast = { showInfo };
      global.window.showToast = vi.fn();
      global.window.prManager = { ensureContextFile };
      global.window.externalCommentManager = { render };
      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('999', 'github', 'src/x.js', 1);

      expect(showInfo).not.toHaveBeenCalled();
      expect(global.window.showToast).not.toHaveBeenCalled();
      expect(ensureContextFile).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // The actual regression: j/k autorepeat across off-diff threads
  //
  // Toast.showToast appends a node per call with a 5000ms timer and no
  // dedupe, so N off-diff threads used to mean N stacked toasts. Assert at
  // the navigation level, not just on the flag.
  // -------------------------------------------------------------------
  describe('keyboard navigation across off-diff external threads', () => {
    it('produces ZERO toasts and adds NO context files when goToNext walks several unrenderable threads', async () => {
      setupEmptyDocument();
      const showInfo = vi.fn();
      const ensureContextFile = vi.fn(async () => ({ type: 'context', contextFile: { id: 1 } }));
      global.window.toast = { showInfo };
      global.window.showToast = vi.fn();
      global.window.prManager = { ensureContextFile };
      global.window.externalCommentManager = { render: vi.fn(async () => {}) };

      const panel = createTestPanel({
        selectedSegment: 'external',
        externalThreads: [
          makeThread({ id: 1, external_id: 'gh-1', file: 'off/a.js', line_start: 3 }),
          makeThread({ id: 2, external_id: 'gh-2', file: 'off/b.js', line_start: 4 }),
          makeThread({ id: 3, external_id: 'gh-3', file: 'off/c.js', line_start: 5 }),
          makeThread({ id: 4, external_id: 'gh-4', file: 'off/d.js', line_start: 6 }),
        ],
        fileOrder: new Map([['off/a.js', 0], ['off/b.js', 1], ['off/c.js', 2], ['off/d.js', 3]]),
      });
      panel.expandFileIfCollapsed = vi.fn(() => false);

      // Four autorepeat ticks + one wrap-around.
      for (let i = 0; i < 5; i++) {
        panel.goToNext();
        // Drain any microtasks the async scroll queued before the next tick.
        await Promise.resolve();
      }

      expect(showInfo).not.toHaveBeenCalled();
      expect(global.window.showToast).not.toHaveBeenCalled();
      expect(ensureContextFile).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Off-diff click: add a context file on demand, re-anchor, retry
  // -------------------------------------------------------------------
  describe('off-diff click adds a context file', () => {
    /**
     * A document whose `.external-comment-row` lookup misses until
     * `revealRow()` is called — modelling the wrapper that only exists once
     * the context file has been rendered and the external rows re-anchored.
     */
    function setupLateRow({ threadId = '999' } = {}) {
      let present = false;
      const row = {
        classList: { add: vi.fn(), remove: vi.fn() },
        scrollIntoView: vi.fn(),
        closest: vi.fn(() => null),
      };
      global.document = {
        ...originalDocument,
        querySelector: vi.fn((selector) => {
          if (!present) return null;
          if (selector.includes(`data-thread-id="${threadId}"`)) return row;
          return null;
        }),
        querySelectorAll: vi.fn(() => []),
      };
      return { row, revealRow: () => { present = true; } };
    }

    it('calls ensureContextFile with the thread file and line, renders, retries, and stays silent', async () => {
      const { row, revealRow } = setupLateRow({ threadId: '999' });
      const showInfo = vi.fn();
      global.window.toast = { showInfo };

      const order = [];
      let querySelectorCallsAtRender = 0;

      const ensureContextFile = vi.fn(async () => {
        order.push('ensureContextFile');
        return { type: 'context', contextFile: { id: 7, file: 'off/x.js', line_start: 1, line_end: 21 } };
      });
      const render = vi.fn(async () => {
        order.push('render');
        querySelectorCallsAtRender = global.document.querySelector.mock.calls.length;
        revealRow();
      });

      global.window.prManager = { ensureContextFile };
      global.window.externalCommentManager = { render };

      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      // `line` arrives as a dataset STRING on the click path.
      await panel.scrollToExternalThread('999', 'github', 'off/x.js', '5', { notify: true });

      // Coerced to a number (ensureContextFile does arithmetic on the bounds),
      // and the END is deliberately null: ensureContextFile centres a ~21-line
      // window only when lineEnd is null, and treats an explicit end as an
      // exact range. Passing the anchor twice would render a context file
      // containing exactly one line, with no surrounding code to read the
      // comment against.
      expect(ensureContextFile).toHaveBeenCalledWith('off/x.js', 5, null);
      // Re-anchor happens AFTER the context file lands, not before.
      expect(order).toEqual(['ensureContextFile', 'render']);
      // The lookup was re-run after render(), and this time it hit.
      expect(global.document.querySelector.mock.calls.length).toBeGreaterThan(querySelectorCallsAtRender);
      expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
      expect(row.classList.add).toHaveBeenCalledWith('external-comment-row--focused');
      // Resolved, so nothing to tell the reviewer.
      expect(showInfo).not.toHaveBeenCalled();
    });

    it('retries after a { type: "diff" } result too', async () => {
      // A distinct branch: ensureContextFile answers `{type:'diff'}` when the
      // file turns out to already be in the diff — the row was missing only
      // because the wrapper had not rendered yet. No context file is created,
      // but the retry must still run, so the guard is `if (ensured)`, not a
      // check for `type === 'context'`.
      const { row, revealRow } = setupLateRow({ threadId: '999' });
      const showInfo = vi.fn();
      global.window.toast = { showInfo };

      const ensureContextFile = vi.fn(async () => ({ type: 'diff' }));
      const render = vi.fn(async () => { revealRow(); });

      global.window.prManager = { ensureContextFile };
      global.window.externalCommentManager = { render };

      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('999', 'github', 'off/x.js', '5', { notify: true });

      expect(render).toHaveBeenCalledTimes(1);
      expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
      expect(showInfo).not.toHaveBeenCalled();
    });

    it('passes a null anchor for a file-level thread with no line', async () => {
      setupEmptyDocument();
      const ensureContextFile = vi.fn(async () => null);
      global.window.prManager = { ensureContextFile };
      global.window.toast = { showInfo: vi.fn() };

      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('12', 'github', 'off/x.js', null, { notify: true });

      expect(ensureContextFile).toHaveBeenCalledWith('off/x.js', null, null);
    });

    it('toasts exactly once when ensureContextFile resolves null', async () => {
      setupEmptyDocument();
      const showInfo = vi.fn();
      global.window.toast = { showInfo };
      const render = vi.fn(async () => {});
      global.window.prManager = { ensureContextFile: vi.fn(async () => null) };
      global.window.externalCommentManager = { render };

      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('999', 'github', 'off/x.js', 5, { notify: true });

      expect(showInfo).toHaveBeenCalledTimes(1);
      expect(showInfo).toHaveBeenCalledWith('Could not bring that file into view');
      // Nothing was rendered, so there is nothing to re-anchor.
      expect(render).not.toHaveBeenCalled();
    });

    it('toasts once when ensureContextFile rejects', async () => {
      setupEmptyDocument();
      const showInfo = vi.fn();
      global.window.toast = { showInfo };
      global.window.prManager = { ensureContextFile: vi.fn(async () => { throw new Error('boom'); }) };

      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('999', 'github', 'off/x.js', 5, { notify: true });

      expect(showInfo).toHaveBeenCalledTimes(1);
    });

    it('toasts when the retry still misses after the context file rendered', async () => {
      setupEmptyDocument(); // row never appears
      const showInfo = vi.fn();
      global.window.toast = { showInfo };
      global.window.prManager = {
        ensureContextFile: vi.fn(async () => ({ type: 'context', contextFile: { id: 3 } })),
      };
      global.window.externalCommentManager = { render: vi.fn(async () => {}) };

      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      await panel.scrollToExternalThread('999', 'github', 'off/x.js', 5, { notify: true });

      expect(global.window.externalCommentManager.render).toHaveBeenCalledTimes(1);
      expect(showInfo).toHaveBeenCalledTimes(1);
    });

    it('abandons the scroll when a newer navigation started during the round trip', async () => {
      // The _navGen guard: a slow context-file fetch must not scroll after
      // the user has moved on.
      const { row, revealRow } = setupLateRow({ threadId: '999' });
      const showInfo = vi.fn();
      global.window.toast = { showInfo };

      const panel = createTestPanel();
      panel.expandFileIfCollapsed = vi.fn(() => false);

      global.window.prManager = {
        ensureContextFile: vi.fn(async () => {
          // Simulate the user pressing j while the POST is in flight.
          panel._navGen++;
          return { type: 'context', contextFile: { id: 9 } };
        }),
      };
      global.window.externalCommentManager = { render: vi.fn(async () => { revealRow(); }) };

      await panel.scrollToExternalThread('999', 'github', 'off/x.js', 5, { notify: true });

      expect(global.window.externalCommentManager.render).not.toHaveBeenCalled();
      expect(row.scrollIntoView).not.toHaveBeenCalled();
      expect(showInfo).not.toHaveBeenCalled();
    });
  });
});

// -----------------------------------------------------------------------
// onFindingClick — the deliberate-click entry point
// -----------------------------------------------------------------------

describe('AIPanel.onFindingClick for external items', () => {
  it('passes { notify: true } through to scrollToExternalThread', () => {
    const panel = createTestPanel({
      selectedSegment: 'external',
      externalThreads: [makeThread({ id: 100, external_id: 'gh-100', file: 'src/utils.js', line_start: 5 })],
      fileOrder: new Map([['src/utils.js', 0]]),
    });
    const scrollSpy = vi.fn();
    panel.scrollToExternalThread = scrollSpy;
    panel.scrollToComment = vi.fn();
    panel.scrollToFinding = vi.fn();

    panel.onFindingClick({
      dataset: {
        id: '100',
        itemType: 'external',
        file: 'src/utils.js',
        line: '5',
        index: '0',
        threadId: '100',
        source: 'github',
      },
    });

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith('100', 'github', 'src/utils.js', '5', { notify: true });
  });

  it('leaves comment and finding clicks on their own scroll paths', () => {
    const panel = createTestPanel({
      selectedSegment: 'all',
      comments: [{ id: 10, file: 'src/utils.js', line_start: 2 }],
      fileOrder: new Map([['src/utils.js', 0]]),
    });
    panel.scrollToExternalThread = vi.fn();
    panel.scrollToComment = vi.fn();
    panel.scrollToFinding = vi.fn();

    panel.onFindingClick({
      dataset: { id: '10', itemType: 'comment', file: 'src/utils.js', line: '2', index: '0' },
    });

    expect(panel.scrollToComment).toHaveBeenCalled();
    expect(panel.scrollToExternalThread).not.toHaveBeenCalled();
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
  // The external branch delegates to the REAL manager's public
  // openThreadChat, so these tests wire an actual ExternalCommentManager
  // (with a spy chat panel) onto window — the same object AIPanel reaches
  // for in production. The manager owns the payload shape AND the
  // anchor-trust gate; AIPanel only looks the thread up.

  /**
   * Install window.chatPanel + a real manager sharing the same open spy.
   * `managerOptions` seeds the anchor-trust flags (defaults = PR mode,
   * everything trusted).
   */
  function wireManager(managerOptions = {}) {
    const open = vi.fn();
    const chatPanel = { open };
    const manager = new ExternalCommentManager({
      reviewId: 'rev-1',
      chatPanel,
      ...managerOptions,
    });
    global.window = {
      ...global.window,
      chatPanel,
      prManager: { currentPR: { id: 5 } },
      externalCommentManager: manager,
    };
    return { open, manager };
  }

  it('delegates to the manager and dispatches threadContext with replies', () => {
    const { open } = wireManager();

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
    // The manager's payload carries no reviewId — ChatPanel.open resolves it
    // from window.prManager.currentPR.id, the same value AIPanel used to pass.
    expect(arg.reviewId).toBeUndefined();
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
    const { open } = wireManager();

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

  it('REGRESSION: an untrusted anchor opened from the Review panel nulls the lines', () => {
    // The old inline branch built its own threadContext and shipped
    // line_start/line_end unconditionally — a degraded local-mode anchor
    // reached ChatPanel as exact PR-head coordinates, and
    // _sendThreadContextMessage keys hunk extraction and its `file:line`
    // header purely on line_start (no isFileLevel guard). Nulled lines are
    // the ONLY protection, so this path must produce them.
    const { open } = wireManager({ trustPreciseAnchors: false, anchorPRNumber: 7 });

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
          line_end: 9,
          is_outdated: 0,
          replies: [],
        },
      ],
    });

    panel.openQuickActionChat({
      dataset: { itemType: 'external', threadId: '42', source: 'github' },
    });

    expect(open).toHaveBeenCalledTimes(1);
    const ctx = open.mock.calls[0][0].threadContext;
    expect(ctx.line_start).toBeNull();
    expect(ctx.line_end).toBeNull();
    // The provenance note rides along so the agent knows WHY there is no line.
    expect(ctx.anchorNote).toContain('PR #7');
    expect(ctx.anchorNote).toContain('written against a different commit');
    // The discussion itself still flows.
    expect(ctx.file).toBe('src/a.js');
    expect(ctx.comments[0].body).toBe('Root body');
  });

  it('is a no-op when no matching thread is in state', () => {
    const { open } = wireManager();
    const panel = createTestPanel({ externalThreads: [] });
    panel.openQuickActionChat({
      dataset: { itemType: 'external', threadId: '999', source: 'github' },
    });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('AIPanel.openQuickActionChat for comments', () => {
  it('preserves the LEFT (deletion) side from the comment model', () => {
    const open = vi.fn();
    global.window = { ...global.window, chatPanel: { open }, prManager: { currentPR: { id: 3 } } };

    const panel = createTestPanel({
      comments: [
        { id: 12, body: 'On the removed line', file: 'src/a.js', line_start: 4, line_end: 4, side: 'LEFT' },
      ],
    });

    panel.openQuickActionChat({
      dataset: { commentId: '12' },
    });

    expect(open).toHaveBeenCalledTimes(1);
    const arg = open.mock.calls[0][0];
    expect(arg.reviewId).toBe(3);
    expect(arg.commentContext).toMatchObject({
      commentId: '12',
      file: 'src/a.js',
      line_start: 4,
      line_end: 4,
      side: 'LEFT',
      source: 'user',
    });
  });

  it('defaults a missing comment side to RIGHT', () => {
    const open = vi.fn();
    global.window = { ...global.window, chatPanel: { open }, prManager: { currentPR: { id: 1 } } };

    const panel = createTestPanel({
      comments: [
        { id: 8, body: 'No side here', file: 'src/b.js', line_start: 2, line_end: 2 },
      ],
    });

    panel.openQuickActionChat({ dataset: { commentId: '8' } });

    const arg = open.mock.calls[0][0];
    expect(arg.commentContext.side).toBe('RIGHT');
  });

  it('falls back to data-comment-side when the comment is not in state', () => {
    const open = vi.fn();
    global.window = { ...global.window, chatPanel: { open }, prManager: { currentPR: { id: 2 } } };

    // No matching comment in state, so buildCommentContext relies on the
    // dataset carried on the button (the fallback path).
    const panel = createTestPanel({ comments: [] });

    panel.openQuickActionChat({
      dataset: {
        commentId: '99',
        commentFile: 'src/c.js',
        commentLineStart: '10',
        commentLineEnd: '10',
        commentSide: 'LEFT',
      },
    });

    const arg = open.mock.calls[0][0];
    expect(arg.commentContext).toMatchObject({
      commentId: '99',
      file: 'src/c.js',
      line_start: 10,
      line_end: 10,
      side: 'LEFT',
    });
  });
});

describe('AIPanel comment chat button rendering', () => {
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

  it('emits data-comment-side on the quick-action chat button', () => {
    const panel = createTestPanel();
    const html = panel.renderCommentItem(
      { id: 5, body: 'hi', file: 'src/a.js', line_start: 4, line_end: 4, side: 'LEFT' },
      0
    );
    expect(html).toContain('quick-action-chat');
    expect(html).toContain('data-comment-side="LEFT"');
  });

  it('defaults data-comment-side to RIGHT when the comment has no side', () => {
    const panel = createTestPanel();
    const html = panel.renderCommentItem(
      { id: 6, body: 'hi', file: 'src/a.js', line_start: 4, line_end: 4 },
      0
    );
    expect(html).toContain('data-comment-side="RIGHT"');
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
