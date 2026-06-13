// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Regression test for the AIPanel scroll-to navigation race.
 *
 * The three scroll methods (scrollToFinding / scrollToComment /
 * scrollToExternalThread) are async and await the target file's lazy body
 * render before scrolling. handleItemClick fires them and-forgets, so two
 * can be in flight at once. If the user moves to a NEWER item while an OLDER
 * call is still awaiting a slow render, the older call must NOT scroll when
 * its await finally resolves — otherwise it snaps the viewport back to the
 * stale target. A monotonic `_navGen` token (bumped at the top of each
 * method, re-checked before doScroll) enforces latest-wins at the consumer.
 *
 * We bypass AIPanel's heavy DOM constructor with Object.create and set
 * `_navGen = 0` to mirror what the real constructor does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { AIPanel } = require('../../public/js/components/AIPanel.js');

/** Create a deferred promise we can resolve on demand. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function makeInstance() {
  const inst = Object.create(AIPanel.prototype);
  // Mirror the real constructor: latest-wins token starts at 0 so the first
  // ++this._navGen yields 1 (not NaN from ++undefined).
  inst._navGen = 0;
  inst.expandFileIfCollapsed = vi.fn(() => undefined);
  inst._scrollDiffTarget = vi.fn();
  inst.comments = [];
  return inst;
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.prManager = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.prManager;
});

describe('AIPanel scroll-to latest-wins race', () => {
  it('scrollToFinding: an older call bails after a newer call supersedes it', async () => {
    const oldGate = deferred();
    const newGate = deferred();
    let firstCall = true;
    window.prManager = {
      ensureFileBodyRendered: vi.fn(() => {
        const gate = firstCall ? oldGate : newGate;
        firstCall = false;
        return gate.promise;
      })
    };

    const inst = makeInstance();

    const findingA = document.createElement('div');
    findingA.className = 'ai-suggestion';
    findingA.setAttribute('data-suggestion-id', 'A');
    const findingB = document.createElement('div');
    findingB.className = 'ai-suggestion';
    findingB.setAttribute('data-suggestion-id', 'B');
    document.body.append(findingA, findingB);

    // Older call starts and parks on its pending render.
    const olderP = inst.scrollToFinding('A', 'a.js', null);
    // Newer call starts, bumps _navGen, parks on its own render.
    const newerP = inst.scrollToFinding('B', 'b.js', null);

    // Resolve the OLDER render LAST-ish: first let it through.
    oldGate.resolve();
    await olderP;
    // Older call must have bailed — no scroll.
    expect(inst._scrollDiffTarget).not.toHaveBeenCalled();

    // Now let the newer call finish — it owns the scroll.
    newGate.resolve();
    await newerP;
    expect(inst._scrollDiffTarget).toHaveBeenCalledTimes(1);
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(findingB);
  });

  it('scrollToComment: an older call bails after a newer call supersedes it', async () => {
    const oldGate = deferred();
    const newGate = deferred();
    let firstCall = true;
    window.prManager = {
      ensureFileBodyRendered: vi.fn(() => {
        const gate = firstCall ? oldGate : newGate;
        firstCall = false;
        return gate.promise;
      })
    };

    const inst = makeInstance();

    const rowA = document.createElement('div');
    rowA.className = 'user-comment-row';
    rowA.setAttribute('data-comment-id', 'A');
    rowA.appendChild(Object.assign(document.createElement('div'), { className: 'user-comment' }));
    const rowB = document.createElement('div');
    rowB.className = 'user-comment-row';
    rowB.setAttribute('data-comment-id', 'B');
    rowB.appendChild(Object.assign(document.createElement('div'), { className: 'user-comment' }));
    document.body.append(rowA, rowB);

    const olderP = inst.scrollToComment('A', 'a.js', null);
    const newerP = inst.scrollToComment('B', 'b.js', null);

    oldGate.resolve();
    await olderP;
    expect(inst._scrollDiffTarget).not.toHaveBeenCalled();

    newGate.resolve();
    await newerP;
    expect(inst._scrollDiffTarget).toHaveBeenCalledTimes(1);
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(rowB);
  });

  it('scrollToExternalThread: an older call bails after a newer call supersedes it', async () => {
    const oldGate = deferred();
    const newGate = deferred();
    let firstCall = true;
    window.prManager = {
      ensureFileBodyRendered: vi.fn(() => {
        const gate = firstCall ? oldGate : newGate;
        firstCall = false;
        return gate.promise;
      })
    };

    const inst = makeInstance();

    const rowA = document.createElement('div');
    rowA.className = 'external-comment-row';
    rowA.setAttribute('data-thread-id', 'A');
    rowA.setAttribute('data-source', 'github');
    const rowB = document.createElement('div');
    rowB.className = 'external-comment-row';
    rowB.setAttribute('data-thread-id', 'B');
    rowB.setAttribute('data-source', 'github');
    document.body.append(rowA, rowB);

    const olderP = inst.scrollToExternalThread('A', 'github', 'a.js', null);
    const newerP = inst.scrollToExternalThread('B', 'github', 'b.js', null);

    oldGate.resolve();
    await olderP;
    expect(inst._scrollDiffTarget).not.toHaveBeenCalled();

    newGate.resolve();
    await newerP;
    expect(inst._scrollDiffTarget).toHaveBeenCalledTimes(1);
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(rowB);
  });

  it('single scrollToFinding call still scrolls (no false bail with _navGen = 0)', async () => {
    // With _navGen initialized to 0 (as the constructor does), a lone call
    // bumps it to 1 and 1 === 1, so it must NOT bail. This guards against the
    // ++undefined -> NaN bug, where NaN !== NaN would wrongly skip the scroll.
    window.prManager = {
      ensureFileBodyRendered: vi.fn(() => Promise.resolve())
    };
    const inst = makeInstance();

    const finding = document.createElement('div');
    finding.className = 'ai-suggestion';
    finding.setAttribute('data-suggestion-id', 'F1');
    document.body.appendChild(finding);

    await inst.scrollToFinding('F1', 'a.js', null);

    expect(inst._scrollDiffTarget).toHaveBeenCalledTimes(1);
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(finding);
  });
});
