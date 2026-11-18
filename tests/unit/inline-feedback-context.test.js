// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { setImmediate } from 'node:timers';

const { AIPanel } = require('../../public/js/components/AIPanel.js');
const { makePageManager, cardBridge } = require('../utils/page-manager.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { createBridgeHarness, restoreBridgeHarnesses, hunk } = require('../utils/pierre-bridge-harness.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

afterEach(() => {
  restoreBridgeHarnesses();
  document.body.innerHTML = '';
  delete window.prManager;
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
    const card = document.createElement('div');
    card.className = 'ai-suggestion user-comment-row';
    card.dataset.suggestionId = '1';
    card.dataset.commentId = '1';
    card.scrollIntoView = vi.fn();
    let reveal;
    // The production navigation helper (PRManager.revealInDiff); the line
    // reveal and the bridge's card questions are the stubs.
    window.prManager = makePageManager({
      pierreBridge: cardBridge({ 'suggestion-1': card, 'comment-1': card }),
      ensureLinesVisible: vi.fn(() => new Promise(resolve => {
        reveal = () => { document.body.appendChild(card); resolve(); };
      })),
    });

    let completed = false;
    const navigation = inst[method]('1', 'a.js', '10').then(() => { completed = true; });
    // Let the caller settle if it forgot to await doScroll. The reveal promise
    // stays pending until the test releases it, independent of elapsed time.
    await new Promise(setImmediate);
    expect(completed).toBe(false);
    expect(card.scrollIntoView).not.toHaveBeenCalled();
    reveal();
    await navigation;

    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'a.js', line_start: 10, line_end: 50, side },
    ]);
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('falls back to the supplied line when the item is absent', async () => {
    const inst = Object.create(AIPanel.prototype);
    inst._navGen = 0;
    inst[collection] = [];
    window.prManager = makePageManager({ ensureLinesVisible: vi.fn(async () => {}) });

    await inst[method]('missing', 'a.js', '30');

    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'a.js', line_start: 30, line_end: 30, side: 'RIGHT' },
    ]);
  });
});

it('preserves comment context when refreshing to an empty suggestion list', async () => {
  // The production bridge (on a viewer that never renders): a range revealed
  // for a comment is the file's, not the suggestions'.
  const numbered = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const bridge = createBridgeHarness(vi, vendor, { files: [{ name: 'a.js', hunks: [hunk(10, 12)] }] });
  const changed = numbered.replace('line 11\n', 'changed 11\n');
  bridge.upgradeFileContents('a.js', { name: 'a.js', contents: numbered }, { name: 'a.js', contents: changed });
  expect(bridge.isLineVisible('a.js', 80, 'RIGHT')).toBe(false);
  bridge.addContextRanges('a.js', [{ startLine: 70, endLine: 80 }]);
  expect(bridge.isLineVisible('a.js', 80, 'RIGHT')).toBe(true);

  const sm = Object.create(SuggestionManager.prototype);
  sm.prManager = { pierreBridge: bridge };
  sm._closeReasoningPopover = vi.fn();
  await sm.displayAISuggestions([]);

  expect(bridge.isLineVisible('a.js', 80, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 70, 'RIGHT')).toBe(true);
});
