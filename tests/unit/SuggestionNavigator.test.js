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

describe('SuggestionNavigator.updateSuggestions selection', () => {
  it('keeps the selection by id when a refresh reorders items, clearing it only when removed', () => {
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'first' }, { id: 'selected' }];
    nav.currentSuggestionIndex = 1;

    nav.updateSuggestions([{ id: 'selected' }, { id: 'first' }]);
    expect(nav.currentSuggestionIndex).toBe(0);
    expect(nav.element.querySelector('.suggestion-item.current').dataset.id).toBe('selected');

    nav.updateSuggestions([{ id: 'first' }]);
    expect(nav.currentSuggestionIndex).toBe(-1);
    expect(nav.element.querySelector('.suggestion-item.current')).toBeNull();
  });

  it('keeps the selection when a status change refreshes the same list', () => {
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 1, status: 'active' }, { id: 2, status: 'active' }];
    nav.currentSuggestionIndex = 1;

    nav.updateSuggestions([{ id: 1, status: 'active' }, { id: 2, status: 'dismissed' }]);

    expect(nav.currentSuggestionIndex).toBe(1);
    const current = nav.element.querySelector('.suggestion-item.current');
    expect(current.dataset.id).toBe('2');
    expect(current.classList.contains('dismissed')).toBe(true);
  });

  it('starts with no selection when nothing was selected', () => {
    const nav = new SuggestionNavigator();
    nav.updateSuggestions([{ id: 'a' }, { id: 'b' }]);
    expect(nav.currentSuggestionIndex).toBe(-1);
    expect(nav.element.querySelector('.suggestion-item.current')).toBeNull();
  });
});

describe('SuggestionNavigator.scrollToSuggestion', () => {
  afterEach(() => {
    delete window.toast;
  });

  it('scrolls to the rendered suggestion without an error toast', () => {
    window.toast = { showError: vi.fn() };
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'shown' }];
    nav.currentSuggestionIndex = 0;
    const target = document.createElement('div');
    target.dataset.suggestionId = 'shown';
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    nav.scrollToSuggestion();

    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(window.toast.showError).not.toHaveBeenCalled();
  });

  it('shows the display error when the suggestion has no card in the diff', () => {
    window.toast = { showError: vi.fn() };
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'missing', _displayError: 'Line 9 (RIGHT) not found in diff for file "a.js"' }];
    nav.currentSuggestionIndex = 0;

    nav.scrollToSuggestion();

    expect(window.toast.showError).toHaveBeenCalledWith('Line 9 (RIGHT) not found in diff for file "a.js"');
  });

  it('shows no error while suggestions are being redisplayed', () => {
    // displayAISuggestions removes every card first and re-adds them when it
    // ends, so a lookup miss during a display is not an error.
    window.toast = { showError: vi.fn() };
    window.prManager = { suggestionManager: { _isDisplayingSuggestions: true } };
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'reloading' }];
    nav.currentSuggestionIndex = 0;

    nav.scrollToSuggestion();
    expect(window.toast.showError).not.toHaveBeenCalled();

    // Once the display has ended a miss is reported again.
    window.prManager.suggestionManager._isDisplayingSuggestions = false;
    nav.scrollToSuggestion();
    expect(window.toast.showError).toHaveBeenCalledWith('Could not reveal this finding');
  });

  it('falls back to a generic message without a display error', () => {
    window.toast = { showError: vi.fn() };
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'missing' }];
    nav.currentSuggestionIndex = 0;

    nav.scrollToSuggestion();

    expect(window.toast.showError).toHaveBeenCalledWith('Could not reveal this finding');
  });

  it('does nothing when there is no selection or no toast', () => {
    window.toast = { showError: vi.fn() };
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'missing' }];
    nav.currentSuggestionIndex = -1;
    nav.scrollToSuggestion();
    expect(window.toast.showError).not.toHaveBeenCalled();

    delete window.toast;
    nav.currentSuggestionIndex = 0;
    expect(() => nav.scrollToSuggestion()).not.toThrow();
  });

  it('does nothing when the selected index is past the end of the list', () => {
    window.toast = { showError: vi.fn() };
    const nav = new SuggestionNavigator();
    nav.suggestions = [];
    nav.currentSuggestionIndex = 3;
    expect(() => nav.scrollToSuggestion()).not.toThrow();
    expect(window.toast.showError).not.toHaveBeenCalled();
  });
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

  it('keeps the selected suggestion when suggestions refresh during a pending jump', async () => {
    let release;
    window.prManager = {
      findFileElement: vi.fn(() => null),
      ensureFileBodyRendered: vi.fn(() => new Promise(resolve => { release = resolve; }))
    };
    const nav = makeNavigator();
    const highlighted = [];
    nav.highlightCurrentSuggestion.mockImplementation(() => highlighted.push(nav.currentSuggestionIndex));
    nav.suggestions = [{ id: 'first', file: 'a.js', line_start: 20 },
      { id: 'selected', file: 'a.js', line_start: 40 }];

    const pending = nav.goToSuggestion(1);
    // A refresh lands while the file body is still rendering and moves the
    // selected suggestion to the front.
    nav.updateSuggestions([{ id: 'selected', file: 'a.js', line_start: 40 },
      { id: 'first', file: 'a.js', line_start: 20 }]);
    release();
    await pending;

    expect(nav.currentSuggestionIndex).toBe(0);
    expect(highlighted).toEqual([0]);
    expect(nav.scrollToSuggestion).toHaveBeenCalled();
  });
});
