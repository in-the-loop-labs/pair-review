// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for CommentMinimizer against the @pierre/diffs DOM.
 *
 * Under @pierre/diffs, diff lines are shadow-DOM elements and annotation cards
 * live in the LIGHT DOM, each wrapped by the vendor in a
 * `<div data-annotation-slot slot="annotation-{side}-{lineNumber}">` that is a
 * child of the file's `<diffs-container>` host. Cards on the same line+side
 * share a slot value; the minimizer groups by `{fileName}\0{slot}`.
 *
 * These tests build that real structure in jsdom and import the actual
 * CommentMinimizer class (never duplicating production code). They cover:
 * - grouping/aggregation counts and per-type icons (user/adopted/AI/external)
 * - suggestions hidden for adoption are not double-counted
 * - per-file scoping (same slot name in two files → two independent lines)
 * - toggle expand/collapse by clicking the indicator
 * - expandForElement (line-level and file-level)
 * - stable-key expansion surviving a simulated vendor rerender
 * - minimize-off cleanup
 * - file-level indicators (unchanged path)
 * - findDiffRowFor contract
 * - the mutation-driven re-injection debounce
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { CommentMinimizer } = require('../../public/js/modules/comment-minimizer.js');

// ---------------------------------------------------------------------------
// DOM builders — mirror the real light-DOM structure the vendor produces.
// ---------------------------------------------------------------------------

/** Create (or reuse) the #diff-container root. */
function diffContainer() {
  let el = document.getElementById('diff-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'diff-container';
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Create a `.d2h-file-wrapper` with a `<diffs-container>` host and (optionally)
 * a file header + file-comments-zone, appended to #diff-container.
 * @returns {{wrapper: Element, host: Element, header: Element, zone: Element}}
 */
function makeFile(fileName, { withZone = false } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'd2h-file-wrapper';
  wrapper.dataset.fileName = fileName;

  const header = document.createElement('div');
  header.className = 'd2h-file-header';
  const commentBtn = document.createElement('button');
  commentBtn.className = 'file-header-comment-btn';
  header.appendChild(commentBtn);
  wrapper.appendChild(header);

  let zone = null;
  if (withZone) {
    zone = document.createElement('div');
    zone.className = 'file-comments-zone';
    zone.dataset.fileName = fileName;
    wrapper.appendChild(zone);
  }

  const host = document.createElement('diffs-container');
  // Attach a shadow root so the structure matches production, even though the
  // minimizer only reads the light DOM.
  host.attachShadow({ mode: 'open' });
  wrapper.appendChild(host);

  diffContainer().appendChild(wrapper);
  return { wrapper, host, header, zone };
}

/**
 * Slot an annotation card into a host, wrapped in the vendor
 * `[data-annotation-slot]` div (as @pierre/diffs does).
 * @param {Element} host - the <diffs-container>
 * @param {string} side - 'additions' | 'deletions'
 * @param {number} lineNumber
 * @param {Element} card - the annotation card element
 * @returns {Element} the vendor wrapper
 */
function slotCard(host, side, lineNumber, card) {
  const wrapper = document.createElement('div');
  wrapper.dataset.annotationSlot = '';
  wrapper.setAttribute('slot', `annotation-${side}-${lineNumber}`);
  wrapper.appendChild(card);
  host.appendChild(wrapper);
  return wrapper;
}

function userCommentCard({ adopted = false } = {}) {
  const card = document.createElement('div');
  card.className = 'user-comment-row';
  card.dataset.commentId = String(Math.floor(Math.random() * 1e6));
  const inner = document.createElement('div');
  inner.className = adopted ? 'user-comment adopted-comment comment-ai-origin' : 'user-comment comment-user-origin';
  inner.textContent = 'a comment';
  card.appendChild(inner);
  return card;
}

// `hiddenForAdoption` mirrors the real string dataset: undefined (load-time,
// visible), 'true' (adopted → hidden), or 'false' (runtime-restored → visible,
// written literally by suggestion-ui.js).
function suggestionCard({ hiddenForAdoption } = {}) {
  const card = document.createElement('div');
  card.className = 'ai-suggestion ai-type-bug';
  card.dataset.suggestionId = String(Math.floor(Math.random() * 1e6));
  if (hiddenForAdoption !== undefined) card.dataset.hiddenForAdoption = String(hiddenForAdoption);
  card.textContent = 'a suggestion';
  return card;
}

function externalCard({ bubbles = 1 } = {}) {
  const card = document.createElement('div');
  card.className = 'external-comment-row';
  card.dataset.threadId = String(Math.floor(Math.random() * 1e6));
  const thread = document.createElement('div');
  thread.className = 'external-comment-thread';
  for (let i = 0; i < bubbles; i++) {
    const bubble = document.createElement('div');
    bubble.className = 'external-comment';
    thread.appendChild(bubble);
  }
  card.appendChild(thread);
  return card;
}

/** Add a file-level card to a zone. */
function fileCommentCard(zone, type, { adopted = false, collapsed = false } = {}) {
  const card = document.createElement('div');
  card.className = 'file-comment-card ' + type;
  if (adopted) card.classList.add('adopted-comment');
  if (collapsed) card.classList.add('collapsed');
  zone.appendChild(card);
  return card;
}

/** All line-level indicators currently in the DOM. */
function lineIndicators() {
  return [...document.querySelectorAll('#diff-container .comment-indicator')];
}

// The real MutationObserver would fire async refreshes that leak across tests
// (a prior test's minimizer mutating a later test's DOM). Stub it to a no-op —
// the debounce/scheduling logic is covered directly via _onDomMutation below.
let RealMutationObserver;
beforeEach(() => {
  document.body.innerHTML = '';
  window.prManager = undefined;
  RealMutationObserver = global.MutationObserver;
  global.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
  window.MutationObserver = global.MutationObserver;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  global.MutationObserver = RealMutationObserver;
  window.MutationObserver = RealMutationObserver;
});

// ===========================================================================
// Line-level grouping / aggregation
// ===========================================================================

describe('CommentMinimizer — line-level grouping', () => {
  it('injects one indicator per line with a person icon for a user comment', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const indicators = lineIndicators();
    expect(indicators).toHaveLength(1);
    const btn = indicators[0];
    expect(btn.innerHTML).toContain('indicator-user');
    expect(btn.innerHTML).not.toContain('indicator-ai');
    expect(btn.title).toBe('1 comment');
  });

  it('uses the adopted icon for an adopted comment card', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard({ adopted: true }));

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const btn = lineIndicators()[0];
    expect(btn.innerHTML).toContain('indicator-adopted');
    expect(btn.innerHTML).not.toContain('indicator-user');
    expect(btn.title).toBe('1 adopted comment');
  });

  it('uses the sparkles icon for an AI suggestion card', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, suggestionCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const btn = lineIndicators()[0];
    expect(btn.innerHTML).toContain('indicator-ai');
    expect(btn.title).toBe('1 suggestion');
  });

  it('does not count a suggestion hidden for adoption', () => {
    const { host } = makeFile('a.js');
    // Adopted comment + its now-hidden originating suggestion, same line.
    slotCard(host, 'additions', 10, suggestionCard({ hiddenForAdoption: true }));
    slotCard(host, 'additions', 10, userCommentCard({ adopted: true }));

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const btn = lineIndicators()[0];
    expect(btn.innerHTML).toContain('indicator-adopted');
    expect(btn.innerHTML).not.toContain('indicator-ai');
    expect(btn.title).toBe('1 adopted comment');
  });

  it('counts a runtime-restored suggestion whose flag is the string "false"', () => {
    // Regression: `!dataset.hiddenForAdoption` treated the literal 'false'
    // string as truthy and dropped a restored suggestion from the count.
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, suggestionCard({ hiddenForAdoption: 'false' }));

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const btn = lineIndicators()[0];
    expect(btn.innerHTML).toContain('indicator-ai');
    expect(btn.title).toBe('1 suggestion');
  });

  it('injects no indicator when a line\'s only card is hidden for adoption', () => {
    // The suggestion is represented by its adopted comment elsewhere; with no
    // other card on the line the group has zero counts and must not produce an
    // empty (icon-less, title-less) button.
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, suggestionCard({ hiddenForAdoption: 'true' }));

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    expect(lineIndicators()).toHaveLength(0);
  });

  it('uses the external chat icon and counts thread bubbles', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'deletions', 4, externalCard({ bubbles: 3 }));

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const btn = lineIndicators()[0];
    expect(btn.innerHTML).toContain('indicator-external');
    expect(btn.innerHTML).toContain('<span class="indicator-count">3</span>');
    expect(btn.title).toBe('3 external comments');
  });

  it('aggregates mixed card types on the same line into one indicator', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard());
    slotCard(host, 'additions', 10, userCommentCard({ adopted: true }));
    slotCard(host, 'additions', 10, suggestionCard());
    slotCard(host, 'additions', 10, externalCard({ bubbles: 1 }));

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const indicators = lineIndicators();
    expect(indicators).toHaveLength(1);
    const btn = indicators[0];
    expect(btn.innerHTML).toContain('indicator-user');
    expect(btn.innerHTML).toContain('indicator-adopted');
    expect(btn.innerHTML).toContain('indicator-ai');
    expect(btn.innerHTML).toContain('indicator-external');
    // 1 user + 1 adopted + 1 AI + 1 external = 4
    expect(btn.innerHTML).toContain('<span class="indicator-count">4</span>');
    expect(btn.title).toBe('1 comment, 1 adopted comment, 1 suggestion, 1 external comment');
  });

  it('separates cards on different lines and different sides', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard());
    slotCard(host, 'additions', 20, suggestionCard());
    slotCard(host, 'deletions', 10, externalCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    // Three distinct line+side groups → three indicators.
    expect(lineIndicators()).toHaveLength(3);
  });

  it('scopes grouping per file so identical slot names do not merge', () => {
    const a = makeFile('a.js');
    const b = makeFile('b.js');
    slotCard(a.host, 'additions', 10, userCommentCard());
    slotCard(b.host, 'additions', 10, suggestionCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    // Same slot string "annotation-additions-10" but different files.
    expect(lineIndicators()).toHaveLength(2);
  });

  it('ignores comment forms / tour stops (non-minimized annotations)', () => {
    const { host } = makeFile('a.js');
    const form = document.createElement('div');
    form.className = 'user-comment-form';
    slotCard(host, 'additions', 10, form);

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    expect(lineIndicators()).toHaveLength(0);
  });
});

// ===========================================================================
// Toggle expand / collapse
// ===========================================================================

describe('CommentMinimizer — expand/collapse', () => {
  it('shows and hides a line group when the indicator is clicked', () => {
    const { host } = makeFile('a.js');
    const w1 = slotCard(host, 'additions', 10, userCommentCard());
    const w2 = slotCard(host, 'additions', 10, suggestionCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const card1 = w1.firstElementChild;
    const card2 = w2.firstElementChild;
    expect(card1.classList.contains('comment-expanded')).toBe(false);

    const btn = lineIndicators()[0];
    btn.click();
    expect(btn.classList.contains('expanded')).toBe(true);
    expect(card1.classList.contains('comment-expanded')).toBe(true);
    expect(card2.classList.contains('comment-expanded')).toBe(true);

    btn.click();
    expect(btn.classList.contains('expanded')).toBe(false);
    expect(card1.classList.contains('comment-expanded')).toBe(false);
    expect(card2.classList.contains('comment-expanded')).toBe(false);
  });

  it('tracks expanded lines independently', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard());
    slotCard(host, 'additions', 20, userCommentCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const [b1, b2] = lineIndicators();
    b1.click();
    expect(cm._expandedLines.size).toBe(1);
    b2.click();
    expect(cm._expandedLines.size).toBe(2);
    b1.click();
    expect(cm._expandedLines.size).toBe(1);
  });
});

// ===========================================================================
// Stable-key expansion survives a vendor rerender
// ===========================================================================

describe('CommentMinimizer — rerender resilience', () => {
  it('re-applies expansion after the vendor recreates the cards', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    // User expands the line.
    lineIndicators()[0].click();
    expect(cm._expandedLines.size).toBe(1);

    // Simulate a vendor rerender: every [data-annotation-slot] wrapper (and its
    // card + our injected indicator) is destroyed and rebuilt fresh — no
    // .comment-expanded, no indicator. Element identity does NOT survive.
    host.innerHTML = '';
    const rebuilt = slotCard(host, 'additions', 10, userCommentCard());
    expect(rebuilt.firstElementChild.classList.contains('comment-expanded')).toBe(false);

    // The minimizer's stable string key survives, so a refresh restores state.
    cm.refreshIndicators();

    const btn = lineIndicators()[0];
    expect(btn.classList.contains('expanded')).toBe(true);
    expect(rebuilt.firstElementChild.classList.contains('comment-expanded')).toBe(true);
  });

  it('does not duplicate indicators across refreshes', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);
    cm.refreshIndicators();
    cm.refreshIndicators();

    expect(lineIndicators()).toHaveLength(1);
  });
});

// ===========================================================================
// findDiffRowFor
// ===========================================================================

describe('CommentMinimizer — findDiffRowFor', () => {
  it('returns the vendor annotation wrapper for a slotted card', () => {
    const { host } = makeFile('a.js');
    const card = userCommentCard();
    const wrapper = slotCard(host, 'additions', 10, card);

    const cm = new CommentMinimizer();
    expect(cm.findDiffRowFor(card)).toBe(wrapper);
    // Also from a descendant of the card.
    expect(cm.findDiffRowFor(card.firstElementChild)).toBe(wrapper);
  });

  it('returns null for an element not slotted onto a diff line', () => {
    const loose = document.createElement('div');
    document.body.appendChild(loose);

    const cm = new CommentMinimizer();
    expect(cm.findDiffRowFor(loose)).toBeNull();
  });
});

// ===========================================================================
// expandForElement
// ===========================================================================

describe('CommentMinimizer — expandForElement', () => {
  it('expands the whole line group for a line-level card', () => {
    const { host } = makeFile('a.js');
    const w1 = slotCard(host, 'additions', 10, userCommentCard());
    const w2 = slotCard(host, 'additions', 10, suggestionCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    cm.expandForElement(w2.firstElementChild);

    expect(cm._expandedLines.size).toBe(1);
    expect(w1.firstElementChild.classList.contains('comment-expanded')).toBe(true);
    expect(w2.firstElementChild.classList.contains('comment-expanded')).toBe(true);
    expect(lineIndicators()[0].classList.contains('expanded')).toBe(true);
  });

  it('is a no-op when not active', () => {
    const { host } = makeFile('a.js');
    const card = userCommentCard();
    slotCard(host, 'additions', 10, card);

    const cm = new CommentMinimizer();
    cm.expandForElement(card);

    expect(cm._expandedLines.size).toBe(0);
    expect(card.classList.contains('comment-expanded')).toBe(false);
  });

  it('is a no-op for an element with no annotation wrapper', () => {
    const loose = document.createElement('div');
    const cm = new CommentMinimizer();
    cm._active = true;
    cm.expandForElement(loose);
    expect(cm._expandedLines.size).toBe(0);
  });

  it('expands a file-comments-zone for a file-level element', () => {
    const { zone } = makeFile('a.js', { withZone: true });
    const card = fileCommentCard(zone, 'user-comment');

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    cm.expandForElement(card);
    expect(cm._expandedFiles.has(zone)).toBe(true);
    expect(zone.classList.contains('file-comments-expanded')).toBe(true);
    // File-header indicator is marked expanded.
    const indicator = document.querySelector('.d2h-file-header .file-comment-indicator');
    expect(indicator.classList.contains('expanded')).toBe(true);
  });
});

// ===========================================================================
// setMinimized cleanup
// ===========================================================================

describe('CommentMinimizer — setMinimized', () => {
  it('adds the container class and injects indicators when enabled', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    expect(cm.active).toBe(true);
    expect(diffContainer().classList.contains('comments-minimized')).toBe(true);
    expect(lineIndicators()).toHaveLength(1);
  });

  it('removes the class, indicators and expansion overrides when disabled', () => {
    const { host } = makeFile('a.js');
    const w = slotCard(host, 'additions', 10, userCommentCard());

    const cm = new CommentMinimizer();
    cm.setMinimized(true);
    lineIndicators()[0].click();
    expect(w.firstElementChild.classList.contains('comment-expanded')).toBe(true);

    cm.setMinimized(false);

    expect(cm.active).toBe(false);
    expect(diffContainer().classList.contains('comments-minimized')).toBe(false);
    expect(lineIndicators()).toHaveLength(0);
    expect(w.firstElementChild.classList.contains('comment-expanded')).toBe(false);
    expect(cm._expandedLines.size).toBe(0);
  });
});

// ===========================================================================
// File-level indicators (unchanged path)
// ===========================================================================

describe('CommentMinimizer — file-level indicators', () => {
  function fileIndicator() {
    return document.querySelector('.d2h-file-header .file-comment-indicator');
  }

  it('injects a file-header indicator for a zone with user comments', () => {
    const { zone } = makeFile('a.js', { withZone: true });
    fileCommentCard(zone, 'user-comment');

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const btn = fileIndicator();
    expect(btn).toBeTruthy();
    expect(btn.innerHTML).toContain('indicator-user');
    expect(btn.title).toBe('1 file comment');
  });

  it('shows combined counts and skips collapsed cards', () => {
    const { zone } = makeFile('a.js', { withZone: true });
    fileCommentCard(zone, 'ai-suggestion', { collapsed: true }); // ignored
    fileCommentCard(zone, 'user-comment', { adopted: true });
    fileCommentCard(zone, 'ai-suggestion');
    fileCommentCard(zone, 'user-comment');

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const btn = fileIndicator();
    expect(btn.innerHTML).toContain('indicator-user');
    expect(btn.innerHTML).toContain('indicator-adopted');
    expect(btn.innerHTML).toContain('indicator-ai');
    // 1 user + 1 adopted + 1 AI = 3 (collapsed AI not counted)
    expect(btn.innerHTML).toContain('<span class="indicator-count">3</span>');
  });

  it('inserts the indicator before the file-header comment button', () => {
    const { zone, header } = makeFile('a.js', { withZone: true });
    fileCommentCard(zone, 'user-comment');

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const kids = [...header.children];
    const indicatorIdx = kids.findIndex(c => c.classList.contains('file-comment-indicator'));
    const btnIdx = kids.findIndex(c => c.classList.contains('file-header-comment-btn'));
    expect(indicatorIdx).toBeGreaterThanOrEqual(0);
    expect(indicatorIdx).toBeLessThan(btnIdx);
  });

  it('toggles file comments when the indicator is clicked', () => {
    const { zone } = makeFile('a.js', { withZone: true });
    fileCommentCard(zone, 'user-comment');

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    const btn = fileIndicator();
    btn.click();
    expect(cm._expandedFiles.has(zone)).toBe(true);
    expect(zone.classList.contains('file-comments-expanded')).toBe(true);
    btn.click();
    expect(cm._expandedFiles.has(zone)).toBe(false);
    expect(zone.classList.contains('file-comments-expanded')).toBe(false);
  });

  it('does not inject an indicator for an empty zone', () => {
    makeFile('a.js', { withZone: true });

    const cm = new CommentMinimizer();
    cm.setMinimized(true);

    expect(fileIndicator()).toBeNull();
  });

  it('clears file-level expansion state and indicators when disabled', () => {
    const { zone } = makeFile('a.js', { withZone: true });
    fileCommentCard(zone, 'user-comment');

    const cm = new CommentMinimizer();
    cm.setMinimized(true);
    fileIndicator().click();
    expect(cm._expandedFiles.size).toBe(1);
    expect(zone.classList.contains('file-comments-expanded')).toBe(true);

    cm.setMinimized(false);

    expect(cm._expandedFiles.size).toBe(0);
    expect(document.querySelector('.file-comments-expanded')).toBeNull();
    expect(document.querySelector('.file-comment-indicator')).toBeNull();
  });
});

// ===========================================================================
// Mutation-driven re-injection
// ===========================================================================

describe('CommentMinimizer — mutation observer', () => {
  it('debounces a refresh in response to DOM mutations', () => {
    const { host } = makeFile('a.js');
    slotCard(host, 'additions', 10, userCommentCard());

    const cm = new CommentMinimizer();
    cm._active = true;
    const refreshSpy = vi.spyOn(cm, 'refreshIndicators');

    // Stub rAF so we control when the debounced refresh runs.
    let queued = null;
    const rafStub = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      queued = fn;
      return 1;
    });

    // Two mutations before the frame fires → one scheduled refresh.
    cm._onDomMutation();
    cm._onDomMutation();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(rafStub).toHaveBeenCalledTimes(1);

    queued();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // After the frame, a new mutation schedules again.
    cm._onDomMutation();
    expect(rafStub).toHaveBeenCalledTimes(2);
  });

  it('does not schedule when inactive', () => {
    const cm = new CommentMinimizer();
    cm._active = false;
    const rafStub = vi.spyOn(window, 'requestAnimationFrame');
    cm._onDomMutation();
    expect(rafStub).not.toHaveBeenCalled();
  });

  it('_startObserving watches #diff-container and routes the callback to _onDomMutation', () => {
    makeFile('a.js');

    // A controlled MutationObserver that captures the constructor callback and
    // observe() arguments (the beforeEach no-op stub can't assert either).
    let capturedCb;
    let observeArgs;
    const prev = global.MutationObserver;
    global.MutationObserver = class {
      constructor(cb) { capturedCb = cb; }
      observe(target, opts) { observeArgs = { target, opts }; }
      disconnect() {}
    };
    window.MutationObserver = global.MutationObserver;

    try {
      const cm = new CommentMinimizer();
      cm._active = true;
      const onMutation = vi.spyOn(cm, '_onDomMutation').mockImplementation(() => {});

      cm._startObserving();

      expect(observeArgs.target).toBe(document.getElementById('diff-container'));
      expect(observeArgs.opts).toEqual({ childList: true, subtree: true });

      // The constructor callback must reach _onDomMutation with `this` intact —
      // guards against a refactor to a bare `this._onDomMutation` method ref.
      capturedCb([], {});
      expect(onMutation).toHaveBeenCalledTimes(1);
    } finally {
      global.MutationObserver = prev;
      window.MutationObserver = prev;
    }
  });
});
