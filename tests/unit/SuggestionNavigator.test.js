// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for SuggestionNavigator's async navigation path.
 *
 * The suggestion's card only exists once its (lazily rendered) file body is
 * in the DOM, so `goToSuggestion` goes through the page's one navigation
 * helper, `PRManager.revealInDiff` (the production one here, on a page
 * manager from tests/utils/page-manager.js), before highlighting. These
 * tests lock in:
 *   - the render-before-lookup ordering (the bug being fixed),
 *   - that a collapsed file is expanded vs. a rendered-but-collapsed body,
 *   - the early returns when there's no file / no prManager,
 *   - and the latest-call-wins guard against rapid Next/Prev racing on the
 *     shared `this.currentSuggestionIndex` across the await.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SuggestionNavigator = require('../../public/js/components/SuggestionNavigator.js');
const { makePageManager, PRManager } = require('../utils/page-manager.js');

/** Build a navigator with the list-rendering DOM stubbed out. */
function makeNavigator() {
  const nav = new SuggestionNavigator();
  // Isolate goToSuggestion's await ordering from real DOM highlight/scroll.
  vi.spyOn(nav, 'highlightCurrentSuggestion').mockImplementation(() => {});
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

/** A suggestion card attached to the document. */
function addCard(id) {
  const target = document.createElement('div');
  target.className = 'ai-suggestion';
  target.dataset.suggestionId = id;
  target.scrollIntoView = vi.fn();
  document.body.appendChild(target);
  return target;
}

/**
 * A bridge whose wait for a card ends when the test says so: `resolvers`
 * gets one function per wait that was started, in order.
 * @param {Object<string, Element>} cards - annotation id to card
 */
function waitingBridge(cards) {
  const resolvers = [];
  const bridge = {
    files: new Map(),
    findAnnotationFile: (annotationId, file) => (cards[annotationId] ? file : null),
    getAnnotationElement: (file, annotationId) => cards[annotationId] || null,
    isElementDrawn: (element) => !!element?.isConnected,
    scrollToAnnotation: vi.fn(() => true),
    whenAnnotationRendered: vi.fn((file, annotationId) => new Promise((resolve) => {
      resolvers.push(() => resolve(cards[annotationId] || null));
    })),
  };
  return { bridge, resolvers };
}

describe('SuggestionNavigator.goToSuggestion: reveal and report', () => {
  afterEach(() => {
    delete window.toast;
  });

  it('scrolls to the suggestion\'s card through revealInDiff without an error toast', async () => {
    window.toast = { showError: vi.fn() };
    window.prManager = makePageManager();
    const reveal = vi.spyOn(window.prManager, 'revealInDiff');
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'shown', file: 'a.js' }];
    const target = addCard('shown');

    await nav.goToSuggestion(0);

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal.mock.calls[0][0]).toMatchObject({
      file: 'a.js',
      annotationId: 'suggestion-shown',
      zoneCardSelector: '.ai-suggestion[data-suggestion-id="shown"]',
      scroll: { behavior: 'smooth', block: 'start', inline: 'nearest' },
    });
    // The lines are not revealed here: displaying the suggestions did that.
    expect(reveal.mock.calls[0][0].line_start).toBeUndefined();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    expect(target.classList.contains('current-suggestion')).toBe(true);
    expect(window.toast.showError).not.toHaveBeenCalled();
  });

  it('shows the display error when the suggestion has no card in the diff', async () => {
    window.toast = { showError: vi.fn() };
    window.prManager = makePageManager();
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'missing', _displayError: 'Line 9 (RIGHT) not found in diff for file "a.js"' }];

    await nav.goToSuggestion(0);

    expect(window.toast.showError).toHaveBeenCalledWith('Line 9 (RIGHT) not found in diff for file "a.js"');
  });

  it('reports a card that exists and is not attached to the document as not revealed', async () => {
    // The bridge holds a card for the suggestion's annotation, and the diff
    // never attaches it (its line is not shown). That is a miss.
    window.toast = { showError: vi.fn() };
    const detached = document.createElement('div');
    detached.className = 'ai-suggestion';
    window.prManager = makePageManager({
      pierreBridge: {
        files: new Map([['a.js', {}]]),
        findAnnotationFile: () => 'a.js',
        isElementDrawn: (element) => !!element?.isConnected,
        scrollToAnnotation: vi.fn(() => false),
        whenAnnotationRendered: vi.fn(async () => null),
        findAnnotationByData: () => ({ fileName: 'a.js', annotation: { metadata: { id: 'suggestion-7' } } }),
        getAnnotationElement: () => detached,
      },
    });
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 7, file: 'a.js' }];

    await nav.goToSuggestion(0);

    expect(window.prManager.pierreBridge.whenAnnotationRendered).toHaveBeenCalledWith(
      'a.js', 'suggestion-7', expect.objectContaining({ isCancelled: expect.any(Function) }));
    expect(window.toast.showError).toHaveBeenCalledWith('Could not reveal this finding');
  });

  it('shows no error while suggestions are being redisplayed', async () => {
    // displayAISuggestions removes every card first and re-adds them when it
    // ends, so a lookup miss during a display is not an error.
    window.toast = { showError: vi.fn() };
    window.prManager = makePageManager({ suggestionManager: { _isDisplayingSuggestions: true } });
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'reloading' }];

    await nav.goToSuggestion(0);
    expect(window.toast.showError).not.toHaveBeenCalled();

    // Once the display has ended a miss is reported again.
    window.prManager.suggestionManager._isDisplayingSuggestions = false;
    await nav.goToSuggestion(0);
    expect(window.toast.showError).toHaveBeenCalledWith('Could not reveal this finding');
  });

  it('does not report a miss when another navigation took this one over', async () => {
    // A click in the review panel right after the key: the navigator's own
    // navigation stops looking for its card and says so.
    window.toast = { showError: vi.fn() };
    window.prManager = makePageManager();
    window.prManager.revealInDiff = vi.fn(async () => ({ element: null, cancelled: true }));
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'taken-over', file: 'a.js' }];

    await nav.goToSuggestion(0);
    expect(window.prManager.revealInDiff).toHaveBeenCalledTimes(1);
    expect(window.toast.showError).not.toHaveBeenCalled();
  });

  it('falls back to a generic message without a display error', async () => {
    window.toast = { showError: vi.fn() };
    window.prManager = makePageManager();
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'missing' }];

    await nav.goToSuggestion(0);

    expect(window.toast.showError).toHaveBeenCalledWith('Could not reveal this finding');
  });

  it('does not throw without a toast, and survives a failing navigation', async () => {
    window.prManager = makePageManager({
      revealInDiff: vi.fn(async () => { throw new Error('boom'); }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nav = new SuggestionNavigator();
    nav.suggestions = [{ id: 'missing', file: 'a.js' }];

    await expect(nav.goToSuggestion(0)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(nav.currentSuggestionIndex).toBe(0);
  });
});

describe('SuggestionNavigator.goToSuggestion', () => {
  /** A file wrapper in the document, collapsed or not. */
  function addWrapper(fileName, { collapsed = false } = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = `d2h-file-wrapper${collapsed ? ' collapsed' : ''}`;
    wrapper.dataset.fileName = fileName;
    document.body.appendChild(wrapper);
    return wrapper;
  }

  it('expands a collapsed file before the card is resolved and highlighted', async () => {
    const wrapper = addWrapper('a.js', { collapsed: true });
    const order = [];
    window.prManager = makePageManager({
      // A file of the diff that the reader collapsed.
      changedFilesByPath: new Map([['a.js', { file: 'a.js' }]]),
      collapsedFiles: new Set(['a.js']),
      findFileElement: vi.fn(() => wrapper),
    });
    const setCollapsed = vi.spyOn(window.prManager, 'setFileCollapsed').mockImplementation(async function (...args) {
      order.push('expand');
      return PRManager.prototype.setFileCollapsed.apply(this, args);
    });
    const nav = makeNavigator();
    nav.highlightCurrentSuggestion.mockImplementation(() => order.push('highlight'));
    nav.suggestions = [{ id: 's1', file: 'a.js' }];
    const card = addCard('s1');
    card.scrollIntoView.mockImplementation(() => order.push('scroll'));

    await nav.goToSuggestion(0);

    // Through the page's one collapse writer, to "expanded".
    expect(setCollapsed).toHaveBeenCalledWith('a.js', false);
    expect(window.prManager.isFileCollapsed('a.js')).toBe(false);
    // The file is opened strictly before the scroll and the highlight.
    expect(order).toEqual(['expand', 'scroll', 'highlight']);
  });

  it('leaves a file that is not collapsed as it is', async () => {
    const wrapper = addWrapper('a.js');
    window.prManager = makePageManager({
      changedFilesByPath: new Map([['a.js', { file: 'a.js' }]]),
      findFileElement: vi.fn(() => wrapper),
    });
    const setCollapsed = vi.spyOn(window.prManager, 'setFileCollapsed');
    const nav = makeNavigator();
    nav.suggestions = [{ id: 's1', file: 'a.js' }];
    const card = addCard('s1');

    await nav.goToSuggestion(0);

    expect(setCollapsed).not.toHaveBeenCalled();
    expect(nav.highlightCurrentSuggestion).toHaveBeenCalled();
    expect(card.scrollIntoView).toHaveBeenCalled();
  });

  it('does nothing for an out-of-range index', async () => {
    window.prManager = makePageManager({ revealInDiff: vi.fn() });
    const nav = makeNavigator();
    nav.suggestions = [{ id: 's1', file: 'a.js' }];

    await nav.goToSuggestion(5);

    expect(window.prManager.revealInDiff).not.toHaveBeenCalled();
    expect(nav.highlightCurrentSuggestion).not.toHaveBeenCalled();
  });

  it('skips file prep when the suggestion has no file', async () => {
    window.prManager = makePageManager({
      findFileElement: vi.fn(),
    });
    const setCollapsed = vi.spyOn(window.prManager, 'setFileCollapsed');
    const nav = makeNavigator();
    nav.suggestions = [{ id: 's1' }]; // no file

    await nav.goToSuggestion(0);

    expect(window.prManager.findFileElement).not.toHaveBeenCalled();
    expect(setCollapsed).not.toHaveBeenCalled();
    // Still navigates — best effort falls through to the lookup.
    expect(nav.highlightCurrentSuggestion).toHaveBeenCalled();
  });

  it('still navigates when prManager is unavailable', async () => {
    window.prManager = undefined;
    const nav = makeNavigator();
    nav.suggestions = [{ id: 's1', file: 'a.js' }];

    await nav.goToSuggestion(0);

    expect(nav.currentSuggestionIndex).toBe(0);
    expect(nav.highlightCurrentSuggestion).toHaveBeenCalled();
  });

  it('lets a newer goToSuggestion supersede an older in-flight one', async () => {
    // Each wait for a card hands back a resolver we control, so we can
    // interleave two goToSuggestion calls across their awaits.
    const first = addCard('s1');
    const second = addCard('s2');
    const { bridge, resolvers } = waitingBridge({ 'suggestion-s1': first, 'suggestion-s2': second });
    window.prManager = makePageManager({ pierreBridge: bridge });
    const nav = makeNavigator();
    const highlighted = [];
    nav.highlightCurrentSuggestion.mockImplementation(() => highlighted.push(nav.currentSuggestionIndex));
    nav.suggestions = [{ id: 's1', file: 'a.js' }, { id: 's2', file: 'b.js' }];

    const pA = nav.goToSuggestion(0); // _navGen = 1
    const pB = nav.goToSuggestion(1); // _navGen = 2
    await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0));

    // Let every wait that was started end, the OLDER call's first; that call
    // must still bail because gen moved on.
    resolvers.forEach((resolve) => resolve());
    await Promise.all([pA, pB]);

    // Only the latest call scrolls and highlights, and it sees its own
    // (latest) index.
    expect(highlighted).toEqual([1]);
    expect(nav.currentSuggestionIndex).toBe(1);
    expect(first.scrollIntoView).not.toHaveBeenCalled();
    expect(second.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected suggestion when suggestions refresh during a pending jump', async () => {
    const card = addCard('selected');
    const other = addCard('first');
    const { bridge, resolvers } = waitingBridge({ 'suggestion-selected': card, 'suggestion-first': other });
    window.prManager = makePageManager({ pierreBridge: bridge });
    const nav = makeNavigator();
    const highlighted = [];
    nav.highlightCurrentSuggestion.mockImplementation(() => highlighted.push(nav.currentSuggestionIndex));
    nav.suggestions = [{ id: 'first', file: 'a.js', line_start: 20 },
      { id: 'selected', file: 'a.js', line_start: 40 }];

    const pending = nav.goToSuggestion(1);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    // A refresh lands while the navigation waits for the card and moves the
    // selected suggestion to the front.
    nav.updateSuggestions([{ id: 'selected', file: 'a.js', line_start: 40 },
      { id: 'first', file: 'a.js', line_start: 20 }]);
    resolvers[0]();
    await pending;

    expect(nav.currentSuggestionIndex).toBe(0);
    expect(highlighted).toEqual([0]);
    // The suggestion that was asked for is the one scrolled to.
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(other.scrollIntoView).not.toHaveBeenCalled();
  });
});
