// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: a list write (renderAll, reconcile) asked for from
 * inside one of the viewer's render callbacks. The records change at once;
 * the viewer's list is written when the pass has ended, from the records as
 * they are then, at most once, and not at all when a direct list write or
 * destroy() came first. Every case here failed silently (an annotation never
 * drawn, a newer list overwritten, a destroyed bridge brought back) when the
 * waiting write carried the list that was built when it was asked for.
 */

import { test, expect, openBridge, clickExpandControl, readingInTheMiddle } from './bridge-test.js';

const CONTEXT = 'ctx/added-at-run-time.js';
const SECOND = 'ctx/second.js';

for (const via of ['hook', 'renderer']) {
  test(`a reconcile asked for from inside a viewer callback (${via}) changes the records at once and the viewer's list once, after the pass`, async ({ harness }) => {
    const page = await openBridge(harness);
    await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ CONTEXT, via }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      const all = [...T.names, CONTEXT];
      const writes = BH.spyOnSetItems();
      const call = BH.fromViewerCallback(via, T.reading, T.line.n, () => b.reconcile(T.withContext(3)), T.line.side);
      // Same task, the pass has returned, the microtask has not run.
      const sameTask = {
        ran: call.ran,
        depth: call.depth,
        outcome: call.value,
        recordIds: [...b.files.keys()].length,
        hasRecord: b.files.get(CONTEXT)?.kind ?? null,
        viewerHasItem: !!b.codeView.getItem(CONTEXT),
        writes: writes.slice(),
        hosts: H.root.querySelectorAll('diffs-container').length === H.mounted().length,
      };
      await Promise.resolve();
      const afterMicrotask = { writes: writes.slice(), moved: T.moved(), list: BH.listState(all) };
      await H.settle(300);
      const settled = { writes: writes.slice(), moved: T.moved(), list: BH.listState(all), trigger: BH.cardState(T.reading, 'trigger').connected, sound: BH.sound() };
      writes.restore();
      return { sameTask, afterMicrotask, settled, order: [...T.names.slice(0, 3), CONTEXT, ...T.names.slice(3)] };
    }, { CONTEXT, via });

    expect(result.sameTask).toEqual({
      ran: 1,
      depth: 1,
      outcome: { applied: true, created: [CONTEXT], removed: [], updated: [], listWritten: true },
      recordIds: 31,
      hasRecord: 'context',
      viewerHasItem: false,
      writes: [],
      hosts: true,
    });
    // One clear and one set, of the 31 records, with the reader where they were.
    expect(result.afterMicrotask.writes).toEqual([0, 31]);
    expect(result.afterMicrotask.moved).toBe(0);
    expect(result.afterMicrotask.list).toEqual({ viewerIds: expect.arrayContaining([CONTEXT]), recordIds: result.order, outOfStep: [] });
    expect(result.afterMicrotask.list.viewerIds).toHaveLength(31);
    expect(result.settled.writes).toEqual([0, 31]);
    expect(result.settled.moved).toBe(0);
    expect(result.settled.list.outOfStep).toEqual([]);
    expect(result.settled.trigger).toBe(true);
    expect(result.settled.sound).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

test('what changes between the request and the write is part of the write: annotations on the new record and on a kept one, a collapse, a revealed range', async ({ harness }) => {
  const page = await openBridge(harness);
  await readingInTheMiddle(page);
  const result = await page.evaluate(async ({ CONTEXT }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    const all = [...T.names, CONTEXT];
    const other = T.names[20];
    const side = T.line.side === 'deletions' ? 'LEFT' : 'RIGHT';
    BH.fromViewerCallback('hook', T.reading, T.line.n, () => b.reconcile(T.withContext(3)));
    // Same task: the page reacts to the new record and goes on working.
    b.addAnnotation(CONTEXT, { lineNumber: 105, side: 'RIGHT', type: 'card', id: 'late-context', data: { text: 'late on the context file' } });
    b.addAnnotation(T.reading, { lineNumber: T.line.n, side, type: 'card', id: 'late-kept', data: { text: 'late on the kept file' } });
    b.setCollapsed(other, true);
    const revealed = b.addContextRanges(CONTEXT, [{ startLine: 200, endLine: 205 }]);
    const sameTask = {
      revealed,
      contextCard: { inRecord: b.hasAnnotation(CONTEXT, 'late-context'), built: BH.cardState(CONTEXT, 'late-context').built, inViewer: !!b.codeView.getItem(CONTEXT) },
      // A kept record still has its item: the publish reached it.
      keptCard: BH.cardState(T.reading, 'late-kept').connected,
      visible: [105, 202, 150].map((n) => b.isLineVisible(CONTEXT, n, 'RIGHT')),
    };
    await H.settle(300);
    const item = (id) => b.codeView.getItem(id);
    const settled = {
      list: BH.listState(all).outOfStep,
      contextCardInItem: item(CONTEXT).annotations.some((a) => a.metadata.id === 'late-context'),
      keptCardInItem: item(T.reading).annotations.some((a) => a.metadata.id === 'late-kept'),
      keptCard: BH.cardState(T.reading, 'late-kept'),
      collapsedInItem: item(other).collapsed,
      moved: T.moved(),
    };
    // Go to the context file: its card is drawn under its line, and the revealed range is there.
    b.scrollToLine(CONTEXT, 105, 'RIGHT', { behavior: 'instant', flash: false });
    await H.settle(400);
    const card = await b.whenAnnotationRendered(CONTEXT, 'late-context', { timeoutMs: 5000 });
    const there = {
      card: !!card && card.isConnected,
      cardState: BH.cardState(CONTEXT, 'late-context'),
      runs: BH.lineRuns(CONTEXT),
      sound: BH.sound(),
    };
    return { sameTask, settled, there, reading: T.reading };
  }, { CONTEXT });

  expect(result.sameTask).toEqual({
    revealed: true,
    contextCard: { inRecord: true, built: false, inViewer: false },
    keptCard: true,
    visible: [true, true, false],
  });
  expect(result.settled.list).toEqual([]);
  expect(result.settled.contextCardInItem).toBe(true);
  expect(result.settled.keptCardInItem).toBe(true);
  expect(result.settled.keptCard).toMatchObject({ connected: true, host: result.reading });
  expect(result.settled.collapsedInItem).toBe(true);
  expect(result.settled.moved).toBe(0);
  expect(result.there.card).toBe(true);
  expect(result.there.cardState).toMatchObject({ connected: true, host: CONTEXT, slot: 'annotation-additions-105' });
  expect(result.there.cardState.height).toBeGreaterThan(0);
  expect(result.there.runs.slice(0, 2)).toEqual([[100, 120], [200, 205]]);
  expect(result.there.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

for (const direct of ['a new diff (renderAll)', 'another reconcile']) {
  test(`a list write made directly before the waiting one runs is that write: ${direct}`, async ({ harness }) => {
    const page = await openBridge(harness);
    await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ CONTEXT, newDiff }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      const all = [...T.names, CONTEXT];
      const writes = BH.spyOnSetItems();
      BH.fromViewerCallback('hook', T.reading, T.line.n, () => b.reconcile(T.withContext(3)));
      const waiting = { viewerHasItem: !!b.codeView.getItem(CONTEXT), writes: writes.slice() };
      // Same task, outside the pass.
      const expected = newDiff ? T.names.slice(0, 10) : T.names;
      const outcome = newDiff ? BH.renderAll(T.entries.slice(0, 10), { keyPrefix: 'rev2' }) : b.reconcile(T.entries).removed;
      const sameTask = { writes: writes.slice(), list: BH.listState(all) };
      await H.settle(400);
      const settled = { writes: writes.slice(), list: BH.listState(all), sound: BH.sound() };
      writes.restore();
      return { waiting, outcome, sameTask, settled, expected };
    }, { CONTEXT, newDiff: direct.startsWith('a new diff') });

    expect(result.waiting).toEqual({ viewerHasItem: false, writes: [] });
    expect(result.outcome).toEqual(direct.startsWith('a new diff') ? true : [CONTEXT]);
    const list = { viewerIds: result.expected, recordIds: result.expected, outOfStep: [] };
    expect(result.sameTask).toEqual({ writes: [0, result.expected.length], list });
    // The microtask found nothing waiting: no second write, and the viewer's list is the bridge's.
    expect(result.settled.writes).toEqual([0, result.expected.length]);
    expect(result.settled.list).toEqual(list);
    expect(result.settled.sound).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

test('destroy() before the waiting write runs cancels it, and a destroyed bridge renders nothing', async ({ harness }) => {
  const page = await openBridge(harness);
  await readingInTheMiddle(page);
  const result = await page.evaluate(async () => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    BH.fromViewerCallback('hook', T.reading, T.line.n, () => b.reconcile(T.withContext(3)));
    b.destroy();
    const state = () => ({ viewer: b.codeView === null ? null : 'a viewer', records: b.files.size, hosts: H.root.querySelectorAll('diffs-container').length });
    const atDestroy = state();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await H.raf(5);
    const later = state();
    const again = { renderAll: b.renderAll(T.entries), reconcile: b.reconcile(T.entries).reason, ...state() };
    return { atDestroy, later, again };
  });
  const gone = { viewer: null, records: 0, hosts: 0 };
  expect(result.atDestroy).toEqual(gone);
  expect(result.later).toEqual(gone);
  expect(result.again).toEqual({ renderAll: false, reconcile: 'not-rendered', ...gone });
});

test('two list writes asked for in one pass are one write, of the records as they are at the end', async ({ harness }) => {
  const page = await openBridge(harness);
  await readingInTheMiddle(page);
  const result = await page.evaluate(async ({ CONTEXT, SECOND }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    const all = [...T.names, CONTEXT, SECOND];
    const writes = BH.spyOnSetItems();
    const both = () => { const next = T.withContext(3); next.splice(25, 0, BH.contextEntry(SECOND, { contents: BH.numberedLines(120), ranges: [{ startLine: 10, endLine: 20 }] })); return next; };
    const call = BH.fromViewerCallback('hook', T.reading, T.line.n, () => [b.reconcile(T.withContext(3)).created, b.reconcile(both()).created]);
    await H.settle(300);
    const out = { created: call.value, writes: writes.slice(), list: BH.listState(all), moved: T.moved(), sound: BH.sound() };
    writes.restore();
    return out;
  }, { CONTEXT, SECOND });
  expect(result.created).toEqual([[CONTEXT], [SECOND]]);
  expect(result.writes).toEqual([0, 32]);
  expect(result.list.viewerIds).toHaveLength(32);
  expect(result.list.recordIds).toHaveLength(32);
  expect(result.list.outOfStep).toEqual([]);
  expect(result.moved).toBe(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('a list write asked for by a hook while a list write is drawing waits for it to end, then writes once', async ({ harness }) => {
  const page = await openBridge(harness);
  const { readingIndex } = await readingInTheMiddle(page);
  const result = await page.evaluate(async ({ CONTEXT, SECOND, readingIndex }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    const all = [...T.names, CONTEXT, SECOND];
    const writes = BH.spyOnSetItems();
    // The context file goes in directly above the file being read, so the
    // write that adds it mounts it; its mount is the hook's cue.
    const first = T.withContext(readingIndex);
    const second = first.slice();
    second.splice(5, 0, BH.contextEntry(SECOND, { contents: BH.numberedLines(120), ranges: [{ startLine: 10, endLine: 20 }] }));
    const nested = { ran: 0, depth: null, outcome: null, writesAtCall: null };
    BH.onLifecycle = (id, phase) => {
      if (id !== CONTEXT || phase !== 'mount' || nested.ran++) return;
      nested.depth = b._callbackDepth;
      nested.writesAtCall = writes.slice();
      nested.outcome = b.reconcile(second).created;
    };
    const outer = b.reconcile(first).created;
    BH.onLifecycle = null;
    const sameTask = { writes: writes.slice(), hasSecond: b.files.has(SECOND), viewerHasSecond: !!b.codeView.getItem(SECOND) };
    await H.settle(300);
    const out = { outer, nested, sameTask, writes: writes.slice(), list: BH.listState(all), moved: T.moved(), sound: BH.sound() };
    writes.restore();
    return out;
  }, { CONTEXT, SECOND, readingIndex });
  expect(result.outer).toEqual([CONTEXT]);
  expect(result.nested).toEqual({ ran: 1, depth: 1, outcome: [SECOND], writesAtCall: [0, 31] });
  expect(result.sameTask).toEqual({ writes: [0, 31], hasSecond: true, viewerHasSecond: false });
  expect(result.writes).toEqual([0, 31, 0, 32]);
  expect(result.list.viewerIds).toHaveLength(32);
  expect(result.list.outOfStep).toEqual([]);
  expect(result.moved).toBe(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('a new diff asked for from a hook: the records are new at once, nothing of the old items reaches them, and what is added meanwhile is drawn', async ({ harness }) => {
  const page = await openBridge(harness);
  const { names, reading } = await readingInTheMiddle(page, { upgrade: true });
  // The reader expands the gap after the last hunk of the file below the one
  // being read. That file is where everything in this test happens: it is on
  // screen, with the separator a little below the top of the pane.
  const file = names[names.indexOf(reading) + 1];
  const gapIndex = await page.evaluate((id) => window.BH.bridge.files.get(id).metadata.hunks.length, file);
  const box = await clickExpandControl(page, file, gapIndex, 'up');
  expect(box && box.visible, JSON.stringify(box)).toBe(true);

  const result = await page.evaluate(async ({ file }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    const oldRecord = b.files.get(file);
    const hunks = oldRecord.metadata.hunks;
    const last = hunks[hunks.length - 1];
    const line = last.additionStart;
    const firstExpanded = last.additionStart + last.additionCount;
    const rowTop = () => { const row = H.findRow(file, line, 'additions'); return row ? H.viewportTopOf(row) : null; };
    b.addAnnotation(file, { lineNumber: line + 1, side: 'RIGHT', type: 'card', id: 'old-card', data: { text: 'on the old diff' } });
    const oldCardElement = b.getAnnotationElement(file, 'old-card');
    const before = {
      expandedVisible: b.isLineVisible(file, firstExpanded, 'RIGHT'),
      expandedRow: !!H.findRow(file, firstExpanded, 'additions'),
      mapSize: oldRecord._instance.hunksRenderer.expandedHunks.size,
      oldCard: !!oldCardElement && oldCardElement.isConnected,
      top: rowTop(),
    };
    const writes = BH.spyOnSetItems();
    // What is published while the old list is still the viewer's.
    const cv = b.codeView;
    const originalUpdateItem = cv.updateItem;
    const published = [];
    cv.updateItem = function (item) { published.push(item.annotations.map((x) => x.metadata.id).filter((id) => id !== 'file-comments').join('+')); return originalUpdateItem.call(this, item); };
    // The trigger is on the same file, so the viewer goes on drawing THAT
    // item (header, cards, onPostRender) after its record was replaced.
    const call = BH.fromViewerCallback('hook', file, line, () => {
      const ok = BH.renderAll(T.entries, { keyPrefix: 'rev2' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'card', id: 'new-card', data: { text: 'on the new diff' } });
      return ok;
    });
    const record = b.files.get(file);
    const sameTask = {
      ran: call.ran,
      depth: call.depth,
      ok: call.value,
      newRecord: record !== oldRecord,
      writes: writes.slice(),
      // The old item of the same path is still mounted; it is not the new record's.
      oldHostMounted: !!H.host(file),
      element: b.findFileElement(file),
      displayed: b.isDiffDisplayed(file),
      instance: record._instance,
      expandedVisible: b.isLineVisible(file, firstExpanded, 'RIGHT'),
      revealed: record.contextRanges.length,
      upgraded: record.upgraded,
      cards: ['old-card', 'trigger', 'new-card'].map((id) => b.hasAnnotation(file, id)),
      published: published.slice(),
    };
    await H.settle(400);
    cv.updateItem = originalUpdateItem;
    const now = b.files.get(file);
    const settled = {
      writes: writes.slice(),
      published: published.slice(),
      list: BH.listState(T.names),
      sameRecord: now === record,
      newCard: BH.cardState(file, 'new-card'),
      oldCardAttached: !!oldCardElement && oldCardElement.isConnected,
      triggerAttached: !!document.querySelector('[data-card-id="trigger"]'),
      element: !!H.host(file) && b.findFileElement(file) === H.host(file),
      expandedVisible: b.isLineVisible(file, firstExpanded, 'RIGHT'),
      expandedRow: !!H.findRow(file, firstExpanded, 'additions'),
      revealed: now.contextRanges.length,
      patchKey: now.metadata.cacheKey === now.patchMetadata.cacheKey,
      moved: rowTop() - before.top,
      sound: BH.sound(),
    };
    writes.restore();
    return { before, sameTask, settled, names: T.names };
  }, { file });

  expect(result.before).toMatchObject({ expandedVisible: true, expandedRow: true, mapSize: 1, oldCard: true });
  expect(result.sameTask).toEqual({
    ran: 1,
    depth: 1,
    ok: true,
    newRecord: true,
    writes: [],
    oldHostMounted: true,
    element: null,
    displayed: false,
    instance: null,
    // A re-render starts from the patch: the old item's expansion is not the new record's.
    expandedVisible: false,
    revealed: 0,
    upgraded: false,
    cards: [false, false, true],
    // The trigger went to the old item; the new record's card went to no item.
    published: ['trigger+old-card'],
  });
  expect(result.settled.writes).toEqual([0, 30]);
  // The list write carried the card: nothing more was published.
  expect(result.settled.published).toEqual(['trigger+old-card']);
  expect(result.settled.list).toEqual({ viewerIds: result.names, recordIds: result.names, outOfStep: [] });
  expect(result.settled.sameRecord).toBe(true);
  expect(result.settled.newCard).toMatchObject({ connected: true, host: file });
  expect(result.settled.newCard.height).toBeGreaterThan(0);
  expect(result.settled.oldCardAttached).toBe(false);
  expect(result.settled.triggerAttached).toBe(false);
  expect(result.settled.element).toBe(true);
  expect(result.settled.expandedVisible).toBe(false);
  expect(result.settled.expandedRow).toBe(false);
  expect(result.settled.revealed).toBe(0);
  expect(result.settled.patchKey).toBe(true);
  expect(result.settled.moved).toBe(0);
  expect(result.settled.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('the old list drawn again before the write runs (a publish, a layout change) leaves a clean layout and reaches no record it does not belong to', async ({ harness }) => {
  const page = await openBridge(harness);
  const { readingIndex } = await readingInTheMiddle(page);
  const result = await page.evaluate(async ({ CONTEXT, readingIndex }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    const all = [...T.names, CONTEXT];
    const side = T.line.side === 'deletions' ? 'LEFT' : 'RIGHT';
    const headers = () => H.mounted().map((id) => BH.hostInfo(id)).filter((info) => !info || info.header !== info.fileName).length;

    // A context file directly above the file being read: mounted, with a
    // card and a class from the page's hostState hook.
    BH.hostClasses.set(CONTEXT, ['generated-file']);
    b.reconcile(T.withContext(readingIndex));
    b.addAnnotation(CONTEXT, { lineNumber: 118, side: 'RIGHT', type: 'card', id: 'on-context', data: { text: 'goes with its file' } });
    await H.settle(300);
    const contextCard = b.getAnnotationElement(CONTEXT, 'on-context');
    const contextHost = b.findFileElement(CONTEXT);
    const before = { mounted: !!contextHost, card: !!contextCard && contextCard.isConnected, classes: BH.hostInfo(CONTEXT)?.classes ?? null };

    // 1. The file is taken out from inside a callback, and the page forgets
    //    it (no header, no host classes for that path any more). Before the
    //    write runs the page publishes on a kept file and changes the layout
    //    and back, which draws the old list twice, the removed file's item
    //    included.
    const writes = BH.spyOnSetItems();
    const removal = BH.fromViewerCallback('hook', T.reading, T.line.n, () => { BH.forgotten.add(CONTEXT); return b.reconcile(T.entries).removed; }, T.line.side);
    b.addAnnotation(T.reading, { lineNumber: T.line.n, side, type: 'card', id: 'kept-card', data: { text: 'drawn on the old list, then on the new' } });
    b.setDiffStyle('split');
    b.setDiffStyle('unified');
    const removedSameTask = {
      removed: removal.value,
      stillInViewer: !!b.codeView.getItem(CONTEXT),
      keptCard: BH.cardState(T.reading, 'kept-card').connected,
      lookup: b.getAnnotationElement(CONTEXT, 'on-context', { create: true }),
      writes: writes.slice(),
      // The item of the file that is gone is drawn as it was: its header, its classes, its card.
      staleHost: contextHost.isConnected ? { header: contextHost.querySelector('.pr-file-header-slot .ph')?.dataset.phId ?? null, classes: [...contextHost.classList].sort(), card: contextCard.isConnected } : null,
    };
    await H.settle(300);
    const removedSettled = {
      writes: writes.slice(),
      list: BH.listState(all),
      keptCard: BH.cardState(T.reading, 'kept-card').connected,
      contextCardAttached: contextCard.isConnected,
      headersMissing: headers(),
      moved: T.moved(),
      sound: BH.sound(),
    };

    // 2. A new diff of the same files from inside a callback; before the
    //    write runs the page changes the layout, which draws every old item
    //    again while no record of the new diff is in the viewer's list.
    writes.length = 0;
    const lifecycleBefore = BH.lifecycle.length;
    const rerender = BH.fromViewerCallback('hook', T.reading, T.line.n + 1, () => BH.renderAll(T.entries, { keyPrefix: 'rev2' }), T.line.side);
    const records = [...b.files.values()];
    b.setDiffStyle('split');
    const newDiffSameTask = {
      ok: rerender.value,
      writes: writes.slice(),
      // No hook call and no host reference for a record whose item the viewer does not have.
      reached: records.filter((r) => r._element || r._instance || r._headerSlot || r._gutter).length,
      notified: BH.lifecycle.slice(lifecycleBefore).filter((e) => e.phase !== 'unmount' && !(e.id === T.reading && e.phase === 'update')).length,
    };
    await H.settle(400);
    const newDiffSettled = {
      writes: writes.slice(),
      list: BH.listState(all),
      sameRecords: records.every((r) => b.files.get(r.id) === r),
      headersMissing: headers(),
      split: H.host(T.reading).shadowRoot.querySelector('pre')?.getAttribute('data-diff-type') ?? null,
      sound: BH.sound(),
    };
    writes.restore();
    return { before, removedSameTask, removedSettled, newDiffSameTask, newDiffSettled, names: T.names };
  }, { CONTEXT, readingIndex });

  const contextClasses = ['context-file', 'd2h-file-wrapper', 'generated-file'];
  expect(result.before).toEqual({ mounted: true, card: true, classes: contextClasses });
  expect(result.removedSameTask).toEqual({
    removed: [CONTEXT],
    stillInViewer: true,
    keptCard: true,
    lookup: null,
    writes: [],
    staleHost: { header: CONTEXT, classes: contextClasses, card: true },
  });
  expect(result.removedSettled).toEqual({
    writes: [0, 30],
    list: { viewerIds: result.names, recordIds: result.names, outOfStep: [] },
    keptCard: true,
    contextCardAttached: false,
    headersMissing: 0,
    moved: 0,
    sound: { orphans: 0, clean: true },
  });
  expect(result.newDiffSameTask).toEqual({ ok: true, writes: [], reached: 0, notified: 0 });
  expect(result.newDiffSettled).toEqual({
    writes: [0, 30],
    list: { viewerIds: result.names, recordIds: result.names, outOfStep: [] },
    sameRecords: true,
    headersMissing: 0,
    split: 'split',
    sound: { orphans: 0, clean: true },
  });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('a scroll target and a selection sent between the request and the write are applied after it, as after a direct reconcile', async ({ harness }) => {
  const run = async (fromHook) => {
    const page = await openBridge(harness);
    await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ CONTEXT, fromHook }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      const cv = b.codeView;
      const scrolls = [];
      const originalScrollTo = cv.scrollTo;
      cv.scrollTo = function (target) { scrolls.push(`${target.type}:${target.id}:${target.lineNumber ?? ''}`); return originalScrollTo.call(this, target); };
      b.selectLines(T.reading, T.line.n, T.line.n + 1, 'RIGHT');
      const commands = () => {
        const out = {
          line: b.scrollToLine(CONTEXT, 305, 'RIGHT', { behavior: 'instant', flash: false }),
          hidden: b.scrollToLine(CONTEXT, 150, 'RIGHT', { behavior: 'instant', flash: false }),
        };
        b.clearLineSelection(T.reading);
        b.selectLines(CONTEXT, 304, 306, 'RIGHT');
        return out;
      };
      let answered;
      let waiting = null;
      if (fromHook) {
        const call = BH.fromViewerCallback('hook', T.reading, T.line.n, () => { b.reconcile(T.withContext(3)); return commands(); });
        answered = call.value;
        // Same task: nothing was sent to the old list, and the new record has no selection yet.
        waiting = { scrolls: scrolls.slice(), oldSelection: b.getLineSelection(T.reading), newSelection: b.getLineSelection(CONTEXT) };
      } else {
        b.addAnnotation(T.reading, { lineNumber: T.line.n, side: 'RIGHT', type: 'card', data: { text: 'trigger' }, id: 'trigger' });
        b.reconcile(T.withContext(3));
        answered = commands();
      }
      await H.settle(500);
      cv.scrollTo = originalScrollTo;
      const row = H.findRow(CONTEXT, 305, 'additions');
      return {
        answered,
        waiting,
        lineScrolls: scrolls.filter((s) => s.startsWith('line:ctx/')),
        rowTop: row ? Math.round(H.viewportTopOf(row)) : null,
        paneHeight: H.root.clientHeight,
        selection: { context: b.getLineSelection(CONTEXT), reading: b.getLineSelection(T.reading) },
        sound: BH.sound(),
      };
    }, { CONTEXT, fromHook });
    expect(harness.validatorErrors(page)).toEqual([]);
    await page.close();
    return result;
  };
  const direct = await run(false);
  const deferred = await run(true);

  expect(direct.answered).toEqual({ line: true, hidden: false });
  expect(direct.rowTop).toBeGreaterThan(40);
  expect(direct.rowTop).toBeLessThan(direct.paneHeight);
  expect(direct.selection).toEqual({ context: { start: 304, end: 306, side: 'RIGHT' }, reading: null });

  expect(deferred.answered).toEqual(direct.answered);
  expect(deferred.waiting.scrolls).toEqual([]);
  expect(deferred.waiting.newSelection).toBeNull();
  expect(deferred.waiting.oldSelection).not.toBeNull();
  // One line target reached the viewer, for the line that is shown, after the write.
  expect(deferred.lineScrolls).toEqual([`line:${CONTEXT}:305`]);
  expect(deferred.rowTop).toBe(direct.rowTop);
  expect(deferred.selection).toEqual(direct.selection);
  expect(deferred.sound).toEqual({ orphans: 0, clean: true });
  expect(direct.sound).toEqual({ orphans: 0, clean: true });
});

// The viewer draws the items of one pass one after another (render, then
// onPostRender, then the next item). A hook that fires on the first item of
// a pass can therefore take out, or replace, a file whose item the SAME pass
// draws next, for the first time: a record that is no longer the pane's and
// has no header slot, no host and no card yet.
const FIRST_DRAWN = [
  ['a context file taken out by reconcile', 'reconcile'],
  ['a new diff without the file', 'renderAll-without'],
  ['a new diff of the same files', 'renderAll-same'],
];
for (const [how, mode] of FIRST_DRAWN) {
  test(`an item drawn for the first time between the request and the write (${how}): nothing of the page runs for it, and it is the height the viewer was told`, async ({ harness }) => {
    const page = await openBridge(harness);
    await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ CONTEXT, mode }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      const all = [...T.names, CONTEXT];
      // The victim: a file far below the reader, never drawn, with a card.
      let victim = T.names[24];
      if (mode === 'reconcile') {
        b.reconcile(T.withContext(25));
        victim = CONTEXT;
      }
      const stale = b.files.get(victim);
      const cardLine = stale.kind === 'context' ? 105 : stale.metadata.hunks[0].additionStart;
      b.addAnnotation(victim, { lineNumber: cardLine, side: 'RIGHT', type: 'card', id: 'victim-card', data: { text: 'never drawn' } });
      await H.settle(300);
      const before = { kind: stale.kind, mounted: !!stale._element, slot: !!stale._headerSlot, cardBuilt: BH.cardState(victim, 'victim-card').built };

      const asked = [];
      const { renderHeader, hostState } = b.hooks;
      b.hooks.renderHeader = (id, kind) => { asked.push(`renderHeader:${id}`); return renderHeader(id, kind); };
      b.hooks.hostState = (id, kind) => { asked.push(`hostState:${id}`); return hostState(id, kind); };
      const marks = { lifecycle: BH.lifecycle.length, renderers: BH.rendererCalls.length, synced: BH.synced.length };
      const toldAboutVictim = () => BH.lifecycle.slice(marks.lifecycle).filter((e) => e.id === victim).map((e) => e.phase);
      let fired = 0;
      let trigger = null;
      let atRequest = null;
      let beforeWrite = null;
      let outcome = null;
      BH.onLifecycle = (id, phase) => {
        // The first item the pass mounts (the file above the one scrolled to).
        if (phase !== 'mount' || id === victim || fired) return;
        fired++;
        trigger = id;
        atRequest = { depth: b._callbackDepth, victimDrawn: !!stale._element || !!stale._headerSlot };
        // Queued before the bridge's own microtask: runs when the pass has
        // ended and the list write has not.
        queueMicrotask(() => {
          const host = stale._element;
          const slot = host ? host.querySelector('.pr-file-header-slot') : null;
          beforeWrite = {
            writeWaiting: b._listWriteQueued,
            viewerHasItem: !!b.codeView.getItem(victim),
            mounted: !!host && host.isConnected,
            fileName: host ? host.getAttribute('data-file-name') : null,
            classes: host ? [...host.classList].sort() : null,
            slotHeight: slot ? slot.getBoundingClientRect().height : null,
            pageHeader: !!host && !!host.querySelector('.pr-file-header-slot .ph'),
            rows: !!host && host.shadowRoot.querySelectorAll('[data-content] > [data-line]').length > 0,
            card: !!document.querySelector('[data-card-id="victim-card"]'),
            asked: asked.filter((a) => a.endsWith(`:${victim}`)),
            renderers: BH.rendererCalls.slice(marks.renderers).filter((c) => c.file === victim).map((c) => c.type),
            synced: BH.synced.slice(marks.synced).filter((c) => c.id === 'victim-card').length,
            told: toldAboutVictim(),
          };
        });
        if (mode !== 'renderAll-same') BH.forgotten.add(victim);
        if (mode === 'reconcile') outcome = b.reconcile(T.entries).removed;
        else if (mode === 'renderAll-without') outcome = BH.renderAll(T.entries.filter((e) => e.id !== victim), { keyPrefix: 'rev2' });
        else outcome = BH.renderAll(T.entries, { keyPrefix: 'rev2' });
      };
      b.scrollToItem(victim);
      await H.settle(600);
      BH.onLifecycle = null;
      Object.assign(b.hooks, { renderHeader, hostState });
      const expectedIds = mode === 'renderAll-without' ? T.names.filter((n) => n !== victim) : T.names;
      return {
        before, trigger, atRequest, outcome, beforeWrite, victim, expectedIds,
        after: {
          list: BH.listState(all),
          told: toldAboutVictim(),
          victimHost: b.files.has(victim) ? BH.hostInfo(victim) : null,
          headersMissing: H.mounted().map((id) => BH.hostInfo(id)).filter((info) => !info || info.header !== info.fileName).length,
          sound: BH.sound(),
        },
      };
    }, { CONTEXT, mode });

    const context = mode === 'reconcile';
    expect(result.before).toEqual({ kind: context ? 'context' : 'diff', mounted: false, slot: false, cardBuilt: false });
    expect(result.trigger).not.toBeNull();
    expect(result.trigger).not.toBe(result.victim);
    expect(result.atRequest).toEqual({ depth: 1, victimDrawn: false });
    expect(result.outcome).toEqual(context ? [CONTEXT] : true);
    expect(result.beforeWrite).toEqual({
      writeWaiting: true,
      viewerHasItem: true,
      // The same pass went on to draw the item whose record is gone.
      mounted: true,
      fileName: result.victim,
      classes: context ? ['context-file', 'd2h-file-wrapper'] : ['d2h-file-wrapper'],
      // An empty header slot of the height the viewer was told, and the file's lines.
      slotHeight: 40,
      pageHeader: false,
      rows: true,
      card: false,
      // Nothing of the page ran for it.
      asked: [],
      renderers: [],
      synced: 0,
      told: [],
    });
    expect(result.after.list).toEqual({ viewerIds: result.expectedIds, recordIds: result.expectedIds, outOfStep: [] });
    if (mode === 'renderAll-same') {
      // The new record's item is announced by its mount; the unmount of the
      // old item, which was never announced, is not told.
      expect(result.after.told[0]).toBe('mount');
      expect(result.after.told).not.toContain('unmount');
      expect(result.after.victimHost).toMatchObject({ fileName: result.victim, header: result.victim });
    } else {
      expect(result.after.told).toEqual([]);
      expect(result.after.victimHost).toBeNull();
    }
    expect(result.after.headersMissing).toBe(0);
    expect(result.after.sound).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

// The view restore of a list write runs after the write's flush, and the
// flush runs the page's hooks. A hook that asks for the next list write
// there makes `files` the records of a list the viewer does not have yet.
// What the restore sends must address the list its own write sent.
const NESTED = [
  ['the file being read has another diff in the first list', 'other-diff'],
  ['the file being read is not in the first list', 'absent'],
  ['a selected file is not in the first list', 'selection-absent'],
  ['a selected file is in both lists', 'selection-kept'],
];
for (const [what, scenario] of NESTED) {
  test(`the view restore of a list write addresses the list that write sent when a hook asked for the next one while it was drawing: ${what}`, async ({ harness }) => {
    const run = async (nested) => {
      const page = await openBridge(harness);
      await readingInTheMiddle(page);
      const result = await page.evaluate(async ({ scenario, nested }) => {
        const { H, BH, T } = window;
        const b = BH.bridge;
        const key = T.line.side === 'deletions' ? 'deletion' : 'addition';
        const covers = (name) => b.files.get(name).metadata.hunks.some((h) => T.line.n >= h[`${key}Start`] && T.line.n < h[`${key}Start`] + h[`${key}Count`]);
        const selFile = T.names[T.names.indexOf(T.reading) + 1];
        let first = T.entries;
        if (scenario === 'other-diff') {
          // Another file's patch under the path being read: the line being read is not shown by it.
          const other = T.names.find((n) => n !== T.reading && !covers(n));
          first = T.entries.map((e) => (e.id === T.reading ? { ...e, patch: H.workload.patches[other] } : e));
        } else if (scenario === 'absent') {
          first = T.entries.filter((e) => e.id !== T.reading);
        } else if (scenario === 'selection-absent') {
          first = T.entries.filter((e) => e.id !== selFile);
        }
        if (scenario.startsWith('selection')) {
          const line = b.files.get(selFile).metadata.hunks[0].additionStart;
          b.selectLines(selFile, line, line + 1, 'RIGHT');
          await H.settle(200);
        }
        const selectedBefore = b.getLineSelection(selFile);
        // Every selection the page is told about, with whether the item's record was the pane's then.
        const told = [];
        const onLineSelect = b.options.onLineSelect;
        b.options.onLineSelect = (id, range) => { told.push({ id, current: b.files.get(id) === b._listed.get(id) }); return onLineSelect(id, range); };
        const writes = BH.spyOnSetItems();
        const sent = BH.spyOnListCommands();
        let fired = 0;
        let depth = null;
        if (nested) {
          BH.onLifecycle = (id, phase) => {
            if (phase !== 'mount' || fired) return;
            fired++;
            depth = b._callbackDepth;
            BH.renderAll(T.entries, { keyPrefix: 'rev3' });
          };
          BH.renderAll(first, { keyPrefix: 'rev2' });
          BH.onLifecycle = null;
        } else {
          BH.renderAll(first, { keyPrefix: 'rev2' });
          BH.renderAll(T.entries, { keyPrefix: 'rev3' });
        }
        const sameTask = { writes: writes.slice(), waiting: b._listWriteQueued };
        await H.settle(500);
        writes.restore();
        sent.restore();
        b.options.onLineSelect = onLineSelect;
        const firstVisible = H.firstVisibleItem();
        return {
          fired, depth, sameTask, firstLength: first.length,
          writes: writes.slice(),
          sent: sent.slice(),
          told,
          selectedBefore,
          selection: b.getLineSelection(selFile),
          moved: T.moved(),
          firstVisible,
          firstVisibleTop: Math.round(H.viewportTopOf(H.host(firstVisible))),
          list: BH.listState(T.names),
          sound: BH.sound(),
          names: T.names,
        };
      }, { scenario, nested });
      expect(harness.validatorErrors(page)).toEqual([]);
      await page.close();
      return result;
    };
    const control = await run(false);
    const nested = await run(true);

    for (const result of [control, nested]) {
      expect(result.writes).toEqual([0, result.firstLength, 0, 30]);
      // Whatever was sent addressed an item the viewer had, and a line that item showed.
      expect(result.sent.filter((s) => !s.hasItem)).toEqual([]);
      expect(result.sent.filter((s) => s.type === 'line' && !s.showsLine)).toEqual([]);
      // The page is told of a selection only in an item whose record is the pane's.
      expect(result.told.filter((t) => !t.current)).toEqual([]);
      expect(result.list).toEqual({ viewerIds: result.names, recordIds: result.names, outOfStep: [] });
      expect(result.sound).toEqual({ orphans: 0, clean: true });
    }
    expect(control.sameTask).toEqual({ writes: control.writes, waiting: false });
    expect(control.fired).toBe(0);
    // The hook ran inside the first write's flush; the second write waited for the first to end.
    expect(nested.fired).toBe(1);
    expect(nested.depth).toBe(1);
    expect(nested.sameTask).toEqual({ writes: [0, nested.firstLength], waiting: true });

    // The reader and the selection end where two direct writes leave them.
    expect(nested.moved).toBe(control.moved);
    expect(nested.firstVisible).toBe(control.firstVisible);
    expect(nested.firstVisibleTop).toBe(control.firstVisibleTop);
    expect(nested.selection).toEqual(control.selection);
    if (scenario === 'other-diff') expect(control.moved).toBe(0);
    if (scenario === 'selection-absent') {
      expect(control.selectedBefore).not.toBeNull();
      expect(control.selection).toBeNull();
      expect(control.sent.filter((s) => s.call === 'setSelectedLines')).toEqual([]);
      expect(nested.sent.filter((s) => s.call === 'setSelectedLines')).toEqual([]);
    }
    if (scenario === 'selection-kept') {
      expect(control.selection).toEqual(control.selectedBefore);
      expect(control.selection).not.toBeNull();
      expect(nested.told.length).toBeGreaterThan(0);
    }
  });
}

test('the view restore asks the item the viewer holds: a kept context file whose ranges the next reconcile, asked for while the write was drawing, changed', async ({ harness }) => {
  const run = async (nested) => {
    const page = await openBridge(harness);
    const { readingIndex } = await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ CONTEXT, SECOND, readingIndex, nested }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      const all = [...T.names, CONTEXT, SECOND];
      const both = [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }];
      // The reader is inside the context file, in its first range.
      b.reconcile(T.withContext(readingIndex, { ranges: both }));
      await H.settle(300);
      b.scrollToLine(CONTEXT, 110, 'RIGHT', { behavior: 'instant', align: 'start', flash: false });
      await H.settle(400);
      const row = [...H.host(CONTEXT).shadowRoot.querySelectorAll('[data-content] > [data-line]')].find((r) => H.viewportTopOf(r) >= 40);
      const read = { line: Number(row.getAttribute('data-line')), top: H.viewportTopOf(row), firstVisible: H.firstVisibleItem() };
      // First list: the file keeps its record, shows only its second range,
      // and another context file comes in (so the list is written).
      const first = T.withContext(readingIndex, { ranges: [both[1]] });
      first.splice(3, 0, BH.contextEntry(SECOND, { contents: BH.numberedLines(120), ranges: [{ startLine: 10, endLine: 20 }] }));
      // Second list: both ranges again, the other file gone (so the list is written again).
      const second = T.withContext(readingIndex, { ranges: both });
      const record = b.files.get(CONTEXT);
      const writes = BH.spyOnSetItems();
      const sent = BH.spyOnListCommands();
      let fired = 0;
      let atNested = null;
      if (nested) {
        BH.onLifecycle = (id, phase) => {
          if (phase !== 'mount' || fired) return;
          fired++;
          const outcome = b.reconcile(second);
          // The record is ahead of the viewer's item: it shows the line being read again, the item does not.
          atNested = {
            depth: b._callbackDepth,
            updated: outcome.updated,
            removed: outcome.removed,
            sameRecord: b.files.get(CONTEXT) === record,
            recordShowsLine: b.isLineVisible(CONTEXT, read.line, 'RIGHT'),
            itemIsRecords: b.codeView.getItem(CONTEXT).fileDiff === record.metadata,
          };
        };
        b.reconcile(first);
        BH.onLifecycle = null;
      } else {
        b.reconcile(first);
        b.reconcile(second);
      }
      await H.settle(500);
      writes.restore();
      sent.restore();
      const now = H.findRow(CONTEXT, read.line, 'additions');
      return {
        read, fired, atNested,
        writes: writes.slice(),
        sent: sent.slice(),
        rowTop: now ? Math.round(H.viewportTopOf(now)) : null,
        firstVisible: H.firstVisibleItem(),
        runs: BH.lineRuns(CONTEXT),
        list: BH.listState(all).outOfStep,
        sound: BH.sound(),
      };
    }, { CONTEXT, SECOND, readingIndex, nested });
    expect(harness.validatorErrors(page)).toEqual([]);
    await page.close();
    return result;
  };
  const control = await run(false);
  const nested = await run(true);

  expect(control.read.firstVisible).toBe(CONTEXT);
  expect(control.read.line).toBeGreaterThanOrEqual(100);
  expect(control.read.line).toBeLessThanOrEqual(120);
  expect(nested.read).toEqual(control.read);
  expect(nested.fired).toBe(1);
  expect(nested.atNested).toEqual({ depth: 1, updated: [CONTEXT], removed: [SECOND], sameRecord: true, recordShowsLine: true, itemIsRecords: false });
  for (const result of [control, nested]) {
    expect(result.writes).toEqual([0, 32, 0, 31]);
    expect(result.sent.filter((s) => !s.hasItem)).toEqual([]);
    // No line target for a line the viewer's item does not show.
    expect(result.sent.filter((s) => s.type === 'line' && !s.showsLine)).toEqual([]);
    expect(result.runs.slice(0, 2)).toEqual([[100, 120], [300, 310]]);
    expect(result.list).toEqual([]);
    expect(result.sound).toEqual({ orphans: 0, clean: true });
  }
  expect(nested.sent).toEqual(control.sent);
  expect(nested.firstVisible).toBe(control.firstVisible);
  expect(nested.rowTop).toBe(control.rowTop);
});

test('a scroll target and a selection sent by a hook while a list write is drawing are applied after its view restore, as when sent after the write', async ({ harness }) => {
  const run = async (duringWrite) => {
    const page = await openBridge(harness);
    await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ CONTEXT, duringWrite }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      b.selectLines(T.reading, T.line.n, T.line.n + 1, 'RIGHT');
      const sent = BH.spyOnListCommands();
      const commands = () => {
        const answered = b.scrollToLine(CONTEXT, 305, 'RIGHT', { behavior: 'instant', flash: false });
        b.clearLineSelection(T.reading);
        b.selectLines(CONTEXT, 304, 306, 'RIGHT');
        return answered;
      };
      let answered = null;
      let atCall = null;
      let fired = 0;
      if (duringWrite) {
        // The first item the write's flush mounts is the hook's cue.
        BH.onLifecycle = (id, phase) => {
          if (phase !== 'mount' || fired) return;
          fired++;
          answered = commands();
          atCall = { depth: b._callbackDepth, waiting: b._listWriteQueued, sent: sent.length, contextSelection: b.getLineSelection(CONTEXT) };
        };
        b.reconcile(T.withContext(3));
        BH.onLifecycle = null;
      } else {
        b.reconcile(T.withContext(3));
        answered = commands();
      }
      const sameTask = sent.map((s) => `${s.call}:${s.type || ''}:${s.id}:${s.line ?? ''}`);
      await H.settle(500);
      sent.restore();
      const row = H.findRow(CONTEXT, 305, 'additions');
      return {
        answered, atCall, fired, sameTask,
        unaddressed: sent.filter((s) => !s.hasItem || (s.type === 'line' && !s.showsLine)).length,
        rowTop: row ? Math.round(H.viewportTopOf(row)) : null,
        paneHeight: H.root.clientHeight,
        selection: { context: b.getLineSelection(CONTEXT), reading: b.getLineSelection(T.reading) },
        sound: BH.sound(),
        reading: T.reading,
        line: T.line.n,
      };
    }, { CONTEXT, duringWrite });
    expect(harness.validatorErrors(page)).toEqual([]);
    await page.close();
    return result;
  };
  const after = await run(false);
  const during = await run(true);

  expect(after.answered).toBe(true);
  expect(after.rowTop).toBeGreaterThan(40);
  expect(after.rowTop).toBeLessThan(after.paneHeight);
  expect(after.selection).toEqual({ context: { start: 304, end: 306, side: 'RIGHT' }, reading: null });
  // The write's own restore (the line being read, the selection), then the commands.
  const order = [
    `scrollTo:line:${after.reading}:${after.line}`,
    `setSelectedLines::${after.reading}:`,
    `scrollTo:line:${CONTEXT}:305`,
    `setSelectedLines::${CONTEXT}:`,
  ];
  expect(after.sameTask).toEqual(order);

  expect(during.fired).toBe(1);
  expect(during.answered).toBe(true);
  // Inside the write's flush nothing had been sent, and no write was waiting: the commands waited for the restore.
  expect(during.atCall).toEqual({ depth: 1, waiting: false, sent: 0, contextSelection: null });
  expect(during.sameTask).toEqual(order);
  expect(during.unaddressed).toBe(0);
  expect(during.rowTop).toBe(after.rowTop);
  expect(during.selection).toEqual(after.selection);
  expect(during.sound).toEqual({ orphans: 0, clean: true });
  expect(after.sound).toEqual({ orphans: 0, clean: true });
});

for (const [what, mode] of [['of a replaced record', 'replaced'], ['of a file that was taken out', 'removed']]) {
  test(`an old item ${what} that the viewer unmounts before the write: the page hears the unmount of the mount it heard only while it still has the file`, async ({ harness }) => {
    const page = await openBridge(harness);
    const { readingIndex } = await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ CONTEXT, readingIndex, mode }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      const all = [...T.names, CONTEXT];
      let subject = T.reading;
      if (mode === 'removed') {
        // A context file directly above the file being read: mounted, and the page was told.
        b.reconcile(T.withContext(readingIndex));
        await H.settle(300);
        subject = CONTEXT;
      }
      const hostOf = (id) => [...H.root.querySelectorAll('diffs-container')].find((el) => el.getAttribute('data-file-name') === id) || null;
      const phasesOf = (id, from = 0) => BH.lifecycle.slice(from).filter((e) => e.id === id).map((e) => e.phase);
      const before = { mounted: !!hostOf(subject), lastTold: phasesOf(subject).filter((p) => p !== 'update').pop() };
      const mark = BH.lifecycle.length;
      let beforeWrite = null;
      const call = BH.fromViewerCallback('hook', T.reading, T.line.n, () => {
        // Queued before the bridge's own microtask: runs before the list write.
        queueMicrotask(() => {
          beforeWrite = { writeWaiting: b._listWriteQueued, viewerHasItem: !!b.codeView.getItem(subject), mounted: !!hostOf(subject), told: phasesOf(subject, mark).filter((p) => p !== 'update') };
        });
        if (mode === 'removed') {
          BH.forgotten.add(CONTEXT);
          return b.reconcile(T.entries).removed;
        }
        return BH.renderAll(T.entries, { keyPrefix: 'rev2' });
      }, T.line.side);
      // Same task: the reader is moved to the top and the old list is drawn
      // again there, so the viewer unmounts the items in the middle.
      H.root.scrollTop = 0;
      b.setDiffStyle('split');
      await H.settle(400);
      const mountPhases = phasesOf(subject, mark).filter((p) => p !== 'update');
      return {
        before, ran: call.ran, outcome: call.value, beforeWrite,
        told: mountPhases,
        mountedNow: !!hostOf(subject),
        list: BH.listState(all).outOfStep,
        sound: BH.sound(),
      };
    }, { CONTEXT, readingIndex, mode });

    expect(result.before).toEqual({ mounted: true, lastTold: 'mount' });
    expect(result.ran).toBe(1);
    expect(result.outcome).toEqual(mode === 'removed' ? [CONTEXT] : true);
    // The viewer unmounted the old item while the list write was still waiting.
    expect(result.beforeWrite).toEqual({
      writeWaiting: true,
      viewerHasItem: true,
      mounted: false,
      told: mode === 'removed' ? [] : ['unmount'],
    });
    // And the write had nothing more to say about it.
    expect(result.told).toEqual(mode === 'removed' ? [] : ['unmount']);
    expect(result.mountedNow).toBe(false);
    expect(result.list).toEqual([]);
    expect(result.sound).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

test('a list write asked for by the page from inside a list write (the selection callback of its view restore) waits for that write to end', async ({ harness }) => {
  const run = async (fromCallback) => {
    const page = await openBridge(harness);
    await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ fromCallback }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      const selFile = T.names[T.names.indexOf(T.reading) + 1];
      const line = b.files.get(selFile).metadata.hunks[0].additionStart;
      b.selectLines(selFile, line, line + 1, 'RIGHT');
      await H.settle(200);
      const selectedBefore = b.getLineSelection(selFile);
      const writes = BH.spyOnSetItems();
      let atCall = null;
      let afterCall = null;
      if (fromCallback) {
        const onLineSelect = b.options.onLineSelect;
        b.options.onLineSelect = (id, range) => {
          onLineSelect(id, range);
          if (atCall) return;
          // The viewer tells of the selection the restore puts back: not a render callback, and the write is not over.
          atCall = { id, depth: b._callbackDepth, writes: writes.slice() };
          const first = b.files.get(selFile);
          const ok = BH.renderAll(T.entries, { keyPrefix: 'rev3' });
          afterCall = { ok, newRecord: b.files.get(selFile) !== first, writes: writes.slice(), waiting: b._listWriteQueued };
        };
        BH.renderAll(T.entries, { keyPrefix: 'rev2' });
        b.options.onLineSelect = onLineSelect;
      } else {
        BH.renderAll(T.entries, { keyPrefix: 'rev2' });
        BH.renderAll(T.entries, { keyPrefix: 'rev3' });
      }
      const sameTask = { writes: writes.slice(), waiting: b._listWriteQueued };
      await H.settle(500);
      writes.restore();
      return {
        selFile, selectedBefore, atCall, afterCall, sameTask,
        writes: writes.slice(),
        selection: b.getLineSelection(selFile),
        moved: T.moved(),
        key: b.files.get(selFile).baseKey.split(':')[0],
        list: BH.listState(T.names),
        sound: BH.sound(),
        names: T.names,
      };
    }, { fromCallback });
    expect(harness.validatorErrors(page)).toEqual([]);
    await page.close();
    return result;
  };
  const direct = await run(false);
  const nested = await run(true);

  expect(direct.sameTask).toEqual({ writes: [0, 30, 0, 30], waiting: false });
  expect(direct.selection).toEqual(direct.selectedBefore);
  expect(direct.selection).not.toBeNull();
  expect(direct.moved).toBe(0);

  expect(nested.atCall).toEqual({ id: nested.selFile, depth: 0, writes: [0, 30] });
  // The records are the new diff's at once; the list waits for the write in progress to end.
  expect(nested.afterCall).toEqual({ ok: true, newRecord: true, writes: [0, 30], waiting: true });
  expect(nested.sameTask).toEqual({ writes: [0, 30], waiting: true });
  expect(nested.writes).toEqual([0, 30, 0, 30]);
  expect(nested.key).toBe('rev3');
  expect(nested.selection).toEqual(direct.selection);
  expect(nested.moved).toBe(direct.moved);
  for (const result of [direct, nested]) {
    expect(result.list).toEqual({ viewerIds: result.names, recordIds: result.names, outOfStep: [] });
    expect(result.sound).toEqual({ orphans: 0, clean: true });
  }
});
