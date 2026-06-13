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

beforeEach(() => {
  document.body.innerHTML = '';
  window.prManager = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.prManager;
});

describe('AIPanel.scrollToFinding', () => {
  it('awaits ensureFileBodyRendered before scrolling to the finding row', async () => {
    const order = [];
    const inst = Object.create(AIPanel.prototype);
    // Mirror the real constructor so the latest-wins guard doesn't NaN-bail.
    inst._navGen = 0;
    inst.expandFileIfCollapsed = vi.fn(() => undefined);
    inst._scrollDiffTarget = vi.fn(() => order.push('scroll'));
    window.prManager = {
      ensureFileBodyRendered: vi.fn(() => { order.push('render'); return Promise.resolve(); })
    };

    const finding = document.createElement('div');
    finding.className = 'ai-suggestion';
    finding.setAttribute('data-suggestion-id', 'F1');
    document.body.appendChild(finding);

    await inst.scrollToFinding('F1', 'a.js', null);

    expect(window.prManager.ensureFileBodyRendered).toHaveBeenCalledWith('a.js');
    // Render strictly precedes the lookup-and-scroll.
    expect(order).toEqual(['render', 'scroll']);
  });
});
