// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { setImmediate } from 'node:timers';

const { AIPanel } = require('../../public/js/components/AIPanel.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const PierreBridge = require('../../public/js/modules/pierre-bridge.js');
const PierreContext = require('../../public/js/modules/pierre-context.js');

afterEach(() => {
  document.body.innerHTML = '';
  delete window.prManager;
  delete window.PierreContext;
  vi.restoreAllMocks();
});

describe.each([
  ['scrollToFinding', 'findings'],
  ['scrollToComment', 'comments'],
])('AIPanel.%s range navigation', (method, collection) => {
  it.each(['LEFT', 'RIGHT'])('reveals both endpoints on the %s side before looking up the card', async (side) => {
    const inst = Object.create(AIPanel.prototype);
    inst._navGen = 0;
    inst[collection] = [{ id: 1, line_start: 10, line_end: 50, side }];
    inst.expandFileIfCollapsed = vi.fn();
    inst._scrollDiffTarget = vi.fn();
    const card = document.createElement('div');
    card.className = 'ai-suggestion user-comment-row';
    card.dataset.suggestionId = '1';
    card.dataset.commentId = '1';
    let reveal;
    window.prManager = {
      ensureLinesVisible: vi.fn(() => new Promise(resolve => {
        reveal = () => { document.body.appendChild(card); resolve(); };
      })),
    };

    let completed = false;
    const navigation = inst[method]('1', 'a.js', '10').then(() => { completed = true; });
    // Let the caller settle if it forgot to await doScroll. The reveal promise
    // stays pending until the test releases it, independent of elapsed time.
    await new Promise(setImmediate);
    expect(completed).toBe(false);
    expect(inst._scrollDiffTarget).not.toHaveBeenCalled();
    reveal();
    await navigation;

    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'a.js', line_start: 10, line_end: 50, side },
    ]);
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(card);
  });

  it('falls back to the supplied line when the item is absent', async () => {
    const inst = Object.create(AIPanel.prototype);
    inst._navGen = 0;
    inst[collection] = [];
    inst.expandFileIfCollapsed = vi.fn();
    window.prManager = { ensureLinesVisible: vi.fn(async () => {}) };

    await inst[method]('missing', 'a.js', '30');

    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'a.js', line_start: 30, line_end: 30, side: 'RIGHT' },
    ]);
  });
});

it('preserves comment context when refreshing to an empty suggestion list', async () => {
  window.PierreContext = PierreContext;
  const bridge = Object.create(PierreBridge.prototype);
  const instance = {
    render({ fileDiff }) { this.fileDiff = fileDiff; return false; },
  };
  bridge.files = new Map([['a.js', {
    fileName: 'a.js', instance, annotations: [], formElements: new Map(),
    baseMetadata: { hunks: [], additionLines: Array(100).fill('line') },
  }]]);
  bridge._updateAnnotations = vi.fn();
  bridge.addContextRanges('a.js', [{ startLine: 70, endLine: 80 }]);
  expect(bridge.isLineVisible('a.js', 80, 'RIGHT')).toBe(true);

  const sm = Object.create(SuggestionManager.prototype);
  sm.prManager = { pierreBridge: bridge };
  sm._closeReasoningPopover = vi.fn();
  await sm.displayAISuggestions([]);

  expect(bridge.isLineVisible('a.js', 80, 'RIGHT')).toBe(true);
});

it('keeps manually expanded comment anchors visible when revealing another location', () => {
  window.PierreContext = PierreContext;
  const bridge = Object.create(PierreBridge.prototype);
  const baseMetadata = {
    hunks: [{
      additionStart: 50, additionCount: 1, additionLines: 0,
      deletionStart: 50, deletionCount: 1, deletionLines: 0,
      splitLineCount: 1, unifiedLineCount: 1, collapsedBefore: 49,
    }],
    additionLines: Array(100).fill('line'),
    deletionLines: Array(100).fill('line'),
  };
  const expansions = new Map([
    [0, { fromStart: 10, fromEnd: 10 }],
    [1, { fromStart: 10, fromEnd: 0 }],
  ]);
  const instance = {
    fileDiff: baseMetadata,
    hunksRenderer: { expandedHunks: expansions, getExpandedHunk: i => expansions.get(i) },
    render({ fileDiff }) { this.fileDiff = fileDiff; return false; },
  };
  bridge.files = new Map([['a.js', { fileName: 'a.js', instance, baseMetadata }]]);
  expect(bridge.isLineVisible('a.js', 40, 'LEFT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 60, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 10, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 30, 'RIGHT')).toBe(false);

  bridge.addContextRanges('a.js', [{ startLine: 90, endLine: 90 }]);

  expect(expansions.size).toBe(0);
  expect(bridge.isLineVisible('a.js', 40, 'LEFT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 60, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 10, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 30, 'RIGHT')).toBe(false);
  expect(bridge.isLineVisible('a.js', 90, 'RIGHT')).toBe(true);
});
