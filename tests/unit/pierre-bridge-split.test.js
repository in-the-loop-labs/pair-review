// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';

// Coverage for split-mode (side-by-side) diff support in PierreBridge:
//   - constructor diffStyle default / override / validation
//   - setDiffStyle validation, no-op, and propagation to FileDiff instances
//     (annotations preserved across the re-render)
//   - _queryLineElement column selection in split (deletions/additions)
//   - _deriveHoverSide deriving the side from the enclosing code column
//
// Vendor facts these tests encode (verified against @pierre/diffs dist):
//   - Split content lines are stamped data-line-index="<unified>,<split>" in
//     BOTH columns (renderDiffWithHighlighter), and a context line shares the
//     same composite key on both sides.
//   - The two columns are <code data-deletions> (left) and <code data-additions>
//     (right); gutter cells carry data-column-number + data-line-type.

// Loads the bridge with window.PierreDiffs absent → construction is enabled but
// worker-free and DOM-only, which is all these unit tests exercise.
function loadDisabledBridge({ document: doc } = {}) {
  delete require.cache[require.resolve(BRIDGE_PATH)];
  global.window = {
    PierreDiffs: undefined,
    matchMedia: () => ({ matches: false }),
  };
  if (doc) global.document = doc;
  return require(BRIDGE_PATH);
}

describe('PierreBridge diffStyle — constructor', () => {
  let dom;
  let warnSpy;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete global.window;
    delete global.document;
    vi.restoreAllMocks();
  });

  it('defaults to unified when no diffStyle is given', () => {
    const PierreBridge = loadDisabledBridge({ document: dom.window.document });
    expect(new PierreBridge({}).diffStyle).toBe('unified');
    expect(new PierreBridge({}).getDiffStyle()).toBe('unified');
  });

  it('honors an explicit split diffStyle', () => {
    const PierreBridge = loadDisabledBridge({ document: dom.window.document });
    const bridge = new PierreBridge({ diffStyle: 'split' });
    expect(bridge.diffStyle).toBe('split');
    expect(bridge.getDiffStyle()).toBe('split');
  });

  it('falls back to unified for an invalid diffStyle', () => {
    const PierreBridge = loadDisabledBridge({ document: dom.window.document });
    expect(new PierreBridge({ diffStyle: 'sideways' }).diffStyle).toBe('unified');
    expect(new PierreBridge({ diffStyle: null }).diffStyle).toBe('unified');
  });

  it('validates diffStyle values via the static helper', () => {
    const PierreBridge = loadDisabledBridge({ document: dom.window.document });
    expect(PierreBridge.isValidDiffStyle('unified')).toBe(true);
    expect(PierreBridge.isValidDiffStyle('split')).toBe(true);
    expect(PierreBridge.isValidDiffStyle('nope')).toBe(false);
    expect(PierreBridge.isValidDiffStyle(undefined)).toBe(false);
  });
});

describe('PierreBridge._createFileDiffInstance passes diffStyle to FileDiff', () => {
  let dom;
  let capturedOptions;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    capturedOptions = [];
    // PierreDiffs present (bridge enabled) but no WorkerPoolManager → the bridge
    // builds no worker pool, so _createFileDiffInstance is the only thing under
    // test and it constructs a FileDiff synchronously.
    delete require.cache[require.resolve(BRIDGE_PATH)];
    global.window = {
      matchMedia: () => ({ matches: false }),
      PierreDiffs: {
        FileDiff: function FileDiff(options) {
          capturedOptions.push(options);
          this.options = options;
        },
      },
    };
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    vi.restoreAllMocks();
  });

  it('stamps the constructor diffStyle onto new instances', () => {
    const PierreBridge = require(BRIDGE_PATH);
    const bridge = new PierreBridge({ diffStyle: 'split' });
    bridge._createFileDiffInstance('a.js', new Map(), {});
    expect(capturedOptions.at(-1).diffStyle).toBe('split');
  });

  it('reflects a later setDiffStyle for newly created instances', () => {
    const PierreBridge = require(BRIDGE_PATH);
    const bridge = new PierreBridge({}); // starts unified
    bridge.setDiffStyle('split');
    bridge._createFileDiffInstance('b.js', new Map(), {});
    expect(capturedOptions.at(-1).diffStyle).toBe('split');
  });
});

describe('PierreBridge.setDiffStyle', () => {
  let PierreBridge;
  let dom;
  let warnSpy;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    PierreBridge = loadDisabledBridge({ document: dom.window.document });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete global.window;
    delete global.document;
    vi.restoreAllMocks();
  });

  function makeInstance(startStyle = 'unified') {
    return {
      options: { diffStyle: startStyle, theme: { dark: 'x' }, enableGutterUtility: true },
      lineAnnotations: [{ side: 'additions', lineNumber: 5, metadata: { id: 'c1' } }],
      setOptions: vi.fn(function (o) { this.options = o; }),
      rerender: vi.fn(),
    };
  }

  it('propagates a real change to every instance via setOptions + rerender', () => {
    const bridge = new PierreBridge({});
    const a = makeInstance();
    const b = makeInstance();
    bridge.files.set('a.js', { instance: a });
    bridge.files.set('b.js', { instance: b });

    bridge.setDiffStyle('split');

    expect(bridge.diffStyle).toBe('split');
    for (const inst of [a, b]) {
      expect(inst.setOptions).toHaveBeenCalledTimes(1);
      // Existing options are preserved; only diffStyle changes.
      expect(inst.setOptions).toHaveBeenCalledWith({
        diffStyle: 'split',
        theme: { dark: 'x' },
        enableGutterUtility: true,
      });
      expect(inst.rerender).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves stored annotations across the switch (rerender re-slots them)', () => {
    const bridge = new PierreBridge({});
    const a = makeInstance();
    const before = a.lineAnnotations;
    bridge.files.set('a.js', { instance: a });

    bridge.setDiffStyle('split');

    // setDiffStyle must not clear/replace annotations — they ride the rerender.
    expect(a.lineAnnotations).toBe(before);
    expect(a.lineAnnotations).toEqual([
      { side: 'additions', lineNumber: 5, metadata: { id: 'c1' } },
    ]);
  });

  it('is a no-op when the style is unchanged', () => {
    const bridge = new PierreBridge({ diffStyle: 'split' });
    const a = makeInstance('split');
    bridge.files.set('a.js', { instance: a });

    bridge.setDiffStyle('split');

    expect(a.setOptions).not.toHaveBeenCalled();
    expect(a.rerender).not.toHaveBeenCalled();
  });

  it('warns and does nothing for an invalid style', () => {
    const bridge = new PierreBridge({});
    const a = makeInstance();
    bridge.files.set('a.js', { instance: a });

    bridge.setDiffStyle('diagonal');

    expect(warnSpy).toHaveBeenCalled();
    expect(bridge.diffStyle).toBe('unified');
    expect(a.setOptions).not.toHaveBeenCalled();
    expect(a.rerender).not.toHaveBeenCalled();
  });

  it('falls back to mergeOptions when setOptions is absent', () => {
    const bridge = new PierreBridge({});
    const merged = [];
    const a = {
      options: { diffStyle: 'unified' },
      mergeOptions: (o) => merged.push(o),
      rerender: vi.fn(),
    };
    bridge.files.set('a.js', { instance: a });

    bridge.setDiffStyle('split');

    expect(merged).toEqual([{ diffStyle: 'split' }]);
    expect(a.rerender).toHaveBeenCalledTimes(1);
  });

  it('skips files whose instance is missing', () => {
    const bridge = new PierreBridge({});
    bridge.files.set('gone.js', { instance: null });
    expect(() => bridge.setDiffStyle('split')).not.toThrow();
    expect(bridge.diffStyle).toBe('split');
  });
});

describe('PierreBridge.setCollapsed preserves the full options object', () => {
  let PierreBridge;
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    PierreBridge = loadDisabledBridge({ document: dom.window.document });
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  // Regression: vendor setOptions REPLACES the options object. A bare
  // setOptions({ collapsed }) wiped diffStyle (reverting the file to the
  // vendor default 'split'), renderAnnotation, theme, etc.
  it('spreads existing options so collapse does not wipe diffStyle', () => {
    const bridge = new PierreBridge({});
    const renderAnnotation = () => {};
    const instance = {
      options: { diffStyle: 'unified', renderAnnotation, theme: { dark: 'x' } },
      setOptions: vi.fn(function (o) { this.options = o; }),
      rerender: vi.fn(),
    };
    bridge.files.set('a.js', { instance, collapsed: false });

    bridge.setCollapsed('a.js', true);

    expect(instance.setOptions).toHaveBeenCalledWith({
      diffStyle: 'unified',
      renderAnnotation,
      theme: { dark: 'x' },
      collapsed: true,
    });
    expect(instance.options.diffStyle).toBe('unified');
  });

  it('keeps diffStyle intact through a collapse → toggle → expand sequence', () => {
    const bridge = new PierreBridge({});
    const instance = {
      options: { diffStyle: 'unified', enableGutterUtility: true },
      setOptions: vi.fn(function (o) { this.options = o; }),
      rerender: vi.fn(),
    };
    bridge.files.set('a.js', { instance, collapsed: false });

    bridge.setCollapsed('a.js', true);
    bridge.setDiffStyle('split');
    bridge.setCollapsed('a.js', false);

    expect(instance.options).toEqual({
      diffStyle: 'split',
      enableGutterUtility: true,
      collapsed: false,
    });
    // collapsed→expanded forces a rerender so lines materialize.
    expect(instance.rerender).toHaveBeenCalled();
  });
});

describe('PierreBridge._queryLineElement — split columns', () => {
  let PierreBridge;
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    PierreBridge = loadDisabledBridge({ document: dom.window.document });
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  // Build a split <pre> with a deletions (left) and additions (right) column.
  // `keys` maps column → composite data-line-index string for its single line.
  function makeSplitInstance({ deletionKey, additionKey }) {
    const doc = dom.window.document;
    const pre = doc.createElement('pre');
    pre.setAttribute('data-diff-type', 'split');

    const mkColumn = (attr, key) => {
      const code = doc.createElement('code');
      code.setAttribute('data-code', '');
      code.setAttribute(attr, '');
      let lineEl = null;
      if (key != null) {
        lineEl = doc.createElement('div');
        lineEl.setAttribute('data-line', '');
        lineEl.setAttribute('data-line-index', key);
        code.appendChild(lineEl);
      }
      pre.appendChild(code);
      return { code, lineEl };
    };

    const del = mkColumn('data-deletions', deletionKey);
    const add = mkColumn('data-additions', additionKey);
    return {
      instance: { pre, codeDeletions: del.code, codeAdditions: add.code },
      deletionLineEl: del.lineEl,
      additionLineEl: add.lineEl,
    };
  }

  it('returns the additions-column line when RIGHT (additions) is requested', () => {
    // Context line: same composite key present in BOTH columns.
    const { instance, additionLineEl } = makeSplitInstance({
      deletionKey: '5,4',
      additionKey: '5,4',
    });
    expect(PierreBridge._queryLineElement(instance, [5, 4], 'additions')).toBe(additionLineEl);
  });

  it('returns the deletions-column line when LEFT (deletions) is requested', () => {
    const { instance, deletionLineEl } = makeSplitInstance({
      deletionKey: '5,4',
      additionKey: '5,4',
    });
    expect(PierreBridge._queryLineElement(instance, [5, 4], 'deletions')).toBe(deletionLineEl);
  });

  it('falls back to the other column when the requested side lacks the line', () => {
    // Pure addition: line exists only in the additions column.
    const { instance, additionLineEl } = makeSplitInstance({
      deletionKey: null,
      additionKey: '7,6',
    });
    expect(PierreBridge._queryLineElement(instance, [7, 6], 'deletions')).toBe(additionLineEl);
  });

  it('resolves columns from the DOM when instance code refs are absent', () => {
    const { instance, additionLineEl } = makeSplitInstance({
      deletionKey: '5,4',
      additionKey: '5,4',
    });
    // Drop the cached column refs — force the querySelector fallback path.
    const domOnly = { pre: instance.pre };
    expect(PierreBridge._queryLineElement(domOnly, [5, 4], 'additions')).toBe(additionLineEl);
  });

  it('still resolves the unified column when present (regression guard)', () => {
    const doc = dom.window.document;
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.setAttribute('data-unified', '');
    const line = doc.createElement('div');
    line.setAttribute('data-line', '');
    line.setAttribute('data-line-index', '4,3');
    code.appendChild(line);
    pre.appendChild(code);
    const instance = { pre, codeUnified: code };
    expect(PierreBridge._queryLineElement(instance, [4, 3], 'additions')).toBe(line);
  });
});

describe('PierreBridge split full-width annotation layout', () => {
  let PierreBridge;
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    PierreBridge = loadDisabledBridge({ document: dom.window.document });
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.requestAnimationFrame;
    vi.restoreAllMocks();
  });

  // Fake shadow tree: <pre data-diff-type="split"> with an additions gutter
  // (measurable width) and a paired annotation-cell row per vendor layout —
  // both cells share the same data-line-annotation key; only the annotated
  // side contains <slot> elements.
  function makeSplitShadow({ deletionHasSlot = false, additionHasSlot = true, key = '0,3' } = {}) {
    const doc = dom.window.document;
    const root = doc.createElement('div');
    const pre = doc.createElement('pre');
    pre.setAttribute('data-diff-type', 'split');
    root.appendChild(pre);

    const mkCol = (attr, hasSlot) => {
      const code = doc.createElement('code');
      code.setAttribute('data-code', '');
      code.setAttribute(attr, '');
      const gutter = doc.createElement('div');
      gutter.setAttribute('data-gutter', '');
      code.appendChild(gutter);
      const content = doc.createElement('div');
      content.setAttribute('data-content', '');
      const cell = doc.createElement('div');
      cell.setAttribute('data-line-annotation', key);
      const inner = doc.createElement('div');
      inner.setAttribute('data-annotation-content', '');
      if (hasSlot) inner.appendChild(doc.createElement('slot'));
      cell.appendChild(inner);
      content.appendChild(cell);
      code.appendChild(content);
      pre.appendChild(code);
      return { gutter, cell };
    };

    const del = mkCol('data-deletions', deletionHasSlot);
    const add = mkCol('data-additions', additionHasSlot);
    add.gutter.getBoundingClientRect = () => ({ width: 64 });
    return { root, pre, deletionCell: del.cell, additionCell: add.cell };
  }

  function makeBridgeWithShadow(root) {
    const bridge = new PierreBridge({ diffStyle: 'split' });
    bridge.files.set('a.js', { shadowHost: { shadowRoot: root }, annotations: [] });
    return bridge;
  }

  it('publishes the measured additions-gutter width on the pre', () => {
    const { root, pre } = makeSplitShadow();
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(pre.style.getPropertyValue('--pr-split-gutter-width')).toBe('64px');
  });

  it('marks a lone card full-width and leaves its empty pair unmarked', () => {
    const { root, deletionCell, additionCell } = makeSplitShadow({
      deletionHasSlot: false,
      additionHasSlot: true,
    });
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(additionCell.classList.contains('pr-annotation-fullwidth')).toBe(true);
    expect(deletionCell.classList.contains('pr-annotation-fullwidth')).toBe(false);
  });

  it('keeps both cards half-width when both sides of a row are annotated', () => {
    const { root, deletionCell, additionCell } = makeSplitShadow({
      deletionHasSlot: true,
      additionHasSlot: true,
    });
    // Stale class from a previous pass must be cleared.
    additionCell.classList.add('pr-annotation-fullwidth');
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(additionCell.classList.contains('pr-annotation-fullwidth')).toBe(false);
    expect(deletionCell.classList.contains('pr-annotation-fullwidth')).toBe(false);
  });

  it('no-ops in unified mode and for missing files/shadow roots', () => {
    const doc = dom.window.document;
    const root = doc.createElement('div');
    root.appendChild(doc.createElement('pre')); // no data-diff-type="split"
    const bridge = makeBridgeWithShadow(root);
    expect(() => bridge._applySplitAnnotationLayout('a.js')).not.toThrow();
    expect(() => bridge._applySplitAnnotationLayout('missing.js')).not.toThrow();
    bridge.files.set('bare.js', {});
    expect(() => bridge._applySplitAnnotationLayout('bare.js')).not.toThrow();
  });

  it('debounces repeated sync requests into one rAF pass', () => {
    const scheduled = [];
    global.requestAnimationFrame = (fn) => {
      scheduled.push(fn);
      return scheduled.length;
    };
    const { root, additionCell } = makeSplitShadow();
    const bridge = makeBridgeWithShadow(root);

    bridge._syncSplitAnnotationLayout('a.js');
    bridge._syncSplitAnnotationLayout('a.js');
    bridge._syncSplitAnnotationLayout('a.js');
    expect(scheduled).toHaveLength(1);

    scheduled[0]();
    expect(additionCell.classList.contains('pr-annotation-fullwidth')).toBe(true);
    // After the pass runs, a new sync can be scheduled again.
    bridge._syncSplitAnnotationLayout('a.js');
    expect(scheduled).toHaveLength(2);
  });
});

describe('PierreBridge._deriveHoverSide', () => {
  let PierreBridge;
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    PierreBridge = loadDisabledBridge({ document: dom.window.document });
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  // A gutter cell nested in a column code element, mirroring the vendor DOM:
  // <code data-{side}> <div data-gutter> <div data-column-number data-line-type>
  function makeGutterCell(columnAttr, lineType) {
    const doc = dom.window.document;
    const code = doc.createElement('code');
    if (columnAttr) code.setAttribute(columnAttr, '');
    const gutter = doc.createElement('div');
    gutter.setAttribute('data-gutter', '');
    const cell = doc.createElement('div');
    cell.dataset.columnNumber = '10';
    if (lineType != null) cell.dataset.lineType = lineType;
    gutter.appendChild(cell);
    code.appendChild(gutter);
    return cell;
  }

  it('derives the side from the enclosing column in split mode', () => {
    const bridge = new PierreBridge({ diffStyle: 'split' });
    // Context line: neutral line-type, side must come from the column.
    const delCell = makeGutterCell('data-deletions', 'context');
    const addCell = makeGutterCell('data-additions', 'context');
    expect(bridge._deriveHoverSide(delCell)).toBe('deletions');
    expect(bridge._deriveHoverSide(addCell)).toBe('additions');
  });

  it('uses the line-type string in unified mode', () => {
    const bridge = new PierreBridge({}); // unified
    const delCell = makeGutterCell(null, 'change-deletion');
    const addCell = makeGutterCell(null, 'change-addition');
    expect(bridge._deriveHoverSide(delCell)).toBe('deletions');
    expect(bridge._deriveHoverSide(addCell)).toBe('additions');
  });

  it('falls back to the line-type string in split when no column ancestor exists', () => {
    const bridge = new PierreBridge({ diffStyle: 'split' });
    const orphan = makeGutterCell(null, 'change-deletion');
    expect(bridge._deriveHoverSide(orphan)).toBe('deletions');
  });
});
