// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: annotations. What a publish guarantees, the element
 * cache, sync on a draw and never on a lookup, the flush guard, and the
 * app's real card renderers with collaborators handed in.
 */

import { test, expect, openBridge } from './bridge-test.js';

/** Bring up a few files and return a line of the first one that is on screen. */
async function up(page, options = {}) {
  return page.evaluate(async (options) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    // Thirty modified files: every one has hunks, and the list is several screens long.
    const names = H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 30);
    await BH.up({ entries: names.map((n) => BH.diffEntry(n)), options });
    const hunk = BH.bridge.files.get(names[0]).metadata.hunks[0];
    return { names, file: names[0], line: hunk.additionStart + 1, far: names[25] };
  }, options);
}

test('add, add many, remove, remove by type: the card of a mounted file is attached in the same task', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line } = await up(page);
  const result = await page.evaluate(async ({ file, line }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const out = {};
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'one' }, id: 'card-1' });
    out.afterAdd = BH.cardState(file, 'card-1');
    b.addAnnotations(file, [
      { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'two' }, id: 'card-2' },
      { lineNumber: line + 1, side: 'RIGHT', type: 'card', data: { text: 'three' }, id: 'card-3' },
      { lineNumber: line + 1, side: 'RIGHT', type: 'other', data: {}, id: 'other-1' },
    ]);
    out.afterBatch = ['card-2', 'card-3'].map((id) => BH.cardState(file, id).connected);
    out.generatedId = (() => {
      b.addAnnotation(file, { lineNumber: line + 2, side: 'LEFT', type: 'card', data: { text: 'auto' } });
      return b.getAnnotations(file, 'card').map((a) => a.metadata.id).find((id) => /^card-\d+-deletions-\d+$/.test(id)) || null;
    })();
    out.listed = b.getAnnotations(file).map((a) => a.metadata.id);
    out.zoneListed = b.getAnnotations(file).some((a) => a.metadata.type === 'file-comments');
    out.has = [b.hasAnnotation(file, 'card-1'), b.hasAnnotation(file, 'nope'), b.hasAnnotation('nope.js', 'card-1')];
    out.findFile = [b.findAnnotationFile('card-3'), b.findAnnotationFile('nope'), b.findAnnotationFile('file-comments')];
    out.findByData = b.findAnnotationByData('card', (data) => data.text === 'three')?.fileName ?? null;

    const removedEl = b.getAnnotationElement(file, 'card-1');
    b.removeAnnotation(file, 'card-1');
    out.afterRemove = { held: b.hasAnnotation(file, 'card-1'), connected: removedEl.isConnected, lookup: b.getAnnotationElement(file, 'card-1') };
    b.removeAnnotationsByType(file, 'card');
    out.afterRemoveByType = b.getAnnotations(file).map((a) => a.metadata.id);
    // The file's comment zone is part of the file: it cannot be removed.
    b.removeAnnotation(file, 'file-comments');
    b.removeAnnotationsByType(file, 'file-comments');
    out.zoneStill = b.codeView.getItem(file).annotations[0].metadata.type;
    // A file the bridge does not hold: nothing happens, nothing throws.
    b.addAnnotation('nope.js', { lineNumber: 1, side: 'RIGHT', type: 'card', data: {} });
    b.addAnnotations(file, []);
    b.removeAnnotation('nope.js', 'x');
    out.unknownFile = b.getAnnotations('nope.js');
    await H.settle(100);
    out.sound = BH.sound();
    return out;
  }, { file, line });

  expect(result.afterAdd).toMatchObject({ built: true, connected: true, slot: `annotation-additions-${line}`, host: file });
  expect(result.afterBatch).toEqual([true, true]);
  expect(result.generatedId).not.toBeNull();
  expect(result.listed).toEqual(expect.arrayContaining(['card-1', 'card-2', 'card-3', 'other-1']));
  expect(result.zoneListed).toBe(false);
  expect(result.has).toEqual([true, false, false]);
  expect(result.findFile).toEqual([file, null, null]);
  expect(result.findByData).toBe(file);
  expect(result.afterRemove).toEqual({ held: false, connected: false, lookup: null });
  expect(result.afterRemoveByType).toEqual(['other-1']);
  expect(result.zoneStill).toBe('file-comments');
  expect(result.unknownFile).toEqual([]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('cards on one line are drawn in the app\'s order, whatever order they were added in', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line } = await up(page);
  const order = await page.evaluate(async ({ file, line }) => {
    const { BH } = window;
    const b = BH.bridge;
    for (const type of ['external-comment', 'comment-like', 'tour-stop', 'hunk-summary']) {
      b.registerAnnotationRenderer(type, (data, id) => {
        const el = document.createElement('div');
        el.className = 'ann';
        el.dataset.cardId = id;
        return el;
      });
    }
    b.batch(() => {
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'external-comment', data: {}, id: 'ext' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'comment-form', data: { lineStart: line, lineEnd: line, side: 'RIGHT' }, id: 'form' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'tour-stop', data: {}, id: 'tour' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'hunk-summary', data: {}, id: 'summary' });
    });
    const slot = BH.bridge.findFileElement(file).querySelectorAll(`[data-annotation-slot][slot="annotation-additions-${line}"] > *`);
    return [...slot].map((el) => el.dataset.cardId || el.dataset.annotationId);
  }, { file, line });
  expect(order).toEqual(['summary', 'tour', 'form', 'ext']);
});

test('a card is built once, re-attached after its file left the window, and synced on every draw but never by a lookup', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line, far } = await up(page);
  const result = await page.evaluate(async ({ file, line, far }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const data = { text: 'kept', n: 1, textarea: true };
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'card', data, id: 'card-1' });
    const el = b.getAnnotationElement(file, 'card-1');
    el.querySelector('textarea').value = 'typed by the reader';
    el.dataset.readerState = 'open';
    const syncsAfterBuild = BH.synced.length;

    // A lookup of a card that exists changes nothing, also when the data moved on.
    data.n = 2;
    const looked = b.getAnnotationElement(file, 'card-1', { create: true });
    const afterLookup = { same: looked === el, syncs: BH.synced.length - syncsAfterBuild, stamped: el.dataset.syncedN };

    // Away and back: the file unmounts, its host is recycled, the card detaches.
    b.scrollToItem(far);
    await H.settle(300);
    const away = { mounted: b.findFileElement(file) !== null, connected: el.isConnected, lookup: b.getAnnotationElement(file, 'card-1') === el };
    b.scrollToItem(file);
    await H.settle(300);
    return {
      builds: BH.cardBuilds,
      syncsAfterBuild,
      afterLookup,
      away,
      back: {
        connected: el.isConnected,
        same: b.getAnnotationElement(file, 'card-1') === el,
        value: el.querySelector('textarea').value,
        readerState: el.dataset.readerState,
        // The draw on remount brought the card in line with its data.
        stamped: el.dataset.syncedN,
        syncedOnRemount: BH.synced.length > syncsAfterBuild,
      },
      sound: BH.sound(),
    };
  }, { file, line, far });

  expect(result.builds).toBe(1);
  expect(result.syncsAfterBuild).toBeGreaterThanOrEqual(1);
  expect(result.afterLookup).toEqual({ same: true, syncs: 0, stamped: '1' });
  expect(result.away).toEqual({ mounted: false, connected: false, lookup: true });
  expect(result.back).toEqual({ connected: true, same: true, value: 'typed by the reader', readerState: 'open', stamped: '2', syncedOnRemount: true });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('getAnnotationElement builds the card of a file that was never mounted, and the viewer later draws that element', async ({ harness }) => {
  const page = await openBridge(harness);
  const { far } = await up(page);
  const result = await page.evaluate(async ({ far }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const line = b.files.get(far).metadata.hunks[0].additionStart + 1;
    const everMounted = BH.lifecycle.some((e) => e.id === far);
    b.addAnnotation(far, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'far' }, id: 'card-far' });
    const before = b.getAnnotationElement(far, 'card-far');
    const built = b.getAnnotationElement(far, 'card-far', { create: true });
    const builtDetached = !!built && !built.isConnected;
    const waiting = b.whenAnnotationRendered(far, 'card-far', { timeoutMs: 5000 });
    b.scrollToLine(far, line, 'RIGHT', { behavior: 'instant' });
    const rendered = await waiting;
    await H.settle(150);
    return {
      everMounted,
      before,
      builtDetached,
      renderedIsBuilt: rendered === built,
      connected: built.isConnected,
      builds: BH.cardBuilds,
      sound: BH.sound(),
    };
  }, { far });
  expect(result.everMounted).toBe(false);
  expect(result.before).toBeNull();
  expect(result.builtDetached).toBe(true);
  expect(result.renderedIsBuilt).toBe(true);
  expect(result.connected).toBe(true);
  expect(result.builds).toBe(1);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('whenAnnotationRendered answers null at once for a line the file does not show, a collapsed file, and an unknown annotation', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line } = await up(page);
  const result = await page.evaluate(async ({ file, line }) => {
    const { BH } = window;
    const b = BH.bridge;
    const timed = async (promise) => { const t0 = performance.now(); const value = await promise; return { isNull: value === null, fast: performance.now() - t0 < 500 }; };
    b.addAnnotation(file, { lineNumber: 99999, side: 'RIGHT', type: 'card', data: {}, id: 'card-hidden' });
    const hidden = await timed(b.whenAnnotationRendered(file, 'card-hidden'));
    const unknown = await timed(b.whenAnnotationRendered(file, 'nope'));
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'card', data: {}, id: 'card-shown' });
    b.setCollapsed(file, true);
    const collapsed = await timed(b.whenAnnotationRendered(file, 'card-shown'));
    let cancelledAfter = 0;
    b.setCollapsed(file, false);
    const cancelled = await timed(b.whenAnnotationRendered(file, 'card-shown', { isCancelled: () => ++cancelledAfter > 0 }));
    return { hidden, unknown, collapsed, shownAgain: cancelled };
  }, { file, line });
  expect(result.hidden).toEqual({ isNull: true, fast: true });
  expect(result.unknown).toEqual({ isNull: true, fast: true });
  expect(result.collapsed).toEqual({ isNull: true, fast: true });
  // Expanded again and mounted: the card is attached in the same task, before any cancel check.
  expect(result.shownAgain).toEqual({ isNull: false, fast: true });
});

test('a card on a row the viewer does not draw is in the document and not drawn; scrollToAnnotation and whenAnnotationRendered bring it on screen', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    // An added file of 20,000 lines: the viewer draws it in blocks of 5,000 rows.
    const id = H.workload.roles.hugeAdded;
    await BH.up({ entries: [BH.diffEntry(H.workload.roles.small), BH.diffEntry(id)] });
    const b = BH.bridge;
    const total = b.files.get(id).metadata.hunks.reduce((n, hunk) => n + hunk.additionCount, 0);
    const farLine = total - 100;
    b.addAnnotation(id, { lineNumber: 0, side: 'RIGHT', type: 'card', id: 'file-level', data: { text: 'file-level card.', height: 30 } });
    b.addAnnotation(id, { lineNumber: 120, side: 'RIGHT', type: 'card', id: 'near', data: { text: 'near card.', height: 30 } });
    b.addAnnotation(id, { lineNumber: farLine, side: 'RIGHT', type: 'card', id: 'far', data: { text: 'far card.', height: 30 } });
    await H.settle(300);
    const pane = () => H.root.getBoundingClientRect();
    const card = (annotationId) => {
      const element = b.getAnnotationElement(id, annotationId);
      const box = element.getBoundingClientRect();
      return {
        connected: element.isConnected,
        drawn: b.isElementDrawn(element),
        height: Math.round(box.height),
        inPane: box.height > 0 && box.top >= pane().top && box.bottom <= pane().bottom,
      };
    };
    const rows = () => {
      const all = H.host(id).shadowRoot.querySelectorAll('[data-content] > [data-line]');
      return { count: all.length, first: Number(all[0].getAttribute('data-line')), last: Number(all[all.length - 1].getAttribute('data-line')) };
    };
    const go = async (annotationId) => {
      const sent = b.scrollToAnnotation(id, annotationId);
      const element = await b.whenAnnotationRendered(id, annotationId, { timeoutMs: 8000 });
      await H.settle(300);
      return { sent, resolved: element === b.getAnnotationElement(id, annotationId), ...card(annotationId) };
    };
    const out = { total };
    // The reader at the top of the file.
    out.atTop = { rows: rows(), near: card('near'), far: card('far') };
    // Asked for without a scroll: the wait does not hand back a card that is merely in the document.
    const waited = await b.whenAnnotationRendered(id, 'far', { timeoutMs: 100 });
    out.farWithoutScroll = waited === null;
    out.far = await go('far');
    // The reader near the end of the file: the rows at its top are not drawn there.
    out.atEnd = { rows: rows(), fileLevel: card('file-level'), near: card('near') };
    out.near = await go('near');
    b.scrollToLine(id, farLine, 'RIGHT', { align: 'center', behavior: 'instant', flash: false });
    await H.settle(300);
    out.atEndAgain = { fileLevel: card('file-level') };
    out.fileLevel = await go('file-level');
    // Drawn already: nothing is sent, and the wait answers at once.
    const before = H.root.scrollTop;
    out.again = await go('file-level');
    out.movedWhenDrawn = Math.round(H.root.scrollTop - before);
    out.sound = BH.sound();
    return out;
  });
  expect(result.total).toBe(20000);
  // In the document, without a row to be shown in.
  expect(result.atTop.rows).toEqual({ count: 5000, first: 1, last: 5000 });
  expect(result.atTop.near).toEqual({ connected: true, drawn: true, height: 30, inPane: expect.any(Boolean) });
  expect(result.atTop.far).toEqual({ connected: true, drawn: false, height: 0, inPane: false });
  expect(result.farWithoutScroll).toBe(true);
  expect(result.far).toEqual({ sent: true, resolved: true, connected: true, drawn: true, height: 30, inPane: true });
  expect(result.atEnd.rows.first).toBeGreaterThan(120);
  expect(result.atEnd.fileLevel).toEqual({ connected: true, drawn: false, height: 0, inPane: false });
  expect(result.atEnd.near).toEqual({ connected: true, drawn: false, height: 0, inPane: false });
  expect(result.near).toEqual({ sent: true, resolved: true, connected: true, drawn: true, height: 30, inPane: true });
  expect(result.atEndAgain.fileLevel).toEqual({ connected: true, drawn: false, height: 0, inPane: false });
  expect(result.fileLevel).toEqual({ sent: true, resolved: true, connected: true, drawn: true, height: 30, inPane: true });
  expect(result.again).toEqual({ sent: true, resolved: true, connected: true, drawn: true, height: 30, inPane: true });
  expect(result.movedWhenDrawn).toBe(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('a card on a line that was just revealed: its file\'s display draws it where the pane is, unless the file is drawn in row windows, where the pane is taken to it first', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const SHORT = 'ctx/short.js';
    const LONG = 'ctx/long.js';
    // Two coloured context files (under 400 KB each). The long one shows 6,000 of its 7,000 lines: it is drawn in windows of its rows.
    await BH.up({ entries: [
      BH.contextEntry(SHORT, { contents: BH.numberedLines(400), ranges: [{ startLine: 100, endLine: 120 }] }),
      BH.contextEntry(LONG, { contents: BH.numberedLines(7000), ranges: [{ startLine: 1, endLine: 6000 }] }),
    ], quietMs: 400 });
    const b = BH.bridge;
    await H.until(() => (H.shape(SHORT)?.tokens ?? 0) > 0 && (H.shape(LONG)?.tokens ?? 0) > 0, 30000);
    const pane = () => H.root.getBoundingClientRect();
    const state = (file, id) => {
      const element = b.getAnnotationElement(file, id);
      const box = element ? element.getBoundingClientRect() : null;
      return {
        connected: !!element && element.isConnected,
        drawn: b.isElementDrawn(element),
        hasBox: !!box && box.height > 0,
      };
    };
    const inPane = (file, id) => {
      const box = b.getAnnotationElement(file, id).getBoundingClientRect();
      return box.height > 0 && box.top >= pane().top && box.bottom <= pane().bottom;
    };
    const reveal = async (file, line, id) => {
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'card', id, data: { text: `${id}.`, height: 30 } });
      const out = { shownBefore: b.isLineVisible(file, line, 'RIGHT') };
      // The line is revealed: a new diff of the file, which the viewer draws when it has been highlighted.
      b.addContextRanges(file, [{ startLine: line - 5, endLine: line + 5 }]);
      out.pending = !b.isDiffDisplayed(file);
      out.whilePending = state(file, id);
      const before = H.root.scrollTop;
      out.sent = b.scrollToAnnotation(file, id);
      const element = await b.whenAnnotationRendered(file, id, { timeoutMs: 8000 });
      out.resolved = element === b.getAnnotationElement(file, id);
      out.resolvedWhilePending = out.resolved && !b.isDiffDisplayed(file);
      // Whether the pane had been taken somewhere by the time the card was handed over.
      out.paneMoved = H.root.scrollTop !== before;
      await BH.displayed(file);
      await H.settle(300);
      out.after = state(file, id);
      // What the page does next: the browser's own scroll to the card, which needs the card to have a place.
      b.getAnnotationElement(file, id).scrollIntoView({ block: 'center' });
      await H.settle(300);
      out.inPaneAfterTheScroll = inPane(file, id);
      return out;
    };
    const out = {};
    // The short file, on screen at the top of the pane.
    out.short = await reveal(SHORT, 300, 'short-card');
    // The long file, the reader at its first rows; the card's line is beyond the rows drawn there.
    b.scrollToItem(LONG);
    await H.settle(300);
    out.longRows = H.host(LONG).shadowRoot.querySelectorAll('[data-content] > [data-line]').length;
    out.long = await reveal(LONG, 6500, 'long-card');
    out.sound = BH.sound();
    return out;
  });
  // Drawn whole: nothing is sent, the wait hands the card over while the diff is still on its way, and the display draws it.
  expect(result.short.shownBefore).toBe(false);
  expect(result.short.pending).toBe(true);
  expect(result.short.whilePending).toEqual({ connected: true, drawn: false, hasBox: false });
  expect(result.short).toMatchObject({ sent: true, resolved: true, resolvedWhilePending: true, paneMoved: false });
  expect(result.short.after).toEqual({ connected: true, drawn: true, hasBox: true });
  expect(result.short.inPaneAfterTheScroll).toBe(true);
  // Drawn in windows: the pane is taken to the line, and the card is waited for until it is drawn there.
  expect(result.longRows).toBe(5000);
  expect(result.long.pending).toBe(true);
  expect(result.long.whilePending).toEqual({ connected: true, drawn: false, hasBox: false });
  expect(result.long).toMatchObject({ sent: true, resolved: true, resolvedWhilePending: false, paneMoved: true });
  expect(result.long.after).toEqual({ connected: true, drawn: true, hasBox: true });
  expect(result.long.inPaneAfterTheScroll).toBe(true);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('a renderer that publishes while the viewer is drawing does not corrupt the layout (flush guard)', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line, far } = await up(page);
  const result = await page.evaluate(async ({ file, line, far }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    let publishedFromRenderer = 0;
    b.registerAnnotationRenderer('eager', (data, id) => {
      // What a feature module might do from inside its renderer: add another card.
      if (!b.hasAnnotation(file, 'card-from-renderer')) {
        publishedFromRenderer++;
        b.addAnnotation(file, { lineNumber: line + 2, side: 'RIGHT', type: 'card', data: { text: 'from renderer' }, id: 'card-from-renderer' });
      }
      const el = document.createElement('div');
      el.className = 'ann';
      el.textContent = id;
      return el;
    });
    // The lifecycle hook runs inside the viewer's pass too.
    let publishedFromHook = 0;
    BH.onLifecycle = (id, phase) => {
      if (id === file && phase === 'update' && !b.hasAnnotation(file, 'card-from-hook')) {
        publishedFromHook++;
        b.addAnnotation(file, { lineNumber: line + 3, side: 'RIGHT', type: 'card', data: { text: 'from hook' }, id: 'card-from-hook' });
      }
    };
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'eager', data: {}, id: 'eager-1' });
    const sameTask = BH.cardState(file, 'card-from-renderer').connected;
    await H.settle(150);
    const settled = ['eager-1', 'card-from-renderer', 'card-from-hook'].map((id) => BH.cardState(file, id).connected);
    // Walk away and back: a corrupted layout does not heal.
    b.scrollToItem(far);
    await H.settle(250);
    b.scrollToItem(file);
    await H.settle(250);
    return { publishedFromRenderer, publishedFromHook, sameTask, settled, sound: BH.sound() };
  }, { file, line, far });
  expect(result.publishedFromRenderer).toBe(1);
  expect(result.publishedFromHook).toBe(1);
  // The nested publish is flushed after the pass, not inside it.
  expect(result.sameTask).toBe(false);
  expect(result.settled).toEqual([true, true, true]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('batch: many publishes, one flush, and the cards are there when it returns', async ({ harness }) => {
  const page = await openBridge(harness);
  const { names } = await up(page);
  const result = await page.evaluate(async ({ names }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const cv = b.codeView;
    const originalRender = cv.render.bind(cv);
    const originalUpdate = cv.updateItem.bind(cv);
    let flushes = 0;
    let updates = 0;
    cv.render = (immediate) => { if (immediate) flushes++; return originalRender(immediate); };
    cv.updateItem = (item) => { updates++; return originalUpdate(item); };
    const mounted = H.mounted().slice(0, 2);
    const returned = b.batch(() => {
      for (const id of mounted) {
        const line = b.files.get(id).metadata.hunks[0].additionStart;
        for (let i = 0; i < 5; i++) b.addAnnotation(id, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: `c${i}` }, id: `card-${id}-${i}` });
      }
      // Nested batches do not flush on their own.
      b.batch(() => b.addAnnotations(mounted[0], [{ lineNumber: b.files.get(mounted[0]).metadata.hunks[0].additionStart, side: 'RIGHT', type: 'card', data: {}, id: 'nested' }]));
      return { flushesInside: flushes };
    });
    const connected = mounted.every((id) => [0, 1, 2, 3, 4].every((i) => BH.cardState(id, `card-${id}-${i}`).connected));
    cv.render = originalRender;
    cv.updateItem = originalUpdate;
    return { returned, flushes, updates, connected, nested: BH.cardState(mounted[0], 'nested').connected };
  }, { names });
  expect(result.returned).toEqual({ flushesInside: 0 });
  expect(result.flushes).toBe(1);
  expect(result.updates).toBe(11);
  expect(result.connected).toBe(true);
  expect(result.nested).toBe(true);
});

test('the app\'s comment, suggestion and form cards are built from collaborators handed to the bridge, with no page manager', async ({ harness }) => {
  const page = await openBridge(harness, {
    before: ['/app/js/utils/posted-comment.js', '/app/js/modules/suggestion-manager.js'],
  });
  const { file, line } = await up(page);
  const result = await page.evaluate(async ({ file, line }) => {
    const { H, BH } = window;
    // The page object the suggestion manager reads its comments from. It is
    // not on window: nothing in the bridge or the shared renderers may need
    // window.prManager.
    const pageState = { userComments: [], escapeHtml: (text) => String(text).replace(/</g, '&lt;') };
    const suggestionManager = new window.SuggestionManager(pageState);
    const submitted = [];
    BH.bridge.destroy();
    H.root.replaceChildren();
    H.cv = null;
    BH.create({
      collaborators: () => ({ suggestionManager, PostedComment: window.PostedComment, escapeHtml: pageState.escapeHtml }),
      onCommentFormSubmit: async (...args) => { submitted.push(args); },
    });
    BH.renderAll([BH.diffEntry(file)]);
    await H.settle(150);
    const b = BH.bridge;
    const comment = { id: 7, file, line_start: line, line_end: line, side: 'RIGHT', body: 'A <b>comment</b>', status: 'active' };
    const suggestion = { id: 11, file, line_start: line, line_end: line, side: 'RIGHT', type: 'bug', title: 'A finding', body: 'Body', status: 'active' };
    b.batch(() => {
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'comment', data: comment, id: 'comment-7' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'suggestion', data: suggestion, id: 'suggestion-11' });
      b.addAnnotation(file, { lineNumber: line + 1, side: 'RIGHT', type: 'comment-form', data: { lineStart: line + 1, lineEnd: line + 1, side: 'RIGHT', initialValue: 'draft' }, id: 'form-1' });
    });
    const commentEl = b.getAnnotationElement(file, 'comment-7');
    const suggestionEl = b.getAnnotationElement(file, 'suggestion-11');
    const formEl = b.getAnnotationElement(file, 'form-1');
    formEl.querySelector('.save-comment-btn').click();
    await H.raf(2);
    return {
      prManagerOnWindow: 'prManager' in window,
      comment: { cls: commentEl.className, id: commentEl.dataset.commentId, connected: commentEl.isConnected, escaped: commentEl.querySelector('.user-comment-body').innerHTML.includes('&lt;b&gt;') },
      suggestion: { cls: suggestionEl.className, id: suggestionEl.dataset.suggestionId, connected: suggestionEl.isConnected },
      form: { cls: formEl.className, value: formEl.querySelector('textarea').value, connected: formEl.isConnected, sameOnLookup: b.getAnnotationElement(file, 'form-1', { create: true }) === formEl },
      submitted: submitted.map(([f, id, data, text]) => [f, id, data.lineStart, text]),
      sound: BH.sound(),
    };
  }, { file, line });
  expect(result.prManagerOnWindow).toBe(false);
  expect(result.comment).toEqual({ cls: 'user-comment-row', id: '7', connected: true, escaped: true });
  expect(result.suggestion.cls).toContain('ai-suggestion');
  expect(result.suggestion).toMatchObject({ id: '11', connected: true });
  expect(result.form).toEqual({ cls: 'pierre-annotation user-comment-form', value: 'draft', connected: true, sameOnLookup: true });
  expect(result.submitted).toEqual([[file, 'form-1', line + 1, 'draft']]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a suggestion whose status changed while its card was untouched shows it at the next draw, and a card the reader re-opened stays open', async ({ harness }) => {
  // The comment-restore scenario (ledger H71): a comment that adopted a
  // suggestion is deleted (the suggestion becomes dismissed, the flow updates
  // the card) and later restored. Restoring reloads the comments and touches
  // no card; the data now says "adopted" while the card still shows
  // "dismissed". The card is corrected by the next draw. Under CodeView every
  // remount is such a draw. The second half is the other rule of H71: state
  // the reader put on a card (an adopted suggestion shown again) is not
  // undone by a draw, because the flow recorded the card as showing its status.
  const page = await openBridge(harness, {
    before: ['/app/js/utils/posted-comment.js', '/app/js/modules/suggestion-manager.js'],
  });
  const { file, line, far } = await up(page);
  const result = await page.evaluate(async ({ file, line, far }) => {
    const { H, BH } = window;
    const pageState = { userComments: [], escapeHtml: (text) => text };
    const suggestionManager = new window.SuggestionManager(pageState);
    BH.bridge.destroy();
    H.root.replaceChildren();
    H.cv = null;
    BH.create({ collaborators: { suggestionManager, PostedComment: window.PostedComment, escapeHtml: pageState.escapeHtml } });
    const names = H.workload.modifiedPaths.filter((n) => n !== H.workload.roles.hugeModified && n !== H.workload.roles.large).slice(0, 30);
    BH.renderAll(names.map((n) => BH.diffEntry(n)));
    await H.settle(150);
    const b = BH.bridge;
    const restored = { id: 21, file, line_start: line, line_end: line, side: 'RIGHT', type: 'bug', title: 'Restored', body: 'x', status: 'dismissed' };
    const reopened = { id: 22, file, line_start: line + 1, line_end: line + 1, side: 'RIGHT', type: 'bug', title: 'Re-opened', body: 'y', status: 'adopted' };
    b.addAnnotations(file, [
      { lineNumber: line, side: 'RIGHT', type: 'suggestion', data: restored, id: 'suggestion-21' },
      { lineNumber: line + 1, side: 'RIGHT', type: 'suggestion', data: reopened, id: 'suggestion-22' },
    ]);
    const restoredCard = b.getAnnotationElement(file, 'suggestion-21');
    const reopenedCard = b.getAnnotationElement(file, 'suggestion-22');
    const state = (card) => ({ collapsed: card.classList.contains('collapsed'), adoption: card.dataset.hiddenForAdoption ?? null });
    const built = { restored: state(restoredCard), reopened: state(reopenedCard) };

    // The reader shows the adopted suggestion again (what restoreSuggestion
    // does to the card), and the flow records the card as showing its status.
    reopenedCard.classList.remove('collapsed');
    suggestionManager.markSuggestionSynced(reopenedCard, reopened);

    // The adopting comment of the other suggestion is restored: data only,
    // and its card annotation is added on the suggestion's own line.
    const comment = { id: 31, file, line_start: line, line_end: line, side: 'RIGHT', body: 'adopted text', parent_id: 21, status: 'active' };
    pageState.userComments.push(comment);
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'comment', data: comment, id: 'comment-31' });
    await H.settle(100);
    const afterRestore = { restored: state(restoredCard), reopened: state(reopenedCard) };

    // Away and back: a remount, which draws every annotation of the file again.
    b.scrollToItem(far);
    await H.settle(300);
    b.scrollToItem(file);
    await H.settle(300);
    return {
      built,
      afterRestore,
      afterRemount: { restored: state(restoredCard), reopened: state(reopenedCard) },
      sameCards: b.getAnnotationElement(file, 'suggestion-21') === restoredCard && b.getAnnotationElement(file, 'suggestion-22') === reopenedCard,
      connected: restoredCard.isConnected && reopenedCard.isConnected,
    };
  }, { file, line, far });
  expect(result.built).toEqual({
    restored: { collapsed: true, adoption: null },
    reopened: { collapsed: true, adoption: 'true' },
  });
  // Adding the restored comment on the suggestion's line draws no other card
  // again: the suggestion keeps showing "dismissed", as on the current engine.
  expect(result.afterRestore).toEqual({
    restored: { collapsed: true, adoption: null },
    reopened: { collapsed: false, adoption: 'true' },
  });
  // The remount is a draw: the restored suggestion now shows "adopted"; the
  // one the reader re-opened is still open.
  expect(result.afterRemount).toEqual({
    restored: { collapsed: true, adoption: 'true' },
    reopened: { collapsed: false, adoption: 'true' },
  });
  expect(result.sameCards).toBe(true);
  expect(result.connected).toBe(true);
});

/**
 * A card on a hidden line of a long file is navigated to the way
 * PRManager._revealSteps does it: the line is revealed (a new diff, which
 * the viewer draws when the highlighter has answered), the pane is taken to
 * the card unless the viewer draws it already, the card is waited for with
 * the default time, and then the browser scrolls to it.
 */
const REVEAL_NAVIGATIONS = [
  { name: 'a file drawn whole that the reveal takes past 5,000 rows, first of thirty-one files', position: 'first', shown: 4995, reveal: [6495, 6505], line: 6500, rows: 5006 },
  { name: 'the same file in the middle of the pane', position: 'middle', shown: 4995, reveal: [6495, 6505], line: 6500, rows: 5006 },
  { name: 'the same file as the last of the pane, the card among the six rows after the block boundary', position: 'last', shown: 4995, reveal: [6495, 6505], line: 6500, rows: 5006 },
  { name: 'the same file as the only one', position: 'only', shown: 4995, reveal: [6495, 6505], line: 6500, rows: 5006 },
  { name: 'a file that was drawn in windows already, a line revealed near its end', position: 'middle', shown: 5010, reveal: [6495, 6505], line: 6500, rows: 5021 },
  // The pane cannot be scrolled beyond its present height: where the file ends the pane, the first target stops at the old diff's end.
  { name: 'a reveal of 3,600 lines at once in the only file, the card far below what the pane\'s height reaches until the new diff is displayed', position: 'only', shown: 3000, reveal: [3001, 6600], line: 6500, rows: 6600, sentAgain: true },
  { name: 'the same reveal in the last of thirty-one files', position: 'last', shown: 3000, reveal: [3001, 6600], line: 6500, rows: 6600, sentAgain: true },
  { name: 'the same reveal with files after it: the pane is high enough for the first target', position: 'middle', shown: 3000, reveal: [3001, 6600], line: 6500, rows: 6600 },
];
for (const v of REVEAL_NAVIGATIONS) {
  test(`navigating to a card on a line that was just revealed in a long file: ${v.name}`, async ({ harness }) => {
    // Hazard H155. Three things have to hold together: the card is not taken
    // as "about to be drawn" when the diff that awaits display is drawn in
    // windows (PierreBridge.drawnRowCount), the rows after a block boundary
    // are drawn when the pane is there (coverPaneWithRowWindow, vendor fact
    // F30), and a target sent while the old diff was on screen is sent again
    // once the new one is (whenAnnotationRendered).
    test.setTimeout(120000);
    const page = await openBridge(harness);
    const result = await page.evaluate(async (v) => {
      const { H, BH } = window;
      const { roles } = H.workload;
      const LONG = 'ctx/long.js';
      const others = v.position === 'only' ? [] : H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 30).map((n) => BH.diffEntry(n));
      const long = BH.contextEntry(LONG, { contents: BH.numberedLines(7000), ranges: [{ startLine: 1, endLine: v.shown }] });
      const entries = v.position === 'first' || v.position === 'only' ? [long, ...others] : v.position === 'last' ? [...others, long] : [...others.slice(0, 15), long, ...others.slice(15)];
      await BH.up({ entries, quietMs: 400 });
      const b = BH.bridge;
      // The reader at the top of the long file.
      b.scrollToItem(LONG);
      await H.until(() => !!H.host(LONG));
      await H.until(() => (H.shape(LONG)?.tokens ?? 0) > 0, 30000);
      await H.settle(400);
      const pane = () => H.root.getBoundingClientRect();
      const lines = () => [...H.host(LONG).shadowRoot.querySelectorAll('[data-content] > [data-line]')].map((row) => Number(row.getAttribute('data-line')));
      const id = 'far-card';
      const out = { rowsBefore: lines().length };
      const scrolls = [];
      const scrollTo = b.codeView.scrollTo.bind(b.codeView);
      b.codeView.scrollTo = (target) => { scrolls.push({ type: target.type, lineNumber: target.lineNumber, displayed: b.isDiffDisplayed(LONG) }); return scrollTo(target); };

      b.addAnnotation(LONG, { lineNumber: v.line, side: 'RIGHT', type: 'card', id, data: { text: 'far.', height: 30 } });
      b.addContextRanges(LONG, [{ startLine: v.reveal[0], endLine: v.reveal[1] }]);
      out.pending = !b.isDiffDisplayed(LONG);
      out.pendingRows = window.PierreBridge.drawnRowCount(b.files.get(LONG).metadata, 'unified');
      if (!b.isElementDrawn(b.getAnnotationElement(LONG, id))) out.sent = b.scrollToAnnotation(LONG, id);
      const element = await b.whenAnnotationRendered(LONG, id);
      out.resolved = element !== null && element === b.getAnnotationElement(LONG, id);
      out.drawnWhenHandedOver = b.isElementDrawn(element);
      out.displayedWhenHandedOver = b.isDiffDisplayed(LONG);
      element?.scrollIntoView({ block: 'center' });
      await H.settle(600);
      const box = element ? element.getBoundingClientRect() : null;
      out.inPane = !!box && box.height === 30 && box.top >= pane().top && box.bottom <= pane().bottom;
      const drawn = lines();
      out.lineDrawn = drawn.includes(v.line);
      out.lastLineDrawn = drawn.includes(v.reveal[1]);
      out.scrolls = scrolls;
      out.sound = BH.sound();
      return out;
    }, v);
    expect(result.rowsBefore).toBe(Math.min(v.shown, 5000));
    expect(result.pending).toBe(true);
    expect(result.pendingRows).toBe(v.rows);
    expect(result.sent).toBe(true);
    // The card is handed over when the viewer draws it, which is after the new diff is displayed.
    expect(result).toMatchObject({ resolved: true, drawnWhenHandedOver: true, displayedWhenHandedOver: true });
    expect(result).toMatchObject({ inPane: true, lineDrawn: true, lastLineDrawn: true });
    // One line target while the old diff was on screen; a second one, after
    // the display, only where the first could not reach the line.
    const target = { type: 'line', lineNumber: v.line };
    expect(result.scrolls[0]).toEqual({ ...target, displayed: false });
    expect(result.scrolls.slice(1)).toEqual(v.sentAgain ? [{ ...target, displayed: true }] : []);
    expect(result.sound).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}
