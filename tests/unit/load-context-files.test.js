// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * PRManager.loadContextFiles on the virtualized viewer: "data in, one
 * synchronous sync out" (ledger H80).
 *
 * It has five callers and any two can be in flight together, so what is
 * tested here is which load wins, what a superseded load leaves untouched,
 * what a caller that awaits a superseded load finds when it settles, and
 * what the one sync sends to the bridge. The bridge is the production
 * PierreCodeViewBridge over the recording stand-in for the viewer
 * (tests/utils/codeview-bridge-harness.js): what it is asked and what it
 * decides from data is real; nothing is rendered.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { loadCodeViewBridge, numberedLines } = require('../utils/codeview-bridge-harness.js');
const { makePageManager } = require('../utils/page-manager.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

const patchOf = (name) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n`;
const row = (id, file, line_start = 1, line_end = 10) => ({ id, file, line_start, line_end, label: null });

let env;
let manager;
let bridge;
/** The context rows the "server" has, and the contents of each file (null: cannot be read). */
let server;
let rowRequests;

/** A promise and its resolver, to hold a request open. */
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function setUp({ changedFiles = ['src/main.js', 'src/utils.js'] } = {}) {
  env = loadCodeViewBridge(vendor);
  bridge = new env.PierreCodeViewBridge({
    root: env.window.document.getElementById('root'),
    theme: 'light',
    useWorkerPool: false,
    itemMetrics: { diffHeaderHeight: 45, lineHeight: 17 },
  });
  server = { rows: [], contents: {}, holdRows: null, holdContents: {} };
  rowRequests = 0;
  global.fetch = vi.fn(async (url) => {
    if (!/\/api\/reviews\/1\/context-files$/.test(url)) throw new Error(`unexpected fetch ${url}`);
    rowRequests++;
    const rows = server.rows.map((r) => ({ ...r }));
    if (server.holdRows) await server.holdRows.promise;
    return { ok: true, json: async () => ({ contextFiles: rows }) };
  });
  manager = makePageManager({
    _diffEngine: 'codeview',
    pierreBridge: bridge,
    generatedFiles: new Map(),
    changedFilesByPath: new Map(changedFiles.map((name) => [name, { file: name, patch: patchOf(name) }])),
    _renderGen: 1,
    fetchFileContent: vi.fn(async (path) => {
      if (server.holdContents[path]) await server.holdContents[path].promise;
      const lines = server.contents[path];
      return lines ? { lines } : null;
    }),
    loadUserComments: vi.fn(async () => {}),
    rebuildFileListWithContext: vi.fn(),
    saveViewedState: vi.fn(),
  });
  bridge.renderAll(manager._buildPaneEntries(), { keyPrefix: 1 });
}

const viewer = () => bridge.codeView;
const paneIds = () => [...bridge.files.keys()];
const listWrites = () => viewer().count('setItems');

beforeEach(() => setUp());

afterEach(() => {
  bridge?.destroy();
  env.restore();
  delete global.fetch;
  vi.restoreAllMocks();
});

describe('loadContextFiles on the virtualized viewer', () => {
  it('makes an item of a stored row once its contents are read, in its place, and reloads the comments', async () => {
    server.rows = [row(1, 'src/notes.js', 5, 15)];
    server.contents['src/notes.js'] = numberedLines(30);

    await manager.loadContextFiles();

    expect(paneIds()).toEqual(['src/main.js', 'src/notes.js', 'src/utils.js']);
    const record = bridge.files.get('src/notes.js');
    expect(record.kind).toBe('context');
    expect(record.storedRanges).toEqual([{ startLine: 5, endLine: 15 }]);
    expect(record.file.contents).toBe(numberedLines(30).join('\n'));
    expect(manager.contextFiles).toEqual(server.rows);
    expect(manager.fileKind('src/notes.js')).toBe('context');
    expect(manager.rebuildFileListWithContext).toHaveBeenCalledTimes(1);
    expect(manager.loadUserComments).toHaveBeenCalledTimes(1);
  });

  it('a load that changes nothing reads no contents, writes no list and does not reload the comments', async () => {
    server.rows = [row(1, 'src/notes.js')];
    server.contents['src/notes.js'] = numberedLines(30);
    await manager.loadContextFiles();
    const writes = listWrites();
    const updates = viewer().count('updateItem');

    await manager.loadContextFiles();

    expect(manager.fetchFileContent).toHaveBeenCalledTimes(1);
    expect(listWrites()).toBe(writes);
    expect(viewer().count('updateItem')).toBe(updates);
    expect(manager.loadUserComments).toHaveBeenCalledTimes(1);
    expect(manager.rebuildFileListWithContext).toHaveBeenCalledTimes(2);
  });

  it('refreshContents reads every context file again and publishes only the ones whose text changed', async () => {
    server.rows = [row(1, 'a/one.js'), row(2, 'b/two.js')];
    server.contents['a/one.js'] = numberedLines(30);
    server.contents['b/two.js'] = numberedLines(30);
    await manager.loadContextFiles();
    const seqBefore = { one: manager._contextContents.get('a/one.js').seq, two: manager._contextContents.get('b/two.js').seq };
    const writes = listWrites();
    viewer().calls.length = 0;

    server.contents['b/two.js'] = numberedLines(40, 'changed');
    await manager.loadContextFiles({ refreshContents: true });

    expect(manager.fetchFileContent.mock.calls.map(([path]) => path)).toEqual(['a/one.js', 'b/two.js', 'a/one.js', 'b/two.js']);
    expect(manager._contextContents.get('a/one.js').seq).toBe(seqBefore.one);
    expect(manager._contextContents.get('b/two.js').seq).toBeGreaterThan(seqBefore.two);
    // The same files in the same order: the changed one is published on its item.
    expect(listWrites()).toBe(0);
    expect(viewer().calls.filter((c) => c.name === 'updateItem').map((c) => c.args[0].id)).toEqual(['b/two.js']);
    expect(bridge.files.get('b/two.js').file.contents).toBe(numberedLines(40, 'changed').join('\n'));
    expect(writes).toBeGreaterThan(0);
    // Nothing was created: the comments are not reloaded again.
    expect(manager.loadUserComments).toHaveBeenCalledTimes(1);
  });

  it('a file that cannot be read has no item and no cached contents; the next load tries again', async () => {
    server.rows = [row(1, 'missing/gone.js'), row(2, 'src/notes.js')];
    server.contents['src/notes.js'] = numberedLines(30);

    await manager.loadContextFiles();
    expect(paneIds()).toEqual(['src/main.js', 'src/notes.js', 'src/utils.js']);
    expect(manager._contextContents.has('missing/gone.js')).toBe(false);
    // The row is the review's: the sidebar still lists it.
    expect(manager.contextFiles.map((r) => r.file)).toEqual(['missing/gone.js', 'src/notes.js']);

    server.contents['missing/gone.js'] = numberedLines(12);
    await manager.loadContextFiles();
    expect(manager.fetchFileContent.mock.calls.map(([path]) => path)).toEqual(['missing/gone.js', 'src/notes.js', 'missing/gone.js']);
    expect(paneIds()).toEqual(['missing/gone.js', 'src/main.js', 'src/notes.js', 'src/utils.js']);
  });

  it('a read that throws is a file that cannot be read, not a failed load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.rows = [row(1, 'boom.js'), row(2, 'src/notes.js')];
    server.contents['src/notes.js'] = numberedLines(30);
    manager.fetchFileContent.mockImplementation(async (path) => {
      if (path === 'boom.js') throw new Error('network');
      return { lines: server.contents[path] };
    });
    await manager.loadContextFiles();
    expect(paneIds()).toEqual(['src/main.js', 'src/notes.js', 'src/utils.js']);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('the diff wins: a row whose path is a changed file is not read and gets no item', async () => {
    server.rows = [row(1, 'src/utils.js'), row(2, 'src/notes.js')];
    server.contents['src/notes.js'] = numberedLines(30);
    server.contents['src/utils.js'] = numberedLines(30);

    await manager.loadContextFiles();

    expect(manager.fetchFileContent.mock.calls.map(([path]) => path)).toEqual(['src/notes.js']);
    expect(paneIds()).toEqual(['src/main.js', 'src/notes.js', 'src/utils.js']);
    expect(bridge.files.get('src/utils.js').kind).toBe('diff');
    // The row stays stored.
    expect(manager.contextFiles).toHaveLength(2);
  });

  it('of two loads in flight the later one wins; the earlier one stops at its next await', async () => {
    server.rows = [row(1, 'early.js')];
    server.contents['early.js'] = numberedLines(10);
    server.contents['late.js'] = numberedLines(10);
    server.holdContents['early.js'] = gate();

    const first = manager.loadContextFiles();
    // Let the first load get its rows and start reading contents.
    await vi.waitFor(() => expect(manager.fetchFileContent).toHaveBeenCalledWith('early.js'));
    server.rows = [row(2, 'late.js')];
    await manager.loadContextFiles();
    expect(paneIds()).toEqual(['late.js', 'src/main.js', 'src/utils.js']);

    server.holdContents['early.js'].release();
    await first;
    // The first load's rows and contents were dropped.
    expect(paneIds()).toEqual(['late.js', 'src/main.js', 'src/utils.js']);
    expect(manager.contextFiles.map((r) => r.file)).toEqual(['late.js']);
    expect(manager._contextContents.has('early.js')).toBe(false);
    expect(manager.loadUserComments).toHaveBeenCalledTimes(1);
  });

  // What a caller that awaits a load may rely on (ensureContextFile and
  // removeContextFile read the rows and the pane right after their await).
  describe('a load that is overtaken', () => {
    /** Start a load whose rows request is held; answers the load's promise and whether it has settled. */
    function heldLoad(options) {
      const hold = gate();
      server.holdRows = hold;
      const state = { settled: false, hold };
      state.promise = manager.loadContextFiles(options).then(() => { state.settled = true; });
      server.holdRows = null;
      return state;
    }
    // Microtask chains only (the stand-in requests resolve without I/O):
    // after this, every continuation that could run has run.
    const tick = () => new Promise(setImmediate);

    it('settles only when the load that overtook it has brought its rows to the pane', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      const first = heldLoad();
      const second = heldLoad();

      // The first load's request answers; the second is still in flight.
      first.hold.release();
      await tick();
      expect(first.settled).toBe(false);
      expect(paneIds()).toEqual(['src/main.js', 'src/utils.js']);

      second.hold.release();
      await first.promise;
      expect(paneIds()).toEqual(['ctx.js', 'src/main.js', 'src/utils.js']);
      expect(manager.contextFiles.map((r) => r.id)).toEqual([1]);
      // The comments of the new file were reloaded before the caller goes on.
      expect(manager.loadUserComments).toHaveBeenCalledTimes(1);
      expect(rowRequests).toBe(2);
    });

    it('of three loads in flight every caller finds the last one applied', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      const loads = [heldLoad(), heldLoad(), heldLoad()];
      loads[1].hold.release();
      loads[0].hold.release();
      await tick();
      expect(loads.map((l) => l.settled)).toEqual([false, false, false]);
      loads[2].hold.release();
      await Promise.all(loads.map((l) => l.promise));
      expect(paneIds()).toEqual(['ctx.js', 'src/main.js', 'src/utils.js']);
      expect(listWrites()).toBe(1 + 2); // the render's list, then one list replace
    });

    it('ensureContextFile answers with its row and the file in the pane when a push overtakes its load', async () => {
      server.contents['late.js'] = numberedLines(40);
      const rowsFetch = global.fetch;
      global.fetch = vi.fn(async (url, init) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body);
          server.rows.push(row(501, body.file, body.line_start, body.line_end));
          return { ok: true, status: 201, json: async () => ({}) };
        }
        return rowsFetch(url, init);
      });
      // The rows request of ensureContextFile's own load is held ...
      const hold = gate();
      server.holdRows = hold;
      let answer;
      const asking = manager.ensureContextFile('late.js', 20).then((value) => { answer = value; });
      await vi.waitFor(() => expect(rowRequests).toBe(1));
      // ... a push starts a second load, which is held too ...
      const pushHold = gate();
      server.holdRows = pushHold;
      const push = manager.loadContextFiles({ whenIdle: true });
      server.holdRows = null;
      // ... and the first request answers while the second is in flight.
      hold.release();
      await tick();
      expect(answer).toBeUndefined();

      pushHold.release();
      await Promise.all([asking, push]);
      expect(answer).toEqual({ type: 'context', contextFile: row(501, 'late.js', 10, 30) });
      expect(manager.fileKind('late.js')).toBe('context');
      expect(paneIds()).toContain('late.js');
    });

    it('hands the later load what it was asked for: fresh contents', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      await manager.loadContextFiles();
      const seq = manager._contextContents.get('ctx.js').seq;
      server.contents['ctx.js'] = [...numberedLines(10), 'a new last line'];

      const refresh = heldLoad({ refreshContents: true });
      const plain = heldLoad();
      refresh.hold.release();
      plain.hold.release();
      await Promise.all([refresh.promise, plain.promise]);
      expect(manager._contextContents.get('ctx.js').seq).not.toBe(seq);
      expect(manager._contextContents.get('ctx.js').text).toContain('a new last line');

      // Nothing is carried past the load that applied.
      manager.fetchFileContent.mockClear();
      await manager.loadContextFiles();
      expect(manager.fetchFileContent).not.toHaveBeenCalled();
    });

    it('hands the later load what it was asked for: the reader is waiting, so a push does not wait for a drag to end', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      bridge._pointerDownOnRoot = true;
      const own = heldLoad();
      const push = heldLoad({ whenIdle: true });
      own.hold.release();
      push.hold.release();
      await Promise.all([own.promise, push.promise]);
      expect(paneIds()).toEqual(['ctx.js', 'src/main.js', 'src/utils.js']);

      // A push on its own still waits.
      server.rows = [];
      await manager.loadContextFiles({ whenIdle: true });
      expect(paneIds()).toEqual(['ctx.js', 'src/main.js', 'src/utils.js']);
      bridge._handlePointerUp();
      expect(paneIds()).toEqual(['src/main.js', 'src/utils.js']);
    });

    it('runs again when the load that overtook it could not fetch the rows', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      const first = heldLoad();
      const rowsFetch = global.fetch;
      global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
      const failing = manager.loadContextFiles();
      global.fetch = rowsFetch;

      first.hold.release();
      await Promise.all([first.promise, failing]);
      expect(paneIds()).toEqual(['ctx.js', 'src/main.js', 'src/utils.js']);
      expect(rowRequests).toBe(2); // the held one, and the one that ran again
    });

    it('does not wait for anything when the diff was emptied meanwhile', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      const first = heldLoad({ refreshContents: true });
      manager._clearDiffItems();
      first.hold.release();
      await first.promise;
      expect(paneIds()).toEqual([]);
      expect(manager._contextLoadPending).toBe(null);
    });

    it('two loads in flight when the diff is emptied: neither puts the context file back, in whichever order they answer', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      for (const order of ['first-then-second', 'second-then-first']) {
        rowRequests = 0;
        const first = heldLoad();
        const second = heldLoad();
        manager._clearDiffItems();
        expect(manager._contextLoadTail).toBe(null);
        const [early, late] = order === 'first-then-second' ? [first, second] : [second, first];
        early.hold.release();
        await tick();
        late.hold.release();
        await Promise.all([first.promise, second.promise]);
        await tick();
        expect(paneIds(), order).toEqual([]);
        // The two requests that were in flight, and no load after them.
        expect(rowRequests, order).toBe(2);
        expect(manager._contextLoadPending, order).toBe(null);
      }
    });

    it('a load that is already waiting for the load that overtook it stops there when the diff is emptied', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      const first = heldLoad();
      const second = heldLoad();
      // The first answers, finds itself overtaken and waits for the second.
      first.hold.release();
      await tick();
      expect(first.settled).toBe(false);
      manager._clearDiffItems();
      second.hold.release();
      await Promise.all([first.promise, second.promise]);
      await tick();
      expect(paneIds()).toEqual([]);
      expect(rowRequests).toBe(2);
    });

    it('settles after the new diff\'s own load when the diff was replaced meanwhile, and applies nothing itself', async () => {
      server.rows = [row(1, 'ctx.js')];
      server.contents['ctx.js'] = numberedLines(10);
      const stale = heldLoad();
      // renderDiff: a new render generation, and its own load.
      manager._renderGen += 1;
      const fresh = heldLoad({ refreshContents: true });
      stale.hold.release();
      await tick();
      expect(stale.settled).toBe(false);
      fresh.hold.release();
      await Promise.all([stale.promise, fresh.promise]);
      expect(paneIds()).toEqual(['ctx.js', 'src/main.js', 'src/utils.js']);
      expect(rowRequests).toBe(2);
    });
  });

  it('a file dismissed while its contents are being read does not appear', async () => {
    server.rows = [row(1, 'ctx.js')];
    server.contents['ctx.js'] = numberedLines(10);
    server.holdContents['ctx.js'] = gate();
    const adding = manager.loadContextFiles();
    await vi.waitFor(() => expect(manager.fetchFileContent).toHaveBeenCalledWith('ctx.js'));

    // The dismiss: the row is gone, and its load runs to the end.
    server.rows = [];
    await manager.loadContextFiles();
    server.holdContents['ctx.js'].release();
    await adding;

    expect(paneIds()).toEqual(['src/main.js', 'src/utils.js']);
    expect(manager.contextFiles).toEqual([]);
    expect(manager.loadUserComments).not.toHaveBeenCalled();
  });

  it('a load started for a diff that has since been replaced stops', async () => {
    server.rows = [row(1, 'ctx.js')];
    server.contents['ctx.js'] = numberedLines(10);
    server.holdRows = gate();
    const stale = manager.loadContextFiles();
    // renderDiff: a new render generation (and it starts a load of its own).
    manager._renderGen += 1;
    server.holdRows.release();
    await stale;

    expect(manager.fetchFileContent).not.toHaveBeenCalled();
    expect(manager.contextFiles).toEqual([]);
    expect(paneIds()).toEqual(['src/main.js', 'src/utils.js']);
    expect(manager.rebuildFileListWithContext).not.toHaveBeenCalled();
  });

  it('the dismiss button\'s deletes, one after the other: the item stays while a row is left, and no list is written for that', async () => {
    server.rows = [row(1, 'ctx.js', 5, 10), row(2, 'ctx.js', 50, 60)];
    server.contents['ctx.js'] = numberedLines(100);
    await manager.loadContextFiles();
    expect(bridge.files.get('ctx.js').storedRanges).toEqual([{ startLine: 5, endLine: 10 }, { startLine: 50, endLine: 60 }]);
    manager.viewedFiles.add('context:ctx.js');
    manager._fileHeaders.set('ctx.js', env.window.document.createElement('div'));
    const writes = listWrites();

    // removeContextFile's DELETE is the server's business; then it loads.
    server.rows = [row(2, 'ctx.js', 50, 60)];
    await manager.loadContextFiles();
    expect(listWrites()).toBe(writes);
    expect(paneIds()).toContain('ctx.js');
    expect(bridge.files.get('ctx.js').storedRanges).toEqual([{ startLine: 50, endLine: 60 }]);
    expect(manager.viewedFiles.has('context:ctx.js')).toBe(true);

    server.rows = [];
    await manager.loadContextFiles();
    expect(paneIds()).toEqual(['src/main.js', 'src/utils.js']);
    expect(listWrites()).toBe(writes + 2); // clear, then set: one list replace
    // What the page held for the file went with it.
    expect(manager._fileHeaders.has('ctx.js')).toBe(false);
    expect(manager._fileCollapsed.has('context:ctx.js')).toBe(false);
    expect(manager.viewedFiles.has('context:ctx.js')).toBe(false);
    expect(manager._contextContents.has('ctx.js')).toBe(false);
    expect(manager.saveViewedState).toHaveBeenCalledTimes(1);
  });

  it('a change the reader did not ask for waits while a selection is being dragged, then reloads the comments', async () => {
    server.rows = [row(1, 'ctx.js')];
    server.contents['ctx.js'] = numberedLines(10);
    bridge._pointerDownOnRoot = true;

    await manager.loadContextFiles({ whenIdle: true });
    expect(paneIds()).toEqual(['src/main.js', 'src/utils.js']);
    expect(manager.loadUserComments).not.toHaveBeenCalled();
    // The rows and the sidebar are up to date all the same.
    expect(manager.contextFiles).toHaveLength(1);
    expect(manager.rebuildFileListWithContext).toHaveBeenCalledTimes(1);

    bridge._handlePointerUp();
    expect(paneIds()).toEqual(['ctx.js', 'src/main.js', 'src/utils.js']);
    await Promise.resolve();
    expect(manager.loadUserComments).toHaveBeenCalledTimes(1);
    expect(manager.fileKind('ctx.js')).toBe('context');
  });

  it('does nothing without a review, and leaves everything alone when the rows cannot be fetched', async () => {
    manager.currentPR = null;
    await manager.loadContextFiles();
    expect(rowRequests).toBe(0);

    manager.currentPR = { id: 1 };
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    manager.contextFiles = [row(9, 'kept.js')];
    await manager.loadContextFiles();
    expect(manager.contextFiles).toEqual([row(9, 'kept.js')]);
    expect(manager.rebuildFileListWithContext).not.toHaveBeenCalled();
  });
});

describe('_syncContextItems', () => {
  it('is idempotent: the same data gives no second list write', async () => {
    server.rows = [row(1, 'ctx.js')];
    server.contents['ctx.js'] = numberedLines(10);
    await manager.loadContextFiles();
    const writes = listWrites();
    expect(manager._syncContextItems()).toEqual({ created: [], removed: [], deferred: false });
    expect(listWrites()).toBe(writes);
  });

  it('answers with nothing when there is no viewer', () => {
    const plain = makePageManager({ pierreBridge: null });
    expect(plain._syncContextItems()).toEqual({ created: [], removed: [], deferred: false });
  });
});
