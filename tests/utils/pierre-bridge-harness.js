// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * The production PierreBridge for unit tests, with a RECORDING STUB in place
 * of the viewer: for tests of the bridge's own pure logic
 * (loadCodeViewBridge) and for tests of the modules that talk to a bridge
 * (createBridgeHarness).
 *
 * What the stub is: an object with the viewer's method names that stores
 * every call and answers the booleans and item objects the bridge reads
 * back. It never renders, never mounts anything and never calls one of the
 * bridge's render callbacks. A unit test built on it may assert what the
 * bridge SENDS to the viewer and what the bridge decides from its own data
 * (records, metadata, ranges, keys, the flush state machine). What the
 * viewer does with what it is sent is decided only by the real bundle in a
 * real browser: tests/contract/bridge and tests/contract/vendor. See
 * tests/CONVENTIONS.md.
 *
 * The parsers (parsePatchFiles, parseDiffFromFile) are the installed
 * package's own pure functions, so the metadata a test works on is real.
 */

const path = require('path');

const MODULES = ['pierre-context.js', 'pierre-styles.js', 'pierre-annotations.js', 'pierre-gutter.js', 'pierre-bridge.js']
  .map((name) => path.join(__dirname, '..', '..', 'public', 'js', 'modules', name));

/** The recording stand-in for a CodeView instance. */
class RecordingViewer {
  constructor(options, workerManager) {
    this.options = options;
    this.workerManager = workerManager;
    this.calls = [];
    this.items = [];
    this.selection = null;
    RecordingViewer.instances.push(this);
  }
  _record(name, ...args) { this.calls.push({ name, args }); }
  count(name) { return this.calls.filter((call) => call.name === name).length; }
  last(name) { return [...this.calls].reverse().find((call) => call.name === name) || null; }
  setup(root) { this._record('setup', root); }
  setItems(items) { this._record('setItems', items); this.items = items.slice(); }
  getItem(id) { return this.items.find((item) => item.id === id); }
  updateItem(item) {
    this._record('updateItem', item);
    const index = this.items.findIndex((existing) => existing.id === item.id);
    if (index === -1) return false;
    if (this.items[index].version === item.version) return false;
    this.items[index] = item;
    return true;
  }
  render(immediate) { this._record('render', immediate); }
  setOptions(options) { this._record('setOptions', options); this.options = options; }
  scrollTo(target) { this._record('scrollTo', target); }
  getRenderedItems() { return []; }
  getSelectedLines() { return this.selection; }
  setSelectedLines(selection) { this._record('setSelectedLines', selection); this.selection = selection; }
  clearSelectedLines() { this._record('clearSelectedLines'); this.selection = null; }
  cleanUp() { this._record('cleanUp'); }
}
RecordingViewer.instances = [];

/**
 * Load the bridge and its modules into a fresh jsdom window, or into the
 * window a test already has (a file that runs in vitest's jsdom environment
 * and keeps its own `window` and `document`).
 * @param {Object} vendor - the installed package's exports (await import('@pierre/diffs'))
 * @param {Object} [options]
 * @param {Window} [options.into] - an existing window to load into; nothing
 *   global is replaced then
 * @returns {{dom: JSDOM|null, window: Window, PierreBridge: Function, RecordingViewer: Function, parseCalls: Array, restore: Function}}
 */
function loadCodeViewBridge(vendor, { into = null } = {}) {
  let dom = null;
  const previous = {};
  if (!into) {
    const { JSDOM } = require('jsdom');
    dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
    const globals = {
      window: dom.window,
      document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    };
    for (const [name, value] of Object.entries(globals)) {
      previous[name] = Object.getOwnPropertyDescriptor(global, name);
      Object.defineProperty(global, name, { value, configurable: true, writable: true });
    }
  }
  const win = into || dom.window;
  RecordingViewer.instances.length = 0;
  const parseCalls = [];
  win.PierreDiffs = {
    CodeView: RecordingViewer,
    // The class whose row-window method the bridge wraps
    // (PierreBridge.coverPaneWithRowWindow). A stand-in of its own per load:
    // the recording viewer draws nothing, and the installed package's class
    // must not be changed for the other test files of the process.
    VirtualizedFileDiff: class VirtualizedFileDiff {
      computeRenderRangeFromWindow() { return { startingLine: 0, totalLines: 0, bufferBefore: 0, bufferAfter: 0 }; }
    },
    parsePatchFiles: (...args) => { parseCalls.push(args); return vendor.parsePatchFiles(...args); },
    parseDiffFromFile: vendor.parseDiffFromFile,
  };
  for (const file of MODULES) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return {
    dom,
    window: win,
    PierreBridge: win.PierreBridge,
    RecordingViewer,
    parseCalls,
    /** Put the globals back and close the window (a window the test brought is left as it was found). */
    restore() {
      if (into) {
        for (const name of ['PierreDiffs', 'PierreBridge', 'PierreContext', 'PierreStyles', 'PierreAnnotations', 'PierreGutter']) delete win[name];
        return;
      }
      for (const [name, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(global, name, descriptor);
        else delete global[name];
      }
      dom.window.close();
    },
  };
}

/**
 * One selection callback of the viewer for an item, sent as the real
 * viewer sends it: its wrapper of each selection callback (@pierre/diffs
 * 1.6.4, CodeView defineItemSelectionCallback) first makes the range the
 * viewer's selection (or drops the selection when the range is null and the
 * selection is this item's), then calls the callback with the item's
 * options, whose `item` is the item.
 * @param {RecordingViewer} viewer
 * @param {string} key - onLineSelectionStart | onLineSelectionChange | onLineSelectionEnd | onLineSelected
 * @param {string} id
 * @param {Object|null} range
 */
function viewerSelectionCallback(viewer, key, id, range) {
  if (range) viewer.selection = { id, range };
  else if (viewer.selection?.id === id) viewer.selection = null;
  viewer.options[key]?.(range, { item: viewer.getItem(id) });
}

/**
 * A pointer gesture on the line numbers of one item, as the viewer reports
 * it (@pierre/diffs 1.6.4, InteractionManager: startLineSelectionFromPointerDown,
 * handleDocumentPointerMove, handleDocumentPointerUp): the press
 * (onLineSelectionStart), each row the pointer reaches (onLineSelectionChange,
 * the range from the anchor to that row), the release (onLineSelectionEnd,
 * then onLineSelected, both with the range the viewer holds at that moment,
 * which a correction sent in between has replaced). A range's `start` is
 * the anchor and `end` the row under the pointer; `endSide` is set when that
 * row is in the other column of a split layout. With `extendFrom`, the
 * press is a shift-click that extends that selection from its start (the
 * viewer anchors at the start when the click is below it).
 * @param {RecordingViewer} viewer
 * @param {string} id
 * @param {Array<number|[number, string]>} points - line numbers on the
 *   additions side, or `[line, side]`; the first is the press
 * @param {Object} [options]
 * @param {{start: number, end: number, side: string}} [options.extendFrom]
 * @returns {Object|null} the range the gesture ended with
 */
function selectionGesture(viewer, id, points, { extendFrom = null } = {}) {
  const [first, ...rest] = points.map((p) => (Array.isArray(p) ? { lineNumber: p[0], side: p[1] } : { lineNumber: p, side: 'additions' }));
  const anchor = extendFrom ? { lineNumber: extendFrom.start, side: extendFrom.side } : first;
  const to = (p) => ({ start: anchor.lineNumber, end: p.lineNumber, side: anchor.side, ...(p.side !== anchor.side ? { endSide: p.side } : {}) });
  if (extendFrom) viewer.selection = { id, range: extendFrom };
  viewerSelectionCallback(viewer, 'onLineSelectionStart', id, to(first));
  for (const p of rest) viewerSelectionCallback(viewer, 'onLineSelectionChange', id, to(p));
  const held = viewer.selection?.id === id ? viewer.selection.range : null;
  viewerSelectionCallback(viewer, 'onLineSelectionEnd', id, held);
  viewerSelectionCallback(viewer, 'onLineSelected', id, held);
  return held;
}

/** `count` numbered lines. */
function numberedLines(count, tag = 'line') {
  return Array.from({ length: count }, (_, i) => `${tag} ${i + 1}`);
}

/**
 * A changed file of 400 lines with two hunks (line 120 changed; a line
 * inserted after 249): its patch and its two contents.
 */
function changedFileFixture(name = 'src/a.js') {
  const oldLines = numberedLines(400);
  const newLines = oldLines.slice();
  newLines[119] = 'changed 120';
  newLines.splice(249, 0, 'inserted after 249');
  const patch = [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -117,7 +117,7 @@',
    ...oldLines.slice(116, 119).map((l) => ` ${l}`),
    `-${oldLines[119]}`,
    '+changed 120',
    ...oldLines.slice(120, 123).map((l) => ` ${l}`),
    '@@ -247,6 +247,7 @@',
    ...oldLines.slice(246, 249).map((l) => ` ${l}`),
    '+inserted after 249',
    ...oldLines.slice(249, 252).map((l) => ` ${l}`),
    '',
  ].join('\n');
  return {
    name,
    patch,
    oldFile: { name, contents: `${oldLines.join('\n')}\n` },
    newFile: { name, contents: `${newLines.join('\n')}\n` },
  };
}

/** The lines `start..end` of a file, shown by its diff on both sides (an argument of createBridgeHarness). */
function hunk(start, end) {
  return { start, end };
}

/** A patch of `name` whose hunks show exactly the given line ranges, as context lines. No hunk: a mode change. */
function patchShowing(name, hunks) {
  const head = [`diff --git a/${name} b/${name}`];
  const ranges = hunks.slice().sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return [...head, 'old mode 100644', 'new mode 100755', ''].join('\n');
  const body = [];
  for (const { start, end } of ranges) {
    const count = end - start + 1;
    body.push(`@@ -${start},${count} +${start},${count} @@`);
    for (let line = start; line <= end; line++) body.push(` line ${line}`);
  }
  return [...head, `--- a/${name}`, `+++ b/${name}`, ...body, ''].join('\n');
}

/**
 * The production PierreBridge for unit tests of the modules that talk to it
 * (ExternalCommentManager, TourRenderer, the page's card resolvers), over
 * the recording stub and loaded into the test's own window.
 *
 * The bridge's own behaviour is real: the annotation lists, the visibility
 * oracle (isLineVisible answers from the hunks a test gives a file, parsed
 * by the vendor's own parser), the element cache (getAnnotationElement), the
 * renderer registry. Nothing is ever drawn, so no card is ever attached to
 * the document: a module under test must decide from data.
 * @param {Object} vi - vitest's `vi`
 * @param {Object} vendor - the installed package's exports (await import('@pierre/diffs'))
 * @param {Object} [options]
 * @param {Array<string|Object>} [options.files] - file names, or
 *   `{ name, hunks, collapsed }`; hunks default to one hunk of lines 1-100,
 *   and `hunks: []` gives a file whose diff shows no line
 * @param {Function} [options.collaborators] - what the card builders are
 *   given; by default what PRManager._createBridge gives them, read from
 *   `window.prManager` each time a card is built
 * @returns {Object} the bridge, with `addAnnotation`, `addAnnotations`,
 *   `removeAnnotation`, `removeAnnotationsByType`, `registerAnnotationRenderer`
 *   and `getAnnotationElement` wrapped in spies that call through. A test
 *   file calls `restoreBridgeHarnesses()` in its afterEach.
 */
function createBridgeHarness(vi, vendor, { files = [], collaborators = pageCollaborators } = {}) {
  const env = loadCodeViewBridge(vendor, { into: window });
  const bridge = new env.PierreBridge({
    root: document.createElement('div'),
    theme: 'light',
    useWorkerPool: false,
    itemMetrics: { diffHeaderHeight: 45, lineHeight: 17 },
    collaborators,
  });
  const entries = files.map((file) => {
    const { name, hunks = [hunk(1, 100)], collapsed = false } = typeof file === 'string' ? { name: file } : file;
    return { id: name, kind: 'diff', patch: patchShowing(name, hunks), status: 'modified', collapsed };
  });
  bridge.renderAll(entries, { keyPrefix: 'unit' });
  for (const method of ['addAnnotation', 'addAnnotations', 'removeAnnotation',
    'removeAnnotationsByType', 'registerAnnotationRenderer', 'getAnnotationElement']) {
    vi.spyOn(bridge, method);
  }
  liveHarnesses.add({ bridge, env });
  return bridge;
}

/** The collaborators PRManager._createBridge hands the bridge, from the page manager a test put on the window. */
function pageCollaborators() {
  const manager = window.prManager;
  return {
    escapeHtml: manager && typeof manager.escapeHtml === 'function' ? (text) => manager.escapeHtml(text) : undefined,
    PostedComment: window.PostedComment,
    suggestionManager: manager ? manager.suggestionManager : undefined,
  };
}

const liveHarnesses = new Set();

/** Destroy every bridge createBridgeHarness made and take its modules off the window. */
function restoreBridgeHarnesses() {
  for (const { bridge, env } of liveHarnesses) {
    bridge.destroy();
    env.restore();
  }
  liveHarnesses.clear();
}

module.exports = {
  loadCodeViewBridge, createBridgeHarness, restoreBridgeHarnesses, hunk, RecordingViewer, numberedLines, changedFileFixture,
  viewerSelectionCallback, selectionGesture,
};
