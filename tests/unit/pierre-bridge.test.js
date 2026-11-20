// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
/**
 * Pure logic of PierreBridge: what it decides from its own data and
 * what it sends to the viewer. The viewer here is a recording stub that
 * never renders (tests/utils/pierre-bridge-harness.js); what the real
 * viewer does is tested in a browser (tests/contract/bridge).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { loadCodeViewBridge, numberedLines, changedFileFixture } = require('../utils/pierre-bridge-harness.js');

const BRIDGE_SOURCE = path.join(__dirname, '..', '..', 'public', 'js', 'modules', 'pierre-bridge.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

let env;
let PierreBridge;
let bridge;

function create(options = {}) {
  bridge = new PierreBridge({
    root: env.window.document.getElementById('root'),
    theme: 'light',
    useWorkerPool: false,
    itemMetrics: { diffHeaderHeight: 45, lineHeight: 17 },
    ...options,
  });
  return bridge;
}
const viewer = () => bridge.codeView;
const A = changedFileFixture('src/a.js');
const B = changedFileFixture('src/b.js');
const diffEntry = (fixture, extra = {}) => ({ id: fixture.name, kind: 'diff', patch: fixture.patch, status: 'modified', ...extra });
const contextEntry = (id, extra = {}) => ({ id, kind: 'context', contents: `${numberedLines(400).join('\n')}\n`, contentsSeq: 1, ranges: [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }], ...extra });

beforeEach(() => {
  env = loadCodeViewBridge(vendor);
  PierreBridge = env.PierreBridge;
});

afterEach(() => {
  bridge?.destroy();
  bridge = null;
  env.restore();
});

describe('renderAll: records and the first list', () => {
  it('builds one record and one item per entry, in entry order, and parses each patch once', () => {
    create();
    expect(bridge.renderAll([diffEntry(A), contextEntry('ctx/c.js'), diffEntry(B)], { keyPrefix: 'rev7' })).toBe(true);
    expect([...bridge.files.keys()]).toEqual(['src/a.js', 'ctx/c.js', 'src/b.js']);
    expect([...bridge.files.values()].map((r) => r.kind)).toEqual(['diff', 'context', 'diff']);
    expect(viewer().count('setup')).toBe(1);
    expect(viewer().count('setItems')).toBe(1);
    const items = viewer().last('setItems').args[0];
    expect(items.map((item) => [item.id, item.type])).toEqual([['src/a.js', 'diff'], ['ctx/c.js', 'diff'], ['src/b.js', 'diff']]);
    // One parse per changed file; a context file is not parsed from a patch.
    expect(env.parseCalls).toHaveLength(2);
  });

  it('every item starts with the file-comment zone, on the side the viewer lays out for the file', () => {
    create();
    bridge.renderAll([
      diffEntry(A),
      diffEntry(B, { status: 'removed' }),
      { id: 'src/gone.js', kind: 'diff', patch: 'diff --git a/src/gone.js b/src/gone.js\ndeleted file mode 100644\n--- a/src/gone.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n' },
      contextEntry('ctx/c.js'),
    ]);
    const zone = (id) => viewer().getItem(id).annotations[0];
    expect(zone('src/a.js')).toMatchObject({ side: 'additions', lineNumber: 0, metadata: { type: 'file-comments' } });
    // The status says so although the patch does not.
    expect(zone('src/b.js').side).toBe('deletions');
    // The patch says so although no status was given.
    expect(zone('src/gone.js').side).toBe('deletions');
    expect(zone('ctx/c.js').side).toBe('additions');
  });

  it('gives every file its own cache key, made from the review, the render and the position', () => {
    create();
    bridge.renderAll([diffEntry(A), diffEntry(B)], { keyPrefix: 'rev7' });
    const first = [...bridge.files.values()].map((r) => r.metadata.cacheKey);
    expect(new Set(first).size).toBe(2);
    expect(first.every((key) => key.includes('rev7:1:'))).toBe(true);
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    const second = [...bridge.files.values()].map((r) => r.metadata.cacheKey);
    expect(second.every((key) => key.includes('rev7:2:'))).toBe(true);
    expect(second.some((key) => first.includes(key))).toBe(false);
  });

  it('refuses a missing list, ignores a duplicate id and an entry without one, and needs a root', () => {
    create();
    expect(bridge.renderAll(null)).toBe(false);
    expect(bridge.renderAll(undefined)).toBe(false);
    expect(bridge.codeView).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(bridge.renderAll([diffEntry(A), diffEntry(A), { kind: 'diff', patch: A.patch }, null])).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate id'));
    warn.mockRestore();
    expect([...bridge.files.keys()]).toEqual(['src/a.js']);
    bridge.destroy();

    const rootless = new PierreBridge({ useWorkerPool: false });
    expect(rootless.renderAll([diffEntry(A)])).toBe(false);
    rootless.destroy();
  });

  it('a patch the vendor cannot parse, no patch at all and a deferred file are header-only items', () => {
    create();
    bridge.renderAll([
      { id: 'bin/logo.png', kind: 'diff', patch: 'diff --git a/bin/logo.png b/bin/logo.png\nBinary files a/bin/logo.png and b/bin/logo.png differ\n' },
      { id: 'no/patch.js', kind: 'diff', patch: null },
      diffEntry(A, { deferred: true, notice: { message: 'Large diff' } }),
    ]);
    for (const id of ['bin/logo.png', 'no/patch.js', 'src/a.js']) {
      const record = bridge.files.get(id);
      expect(record.metadata.hunks, id).toEqual([]);
      expect(record.metadata.name, id).toBe(id);
      expect(bridge.isLineVisible(id, 1, 'RIGHT'), id).toBe(false);
    }
    // The deferred file's patch was not parsed, and it carries its notice after the zone.
    expect(env.parseCalls).toHaveLength(1);
    expect(viewer().getItem('src/a.js').annotations.map((a) => a.metadata.type)).toEqual(['file-comments', 'notice']);
    expect(bridge.getDiffPosition('src/a.js', 120, 'RIGHT')).toBeNull();
  });
});

describe('the options object', () => {
  it('is built once with the documented options, and a layout or theme change replaces it keeping every callback', () => {
    create({ diffStyle: 'split', theme: 'dark' });
    bridge.renderAll([diffEntry(A)]);
    const first = viewer().options;
    expect(first).toMatchObject({
      themeType: 'dark', diffStyle: 'split', diffIndicators: 'bars', overflow: 'wrap', lineHoverHighlight: 'line',
      lineDiffType: 'word', enableGutterUtility: true, enableLineSelection: true, hunkSeparators: 'line-info',
      expansionLineCount: 20, collapsedContextThreshold: 5, stickyHeaders: true, pointerEventsOnScroll: true,
      itemMetrics: { diffHeaderHeight: 45, lineHeight: 17 },
      // The per-file renderer's numbers: 16 px padding and a 1 px border
      // above the first file, a 24 px margin more below the last.
      layout: { paddingTop: 17, paddingBottom: 41, gap: 24 },
    });
    expect(first.unsafeCSS).toBe(env.window.PierreStyles.unsafeCSS());
    for (const name of ['renderCustomHeader', 'renderAnnotation', 'renderGutterUtility', 'onPostRender']) expect(typeof first[name]).toBe('function');
    // Per item, or not used at all.
    for (const name of ['collapsed', 'disableFileHeader', 'onHunkExpand', 'loadDiffFiles', 'expandUnchanged', 'renderCodeViewFooter']) expect(name in first).toBe(false);

    expect(bridge.setDiffStyle('unified')).toBe(true);
    const second = viewer().last('setOptions').args[0];
    expect(second).not.toBe(first);
    expect(second.diffStyle).toBe('unified');
    for (const name of ['renderCustomHeader', 'renderAnnotation', 'renderGutterUtility', 'onPostRender', 'onLineClick', 'onLineSelected', 'onLineSelectionEnd']) {
      expect(second[name], name).toBe(first[name]);
    }
    bridge.setTheme('light');
    expect(viewer().last('setOptions').args[0]).toMatchObject({ themeType: 'light', diffStyle: 'unified' });
    expect(bridge.theme).toBe('light');
  });

  it('setDiffStyle refuses an unknown style and does nothing for the current one', () => {
    create();
    bridge.renderAll([diffEntry(A)]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(bridge.setDiffStyle('sideways')).toBe(false);
    warn.mockRestore();
    expect(bridge.setDiffStyle('unified')).toBe(true);
    expect(viewer().count('setOptions')).toBe(0);
    expect(PierreBridge.isValidDiffStyle('split')).toBe(true);
    expect(PierreBridge.isValidDiffStyle(undefined)).toBe(false);
  });

  it('a layout option and extra viewer options given to the bridge are passed on', () => {
    create({ layout: { gap: 8 }, viewerOptions: { __devOnlyValidateItemHeights: true } });
    bridge.renderAll([diffEntry(A)]);
    expect(viewer().options.layout).toEqual({ paddingTop: 17, paddingBottom: 41, gap: 8 });
    expect(viewer().options.__devOnlyValidateItemHeights).toBe(true);
  });

  it('every item is given a row window of 5000 rows, next to the measured metrics', () => {
    // The viewer's default (1) moves a window of rows with the scroll
    // position, and a window that shrinks loses a separator or a card for
    // good (vendor fact F26, tests/contract/vendor/row-window.spec.js). A
    // file that shows fewer rows than the window is drawn whole.
    create();
    bridge.renderAll([diffEntry(A)]);
    expect(viewer().options.itemMetrics).toEqual({ diffHeaderHeight: 45, lineHeight: 17, hunkLineCount: 5000, paddingBottom: 9 });
  });

  it('the viewer is told what is below a file\'s last row: the frame\'s bottom border with the vendor\'s padding', () => {
    // One number for the styles that draw it and the layout that counts it.
    create();
    bridge.renderAll([diffEntry(A)]);
    expect(viewer().options.itemMetrics.paddingBottom).toBe(env.window.PierreStyles.ITEM_PADDING_BOTTOM);
    // Not told: a top padding. The viewer would count it for a file without
    // lines too, which has none; the 8 px under a header are the page's.
    expect(viewer().options.itemMetrics).not.toHaveProperty('paddingTop');
  });
});

describe('publish and flush', () => {
  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    viewer().calls.length = 0;
  });

  it('K annotations added at once are one updateItem and one flush', () => {
    bridge.addAnnotations('src/a.js', [1, 2, 3, 4].map((n) => ({ lineNumber: 117 + n, side: 'RIGHT', type: 'card', data: {}, id: `card-${n}` })));
    expect(viewer().count('updateItem')).toBe(1);
    expect(viewer().calls.filter((c) => c.name === 'render').map((c) => c.args[0])).toEqual([true]);
    const sent = viewer().last('updateItem').args[0];
    expect(sent.annotations).toHaveLength(5);
    expect(sent.fileDiff).toBe(bridge.files.get('src/a.js').metadata);
  });

  it('every publish carries a version the viewer has not seen, and a new annotations array', () => {
    const before = viewer().getItem('src/a.js');
    bridge.addAnnotation('src/a.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'one' });
    const first = viewer().last('updateItem').args[0];
    bridge.addAnnotation('src/a.js', { lineNumber: 119, side: 'RIGHT', type: 'card', data: {}, id: 'two' });
    const second = viewer().last('updateItem').args[0];
    expect(first.version).not.toBe(before.version);
    expect(second.version).not.toBe(first.version);
    expect(second.annotations).not.toBe(first.annotations);
    // The annotation objects themselves are the same across publishes.
    expect(second.annotations.find((a) => a.metadata.id === 'one')).toBe(first.annotations.find((a) => a.metadata.id === 'one'));
  });

  it('batch: one flush when the outermost batch returns, and its return value is the function\'s', () => {
    const value = bridge.batch(() => {
      bridge.addAnnotation('src/a.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'one' });
      bridge.batch(() => bridge.addAnnotation('src/b.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'two' }));
      expect(viewer().count('render')).toBe(0);
      return 'done';
    });
    expect(value).toBe('done');
    expect(viewer().count('updateItem')).toBe(2);
    expect(viewer().count('render')).toBe(1);
  });

  it('a batch that publishes nothing does not flush, and one that throws still closes', () => {
    bridge.batch(() => {});
    expect(viewer().count('render')).toBe(0);
    expect(() => bridge.batch(() => { bridge.setCollapsed('src/a.js', true); throw new Error('boom'); })).toThrow('boom');
    expect(viewer().count('render')).toBe(1);
    bridge.setCollapsed('src/b.js', true);
    expect(viewer().count('render')).toBe(2);
  });

  it('a publish made while the viewer is inside a render callback is flushed afterwards, once', async () => {
    const renderAnnotation = viewer().options.renderAnnotation;
    bridge.registerAnnotationRenderer('eager', () => {
      bridge.addAnnotation('src/a.js', { lineNumber: 119, side: 'RIGHT', type: 'card', data: {}, id: 'from-renderer' });
      bridge.addAnnotation('src/b.js', { lineNumber: 119, side: 'RIGHT', type: 'card', data: {}, id: 'from-renderer-2' });
      return env.window.document.createElement('div');
    });
    renderAnnotation({ side: 'additions', lineNumber: 118, metadata: { type: 'eager', data: {}, id: 'e' } }, {}, { item: { id: 'src/a.js' } });
    expect(viewer().count('updateItem')).toBe(2);
    expect(viewer().count('render')).toBe(0);
    await Promise.resolve();
    expect(viewer().calls.filter((c) => c.name === 'render').map((c) => c.args[0])).toEqual([true]);
  });

  it('a publish for a file the viewer no longer has is dropped', () => {
    viewer().items = viewer().items.filter((item) => item.id !== 'src/a.js');
    bridge.addAnnotation('src/a.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'one' });
    expect(viewer().count('updateItem')).toBe(0);
    expect(viewer().count('render')).toBe(0);
  });

  it('removing an annotation that is not there, or the zone, publishes nothing', () => {
    bridge.removeAnnotation('src/a.js', 'nope');
    bridge.removeAnnotation('src/a.js', 'file-comments');
    bridge.removeAnnotationsByType('src/a.js', 'card');
    bridge.removeAnnotationsByType('src/a.js', 'file-comments');
    bridge.addAnnotations('src/a.js', []);
    bridge.addAnnotations('src/a.js', null);
    expect(viewer().count('updateItem')).toBe(0);
    expect(viewer().getItem('src/a.js').annotations).toHaveLength(1);
  });
});

describe('a list write asked for inside a viewer callback', () => {
  let calls = 0;
  /** Run `fn` the way a card renderer runs: inside the viewer's renderAnnotation callback of src/a.js. */
  const insideCallback = (fn) => {
    const type = `calls-out-${++calls}`;
    let value;
    bridge.registerAnnotationRenderer(type, () => {
      value = fn();
      return env.window.document.createElement('div');
    });
    viewer().options.renderAnnotation({ side: 'additions', lineNumber: 118, metadata: { type, data: {}, id: type } }, {}, { item: { id: 'src/a.js' } });
    return value;
  };
  const writes = () => viewer().calls.filter((c) => c.name === 'setItems').map((c) => c.args[0].map((item) => item.id));
  const WITH_CONTEXT = () => [diffEntry(A), contextEntry('ctx/c.js'), diffEntry(B)];

  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    viewer().calls.length = 0;
  });

  it('the records change at once; the viewer is told once, after the pass', async () => {
    const outcome = insideCallback(() => bridge.reconcile(WITH_CONTEXT()));
    expect(outcome).toEqual({ applied: true, created: ['ctx/c.js'], removed: [], updated: [], listWritten: true });
    expect([...bridge.files.keys()]).toEqual(['src/a.js', 'ctx/c.js', 'src/b.js']);
    expect(writes()).toEqual([]);
    expect(viewer().count('render')).toBe(0);
    await Promise.resolve();
    expect(writes()).toEqual([[], ['src/a.js', 'ctx/c.js', 'src/b.js']]);
    expect(viewer().count('render')).toBeGreaterThan(0);
    await Promise.resolve();
    expect(writes()).toHaveLength(2);
  });

  it('the write sends the records as they are when it runs, not as they were when it was asked for', async () => {
    insideCallback(() => bridge.reconcile(WITH_CONTEXT()));
    bridge.addAnnotation('ctx/c.js', { lineNumber: 105, side: 'RIGHT', type: 'card', data: {}, id: 'late-new' });
    bridge.addAnnotation('src/b.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'late-kept' });
    bridge.setCollapsed('src/a.js', true);
    expect(bridge.addContextRanges('ctx/c.js', [{ startLine: 200, endLine: 204 }])).toBe(true);
    const metadata = bridge.files.get('ctx/c.js').metadata;
    await Promise.resolve();
    const sent = viewer().last('setItems').args[0];
    const ids = (item) => item.annotations.map((a) => a.metadata.id);
    expect(ids(sent[1])).toEqual(['file-comments', 'late-new']);
    expect(ids(sent[2])).toEqual(['file-comments', 'late-kept']);
    expect(sent[0].collapsed).toBe(true);
    expect(sent[1].fileDiff).toBe(metadata);
    expect(bridge.isLineVisible('ctx/c.js', 202, 'RIGHT')).toBe(true);
  });

  it('two requests in one pass are one write, of the last state', async () => {
    insideCallback(() => {
      bridge.reconcile(WITH_CONTEXT());
      bridge.reconcile([...WITH_CONTEXT(), contextEntry('ctx/d.js')]);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(writes()).toEqual([[], ['src/a.js', 'ctx/c.js', 'src/b.js', 'ctx/d.js']]);
  });

  it('until the write a viewer callback is about the record its item was made from, and nothing of that item reaches the new record', async () => {
    const renderHeader = vi.fn(() => env.window.document.createElement('div'));
    const hostState = vi.fn(() => ['generated-file']);
    const onItemLifecycle = vi.fn();
    bridge.destroy();
    create({ hooks: { renderHeader, hostState, onItemLifecycle } });
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    const oldRecord = bridge.files.get('src/b.js');
    viewer().selection = { id: 'src/b.js', range: { start: 118, end: 119, side: 'additions' } };
    // The old item is mounted: it has a header and a stamped host.
    const options = viewer().options;
    const host = env.window.document.createElement('div');
    const context = { item: { id: 'src/b.js' }, element: host, instance: { hunksRenderer: { expandedHunks: new Map([[0, { fromStart: 5, fromEnd: 0 }]]) } } };
    const oldSlot = options.renderCustomHeader({}, context);
    options.onPostRender(host, context.instance, 'mount', context);
    expect(oldSlot).toBe(oldRecord._headerSlot);
    expect(host.classList.contains('generated-file')).toBe(true);
    for (const mock of [renderHeader, hostState, onItemLifecycle]) mock.mockClear();
    viewer().calls.length = 0;
    // A new diff with the same paths: every record is new, the viewer's items are the old ones.
    insideCallback(() => bridge.renderAll([diffEntry(A), diffEntry(B)]));
    const record = bridge.files.get('src/b.js');
    expect(record).not.toBe(oldRecord);
    expect(bridge._listed.get('src/b.js')).toBe(oldRecord);

    // Not published: the item the viewer has under this path is the old record's.
    bridge.addAnnotation('src/b.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'new-card' });
    expect(viewer().count('updateItem')).toBe(0);

    // The old item goes on being drawn as it was: the header it has, the classes its host carries.
    expect(options.renderCustomHeader({}, context)).toBe(oldSlot);
    options.onPostRender(host, context.instance, 'update', context);
    expect(oldRecord._element).toBe(host);
    expect(host.getAttribute('data-file-name')).toBe('src/b.js');
    expect([...host.classList].sort()).toEqual(['d2h-file-wrapper', 'generated-file', 'has-diff-lines']);
    // None of it is the new record's, and the page is neither asked nor told about an item of a file it no longer has.
    expect(record._headerSlot).toBeNull();
    expect(record._element).toBeNull();
    expect(record._instance).toBeNull();
    expect(bridge.findFileElement('src/b.js')).toBeNull();
    expect(bridge.isDiffDisplayed('src/b.js')).toBe(false);
    expect(renderHeader).not.toHaveBeenCalled();
    expect(hostState).not.toHaveBeenCalled();
    expect(onItemLifecycle).not.toHaveBeenCalled();
    // The selection the viewer holds under this path is in the old file.
    expect(bridge.getLineSelection('src/b.js')).toBeNull();

    await Promise.resolve();
    expect(bridge._listed.get('src/b.js')).toBe(record);
    expect(viewer().last('setItems').args[0][1].annotations.map((a) => a.metadata.id)).toEqual(['file-comments', 'new-card']);
    // The old record was discarded by the write.
    expect(oldRecord._element).toBeNull();
    expect(oldRecord._headerSlot).toBeNull();
    expect(oldRecord.annotations).toEqual([]);
    // From here on the record is the item's.
    const slot = options.renderCustomHeader({}, context);
    expect(slot).toBe(record._headerSlot);
    expect(slot).not.toBe(oldSlot);
    expect(renderHeader).toHaveBeenCalledWith('src/b.js', 'diff');
    options.onPostRender(host, context.instance, 'mount', context);
    expect(record._element).toBe(host);
    expect(hostState).toHaveBeenCalledWith('src/b.js', 'diff');
    expect(onItemLifecycle).toHaveBeenCalledWith('src/b.js', 'mount');
    bridge.addAnnotation('src/b.js', { lineNumber: 119, side: 'RIGHT', type: 'card', data: {}, id: 'next' });
    expect(viewer().count('updateItem')).toBe(1);
  });

  it('a file taken out goes on drawing its item until the write, without a word to the page', async () => {
    const onItemLifecycle = vi.fn();
    bridge.destroy();
    create({ hooks: { onItemLifecycle } });
    const build = vi.fn(() => env.window.document.createElement('div'));
    const sync = vi.fn();
    bridge.registerAnnotationRenderer('card', build, { sync });
    bridge.renderAll(WITH_CONTEXT());
    bridge.addAnnotation('ctx/c.js', { lineNumber: 105, side: 'RIGHT', type: 'card', data: {}, id: 'goes' });
    bridge.addAnnotation('ctx/c.js', { lineNumber: 106, side: 'RIGHT', type: 'card', data: {}, id: 'never-drawn' });
    const removed = bridge.files.get('ctx/c.js');
    const options = viewer().options;
    const host = env.window.document.createElement('div');
    const context = { item: { id: 'ctx/c.js' }, element: host, instance: {} };
    const annotationOf = (id) => viewer().getItem('ctx/c.js').annotations.find((a) => a.metadata.id === id);
    // The viewer has drawn the first card (built and synced by the page's renderer), not the second.
    const card = options.renderAnnotation(annotationOf('goes'), {}, context);
    expect(card).toBe(build.mock.results[0].value);
    expect(sync).toHaveBeenCalledTimes(1);
    build.mockClear();
    sync.mockClear();
    viewer().calls.length = 0;
    insideCallback(() => bridge.reconcile([diffEntry(A), diffEntry(B)]));
    // Gone from the pane's data at once.
    expect(bridge.files.has('ctx/c.js')).toBe(false);
    expect(bridge.hasAnnotation('ctx/c.js', 'goes')).toBe(false);
    expect(bridge.getAnnotationElement('ctx/c.js', 'goes', { create: true })).toBeNull();
    // Its item is still the viewer's: drawn from the record it was made from,
    // with the card it has, as it is. No renderer and no sync of the page
    // runs for a file the pane no longer has, so a card that was never built
    // is not built now.
    expect(options.renderAnnotation(annotationOf('goes'), {}, context)).toBe(card);
    expect(options.renderAnnotation(annotationOf('never-drawn'), {}, context)).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    options.onPostRender(host, context.instance, 'update', context);
    expect(host.classList.contains('context-file')).toBe(true);
    expect(onItemLifecycle).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(writes()).toEqual([[], ['src/a.js', 'src/b.js']]);
    expect(removed.annotations).toEqual([]);
    expect(removed._element).toBeNull();
    // The viewer hands the host back: it loses its stamps, and the page hears nothing of a file it does not have.
    options.onPostRender(host, context.instance, 'unmount', context);
    expect(host.classList.contains('context-file')).toBe(false);
    expect(host.hasAttribute('data-file-name')).toBe(false);
    expect(onItemLifecycle).not.toHaveBeenCalled();
  });

  it('an item drawn for the first time after its record was replaced gets an empty header slot of the height the viewer was told, no card, and nothing of the page', async () => {
    const renderHeader = vi.fn(() => env.window.document.createElement('div'));
    const hostState = vi.fn(() => ['generated-file']);
    const onItemLifecycle = vi.fn();
    const callbacks = { onLineSelect: vi.fn(), onLineSelectionEnd: vi.fn(), onLineClick: vi.fn() };
    bridge.destroy();
    create({ hooks: { renderHeader, hostState, onItemLifecycle }, ...callbacks });
    const build = vi.fn(() => env.window.document.createElement('div'));
    const sync = vi.fn();
    bridge.registerAnnotationRenderer('card', build, { sync });
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    bridge.addAnnotation('src/b.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'never-drawn' });
    const annotation = viewer().getItem('src/b.js').annotations.find((a) => a.metadata.id === 'never-drawn');
    const options = viewer().options;
    const element = () => env.window.document.createElement('div');
    const a = { item: { id: 'src/a.js' }, element: element(), instance: {} };
    const b = { item: { id: 'src/b.js' }, element: element(), instance: {} };
    // src/a.js is mounted and the page was told; src/b.js has never been drawn.
    options.renderCustomHeader({}, a);
    options.onPostRender(a.element, a.instance, 'mount', a);
    expect(onItemLifecycle.mock.calls).toEqual([['src/a.js', 'mount']]);
    for (const mock of [renderHeader, hostState, onItemLifecycle]) mock.mockClear();

    // A hook of the first item of a pass replaces every record; the same pass goes on to draw src/b.js.
    insideCallback(() => bridge.renderAll([diffEntry(A), diffEntry(B)]));
    const slot = options.renderCustomHeader({}, b);
    // The slot every header is in, empty, and itself the height the viewer was told (itemMetrics.diffHeaderHeight).
    expect(slot.className).toBe('pr-file-header-slot');
    expect(slot.style.height).toBe('45px');
    expect(slot.childElementCount).toBe(0);
    expect(options.renderCustomHeader({}, b)).toBe(slot);
    expect(options.renderAnnotation(annotation, {}, b)).toBeUndefined();
    options.onPostRender(b.element, b.instance, 'mount', b);
    // The bridge's own stamps only (the item shows lines); nothing the page's hook would add.
    expect([...b.element.classList]).toEqual(['d2h-file-wrapper', 'has-diff-lines']);
    expect(b.element.getAttribute('data-file-name')).toBe('src/b.js');
    const range = { start: 118, end: 119, side: 'additions' };
    options.onLineSelected(range, b);
    options.onLineSelectionEnd(range, b);
    options.onLineClick({ lineNumber: 118, annotationSide: 'additions', lineType: 'context' }, b);
    for (const mock of [renderHeader, hostState, onItemLifecycle, build, sync, ...Object.values(callbacks)]) expect(mock).not.toHaveBeenCalled();
    // None of it is the new record's.
    const record = bridge.files.get('src/b.js');
    expect(record._headerSlot).toBeNull();
    expect(record._element).toBeNull();

    await Promise.resolve();
    // The write unmounts the old items. src/a.js was announced, so its
    // unmount is told; src/b.js never was, so its unmount is not.
    options.onPostRender(a.element, a.instance, 'unmount', a);
    options.onPostRender(b.element, b.instance, 'unmount', b);
    expect(onItemLifecycle.mock.calls).toEqual([['src/a.js', 'unmount']]);
    // From here on the items are the new records': told in pairs, and the page's callbacks are theirs.
    onItemLifecycle.mockClear();
    options.onPostRender(b.element, b.instance, 'mount', b);
    options.onPostRender(b.element, b.instance, 'unmount', b);
    options.onPostRender(b.element, b.instance, 'unmount', b);
    expect(onItemLifecycle.mock.calls).toEqual([['src/b.js', 'mount'], ['src/b.js', 'unmount']]);
    expect(options.renderCustomHeader({}, b)).toBe(record._headerSlot);
    expect(renderHeader).toHaveBeenCalledWith('src/b.js', 'diff');
    options.onLineSelected(range, b);
    options.onLineSelectionEnd(range, b);
    expect(callbacks.onLineSelect).toHaveBeenCalledWith('src/b.js', range);
    expect(callbacks.onLineSelectionEnd).toHaveBeenCalledWith('src/b.js', range);
  });

  it('the page hears the unmount of every mount it heard, whichever record the item was made from, unless the file is gone', async () => {
    const onItemLifecycle = vi.fn();
    bridge.destroy();
    create({ hooks: { onItemLifecycle } });
    bridge.renderAll(WITH_CONTEXT());
    const options = viewer().options;
    const mounted = (id) => {
      const context = { item: { id }, element: env.window.document.createElement('div'), instance: {} };
      options.onPostRender(context.element, context.instance, 'mount', context);
      return context;
    };
    const b = mounted('src/b.js');
    const c = mounted('ctx/c.js');
    onItemLifecycle.mockClear();
    // A new diff without the context file, asked for in a pass; before the
    // write runs the viewer unmounts both old items (the reader moved, the
    // old list was drawn again).
    insideCallback(() => bridge.renderAll([diffEntry(A), diffEntry(B)]));
    options.onPostRender(b.element, b.instance, 'update', b);
    options.onPostRender(b.element, b.instance, 'unmount', b);
    options.onPostRender(c.element, c.instance, 'unmount', c);
    // The pane still has src/b.js: that was its unmount. It has no ctx/c.js any more.
    expect(onItemLifecycle.mock.calls).toEqual([['src/b.js', 'unmount']]);
    expect(b.element.hasAttribute('data-file-name')).toBe(false);
    expect(c.element.classList.contains('context-file')).toBe(false);
    await Promise.resolve();
    // Told once: the write has nothing more to say about either.
    options.onPostRender(b.element, b.instance, 'unmount', b);
    options.onPostRender(c.element, c.instance, 'unmount', c);
    expect(onItemLifecycle.mock.calls).toEqual([['src/b.js', 'unmount']]);
    // A context file of the same path that comes back starts from nothing.
    bridge.reconcile(WITH_CONTEXT());
    options.onPostRender(c.element, c.instance, 'unmount', c);
    expect(onItemLifecycle.mock.calls).toEqual([['src/b.js', 'unmount']]);
    mounted('ctx/c.js');
    options.onPostRender(c.element, c.instance, 'unmount', c);
    expect(onItemLifecycle.mock.calls.slice(1)).toEqual([['ctx/c.js', 'mount'], ['ctx/c.js', 'unmount']]);
  });

  describe('while a list write is drawing', () => {
    /** Run `fn` from inside a viewer callback during the first flush of the next list write. */
    const hookDuringFlush = (fn) => {
      const v = viewer();
      const render = v.render.bind(v);
      let ran = false;
      v.render = (immediate) => {
        render(immediate);
        if (ran) return;
        ran = true;
        insideCallback(fn);
      };
    };
    /** The reader's first visible line: `line` of `id`, 60 px below the top of the pane, which is scrolled. */
    const readingAt = (id, line, { scrollTop = 800 } = {}) => {
      Object.defineProperty(bridge.root, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
      const row = {
        getBoundingClientRect: () => ({ top: 60 }),
        getAttribute: (name) => (name === 'data-line' ? String(line) : 'context'),
        closest: () => null,
      };
      viewer().getRenderedItems = () => [{ id, element: { getBoundingClientRect: () => ({ top: 10, bottom: 500 }), shadowRoot: { querySelectorAll: () => [row] } } }];
    };
    const sent = (name) => viewer().calls.filter((c) => c.name === name).map((c) => c.args[0]);

    it('the view restore addresses the list the write sent: no line target for a line that list does not show', async () => {
      readingAt('src/b.js', 118);
      // The first list shows no line of src/b.js; the hook's new diff, asked for in the flush, shows it again.
      hookDuringFlush(() => bridge.renderAll([diffEntry(A), diffEntry(B)]));
      bridge.renderAll([diffEntry(A), diffEntry(B, { patch: null })]);
      expect(bridge._listWriteQueued).toBe(true);
      expect(bridge.isLineVisible('src/b.js', 118, 'RIGHT')).toBe(true);
      expect(bridge._listShowsLine('src/b.js', 118, 'additions')).toBe(false);
      expect(sent('scrollTo')).toEqual([{ type: 'item', id: 'src/b.js', align: 'start', offset: 10 }]);
      await Promise.resolve();
      // The second write's restore: the line is shown by the list it sent.
      expect(sent('scrollTo')[1]).toMatchObject({ type: 'line', id: 'src/b.js', lineNumber: 118, side: 'additions' });
      expect(bridge._listShowsLine('src/b.js', 118, 'additions')).toBe(true);
    });

    it('a pane that was at its very top stays there: the write sends no scroll target', () => {
      // What a list write puts above the first file is shown, as content
      // inserted at the top of a scroll container at offset 0 is.
      readingAt('src/a.js', 117, { scrollTop: 0 });
      bridge.reconcile([contextEntry('ctx/above.js'), diffEntry(A), diffEntry(B)]);
      expect([...bridge.files.keys()]).toEqual(['ctx/above.js', 'src/a.js', 'src/b.js']);
      expect(sent('scrollTo')).toEqual([]);
      expect(bridge.root.scrollTop).toBe(0);
    });

    it('a pane that was scrolled keeps the reader\'s line when a file is put above it', () => {
      readingAt('src/a.js', 117);
      bridge.reconcile([contextEntry('ctx/above.js'), diffEntry(A), diffEntry(B)]);
      expect(sent('scrollTo')).toEqual([expect.objectContaining({ type: 'line', id: 'src/a.js', lineNumber: 117 })]);
    });

    it('the view restore addresses the list the write sent: nothing for a file that list does not hold', async () => {
      readingAt('src/b.js', 118);
      viewer().selection = { id: 'src/b.js', range: { start: 118, end: 119, side: 'additions' } };
      hookDuringFlush(() => bridge.renderAll([diffEntry(A), diffEntry(B)]));
      bridge.renderAll([diffEntry(A)]);
      // `files` has src/b.js again; the viewer's list does not.
      expect(bridge.files.has('src/b.js')).toBe(true);
      expect(viewer().getItem('src/b.js')).toBeUndefined();
      expect(sent('scrollTo')).toEqual([]);
      expect(sent('setSelectedLines')).toEqual([]);
      await Promise.resolve();
      expect(sent('scrollTo')).toHaveLength(1);
      expect(sent('scrollTo')[0]).toMatchObject({ type: 'line', id: 'src/b.js', lineNumber: 118 });
      expect(sent('setSelectedLines')).toEqual([{ id: 'src/b.js', range: { start: 118, end: 119, side: 'additions' } }]);
    });

    it('a line target is decided from the item the viewer holds, not from a kept record that is ahead of it', async () => {
      bridge.renderAll(WITH_CONTEXT());
      const record = bridge.files.get('ctx/c.js');
      // Kept, with other ranges, and a second context file: a list write waits, and nothing was published.
      insideCallback(() => bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js', { ranges: [{ startLine: 300, endLine: 310 }] }), contextEntry('ctx/d.js'), diffEntry(B)]));
      expect(bridge.files.get('ctx/c.js')).toBe(record);
      expect(viewer().getItem('ctx/c.js').fileDiff).not.toBe(record.metadata);
      expect(bridge.isLineVisible('ctx/c.js', 105, 'RIGHT')).toBe(false);
      expect(bridge._listShowsLine('ctx/c.js', 105, 'additions')).toBe(true);
      expect(bridge._listShowsLine('ctx/c.js', 305, 'additions')).toBe(true);
      expect(bridge._listShowsLine('ctx/d.js', 105, 'additions')).toBe(false);
      await Promise.resolve();
      expect(bridge._listShowsLine('ctx/c.js', 105, 'additions')).toBe(false);
      expect(bridge._listShowsLine('ctx/d.js', 105, 'additions')).toBe(true);
      bridge.setCollapsed('ctx/d.js', true);
      expect(bridge._listShowsLine('ctx/d.js', 105, 'additions')).toBe(false);
    });

    it('a command sent by a hook during the flush waits for the write\'s view restore', () => {
      viewer().selection = { id: 'src/a.js', range: { start: 118, end: 118, side: 'additions' } };
      let waiting = null;
      hookDuringFlush(() => {
        expect(bridge.scrollToItem('src/b.js')).toBe(true);
        bridge.selectLines('ctx/c.js', 104, 106, 'RIGHT');
        waiting = { queued: bridge._listWriteQueued, scrolls: sent('scrollTo').length, held: bridge._afterListWrite.length };
      });
      bridge.reconcile(WITH_CONTEXT());
      expect(waiting).toEqual({ queued: false, scrolls: 0, held: 2 });
      const order = viewer().calls.filter((c) => c.name !== 'render').map((c) => `${c.name}:${c.args[0]?.id ?? c.args[0].length}`);
      // The write, its restore (the selection it found), then the hook's commands in call order.
      expect(order).toEqual(['setItems:0', 'setItems:3', 'setSelectedLines:src/a.js', 'scrollTo:src/b.js', 'setSelectedLines:ctx/c.js']);
      expect(bridge._afterListWrite).toEqual([]);
      // Nothing waits any more.
      bridge.scrollToItem('src/a.js');
      expect(viewer().last('scrollTo').args[0].id).toBe('src/a.js');
    });

    it('a list write asked for by the page from inside a list write (the selection callback of its view restore) waits for it to end', async () => {
      const lists = () => viewer().calls.filter((c) => c.name === 'setItems').map((c) => c.args[0].length);
      let atCall = null;
      const onLineSelect = vi.fn(() => {
        if (atCall) return;
        // Not inside a render callback, and still inside the write.
        atCall = { depth: bridge._callbackDepth, running: bridge._listWriteRunning, lists: lists() };
        bridge.reconcile([diffEntry(A), diffEntry(B)]);
      });
      bridge.destroy();
      create({ onLineSelect });
      bridge.renderAll([diffEntry(A), diffEntry(B)]);
      const v = viewer();
      v.calls.length = 0;
      v.selection = { id: 'src/a.js', range: { start: 118, end: 118, side: 'additions' } };
      // The real viewer tells its onLineSelected callback of a selection that is set.
      const setSelectedLines = v.setSelectedLines.bind(v);
      v.setSelectedLines = (selection) => {
        setSelectedLines(selection);
        v.options.onLineSelected(selection.range, { item: { id: selection.id } });
      };
      const outcome = bridge.reconcile(WITH_CONTEXT());
      expect(outcome.created).toEqual(['ctx/c.js']);
      expect(atCall).toEqual({ depth: 0, running: true, lists: [0, 3] });
      // The records changed at once; the viewer's list is still the one whose write was in progress.
      expect([...bridge.files.keys()]).toEqual(['src/a.js', 'src/b.js']);
      expect(lists()).toEqual([0, 3]);
      expect(bridge._listWriteQueued).toBe(true);
      expect(bridge._listWriteRunning).toBe(false);
      await Promise.resolve();
      expect(lists()).toEqual([0, 3, 0, 2]);
      expect(bridge._listWriteQueued).toBe(false);
    });

    it('a write that throws takes the commands sent during it with it', () => {
      const v = viewer();
      v.render = () => {
        insideCallback(() => bridge.scrollToItem('src/b.js'));
        throw new Error('the viewer failed');
      };
      expect(() => bridge.reconcile(WITH_CONTEXT())).toThrow('the viewer failed');
      expect(bridge._afterListWrite).toEqual([]);
      expect(bridge._listWriteRunning).toBe(false);
      expect(v.count('scrollTo')).toBe(0);
      v.render = () => {};
      bridge.scrollToItem('src/a.js');
      expect(v.count('scrollTo')).toBe(1);
    });
  });

  it('a list write made directly meanwhile is the write: the microtask sends nothing', async () => {
    insideCallback(() => bridge.reconcile(WITH_CONTEXT()));
    expect(bridge.renderAll([diffEntry(B)])).toBe(true);
    expect(writes()).toEqual([[], ['src/b.js']]);
    await Promise.resolve();
    await Promise.resolve();
    expect(writes()).toEqual([[], ['src/b.js']]);
    expect([...bridge.files.keys()]).toEqual(['src/b.js']);

    // And the other way round: a waiting new diff, then a reconcile outside the pass.
    viewer().calls.length = 0;
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    viewer().calls.length = 0;
    insideCallback(() => bridge.renderAll([diffEntry(A), diffEntry(B)]));
    expect(bridge.reconcile(WITH_CONTEXT()).created).toEqual(['ctx/c.js']);
    await Promise.resolve();
    expect(writes()).toEqual([[], ['src/a.js', 'ctx/c.js', 'src/b.js']]);
  });

  it('destroy() cancels the waiting write: no viewer is made, and a destroyed bridge renders nothing', async () => {
    const instances = env.RecordingViewer.instances.length;
    const old = viewer();
    insideCallback(() => bridge.reconcile(WITH_CONTEXT()));
    bridge.scrollToItem('ctx/c.js');
    bridge.destroy();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.codeView).toBeNull();
    expect(env.RecordingViewer.instances).toHaveLength(instances);
    expect(old.count('setItems')).toBe(0);
    expect(old.count('scrollTo')).toBe(0);
    expect(bridge.renderAll([diffEntry(A)])).toBe(false);
    expect(bridge.reconcile([diffEntry(A)]).reason).toBe('not-rendered');
    expect(bridge.files.size).toBe(0);
    expect(env.RecordingViewer.instances).toHaveLength(instances);
  });

  it('scroll targets and selections sent meanwhile reach the viewer after the write, in call order', async () => {
    viewer().selection = { id: 'src/a.js', range: { start: 118, end: 118, side: 'additions' } };
    insideCallback(() => {
      bridge.reconcile(WITH_CONTEXT());
      expect(bridge.scrollToItem('ctx/c.js')).toBe(true);
      expect(bridge.scrollToLine('ctx/c.js', 105, 'RIGHT', { flash: false })).toBe(true);
      expect(bridge.scrollToLine('ctx/c.js', 150, 'RIGHT', { flash: false })).toBe(false);
      bridge.clearLineSelection('src/a.js');
      bridge.selectLines('ctx/c.js', 104, 106, 'LEFT');
    });
    // Same task, after the pass: still waiting.
    bridge.scrollToItem('src/b.js');
    expect(viewer().calls.map((c) => c.name)).toEqual([]);
    await Promise.resolve();
    const order = viewer().calls.map((c) => c.name).filter((name) => name !== 'render');
    expect(order).toEqual(['setItems', 'setItems', 'setSelectedLines', 'scrollTo', 'scrollTo', 'clearSelectedLines', 'setSelectedLines', 'scrollTo']);
    expect(viewer().calls.filter((c) => c.name === 'scrollTo').map((c) => `${c.args[0].type}:${c.args[0].id}`)).toEqual(['item:ctx/c.js', 'line:ctx/c.js', 'item:src/b.js']);
    // A context file has one side.
    expect(viewer().last('setSelectedLines').args[0]).toEqual({ id: 'ctx/c.js', range: { start: 104, end: 106, side: 'additions' } });
    // Nothing waits any more: the next command goes straight to the viewer.
    bridge.scrollToItem('src/a.js');
    expect(viewer().last('scrollTo').args[0].id).toBe('src/a.js');
  });

  it('a command whose file, or whose line, is gone when the write runs is dropped', async () => {
    insideCallback(() => {
      bridge.reconcile(WITH_CONTEXT());
      bridge.scrollToItem('ctx/c.js');
      bridge.scrollToLine('ctx/c.js', 105, 'RIGHT', { flash: false });
      bridge.selectLines('ctx/c.js', 104, 106, 'RIGHT');
      bridge.scrollToLine('src/b.js', 120, 'RIGHT', { flash: false });
      // The file is taken out again and the other one collapsed, in the same pass.
      bridge.reconcile([diffEntry(A), diffEntry(B)]);
      bridge.setCollapsed('src/b.js', true);
    });
    await Promise.resolve();
    expect(writes()).toEqual([[], ['src/a.js', 'src/b.js']]);
    expect(viewer().count('scrollTo')).toBe(0);
    expect(viewer().count('setSelectedLines')).toBe(0);
  });

  it('what the reader expanded by hand is folded when the write runs', async () => {
    for (const fixture of [A, B]) bridge.upgradeFileContents(fixture.name, fixture.oldFile, fixture.newFile);
    const record = bridge.files.get('src/a.js');
    const map = new Map([[1, { fromStart: 20, fromEnd: 0 }]]);
    record._instance = { hunksRenderer: { expandedHunks: map } };
    const key = record.metadata.cacheKey;
    insideCallback(() => bridge.reconcile(WITH_CONTEXT()));
    // Until the write the viewer's instance is the item's, and the oracle reads its map.
    expect(map.size).toBe(1);
    expect(record.contextRanges).toEqual([]);
    expect(bridge.isLineVisible('src/a.js', 130, 'RIGHT')).toBe(true);
    await Promise.resolve();
    expect(map.size).toBe(0);
    // The diff of the two contents has its first hunk on lines 116-124.
    expect(record.contextRanges).toEqual([{ startLine: 125, endLine: 144 }]);
    expect(record.metadata.cacheKey).not.toBe(key);
    expect(record._instance).toBeNull();
    expect(bridge.isLineVisible('src/a.js', 130, 'RIGHT')).toBe(true);
    expect(viewer().last('setItems').args[0][0].fileDiff).toBe(record.metadata);
  });

  it('a new diff does not fold: its records start from the patch', async () => {
    for (const fixture of [A, B]) bridge.upgradeFileContents(fixture.name, fixture.oldFile, fixture.newFile);
    const old = bridge.files.get('src/a.js');
    old._instance = { hunksRenderer: { expandedHunks: new Map([[1, { fromStart: 20, fromEnd: 0 }]]) } };
    insideCallback(() => bridge.renderAll([diffEntry(A), diffEntry(B)]));
    await Promise.resolve();
    const record = bridge.files.get('src/a.js');
    expect(record).not.toBe(old);
    expect(record.contextRanges).toEqual([]);
    expect(record.metadata).toBe(record.patchMetadata);
    expect(bridge.isLineVisible('src/a.js', 130, 'RIGHT')).toBe(false);
  });
});

describe('contents and derived metadata', () => {
  beforeEach(() => {
    create();
  });

  it('upgradeStrategy: by the type of the diff', () => {
    const strategy = PierreBridge.upgradeStrategy;
    expect(strategy({ type: 'change', hunks: [{}] })).toBe('rediff');
    expect(strategy({ type: 'rename-changed', hunks: [{}] })).toBe('rediff');
    expect(strategy({ type: 'new', hunks: [{}] })).toBe('none');
    expect(strategy({ type: 'deleted', hunks: [{}] })).toBe('none');
    expect(strategy({ type: 'rename-pure', hunks: [] })).toBe('reparse');
    expect(strategy({ type: 'change', hunks: [] })).toBe('reparse');
    expect(strategy(null)).toBe('none');
    expect(strategy({ type: 'change' })).toBe('none');
  });

  it('a changed file\'s two contents are diffed again: the vendor\'s hunks of them, every line of the patch still shown, a new key', () => {
    bridge.renderAll([diffEntry(A)]);
    const record = bridge.files.get('src/a.js');
    const patchKey = record.metadata.cacheKey;
    viewer().calls.length = 0;
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(true);
    expect(record.upgraded).toBe(true);
    expect(record.metadata.isPartial).toBe(false);
    // What the per-file renderer drew: the vendor's diff of the two contents...
    const reference = vendor.parseDiffFromFile(A.oldFile, A.newFile);
    const spans = (metadata) => metadata.hunks.map((h) => [h.additionStart, h.additionCount, h.deletionStart, h.deletionCount]);
    expect(spans(record.baseMetadata)).toEqual(spans(reference));
    // ...with the lines the patch showed kept on screen.
    const patchRanges = record.patchMetadata.hunks.map((h) => ({ startLine: h.additionStart, endLine: h.additionStart + h.additionCount - 1 }));
    expect(record.parityRanges).toEqual(patchRanges);
    expect(spans(record.metadata)).toEqual(spans(env.window.PierreContext.mergeContextRanges(reference, patchRanges)));
    for (const range of patchRanges) {
      for (let line = range.startLine; line <= range.endLine; line++) expect(bridge.isLineVisible('src/a.js', line, 'RIGHT'), `line ${line}`).toBe(true);
    }
    expect(record.metadata.additionLines).toHaveLength(401);
    expect(record.metadata.name).toBe('src/a.js');
    expect(record.metadata.cacheKey).not.toBe(patchKey);
    expect(record.metadata.cacheKey).toBeTruthy();
    expect(record.baseMetadata.cacheKey).toBeTruthy();
    expect(viewer().count('updateItem')).toBe(1);
    expect(viewer().last('updateItem').args[0].fileDiff).toBe(record.metadata);
    // A second call changes nothing.
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(true);
    expect(viewer().count('updateItem')).toBe(1);
  });

  it('a patch with more context than the diff of the contents keeps every one of its lines on screen', () => {
    // Ten lines of context around one changed line; the vendor's diff has four.
    const oldLines = numberedLines(80);
    const newLines = oldLines.slice();
    newLines[39] = 'line 40 changed';
    const hunk = [
      ...oldLines.slice(29, 39).map((line) => ` ${line}`),
      `-${oldLines[39]}`,
      `+${newLines[39]}`,
      ...oldLines.slice(40, 50).map((line) => ` ${line}`),
    ];
    const patch = `diff --git a/wide.js b/wide.js\n--- a/wide.js\n+++ b/wide.js\n@@ -30,21 +30,21 @@\n${hunk.join('\n')}\n`;
    bridge.renderAll([{ id: 'wide.js', kind: 'diff', patch }]);
    const record = bridge.files.get('wide.js');
    expect(bridge.upgradeFileContents('wide.js', { name: 'wide.js', contents: `${oldLines.join('\n')}\n` }, { name: 'wide.js', contents: `${newLines.join('\n')}\n` })).toBe(true);
    expect(record.baseMetadata.hunks.map((h) => [h.additionStart, h.additionCount])).toEqual([[36, 9]]);
    expect(record.parityRanges).toEqual([{ startLine: 30, endLine: 50 }]);
    expect([29, 30, 35, 45, 50, 51].map((line) => bridge.isLineVisible('wide.js', line, 'RIGHT'))).toEqual([false, true, true, true, true, false]);
    // A later reveal keeps them too.
    bridge.addContextRanges('wide.js', [{ startLine: 70, endLine: 72 }]);
    expect([30, 50, 71].map((line) => bridge.isLineVisible('wide.js', line, 'RIGHT'))).toEqual([true, true, true]);
  });

  it('patchParityRanges: one range per hunk that shows a line of the new file', () => {
    const ranges = PierreBridge.patchParityRanges;
    expect(ranges({ hunks: [{ additionStart: 5, additionCount: 7 }, { additionStart: 40, additionCount: 0 }, { additionStart: 90, additionCount: 1 }] }))
      .toEqual([{ startLine: 5, endLine: 11 }, { startLine: 90, endLine: 90 }]);
    expect(ranges({ hunks: [] })).toEqual([]);
    expect(ranges(null)).toEqual([]);
  });

  it('an added and a deleted file are marked as upgraded without a publish', () => {
    const added = 'diff --git a/n.js b/n.js\nnew file mode 100644\n--- /dev/null\n+++ b/n.js\n@@ -0,0 +1,2 @@\n+one\n+two\n';
    const deleted = 'diff --git a/d.js b/d.js\ndeleted file mode 100644\n--- a/d.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n';
    bridge.renderAll([{ id: 'n.js', patch: added }, { id: 'd.js', patch: deleted }]);
    viewer().calls.length = 0;
    expect(bridge.upgradeFileContents('n.js', null, { name: 'n.js', contents: 'one\ntwo\n' })).toBe(true);
    expect(bridge.upgradeFileContents('d.js', { name: 'd.js', contents: 'one\ntwo\n' }, null)).toBe(true);
    expect(viewer().count('updateItem')).toBe(0);
    expect(bridge.files.get('n.js').baseMetadata).toBe(bridge.files.get('n.js').patchMetadata);
    expect(bridge.files.get('d.js').upgraded).toBe(true);
  });

  it('a file without a hunk takes its lines from its contents when both sides are the same text, and stays as it is otherwise', () => {
    const rename = 'diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\n';
    const text = `${numberedLines(40).join('\n')}\n`;
    bridge.renderAll([{ id: 'new.js', patch: rename }, { id: 'other.js', patch: rename }, { id: 'binary.bin', patch: rename }]);
    viewer().calls.length = 0;
    expect(bridge.upgradeFileContents('new.js', { name: 'old.js', contents: text }, { name: 'new.js', contents: text })).toBe(true);
    const record = bridge.files.get('new.js');
    expect(record.baseMetadata.hunks).toEqual([]);
    expect(record.baseMetadata.additionLines).toHaveLength(40);
    // Still header-only: nothing to publish until a line is revealed.
    expect(viewer().count('updateItem')).toBe(0);
    expect(bridge.addContextRanges('new.js', [{ startLine: 5, endLine: 8 }])).toBe(true);
    expect(bridge.isLineVisible('new.js', 6, 'RIGHT')).toBe(true);
    expect(viewer().count('updateItem')).toBe(1);

    // Different texts, or not text: the patch's metadata stays, and a range has nothing to show.
    expect(bridge.upgradeFileContents('other.js', { name: 'old.js', contents: 'a\n' }, { name: 'other.js', contents: 'b\n' })).toBe(true);
    expect(bridge.upgradeFileContents('binary.bin', { name: 'binary.bin', contents: 'a\u0000b' }, { name: 'binary.bin', contents: 'a\u0000b' })).toBe(true);
    for (const id of ['other.js', 'binary.bin']) {
      expect(bridge.files.get(id).baseMetadata, id).toBe(bridge.files.get(id).patchMetadata);
      bridge.addContextRanges(id, [{ startLine: 1, endLine: 3 }]);
      expect(bridge.isLineVisible(id, 2, 'RIGHT'), id).toBe(false);
      expect(bridge.files.get(id).metadata.hunks, id).toEqual([]);
    }
  });

  it('contents the vendor cannot diff leave the file as it was and say so', () => {
    bridge.renderAll([diffEntry(A)]);
    const parse = env.window.PierreDiffs.parseDiffFromFile;
    env.window.PierreDiffs.parseDiffFromFile = () => { throw new Error('contents do not match'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('src/a.js'), expect.any(Error));
    warn.mockRestore();
    env.window.PierreDiffs.parseDiffFromFile = parse;
    const record = bridge.files.get('src/a.js');
    expect(record.upgraded).toBe(false);
    expect(record.metadata).toBe(record.patchMetadata);
    expect(record.parityRanges).toEqual([]);
  });

  it('a changed file with one side of its contents missing, or with both sides the same, keeps the diff of its patch', () => {
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    viewer().calls.length = 0;
    expect(bridge.upgradeFileContents('src/a.js', null, A.newFile)).toBe(false);
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, null)).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(bridge.upgradeFileContents('src/b.js', B.newFile, B.newFile)).toBe(false);
    warn.mockRestore();
    for (const id of ['src/a.js', 'src/b.js']) {
      expect(bridge.files.get(id).upgraded, id).toBe(false);
      expect(bridge.files.get(id).metadata, id).toBe(bridge.files.get(id).patchMetadata);
    }
    expect(viewer().count('updateItem')).toBe(0);
    // The contents can still arrive later.
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(true);
  });

  it('a file the bridge does not hold, a context file and a deferred file are not upgraded', () => {
    bridge.renderAll([contextEntry('ctx/c.js'), diffEntry(A, { deferred: true })]);
    expect(bridge.upgradeFileContents('nope.js', A.oldFile, A.newFile)).toBe(false);
    expect(bridge.upgradeFileContents('ctx/c.js', A.oldFile, A.newFile)).toBe(false);
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(false);
  });

  it('forcePlainText: the patch\'s metadata and the one made from the contents are both plain text', () => {
    bridge.renderAll([diffEntry(A, { forcePlainText: true })]);
    expect(bridge.files.get('src/a.js').metadata.lang).toBe('text');
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    expect(bridge.files.get('src/a.js').metadata.lang).toBe('text');
  });

  it('rekey: a new key for every derived metadata of a record, never one it had', () => {
    bridge.renderAll([diffEntry(A)]);
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    const record = bridge.files.get('src/a.js');
    const keys = [record.patchMetadata.cacheKey, record.metadata.cacheKey];
    for (const line of [30, 60, 180, 320]) {
      bridge.addContextRanges('src/a.js', [{ startLine: line, endLine: line + 2 }]);
      keys.push(record.metadata.cacheKey);
    }
    expect(new Set(keys).size).toBe(keys.length);
    const copy = PierreBridge.rekey(record, record.metadata);
    expect(copy).not.toBe(record.metadata);
    expect(keys).not.toContain(copy.cacheKey);
  });

  it('a range asked for before the contents are loaded is kept and applied with them', () => {
    bridge.renderAll([diffEntry(A)]);
    viewer().calls.length = 0;
    expect(bridge.addContextRanges('src/a.js', [{ startLine: 30, endLine: 34 }])).toBe(false);
    expect(viewer().count('updateItem')).toBe(0);
    expect(bridge.isLineVisible('src/a.js', 32, 'RIGHT')).toBe(false);
    expect(bridge.convertOldToNew('src/a.js', 300, 301)).toBeNull();
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    expect(bridge.isLineVisible('src/a.js', 32, 'RIGHT')).toBe(true);
    expect(viewer().count('updateItem')).toBe(1);
    // One line was inserted above old line 300.
    expect(bridge.convertOldToNew('src/a.js', 300, 301)).toEqual({ startLine: 301, endLine: 302 });
  });

  it('a range that adds nothing publishes nothing', () => {
    bridge.renderAll([diffEntry(A)]);
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    viewer().calls.length = 0;
    const key = bridge.files.get('src/a.js').metadata.cacheKey;
    // Inside the first hunk (117-123).
    expect(bridge.addContextRanges('src/a.js', [{ startLine: 118, endLine: 120 }])).toBe(true);
    expect(viewer().count('updateItem')).toBe(0);
    expect(bridge.files.get('src/a.js').metadata.cacheKey).toBe(key);
  });

  it('materializeDeferred parses the patch, drops the notice and publishes on the same item', () => {
    bridge.renderAll([diffEntry(A, { deferred: true, notice: { message: 'Large diff' } })]);
    viewer().calls.length = 0;
    const keyBefore = bridge.files.get('src/a.js').metadata.cacheKey;
    expect(bridge.materializeDeferred('src/a.js')).toBe(true);
    const record = bridge.files.get('src/a.js');
    expect(record.deferred).toBe(false);
    expect(record.metadata.hunks).toHaveLength(2);
    expect(record.metadata.cacheKey).not.toBe(keyBefore);
    expect(viewer().count('updateItem')).toBe(1);
    expect(viewer().last('updateItem').args[0].annotations.map((a) => a.metadata.type)).toEqual(['file-comments']);
    expect(bridge.getDiffPosition('src/a.js', 120, 'RIGHT')).toBeGreaterThan(0);
    expect(bridge.materializeDeferred('src/a.js')).toBe(true);
    expect(viewer().count('updateItem')).toBe(1);
    expect(bridge.materializeDeferred('nope.js')).toBe(false);
  });
});

describe('the visibility oracle', () => {
  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A)]);
  });

  it('answers from the published hunks, on either side', () => {
    // Hunks: old 117-123 / new 117-123, old 247-252 / new 247-253.
    expect(bridge.isLineVisible('src/a.js', 117, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 123, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 124, 'RIGHT')).toBe(false);
    expect(bridge.isLineVisible('src/a.js', 253, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 253, 'LEFT')).toBe(false);
    expect(bridge.isLineVisible('src/a.js', 252, 'deletions')).toBe(true);
    expect(bridge.isLineVisible('nope.js', 117, 'RIGHT')).toBe(false);
  });

  it('a collapsed file shows no line', () => {
    bridge.setCollapsed('src/a.js', true);
    expect(bridge.isLineVisible('src/a.js', 117, 'RIGHT')).toBe(false);
    bridge.setCollapsed('src/a.js', false);
    expect(bridge.isLineVisible('src/a.js', 117, 'RIGHT')).toBe(true);
  });

  it('counts what the reader expanded by hand, read from the viewer instance\'s own record, and gaps of five lines or fewer', () => {
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    const record = bridge.files.get('src/a.js');
    // Gap 1 is new lines 125-245. The instance is what the bridge learns from the viewer's mount callback.
    record._instance = { hunksRenderer: { expandedHunks: new Map([[1, { fromStart: 20, fromEnd: 0 }]]) } };
    expect(bridge.isLineVisible('src/a.js', 125, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 144, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 145, 'RIGHT')).toBe(false);
    // Old numbering on the left: the same lines are old 125-144 (nothing was inserted above them).
    expect(bridge.isLineVisible('src/a.js', 144, 'LEFT')).toBe(true);

    // A range that leaves a gap of five lines before the second hunk: the viewer paints such a gap in full.
    record._instance.hunksRenderer.expandedHunks.clear();
    bridge.addContextRanges('src/a.js', [{ startLine: 230, endLine: 241 }]);
    expect(bridge.isLineVisible('src/a.js', 244, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 229, 'RIGHT')).toBe(false);
  });

  it('a later reveal folds manual expansions into the file\'s ranges and clears the viewer\'s record of them', () => {
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    const record = bridge.files.get('src/a.js');
    const map = new Map([[1, { fromStart: 20, fromEnd: Infinity }], [0, { fromStart: 0, fromEnd: 10 }]]);
    record._instance = { hunksRenderer: { expandedHunks: map } };
    const resetLayoutCache = vi.fn();
    record._instance.resetLayoutCache = resetLayoutCache;
    bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
    expect(map.size).toBe(0);
    // The file is not on screen: its height is computed again when it is, once.
    expect(resetLayoutCache.mock.calls).toEqual([[{ includeEstimatedHeights: true }]]);
    // Infinity is the whole gap (125-245), clamped to it; ten lines before the first hunk.
    expect(record.contextRanges).toEqual([{ startLine: 106, endLine: 115 }, { startLine: 125, endLine: 245 }, { startLine: 300, endLine: 302 }]);
    expect(bridge.isLineVisible('src/a.js', 200, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 105, 'RIGHT')).toBe(false);
  });

  it('a reveal on a file with nothing expanded by hand does not touch the viewer\'s layout', () => {
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    const record = bridge.files.get('src/a.js');
    const resetLayoutCache = vi.fn();
    record._instance = { hunksRenderer: { expandedHunks: new Map() }, resetLayoutCache };
    bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
    expect(resetLayoutCache).not.toHaveBeenCalled();
    // And an instance of a viewer without that method is left alone.
    record._instance = { hunksRenderer: { expandedHunks: new Map([[0, { fromStart: 0, fromEnd: 3 }]]) } };
    expect(() => bridge.addContextRanges('src/a.js', [{ startLine: 400, endLine: 401 }])).not.toThrow();
    expect(record._instance.hunksRenderer.expandedHunks.size).toBe(0);
  });
});

describe('context records', () => {
  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A), contextEntry('ctx/c.js')]);
    viewer().calls.length = 0;
  });

  it('the metadata is the vendor\'s diff of the file with itself, made one-sided, with the ranges merged in', () => {
    const record = bridge.files.get('ctx/c.js');
    expect(record.baseMetadata).toMatchObject({ type: 'new', isPartial: false });
    expect(record.baseMetadata.hunks).toEqual([]);
    expect(record.metadata.type).toBe('new');
    expect(record.metadata.hunks.map((h) => [h.additionStart, h.additionCount])).toEqual([[100, 21], [300, 11]]);
    expect(record.metadata.cacheKey).not.toBe(record.baseMetadata.cacheKey);
    expect(record.upgraded).toBe(true);
    expect(record.file.contents.split('\n')).toHaveLength(401);
  });

  it('every annotation is published on the additions side and keeps its stored side in its data', () => {
    const left = { id: 1, side: 'LEFT' };
    bridge.addAnnotation('ctx/c.js', { lineNumber: 105, side: 'LEFT', type: 'comment', data: left, id: 'comment-1' });
    bridge.addAnnotation('ctx/c.js', { lineNumber: 110, side: 'deletions', type: 'card', data: {} });
    const [first, second] = bridge.getAnnotations('ctx/c.js');
    expect([first.side, second.side]).toEqual(['additions', 'additions']);
    expect(first.metadata.data).toBe(left);
    expect(first.metadata.data.side).toBe('LEFT');
    expect(second.metadata.id).toMatch(/^card-110-additions-\d+$/);
    // On a changed file the stored side is the published side.
    bridge.addAnnotation('src/a.js', { lineNumber: 120, side: 'LEFT', type: 'card', data: {}, id: 'card-left' });
    expect(bridge.getAnnotations('src/a.js')[0].side).toBe('deletions');
  });

  it('side does not matter to the oracle, old and new numbers are the same, and there is no diff position', () => {
    expect(bridge.isLineVisible('ctx/c.js', 110, 'LEFT')).toBe(true);
    expect(bridge.isLineVisible('ctx/c.js', 110, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('ctx/c.js', 200, 'LEFT')).toBe(false);
    expect(bridge.convertOldToNew('ctx/c.js', 40, 44)).toEqual({ startLine: 40, endLine: 44 });
    expect(bridge.getDiffPosition('ctx/c.js', 110, 'RIGHT')).toBeNull();
    expect(bridge.getDiffPosition('src/a.js', 120, 'RIGHT')).toBeGreaterThan(0);
    expect(bridge.getDiffPosition('nope.js', 1, 'RIGHT')).toBeNull();
  });

  it('a line scroll target and a selection on a context file are on the additions side', () => {
    expect(bridge.scrollToLine('ctx/c.js', 110, 'LEFT', { behavior: 'instant', flash: false })).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'line', id: 'ctx/c.js', lineNumber: 110, side: 'additions', align: 'center', behavior: 'instant' });
    bridge.selectLines('ctx/c.js', 104, 106, 'LEFT');
    expect(viewer().last('setSelectedLines').args[0]).toEqual({ id: 'ctx/c.js', range: { start: 104, end: 106, side: 'additions' } });
    expect(bridge.getLineSelection('ctx/c.js')).toEqual({ start: 104, end: 106, side: 'RIGHT' });
    // A line the file does not show cannot be scrolled to.
    viewer().calls.length = 0;
    expect(bridge.scrollToLine('ctx/c.js', 200, 'RIGHT')).toBe(false);
    expect(viewer().count('scrollTo')).toBe(0);
  });

  it('addContextRanges reveals lines of a context file through the same derivation', () => {
    const before = bridge.files.get('ctx/c.js').metadata.cacheKey;
    expect(bridge.addContextRanges('ctx/c.js', [{ startLine: 195, endLine: 205 }])).toBe(true);
    const record = bridge.files.get('ctx/c.js');
    expect(record.storedRanges).toEqual([{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }]);
    expect(record.contextRanges).toEqual([{ startLine: 195, endLine: 205 }]);
    expect(record.metadata.hunks.map((h) => h.additionStart)).toEqual([100, 195, 300]);
    expect(record.metadata.type).toBe('new');
    expect(record.metadata.cacheKey).not.toBe(before);
    expect(viewer().count('updateItem')).toBe(1);
  });

  it('contextLanguage: plain text above the size limits and for a file with a NUL character', () => {
    const lang = PierreBridge.contextLanguage;
    expect(lang('const a = 1;\n')).toBeUndefined();
    expect(lang('')).toBeUndefined();
    expect(lang(null)).toBeUndefined();
    expect(lang(`${'x\n'.repeat(11999)}`)).toBeUndefined();
    expect(lang(`${'x\n'.repeat(12000)}`)).toBe('text');
    expect(lang('y'.repeat(400 * 1024))).toBeUndefined();
    expect(lang('y'.repeat(400 * 1024 + 1))).toBe('text');
    expect(lang('a\u0000b')).toBe('text');
  });

  it('a context file too large to colour carries lang "text" on its file and its metadata', () => {
    bridge.renderAll([contextEntry('ctx/big.txt', { contents: 'x\n'.repeat(12001), ranges: [{ startLine: 1, endLine: 10 }] })]);
    const record = bridge.files.get('ctx/big.txt');
    expect(record.file.lang).toBe('text');
    expect(record.baseMetadata.lang).toBe('text');
    expect(record.metadata.lang).toBe('text');
  });

  it('an empty file and a range past the end are header-only', () => {
    bridge.renderAll([contextEntry('ctx/empty.txt', { contents: '' }), contextEntry('ctx/short.js', { contents: 'a\nb\n', ranges: [{ startLine: 50, endLine: 60 }] })]);
    for (const id of ['ctx/empty.txt', 'ctx/short.js']) {
      expect(bridge.files.get(id).metadata.hunks, id).toEqual([]);
      expect(bridge.isLineVisible(id, 1, 'RIGHT'), id).toBe(false);
    }
  });
});

describe('reconcile', () => {
  const rendered = () => {
    create();
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    viewer().calls.length = 0;
  };
  const refused = (reason) => ({ applied: false, created: [], removed: [], updated: [], listWritten: false, reason });

  it('does nothing before the first list', () => {
    create();
    expect(bridge.reconcile([diffEntry(A)])).toEqual(refused('not-rendered'));
  });

  it('refuses entries whose changed files are not the pane\'s, in order', () => {
    rendered();
    expect(bridge.reconcile([diffEntry(A)])).toEqual(refused('stale-entries'));
    expect(bridge.reconcile([diffEntry(B), diffEntry(A)])).toEqual(refused('stale-entries'));
    expect(bridge.reconcile([diffEntry(A), diffEntry(B), diffEntry(changedFileFixture('src/c.js'))])).toEqual(refused('stale-entries'));
    expect(bridge.reconcile('nope')).toEqual(refused('no-list'));
    expect(viewer().calls).toEqual([]);
  });

  it('a context file added: the list is written once, cleared first, and every other record is the same object', () => {
    rendered();
    const [recordA, recordB] = [bridge.files.get('src/a.js'), bridge.files.get('src/b.js')];
    bridge.addAnnotation('src/a.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'kept' });
    viewer().calls.length = 0;
    const outcome = bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js'), diffEntry(B)]);
    expect(outcome).toEqual({ applied: true, created: ['ctx/c.js'], removed: [], updated: [], listWritten: true });
    expect([...bridge.files.keys()]).toEqual(['src/a.js', 'ctx/c.js', 'src/b.js']);
    expect(bridge.files.get('src/a.js')).toBe(recordA);
    expect(bridge.files.get('src/b.js')).toBe(recordB);
    expect(bridge.hasAnnotation('src/a.js', 'kept')).toBe(true);
    const writes = viewer().calls.filter((c) => c.name === 'setItems').map((c) => c.args[0].map((item) => item.id));
    expect(writes).toEqual([[], ['src/a.js', 'ctx/c.js', 'src/b.js']]);
    expect(viewer().count('updateItem')).toBe(0);
    // The kept file's item carries its annotation and its metadata object.
    const sent = viewer().last('setItems').args[0][0];
    expect(sent.fileDiff).toBe(recordA.metadata);
    expect(sent.annotations.map((a) => a.metadata.id)).toEqual(['file-comments', 'kept']);
  });

  it('a context file removed: its record and annotations go, the list is written', () => {
    rendered();
    bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js'), diffEntry(B)]);
    bridge.addAnnotation('ctx/c.js', { lineNumber: 105, side: 'RIGHT', type: 'card', data: {}, id: 'gone' });
    viewer().calls.length = 0;
    expect(bridge.reconcile([diffEntry(A), diffEntry(B)])).toEqual({ applied: true, created: [], removed: ['ctx/c.js'], updated: [], listWritten: true });
    expect(bridge.files.has('ctx/c.js')).toBe(false);
    expect(bridge.hasAnnotation('ctx/c.js', 'gone')).toBe(false);
    expect(bridge.getAnnotationElement('ctx/c.js', 'gone', { create: true })).toBeNull();
    expect(bridge.findAnnotationFile('gone')).toBeNull();
    expect(viewer().count('setItems')).toBe(2);
  });

  it('the same ids: no list write; changed ranges and changed contents are published on the item, unchanged entries are not', () => {
    rendered();
    bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js'), diffEntry(B)]);
    const record = bridge.files.get('ctx/c.js');
    viewer().calls.length = 0;

    expect(bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js'), diffEntry(B)])).toEqual({ applied: true, created: [], removed: [], updated: [], listWritten: false });
    expect(viewer().calls).toEqual([]);

    const keyBefore = record.metadata.cacheKey;
    expect(bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js', { ranges: [{ startLine: 100, endLine: 140 }] }), diffEntry(B)]).updated).toEqual(['ctx/c.js']);
    expect(bridge.files.get('ctx/c.js')).toBe(record);
    expect(record.storedRanges).toEqual([{ startLine: 100, endLine: 140 }]);
    expect(record.metadata.cacheKey).not.toBe(keyBefore);
    expect(viewer().count('setItems')).toBe(0);
    expect(viewer().count('updateItem')).toBe(1);
    expect(viewer().count('render')).toBe(1);

    const baseKey = record.baseKey;
    const changed = `${numberedLines(50, 'new text').join('\n')}\n`;
    expect(bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js', { contents: changed, contentsSeq: 2, ranges: [{ startLine: 1, endLine: 10 }] }), diffEntry(B)]).updated).toEqual(['ctx/c.js']);
    expect(record.baseKey).not.toBe(baseKey);
    expect(record.file.contents).toBe(changed);
    expect(record.metadata.additionLines).toHaveLength(50);
    expect(viewer().count('setItems')).toBe(0);
    expect(viewer().count('updateItem')).toBe(2);
  });

  it('stored ranges are replaced and the ranges the reader revealed stay', () => {
    rendered();
    bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js'), diffEntry(B)]);
    bridge.addContextRanges('ctx/c.js', [{ startLine: 200, endLine: 204 }]);
    bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js', { ranges: [{ startLine: 350, endLine: 360 }] }), diffEntry(B)]);
    const record = bridge.files.get('ctx/c.js');
    expect(record.storedRanges).toEqual([{ startLine: 350, endLine: 360 }]);
    expect(record.contextRanges).toEqual([{ startLine: 200, endLine: 204 }]);
    expect([110, 202, 355].map((n) => bridge.isLineVisible('ctx/c.js', n, 'RIGHT'))).toEqual([false, true, true]);
  });

  it('a list write folds what the reader expanded by hand into ranges and re-keys only those records', () => {
    rendered();
    for (const fixture of [A, B]) bridge.upgradeFileContents(fixture.name, fixture.oldFile, fixture.newFile);
    const [recordA, recordB] = [bridge.files.get('src/a.js'), bridge.files.get('src/b.js')];
    const map = new Map([[1, { fromStart: 20, fromEnd: 0 }]]);
    recordA._instance = { hunksRenderer: { expandedHunks: map } };
    recordB._instance = { hunksRenderer: { expandedHunks: new Map() } };
    const [keyA, keyB, metadataB] = [recordA.metadata.cacheKey, recordB.metadata.cacheKey, recordB.metadata];
    bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js'), diffEntry(B)]);
    expect(recordA.contextRanges).toEqual([{ startLine: 125, endLine: 144 }]);
    expect(recordA.metadata.cacheKey).not.toBe(keyA);
    expect(map.size).toBe(0);
    expect(bridge.isLineVisible('src/a.js', 130, 'RIGHT')).toBe(true);
    // Untouched: the same metadata object under the same key.
    expect(recordB.metadata).toBe(metadataB);
    expect(recordB.metadata.cacheKey).toBe(keyB);
    // The viewer makes new instances for a new list.
    expect(recordA._instance).toBeNull();
  });

  it('a context path that became a changed file, or the other way round, gets a new record of the new kind', () => {
    create();
    bridge.renderAll([diffEntry(A), contextEntry('src/b.js')]);
    const contextRecord = bridge.files.get('src/b.js');
    bridge.addAnnotation('src/b.js', { lineNumber: 105, side: 'RIGHT', type: 'card', data: {}, id: 'old' });
    // The pane's changed files are unchanged, so this is still a reconcile; the entry's kind changed.
    const outcome = bridge.reconcile([diffEntry(A), contextEntry('src/b.js', { kind: 'context' })]);
    expect(outcome.listWritten).toBe(false);
    expect(bridge.files.get('src/b.js')).toBe(contextRecord);
  });

  it('whenIdle: waits while list writes are held, the latest request wins, and a direct call supersedes it', () => {
    rendered();
    const release = bridge.holdListWrites();
    const deferred = { applied: false, created: [], removed: [], updated: [], listWritten: false, deferred: true };
    expect(bridge.reconcile([diffEntry(A), contextEntry('ctx/one.js'), diffEntry(B)], { whenIdle: true })).toEqual(deferred);
    expect(bridge.reconcile(() => [diffEntry(A), diffEntry(B), contextEntry('ctx/two.js')], { whenIdle: true })).toEqual(deferred);
    expect(viewer().count('setItems')).toBe(0);
    release();
    release();
    expect([...bridge.files.keys()]).toEqual(['src/a.js', 'src/b.js', 'ctx/two.js']);

    const again = bridge.holdListWrites();
    bridge.reconcile([diffEntry(A), diffEntry(B)], { whenIdle: true });
    // Asked for by the reader: runs now, and nothing stale runs later.
    expect(bridge.reconcile([diffEntry(A), contextEntry('ctx/three.js'), diffEntry(B)]).applied).toBe(true);
    again();
    expect([...bridge.files.keys()]).toEqual(['src/a.js', 'ctx/three.js', 'src/b.js']);
  });

  it('whenIdle without a hold runs at once; a new diff drops a waiting reconcile', () => {
    rendered();
    expect(bridge.reconcile([diffEntry(A), contextEntry('ctx/one.js'), diffEntry(B)], { whenIdle: true }).applied).toBe(true);
    const release = bridge.holdListWrites();
    bridge.reconcile([diffEntry(A), diffEntry(B)], { whenIdle: true });
    bridge.renderAll([diffEntry(B)]);
    release();
    expect([...bridge.files.keys()]).toEqual(['src/b.js']);
  });
});

describe('paths in another form', () => {
  it('every function that takes a file resolves it once: "./" and "/" prefixes by itself, anything else through the hook', () => {
    const resolvePath = vi.fn((path) => (path === 'old/name.js => src/a.js' ? 'src/a.js' : null));
    create({ hooks: { resolvePath } });
    bridge.renderAll([diffEntry(A)]);
    expect(bridge.resolveFileId('src/a.js')).toBe('src/a.js');
    // An exact id never reaches the hook.
    expect(resolvePath).not.toHaveBeenCalled();
    expect(bridge.resolveFileId('./src/a.js')).toBe('src/a.js');
    expect(bridge.resolveFileId('/src/a.js')).toBe('src/a.js');
    expect(bridge.resolveFileId('old/name.js => src/a.js')).toBe('src/a.js');
    expect(bridge.resolveFileId('nope.js')).toBeNull();
    expect(bridge.resolveFileId(undefined)).toBeNull();
    expect(bridge.resolveFileId(42)).toBeNull();

    bridge.addAnnotation('./src/a.js', { lineNumber: 118, side: 'RIGHT', type: 'card', data: {}, id: 'one' });
    bridge.setCollapsed('/src/a.js', true);
    expect(bridge.hasAnnotation('src/a.js', 'one')).toBe(true);
    expect(bridge.findAnnotationFile('one', './src/a.js')).toBe('src/a.js');
    expect(bridge.files.get('src/a.js').collapsed).toBe(true);
    expect([...bridge.files.keys()]).toEqual(['src/a.js']);
    // The viewer is addressed by the canonical id.
    expect(viewer().last('updateItem').args[0].id).toBe('src/a.js');
  });

  it('a hook that throws is reported and the path is not resolved by it', () => {
    create({ hooks: { resolvePath: () => { throw new Error('boom'); } } });
    bridge.renderAll([diffEntry(A)]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(bridge.resolveFileId('./src/a.js')).toBe('src/a.js');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('scroll targets, selection, code text', () => {
  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A)]);
    viewer().calls.length = 0;
  });

  it('scrollToItem and scrollToLine send the viewer\'s own targets and never a position', () => {
    expect(bridge.scrollToItem('src/a.js')).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'item', id: 'src/a.js', align: 'start', behavior: 'instant' });
    expect(bridge.scrollToItem('./src/a.js', { align: 'center', behavior: 'smooth', offset: 12 })).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'item', id: 'src/a.js', align: 'center', behavior: 'smooth', offset: 12 });
    expect(bridge.scrollToLine('src/a.js', 120, 'LEFT', { flash: false })).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'line', id: 'src/a.js', lineNumber: 120, side: 'deletions', align: 'center', behavior: 'smooth' });
    expect(viewer().calls.some((c) => c.name === 'scrollTo' && c.args[0].type === 'position')).toBe(false);
  });

  it('scrollToLine answers false, and scrolls nowhere, for a line the data does not show', () => {
    expect(bridge.scrollToLine('src/a.js', 10, 'RIGHT')).toBe(false);
    expect(bridge.scrollToLine('nope.js', 120, 'RIGHT')).toBe(false);
    expect(bridge.scrollToItem('nope.js')).toBe(false);
    bridge.setCollapsed('src/a.js', true);
    viewer().calls.length = 0;
    expect(bridge.scrollToLine('src/a.js', 120, 'RIGHT')).toBe(false);
    expect(viewer().count('scrollTo')).toBe(0);
  });

  it('the boolean form only flashes', () => {
    expect(bridge.scrollToLine('src/a.js', 120, 'RIGHT', false)).toBe(true);
    expect(viewer().count('scrollTo')).toBe(0);
  });

  it('the selection belongs to one file and is answered in the app\'s sides, low line first', () => {
    bridge.selectLines('src/a.js', 122, 118, 'LEFT');
    expect(viewer().last('setSelectedLines').args[0]).toEqual({ id: 'src/a.js', range: { start: 122, end: 118, side: 'deletions' } });
    expect(bridge.getLineSelection('src/a.js')).toEqual({ start: 118, end: 122, side: 'LEFT' });
    expect(bridge.getLineSelection('nope.js')).toBeNull();
    bridge.clearLineSelection('nope.js');
    expect(viewer().count('clearSelectedLines')).toBe(0);
    bridge.clearLineSelection('src/a.js');
    expect(bridge.getLineSelection('src/a.js')).toBeNull();
  });

  it('getCodeFromLines reads the lines the file shows, on either side', () => {
    expect(bridge.getCodeFromLines('src/a.js', 119, 121, 'RIGHT').split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['line 119', 'changed 120', 'line 121']);
    expect(bridge.getCodeFromLines('src/a.js', 120, 120, 'LEFT').trim()).toBe('line 120');
    expect(bridge.getCodeFromLines('src/a.js', 10, 12, 'RIGHT')).toBeNull();
    expect(bridge.getCodeFromLines('nope.js', 1, 2, 'RIGHT')).toBeNull();
  });

  it('getCodeFromLines on a context file answers the lines it shows, without their line breaks, whatever the side', () => {
    // Stored ranges 4-24 and 28-40 of 400 lines: 1-3 and 25-27 are gaps the viewer paints in full.
    bridge.renderAll([diffEntry(A), contextEntry('ctx/c.js', { ranges: [{ startLine: 4, endLine: 24 }, { startLine: 28, endLine: 40 }] })]);
    const text = (from, to) => numberedLines(400).slice(from - 1, to).join('\n');
    expect(bridge.getCodeFromLines('ctx/c.js', 10, 12, 'RIGHT')).toBe(text(10, 12));
    expect(bridge.getCodeFromLines('ctx/c.js', 10, 10, 'LEFT')).toBe(text(10, 10));
    expect(bridge.getCodeFromLines('ctx/c.js', 2, 2, 'RIGHT')).toBe(text(2, 2));
    expect(bridge.getCodeFromLines('ctx/c.js', 20, 30, 'RIGHT')).toBe(text(20, 30));
    for (const line of [2, 26, 30]) expect(bridge.isLineVisible('ctx/c.js', line, 'RIGHT')).toBe(true);
    // A hidden line has no text to offer; a range that runs into hidden lines holds the shown ones.
    expect(bridge.isLineVisible('ctx/c.js', 41, 'RIGHT')).toBe(false);
    expect(bridge.getCodeFromLines('ctx/c.js', 41, 60, 'RIGHT')).toBeNull();
    expect(bridge.getCodeFromLines('ctx/c.js', 39, 45, 'RIGHT')).toBe(text(39, 40));
    expect(bridge.getCodeFromLines('ctx/c.js', 399, 450, 'RIGHT')).toBeNull();
  });
});

describe('navigation to what is not mounted, a collapse while inside a file, a flashed range', () => {
  /** A host for a file, as the viewer's mount callback hands it over: an element in the document, `box` its place. */
  function mount(id, { box = { top: 0, bottom: 400 }, renderedDiff } = {}) {
    const host = env.window.document.createElement('div');
    env.window.document.body.appendChild(host);
    host.getBoundingClientRect = () => ({ top: box.top, bottom: box.bottom, height: box.bottom - box.top, left: 0, right: 100, width: 100 });
    const instance = { hunksRenderer: { expandedHunks: new Map() }, getRenderedDiff: () => renderedDiff ?? bridge.files.get(id).metadata };
    const context = { item: { id }, element: host, instance };
    viewer().options.onPostRender(host, instance, 'mount', context);
    return { host, instance, context };
  }

  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A), diffEntry(B)]);
    viewer().calls.length = 0;
  });

  it('scrollToAnnotation sends a line target for a card that is not in the document, an item target for a file-level one', () => {
    bridge.addAnnotation('src/a.js', { lineNumber: 120, side: 'LEFT', type: 'card', data: {}, id: 'on-line' });
    bridge.addAnnotation('src/a.js', { lineNumber: 0, side: 'RIGHT', type: 'card', data: {}, id: 'file-level' });
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation('src/a.js', 'on-line')).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'line', id: 'src/a.js', lineNumber: 120, side: 'deletions', align: 'start', behavior: 'instant' });
    expect(bridge.scrollToAnnotation('./src/a.js', 'file-level', { behavior: 'smooth' })).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'item', id: 'src/a.js', align: 'start', behavior: 'smooth' });
    expect(viewer().calls.some((c) => c.name === 'scrollTo' && c.args[0].type === 'position')).toBe(false);
  });

  it('scrollToAnnotation moves nothing for a card that is in the document, and answers false where the file does not show the line', () => {
    bridge.registerAnnotationRenderer('card', () => env.window.document.createElement('div'));
    bridge.addAnnotation('src/a.js', { lineNumber: 120, side: 'RIGHT', type: 'card', data: {}, id: 'shown' });
    bridge.addAnnotation('src/a.js', { lineNumber: 10, side: 'RIGHT', type: 'card', data: {}, id: 'hidden-line' });
    const card = bridge.getAnnotationElement('src/a.js', 'shown', { create: true });
    env.window.document.body.appendChild(card);
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation('src/a.js', 'shown')).toBe(true);
    expect(bridge.scrollToAnnotation('src/a.js', 'hidden-line')).toBe(false);
    expect(bridge.scrollToAnnotation('src/a.js', 'no-such-card')).toBe(false);
    expect(bridge.scrollToAnnotation('nope.js', 'shown')).toBe(false);
    bridge.setCollapsed('src/a.js', true);
    card.remove();
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation('src/a.js', 'shown')).toBe(false);
    expect(viewer().count('scrollTo')).toBe(0);
  });

  /**
   * A file's element as the viewer builds it: the card of every annotation
   * is a child of the element, in a wrapper that names a slot; the slot is
   * in the row under the card's line, and only the rows of the row window
   * exist. `drawRow(name)` adds the slot of a row to the shadow tree.
   */
  function fileElement(id, { renderedDiff, rows = 3 } = {}) {
    const { host } = mount(id, { renderedDiff });
    const shadow = host.attachShadow({ mode: 'open' });
    const column = env.window.document.createElement('div');
    column.setAttribute('data-content', '');
    for (let i = 0; i < rows; i++) column.appendChild(env.window.document.createElement('div'));
    shadow.appendChild(column);
    const wrap = (card, name) => {
      const wrapper = env.window.document.createElement('div');
      wrapper.slot = name;
      wrapper.appendChild(card);
      host.appendChild(wrapper);
      return wrapper;
    };
    const drawRow = (name) => {
      const slot = env.window.document.createElement('slot');
      slot.name = name;
      shadow.appendChild(slot);
      return slot;
    };
    return { host, wrap, drawRow };
  }

  it('isElementDrawn: a card in a file\'s element is drawn when the row under its line is, not when it is in the document', () => {
    const doc = env.window.document;
    const { wrap, drawRow } = fileElement('src/a.js');
    const card = doc.createElement('div');
    const inner = doc.createElement('span');
    card.appendChild(inner);
    expect(bridge.isElementDrawn(null)).toBe(false);
    expect(bridge.isElementDrawn(card)).toBe(false);
    // In the document, with no row to be shown in: a line outside the row window.
    wrap(card, 'annotation-additions-8000');
    expect(card.isConnected).toBe(true);
    expect(bridge.isElementDrawn(card)).toBe(false);
    expect(bridge.isElementDrawn(inner)).toBe(false);
    // The window moves over the line.
    const slot = drawRow('annotation-additions-8000');
    expect(bridge.isElementDrawn(card)).toBe(true);
    expect(bridge.isElementDrawn(inner)).toBe(true);
    // And away again.
    slot.remove();
    expect(bridge.isElementDrawn(card)).toBe(false);
    // An element that is in no file's element: in the document is all there is to ask.
    const loose = doc.createElement('div');
    expect(bridge.isElementDrawn(loose)).toBe(false);
    doc.body.appendChild(loose);
    expect(bridge.isElementDrawn(loose)).toBe(true);
  });

  it('scrollToAnnotation sends the line target for a card that is in the document and not drawn, and nothing once it is drawn', () => {
    bridge.registerAnnotationRenderer('card', () => env.window.document.createElement('div'));
    bridge.addAnnotation('src/a.js', { lineNumber: 120, side: 'RIGHT', type: 'card', data: {}, id: 'far' });
    bridge.addAnnotation('src/a.js', { lineNumber: 0, side: 'RIGHT', type: 'card', data: {}, id: 'file-level' });
    const { wrap, drawRow } = fileElement('src/a.js');
    wrap(bridge.getAnnotationElement('src/a.js', 'far', { create: true }), 'annotation-additions-120');
    wrap(bridge.getAnnotationElement('src/a.js', 'file-level', { create: true }), 'annotation-additions-0');
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation('src/a.js', 'far')).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'line', id: 'src/a.js', lineNumber: 120, side: 'additions', align: 'start', behavior: 'instant' });
    expect(bridge.scrollToAnnotation('src/a.js', 'file-level')).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'item', id: 'src/a.js', align: 'start', behavior: 'instant' });
    drawRow('annotation-additions-120');
    drawRow('annotation-additions-0');
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation('src/a.js', 'far')).toBe(true);
    expect(bridge.scrollToAnnotation('src/a.js', 'file-level')).toBe(true);
    expect(viewer().count('scrollTo')).toBe(0);
  });

  it('whenAnnotationRendered waits for a card that is in the document until the viewer draws it', async () => {
    bridge.registerAnnotationRenderer('card', () => env.window.document.createElement('div'));
    bridge.addAnnotation('src/a.js', { lineNumber: 120, side: 'RIGHT', type: 'card', data: {}, id: 'far' });
    const { wrap, drawRow } = fileElement('src/a.js');
    const card = bridge.getAnnotationElement('src/a.js', 'far', { create: true });
    wrap(card, 'annotation-additions-120');
    const waiting = bridge.whenAnnotationRendered('src/a.js', 'far');
    let settled;
    waiting.then((value) => { settled = value; });
    await Promise.resolve();
    expect(settled).toBeUndefined();
    drawRow('annotation-additions-120');
    expect(await waiting).toBe(card);
    // Drawn: at once.
    expect(await bridge.whenAnnotationRendered('src/a.js', 'far')).toBe(card);
    // Never drawn: null when the time runs out, not the card that is merely in the document.
    bridge.addAnnotation('src/a.js', { lineNumber: 121, side: 'RIGHT', type: 'card', data: {}, id: 'never' });
    wrap(bridge.getAnnotationElement('src/a.js', 'never', { create: true }), 'annotation-additions-121');
    expect(await bridge.whenAnnotationRendered('src/a.js', 'never', { timeoutMs: 0 })).toBeNull();
  });

  it('a card that is attached while its file\'s new diff awaits display: nothing is sent and the wait answers at once, unless the file is drawn in row windows', async () => {
    bridge.registerAnnotationRenderer('card', () => env.window.document.createElement('div'));
    bridge.addAnnotation('src/a.js', { lineNumber: 120, side: 'RIGHT', type: 'card', data: {}, id: 'revealed' });
    bridge.addAnnotation('src/b.js', { lineNumber: 120, side: 'RIGHT', type: 'card', data: {}, id: 'revealed-b' });
    // The viewer still draws another diff than the one the bridge published last.
    const small = fileElement('src/a.js', { renderedDiff: { name: 'the diff before' } });
    const card = bridge.getAnnotationElement('src/a.js', 'revealed', { create: true });
    small.wrap(card, 'annotation-additions-120');
    expect(bridge.isDiffDisplayed('src/a.js')).toBe(false);
    expect(bridge.isElementDrawn(card)).toBe(false);
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation('src/a.js', 'revealed')).toBe(true);
    expect(viewer().count('scrollTo')).toBe(0);
    expect(await bridge.whenAnnotationRendered('src/a.js', 'revealed', { timeoutMs: 0 })).toBe(card);

    // A file of 5,000 rows or more: the display draws the rows of the window the pane is in.
    const long = fileElement('src/b.js', { renderedDiff: { name: 'the diff before' }, rows: 5000 });
    const far = bridge.getAnnotationElement('src/b.js', 'revealed-b', { create: true });
    long.wrap(far, 'annotation-additions-120');
    expect(bridge.scrollToAnnotation('src/b.js', 'revealed-b')).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'line', id: 'src/b.js', lineNumber: 120, side: 'additions', align: 'start', behavior: 'instant' });
    expect(await bridge.whenAnnotationRendered('src/b.js', 'revealed-b', { timeoutMs: 0 })).toBeNull();
    long.drawRow('annotation-additions-120');
    expect(await bridge.whenAnnotationRendered('src/b.js', 'revealed-b', { timeoutMs: 0 })).toBe(far);
  });

  it('a new diff that awaits display and takes a file drawn whole to 5,000 rows or more: the line target is sent, the card is not taken as about to be drawn', async () => {
    const LONG = 'lib/long.js';
    bridge.renderAll([diffEntry(A), contextEntry(LONG, { contents: `${numberedLines(6000).join('\n')}\n`, ranges: [{ startLine: 100, endLine: 120 }] })]);
    bridge.registerAnnotationRenderer('card', () => env.window.document.createElement('div'));
    bridge.addAnnotation(LONG, { lineNumber: 110, side: 'RIGHT', type: 'card', data: {}, id: 'near' });
    const record = bridge.files.get(LONG);
    const before = record.metadata;
    expect(PierreBridge.drawnRowCount(before, 'unified')).toBe(21);
    // The file is on screen with its 21 rows, all drawn.
    const file = fileElement(LONG, { renderedDiff: before, rows: 21 });
    // A reveal of 150 lines: the new diff awaits display, the file is still one the viewer draws whole.
    bridge.addContextRanges(LONG, [{ startLine: 200, endLine: 349 }]);
    bridge.addAnnotation(LONG, { lineNumber: 300, side: 'RIGHT', type: 'card', data: {}, id: 'revealed' });
    const card = bridge.getAnnotationElement(LONG, 'revealed', { create: true });
    file.wrap(card, 'annotation-additions-300');
    expect(bridge.isDiffDisplayed(LONG)).toBe(false);
    expect(PierreBridge.drawnRowCount(record.metadata, 'unified')).toBe(171);
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation(LONG, 'revealed')).toBe(true);
    expect(viewer().count('scrollTo')).toBe(0);
    expect(await bridge.whenAnnotationRendered(LONG, 'revealed', { timeoutMs: 0 })).toBe(card);

    // A reveal that takes the file to 5,150 rows: its display draws a window of them, which need not hold the card's line.
    bridge.addContextRanges(LONG, [{ startLine: 1000, endLine: 5978 }]);
    bridge.addAnnotation(LONG, { lineNumber: 5900, side: 'RIGHT', type: 'card', data: {}, id: 'far' });
    const far = bridge.getAnnotationElement(LONG, 'far', { create: true });
    file.wrap(far, 'annotation-additions-5900');
    expect(PierreBridge.drawnRowCount(record.metadata, 'unified')).toBe(21 + 150 + 4979);
    expect(file.host.shadowRoot.querySelector('[data-content]').children.length).toBe(21);
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation(LONG, 'far')).toBe(true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'line', id: LONG, lineNumber: 5900, side: 'additions', align: 'start', behavior: 'instant' });
    expect(await bridge.whenAnnotationRendered(LONG, 'far', { timeoutMs: 0 })).toBeNull();
    file.drawRow('annotation-additions-5900');
    expect(await bridge.whenAnnotationRendered(LONG, 'far', { timeoutMs: 0 })).toBe(far);
  });

  it('whenAnnotationRendered takes the pane to the line once more when the diff that awaited display is displayed and the card is still not drawn', async () => {
    const LONG = 'lib/long.js';
    bridge.renderAll([diffEntry(A), contextEntry(LONG, { contents: `${numberedLines(9000).join('\n')}\n`, ranges: [{ startLine: 1, endLine: 100 }] })]);
    bridge.registerAnnotationRenderer('card', () => env.window.document.createElement('div'));
    const record = bridge.files.get(LONG);
    const before = record.metadata;
    const file = fileElement(LONG, { renderedDiff: before, rows: 100 });
    // A reveal that takes the file to 8,100 rows, and a card far down them.
    bridge.addContextRanges(LONG, [{ startLine: 1000, endLine: 8999 }]);
    bridge.addAnnotation(LONG, { lineNumber: 8900, side: 'RIGHT', type: 'card', data: {}, id: 'far' });
    const far = bridge.getAnnotationElement(LONG, 'far', { create: true });
    file.wrap(far, 'annotation-additions-8900');
    const target = { type: 'line', id: LONG, lineNumber: 8900, side: 'additions', align: 'start', behavior: 'instant' };
    viewer().calls.length = 0;
    expect(bridge.scrollToAnnotation(LONG, 'far')).toBe(true);
    expect(viewer().count('scrollTo')).toBe(1);
    const waiting = bridge.whenAnnotationRendered(LONG, 'far');
    let settled = false;
    waiting.then(() => { settled = true; });
    // While the old diff is on screen nothing more is sent, however many frames pass.
    await new Promise((resolve) => env.window.requestAnimationFrame(() => env.window.requestAnimationFrame(resolve)));
    expect(viewer().count('scrollTo')).toBe(1);
    // The new diff is displayed, in a window of rows that does not hold the card's line.
    record._instance.getRenderedDiff = () => record.metadata;
    expect(bridge.isDiffDisplayed(LONG)).toBe(true);
    await vi.waitFor(() => expect(viewer().count('scrollTo')).toBe(2));
    expect(viewer().last('scrollTo').args[0]).toEqual(target);
    expect(settled).toBe(false);
    // Once only, and the wait ends when the viewer draws the card.
    await new Promise((resolve) => env.window.requestAnimationFrame(() => env.window.requestAnimationFrame(resolve)));
    expect(viewer().count('scrollTo')).toBe(2);
    file.drawRow('annotation-additions-8900');
    expect(await waiting).toBe(far);
    expect(viewer().count('scrollTo')).toBe(2);
  });

  it('whenAnnotationRendered sends nothing more for a file whose diff was on screen all along, nor after it was cancelled', async () => {
    bridge.registerAnnotationRenderer('card', () => env.window.document.createElement('div'));
    bridge.addAnnotation('src/b.js', { lineNumber: 120, side: 'RIGHT', type: 'card', data: {}, id: 'far' });
    const file = fileElement('src/b.js', { rows: 5000 });
    const far = bridge.getAnnotationElement('src/b.js', 'far', { create: true });
    file.wrap(far, 'annotation-additions-120');
    viewer().calls.length = 0;
    const waiting = bridge.whenAnnotationRendered('src/b.js', 'far');
    await new Promise((resolve) => env.window.requestAnimationFrame(() => env.window.requestAnimationFrame(resolve)));
    expect(viewer().count('scrollTo')).toBe(0);
    file.drawRow('annotation-additions-120');
    expect(await waiting).toBe(far);

    // Cancelled while the new diff awaited display: its display moves nothing.
    const LONG = 'lib/long.js';
    bridge.renderAll([diffEntry(A), contextEntry(LONG, { contents: `${numberedLines(9000).join('\n')}\n`, ranges: [{ startLine: 1, endLine: 100 }] })]);
    const record = bridge.files.get(LONG);
    const long = fileElement(LONG, { renderedDiff: record.metadata, rows: 100 });
    bridge.addContextRanges(LONG, [{ startLine: 1000, endLine: 8999 }]);
    bridge.addAnnotation(LONG, { lineNumber: 8900, side: 'RIGHT', type: 'card', data: {}, id: 'gone' });
    long.wrap(bridge.getAnnotationElement(LONG, 'gone', { create: true }), 'annotation-additions-8900');
    let cancelled = false;
    viewer().calls.length = 0;
    const stopped = bridge.whenAnnotationRendered(LONG, 'gone', { isCancelled: () => cancelled });
    cancelled = true;
    record._instance.getRenderedDiff = () => record.metadata;
    expect(await stopped).toBeNull();
    expect(viewer().count('scrollTo')).toBe(0);
  });

  it('drawnRowCount: the lines of the hunks in the layout asked for, and the gaps small enough to be drawn when the diff has the file\'s contents', () => {
    const patchOnly = bridge.files.get('src/a.js').metadata;
    // Two hunks of the patch: 3 + 1 removed + 1 added + 3, and 3 + 1 added + 3. Side by side the change is one row.
    expect(patchOnly.isPartial).toBe(true);
    expect(PierreBridge.drawnRowCount(patchOnly, 'unified')).toBe(8 + 7);
    expect(PierreBridge.drawnRowCount(patchOnly, 'split')).toBe(7 + 7);
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    const upgraded = bridge.files.get('src/a.js').metadata;
    expect(upgraded.isPartial).toBe(false);
    const hunkRows = upgraded.hunks.reduce((sum, hunk) => sum + hunk.unifiedLineCount, 0);
    expect(PierreBridge.drawnRowCount(upgraded, 'unified')).toBe(hunkRows);
    // A range that leaves five hidden lines before the second hunk: the viewer draws those too.
    const firstOfSecond = upgraded.hunks[1].additionStart;
    bridge.addContextRanges('src/a.js', [{ startLine: firstOfSecond - 16, endLine: firstOfSecond - 6 }]);
    expect(PierreBridge.drawnRowCount(bridge.files.get('src/a.js').metadata, 'unified')).toBe(hunkRows + 11 + 5);
    // The last five lines of a file whose last hunk ends five lines short of its end.
    bridge.renderAll([contextEntry('lib/c.js', { ranges: [{ startLine: 380, endLine: 395 }] })]);
    expect(PierreBridge.drawnRowCount(bridge.files.get('lib/c.js').metadata, 'unified')).toBe(16 + 5);
    expect(PierreBridge.drawnRowCount(null, 'unified')).toBe(0);
    expect(PierreBridge.drawnRowCount({ hunks: [] }, 'split')).toBe(0);
  });

  it('whenElementDrawn: at once for an element that is drawn and for none, else when the viewer draws it', async () => {
    const doc = env.window.document;
    const { wrap, drawRow } = fileElement('src/a.js');
    expect(await bridge.whenElementDrawn(null)).toBe(false);
    const card = doc.createElement('div');
    wrap(card, 'annotation-additions-0');
    const waiting = bridge.whenElementDrawn(card);
    let settled = null;
    waiting.then((value) => { settled = value; });
    await Promise.resolve();
    expect(settled).toBeNull();
    drawRow('annotation-additions-0');
    expect(await waiting).toBe(true);
    expect(await bridge.whenElementDrawn(card)).toBe(true);
  });

  it('whenElementDrawn stops when cancelled, when the time runs out and when the bridge is destroyed', async () => {
    const doc = env.window.document;
    const { wrap } = fileElement('src/a.js');
    const card = doc.createElement('div');
    wrap(card, 'annotation-additions-0');
    let cancel = false;
    const cancelled = bridge.whenElementDrawn(card, { isCancelled: () => cancel });
    cancel = true;
    expect(await cancelled).toBe(false);
    expect(await bridge.whenElementDrawn(card, { timeoutMs: 0 })).toBe(false);
    const destroyed = bridge.whenElementDrawn(card);
    bridge.destroy();
    expect(await destroyed).toBe(false);
  });

  it('isEditingInside: the focus is in a text field of the file, not merely somewhere in it', () => {
    const { host } = mount('src/a.js');
    const textarea = env.window.document.createElement('textarea');
    const button = env.window.document.createElement('button');
    host.append(textarea, button);
    const outside = env.window.document.createElement('textarea');
    env.window.document.body.appendChild(outside);
    expect(bridge.isEditingInside('src/a.js')).toBe(false);
    textarea.focus();
    expect(bridge.hasFocusInside('src/a.js')).toBe(true);
    expect(bridge.isEditingInside('src/a.js')).toBe(true);
    expect(bridge.isEditingInside('src/b.js')).toBe(false);
    button.focus();
    expect(bridge.hasFocusInside('src/a.js')).toBe(true);
    expect(bridge.isEditingInside('src/a.js')).toBe(false);
    outside.focus();
    expect(bridge.isEditingInside('src/a.js')).toBe(false);
    expect(bridge.isEditingInside('nope.js')).toBe(false);
  });

  it('collapsing a file the reader is inside keeps its header at the top of the pane', () => {
    bridge.root.getBoundingClientRect = () => ({ top: 100, bottom: 700, height: 600, left: 0, right: 100, width: 100 });
    // The file starts 300 px above the pane's top edge and ends below it.
    mount('src/a.js', { box: { top: -200, bottom: 900 } });
    viewer().calls.length = 0;
    bridge.setCollapsed('src/a.js', true);
    expect(viewer().last('scrollTo').args[0]).toEqual({ type: 'item', id: 'src/a.js', align: 'start', behavior: 'instant' });
    // The collapse is published before the target is sent.
    const names = viewer().calls.map((c) => c.name);
    expect(names.indexOf('updateItem')).toBeLessThan(names.lastIndexOf('scrollTo'));
  });

  it('collapsing a file whose top is in view, a file below or above the pane, or an unmounted file scrolls nowhere; neither does expanding', () => {
    bridge.root.getBoundingClientRect = () => ({ top: 100, bottom: 700, height: 600, left: 0, right: 100, width: 100 });
    mount('src/a.js', { box: { top: 100, bottom: 900 } });
    bridge.setCollapsed('src/a.js', true);
    bridge.setCollapsed('src/a.js', false);
    const b = mount('src/b.js', { box: { top: 900, bottom: 1500 } });
    bridge.setCollapsed('src/b.js', true);
    bridge.setCollapsed('src/b.js', false);
    b.host.getBoundingClientRect = () => ({ top: -900, bottom: 50, height: 950, left: 0, right: 100, width: 100 });
    bridge.setCollapsed('src/b.js', true);
    // Expanding a collapsed file the pane's top edge is inside (its header).
    b.host.getBoundingClientRect = () => ({ top: 60, bottom: 113, height: 53, left: 0, right: 100, width: 100 });
    bridge.setCollapsed('src/b.js', false);
    bridge.renderAll([diffEntry(A)]);
    bridge.setCollapsed('src/a.js', true);
    expect(viewer().count('scrollTo')).toBe(0);
  });

  it('scrollToLine with endLine flashes every line of the range the file shows, as one flash', () => {
    expect(bridge.scrollToLine('src/a.js', 118, 'RIGHT', { endLine: 121 })).toBe(true);
    const record = bridge.files.get('src/a.js');
    expect(record._flash.lines).toEqual([118, 119, 120, 121]);
    expect(viewer().count('scrollTo')).toBe(1);
    // A range that runs out of what the file shows flashes the lines it does show.
    const last = record.metadata.hunks[0].additionStart + record.metadata.hunks[0].additionCount - 1;
    bridge.scrollToLine('src/a.js', last - 1, 'RIGHT', { endLine: last + 4, scroll: false });
    expect(record._flash.lines).toEqual([last - 1, last]);
    // One line: the flash it always was.
    bridge.scrollToLine('src/a.js', 120, 'RIGHT', { scroll: false });
    expect(record._flash.lines).toEqual([120]);
    bridge._endFlash(record);
    expect(record._flash).toBeNull();
  });

  it('scrollToLine with ifNeeded scrolls when the line has no row on screen', () => {
    // Not mounted: no row.
    expect(bridge.scrollToLine('src/a.js', 120, 'RIGHT', { ifNeeded: true, flash: false })).toBe(true);
    expect(viewer().count('scrollTo')).toBe(1);
  });
});

describe('what the reader expanded by hand, while the file still draws the diff it was expanded in (H120)', () => {
  let record;
  let instance;
  let host;
  let drawn;

  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A)]);
    bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile);
    record = bridge.files.get('src/a.js');
    host = env.window.document.createElement('div');
    env.window.document.body.appendChild(host);
    drawn = record.metadata;
    instance = {
      hunksRenderer: { expandedHunks: new Map([[1, { fromStart: 20, fromEnd: 0 }]]) },
      getRenderedDiff: () => drawn,
      resetLayoutCache: vi.fn(),
    };
    viewer().options.onPostRender(host, instance, 'mount', { item: { id: 'src/a.js' }, element: host, instance });
    viewer().calls.length = 0;
  });

  const draw = (phase = 'update') => viewer().options.onPostRender(host, instance, phase, { item: { id: 'src/a.js' }, element: host, instance });

  it('a reveal keeps the viewer\'s record of them until the viewer draws the new diff, then drops it and draws once more', async () => {
    const map = instance.hunksRenderer.expandedHunks;
    const before = record.metadata;
    expect(bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }])).toBe(true);
    // Folded into the file's ranges: the data is right at once...
    expect(record.contextRanges).toEqual([{ startLine: 125, endLine: 144 }, { startLine: 300, endLine: 302 }]);
    expect(record.metadata).not.toBe(before);
    expect([125, 144, 145, 301].map((line) => bridge.isLineVisible('src/a.js', line, 'RIGHT'))).toEqual([true, true, false, true]);
    // ...and the viewer, which goes on drawing the old diff, keeps what it draws it with.
    expect(map.size).toBe(1);
    expect(instance.resetLayoutCache).not.toHaveBeenCalled();
    expect(viewer().count('updateItem')).toBe(1);

    // Draws of the old diff meanwhile change nothing.
    draw();
    expect(map.size).toBe(1);
    expect(viewer().count('updateItem')).toBe(1);

    // The viewer draws the new diff: the map was the old diff's, and goes.
    drawn = record.metadata;
    draw();
    expect(map.size).toBe(0);
    expect(instance.resetLayoutCache.mock.calls).toEqual([[{ includeEstimatedHeights: true }]]);
    expect(viewer().count('updateItem')).toBe(2);
    expect([125, 144, 145, 301].map((line) => bridge.isLineVisible('src/a.js', line, 'RIGHT'))).toEqual([true, true, false, true]);

    // Later draws leave it alone, and a later expansion by hand counts again.
    draw();
    expect(viewer().count('updateItem')).toBe(2);
    const gapAfter = record.metadata.hunks.findIndex((h) => h.additionStart === 300) + 1;
    map.set(gapAfter, { fromStart: 5, fromEnd: 0 });
    expect(bridge.isLineVisible('src/a.js', 305, 'RIGHT')).toBe(true);
  });

  it('a second reveal before the first is drawn does not fold the old diff\'s record into the new hunks', () => {
    const map = instance.hunksRenderer.expandedHunks;
    bridge.addContextRanges('src/a.js', [{ startLine: 60, endLine: 62 }]);
    // Hunk indices have moved: index 1 is now the gap before the first hunk of the patch.
    bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
    expect(record.contextRanges).toEqual([{ startLine: 60, endLine: 62 }, { startLine: 125, endLine: 144 }, { startLine: 300, endLine: 302 }]);
    expect(bridge.isLineVisible('src/a.js', 70, 'RIGHT')).toBe(false);
    expect(map.size).toBe(1);
    drawn = record.metadata;
    draw();
    expect(map.size).toBe(0);
  });

  it('a file that is not on screen loses the record at once', () => {
    host.remove();
    bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
    expect(instance.hunksRenderer.expandedHunks.size).toBe(0);
    expect(instance.resetLayoutCache).toHaveBeenCalledTimes(1);
    expect(record.contextRanges).toEqual([{ startLine: 125, endLine: 144 }, { startLine: 300, endLine: 302 }]);
  });

  it('a list write folds nothing twice and starts the new instances clean', () => {
    bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
    const key = record.metadata.cacheKey;
    bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js')]);
    expect(record.contextRanges).toEqual([{ startLine: 125, endLine: 144 }, { startLine: 300, endLine: 302 }]);
    expect(record.metadata.cacheKey).toBe(key);
    expect(record._instance).toBeNull();
    expect(record._expansionsOf).toBeNull();
  });

  it('a diff the viewer draws in its next pass (plain text, an unhighlighted file) takes the record with it at once, before it is published', () => {
    const map = instance.hunksRenderer.expandedHunks;
    const order = [];
    // The row renderer's own answer: the diff it is handed can be drawn without a highlight result.
    instance.hunksRenderer.getDiffForNextRender = vi.fn((diff) => diff);
    instance.hunksRenderer.onRenderUpdate = vi.fn();
    const callback = instance.hunksRenderer.onRenderUpdate;
    instance.resetLayoutCache.mockImplementation(() => order.push(`reset:${map.size}`));
    const updateItem = viewer().updateItem.bind(viewer());
    viewer().updateItem = (item) => { order.push(`publish:${map.size}`); return updateItem(item); };
    bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
    expect(instance.hunksRenderer.getDiffForNextRender).toHaveBeenCalledWith(record.metadata);
    expect(order).toEqual(['reset:0', 'publish:0']);
    expect(record._expansionsOf).toBeNull();
    expect(instance.hunksRenderer.onRenderUpdate).toBe(callback);
    expect([125, 144, 145, 301].map((line) => bridge.isLineVisible('src/a.js', line, 'RIGHT'))).toEqual([true, true, false, true]);
  });

  it('a diff the viewer cannot draw yet leaves the record with the diff on screen', () => {
    const map = instance.hunksRenderer.expandedHunks;
    // The row renderer's answer while a highlight result is awaited: the diff it draws now.
    instance.hunksRenderer.getDiffForNextRender = vi.fn(() => drawn);
    bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
    expect(map.size).toBe(1);
    expect(record._expansionsOf).toBe(drawn);
    expect(instance.resetLayoutCache).not.toHaveBeenCalled();
  });

  describe('the row renderer\'s callback, taken over while a record waits for the next diff', () => {
    let original;
    beforeEach(() => {
      original = vi.fn();
      instance.hunksRenderer.onRenderUpdate = original;
    });

    it('is called through, drops the record when the next diff is staged, and is the renderer\'s own again', () => {
      const map = instance.hunksRenderer.expandedHunks;
      bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
      const hook = instance.hunksRenderer.onRenderUpdate;
      expect(hook).not.toBe(original);
      // A result for the diff that is on screen: the record stays.
      instance.hunksRenderer.pendingHighlightResult = { diff: drawn };
      hook('a', 'b');
      expect(original).toHaveBeenLastCalledWith('a', 'b');
      expect(map.size).toBe(1);
      expect(instance.hunksRenderer.onRenderUpdate).toBe(hook);
      // The result for the new diff.
      instance.hunksRenderer.pendingHighlightResult = { diff: record.metadata };
      let sizeAtCall = null;
      original.mockImplementation(() => { sizeAtCall = map.size; });
      hook();
      expect(sizeAtCall).toBe(0);
      expect(instance.resetLayoutCache).toHaveBeenCalledTimes(1);
      expect(record._expansionsOf).toBeNull();
      expect(instance.hunksRenderer.onRenderUpdate).toBe(original);
    });

    it('is the renderer\'s own again when the fallback drops the record', () => {
      bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
      expect(instance.hunksRenderer.onRenderUpdate).not.toBe(original);
      drawn = record.metadata;
      draw();
      expect(instance.hunksRenderer.expandedHunks.size).toBe(0);
      expect(instance.hunksRenderer.onRenderUpdate).toBe(original);
    });

    it('is the renderer\'s own again when a list write takes the instance away, and when the record is discarded', () => {
      bridge.addContextRanges('src/a.js', [{ startLine: 300, endLine: 302 }]);
      expect(instance.hunksRenderer.onRenderUpdate).not.toBe(original);
      bridge.reconcile([diffEntry(A), contextEntry('ctx/c.js')]);
      expect(instance.hunksRenderer.onRenderUpdate).toBe(original);

      draw('mount');
      instance.hunksRenderer.expandedHunks.set(1, { fromStart: 5, fromEnd: 0 });
      drawn = record.metadata;
      bridge.addContextRanges('src/a.js', [{ startLine: 350, endLine: 352 }]);
      expect(instance.hunksRenderer.onRenderUpdate).not.toBe(original);
      bridge.renderAll([diffEntry(B)]);
      expect(instance.hunksRenderer.onRenderUpdate).toBe(original);
    });
  });
});

describe('a context file given another range after the reader expanded a gap by hand (H120)', () => {
  const C = 'ctx/c.js';
  let record;
  let instance;
  let host;
  let drawn;

  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A), contextEntry(C)]);
    record = bridge.files.get(C);
    host = env.window.document.createElement('div');
    env.window.document.body.appendChild(host);
    drawn = record.metadata;
    // The gap after the first range (lines 121-299), twenty lines from its start: lines 121-140.
    instance = {
      hunksRenderer: { expandedHunks: new Map([[1, { fromStart: 20, fromEnd: 0 }]]), onRenderUpdate: vi.fn() },
      getRenderedDiff: () => drawn,
      resetLayoutCache: vi.fn(),
    };
    viewer().options.onPostRender(host, instance, 'mount', { item: { id: C }, element: host, instance });
    viewer().calls.length = 0;
  });

  const draw = () => viewer().options.onPostRender(host, instance, 'update', { item: { id: C }, element: host, instance });
  const withRange = (ranges) => [diffEntry(A), contextEntry(C, { ranges })];
  const STORED = [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }];

  it('the new range and the expanded lines are the file\'s data at once; the viewer\'s record stays with the diff on screen until the next one is drawn', () => {
    const map = instance.hunksRenderer.expandedHunks;
    expect(bridge.isLineVisible(C, 130, 'RIGHT')).toBe(true);
    const result = bridge.reconcile(withRange([...STORED, { startLine: 200, endLine: 210 }]));
    expect(result).toMatchObject({ applied: true, listWritten: false, updated: [C] });
    expect(record.contextRanges).toEqual([{ startLine: 121, endLine: 140 }]);
    expect(record.metadata.hunks.map((h) => [h.additionStart, h.additionCount])).toEqual([[100, 41], [200, 11], [300, 11]]);
    expect([130, 140, 141, 205].map((line) => bridge.isLineVisible(C, line, 'RIGHT'))).toEqual([true, true, false, true]);
    // The old diff is still what the viewer draws: with its record, and the height that goes with it.
    expect(map.size).toBe(1);
    expect(record._expansionsOf).toBe(drawn);
    expect(instance.resetLayoutCache).not.toHaveBeenCalled();
    expect(viewer().count('updateItem')).toBe(1);
    draw();
    expect(map.size).toBe(1);

    // The highlight result of the new diff is staged: the record goes, then the viewer draws.
    const hook = instance.hunksRenderer.onRenderUpdate;
    instance.hunksRenderer.pendingHighlightResult = { diff: record.metadata };
    hook();
    expect(map.size).toBe(0);
    expect(instance.resetLayoutCache.mock.calls).toEqual([[{ includeEstimatedHeights: true }]]);
    expect(record._expansionsOf).toBeNull();
    drawn = record.metadata;
    draw();
    expect(viewer().count('updateItem')).toBe(1);
    expect([130, 140, 141, 205].map((line) => bridge.isLineVisible(C, line, 'RIGHT'))).toEqual([true, true, false, true]);
  });

  it('a second range before the first is drawn folds nothing twice', () => {
    const map = instance.hunksRenderer.expandedHunks;
    bridge.reconcile(withRange([...STORED, { startLine: 200, endLine: 210 }]));
    // Hunk indices have moved: index 1 is still the gap after the first hunk, which now ends at line 140.
    bridge.reconcile(withRange([...STORED, { startLine: 200, endLine: 210 }, { startLine: 50, endLine: 52 }]));
    expect(record.contextRanges).toEqual([{ startLine: 121, endLine: 140 }]);
    expect(bridge.isLineVisible(C, 150, 'RIGHT')).toBe(false);
    expect(map.size).toBe(1);
    expect(record._expansionsOf).toBe(drawn);
  });

  it('new contents: what was expanded is not carried over, and the record still stays with the diff on screen', () => {
    const map = instance.hunksRenderer.expandedHunks;
    bridge.reconcile([diffEntry(A), contextEntry(C, { contents: `${numberedLines(380).join('\n')}\n`, contentsSeq: 2 })]);
    expect(record.contextRanges).toEqual([]);
    expect(bridge.isLineVisible(C, 130, 'RIGHT')).toBe(false);
    expect(map.size).toBe(1);
    expect(record._expansionsOf).toBe(drawn);
    drawn = record.metadata;
    draw();
    expect(map.size).toBe(0);
    expect(bridge.isLineVisible(C, 130, 'RIGHT')).toBe(false);
  });

  it('a file that is not on screen, or one whose next draw is the new diff, loses the record at once', () => {
    const map = instance.hunksRenderer.expandedHunks;
    instance.hunksRenderer.getDiffForNextRender = vi.fn((diff) => diff);
    bridge.reconcile(withRange([...STORED, { startLine: 200, endLine: 210 }]));
    expect(map.size).toBe(0);
    expect(instance.resetLayoutCache).toHaveBeenCalledTimes(1);
    expect(record.contextRanges).toEqual([{ startLine: 121, endLine: 140 }]);

    delete instance.hunksRenderer.getDiffForNextRender;
    map.set(1, { fromStart: 0, fromEnd: 5 });
    host.remove();
    bridge.reconcile(withRange([...STORED, { startLine: 200, endLine: 210 }, { startLine: 50, endLine: 52 }]));
    expect(map.size).toBe(0);
    expect(instance.resetLayoutCache).toHaveBeenCalledTimes(2);
  });
});

describe('diff positions', () => {
  it('counts hunk headers and lines, deletions before additions, both sides for context', () => {
    create();
    bridge.renderAll([diffEntry(A)]);
    // Hunk 1: header (1), 117-119 context (2-4), -120 (5), +120 (6), 121-123 (7-9); hunk 2: header (10), ...
    expect(bridge.getDiffPosition('src/a.js', 117, 'RIGHT')).toBe(2);
    expect(bridge.getDiffPosition('src/a.js', 117, 'LEFT')).toBe(2);
    expect(bridge.getDiffPosition('src/a.js', 120, 'LEFT')).toBe(5);
    expect(bridge.getDiffPosition('src/a.js', 120, 'additions')).toBe(6);
    expect(bridge.getDiffPosition('src/a.js', 247, 'RIGHT')).toBe(11);
    expect(bridge.getDiffPosition('src/a.js', 250, 'RIGHT')).toBe(14);
    expect(bridge.getDiffPosition('src/a.js', 250, 'LEFT')).toBe(15);
    expect(bridge.getDiffPosition('src/a.js', 10, 'RIGHT')).toBeNull();
  });

  it('metadata without hunk contents, or with a segment it does not know, gives no map at all', () => {
    create();
    expect(bridge.computeDiffPositions(null).size).toBe(0);
    expect(bridge.computeDiffPositions({ hunks: [{ deletionStart: 1, additionStart: 1 }] }).size).toBe(0);
    expect(bridge.computeDiffPositions({ hunks: [{ deletionStart: 1, additionStart: 1, hunkContent: [{ type: 'context', lines: 1 }, { type: 'mystery' }] }] }).size).toBe(0);
  });
});

describe('side helpers', () => {
  it('convert between the app\'s sides and the viewer\'s', () => {
    create();
    expect(PierreBridge.toPierreSide('LEFT')).toBe('deletions');
    expect(PierreBridge.toPierreSide('deletions')).toBe('deletions');
    expect(PierreBridge.toPierreSide('RIGHT')).toBe('additions');
    expect(PierreBridge.toPierreSide(undefined)).toBe('additions');
    expect(PierreBridge.toPairReviewSide('deletions')).toBe('LEFT');
    expect(PierreBridge.toPairReviewSide('additions')).toBe('RIGHT');
  });
});

describe('the rows the viewer draws of a very long file hold what the pane shows (vendor fact F30)', () => {
  const pane = { top: 1000, bottom: 2260 };

  it('windowPastDrawnRows: a window of the same height whose middle is where the rows left out begin, when they begin above the pane\'s bottom', () => {
    // An item at 400 that is 100,400 px tall; the viewer leaves the last 160 px out: they begin at 100,640.
    const range = { startingLine: 0, totalLines: 5000, bufferBefore: 0, bufferAfter: 160 };
    expect(PierreBridge.windowPastDrawnRows(range, 400, 100400, { top: 99500, bottom: 100760 })).toEqual({ top: 100640 - 630, bottom: 100640 + 630 });
    // They begin below what the pane shows: the viewer's answer stands.
    expect(PierreBridge.windowPastDrawnRows(range, 400, 100400, { top: 90000, bottom: 100640 })).toBeNull();
    expect(PierreBridge.windowPastDrawnRows(range, 400, 100400, { top: 90000, bottom: 91260 })).toBeNull();
  });

  it('windowPastDrawnRows: nothing to correct when nothing is drawn, nothing is left out, or the numbers are not numbers', () => {
    expect(PierreBridge.windowPastDrawnRows({ totalLines: 0, bufferAfter: 900 }, 0, 1000, pane)).toBeNull();
    expect(PierreBridge.windowPastDrawnRows({ totalLines: 5000, bufferAfter: 0 }, 0, 1500, pane)).toBeNull();
    // Less than a pixel is rounding of the viewer's own sums, not rows.
    expect(PierreBridge.windowPastDrawnRows({ totalLines: 5000, bufferAfter: 0.4 }, 0, 1500, pane)).toBeNull();
    expect(PierreBridge.windowPastDrawnRows({ totalLines: 5000, bufferAfter: 200 }, undefined, 1500, pane)).toBeNull();
    expect(PierreBridge.windowPastDrawnRows({ totalLines: 5000, bufferAfter: 200 }, 0, NaN, pane)).toBeNull();
    expect(PierreBridge.windowPastDrawnRows({ totalLines: 5000, bufferAfter: 200 }, 0, 1500, { top: 1000, bottom: 1000 })).toBeNull();
    expect(PierreBridge.windowPastDrawnRows(null, 0, 1500, pane)).toBeNull();
    expect(PierreBridge.windowPastDrawnRows({ totalLines: 5000, bufferAfter: 200 }, 0, 1500, null)).toBeNull();
  });

  /** A stand-in for the vendor's class: answers from a list, records what it was asked. */
  function standIn(answers) {
    const asked = [];
    class VirtualizedFileDiff {
      constructor() { this.height = 100400; }
      computeRenderRangeFromWindow(fileDiff, fileTop, windowSpecs) {
        asked.push({ self: this, fileDiff, fileTop, windowSpecs });
        return answers[Math.min(asked.length - 1, answers.length - 1)];
      }
    }
    return { VirtualizedFileDiff, asked };
  }

  it('coverPaneWithRowWindow asks the viewer a second time, with the window past the rows it left out, and answers with that', () => {
    const first = { startingLine: 0, totalLines: 5000, bufferBefore: 0, bufferAfter: 160 };
    const second = { startingLine: 0, totalLines: 10000, bufferBefore: 0, bufferAfter: 0 };
    const { VirtualizedFileDiff, asked } = standIn([first, second]);
    expect(PierreBridge.coverPaneWithRowWindow(VirtualizedFileDiff)).toBe(true);
    const instance = new VirtualizedFileDiff();
    const diff = { name: 'a diff' };
    expect(instance.computeRenderRangeFromWindow(diff, 400, { top: 99500, bottom: 100760 })).toBe(second);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toEqual({ self: instance, fileDiff: diff, fileTop: 400, windowSpecs: { top: 99500, bottom: 100760 } });
    expect(asked[1]).toEqual({ self: instance, fileDiff: diff, fileTop: 400, windowSpecs: { top: 100010, bottom: 101270 } });
  });

  it('coverPaneWithRowWindow leaves an answer that needs no correction alone, and keeps the first answer when the second draws nothing', () => {
    const whole = { startingLine: 0, totalLines: 5000, bufferBefore: 0, bufferAfter: 0 };
    const one = standIn([whole]);
    PierreBridge.coverPaneWithRowWindow(one.VirtualizedFileDiff);
    expect(new one.VirtualizedFileDiff().computeRenderRangeFromWindow({}, 400, pane)).toBe(whole);
    expect(one.asked).toHaveLength(1);

    const first = { startingLine: 0, totalLines: 5000, bufferBefore: 0, bufferAfter: 160 };
    const two = standIn([first, { startingLine: 0, totalLines: 0, bufferBefore: 0, bufferAfter: 100000 }]);
    PierreBridge.coverPaneWithRowWindow(two.VirtualizedFileDiff);
    expect(new two.VirtualizedFileDiff().computeRenderRangeFromWindow({}, 400, { top: 99500, bottom: 100760 })).toBe(first);
    expect(two.asked).toHaveLength(2);
  });

  it('coverPaneWithRowWindow changes a class once, however often it is called and from however many loads of the bridge', () => {
    const first = { startingLine: 0, totalLines: 5000, bufferBefore: 0, bufferAfter: 160 };
    const second = { startingLine: 0, totalLines: 10000, bufferBefore: 0, bufferAfter: 0 };
    const { VirtualizedFileDiff, asked } = standIn([first, second]);
    expect(PierreBridge.coverPaneWithRowWindow(VirtualizedFileDiff)).toBe(true);
    const installed = VirtualizedFileDiff.prototype.computeRenderRangeFromWindow;
    expect(PierreBridge.coverPaneWithRowWindow(VirtualizedFileDiff)).toBe(true);
    // The bridge's script evaluated again (another page manager in the same window, a test that reloads it).
    const again = loadCodeViewBridge(vendor, { into: env.window });
    expect(again.PierreBridge).not.toBe(PierreBridge);
    expect(again.PierreBridge.coverPaneWithRowWindow(VirtualizedFileDiff)).toBe(true);
    expect(VirtualizedFileDiff.prototype.computeRenderRangeFromWindow).toBe(installed);
    new VirtualizedFileDiff().computeRenderRangeFromWindow({}, 400, { top: 99500, bottom: 100760 });
    expect(asked).toHaveLength(2);
  });

  it('constructing a bridge installs it on the vendor\'s class; without the class or its method the bridge says so and works', () => {
    create();
    const installed = env.window.PierreDiffs.VirtualizedFileDiff.prototype.computeRenderRangeFromWindow;
    expect(installed.pairReviewRowWindowCoversPane).toBe(true);
    create();
    expect(env.window.PierreDiffs.VirtualizedFileDiff.prototype.computeRenderRangeFromWindow).toBe(installed);

    expect(PierreBridge.coverPaneWithRowWindow(undefined)).toBe(false);
    expect(PierreBridge.coverPaneWithRowWindow(class {})).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    env.window.PierreDiffs.VirtualizedFileDiff = class {};
    create();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('computeRenderRangeFromWindow'));
    warn.mockRestore();
    expect(bridge.available).toBe(true);
    expect(bridge.renderAll([diffEntry(A)])).toBe(true);
  });
});

describe('without the vendor bundle', () => {
  it('says so once, renders nothing and throws nothing', () => {
    env.window.PierreDiffs = undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    create();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bundle is missing'));
    warn.mockRestore();
    expect(bridge.available).toBe(false);
    expect(bridge.renderAll([diffEntry(A)])).toBe(false);
    expect(bridge.parsePatch(A.patch)).toBeNull();
    expect(bridge.files.size).toBe(0);
    expect(bridge.isLineVisible('src/a.js', 120, 'RIGHT')).toBe(false);
    bridge.setTheme('dark');
    expect(bridge.setDiffStyle('split')).toBe(true);
  });
});

describe('the list has one writer (grep)', () => {
  const source = fs.readFileSync(BRIDGE_SOURCE, 'utf8');
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

  it('setItems is called only inside _writeList', () => {
    const start = source.indexOf('    _writeList() {');
    const end = source.indexOf('\n    }\n', start);
    expect(start).toBeGreaterThan(-1);
    const inside = source.slice(start, end);
    const callsInside = (inside.match(/\.setItems\(/g) || []).length;
    const callsInFile = code.join('\n').match(/\.setItems\(/g) || [];
    expect(callsInside).toBeGreaterThan(0);
    expect(callsInFile).toHaveLength(callsInside);
  });

  it('the viewer\'s splicing methods are never called', () => {
    for (const method of ['removeItem', 'addItem', 'addItems', 'insertItem', 'updateItemId']) {
      expect(code.some((line) => line.includes(`.${method}(`)), method).toBe(false);
    }
  });

  it('nothing reads window.prManager, and no position scroll target is written', () => {
    expect(code.some((line) => line.includes('prManager'))).toBe(false);
    expect(code.some((line) => /type:\s*'position'/.test(line))).toBe(false);
  });
});

describe('a card the viewer dropped at the end of a row window (H119)', () => {
  let record;
  let publishes;
  let content;

  /** A unified column with `count` line rows starting at `first`; `withCards` are lines followed by an annotation row. */
  function draw({ first = 1, count, withCards = [] }) {
    const document = env.window.document;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const code = document.createElement('code');
    code.setAttribute('data-unified', '');
    content = document.createElement('div');
    content.setAttribute('data-content', '');
    const rows = [];
    for (let line = first; line < first + count; line++) {
      rows.push(`<div data-line="${line}" data-line-type="change-addition" data-line-index="${line - 1},${line - 1}"></div>`);
      if (withCards.includes(line)) rows.push(`<div data-line-annotation="0,${line - 1}"></div>`);
    }
    content.innerHTML = rows.join('');
    code.appendChild(content);
    shadow.appendChild(code);
    record._element = host;
    return host;
  }

  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A)]);
    record = bridge.files.get('src/a.js');
    bridge.addAnnotation('src/a.js', { lineNumber: 5000, side: 'RIGHT', type: 'comment', data: { id: 1 } });
    bridge.isDiffDisplayed = () => true;
    publishes = 0;
    bridge._publish = () => { publishes++; return true; };
  });

  it('a file that shows fewer rows than a window is never looked at', () => {
    draw({ count: 200 });
    bridge.addAnnotation('src/a.js', { lineNumber: 100, side: 'RIGHT', type: 'comment', data: { id: 2 } });
    publishes = 0;
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(0);
  });

  it('a line whose row is drawn, followed by another row and not by its cards: the file is drawn again, once per state', () => {
    draw({ count: 6000 });
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(1);
    // Still missing after that draw, same rows: not asked again.
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(1);
    // The window moved (other rows): one more attempt.
    draw({ first: 3000, count: 6000 });
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(2);
  });

  it('once the cards are back the next loss is repaired again', () => {
    draw({ count: 6000 });
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(1);
    draw({ count: 6000, withCards: [5000] });
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(1);
    // The same rows as the first time, the cards gone again.
    draw({ count: 6000 });
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(2);
  });

  it('a line at the very end of the drawn rows is left alone: the window ends there', () => {
    draw({ count: 5000 });
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(0);
  });

  it('nothing is asked for a collapsed file, a file without an element, or while the old diff is still displayed', () => {
    draw({ count: 6000 });
    record.collapsed = true;
    bridge._restoreTrimmedCards(record);
    record.collapsed = false;
    bridge.isDiffDisplayed = () => false;
    bridge._restoreTrimmedCards(record);
    bridge.isDiffDisplayed = () => true;
    record._element = null;
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(0);
  });

  it('file-level annotations (line 0) are not lines: the zone alone asks for nothing', () => {
    record.annotations = record.annotations.filter((annotation) => annotation.lineNumber === 0);
    expect(record.annotations).toHaveLength(1);
    draw({ count: 6000 });
    publishes = 0;
    bridge._restoreTrimmedCards(record);
    expect(publishes).toBe(0);
  });
});

describe('a click the browser does not deliver because the file was drawn between press and release', () => {
  let host;
  let button;
  let clicks;
  // The bridge decides in a 0 ms timer set by the release. A 0 ms timer set
  // after it runs after it (timers of one delay run in the order they were
  // set), so this is a sentinel on the bridge's own queue, not a wait.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const down = (target, extra = {}) => bridge._handleRootPointerDown({ isPrimary: true, button: 0, composedPath: () => [target], target, ...extra });
  const up = (target, extra = {}) => bridge._handlePointerUp({ type: 'pointerup', button: 0, composedPath: () => [target], target, ...extra });
  const drawFile = () => bridge._hostDraws.set(host, (bridge._hostDraws.get(host) || 0) + 1);

  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A)]);
    const document = env.window.document;
    host = document.createElement('diffs-container');
    button = document.createElement('button');
    host.appendChild(button);
    document.body.appendChild(host);
    clicks = 0;
    button.addEventListener('click', () => { clicks++; });
  });

  it('press and release on the same control with a draw of its file in between: the control is clicked, once', async () => {
    down(button);
    drawFile();
    up(button);
    expect(clicks).toBe(0); // decided at the end of the release's task
    await tick();
    expect(clicks).toBe(1);
    await tick();
    expect(clicks).toBe(1);
  });

  it('a click the bridge sent itself does not count as the click of the press in progress', async () => {
    // Two presses with no pause: the click made up for the first arrives
    // while the second is in progress.
    down(button);
    drawFile();
    up(button);
    down(button);
    drawFile();
    bridge._onRootClick({ isTrusted: false }); // the first press's made-up click, passing the pane
    up(button);
    await tick();
    expect(clicks).toBe(2);
    // The browser's own click does count.
    down(button);
    drawFile();
    up(button);
    bridge._onRootClick({ isTrusted: true });
    await tick();
    expect(clicks).toBe(2);
  });

  it('a press that opens the context menu gets no click from the bridge', async () => {
    down(button, { ctrlKey: true });
    drawFile();
    bridge._onRootContextMenu();
    up(button);
    await tick();
    expect(clicks).toBe(0);
    expect(bridge._press).toBeNull();
    // The next plain press is repaired as ever.
    down(button);
    drawFile();
    up(button);
    await tick();
    expect(clicks).toBe(1);
  });

  it('the pane listens for the context menu, and stops when the bridge is destroyed', () => {
    const added = [];
    const removed = [];
    const root = bridge.root;
    const add = root.addEventListener.bind(root);
    const remove = root.removeEventListener.bind(root);
    root.addEventListener = (type, ...rest) => { added.push(type); return add(type, ...rest); };
    root.removeEventListener = (type, ...rest) => { removed.push(type); return remove(type, ...rest); };
    bridge._bindRoot();
    expect(added).toContain('contextmenu');
    bridge.destroy();
    expect(removed).toContain('contextmenu');
    bridge = null;
  });

  it('nothing is added when the file was not drawn, when the browser did send the click, or when the release is elsewhere', async () => {
    down(button);
    up(button);
    await tick();
    expect(clicks).toBe(0);

    down(button);
    drawFile();
    up(button);
    bridge._onRootClick(); // the browser's own click reaches the pane
    await tick();
    expect(clicks).toBe(0);

    const other = env.window.document.createElement('button');
    host.appendChild(other);
    down(button);
    drawFile();
    up(other);
    await tick();
    expect(clicks).toBe(0);
  });

  it('an icon inside the control is pressed: the control is what is clicked', async () => {
    const icon = env.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    button.appendChild(icon);
    down(icon);
    drawFile();
    up(icon);
    await tick();
    expect(clicks).toBe(1);
  });

  it('the icon that was pressed is replaced by the draw: the control both icons are in is clicked, once', async () => {
    // The page writes a header's icon again on every draw (the collapse
    // chevron), so the release is on another element than the press.
    const svg = () => env.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const pressed = svg();
    pressed.appendChild(env.window.document.createElementNS('http://www.w3.org/2000/svg', 'path'));
    button.appendChild(pressed);
    down(pressed.firstChild);
    drawFile();
    pressed.remove();
    const fresh = svg();
    button.appendChild(fresh);
    up(fresh);
    await tick();
    expect(clicks).toBe(1);

    // The same with the release on the control's own box.
    down(fresh);
    drawFile();
    fresh.remove();
    up(button);
    await tick();
    expect(clicks).toBe(2);
  });

  it('press and release on different parts of one control: the innermost element both are in is clicked', async () => {
    const document = env.window.document;
    const label = document.createElement('label');
    const box = document.createElement('input');
    const text = document.createElement('span');
    label.append(box, text);
    host.appendChild(label);
    const seen = [];
    label.addEventListener('click', (event) => seen.push(event.target));
    down(text);
    drawFile();
    up(box);
    await tick();
    // The label, not the checkbox and not the file's element. (A click on a
    // label is passed on to its control by the document, as a second event.)
    expect(seen[0]).toBe(label);
    expect(clicks).toBe(0);
  });

  it('nothing when the control itself was replaced by another, or the header left this file\'s element', async () => {
    down(button);
    drawFile();
    const replacement = env.window.document.createElement('button');
    let replacementClicks = 0;
    replacement.addEventListener('click', () => { replacementClicks++; });
    button.replaceWith(replacement);
    up(replacement);
    await tick();
    expect(clicks).toBe(0);
    expect(replacementClicks).toBe(0);

    // Slotted into another file's element by the time of the release.
    const otherHost = env.window.document.createElement('diffs-container');
    env.window.document.body.appendChild(otherHost);
    host.appendChild(button);
    down(button);
    drawFile();
    otherHost.appendChild(button);
    up(button);
    await tick();
    expect(clicks).toBe(0);
  });

  it('not for the viewer\'s own rows, another button, a second pointer, a cancelled press or a control that is gone', async () => {
    // A row is in the viewer's shadow tree.
    const shadow = host.attachShadow({ mode: 'open' });
    const row = env.window.document.createElement('div');
    shadow.appendChild(row);
    let rowClicks = 0;
    row.addEventListener('click', () => { rowClicks++; });
    down(row);
    drawFile();
    up(row);
    await tick();
    expect(rowClicks).toBe(0);

    down(button, { button: 2 });
    drawFile();
    up(button);
    down(button, { isPrimary: false });
    drawFile();
    up(button);
    down(button);
    drawFile();
    bridge._handlePointerUp({ type: 'pointercancel', composedPath: () => [button] });
    up(button);
    await tick();
    expect(clicks).toBe(0);

    down(button);
    drawFile();
    up(button);
    button.remove();
    await tick();
    expect(clicks).toBe(0);
  });

  describe('only for a press the browser handles as a mouse press', () => {
    // What the browser sends right after `pointerdown`, as the pane's
    // listeners receive it (trusted).
    const browserSends = (type, isTrusted = true) => bridge._onRootPressKind({ type, isTrusted });

    it('a touch: nothing is added, the browser delivers the click of a tap itself whatever was drawn', async () => {
      down(button, { pointerType: 'touch' });
      browserSends('touchstart');
      drawFile();
      up(button, { pointerType: 'touch' });
      // Not kept for the `mousedown` the browser sends after the release of a tap.
      expect(bridge._press).toBeNull();
      browserSends('mousedown');
      await tick();
      expect(clicks).toBe(0);

      // The same when `touchstart` never reached the pane: the pointer's type says it.
      down(button, { pointerType: 'touch' });
      drawFile();
      up(button, { pointerType: 'touch' });
      await tick();
      expect(clicks).toBe(0);
    });

    it('a pen is what the browser treats it as: a mouse press when `mousedown` came with it, a touch when `touchstart` did', async () => {
      down(button, { pointerType: 'pen' });
      browserSends('mousedown');
      drawFile();
      up(button, { pointerType: 'pen' });
      await tick();
      expect(clicks).toBe(1);

      down(button, { pointerType: 'pen' });
      browserSends('touchstart');
      drawFile();
      up(button, { pointerType: 'pen' });
      await tick();
      expect(clicks).toBe(1);
    });

    it('neither event seen (a `pointerdown` whose default was prevented has no `mousedown`): a mouse and a pen are mouse presses', async () => {
      down(button, { pointerType: 'mouse' });
      drawFile();
      up(button, { pointerType: 'mouse' });
      await tick();
      expect(clicks).toBe(1);

      down(button, { pointerType: 'pen' });
      drawFile();
      up(button, { pointerType: 'pen' });
      await tick();
      expect(clicks).toBe(2);

      // No pointer type at all (an old event shape): a mouse.
      down(button);
      drawFile();
      up(button);
      await tick();
      expect(clicks).toBe(3);
    });

    it('`mousedown` during the press decides, whatever the pointer calls itself', async () => {
      down(button, { pointerType: 'touch' });
      browserSends('mousedown');
      drawFile();
      up(button, { pointerType: 'touch' });
      await tick();
      expect(clicks).toBe(1);
    });

    it('an event a script dispatched says nothing about the browser: it is not counted', async () => {
      down(button, { pointerType: 'pen' });
      browserSends('touchstart', false);
      drawFile();
      up(button, { pointerType: 'pen' });
      await tick();
      expect(clicks).toBe(1);

      down(button, { pointerType: 'touch' });
      browserSends('mousedown', false);
      drawFile();
      up(button, { pointerType: 'touch' });
      await tick();
      expect(clicks).toBe(1);
    });

    it('the kind belongs to one press: the next press starts without it', async () => {
      down(button, { pointerType: 'pen' });
      browserSends('touchstart');
      up(button, { pointerType: 'pen' });
      down(button, { pointerType: 'pen' });
      drawFile();
      up(button, { pointerType: 'pen' });
      await tick();
      expect(clicks).toBe(1);
      // With no press in progress there is nothing to mark.
      expect(() => browserSends('mousedown')).not.toThrow();
    });

    it('the pane listens for both events before anything inside it can stop them, and stops listening when destroyed', () => {
      const root = bridge.root;
      const added = [];
      const removed = [];
      const add = root.addEventListener.bind(root);
      const remove = root.removeEventListener.bind(root);
      root.addEventListener = (type, listener, options) => { added.push([type, listener, options]); add(type, listener, options); };
      root.removeEventListener = (type, listener, options) => { removed.push([type, listener, options]); remove(type, listener, options); };
      bridge._bindRoot();
      for (const type of ['mousedown', 'touchstart']) {
        const entry = added.find(([t]) => t === type);
        expect(entry[1]).toBe(bridge._onRootPressKind);
        expect(entry[2]).toEqual({ capture: true, passive: true });
      }
      bridge.destroy();
      for (const type of ['mousedown', 'touchstart']) {
        const entry = removed.find(([t]) => t === type);
        expect(entry[1]).toBe(bridge._onRootPressKind);
        expect(entry[2]).toEqual({ capture: true });
      }
    });
  });

  it('every draw of a file is counted for its element, which is what "drawn in between" asks', () => {
    const record = bridge.files.get('src/a.js');
    const element = env.window.document.createElement('diffs-container');
    expect(bridge._hostDraws.get(element)).toBeUndefined();
    bridge._onPostRender(element, {}, 'mount', { item: { id: record.id }, element });
    bridge._onPostRender(element, {}, 'update', { item: { id: record.id }, element });
    expect(bridge._hostDraws.get(element)).toBe(2);
    bridge._onPostRender(element, {}, 'unmount', { item: { id: record.id }, element });
    expect(bridge._hostDraws.get(element)).toBe(2);
  });
});

describe('what counts as the reader scrolling toward the end of the pane (H163)', () => {
  let root;
  const note = (event) => bridge._noteReaderScrollInput(event);
  const button = () => env.window.document.createElement('button');
  /** The pane as tall as `height`, the reader at `top`. */
  const pane = (height, top) => {
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: height });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 100 });
    root.scrollTop = top;
  };
  const running = () => { bridge._endFollow = { still: 0, top: 0, until: Infinity }; bridge._readerScroll = { at: performance.now(), end: 0 }; };

  beforeEach(() => {
    create();
    bridge.renderAll([diffEntry(A)]);
    root = bridge.root;
  });

  it('a wheel step down, a touch dragged up and a key that scrolls down outside a text field are the reader\'s scroll toward the end', () => {
    for (const event of [
      { type: 'wheel', deltaY: 120, target: root },
      { type: 'keydown', key: 'End', target: env.window.document.body },
      { type: 'keydown', key: 'PageDown', target: root },
      { type: 'keydown', key: ' ', target: root },
    ]) {
      bridge._readerScroll = null;
      note(event);
      expect(bridge._readerScroll, `${event.type} ${event.key || ''}`).toMatchObject({ end: root.scrollHeight - root.clientHeight });
    }
    bridge._readerScroll = null;
    note({ type: 'pointerdown', pointerType: 'touch', clientY: 400, target: button() });
    note({ type: 'touchmove', touches: [{ clientY: 380 }], target: root });
    expect(bridge._readerScroll, 'a touch dragged up').toMatchObject({ end: root.scrollHeight - root.clientHeight });
  });

  it('everything else is not, and forgets the last scroll toward the end', () => {
    const textarea = env.window.document.createElement('textarea');
    for (const event of [
      { type: 'wheel', deltaY: -120, target: root },
      { type: 'keydown', key: 'End', target: textarea },
      { type: 'keydown', key: 'a', target: env.window.document.body },
      { type: 'keydown', key: 'Home', target: root },
      { type: 'keydown', key: 'PageUp', target: root },
      { type: 'keydown', key: 'ArrowUp', target: root },
      { type: 'keydown', key: ' ', shiftKey: true, target: root },
      { type: 'pointerdown', target: button() },
      // A press on the pane's own scrollbar.
      { type: 'pointerdown', target: root },
    ]) {
      running();
      note(event);
      expect(bridge._readerScroll, `${event.type} ${event.key || ''}`).toBeNull();
      expect(bridge._endFollow, `${event.type} ${event.key || ''}`).toBeNull();
    }
    // A touch dragged down.
    running();
    note({ type: 'pointerdown', pointerType: 'touch', clientY: 400, target: button() });
    note({ type: 'wheel', deltaY: 120, target: root });
    note({ type: 'touchmove', touches: [{ clientY: 430 }], target: root });
    expect(bridge._readerScroll).toBeNull();
  });

  it('a wheel step sideways and a touch move without a direction change nothing', () => {
    running();
    const before = bridge._readerScroll;
    const follow = bridge._endFollow;
    note({ type: 'wheel', deltaY: 0, deltaX: 40, target: root });
    note({ type: 'touchmove', touches: [{ clientY: 10 }], target: root });
    expect(bridge._readerScroll).toBe(before);
    expect(bridge._endFollow).toBe(follow);
  });

  it('a scroll toward the end while a follow is running leaves it running', () => {
    running();
    const follow = bridge._endFollow;
    note({ type: 'wheel', deltaY: 120, target: root });
    expect(bridge._endFollow).toBe(follow);
  });

  it('a scroll target and a view restore of the application\'s end a follow', () => {
    running();
    bridge.scrollToItem('src/a.js');
    expect(bridge._endFollow).toBeNull();
    expect(bridge._readerScroll).toBeNull();
  });

  it('a scroll that is not the reader\'s, or does not reach the end, starts no follow', () => {
    pane(1000, 900);
    // No input of the reader's at all.
    bridge._followEndAfterReaderScroll();
    expect(bridge._endFollow).toBeNull();
    // An input long ago: forgotten.
    bridge._readerScroll = { at: performance.now() - 60000, end: 900 };
    bridge._followEndAfterReaderScroll();
    expect(bridge._endFollow).toBeNull();
    expect(bridge._readerScroll).toBeNull();
    // An input just now, and the pane short of its end.
    pane(1000, 500);
    note({ type: 'keydown', key: 'End', target: root });
    bridge._followEndAfterReaderScroll();
    expect(bridge._endFollow).toBeNull();
    expect(bridge._readerScroll).not.toBeNull();
  });

  it('the scroll that reaches the end starts one follow and uses the input up: a scroll up right after End is not undone', () => {
    // The verifier's finding: the End key, the pane grows, Page Up within the
    // window. The remembered (old, smaller) end must not count again.
    pane(1000, 0);
    note({ type: 'keydown', key: 'End', target: root });
    root.scrollTop = 900;
    bridge._followEndAfterReaderScroll();
    expect(bridge._endFollow).not.toBeNull();
    expect(bridge._readerScroll).toBeNull();
    // The pane has grown and the follow has put the reader at the new end and ended.
    pane(3000, 2900);
    bridge._endFollow = null;
    // Page Up: its key, then its scroll event, at a position beyond the end as it was at the End key.
    note({ type: 'keydown', key: 'PageUp', target: root });
    root.scrollTop = 2400;
    bridge._followEndAfterReaderScroll();
    expect(bridge._endFollow).toBeNull();
    // The same with no key at all between (a scroll the bridge has no input for).
    root.scrollTop = 2300;
    bridge._followEndAfterReaderScroll();
    expect(bridge._endFollow).toBeNull();
  });

  describe('the pane\'s scrollbar, held and let go', () => {
    /** The pane's box on the screen, with a scrollbar `own` px wide beside the content (0: drawn over the content, or not drawn). */
    const box = (own) => {
      root.getBoundingClientRect = () => ({ left: 0, right: 800, top: 100, bottom: 700, width: 800, height: 600 });
      Object.defineProperty(root, 'clientWidth', { configurable: true, value: 800 - own });
      Object.defineProperty(root, 'clientLeft', { configurable: true, value: 0 });
    };
    /** A press on the scrollbar as the browser sends it: its target is the pane itself, at the pane's right edge. */
    const press = (at = {}) => note({ type: 'pointerdown', target: root, button: 0, clientX: 796, clientY: 110, ...at });
    /** The thumb moves the pane: the position, then its scroll event. */
    const drag = (top) => { root.scrollTop = top; bridge._handleRootScroll(); };
    const letGo = (at = {}) => bridge._handlePointerUp({ type: 'pointerup', button: 0, clientX: 796, clientY: 400, ...at });
    /** The page is told of a pointer move, as it is of every move of a pointer that holds no scrollbar. */
    const moveTold = (buttons) => bridge._handlePointerMove({ isTrusted: true, isPrimary: true, buttons, clientX: 5, clientY: 5 });

    beforeEach(() => box(8));

    it('nothing is followed while the scrollbar is held; let go at the end of the pane, it is', () => {
      pane(1000, 0);
      press();
      expect(bridge._scrollbarPress).toMatchObject({ from: 0, moved: false, atEnd: false });
      // Dragged to the end, still held: the scroll events start nothing.
      drag(900);
      expect(bridge._scrollbarPress).toMatchObject({ moved: true });
      expect(bridge._endFollow).toBeNull();
      // Dragged back up and let go short of the end: nothing.
      drag(700);
      letGo();
      expect(bridge._scrollbarPress).toBeNull();
      expect(bridge._endFollow).toBeNull();
      // Held again, dragged to the end and let go there: followed.
      press();
      drag(900);
      letGo();
      expect(bridge._endFollow).not.toBeNull();
      // The same when the thumb's last scroll has not been reported by the release.
      bridge._endFollow = null;
      pane(1000, 0);
      press();
      root.scrollTop = 900;
      letGo();
      expect(bridge._endFollow).not.toBeNull();
      // A press that was not on the scrollbar, released with the pane at its end: nothing.
      bridge._endFollow = null;
      note({ type: 'pointerdown', target: button(), button: 0, clientX: 796, clientY: 110 });
      expect(bridge._scrollbarPress).toBeNull();
      letGo();
      expect(bridge._endFollow).toBeNull();
      // A cancelled press on the scrollbar: nothing.
      pane(1000, 0);
      press();
      drag(900);
      bridge._handlePointerUp({ type: 'pointercancel' });
      expect(bridge._scrollbarPress).toBeNull();
      expect(bridge._endFollow).toBeNull();
      // A press on the scrollbar whose release never arrived: the pointer
      // moving with no button down ends it, and the release of a later press
      // elsewhere is not its release.
      pane(1000, 0);
      press();
      drag(900);
      pane(3000, 900);
      expect(bridge._scrollbarPress).not.toBeNull();
      moveTold(0);
      expect(bridge._scrollbarPress).toBeNull();
      letGo();
      expect(bridge._endFollow).toBeNull();
    });

    it('a press that holds no scrollbar is let go with nothing done, wherever it began and wherever it is let go', () => {
      // The verifier's finding (phase 9, round 2). Where the scrollbar has no
      // width of its own the strip it may be in is the pane's own padding. A
      // press there, dragged down and let go at the pane's bottom edge, sent
      // the reader to the end of the review.
      box(0);
      const atBottomEdge = { clientY: 700 };
      // The page is told of the pointer's moves: the press holds no scrollbar.
      pane(45000, 3122);
      press({ clientX: 795, clientY: 300 });
      expect(bridge._scrollbarPress).not.toBeNull();
      moveTold(1);
      expect(bridge._scrollbarPress).toBeNull();
      letGo(atBottomEdge);
      expect(bridge._endFollow).toBeNull();
      // The same press dragged into the code: the browser scrolls the pane
      // under the text selection, and the release is still nobody's scrollbar.
      pane(45000, 3122);
      press({ clientX: 795, clientY: 300 });
      moveTold(1);
      drag(3227);
      letGo({ clientX: 400, ...atBottomEdge });
      expect(bridge._endFollow).toBeNull();
      // A selection that scrolled the pane all the way to its end.
      pane(45000, 3122);
      press({ clientX: 795, clientY: 300 });
      moveTold(1);
      drag(44900);
      letGo({ clientX: 400, ...atBottomEdge });
      expect(bridge._endFollow).toBeNull();
      // No move told and nothing moved under the press (a move the page
      // never heard of): pulled to the bottom edge or not, nothing is done.
      pane(45000, 3122);
      press({ clientX: 795, clientY: 300 });
      letGo(atBottomEdge);
      expect(bridge._endFollow).toBeNull();
      // Pressed and let go with the pane at its end: nothing moved, nothing is done.
      pane(45000, 44900);
      press({ clientX: 795, clientY: 300 });
      letGo({ clientY: 300 });
      expect(bridge._endFollow).toBeNull();
      // A press on the pane itself that is not where a scrollbar is: the
      // space between two files, the left padding, beyond the pane's edge.
      for (const clientX of [400, 5, 783, 801]) {
        press({ clientX });
        expect(bridge._scrollbarPress, `x ${clientX}`).toBeNull();
      }
      // A press of another button (the middle one scrolls the pane by itself on some systems).
      press({ clientX: 795, button: 1 });
      expect(bridge._scrollbarPress).toBeNull();
      // A press whose event says nothing of where it was.
      press({ clientX: undefined });
      expect(bridge._scrollbarPress).toBeNull();
      press({ clientY: undefined });
      expect(bridge._scrollbarPress).toBeNull();
      // Beside a scrollbar that has a width of its own, the padding is not the scrollbar.
      box(8);
      press({ clientX: 788 });
      expect(bridge._scrollbarPress).toBeNull();
      press({ clientX: 793 });
      expect(bridge._scrollbarPress).not.toBeNull();
    });

    it('a thumb taken to the end of its track, under which the pane then grew, is followed when it is let go', () => {
      // The files at the end are measured in the frames after the thumb
      // arrives: the pane grows, nothing scrolls, and at the release the pane
      // is short of its end by that growth.
      pane(1000, 0);
      press();
      drag(900);
      expect(bridge._scrollbarPress.atEnd).toBe(true);
      pane(3000, 900);
      expect(bridge._endFollow).toBeNull();
      letGo();
      expect(bridge._endFollow).not.toBeNull();
      bridge._endFollow = null;

      // The same thumb dragged back up before the release: its last scroll did not leave the pane at its end.
      pane(1000, 0);
      press();
      drag(900);
      pane(3000, 900);
      drag(600);
      expect(bridge._scrollbarPress.atEnd).toBe(false);
      letGo();
      expect(bridge._endFollow).toBeNull();

      // The browser moves the thumb down again by as much as the pointer is
      // ahead of it, not all the way: a scroll down that leaves the pane short
      // of its end takes nothing back.
      pane(1000, 0);
      press();
      drag(900);
      pane(3000, 1100);
      bridge._handleRootScroll();
      expect(bridge._scrollbarPress.atEnd).toBe(true);
      letGo();
      expect(bridge._endFollow).not.toBeNull();
      bridge._endFollow = null;

      // A scroll that stops short of the end of a pane that had already grown: not the end.
      pane(1000, 0);
      press();
      pane(3000, 950);
      bridge._handleRootScroll();
      expect(bridge._scrollbarPress.atEnd).toBe(false);
      letGo();
      expect(bridge._endFollow).toBeNull();
    });

    it('a scrollbar pulled down to the pane\'s bottom edge is followed when it is let go, wherever the thumb had got to', () => {
      // The pane grew while the thumb was dragged: the thumb slid back up
      // under the pointer, and the pointer is at the bottom of the track
      // before the thumb is.
      const pull = (down, up, { from = 0, to = 2500 } = {}) => {
        bridge._endFollow = null;
        pane(3000, from);
        press(down);
        if (to !== from) drag(to);
        letGo({ clientY: 700, ...up });
        return bridge._endFollow;
      };
      // Let go at the bottom edge, and below it (the pointer may leave the pane).
      expect(pull({}, { clientY: 699 })).not.toBeNull();
      expect(pull({}, { clientY: 860 })).not.toBeNull();
      // Let go above the bottom edge: where the thumb is.
      expect(pull({}, { clientY: 690 })).toBeNull();
      // A press at the bottom of the track that did not travel (the track clicked there, which pages the pane down).
      expect(pull({ clientY: 698 }, { clientY: 699 })).toBeNull();
      // The pane did not go down with the pointer: nothing was held, or it was taken up on the way.
      expect(pull({}, { clientY: 700 }, { from: 1000, to: 1000 })).toBeNull();
      expect(pull({}, { clientY: 700 }, { from: 1000, to: 400 })).toBeNull();
      // A scrollbar drawn over the content has no width of its own: the
      // strip at the pane's edge is where it is, and what was held there
      // was a scrollbar when the pane moved under it and the page was told
      // of no pointer move.
      box(0);
      expect(pull({ clientX: 790 }, { clientY: 700 })).not.toBeNull();
      expect(pull({ clientX: 770 }, { clientY: 700 })).toBeNull();
      bridge._endFollow = null;
      pane(3000, 0);
      press({ clientX: 790 });
      moveTold(1);
      drag(2500);
      letGo({ clientY: 700 });
      expect(bridge._endFollow).toBeNull();
      // A release that says nothing of where it was decides nothing.
      expect(pull({}, { clientY: undefined })).toBeNull();
    });
  });
});
