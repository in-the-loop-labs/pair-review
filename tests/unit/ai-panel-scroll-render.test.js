// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Regression test for AIPanel scroll-to navigation: the target's lazy file
 * body must be rendered (awaited) BEFORE the row lookup inside doScroll —
 * otherwise the suggestion/comment row doesn't exist yet and the scroll
 * silently misses on the first attempt. We bypass AIPanel's heavy DOM
 * constructor with Object.create and exercise scrollToFinding directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { AIPanel } = require('../../public/js/components/AIPanel.js');
const { makePageManager, cardBridge } = require('../utils/page-manager.js');

beforeEach(() => {
  document.body.innerHTML = '';
  window.prManager = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.prManager;
});

describe('AIPanel.scrollToFinding', () => {
  it('expands the finding\'s file before scrolling to the finding\'s card', async () => {
    const order = [];
    const inst = Object.create(AIPanel.prototype);
    // Mirror the real constructor so the latest-wins guard doesn't NaN-bail.
    inst._navGen = 0;

    const finding = document.createElement('div');
    finding.className = 'ai-suggestion';
    finding.setAttribute('data-suggestion-id', 'F1');
    finding.scrollIntoView = vi.fn(() => order.push('scroll'));
    document.body.appendChild(finding);

    // The production navigation helper, on a page manager whose collapse
    // writer and bridge are the only stubs.
    window.prManager = makePageManager({
      pierreBridge: cardBridge({ 'suggestion-F1': finding }),
      isFileCollapsed: vi.fn(() => true),
      setFileCollapsed: vi.fn(async () => { order.push('expand'); return true; }),
    });
    const reveal = vi.spyOn(window.prManager, 'revealInDiff');

    await inst.scrollToFinding('F1', 'a.js', null);

    expect(window.prManager.setFileCollapsed).toHaveBeenCalledWith('a.js', false);
    // The file is opened strictly before the lookup-and-scroll.
    expect(order).toEqual(['expand', 'scroll']);
    // One helper does it: the card is asked for by annotation id first, then
    // in the file's comment zone.
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal.mock.calls[0][0]).toMatchObject({
      file: 'a.js',
      annotationId: 'suggestion-F1',
      zoneCardSelector: '.ai-suggestion[data-suggestion-id="F1"]',
    });
    expect(finding.classList.contains('current-suggestion')).toBe(true);
  });

  it('does nothing without a page manager to navigate through', async () => {
    const inst = Object.create(AIPanel.prototype);
    inst._navGen = 0;
    const finding = document.createElement('div');
    finding.className = 'ai-suggestion';
    finding.setAttribute('data-suggestion-id', 'F1');
    finding.scrollIntoView = vi.fn();
    document.body.appendChild(finding);

    await expect(inst.scrollToFinding('F1', 'a.js', null)).resolves.toBeUndefined();
    await expect(inst.scrollToComment('C1', 'a.js', null)).resolves.toBeUndefined();
    await expect(inst.scrollToExternalThread('T1', 'github', 'a.js', null)).resolves.toBeUndefined();
    expect(finding.scrollIntoView).not.toHaveBeenCalled();
  });
});
