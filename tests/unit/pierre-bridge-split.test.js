// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// Coverage for split-mode (side-by-side) diff support in the single-CodeView
// PierreBridge:
//   - constructor diffStyle default / override / validation
//   - setDiffStyle validation, no-op, and propagation to the ONE CodeView via
//     setOptions (diffStyle is a CodeView-level option applied to every item;
//     annotations live on item data and survive the relayout)
//   - _queryLineElement column selection in split (deletions/additions)
//   - _applySplitAnnotationLayout full-width card math + per-file rAF debounce
//   - gutter buttons built by renderGutterUtility
//
// Vendor facts these tests encode (verified against @pierre/diffs dist):
//   - Split content lines are stamped data-line-index="<unified>,<split>" in
//     BOTH columns, and a context line shares the same composite key on both.
//   - The two columns are <code data-deletions> (left) and <code data-additions>
//     (right); annotation cells carry data-line-annotation.

function diffEntry(id = 'a.js') {
  return { id, type: 'diff', fileName: id, patch: '@@ -1 +1 @@\n-a\n+b\n' };
}

describe('PierreBridge diffStyle — constructor', () => {
  let env;

  beforeEach(() => {
    env = createPierreEnv({ diffs: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('defaults to unified when no diffStyle is given', () => {
    expect(new env.PierreBridge({}).diffStyle).toBe('unified');
    expect(new env.PierreBridge({}).getDiffStyle()).toBe('unified');
  });

  it('honors an explicit split diffStyle', () => {
    const bridge = new env.PierreBridge({ diffStyle: 'split' });
    expect(bridge.diffStyle).toBe('split');
    expect(bridge.getDiffStyle()).toBe('split');
  });

  it('falls back to unified for an invalid diffStyle', () => {
    expect(new env.PierreBridge({ diffStyle: 'sideways' }).diffStyle).toBe('unified');
    expect(new env.PierreBridge({ diffStyle: null }).diffStyle).toBe('unified');
  });

  it('validates diffStyle values via the static helper', () => {
    const { PierreBridge } = env;
    expect(PierreBridge.isValidDiffStyle('unified')).toBe(true);
    expect(PierreBridge.isValidDiffStyle('split')).toBe(true);
    expect(PierreBridge.isValidDiffStyle('nope')).toBe(false);
    expect(PierreBridge.isValidDiffStyle(undefined)).toBe(false);
  });
});

describe('PierreBridge.setDiffStyle propagates through the single CodeView', () => {
  let env;
  let bridge;
  let codeView;

  beforeEach(() => {
    env = createPierreEnv({ worker: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [diffEntry('a.js'), diffEntry('b.js')]);
    codeView = env.codeViews[0];
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('applies a real change via one setOptions carrying diffStyle: split', () => {
    const before = codeView.calls.setOptions.length;
    bridge.setDiffStyle('split');

    expect(bridge.diffStyle).toBe('split');
    expect(codeView.calls.setOptions.length).toBe(before + 1);
    // Every item renders with the CodeView-level diffStyle — no per-file wiring.
    expect(codeView.calls.setOptions.at(-1).diffStyle).toBe('split');
  });

  it('newly added items inherit the current diffStyle from the CodeView options', () => {
    bridge.setDiffStyle('split');
    // The option object handed to CodeView for any subsequent render carries it.
    expect(bridge._buildCodeViewOptions().diffStyle).toBe('split');
  });

  it('preserves stored annotations across the switch (they ride item data)', () => {
    bridge.addAnnotation('a.js', {
      lineNumber: 5, side: 'RIGHT', type: 'comment', id: 'c1', data: {},
    });
    const before = bridge.files.get('a.js').annotations.slice();

    bridge.setDiffStyle('split');

    expect(bridge.files.get('a.js').annotations).toEqual(before);
  });

  it('is a no-op when the style is unchanged', () => {
    const split = new env.PierreBridge({ diffStyle: 'split' });
    const root = env.document.createElement('div');
    split.renderAll(root, [diffEntry('a.js')]);
    const cv = env.codeViews.at(-1);
    const before = cv.calls.setOptions.length;

    split.setDiffStyle('split');

    expect(cv.calls.setOptions.length).toBe(before);
  });

  it('warns and does nothing for an invalid style', () => {
    const before = codeView.calls.setOptions.length;
    bridge.setDiffStyle('diagonal');

    expect(console.warn).toHaveBeenCalled();
    expect(bridge.diffStyle).toBe('unified');
    expect(codeView.calls.setOptions.length).toBe(before);
  });

  it('is safe before any render (no CodeView yet)', () => {
    const fresh = new env.PierreBridge({});
    expect(() => fresh.setDiffStyle('split')).not.toThrow();
    expect(fresh.diffStyle).toBe('split');
  });
});

describe('PierreBridge._queryLineElement — split columns', () => {
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

  // Build a split <pre> with a deletions (left) and additions (right) column.
  function makeSplitInstance({ deletionKey, additionKey }) {
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
    const { instance, additionLineEl } = makeSplitInstance({ deletionKey: '5,4', additionKey: '5,4' });
    expect(PierreBridge._queryLineElement(instance, [5, 4], 'additions')).toBe(additionLineEl);
  });

  it('returns the deletions-column line when LEFT (deletions) is requested', () => {
    const { instance, deletionLineEl } = makeSplitInstance({ deletionKey: '5,4', additionKey: '5,4' });
    expect(PierreBridge._queryLineElement(instance, [5, 4], 'deletions')).toBe(deletionLineEl);
  });

  it('falls back to the other column when the requested side lacks the line', () => {
    const { instance, additionLineEl } = makeSplitInstance({ deletionKey: null, additionKey: '7,6' });
    expect(PierreBridge._queryLineElement(instance, [7, 6], 'deletions')).toBe(additionLineEl);
  });

  it('resolves columns from the DOM when instance code refs are absent', () => {
    const { instance, additionLineEl } = makeSplitInstance({ deletionKey: '5,4', additionKey: '5,4' });
    const domOnly = { pre: instance.pre };
    expect(PierreBridge._queryLineElement(domOnly, [5, 4], 'additions')).toBe(additionLineEl);
  });

  it('still resolves the unified column when present (regression guard)', () => {
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
  let env;
  let doc;

  beforeEach(() => {
    env = createPierreEnv({ diffs: false, raf: false });
    doc = env.document;
  });

  afterEach(() => {
    env.cleanup();
    delete global.requestAnimationFrame;
    vi.restoreAllMocks();
  });

  // Fake shadow tree: <pre data-diff-type="split"> with an additions gutter
  // (measurable width) and a paired annotation-cell row per vendor layout —
  // both cells share the same data-line-annotation key; only the annotated
  // side contains <slot> elements.
  function makeSplitShadow({ deletionHasSlot = false, additionHasSlot = true, key = '0,3' } = {}) {
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
    const bridge = new env.PierreBridge({ diffStyle: 'split' });
    bridge.files.set('a.js', { _shadowRoot: root, annotations: [] });
    return bridge;
  }

  it('publishes the measured additions-gutter width on the pre', () => {
    const { root, pre } = makeSplitShadow();
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(pre.style.getPropertyValue('--pr-split-gutter-width')).toBe('64px');
  });

  it('marks a lone card full-width and leaves its empty pair unmarked', () => {
    const { root, deletionCell, additionCell } = makeSplitShadow({ deletionHasSlot: false, additionHasSlot: true });
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(additionCell.classList.contains('pr-annotation-fullwidth')).toBe(true);
    expect(deletionCell.classList.contains('pr-annotation-fullwidth')).toBe(false);
  });

  it('keeps both cards half-width when both sides of a row are annotated', () => {
    const { root, deletionCell, additionCell } = makeSplitShadow({ deletionHasSlot: true, additionHasSlot: true });
    additionCell.classList.add('pr-annotation-fullwidth'); // stale class must clear
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(additionCell.classList.contains('pr-annotation-fullwidth')).toBe(false);
    expect(deletionCell.classList.contains('pr-annotation-fullwidth')).toBe(false);
  });

  it('no-ops in unified mode and for missing files/shadow roots', () => {
    const root = doc.createElement('div');
    root.appendChild(doc.createElement('pre'));
    const bridge = makeBridgeWithShadow(root);
    expect(() => bridge._applySplitAnnotationLayout('a.js')).not.toThrow();
    expect(() => bridge._applySplitAnnotationLayout('missing.js')).not.toThrow();
    bridge.files.set('bare.js', {});
    expect(() => bridge._applySplitAnnotationLayout('bare.js')).not.toThrow();
  });

  // Entirely added/removed file: the vendor emits ONE code column stamped
  // data-diff-type="single". The layout pass must measure the file's OWN gutter
  // and mark every slotted card lone.
  function makeSingleShadow({ side = 'additions', hasSlot = true, key = '0,3' } = {}) {
    const root = doc.createElement('div');
    const pre = doc.createElement('pre');
    pre.setAttribute('data-diff-type', 'single');
    root.appendChild(pre);

    const code = doc.createElement('code');
    code.setAttribute('data-code', '');
    code.setAttribute(`data-${side}`, '');
    const gutter = doc.createElement('div');
    gutter.setAttribute('data-gutter', '');
    gutter.getBoundingClientRect = () => ({ width: 48 });
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
    return { root, pre, cell };
  }

  it('publishes the lone gutter width for an entirely-added file', () => {
    const { root, pre } = makeSingleShadow({ side: 'additions' });
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(pre.style.getPropertyValue('--pr-split-gutter-width')).toBe('48px');
  });

  it('marks a card in an entirely-added file full-width', () => {
    const { root, cell } = makeSingleShadow({ side: 'additions' });
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(cell.classList.contains('pr-annotation-fullwidth')).toBe(true);
  });

  it('marks a card in an entirely-removed file full-width', () => {
    const { root, cell } = makeSingleShadow({ side: 'deletions' });
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(cell.classList.contains('pr-annotation-fullwidth')).toBe(true);
  });

  it('leaves an empty annotation cell unmarked in a one-sided file', () => {
    const { root, cell } = makeSingleShadow({ side: 'additions', hasSlot: false });
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(cell.classList.contains('pr-annotation-fullwidth')).toBe(false);
  });

  it('ignores single-type pres while the bridge is in unified mode', () => {
    const root = doc.createElement('div');
    const pre = doc.createElement('pre');
    pre.setAttribute('data-diff-type', 'single');
    const code = doc.createElement('code');
    code.setAttribute('data-code', '');
    code.setAttribute('data-unified', '');
    const gutter = doc.createElement('div');
    gutter.setAttribute('data-gutter', '');
    gutter.getBoundingClientRect = () => ({ width: 48 });
    code.appendChild(gutter);
    const cell = doc.createElement('div');
    cell.setAttribute('data-line-annotation', '0,3');
    const inner = doc.createElement('div');
    inner.setAttribute('data-annotation-content', '');
    inner.appendChild(doc.createElement('slot'));
    cell.appendChild(inner);
    code.appendChild(cell);
    pre.appendChild(code);
    root.appendChild(pre);

    const bridge = new env.PierreBridge({}); // unified
    bridge.files.set('a.js', { _shadowRoot: root, annotations: [] });
    bridge._applySplitAnnotationLayout('a.js');

    expect(cell.classList.contains('pr-annotation-fullwidth')).toBe(false);
    expect(pre.style.getPropertyValue('--pr-split-gutter-width')).toBe('');
  });

  it('still measures the middle (additions) gutter on a two-sided pre', () => {
    const { root, pre } = makeSplitShadow();
    const delGutter = pre.querySelector('[data-deletions] [data-gutter]');
    delGutter.getBoundingClientRect = () => ({ width: 999 });
    const bridge = makeBridgeWithShadow(root);
    bridge._applySplitAnnotationLayout('a.js');
    expect(pre.style.getPropertyValue('--pr-split-gutter-width')).toBe('64px');
  });

  it('ships the one-sided half-width and card-stretch CSS', () => {
    const css = env.PierreBridge.ANNOTATION_CSS;
    expect(css).toContain("[data-diff-type='single']:has(> [data-additions], > [data-deletions])");
    expect(css).toContain('grid-template-columns: 1fr 1fr;');
    expect(css).toContain("[data-diff-type='single'] [data-deletions] .pr-annotation-fullwidth");
    expect(css).toContain("[data-diff-type='single'] [data-additions] .pr-annotation-fullwidth");
  });

  it('debounces repeated sync requests into one rAF pass', () => {
    const scheduled = [];
    global.requestAnimationFrame = (fn) => { scheduled.push(fn); return scheduled.length; };
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

  it('schedules an independent rAF per file (debounce guard is per-file)', () => {
    const scheduled = [];
    global.requestAnimationFrame = (fn) => { scheduled.push(fn); return scheduled.length; };
    const a = makeSplitShadow();
    const b = makeSplitShadow();
    const bridge = new env.PierreBridge({ diffStyle: 'split' });
    bridge.files.set('a.js', { _shadowRoot: a.root, annotations: [] });
    bridge.files.set('b.js', { _shadowRoot: b.root, annotations: [] });

    bridge._syncSplitAnnotationLayout('a.js');
    bridge._syncSplitAnnotationLayout('b.js');
    expect(scheduled).toHaveLength(2);

    // A repeat of each file coalesces into its own pending pass — no new rAF.
    bridge._syncSplitAnnotationLayout('a.js');
    bridge._syncSplitAnnotationLayout('b.js');
    expect(scheduled).toHaveLength(2);

    scheduled[0]();
    scheduled[1]();
    expect(a.additionCell.classList.contains('pr-annotation-fullwidth')).toBe(true);
    expect(b.additionCell.classList.contains('pr-annotation-fullwidth')).toBe(true);
  });
});

describe('PierreBridge gutter buttons (renderGutterUtility)', () => {
  let env;
  let bridge;
  let codeView;
  let clicks;

  beforeEach(() => {
    env = createPierreEnv({ worker: false });
    clicks = [];
    bridge = new env.PierreBridge({
      onCommentClick: (file, line, side, target) => clicks.push({ kind: 'comment', file, line, side, target }),
      onChatClick: (file, line, side, target) => clicks.push({ kind: 'chat', file, line, side, target }),
    });
    const root = env.document.createElement('div');
    bridge.renderAll(root, [diffEntry('a.js')]);
    codeView = env.codeViews[0];
  });

  afterEach(() => {
    env.cleanup();
  });

  function clickButton(selector, hovered) {
    const container = codeView.renderGutterFor('a.js', () => hovered);
    const btn = container.querySelector(selector);
    btn.dispatchEvent(new env.dom.window.Event('pointerdown'));
    btn.click();
    return { container, btn };
  }

  it('builds chat + comment buttons with the CSS classes and returns them', () => {
    const container = codeView.renderGutterFor('a.js', () => null);
    expect(container.classList.contains('pierre-gutter-buttons')).toBe(true);
    expect(container.querySelector('.pierre-gutter-btn.pierre-comment-btn')).toBeTruthy();
    expect(container.querySelector('.pierre-gutter-btn.pierre-chat-btn')).toBeTruthy();
  });

  it('routes a comment-button click to onCommentClick for the hovered line', () => {
    clickButton('.pierre-comment-btn', { lineNumber: 5, side: 'additions' });
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ kind: 'comment', file: 'a.js', line: 5, side: 'RIGHT' });
  });

  it('routes a chat-button click to onChatClick, mapping deletion side to LEFT', () => {
    clickButton('.pierre-chat-btn', { lineNumber: 8, side: 'deletions' });
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ kind: 'chat', file: 'a.js', line: 8, side: 'LEFT' });
  });

  it('does not build gutter buttons for a context item', () => {
    bridge.addContextFile('ctx.js', 'contents');
    const result = codeView.renderGutterFor('context:ctx.js', () => null);
    expect(result).toBeUndefined();
  });
});
