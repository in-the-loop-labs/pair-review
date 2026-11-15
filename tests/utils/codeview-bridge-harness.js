// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * The production PierreCodeViewBridge for unit tests of its pure logic, with
 * a RECORDING STUB in place of the viewer.
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
 * The parsers (parsePatchFiles, parseDiffFromFile, hydratePartialDiff) are
 * the installed package's own pure functions, so the metadata a test works
 * on is real.
 */

const path = require('path');

const MODULES = ['pierre-context.js', 'pierre-styles.js', 'pierre-annotations.js', 'pierre-gutter.js', 'pierre-codeview-bridge.js']
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
 * Load the bridge and its modules into a fresh jsdom window.
 * @param {Object} vendor - the installed package's exports (await import('@pierre/diffs'))
 * @returns {{dom: JSDOM, window: Window, PierreCodeViewBridge: Function, RecordingViewer: Function, parseCalls: Array, restore: Function}}
 */
function loadCodeViewBridge(vendor) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  const previous = {};
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
  RecordingViewer.instances.length = 0;
  const parseCalls = [];
  dom.window.PierreDiffs = {
    CodeView: RecordingViewer,
    parsePatchFiles: (...args) => { parseCalls.push(args); return vendor.parsePatchFiles(...args); },
    parseDiffFromFile: vendor.parseDiffFromFile,
    hydratePartialDiff: vendor.hydratePartialDiff,
  };
  for (const file of MODULES) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return {
    dom,
    window: dom.window,
    PierreCodeViewBridge: dom.window.PierreCodeViewBridge,
    RecordingViewer,
    parseCalls,
    /** Put the globals back and close the window. */
    restore() {
      for (const [name, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(global, name, descriptor);
        else delete global[name];
      }
      dom.window.close();
    },
  };
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

module.exports = { loadCodeViewBridge, RecordingViewer, numberedLines, changedFileFixture };
