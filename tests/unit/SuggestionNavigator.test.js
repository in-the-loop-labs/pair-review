// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for SuggestionNavigator's async navigation path.
 *
 * The suggestion's diff row only exists once its (lazily rendered) file body
 * is in the DOM, so `goToSuggestion` awaits `ensureSuggestionVisible` before
 * highlighting/scrolling. These tests lock in:
 *   - the render-before-lookup ordering (the bug being fixed),
 *   - that a collapsed file is expanded vs. a rendered-but-collapsed body,
 *   - the early returns when there's no file / no prManager,
 *   - and the latest-call-wins guard against rapid Next/Prev racing on the
 *     shared `this.currentSuggestionIndex` across the await.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SuggestionNavigator = require('../../public/js/components/SuggestionNavigator.js');

/** Build a navigator with the list-rendering DOM stubbed out. */
function makeNavigator() {
  const nav = new SuggestionNavigator();
  // Isolate goToSuggestion's await ordering from real DOM highlight/scroll.
  vi.spyOn(nav, 'highlightCurrentSuggestion').mockImplementation(() => {});
  vi.spyOn(nav, 'scrollToSuggestion').mockImplementation(() => {});
  return nav;
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  window.prManager = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.prManager;
});

describe('SuggestionNavigator.goToSuggestion', () => {
  it('expands a collapsed file before highlight/scroll', async () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper collapsed';
    wrapper.dataset.fileName = 'a.js';
    const order = [];
    window.prManager = {
      findFileElement: vi.fn(() => wrapper),
      toggleFileCollapse: vi.fn(async () => order.push('toggle')),
      ensureFileBodyRendered: vi.fn(async () => order.push('render'))
    };
    const nav = makeNavigator();
    nav.highlightCurrentSuggestion.mockImplementation(() => order.push('highlight'));
    nav.scrollToSuggestion.mockImplementation(() => order.push('scroll'));
    nav.suggestions = [{ id: 's1', file: 'a.js' }];

    await nav.goToSuggestion(0);

    expect(window.prManager.toggleFileCollapse).toHaveBeenCalledWith('a.js');
    expect(window.prManager.ensureFileBodyRendered).not.toHaveBeenCalled();
    // Highlight/scroll run strictly after the expand await resolves.
    expect(order).toEqual(['toggle', 'highlight', 'scroll']);
  });

  it('renders the lazy body for a non-collapsed file', async () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = 'a.js';
    window.prManager = {
      findFileElement: vi.fn(() => wrapper),
      toggleFileCollapse: vi.fn(async () => {}),
      ensureFileBodyRendered: vi.fn(async () => {})
    };
    const nav = makeNavigator();
    nav.suggestions = [{ id: 's1', file: 'a.js' }];

    await nav.goToSuggestion(0);

    expect(window.prManager.ensureFileBodyRendered).toHaveBeenCalledWith('a.js');
    expect(window.prManager.toggleFileCollapse).not.toHaveBeenCalled();
    expect(nav.highlightCurrentSuggestion).toHaveBeenCalled();
    expect(nav.scrollToSuggestion).toHaveBeenCalled();
  });

  it('does nothing for an out-of-range index', async () => {
    window.prManager = { findFileElement: vi.fn(), ensureFileBodyRendered: vi.fn() };
    const nav = makeNavigator();
    nav.suggestions = [{ id: 's1', file: 'a.js' }];

    await nav.goToSuggestion(5);

    expect(window.prManager.findFileElement).not.toHaveBeenCalled();
    expect(nav.highlightCurrentSuggestion).not.toHaveBeenCalled();
  });

  it('skips file prep when the suggestion has no file', async () => {
    window.prManager = {
      findFileElement: vi.fn(),
      toggleFileCollapse: vi.fn(),
      ensureFileBodyRendered: vi.fn()
    };
    const nav = makeNavigator();
    nav.suggestions = [{ id: 's1' }]; // no file

    await nav.goToSuggestion(0);

    expect(window.prManager.findFileElement).not.toHaveBeenCalled();
    expect(window.prManager.ensureFileBodyRendered).not.toHaveBeenCalled();
    // Still navigates — best effort falls through to the lookup.
    expect(nav.highlightCurrentSuggestion).toHaveBeenCalled();
  });

  it('still navigates when prManager is unavailable', async () => {
    window.prManager = undefined;
    const nav = makeNavigator();
    nav.suggestions = [{ id: 's1', file: 'a.js' }];

    await nav.goToSuggestion(0);

    expect(nav.highlightCurrentSuggestion).toHaveBeenCalled();
    expect(nav.scrollToSuggestion).toHaveBeenCalled();
  });

  it('lets a newer goToSuggestion supersede an older in-flight one', async () => {
    // Each ensureFileBodyRendered call hands back a resolver we control, so we
    // can interleave two goToSuggestion calls across their awaits.
    const resolvers = [];
    window.prManager = {
      findFileElement: vi.fn(() => {
        const w = document.createElement('div');
        w.className = 'd2h-file-wrapper';
        return w;
      }),
      toggleFileCollapse: vi.fn(),
      ensureFileBodyRendered: vi.fn(() => new Promise((res) => resolvers.push(res)))
    };
    const nav = makeNavigator();
    const highlighted = [];
    nav.highlightCurrentSuggestion.mockImplementation(() => highlighted.push(nav.currentSuggestionIndex));
    nav.suggestions = [{ id: 's1', file: 'a.js' }, { id: 's2', file: 'b.js' }];

    const pA = nav.goToSuggestion(0); // _navGen = 1, awaits resolvers[0]
    const pB = nav.goToSuggestion(1); // _navGen = 2, awaits resolvers[1]

    // Resolve the OLDER call first; it must still bail because gen moved on.
    resolvers[0]();
    resolvers[1]();
    await Promise.all([pA, pB]);

    // Only the latest call highlights, and it sees its own (latest) index.
    expect(highlighted).toEqual([1]);
    expect(nav.currentSuggestionIndex).toBe(1);
  });
});
