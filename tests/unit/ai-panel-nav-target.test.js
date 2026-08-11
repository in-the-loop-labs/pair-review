// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Tests for AIPanel's shared nav-target helper `_ensureNavTargetRendered`.
 *
 * Three behaviours are pinned here:
 *
 *  1. The expand/render PREAMBLE lives in the helper, not triplicated across
 *     scrollToFinding / scrollToComment / scrollToExternalThread — so all three
 *     entry points expand the file and await its lazy body exactly once, and a
 *     new entry point can't forget to.
 *  2. The helper POLLS for the target row after materializing. The bridge's
 *     `whenAnnotationsSlotted` answers "is the FILE item mounted", which is
 *     already true for a mounted file whose target LINE is outside CodeView's
 *     render window; the smooth scroll mounts that row several frames later.
 *     Checking once and returning silently loses the navigation.
 *  3. The materialize gate for external threads is STRICT: an unrelated
 *     external row mounted in the same file must not read as "the target is
 *     already live", or the real target never mounts and the wrong thread is
 *     scrolled to and focused.
 *
 * As elsewhere in the AIPanel suite we bypass the heavy DOM constructor with
 * Object.create and drive the real methods. Frame waits go through the
 * `AIPanel._nextFrame` seam so the poll is stepped deterministically (no fixed
 * sleeps); one test additionally exercises the real requestAnimationFrame path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { AIPanel } = require('../../public/js/components/AIPanel.js');

function makeInstance() {
  const inst = Object.create(AIPanel.prototype);
  // Mirror the real constructor: latest-wins token starts at 0.
  inst._navGen = 0;
  inst.expandFileIfCollapsed = vi.fn(() => undefined);
  inst._scrollDiffTarget = vi.fn();
  inst.findings = [];
  inst.comments = [];
  inst.externalThreads = [];
  return inst;
}

/** A mounted file host with no annotation rows in it yet. */
function makeFileWrapper(file = 'a.js') {
  const wrapper = document.createElement('div');
  wrapper.className = 'd2h-file-wrapper';
  wrapper.dataset.fileName = file;
  document.body.appendChild(wrapper);
  return wrapper;
}

function makeExternalRow(wrapper, { threadId, source = 'github' } = {}) {
  const row = document.createElement('div');
  row.className = 'external-comment-row';
  if (threadId !== undefined) row.dataset.threadId = String(threadId);
  if (source !== undefined) row.dataset.source = source;
  wrapper.appendChild(row);
  return row;
}

function makeCommentRow(wrapper, commentId) {
  const row = document.createElement('div');
  row.className = 'user-comment-row';
  row.dataset.commentId = String(commentId);
  row.appendChild(Object.assign(document.createElement('div'), { className: 'user-comment' }));
  wrapper.appendChild(row);
  return row;
}

/**
 * Replace the frame-wait seam with an immediate resolve, optionally running a
 * side effect on the Nth wait (simulating "the smooth scroll finally mounted
 * the row"). Returns the spy so tests can count polled frames.
 */
function stubFrames(onFrame) {
  let frames = 0;
  return vi.spyOn(AIPanel, '_nextFrame').mockImplementation(() => {
    frames += 1;
    if (onFrame) onFrame(frames);
    return Promise.resolve();
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.prManager = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.prManager;
});

describe('AIPanel._ensureNavTargetRendered — shared expand/render preamble', () => {
  it.each([
    ['scrollToFinding', (inst) => inst.scrollToFinding('F1', 'a.js', 42, 'RIGHT')],
    ['scrollToComment', (inst) => inst.scrollToComment('C1', 'a.js', 42, 'RIGHT')],
    ['scrollToExternalThread', (inst) => inst.scrollToExternalThread('7', 'github', 'a.js', 42)],
  ])('%s expands the file and awaits its lazy body before looking up the row', async (_name, run) => {
    const order = [];
    const inst = makeInstance();
    // A thenable expansion must be awaited, not fire-and-forgotten.
    inst.expandFileIfCollapsed = vi.fn(() => {
      order.push('expand:start');
      return Promise.resolve().then(() => order.push('expand:done'));
    });
    inst._scrollDiffTarget = vi.fn(() => order.push('scroll'));
    window.prManager = {
      ensureFileBodyRendered: vi.fn(async (f) => {
        order.push(`render:${f}`);
        // The row only exists once the lazy body has rendered.
        const wrapper = makeFileWrapper('a.js');
        const finding = document.createElement('div');
        finding.className = 'ai-suggestion';
        finding.dataset.suggestionId = 'F1';
        wrapper.appendChild(finding);
        makeCommentRow(wrapper, 'C1');
        makeExternalRow(wrapper, { threadId: '7' });
      }),
    };

    await run(inst);

    expect(inst.expandFileIfCollapsed).toHaveBeenCalledTimes(1);
    expect(inst.expandFileIfCollapsed).toHaveBeenCalledWith('a.js');
    expect(window.prManager.ensureFileBodyRendered).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['expand:start', 'expand:done', 'render:a.js', 'scroll']);
  });

  it('is a no-op preamble when no file is known (nothing to expand or render)', async () => {
    const inst = makeInstance();
    window.prManager = { ensureFileBodyRendered: vi.fn() };

    const finding = document.createElement('div');
    finding.className = 'ai-suggestion';
    finding.dataset.suggestionId = 'F1';
    document.body.appendChild(finding);

    await inst.scrollToFinding('F1', null, null);

    expect(window.prManager.ensureFileBodyRendered).not.toHaveBeenCalled();
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(finding);
  });
});

describe('AIPanel._ensureNavTargetRendered — polls for the row after materializing', () => {
  /**
   * The regression: the file item is MOUNTED (so whenAnnotationsSlotted resolves
   * immediately) but the target LINE is outside the mounted line window. The
   * smooth scroll mounts that row several frames later.
   */
  function mountedFileWithLateRow(appendRow) {
    const wrapper = makeFileWrapper('a.js');
    const bridge = {
      files: { has: (f) => f === 'a.js' },
      scrollToLine: vi.fn(),
      scrollToFile: vi.fn(),
      // Resolves at once: the FILE is mounted. It says nothing about the LINE.
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };
    return { wrapper, bridge, appendRow };
  }

  it('lands on a comment row that mounts several frames after the slot signal', async () => {
    const { wrapper, bridge } = mountedFileWithLateRow();
    let row = null;
    const frameSpy = stubFrames((n) => {
      // Row mounts on the 3rd frame of the smooth scroll.
      if (n === 3) row = makeCommentRow(wrapper, 'C1');
    });

    const inst = makeInstance();
    inst.comments = [{ id: 'C1', side: 'RIGHT' }];

    await inst.scrollToComment('C1', 'a.js', 42, 'RIGHT');

    expect(bridge.scrollToLine).toHaveBeenCalledWith('a.js', 42, 'RIGHT', true);
    expect(frameSpy).toHaveBeenCalledTimes(3);
    expect(row).not.toBeNull();
    // Without the poll this scroll never happens: findRow() is checked once,
    // returns null, and the navigation is silently dropped.
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(row);
    expect(row.querySelector('.user-comment').classList.contains('highlight-flash')).toBe(true);
  });

  it('lands on a finding row that mounts on a real animation frame (unstubbed path)', async () => {
    // Same scenario driven by the production requestAnimationFrame seam, so the
    // poll is proven against real frames and not only the test stub.
    const { wrapper, bridge } = mountedFileWithLateRow();
    bridge.scrollToLine = vi.fn(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const suggestion = document.createElement('div');
        suggestion.className = 'ai-suggestion';
        suggestion.dataset.suggestionId = 'F1';
        wrapper.appendChild(suggestion);
      }));
    });

    const inst = makeInstance();
    inst.findings = [{ id: 'F1', side: 'RIGHT' }];

    await inst.scrollToFinding('F1', 'a.js', 42, 'RIGHT');

    const row = wrapper.querySelector('.ai-suggestion');
    expect(row).not.toBeNull();
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(row);
  });

  it('stops polling as soon as a newer navigation supersedes this one', async () => {
    const { bridge } = mountedFileWithLateRow();
    const inst = makeInstance();
    inst.comments = [{ id: 'C1', side: 'RIGHT' }];
    const frameSpy = stubFrames((n) => {
      // A newer nav starts while we are waiting for the row to mount.
      if (n === 2) inst._navGen += 1;
    });

    await inst.scrollToComment('C1', 'a.js', 42, 'RIGHT');

    expect(bridge.scrollToLine).toHaveBeenCalled();
    // Bailed on the frame that observed the supersede — no further polling and
    // no snap-back to the stale target.
    expect(frameSpy).toHaveBeenCalledTimes(2);
    expect(inst._scrollDiffTarget).not.toHaveBeenCalled();
  });

  it('is bounded — gives up after the frame budget when the row never mounts', async () => {
    mountedFileWithLateRow();
    const frameSpy = stubFrames();

    const inst = makeInstance();
    inst.comments = [{ id: 'C1', side: 'RIGHT' }];

    await inst.scrollToComment('C1', 'a.js', 42, 'RIGHT');

    expect(frameSpy).toHaveBeenCalledTimes(AIPanel.NAV_ROW_MAX_FRAMES);
    expect(inst._scrollDiffTarget).not.toHaveBeenCalled();
  });

  it('does not poll at all when the row is already live', async () => {
    const wrapper = makeFileWrapper('a.js');
    makeCommentRow(wrapper, 'C1');
    const frameSpy = stubFrames();
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.comments = [{ id: 'C1', side: 'RIGHT' }];

    await inst.scrollToComment('C1', 'a.js', 42, 'RIGHT');

    expect(bridge.scrollToLine).not.toHaveBeenCalled();
    expect(frameSpy).not.toHaveBeenCalled();
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(wrapper.querySelector('.user-comment-row'));
  });
});

describe('AIPanel._findExternalRow — strict gate vs loose final lookup', () => {
  it('materializes the requested thread even when a DIFFERENT thread is mounted in the file', async () => {
    // Thread 8 is virtualized out; thread 7 (unrelated) is mounted in the same
    // file. The loose first-row-in-file fallback would return thread 7, skip
    // materialization, and focus the wrong thread.
    const wrapper = makeFileWrapper('a.js');
    const otherRow = makeExternalRow(wrapper, { threadId: '7' });
    let targetRow = null;
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(() => { targetRow = makeExternalRow(wrapper, { threadId: '8' }); }),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.externalThreads = [
      { id: 7, source: 'github', side: 'RIGHT' },
      { id: 8, source: 'github', side: 'LEFT' },
    ];

    await inst.scrollToExternalThread('8', 'github', 'a.js', 99);

    // The strict predicate refused the unrelated row, so the gate materialized.
    expect(bridge.scrollToLine).toHaveBeenCalledWith('a.js', 99, 'LEFT', true);
    expect(targetRow).not.toBeNull();
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(targetRow);
    expect(targetRow.classList.contains('external-comment-row--focused')).toBe(true);
    // The unrelated thread was never scrolled to or focused.
    expect(inst._scrollDiffTarget).not.toHaveBeenCalledWith(otherRow);
    expect(otherRow.classList.contains('external-comment-row--focused')).toBe(false);
  });

  it('_findExternalRow(strict) skips the first-row-in-file fallback', () => {
    const wrapper = makeFileWrapper('a.js');
    const row = makeExternalRow(wrapper, { threadId: '7' });
    const inst = makeInstance();

    expect(inst._findExternalRow('999', 'github', 'a.js')).toBe(row);
    expect(inst._findExternalRow('999', 'github', 'a.js', true)).toBeNull();
  });

  it('keeps the loose fallback for the final lookup (rebuilt row with no ids)', async () => {
    // A row rebuilt without its data attributes: strict never matches, so the
    // gate materializes and the poll runs out — but the final loose lookup must
    // still find it rather than dropping the navigation.
    const wrapper = makeFileWrapper('a.js');
    const bareRow = makeExternalRow(wrapper, { threadId: undefined, source: undefined });
    stubFrames();
    const bridge = {
      files: { has: () => true },
      scrollToLine: vi.fn(),
      scrollToFile: vi.fn(),
      whenAnnotationsSlotted: vi.fn(async () => ({ mounted: true, slotted: true })),
    };
    window.prManager = { pierreBridge: bridge };

    const inst = makeInstance();
    inst.externalThreads = [{ id: 7, source: 'github', side: 'RIGHT' }];

    await inst.scrollToExternalThread('7', 'github', 'a.js', 42);

    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(bareRow);
    expect(bareRow.classList.contains('external-comment-row--focused')).toBe(true);
  });
});
