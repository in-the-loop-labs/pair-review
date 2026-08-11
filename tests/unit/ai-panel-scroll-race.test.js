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

describe('AIPanel scrollToExternalThread — virtualized threads (CodeView)', () => {
  /** A file wrapper (mounted header) with no thread row yet. */
  function makeFileWrapper(file = 'a.js') {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = file;
    document.body.appendChild(wrapper);
    return wrapper;
  }

  /** Inject a slotted external-comment row into a file wrapper. */
  function slotRow(wrapper, { threadId = '7', source = 'github' } = {}) {
    const row = document.createElement('div');
    row.className = 'external-comment-row';
    row.dataset.threadId = String(threadId);
    row.dataset.source = source;
    wrapper.appendChild(row);
    return row;
  }

  it('materializes a virtualized-out thread via bridge line-scroll, then scrolls to the row', async () => {
    const wrapper = makeFileWrapper('a.js');
    const bridge = {
      files: { has: (f) => f === 'a.js' },
      // Scrolling mounts the item and slots the annotation → the row appears.
      scrollToLine: vi.fn(() => slotRow(wrapper)),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    // Side comes from the panel's thread list (LEFT here, to prove it's used).
    inst.externalThreads = [{ id: 7, source: 'github', side: 'LEFT' }];

    await inst.scrollToExternalThread('7', 'github', 'a.js', 42);

    // Precise line-scroll with the thread's resolved side, then await the slot.
    expect(bridge.scrollToLine).toHaveBeenCalledWith('a.js', 42, 'LEFT', true);
    expect(bridge.scrollToFile).not.toHaveBeenCalled();
    expect(bridge.whenAnnotationsSlotted).toHaveBeenCalledWith('a.js', { maxFrames: 30 });
    // Then scrolled to the now-slotted row and flashed it.
    const row = wrapper.querySelector('.external-comment-row');
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(row);
    expect(row.classList.contains('external-comment-row--focused')).toBe(true);
  });

  it('does NOT bridge-scroll when the thread row is already live', async () => {
    const wrapper = makeFileWrapper('a.js');
    const row = slotRow(wrapper);
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.externalThreads = [{ id: 7, source: 'github', side: 'RIGHT' }];

    await inst.scrollToExternalThread('7', 'github', 'a.js', 42);

    expect(bridge.scrollToLine).not.toHaveBeenCalled();
    expect(bridge.scrollToFile).not.toHaveBeenCalled();
    expect(bridge.whenAnnotationsSlotted).not.toHaveBeenCalled();
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(row);
  });

  it('falls back to scrollToFile when no anchor line is known', async () => {
    const wrapper = makeFileWrapper('a.js');
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(),
      scrollToFile: vi.fn(() => slotRow(wrapper)),
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.externalThreads = [{ id: 7, source: 'github', side: 'RIGHT' }];

    await inst.scrollToExternalThread('7', 'github', 'a.js', null);

    expect(bridge.scrollToLine).not.toHaveBeenCalled();
    expect(bridge.scrollToFile).toHaveBeenCalledWith('a.js');
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(wrapper.querySelector('.external-comment-row'));
  });

  it('is a graceful no-op when the file is not a pierre file (legacy fallback)', async () => {
    // No bridge: legacy path, nothing to materialize; a missing row just no-ops.
    window.prManager = {};
    const inst = makeInstance();
    inst.externalThreads = [{ id: 7, source: 'github', side: 'RIGHT' }];

    await inst.scrollToExternalThread('7', 'github', 'a.js', 42);

    expect(inst._scrollDiffTarget).not.toHaveBeenCalled();
  });
});

describe('AIPanel nav materialize — shared helper across comment/finding paths', () => {
  function makeFileWrapper(file = 'a.js') {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = file;
    document.body.appendChild(wrapper);
    return wrapper;
  }

  it('scrollToFinding: materializes a virtualized-out finding via bridge line-scroll', async () => {
    const wrapper = makeFileWrapper('a.js');
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(() => {
        const s = document.createElement('div');
        s.className = 'ai-suggestion';
        s.dataset.suggestionId = 'F1';
        wrapper.appendChild(s);
      }),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.findings = [{ id: 'F1', side: 'RIGHT' }];

    await inst.scrollToFinding('F1', 'a.js', 42, 'RIGHT');

    expect(bridge.scrollToLine).toHaveBeenCalledWith('a.js', 42, 'RIGHT', true);
    expect(bridge.whenAnnotationsSlotted).toHaveBeenCalledWith('a.js', { maxFrames: 30 });
    const row = wrapper.querySelector('.ai-suggestion');
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(row);
    expect(row.classList.contains('current-suggestion')).toBe(true);
  });

  it('scrollToComment: materializes a virtualized-out comment via bridge line-scroll', async () => {
    const wrapper = makeFileWrapper('a.js');
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(() => {
        const row = document.createElement('div');
        row.className = 'user-comment-row';
        row.dataset.commentId = 'C1';
        row.appendChild(Object.assign(document.createElement('div'), { className: 'user-comment' }));
        wrapper.appendChild(row);
      }),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.comments = [{ id: 'C1', side: 'LEFT' }];

    await inst.scrollToComment('C1', 'a.js', 42, 'LEFT');

    expect(bridge.scrollToLine).toHaveBeenCalledWith('a.js', 42, 'LEFT', true);
    const row = wrapper.querySelector('.user-comment-row');
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(row);
    expect(row.querySelector('.user-comment').classList.contains('highlight-flash')).toBe(true);
  });

  it('scrollToComment: reveals a collapsed gap on a MOUNTED file, no bridge scroll (compose)', async () => {
    // The two mechanisms compose: ensureLinesVisible unfolds the gap and the
    // row appears WITHOUT a virtualization scroll, so the bridge is not touched.
    const wrapper = makeFileWrapper('a.js');
    const ensureLinesVisible = vi.fn(async () => {
      const row = document.createElement('div');
      row.className = 'user-comment-row';
      row.dataset.commentId = 'C1';
      row.appendChild(Object.assign(document.createElement('div'), { className: 'user-comment' }));
      wrapper.appendChild(row);
    });
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(),
    };
    window.prManager = { pierreBridge: bridge, ensureLinesVisible };

    const inst = makeInstance();
    inst.comments = [{ id: 'C1', side: 'RIGHT' }];

    await inst.scrollToComment('C1', 'a.js', 42, 'RIGHT');

    expect(ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'a.js', line_start: 42, line_end: 42, side: 'RIGHT' },
    ]);
    // Row materialized by the gap-reveal → no virtualization scroll needed.
    expect(bridge.scrollToLine).not.toHaveBeenCalled();
    expect(bridge.scrollToFile).not.toHaveBeenCalled();
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(wrapper.querySelector('.user-comment-row'));
  });

  it('onFindingClick (user comment): materializes despite the panel mirroring the comment id (F2 regression)', async () => {
    // The AI-panel finding-item and its quick-action-chat button carry the
    // comment id (data-comment-id). If the row lookup isn't scoped to the diff
    // view, it matches that PANEL button, the materialize gate sees a false
    // "row already live", and the virtualized-out file never mounts — the exact
    // divergence where a DIRECT scrollToComment worked but the click didn't.
    const diffContainer = document.createElement('div');
    diffContainer.id = 'diff-container';
    document.body.appendChild(diffContainer);
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = 'a.js';
    diffContainer.appendChild(wrapper);

    // Panel list item + chat button mirror the comment id, OUTSIDE #diff-container.
    const findingsList = document.createElement('div');
    const panelChatBtn = document.createElement('button');
    panelChatBtn.className = 'quick-action-chat';
    panelChatBtn.dataset.commentId = 'C1';
    findingsList.appendChild(panelChatBtn);
    document.body.appendChild(findingsList);

    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(() => {
        const row = document.createElement('div');
        row.className = 'user-comment-row';
        row.dataset.commentId = 'C1';
        row.appendChild(Object.assign(document.createElement('div'), { className: 'user-comment' }));
        wrapper.appendChild(row); // slots into the diff container
      }),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.comments = [{ id: 'C1', file: 'a.js', line_start: 3, side: 'RIGHT' }];
    inst.findingsList = findingsList;
    inst.getFilteredItems = () => [];
    inst.getItemKey = () => '';
    inst.updateNavigationCounter = () => {};

    const item = document.createElement('button');
    item.className = 'finding-item';
    Object.assign(item.dataset, { id: 'C1', itemType: 'comment', file: 'a.js', line: '3', index: '0' });

    // Capture the async nav the (fire-and-forget) click starts, to await it.
    const origScroll = inst.scrollToComment.bind(inst);
    let navP;
    inst.scrollToComment = (...a) => { navP = origScroll(...a); return navP; };

    inst.onFindingClick(item);
    await navP;

    // The panel's mirrored data-comment-id must NOT block materialize.
    expect(bridge.scrollToLine).toHaveBeenCalledWith('a.js', 3, 'RIGHT', true);
    const row = diffContainer.querySelector('.user-comment-row');
    expect(row).not.toBeNull();
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(row);
  });

  it('scrollToComment (file-level): materializes via scrollToFile (no line anchor)', async () => {
    const wrapper = makeFileWrapper('a.js');
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(),
      scrollToFile: vi.fn(() => {
        const zone = document.createElement('div');
        zone.className = 'file-comments-zone';
        const card = document.createElement('div');
        card.className = 'file-comment-card';
        card.dataset.commentId = 'C1';
        zone.appendChild(card);
        wrapper.appendChild(zone);
      }),
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.comments = [{ id: 'C1', side: 'RIGHT', is_file_level: 1 }];

    await inst.scrollToComment('C1', 'a.js', null, 'RIGHT');

    // File-level → no line, so a file-scroll mounts the header/zone.
    expect(bridge.scrollToLine).not.toHaveBeenCalled();
    expect(bridge.scrollToFile).toHaveBeenCalledWith('a.js');
    const card = wrapper.querySelector('.file-comment-card');
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(card);
  });
});
