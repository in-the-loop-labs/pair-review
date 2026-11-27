// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * PRManager.renderDiff and the functions around it: what the page gives the
 * bridge and what it keeps, decided from data. The bridge here is a
 * recording stub: it stores calls and answers booleans. What the viewer
 * draws is tests/contract/bridge and the E2E suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { makePageManager } = require('../utils/page-manager.js');
const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

const patchOf = (name) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n`;
const file = (name, extra = {}) => ({ file: name, patch: patchOf(name), insertions: 1, deletions: 1, ...extra });

function makeBridge() {
  const bridge = {
    files: new Map(),
    calls: [],
    renderAll: vi.fn((entries) => {
      bridge.files = new Map(entries.map((entry) => [entry.id, { id: entry.id, kind: entry.kind, deferred: !!entry.deferred }]));
      return true;
    }),
    reconcile: vi.fn(() => ({ applied: true, created: [], removed: [], updated: [], listWritten: false })),
    setCollapsed: vi.fn(),
    setDiffStyle: vi.fn((style) => style === 'unified' || style === 'split'),
    scrollToItem: vi.fn(() => true),
    scrollToLine: vi.fn(() => true),
    refreshHostState: vi.fn(),
    materializeDeferred: vi.fn(() => true),
  };
  return bridge;
}

function makeManager(overrides = {}) {
  return makePageManager({
    pierreBridge: makeBridge(),
    generatedFiles: new Map(),
    summariesHiddenFiles: new Set(),
    _summaryAnchorsByHash: new Map(),
    _summaryHashesByFile: new Map(),
    loadContextFiles: vi.fn(async () => {}),
    _fetchHunkSummaryMap: vi.fn(async () => {}),
    _registerPierreHunkAnchorsForFile: vi.fn(),
    ...overrides,
  });
}

beforeEach(() => {
  document.body.innerHTML = '<main class="diff-view"><div id="diff-status"></div><div id="diff-container" hidden></div></main>';
  window.DiffRenderer = DiffRenderer;
});

afterEach(() => {
  delete window.DiffRenderer;
  vi.restoreAllMocks();
});

describe('renderDiff on the virtualized viewer', () => {
  it('gives the bridge one entry per changed file, in diff order, keyed by the review', () => {
    const manager = makeManager({ currentPR: { id: 42 } });
    manager.renderDiff({ changed_files: [file('src/b.js'), file('src/a.js')] });

    expect(manager.pierreBridge.renderAll).toHaveBeenCalledTimes(1);
    const [entries, options] = manager.pierreBridge.renderAll.mock.calls[0];
    expect(entries.map((entry) => entry.id)).toEqual(['src/b.js', 'src/a.js']);
    expect(options).toEqual({ keyPrefix: 42 });
    expect([...manager.changedFilesByPath.keys()]).toEqual(['src/b.js', 'src/a.js']);
    expect(manager._registerPierreHunkAnchorsForFile).toHaveBeenCalledTimes(2);
  });

  it('shows the container before the bridge renders (the viewer measures its rows there) and no status', () => {
    const manager = makeManager();
    const container = document.getElementById('diff-container');
    manager.pierreBridge.renderAll.mockImplementation(() => {
      expect(container.hidden).toBe(false);
      return true;
    });
    manager.renderDiff({ changed_files: [file('src/a.js')] });
    expect(document.getElementById('diff-status').hidden).toBe(true);
    // Nothing of the page's is put in the container: its children are the viewer's.
    expect(container.children).toHaveLength(0);
  });

  it('a missing file list is not an empty diff: nothing is rendered and nothing is reset', () => {
    const manager = makeManager({ changedFilesByPath: new Map([['kept.js', file('kept.js')]]), _renderGen: 5 });
    manager.renderDiff({});
    manager.renderDiff(null);
    manager.renderDiff({ changed_files: 'nope' });
    expect(manager.pierreBridge.renderAll).not.toHaveBeenCalled();
    expect([...manager.changedFilesByPath.keys()]).toEqual(['kept.js']);
    expect(manager._renderGen).toBe(5);
    expect(manager.loadContextFiles).not.toHaveBeenCalled();
  });

  it('an empty diff keeps the viewer (context files are its items) under the message', () => {
    const manager = makeManager();
    manager.renderDiff({ changed_files: [] });
    expect(manager.pierreBridge.renderAll).toHaveBeenCalledWith([], expect.anything());
    const status = document.getElementById('diff-status');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('No files changed');
    expect(document.getElementById('diff-container').hidden).toBe(false);
  });

  it('starts a new render generation, keeps the context rows and reads their contents again', () => {
    const rows = [{ id: 1, file: 'ctx.js', line_start: 1, line_end: 5 }];
    const manager = makeManager({ contextFiles: rows, _renderGen: 3 });
    manager._contextContents.set('ctx.js', { text: 'a\nb\nc', seq: 1 });
    manager._contextItemIds.add('ctx.js');

    manager.renderDiff({ changed_files: [file('src/a.js')] });

    expect(manager._renderGen).toBe(4);
    expect(manager.contextFiles).toBe(rows);
    // The context file the page already knows is in the first list, in its place.
    expect(manager.pierreBridge.renderAll.mock.calls[0][0].map((entry) => `${entry.kind}:${entry.id}`))
      .toEqual(['context:ctx.js', 'diff:src/a.js']);
    expect(manager.loadContextFiles).toHaveBeenCalledWith({ refreshContents: true });
    // The page starts the render knowing no context item, so that load reloads the comments.
    expect([...manager._contextItemIds]).toEqual([]);
  });

  it('a context row whose path entered the diff is not an entry any more (the diff wins)', () => {
    const manager = makeManager({ contextFiles: [{ id: 1, file: 'src/a.js', line_start: 1, line_end: 5 }] });
    manager._contextContents.set('src/a.js', { text: 'a\nb\nc', seq: 1 });
    manager.renderDiff({ changed_files: [file('src/a.js')] });
    expect(manager.pierreBridge.renderAll.mock.calls[0][0].map((entry) => `${entry.kind}:${entry.id}`)).toEqual(['diff:src/a.js']);
  });

  it('headers, comment zones and collapsed state are a render\'s: a new render drops them', () => {
    const fileCommentManager = { releaseAllZones: vi.fn(), getZone: () => null, createFileCommentsZone: () => document.createElement('div') };
    const manager = makeManager({ fileCommentManager });
    manager._fileHeaders.set('old.js', document.createElement('div'));
    manager._fileCollapsed.set('old.js', true);
    manager.renderDiff({ changed_files: [file('src/a.js')] });
    expect(manager._fileHeaders.size).toBe(0);
    expect([...manager._fileCollapsed.keys()]).toEqual(['src/a.js']);
    expect(fileCommentManager.releaseAllZones).toHaveBeenCalledTimes(1);
  });

  it('every file gets its own comment zone, also when its path is the tail of another file\'s', () => {
    const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
    const fileCommentManager = new FileCommentManager({});
    const manager = makeManager({ fileCommentManager });
    // The registry's lookup is tolerant: asked for 'a.js' it answers with the zone of 'src/a.js'.
    manager.renderDiff({ changed_files: [file('src/a.js'), file('a.js')] });
    const first = manager._ensureFileCommentsZone('src/a.js');
    const second = manager._ensureFileCommentsZone('a.js');
    expect(first.dataset.fileName).toBe('src/a.js');
    expect(second.dataset.fileName).toBe('a.js');
    expect(second).not.toBe(first);
    // Asked again, each file gets the zone it has.
    expect(manager._ensureFileCommentsZone('a.js')).toBe(second);
    expect(manager._ensureFileCommentsZone('src/a.js')).toBe(first);
  });

  it('the tour is left before the list is replaced', () => {
    const order = [];
    const manager = makeManager({ _tourIsActive: () => true, _exitTour: () => order.push('exit tour') });
    manager.pierreBridge.renderAll.mockImplementation(() => { order.push('renderAll'); return true; });
    manager.renderDiff({ changed_files: [file('src/a.js')] });
    expect(order).toEqual(['exit tour', 'renderAll']);
  });

  it('without the viewer (its bundle did not load) the pane says so in place of the diff', () => {
    const manager = makeManager({ pierreBridge: null });
    manager.renderDiff({ changed_files: [file('src/a.js')] });
    const status = document.getElementById('diff-status');
    expect(status.hidden).toBe(false);
    expect(status.querySelector('.diff-viewer-missing').textContent).toMatch(/The diff viewer could not be loaded/);
    expect(document.getElementById('diff-container').hidden).toBe(true);
    expect(manager.handleDiffViewChange('split')).toBe(false);
  });
});

describe('around renderDiff on the virtualized viewer', () => {
  function rendered(files = [file('src/a.js'), file('src/b.js')], overrides = {}) {
    const manager = makeManager(overrides);
    manager.renderDiff({ changed_files: files });
    return manager;
  }

  it('_clearDiffItems gives the viewer an empty list, releases the comment zones and never touches the container\'s children', () => {
    const manager = rendered();
    const container = document.getElementById('diff-container');
    const viewerChild = container.appendChild(document.createElement('diffs-container'));
    const releaseAllZones = vi.fn();
    manager.fileCommentManager = { ...(manager.fileCommentManager || {}), releaseAllZones };
    manager._clearDiffItems();
    expect(manager.pierreBridge.renderAll).toHaveBeenLastCalledWith([], expect.anything());
    expect(releaseAllZones).toHaveBeenCalledTimes(1);
    expect(viewerChild.parentNode).toBe(container);
    expect(manager.changedFilesByPath.size).toBe(0);
    expect(manager.isFileCollapsed('src/a.js')).toBeNull();
  });

  it('_clearDiffItems does not throw without a bridge or a file comment manager', () => {
    const manager = rendered();
    manager.pierreBridge = null;
    manager.fileCommentManager = null;
    expect(() => manager._clearDiffItems()).not.toThrow();
    expect(manager.changedFilesByPath.size).toBe(0);
  });

  it('scrollToFile addresses the item by its canonical path, mounted or not', async () => {
    const manager = rendered();
    await manager.scrollToFile('./src/b.js');
    expect(manager.pierreBridge.scrollToItem).toHaveBeenCalledWith('src/b.js', { align: 'start', behavior: 'smooth' });
    await manager.scrollToFile('nowhere.js');
    expect(manager.pierreBridge.scrollToItem).toHaveBeenCalledTimes(1);
  });

  it('handleDiffViewChange hands the layout to the bridge and reports whether it took it', () => {
    const manager = rendered();
    expect(manager.handleDiffViewChange('split')).toBe(true);
    expect(manager.pierreBridge.setDiffStyle).toHaveBeenCalledWith('split');
    expect(manager.handleDiffViewChange('sideways')).toBe(false);
  });

  it('says whether a drawn file is still to be given its contents: until the catch-up sweep has run, while a file is queued or in flight, and never for a render that was replaced', async () => {
    vi.useFakeTimers();
    try {
      const files = [file('src/a.js'), file('src/b.js')];
      const manager = rendered(files);
      manager.currentPR = { id: 7 };
      // What the bridge's hook asks (PierreBridge._holdEndAfterCollapse).
      const awaited = () => manager._isContentUpgradeAwaited();
      expect(awaited()).toBe(false);

      // The files drawn first wait for the sweep, with nothing queued.
      manager._upgradeFilesWithContents(files);
      expect(manager._fileContentsUpgradeState).toBeNull();
      expect(awaited()).toBe(true);
      await vi.advanceTimersByTimeAsync(1100);
      // The sweep ran and found no file mounted.
      expect(awaited()).toBe(false);

      // A file is mounted: queued, then in flight for as long as its upgrade takes
      // (the request, and the wait while the pointer rests on the file).
      let land;
      manager._fetchAndUpgradePierreFileContents = vi.fn(() => new Promise((resolve) => { land = resolve; }));
      manager._onDiffItemLifecycle('src/a.js', 'mount');
      expect(awaited()).toBe(true);
      await vi.advanceTimersByTimeAsync(12000);
      expect(manager._fetchAndUpgradePierreFileContents).toHaveBeenCalledTimes(1);
      expect(awaited()).toBe(true);
      land(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(awaited()).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(manager._fileContentsUpgradeState).toBeNull();
      expect(awaited()).toBe(false);

      // An upgrade a navigation asked for.
      manager.pierreBridge.files.get('src/b.js').baseMetadata = null;
      const asked = manager._ensurePierreContentUpgrade('src/b.js');
      expect(awaited()).toBe(true);
      land(false);
      await asked;
      expect(awaited()).toBe(false);

      // A render that was replaced awaits nothing, whatever it had started.
      manager._onDiffItemLifecycle('src/b.js', 'mount');
      expect(awaited()).toBe(true);
      manager._abortContentUpgrades();
      expect(awaited()).toBe(false);
      manager._upgradeFilesWithContents(files);
      expect(awaited()).toBe(true);
      manager._abortContentUpgrades();
      expect(awaited()).toBe(false);
      await vi.advanceTimersByTimeAsync(1100);
      expect(awaited()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the bridge is given the hook that asks it', () => {
    const manager = makeManager();
    let options = null;
    window.PierreBridge = class {
      constructor(given) { options = given; this.available = true; }
      registerAnnotationRenderer() {}
    };
    try {
      manager._createBridge({});
      manager._isContentUpgradeAwaited = vi.fn(() => true);
      expect(options.hooks.contentsAwaited()).toBe(true);
      expect(manager._isContentUpgradeAwaited).toHaveBeenCalledTimes(1);
    } finally {
      delete window.PierreBridge;
    }
  });

  it('a file whose item comes into the mounted window is queued for its content upgrade; a context file is not', () => {
    const manager = rendered();
    manager._enqueuePierreContentUpgrade = vi.fn();
    manager._onDiffItemLifecycle('src/a.js', 'mount');
    manager._onDiffItemLifecycle('ctx.js', 'mount');
    manager._onDiffItemLifecycle('src/a.js', 'update');
    expect(manager._enqueuePierreContentUpgrade.mock.calls.map(([f]) => f.file)).toEqual(['src/a.js']);
    // The catch-up sweep takes mounted files only: the bridge has a record of every file.
    expect(manager._getPierreContentUpgradeFiles([...manager.changedFilesByPath.values()]).map((f) => f.file)).toEqual(['src/a.js']);
    manager._onDiffItemLifecycle('src/a.js', 'unmount');
    expect(manager._getPierreContentUpgradeFiles([...manager.changedFilesByPath.values()])).toEqual([]);
  });

  it('the classes of a file\'s host come from data: generated, summaries hidden, a diff that is drawn', () => {
    const manager = rendered([file('gen.js', { generated: true }), file('src/a.js')]);
    manager.summariesHiddenFiles.add('src/a.js');
    expect(manager._fileHostClasses('gen.js')).toEqual(['generated-file', 'has-diff-body']);
    expect(manager._fileHostClasses('src/a.js')).toEqual(['summaries-hidden-file', 'has-diff-body']);
    expect(manager._fileHostClasses('ctx.js')).toEqual([]);
  });

  it('a file has a code block under its header when its diff is drawn: not a binary file, not a file without a patch, not a diff held back for its size', () => {
    const manager = rendered([
      file('src/a.js'), file('image.png', { binary: true }), file('empty.txt', { patch: '' }), file('big.js'),
    ]);
    manager.pierreBridge.files.get('big.js').deferred = true;
    expect(manager._fileHostClasses('src/a.js')).toEqual(['has-diff-body']);
    expect(manager._fileHostClasses('image.png')).toEqual([]);
    expect(manager._fileHostClasses('empty.txt')).toEqual([]);
    expect(manager._fileHostClasses('big.js')).toEqual([]);
    // "Load diff": the same file, now with its lines.
    manager.pierreBridge.files.get('big.js').deferred = false;
    expect(manager._fileHostClasses('big.js')).toEqual(['has-diff-body']);
  });

  it('a deferred file is materialized through the bridge, with no element, once', async () => {
    const manager = rendered();
    manager.pierreBridge.files.get('src/a.js').deferred = true;
    manager._yieldForDiffWork = vi.fn(async () => {});
    manager._reanchorInlineFeedbackAfterDeferredRender = vi.fn(async () => {});

    const both = Promise.all([
      manager._materializeDeferredDiff('src/a.js', { reanchor: true }),
      manager._materializeDeferredDiff('src/a.js'),
    ]);
    await expect(both).resolves.toEqual([true, true]);
    expect(manager.pierreBridge.materializeDeferred).toHaveBeenCalledTimes(1);
    expect(manager._reanchorInlineFeedbackAfterDeferredRender).toHaveBeenCalledTimes(1);
    // A file that shows its diff needs nothing.
    await expect(manager._materializeDeferredDiff('src/b.js')).resolves.toBe(true);
    expect(manager.pierreBridge.materializeDeferred).toHaveBeenCalledTimes(1);
  });

  it('a materialization that a new render overtook does nothing', async () => {
    const manager = rendered();
    manager.pierreBridge.files.get('src/a.js').deferred = true;
    manager._yieldForDiffWork = vi.fn(async () => { manager._renderGen += 1; });
    await expect(manager._materializeDeferredDiff('src/a.js')).resolves.toBe(false);
    expect(manager.pierreBridge.materializeDeferred).not.toHaveBeenCalled();
  });

  it('the notice of a deferred file is the "Load diff" message; its button materializes the file', () => {
    const manager = rendered();
    manager._materializeDeferredDiff = vi.fn(async () => true);
    const notice = manager._buildDiffNotice('src/a.js', { kind: 'large-diff', chars: 10, lines: 2 });
    expect(notice.classList.contains('large-diff-placeholder')).toBe(true);
    notice.querySelector('.large-diff-load-btn').click();
    expect(manager._materializeDeferredDiff).toHaveBeenCalledWith('src/a.js', { reanchor: true });
    expect(manager._buildDiffNotice('src/a.js', { kind: 'other' })).toBeNull();
  });
});

describe('scrollToContextFile on the virtualized viewer', () => {
  function withContext() {
    const manager = makeManager({
      contextFiles: [
        { id: 1, file: 'ctx.js', line_start: 20, line_end: 30 },
        { id: 2, file: 'ctx.js', line_start: 150, line_end: 160 },
      ],
    });
    manager._contextContents.set('ctx.js', { text: Array.from({ length: 240 }, (_, i) => `l${i}`).join('\n'), seq: 1 });
    manager.renderDiff({ changed_files: [file('src/a.js')] });
    return manager;
  }

  it('goes to the file\'s header for its first range, and flashes the line', async () => {
    const manager = withContext();
    await manager.scrollToContextFile('ctx.js', 20, 1);
    expect(manager.pierreBridge.scrollToItem).toHaveBeenCalledWith('ctx.js', { align: 'start', behavior: 'smooth' });
    expect(manager.pierreBridge.scrollToLine.mock.calls).toEqual([['ctx.js', 20, 'RIGHT', { scroll: false }]]);
  });

  it('goes to the first line of a later range', async () => {
    const manager = withContext();
    await manager.scrollToContextFile('ctx.js', 150, 2);
    expect(manager.pierreBridge.scrollToItem).not.toHaveBeenCalled();
    expect(manager.pierreBridge.scrollToLine.mock.calls[0]).toEqual(['ctx.js', 150, 'RIGHT', { align: 'center', behavior: 'smooth', flash: false }]);
  });

  it('falls back to the header when the line cannot be scrolled to (a collapsed file), and does nothing for a file the pane does not have', async () => {
    const manager = withContext();
    manager.pierreBridge.scrollToLine.mockReturnValue(false);
    await manager.scrollToContextFile('ctx.js', 150, 2);
    expect(manager.pierreBridge.scrollToItem).toHaveBeenCalledTimes(1);

    manager.pierreBridge.scrollToItem.mockClear();
    await manager.scrollToContextFile('gone.js', 1, 9);
    expect(manager.pierreBridge.scrollToItem).not.toHaveBeenCalled();
  });
});
