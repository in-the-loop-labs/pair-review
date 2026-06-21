// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for the force-render hooks that keep lazy diff bodies correct:
 * code paths which scan a file's <tr> rows must render the (lazy) body first,
 * since an unrendered body has zero rows.
 *   - PRManager.expandForSuggestion() renders the body before scanning gaps.
 *   - SuggestionManager.displayAISuggestions() renders every targeted file's
 *     body before findHiddenSuggestions / inline insertion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

global.window = global.window || {};

const { PRManager } = require('../../public/js/pr.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');

describe('PRManager.expandForSuggestion force-render', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.GapCoordinates = { findMatchingGap: vi.fn(() => null), debugLog: vi.fn() };
    window.HunkParser = { EOF_SENTINEL: -1 };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.GapCoordinates;
    delete window.HunkParser;
  });

  it('awaits ensureFileBodyRendered before scanning for gap rows', async () => {
    const m = Object.create(PRManager.prototype);
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    document.body.appendChild(wrapper);

    m.findFileElement = vi.fn(() => wrapper);
    const order = [];
    m.ensureFileBodyRendered = vi.fn(async (f) => { order.push(`ensure:${f}`); });
    // Spy the gap scan via wrapper.querySelectorAll so we can assert ordering.
    const origQSA = wrapper.querySelectorAll.bind(wrapper);
    wrapper.querySelectorAll = vi.fn((sel) => { order.push(`scan:${sel}`); return origQSA(sel); });

    const result = await m.expandForSuggestion('a.js', 10, 12, 'RIGHT');

    expect(m.ensureFileBodyRendered).toHaveBeenCalledWith('a.js');
    // Render happened before the gap-row scan.
    expect(order[0]).toBe('ensure:a.js');
    expect(order.some(o => o.startsWith('scan:tr.context-expand-row'))).toBe(true);
    expect(order.indexOf('ensure:a.js')).toBeLessThan(
      order.findIndex(o => o.startsWith('scan:tr.context-expand-row'))
    );
    // No matching gap → returns false (the line wasn't in a collapsed gap).
    expect(result).toBe(false);
  });

  it('awaits the pending EOF-gap validation before matching gaps', async () => {
    // Regression: with lazy rendering, _renderFileBodyNow fires
    // validatePendingEofGaps() fire-and-forget. Until it resolves, the trailing
    // EOF gap still carries EOF_SENTINEL coords, so findMatchingGap() can never
    // match a real target line and a suggestion on a trailing unchanged line
    // silently fails to expand/anchor. expandForSuggestion must await that
    // in-flight validation before matching.
    const m = Object.create(PRManager.prototype);
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = 'a.js';
    document.body.appendChild(wrapper);

    m.findFileElement = vi.fn(() => wrapper);
    m.ensureFileBodyRendered = vi.fn(async () => {});

    const order = [];
    let resolveValidation;
    const eofValidationPromise = new Promise((resolve) => {
      resolveValidation = () => { order.push('eof-validated'); resolve(); };
    });
    m._lazyFileBodies = new Map([['a.js', { eofValidationPromise }]]);

    // Capture-at-call: expandForSuggestion destructures findMatchingGap from
    // window.GapCoordinates at entry, so install the ordering spy beforehand.
    window.GapCoordinates.findMatchingGap = vi.fn(() => { order.push('match'); return null; });

    const pending = m.expandForSuggestion('a.js', 100, 100, 'RIGHT');

    // Flush microtasks: the gap match must NOT run while EOF validation is
    // still pending. This is the guard that would fail before the fix.
    await new Promise((r) => setTimeout(r, 0));
    expect(window.GapCoordinates.findMatchingGap).not.toHaveBeenCalled();

    resolveValidation();
    await pending;

    // Validation resolved before the gap was matched.
    expect(order).toEqual(['eof-validated', 'match']);
  });
});

describe('SuggestionManager.displayAISuggestions force-render', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the body of every targeted file before anchoring', async () => {
    const sm = Object.create(SuggestionManager.prototype);
    const ensureSpy = vi.fn().mockResolvedValue(null);
    sm.prManager = {
      currentPR: { id: 1 },
      ensureFileBodyRendered: ensureSpy,
      suggestionNavigator: null,
      fileCommentManager: null
    };
    // Stub the bits we are not exercising so the method runs cleanly.
    sm._closeReasoningPopover = vi.fn();
    sm.findHiddenSuggestions = vi.fn(() => []);
    sm.findFileElement = vi.fn(() => null); // short-circuit inline insertion

    await sm.displayAISuggestions([
      { file: 'a.js', line_start: 1, side: 'RIGHT' },
      { file: 'b.js', line_start: 2, side: 'RIGHT' },
      { file: 'a.js', line_start: 9, side: 'RIGHT' }
    ]);

    // Distinct files only, each rendered before scanning.
    const files = ensureSpy.mock.calls.map(c => c[0]).sort();
    expect(files).toEqual(['a.js', 'b.js']);
    // Force-render ran before the hidden-line scan.
    expect(ensureSpy).toHaveBeenCalled();
    expect(sm.findHiddenSuggestions).toHaveBeenCalled();
  });
});
