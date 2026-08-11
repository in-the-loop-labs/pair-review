// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// Regression coverage for the composite data-line-index bug: the @pierre/diffs
// bundle stamps rendered lines with data-line-index="<unifiedIndex>,<splitIndex>"
// (e.g. "4,3"), but isLineVisible/scrollToLine used to query the bare unified
// index ("4"), so every visible line was reported hidden — which broke tour
// stop mounting, hidden-suggestion detection, and scroll-to-line everywhere.

describe('PierreBridge._queryLineElement()', () => {
  let env;
  let PierreBridge;
  let doc;

  beforeEach(() => {
    env = createPierreEnv({ diffs: false });
    PierreBridge = env.PierreBridge;
    doc = env.document;
  });

  afterEach(() => {
    env.cleanup();
  });

  function makeInstance(lineIndexAttr) {
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.setAttribute('data-unified', '');
    const line = doc.createElement('div');
    line.setAttribute('data-line', '');
    line.setAttribute('data-line-index', lineIndexAttr);
    code.appendChild(line);
    pre.appendChild(code);
    return { pre, codeUnified: code, lineEl: line };
  }

  it('finds a line stamped with a composite "unified,split" index', () => {
    const { lineEl, ...instance } = makeInstance('4,3');
    expect(PierreBridge._queryLineElement(instance, [4, 3])).toBe(lineEl);
  });

  it('falls back to the bare unified index for older bundle formats', () => {
    const { lineEl, ...instance } = makeInstance('4');
    expect(PierreBridge._queryLineElement(instance, [4, 3])).toBe(lineEl);
  });

  it('returns null when the line is not rendered (collapsed gap)', () => {
    const { ...instance } = makeInstance('7,2');
    expect(PierreBridge._queryLineElement(instance, [4, 3])).toBe(null);
  });

  it('returns null for missing indices or instance internals', () => {
    const { ...instance } = makeInstance('4,3');
    expect(PierreBridge._queryLineElement(instance, undefined)).toBe(null);
    expect(PierreBridge._queryLineElement(instance, [null, null])).toBe(null);
    expect(PierreBridge._queryLineElement({ pre: null }, [4, 3])).toBe(null);
  });

  it('scopes the query to the instance codeUnified element', () => {
    const { lineEl, ...instance } = makeInstance('4,3');
    // A ghost line with the same index in another element must not match.
    const ghostPre = doc.createElement('pre');
    const ghost = doc.createElement('div');
    ghost.setAttribute('data-line', '');
    ghost.setAttribute('data-line-index', '4,3');
    ghostPre.appendChild(ghost);
    expect(PierreBridge._queryLineElement(instance, [4, 3])).toBe(lineEl);
  });
});

// Regression coverage for the stale-DOM visibility bug: rendering paints
// asynchronously (worker highlighting), so DOM queries lag the latest publish.
// isLineVisible must consult the item's CURRENT logical state
// (metadata.hunks + per-hunk gap expansion tracked on the mounted instance),
// never the DOM — otherwise a clear-ranges-then-check sequence sees lines that
// are about to disappear, skips re-expansion, and leaves annotations unslotted.
describe('PierreBridge.isLineVisible()', () => {
  let env;
  let PierreBridge;

  beforeEach(() => {
    env = createPierreEnv({ diffs: false });
    PierreBridge = env.PierreBridge;
  });

  afterEach(() => {
    env.cleanup();
  });

  // Hunk shape mirrors @pierre/diffs metadata.hunks entries.
  const HUNKS = [
    { additionStart: 3, additionCount: 5, deletionStart: 3, deletionCount: 2 },   // lines 3-7 (RIGHT), 3-4 (LEFT)
    { additionStart: 20, additionCount: 4, deletionStart: 17, deletionCount: 4 }, // lines 20-23 (RIGHT)
  ];

  function makeBridgeWithHunks({ hunks = HUNKS, collapsed = false, expandedHunks = new Map() } = {}) {
    const bridge = new PierreBridge({});
    const _instance = {
      hunksRenderer: { getExpandedHunk: (i) => expandedHunks.get(i) },
    };
    bridge.files.set('a.js', {
      itemType: 'diff',
      collapsed,
      metadata: hunks ? { hunks } : undefined,
      _instance,
    });
    return bridge;
  }

  it('reports lines inside a hunk visible and gap lines hidden (RIGHT side)', () => {
    const bridge = makeBridgeWithHunks();
    expect(bridge.isLineVisible('a.js', 3, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('a.js', 7, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('a.js', 8, 'RIGHT')).toBe(false);   // gap between hunks
    expect(bridge.isLineVisible('a.js', 14, 'RIGHT')).toBe(false);  // gap between hunks
    expect(bridge.isLineVisible('a.js', 20, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('a.js', 24, 'RIGHT')).toBe(false);  // past last hunk
    expect(bridge.isLineVisible('a.js', 1, 'RIGHT')).toBe(false);   // before first hunk
  });

  it('uses deletion-side coordinates for LEFT and skips zero-count sides', () => {
    const bridge = makeBridgeWithHunks({
      hunks: [
        { additionStart: 5, additionCount: 3, deletionStart: 9, deletionCount: 2 },
        { additionStart: 30, additionCount: 2, deletionStart: 26, deletionCount: 0 }, // pure addition
      ],
    });
    expect(bridge.isLineVisible('a.js', 9, 'LEFT')).toBe(true);
    expect(bridge.isLineVisible('a.js', 10, 'LEFT')).toBe(true);
    expect(bridge.isLineVisible('a.js', 11, 'LEFT')).toBe(false);
    // Pure-addition hunk has no deletion-side lines at all.
    expect(bridge.isLineVisible('a.js', 26, 'LEFT')).toBe(false);
  });

  it('widens hunks by user gap expansion tracked in hunksRenderer', () => {
    const bridge = makeBridgeWithHunks({
      expandedHunks: new Map([[1, { fromStart: 3, fromEnd: 2 }]]),
    });
    expect(bridge.isLineVisible('a.js', 17, 'RIGHT')).toBe(true);   // 20 - 3
    expect(bridge.isLineVisible('a.js', 16, 'RIGHT')).toBe(false);
    expect(bridge.isLineVisible('a.js', 25, 'RIGHT')).toBe(true);   // 23 + 2
    expect(bridge.isLineVisible('a.js', 26, 'RIGHT')).toBe(false);
  });

  it('returns false for collapsed files even when the line is in a hunk', () => {
    const bridge = makeBridgeWithHunks({ collapsed: true });
    expect(bridge.isLineVisible('a.js', 3, 'RIGHT')).toBe(false);
  });

  it('returns false for unknown files or items without metadata hunks', () => {
    const bridge = makeBridgeWithHunks({ hunks: null });
    expect(bridge.isLineVisible('a.js', 3, 'RIGHT')).toBe(false);
    expect(bridge.isLineVisible('missing.js', 3, 'RIGHT')).toBe(false);
  });

  it('reports false for a context (non-diff) item', () => {
    const bridge = new PierreBridge({});
    bridge.files.set('context:a.js', {
      itemType: 'context', collapsed: false, metadata: { hunks: HUNKS },
    });
    expect(bridge.isLineVisible('context:a.js', 3, 'RIGHT')).toBe(false);
  });

  it('ignores the DOM entirely — no stale answers during in-flight repaints', () => {
    // No pre/codeUnified/DOM on the instance at all: if the implementation
    // regresses to DOM queries this throws or returns the wrong value.
    const bridge = makeBridgeWithHunks();
    expect(bridge.isLineVisible('a.js', 5, 'RIGHT')).toBe(true);
  });
});

// Under CodeView every file has an item immediately, so setCollapsed always
// publishes a version-bumped item (even when the flag is unchanged — callers
// use it to force a header refresh after a viewed-state change). CodeView
// re-renders a collapsed:true -> false item on the version bump, so no manual
// re-kick is needed.
describe('PierreBridge.setCollapsed()', () => {
  let env;
  let bridge;
  let codeView;

  beforeEach(() => {
    env = createPierreEnv({ worker: false });
    bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n', collapsed: true },
    ]);
    codeView = env.codeViews[0];
  });

  afterEach(() => {
    env.cleanup();
  });

  it('publishes a version-bumped, expanded item on collapsed -> expanded', () => {
    const before = codeView.getItem('a.js').version;
    bridge.setCollapsed('a.js', false);

    const item = codeView.getItem('a.js');
    expect(item.collapsed).toBe(false);
    expect(item.version).toBeGreaterThan(before);
    expect(bridge.files.get('a.js').collapsed).toBe(false);
  });

  it('publishes when collapsing an expanded file', () => {
    bridge.setCollapsed('a.js', false);
    const mid = codeView.getItem('a.js').version;

    bridge.setCollapsed('a.js', true);
    const item = codeView.getItem('a.js');
    expect(item.collapsed).toBe(true);
    expect(item.version).toBeGreaterThan(mid);
  });

  it('publishes even when the flag is unchanged (forces a header refresh)', () => {
    const before = codeView.calls.updateItem.length;
    bridge.setCollapsed('a.js', true); // already collapsed
    expect(codeView.calls.updateItem.length).toBe(before + 1);
  });

  it('is a no-op for unknown files', () => {
    const before = codeView.calls.updateItem.length;
    expect(() => bridge.setCollapsed('missing.js', false)).not.toThrow();
    expect(codeView.calls.updateItem.length).toBe(before);
  });
});

// scrollToLine's boolean return is a CONTRACT: callers (chat snippets, tour
// stops) fall back to file-level navigation when it reports false. Under
// virtualization the DOM cannot answer "is this line real?" — an off-screen row
// is legitimately unmounted — so the answer comes from the parsed diff data.
// Returning true unconditionally silently killed the fallback: a stale
// out-of-diff line anchor scrolled nowhere and no one noticed.
describe('PierreBridge.scrollToLine() data-backed result', () => {
  let env;
  let bridge;
  let codeView;

  // Two hunks with a gap: RIGHT lines 3-7 and 20-23 exist, 8-19 do not.
  const HUNKS = [
    { additionStart: 3, additionCount: 5, deletionStart: 3, deletionCount: 2 },
    { additionStart: 20, additionCount: 4, deletionStart: 17, deletionCount: 4 },
  ];

  function setup({ hunks = HUNKS } = {}) {
    env = createPierreEnv({
      worker: false,
      parsePatch: () => ({
        name: 'a.js',
        type: 'change',
        hunks: hunks || [],
        splitLineCount: 0,
        unifiedLineCount: 0,
        deletionLines: [],
        additionLines: [],
      }),
    });
    bridge = new env.PierreBridge({});
    bridge.renderAll(env.document.createElement('div'), [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -3,2 +3,5 @@\n-a\n+b\n' },
    ]);
    codeView = env.codeViews[0];
  }

  afterEach(() => {
    env.cleanup();
  });

  it('returns false and does not scroll for a line absent from the diff', () => {
    setup();
    expect(bridge.scrollToLine('a.js', 12, 'RIGHT')).toBe(false);
    expect(codeView.calls.scrollTo).toHaveLength(0);
  });

  it('returns true for an in-diff line even though nothing is mounted', () => {
    setup();
    // No item is mounted here: the answer must come from the data, not the DOM.
    expect(bridge.files.get('a.js')._instance).toBeFalsy();
    expect(bridge.scrollToLine('a.js', 21, 'RIGHT')).toBe(true);
    expect(codeView.calls.scrollTo).toHaveLength(1);
    expect(codeView.calls.scrollTo[0]).toMatchObject({ type: 'line', id: 'a.js', lineNumber: 21 });
  });

  it('uses deletion-side coordinates for LEFT', () => {
    setup();
    expect(bridge.scrollToLine('a.js', 4, 'LEFT')).toBe(true);
    expect(bridge.scrollToLine('a.js', 8, 'LEFT')).toBe(false); // LEFT hunks are 3-4 and 17-20
    expect(bridge.scrollToLine('a.js', 17, 'LEFT')).toBe(true);
  });

  it('stays optimistic (true) when the file has no parsed metadata yet', () => {
    // Metadata parsing has not produced hunks: "not in the file" is not knowable,
    // and false is a give-up signal — so scroll and report success.
    setup({ hunks: [] });
    expect(bridge.scrollToLine('a.js', 999, 'RIGHT')).toBe(true);
    expect(codeView.calls.scrollTo).toHaveLength(1);
  });

  it('still scrolls a collapsed file whose line is in the diff', () => {
    // isLineVisible reports collapsed files as not-visible, but the line IS in
    // the file — scrolling to it (which expands nothing) beats falling back.
    setup();
    bridge.files.get('a.js').collapsed = true;
    expect(bridge.isLineVisible('a.js', 5, 'RIGHT')).toBe(false);
    expect(bridge.scrollToLine('a.js', 5, 'RIGHT')).toBe(true);
  });

  it('returns false for an unknown file', () => {
    setup();
    expect(bridge.scrollToLine('missing.js', 3, 'RIGHT')).toBe(false);
    expect(codeView.calls.scrollTo).toHaveLength(0);
  });
});

// Regression for the scroll-to-line flash: the preceding scrollToLine uses
// behavior:'smooth', so a virtualized-out target mounts many frames later. A
// fixed 2-frame wait queried before the row existed and silently no-op'd;
// _flashLine now polls (bounded by maxFrames), re-reading fileState._instance
// each frame, and flashes once the row appears.
describe('PierreBridge._flashLine bounded-poll mount wait', () => {
  let env;
  let bridge;
  let doc;
  let prevRaf;
  let prevCancel;

  beforeEach(() => {
    env = createPierreEnv({ diffs: false });
    bridge = new env.PierreBridge({});
    doc = env.document;
  });

  afterEach(() => {
    env.cleanup();
  });

  function makeInstance(lineIndexAttr = '4,3') {
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.setAttribute('data-unified', '');
    const line = doc.createElement('div');
    line.setAttribute('data-line', '');
    line.setAttribute('data-line-index', lineIndexAttr);
    code.appendChild(line);
    pre.appendChild(code);
    return { instance: { pre, codeUnified: code, getLineIndex: () => [4, 3] }, line };
  }

  function installManualRaf() {
    prevRaf = global.requestAnimationFrame;
    prevCancel = global.cancelAnimationFrame;
    const rq = [];
    global.requestAnimationFrame = (cb) => { rq.push(cb); return rq.length; };
    global.cancelAnimationFrame = () => {};
    return { rq, tick: () => rq.splice(0).forEach((cb) => cb()) };
  }

  it('polls until a late-mounting line appears, then flashes it', () => {
    const { rq, tick } = installManualRaf();
    try {
      const { instance, line } = makeInstance();
      const fileState = { _instance: null }; // not mounted yet

      bridge._flashLine(fileState, 4, 'RIGHT', { maxFrames: 5 });
      tick(); // frame 1: instance still null → no flash, re-poll
      expect(line.classList.contains('pierre-line-highlight')).toBe(false);
      expect(rq.length).toBe(1); // still polling

      fileState._instance = instance; // item mounts late
      tick(); // frame 2: row resolves → flash applied, polling stops
      expect(line.classList.contains('pierre-line-highlight')).toBe(true);
      expect(rq.length).toBe(0);
    } finally {
      global.requestAnimationFrame = prevRaf;
      global.cancelAnimationFrame = prevCancel;
    }
  });

  it('stops after the frame budget when the line never mounts (no infinite poll)', () => {
    const { rq, tick } = installManualRaf();
    try {
      const fileState = { _instance: null }; // never mounts

      bridge._flashLine(fileState, 4, 'RIGHT', { maxFrames: 3 });
      tick(); tick(); tick(); // 3 polls exhaust the budget
      expect(rq.length).toBe(0); // nothing rescheduled past the budget
      tick(); tick(); // further ticks are no-ops
      expect(rq.length).toBe(0);
    } finally {
      global.requestAnimationFrame = prevRaf;
      global.cancelAnimationFrame = prevCancel;
    }
  });
});
