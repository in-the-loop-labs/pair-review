// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * A page manager (tests/utils/page-manager.js) with the production bridge,
 * built by the page's own `_createBridge` over the recording stand-in of
 * the viewer (tests/utils/pierre-bridge-harness.js). The wiring between the
 * two is the production one: the bridge's interaction handlers are
 * PRManager._bridgeInteractionOptions, its `resolvePath` hook is
 * PRManager._canonicalFilePath, and the files are given to it by
 * `renderAll` as renderDiff gives them. Nothing is ever drawn, so a test
 * built on this decides from data, as the page must for a file that is not
 * mounted.
 *
 * For a test file that runs in vitest's jsdom environment. Call
 * `restorePageBridges()` in afterEach.
 */

const { loadCodeViewBridge } = require('./pierre-bridge-harness.js');
const { makePageManager } = require('./page-manager.js');
const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

const live = new Set();

/**
 * @param {Object} vendor - the installed package's exports (await import('@pierre/diffs'))
 * @param {Object} options
 * @param {Array<{name: string, patch: string}>} [options.files] - changed files, in diff order
 * @param {Array<{name: string, contents: string}>} [options.contextFiles] - context files
 *   (their whole contents, shown from line 1 to `endLine`, default the last line)
 * @param {Object} [options.overrides] - own properties of the page manager
 * @returns {{manager: Object, bridge: Object}}
 */
function makePageWithBridge(vendor, { files = [], contextFiles = [], overrides = {} } = {}) {
  window.DiffRenderer = DiffRenderer;
  const root = document.createElement('div');
  root.id = 'diff-container';
  document.body.appendChild(root);
  const env = loadCodeViewBridge(vendor, { into: window });
  const changedFilesByPath = new Map(files.map((file) => [file.name, { file: file.name, patch: file.patch }]));
  const manager = makePageManager({
    changedFilesByPath,
    contextFiles: contextFiles.map((file, index) => ({ id: index + 1, file: file.name, line_start: 1, line_end: file.endLine || null })),
    loadUserComments: async () => {},
    ...overrides,
  });
  manager.pierreBridge = manager._createBridge(manager._bridgeInteractionOptions('unified'));
  const entries = [
    ...contextFiles.map((file) => ({ id: file.name, kind: 'context', contents: file.contents, ranges: [{ startLine: 1, endLine: file.endLine || countLines(file.contents) }] })),
    ...files.map((file) => ({ id: file.name, kind: 'diff', patch: file.patch, status: 'modified' })),
  ];
  manager.pierreBridge.renderAll(entries, { keyPrefix: 'unit' });
  for (const file of contextFiles) {
    manager._contextItemIds.add(file.name);
    manager._fileCollapsed.set(manager._fileStateKey(file.name), false);
  }
  live.add({ bridge: manager.pierreBridge, env, root });
  return { manager, bridge: manager.pierreBridge };
}

/** Lines of a text as the viewer counts them (a final newline ends the last line). */
function countLines(text) {
  if (!text) return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Destroy every bridge makePageWithBridge made and take its modules off the window. */
function restorePageBridges() {
  for (const { bridge, env, root } of live) {
    bridge.destroy();
    env.restore();
    root.remove();
  }
  live.clear();
  delete window.DiffRenderer;
}

module.exports = { makePageWithBridge, restorePageBridges };
