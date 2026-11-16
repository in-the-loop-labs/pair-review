// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * The header of a context file (PRManager._buildContextFileHeader) and the
 * functions its controls call.
 *
 * The header is one element that the table renderer puts in a wrapper and
 * the virtualized viewer puts in an item's header slot, so nothing it does
 * may depend on what it is attached to: its controls call functions that
 * work from data (the context rows, the state keys). On the virtualized
 * viewer those functions need no element at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { makePageManager } = require('../utils/page-manager.js');
const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

const FILE = 'ctx/notes.js';
const row = (id, file = FILE) => ({ id, file, line_start: 1, line_end: 10, label: null });

function makeManager(overrides = {}) {
  return makePageManager({
    contextFiles: [row(11), row(12), row(13, 'ctx/other.js')],
    saveViewedState: vi.fn(),
    updateFileItemViewedState: vi.fn(),
    removeContextFile: vi.fn(async () => {}),
    ...overrides,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.DiffRenderer = DiffRenderer;
});

afterEach(() => {
  delete window.DiffRenderer;
  delete window.chatPanel;
  vi.restoreAllMocks();
});

describe('_buildContextFileHeader', () => {
  it('has the chevron, the path, the CONTEXT badge with the row\'s label, Viewed, chat and dismiss', () => {
    const header = makeManager()._buildContextFileHeader(FILE, { label: 'why this file is here' });
    expect(header.className).toBe('d2h-file-header context-file-header');
    expect([...header.children].map((el) => el.className)).toEqual([
      'file-collapse-toggle', expect.stringContaining('d2h-file-name'), 'context-badge',
      'file-viewed-label', 'file-header-chat-btn', 'context-file-dismiss',
    ]);
    expect(header.querySelector('.d2h-file-name').textContent).toBe(FILE);
    expect(header.querySelector('.context-badge').textContent).toBe('CONTEXT');
    expect(header.querySelector('.context-badge').title).toBe('why this file is here');
  });

  it('with a comment zone it has the file-comment button, which opens a form in that zone', () => {
    const zone = document.createElement('div');
    const fileCommentManager = { showCommentForm: vi.fn() };
    const header = makeManager({ fileCommentManager })._buildContextFileHeader(FILE, { zone });
    const button = header.querySelector('.file-header-comment-btn');
    expect(button).not.toBeNull();
    expect(zone.headerButton).toBe(button);
    button.click();
    expect(fileCommentManager.showCommentForm).toHaveBeenCalledWith(zone, FILE);
  });

  it('the Viewed checkbox starts from the context key, never from a changed file\'s key for the same path', () => {
    const viewedAsDiff = makeManager({ viewedFiles: new Set([FILE]) });
    expect(viewedAsDiff._buildContextFileHeader(FILE).querySelector('.file-viewed-checkbox').checked).toBe(false);
    const viewedAsContext = makeManager({ viewedFiles: new Set([`context:${FILE}`]) });
    expect(viewedAsContext._buildContextFileHeader(FILE).querySelector('.file-viewed-checkbox').checked).toBe(true);
  });

  it('the chevron and a click on the header toggle the context file; a click on a control does not', () => {
    const manager = makeManager();
    manager.toggleContextFileCollapse = vi.fn();
    manager.toggleContextFileViewed = vi.fn();
    const header = manager._buildContextFileHeader(FILE);
    document.body.appendChild(header);

    header.querySelector('.file-collapse-toggle').click();
    header.querySelector('.d2h-file-name').click();
    expect(manager.toggleContextFileCollapse.mock.calls).toEqual([[FILE], [FILE]]);

    header.querySelector('.file-viewed-label').click();
    header.querySelector('.file-header-chat-btn').click();
    header.querySelector('.context-file-dismiss').click();
    expect(manager.toggleContextFileCollapse).toHaveBeenCalledTimes(2);
  });

  it('the Viewed checkbox routes to the context file\'s own viewed state', () => {
    const manager = makeManager();
    manager.toggleContextFileViewed = vi.fn();
    const checkbox = manager._buildContextFileHeader(FILE).querySelector('.file-viewed-checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(manager.toggleContextFileViewed).toHaveBeenCalledWith(FILE, true);
  });

  it('the chat button opens the chat panel about the file', () => {
    window.chatPanel = { open: vi.fn() };
    makeManager()._buildContextFileHeader(FILE).querySelector('.file-header-chat-btn').click();
    expect(window.chatPanel.open).toHaveBeenCalledWith({ fileContext: { file: FILE } });
  });

  it('dismiss removes every stored range of the file, taken from the rows, one after the other', async () => {
    const manager = makeManager();
    const order = [];
    let release;
    manager.removeContextFile = vi.fn((id) => {
      order.push(`start ${id}`);
      if (id !== 11) return Promise.resolve().then(() => order.push(`end ${id}`));
      return new Promise((resolve) => { release = () => { order.push('end 11'); resolve(); }; });
    });
    // The header is not in a wrapper and there is no chunk in the document:
    // the ids can only have come from data.
    const header = manager._buildContextFileHeader(FILE);
    header.querySelector('.context-file-dismiss').click();
    expect(order).toEqual(['start 11']);
    release();
    await vi.waitFor(() => expect(order).toEqual(['start 11', 'end 11', 'start 12', 'end 12']));
    // The other file's row is not touched.
    expect(manager.removeContextFile.mock.calls.map(([id]) => id)).toEqual([11, 12]);
  });
});

describe('on the virtualized viewer the context toggles need no element', () => {
  function codeviewManager(overrides = {}) {
    const bridge = { files: new Map([[FILE, { kind: 'context' }]]), setCollapsed: vi.fn(), refreshHostState: vi.fn() };
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge, ...overrides });
    manager._contextItemIds.add(FILE);
    manager._fileCollapsed.set(`context:${FILE}`, manager.viewedFiles.has(`context:${FILE}`));
    return manager;
  }

  it('toggleContextFileCollapse goes through setFileCollapsed, under the context key', async () => {
    const manager = codeviewManager();
    manager.toggleContextFileCollapse(FILE);
    await vi.waitFor(() => expect(manager.isFileCollapsed(FILE)).toBe(true));
    expect([...manager.collapsedFiles]).toEqual([`context:${FILE}`]);
    expect(manager.pierreBridge.setCollapsed).toHaveBeenLastCalledWith(FILE, true);

    manager.toggleContextFileCollapse(FILE);
    await vi.waitFor(() => expect(manager.isFileCollapsed(FILE)).toBe(false));
    expect([...manager.collapsedFiles]).toEqual([]);
    expect(manager.pierreBridge.setCollapsed).toHaveBeenLastCalledWith(FILE, false);
  });

  it('toggleContextFileViewed stores the context key, collapses, updates the context sidebar row and saves', async () => {
    const manager = codeviewManager();
    manager.toggleContextFileViewed(FILE, true);
    await vi.waitFor(() => expect(manager.isFileCollapsed(FILE)).toBe(true));
    expect([...manager.viewedFiles]).toEqual([`context:${FILE}`]);
    expect(manager.updateFileItemViewedState).toHaveBeenLastCalledWith(FILE, true, { contextItem: true });
    expect(manager.saveViewedState).toHaveBeenCalledTimes(1);

    manager.toggleContextFileViewed(FILE, false);
    await vi.waitFor(() => expect(manager.isFileCollapsed(FILE)).toBe(false));
    expect([...manager.viewedFiles]).toEqual([]);
    expect(manager.updateFileItemViewedState).toHaveBeenLastCalledWith(FILE, false, { contextItem: true });
    expect(manager.saveViewedState).toHaveBeenCalledTimes(2);
  });

  it('un-viewing a file the reader had expanded again leaves it expanded; viewing a collapsed one leaves it collapsed', async () => {
    const manager = codeviewManager({ viewedFiles: new Set([`context:${FILE}`]) });
    await manager.setFileCollapsed(FILE, false);
    manager.pierreBridge.setCollapsed.mockClear();
    manager.toggleContextFileViewed(FILE, false);
    await Promise.resolve();
    expect(manager.isFileCollapsed(FILE)).toBe(false);
    expect(manager.pierreBridge.setCollapsed).not.toHaveBeenCalled();
  });

  it('the cached header is re-stamped from data: chevron, Viewed, badge title', async () => {
    const manager = codeviewManager();
    const header = manager._renderFileHeader(FILE, 'context');
    expect(manager._renderFileHeader(FILE, 'context')).toBe(header);
    expect(header.querySelector('.file-viewed-checkbox').checked).toBe(false);
    expect(header.querySelector('.file-collapse-toggle').title).toBe('Collapse file');

    // Changes made while the header was not on screen.
    manager.viewedFiles.add(`context:${FILE}`);
    manager._fileCollapsed.set(`context:${FILE}`, true);
    manager.contextFiles[0].label = 'added by a tour stop';
    manager._renderFileHeader(FILE, 'context');
    expect(header.querySelector('.file-viewed-checkbox').checked).toBe(true);
    expect(header.querySelector('.file-collapse-toggle').title).toBe('Expand file');
    expect(header.querySelector('.context-badge').title).toBe('added by a tour stop');
  });

  it('never writes a class on the viewer\'s host: the bridge is asked to stamp it', async () => {
    const host = document.createElement('diffs-container');
    host.className = 'd2h-file-wrapper context-file';
    host.dataset.fileName = FILE;
    document.body.appendChild(host);
    const manager = codeviewManager({ findFileElement: () => host });
    await manager.setFileCollapsed(FILE, true);
    expect(host.classList.contains('collapsed')).toBe(false);
    expect(manager.pierreBridge.refreshHostState).toHaveBeenCalledWith(FILE);
    expect(manager.pierreBridge.setCollapsed).toHaveBeenCalledWith(FILE, true);
  });
});

describe('the summary toggle of a changed file\'s cached header (virtualized viewer)', () => {
  // A header of the virtualized viewer is drawn again whenever its file comes
  // near the viewport, and re-stamped from data each time. The toggle must
  // then say what it says on the per-file renderer, where a header is built
  // once: "No summaries available" until a summary was drawn on the file,
  // its hidden state was restored, or the reader used the toggle.
  const A = 'src/a.js';
  // jsdom has no CSS.escape; the paths here need no escaping.
  beforeEach(() => { globalThis.CSS = { escape: (value) => value }; });
  afterEach(() => { delete globalThis.CSS; });
  function setup() {
    const manager = makeManager({
      _diffEngine: 'codeview',
      changedFilesByPath: new Map([[A, { file: A, patch: '@@ -1 +1 @@\n-a\n+b\n' }]]),
      summariesHiddenFiles: new Set(),
      _summariesEnabled: true,
      // The file's hunks are known (their hashes are registered) as soon as the diff is drawn.
      _summaryHashesByFile: new Map([[A, new Set(['hash-1'])]]),
    });
    const header = document.createElement('div');
    header.innerHTML = '<button class="file-header-summary-toggle"></button>';
    manager._fileHeaders.set(A, header);
    return { manager, header, toggle: header.querySelector('.file-header-summary-toggle') };
  }

  it('says there are none on every draw of the header while no summary was drawn on the file', () => {
    const { manager, toggle } = setup();
    manager._syncFileHeader(A);
    manager._syncFileHeader(A);
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe('No summaries available');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('is live once a summary was drawn on the file, also when the file had no element then', () => {
    const { manager, toggle } = setup();
    // The file is far from the viewport: there is no wrapper to find.
    manager._refreshFileSummaryToggle(A);
    manager._syncFileHeader(A);
    expect(toggle.disabled).toBe(false);
    expect(toggle.title).toBe('Hide file summaries');
  });

  it('shows a hidden file as hidden once the reader used the toggle', () => {
    const { manager, toggle } = setup();
    manager._setFileElementClass = vi.fn();
    const wrapper = document.createElement('div');
    wrapper.appendChild(toggle.cloneNode());
    manager.currentPR = null;
    manager.toggleFileSummaries(A, wrapper);
    manager._syncFileHeader(A);
    expect(manager.summariesHiddenFiles.has(A)).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(toggle.title).toBe('Show file summaries');
    expect(toggle.classList.contains('summaries-off')).toBe(true);
  });

  it('starts over with a new render', () => {
    const { manager, toggle } = setup();
    manager._refreshFileSummaryToggle(A);
    manager._resetHunkSummaryRenderState();
    manager._summaryHashesByFile = new Map([[A, new Set(['hash-1'])]]);
    manager._syncFileHeader(A);
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe('No summaries available');
  });
});
