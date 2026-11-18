// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
/**
 * A press on a control of a changed file's header, with a draw of the file
 * before the release, on the virtualized viewer
 * (plans/codeview-virtualized-diff.md, hazard H140).
 *
 * The header here is the application's own: built by
 * PRManager._buildFileHeader and re-stamped by PRManager._syncFileHeader
 * every time the viewer asks for it (PRManager._renderFileHeader), which is
 * every draw of the file. The re-stamp writes the chevron's icon again, so
 * the icon a reader pressed is not the icon under the pointer at the
 * release. The bridge's repair of the click the browser withholds
 * (PierreBridge._handlePointerUp) has to find the control, not the
 * element.
 *
 * The viewer is the recording stub of tests/utils/pierre-bridge-harness.js;
 * the same in a browser, on the real viewer: tests/e2e/file-controls.spec.js
 * ("A header control pressed while its file is drawn again").
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { loadCodeViewBridge, changedFileFixture } = require('../utils/pierre-bridge-harness.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

const A = changedFileFixture('src/a.js');

let env;
let bridge;
let manager;
let host;
let header;

// The bridge decides in a 0 ms timer set by the release. A 0 ms timer set
// after it runs after it (timers of one delay run in the order they were
// set), so this is a sentinel on the bridge's own queue, not a wait.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const down = (target) => bridge._handleRootPointerDown({ isPrimary: true, button: 0, composedPath: () => [target], target });
const up = (target) => bridge._handlePointerUp({ type: 'pointerup', button: 0, composedPath: () => [target], target });

/** What every draw of the file does with its header: out, asked for again, back in, counted. */
function drawFile() {
  header.remove();
  const again = manager._renderFileHeader(A.name, 'diff');
  host.appendChild(again);
  bridge._onPostRender(host, {}, 'update', { item: { id: bridge.files.get(A.name).id }, element: host });
  return again;
}

beforeEach(() => {
  env = loadCodeViewBridge(vendor);
  // After the window exists: the page's modules read it when they load.
  const { makePageManager } = require('../utils/page-manager.js');
  const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');
  env.window.DiffRenderer = DiffRenderer;
  bridge = new env.PierreBridge({
    root: env.window.document.getElementById('root'),
    theme: 'light',
    useWorkerPool: false,
    itemMetrics: { diffHeaderHeight: 53, lineHeight: 17 },
  });
  bridge.renderAll([{ id: A.name, kind: 'diff', patch: A.patch, status: 'modified' }]);
  manager = makePageManager({
    pierreBridge: bridge,
    changedFilesByPath: new Map([[A.name, { file: A.name, patch: A.patch }]]),
    generatedFiles: new Map(),
    // What the header's controls call: outside this unit.
    toggleFileCollapse: vi.fn(),
    toggleFileViewed: vi.fn(),
  });
  host = env.window.document.createElement('diffs-container');
  env.window.document.body.appendChild(host);
  header = manager._renderFileHeader(A.name, 'diff');
  host.appendChild(header);
  bridge._onPostRender(host, {}, 'mount', { item: { id: bridge.files.get(A.name).id }, element: host });
});

afterEach(() => {
  bridge?.destroy();
  bridge = null;
  delete env.window.DiffRenderer;
  env.restore();
});

describe('the collapse chevron of the application\'s header, pressed and released around a draw of its file', () => {
  it('a draw hands the viewer the same header with a new icon in the chevron', () => {
    const chevron = header.querySelector('.file-collapse-toggle');
    const pressed = chevron.querySelector('svg');
    expect(pressed).not.toBeNull();
    expect(drawFile()).toBe(header);
    expect(header.querySelector('.file-collapse-toggle')).toBe(chevron);
    // This is what makes the release land on another element than the press.
    expect(pressed.isConnected).toBe(false);
    expect(chevron.querySelector('svg')).not.toBe(pressed);
  });

  it('collapses the file, once: the click goes to the chevron the pressed icon was in', async () => {
    const chevron = header.querySelector('.file-collapse-toggle');
    down(chevron.querySelector('svg'));
    drawFile();
    up(chevron.querySelector('svg'));
    expect(manager.toggleFileCollapse).not.toHaveBeenCalled(); // decided at the end of the release's task
    await tick();
    expect(manager.toggleFileCollapse).toHaveBeenCalledTimes(1);
    expect(manager.toggleFileCollapse).toHaveBeenCalledWith(A.name);
    await tick();
    expect(manager.toggleFileCollapse).toHaveBeenCalledTimes(1);
  });

  it('the same for a press on the drawing inside the icon and a release on the button\'s own box', async () => {
    const chevron = header.querySelector('.file-collapse-toggle');
    down(chevron.querySelector('svg').firstElementChild || chevron.querySelector('svg'));
    drawFile();
    up(chevron);
    await tick();
    expect(manager.toggleFileCollapse).toHaveBeenCalledTimes(1);
  });

  it('adds nothing when the file was not drawn, or when the browser delivered its own click', async () => {
    const chevron = header.querySelector('.file-collapse-toggle');
    down(chevron.querySelector('svg'));
    up(chevron.querySelector('svg'));
    await tick();
    expect(manager.toggleFileCollapse).not.toHaveBeenCalled();

    down(chevron.querySelector('svg'));
    drawFile();
    up(chevron.querySelector('svg'));
    bridge._onRootClick();
    await tick();
    expect(manager.toggleFileCollapse).not.toHaveBeenCalled();
  });

  it('adds nothing for a tap: a touch gets its click from the browser after the release, whatever was drawn', async () => {
    const chevron = header.querySelector('.file-collapse-toggle');
    const touch = { pointerType: 'touch' };
    bridge._handleRootPointerDown({ isPrimary: true, button: 0, composedPath: () => [chevron.querySelector('svg')], ...touch });
    bridge._onRootPressKind({ type: 'touchstart', isTrusted: true });
    drawFile();
    bridge._handlePointerUp({ type: 'pointerup', button: 0, composedPath: () => [chevron.querySelector('svg')], ...touch });
    await tick();
    expect(manager.toggleFileCollapse).not.toHaveBeenCalled();
    // The browser's own click of that tap, on the icon that is there now: one toggle.
    chevron.querySelector('svg').dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    await tick();
    expect(manager.toggleFileCollapse).toHaveBeenCalledTimes(1);
  });

  it('the Viewed checkbox pressed, the file drawn, released on the checkbox: the checkbox is clicked, not the chevron', async () => {
    const checkbox = header.querySelector('.file-viewed-checkbox');
    const clicked = vi.fn();
    checkbox.addEventListener('click', clicked);
    down(checkbox);
    drawFile();
    up(checkbox);
    await tick();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(manager.toggleFileCollapse).not.toHaveBeenCalled();
  });

  it('a press on the chevron released on the Viewed checkbox: the click goes to the header both are in, and to neither control', async () => {
    // The browser's rule for a press and a release on different elements
    // (measured without a draw in tests/contract/bridge/gutter.spec.js): the
    // click goes to their nearest common ancestor. Here that is the header,
    // whose own listener toggles the file for a click on its background.
    const chevron = header.querySelector('.file-collapse-toggle');
    const checkbox = header.querySelector('.file-viewed-checkbox');
    const onCheckbox = vi.fn();
    const onHeader = vi.fn();
    checkbox.addEventListener('click', onCheckbox);
    header.addEventListener('click', (event) => onHeader(event.target));
    down(chevron.querySelector('svg'));
    drawFile();
    up(checkbox);
    await tick();
    expect(onCheckbox).not.toHaveBeenCalled();
    expect(onHeader).toHaveBeenCalledTimes(1);
    expect(onHeader).toHaveBeenCalledWith(header);
  });
});
