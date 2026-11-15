// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
/**
 * Pure logic of PierreCodeViewBridge: what it decides from its own data and
 * what it sends to the viewer. The viewer here is a recording stub that
 * never renders (tests/utils/codeview-bridge-harness.js); what the real
 * viewer does is tested in a browser (tests/contract/bridge).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { loadCodeViewBridge, numberedLines, changedFileFixture } = require('../utils/codeview-bridge-harness.js');

const BRIDGE_SOURCE = path.join(__dirname, '..', '..', 'public', 'js', 'modules', 'pierre-codeview-bridge.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

let env;
let PierreCodeViewBridge;
let bridge;

function create(options = {}) {
  bridge = new PierreCodeViewBridge({
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
  PierreCodeViewBridge = env.PierreCodeViewBridge;
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

    const rootless = new PierreCodeViewBridge({ useWorkerPool: false });
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
    expect(PierreCodeViewBridge.isValidDiffStyle('split')).toBe(true);
    expect(PierreCodeViewBridge.isValidDiffStyle(undefined)).toBe(false);
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
    expect(record.contextRanges).toEqual([{ startLine: 124, endLine: 143 }]);
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
    const strategy = PierreCodeViewBridge.upgradeStrategy;
    expect(strategy({ type: 'change', hunks: [{}] })).toBe('hydrate');
    expect(strategy({ type: 'rename-changed', hunks: [{}] })).toBe('hydrate');
    expect(strategy({ type: 'new', hunks: [{}] })).toBe('none');
    expect(strategy({ type: 'deleted', hunks: [{}] })).toBe('none');
    expect(strategy({ type: 'rename-pure', hunks: [] })).toBe('reparse');
    expect(strategy({ type: 'change', hunks: [] })).toBe('reparse');
    expect(strategy(null)).toBe('none');
    expect(strategy({ type: 'change' })).toBe('none');
  });

  it('a changed file is hydrated: git\'s hunks kept, no longer partial, published under a new key', () => {
    bridge.renderAll([diffEntry(A)]);
    const record = bridge.files.get('src/a.js');
    const patchKey = record.metadata.cacheKey;
    viewer().calls.length = 0;
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(true);
    expect(record.upgraded).toBe(true);
    expect(record.metadata.isPartial).toBe(false);
    expect(record.metadata.hunks.map((h) => [h.additionStart, h.additionCount])).toEqual(record.patchMetadata.hunks.map((h) => [h.additionStart, h.additionCount]));
    expect(record.metadata.additionLines).toHaveLength(401);
    expect(record.metadata.cacheKey).not.toBe(patchKey);
    expect(record.metadata.cacheKey.startsWith(`${record.baseKey}|d`)).toBe(true);
    expect(viewer().count('updateItem')).toBe(1);
    expect(viewer().last('updateItem').args[0].fileDiff).toBe(record.metadata);
    // A second call changes nothing.
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(true);
    expect(viewer().count('updateItem')).toBe(1);
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

  it('hydration that throws leaves the file as it was and says so', () => {
    bridge.renderAll([diffEntry(A)]);
    env.window.PierreDiffs.hydratePartialDiff = () => { throw new Error('contents do not match'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('src/a.js'), expect.any(Error));
    warn.mockRestore();
    expect(bridge.files.get('src/a.js').upgraded).toBe(false);
    expect(bridge.files.get('src/a.js').metadata).toBe(bridge.files.get('src/a.js').patchMetadata);
  });

  it('a file the bridge does not hold, a context file and a deferred file are not upgraded', () => {
    bridge.renderAll([contextEntry('ctx/c.js'), diffEntry(A, { deferred: true })]);
    expect(bridge.upgradeFileContents('nope.js', A.oldFile, A.newFile)).toBe(false);
    expect(bridge.upgradeFileContents('ctx/c.js', A.oldFile, A.newFile)).toBe(false);
    expect(bridge.upgradeFileContents('src/a.js', A.oldFile, A.newFile)).toBe(false);
  });

  it('forcePlainText: the patch\'s metadata and the hydrated one are both plain text', () => {
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
    const copy = PierreCodeViewBridge.rekey(record, record.metadata);
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
    // Gap 1 is new lines 124-246. The instance is what the bridge learns from the viewer's mount callback.
    record._instance = { hunksRenderer: { expandedHunks: new Map([[1, { fromStart: 20, fromEnd: 0 }]]) } };
    expect(bridge.isLineVisible('src/a.js', 124, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 143, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 144, 'RIGHT')).toBe(false);
    // Old numbering on the left: the same lines are old 124-143 (nothing was inserted above them).
    expect(bridge.isLineVisible('src/a.js', 143, 'LEFT')).toBe(true);

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
    // The viewer still draws the old diff, now without those lines: it is
    // told to compute the item's height again, once.
    expect(resetLayoutCache.mock.calls).toEqual([[{ includeEstimatedHeights: true }]]);
    // Infinity is the whole gap (124-246), clamped to it; ten lines before the first hunk.
    expect(record.contextRanges).toEqual([{ startLine: 107, endLine: 116 }, { startLine: 124, endLine: 246 }, { startLine: 300, endLine: 302 }]);
    expect(bridge.isLineVisible('src/a.js', 200, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible('src/a.js', 106, 'RIGHT')).toBe(false);
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
    const lang = PierreCodeViewBridge.contextLanguage;
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
    expect(recordA.contextRanges).toEqual([{ startLine: 124, endLine: 143 }]);
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
    expect(PierreCodeViewBridge.toPierreSide('LEFT')).toBe('deletions');
    expect(PierreCodeViewBridge.toPierreSide('deletions')).toBe('deletions');
    expect(PierreCodeViewBridge.toPierreSide('RIGHT')).toBe('additions');
    expect(PierreCodeViewBridge.toPierreSide(undefined)).toBe('additions');
    expect(PierreCodeViewBridge.toPairReviewSide('deletions')).toBe('LEFT');
    expect(PierreCodeViewBridge.toPairReviewSide('additions')).toBe('RIGHT');
    expect(PierreCodeViewBridge.normalizeSide('LEFT')).toBe('LEFT');
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
