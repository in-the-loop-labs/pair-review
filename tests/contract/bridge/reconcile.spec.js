// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: reconcile, the second of the bridge's two list writers.
 * A context file is added or removed at run time, in the middle of the list,
 * which the viewer cannot do by itself: the list is replaced and everything
 * the reader had is put back.
 */

import { test, expect, openBridge, clickExpandControl, readingInTheMiddle } from './bridge-test.js';

const CONTEXT = 'ctx/added-at-run-time.js';
const RANGES = [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }];

for (const [where, index] of [['above', 3], ['directly above', null], ['below', 22]]) {
  test(`a context file added ${where} the file being read, and removed again, moves the line being read by 0 px`, async ({ harness }) => {
    const page = await openBridge(harness);
    const { readingIndex } = await readingInTheMiddle(page);
    const result = await page.evaluate(async ({ CONTEXT, index }) => {
      const { H, BH, T } = window;
      const b = BH.bridge;
      const added = b.reconcile(T.withContext(index));
      const afterAdd = { movedSync: T.moved(), order: [...b.files.keys()] };
      await H.settle(300);
      afterAdd.moved = T.moved();
      afterAdd.sound = BH.sound();
      afterAdd.kind = b.files.get(CONTEXT).kind;

      const removed = b.reconcile(T.entries);
      const afterRemove = { movedSync: T.moved(), has: b.files.has(CONTEXT), order: [...b.files.keys()] };
      await H.settle(300);
      afterRemove.moved = T.moved();
      afterRemove.sound = BH.sound();
      return { added, removed, afterAdd, afterRemove, names: T.names };
    }, { CONTEXT, index: index ?? readingIndex });

    const position = index ?? readingIndex;
    expect(result.added).toEqual({ applied: true, created: [CONTEXT], removed: [], updated: [], listWritten: true });
    expect(result.afterAdd.order[position]).toBe(CONTEXT);
    expect(result.afterAdd.order).toHaveLength(31);
    expect(result.afterAdd.kind).toBe('context');
    expect(result.afterAdd.movedSync).toBe(0);
    expect(result.afterAdd.moved).toBe(0);
    expect(result.afterAdd.sound).toEqual({ orphans: 0, clean: true });
    expect(result.removed).toEqual({ applied: true, created: [], removed: [CONTEXT], updated: [], listWritten: true });
    expect(result.afterRemove.has).toBe(false);
    expect(result.afterRemove.order).toEqual(result.names);
    expect(result.afterRemove.movedSync).toBe(0);
    expect(result.afterRemove.moved).toBe(0);
    expect(result.afterRemove.sound).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

test('with the ids unchanged no list is written: new ranges and new contents are published on the same item', async ({ harness }) => {
  const page = await openBridge(harness);
  await readingInTheMiddle(page);
  const result = await page.evaluate(async ({ CONTEXT }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    b.reconcile(T.withContext(0));
    b.scrollToItem(CONTEXT);
    await H.settle(300);
    const cv = b.codeView;
    const originalSetItems = cv.setItems.bind(cv);
    let setItemsCalls = 0;
    cv.setItems = (items) => { setItemsCalls++; return originalSetItems(items); };
    const record = b.files.get(CONTEXT);
    const instance = record._instance;
    const out = { before: { runs: BH.lineRuns(CONTEXT), key: record.metadata.cacheKey, baseKey: record.baseKey } };

    // The same entries again: nothing to do.
    out.same = b.reconcile(T.withContext(0));
    out.afterSame = { calls: setItemsCalls, key: record.metadata.cacheKey };

    // The ranges of the file changed (a range was extended, another added).
    out.ranges = b.reconcile(T.withContext(0, { ranges: [{ startLine: 100, endLine: 140 }, { startLine: 200, endLine: 205 }, { startLine: 300, endLine: 310 }] }));
    out.afterRanges = { calls: setItemsCalls, sameRecord: b.files.get(CONTEXT) === record, sameInstance: record._instance === instance, visible: [140, 202, 150].map((n) => b.isLineVisible(CONTEXT, n, 'RIGHT')), keyChanged: record.metadata.cacheKey !== out.before.key };
    await BH.displayed(CONTEXT);
    await H.settle(200);
    out.afterRanges.runs = BH.lineRuns(CONTEXT).slice(0, 2);
    const keyAfterRanges = record.metadata.cacheKey;

    // The file's contents changed (new commits): a new base under a new key.
    out.contents = b.reconcile(T.withContext(0, { contents: BH.numberedLines(400, 'changed'), contentsSeq: 2 }));
    out.afterContents = { calls: setItemsCalls, sameRecord: b.files.get(CONTEXT) === record, baseKeyChanged: record.baseKey !== out.before.baseKey, keyChanged: record.metadata.cacheKey !== keyAfterRanges };
    await BH.displayed(CONTEXT);
    await H.settle(200);
    out.afterContents.runs = BH.lineRuns(CONTEXT);
    out.afterContents.text = BH.rows(CONTEXT)[0].text;
    out.sound = BH.sound();
    cv.setItems = originalSetItems;
    return out;
  }, { CONTEXT });
  const none = { applied: true, created: [], removed: [], listWritten: false };
  expect(result.same).toEqual({ ...none, updated: [] });
  expect(result.afterSame.calls).toBe(0);
  expect(result.afterSame.key).toBe(result.before.key);
  expect(result.ranges).toEqual({ ...none, updated: [CONTEXT] });
  // (The item is taller than the pane now: its last range is below the rows the viewer has mounted.)
  expect(result.afterRanges).toEqual({ calls: 0, sameRecord: true, sameInstance: true, visible: [true, true, false], keyChanged: true, runs: [[100, 140], [200, 205]] });
  expect(result.contents).toEqual({ ...none, updated: [CONTEXT] });
  expect(result.afterContents).toMatchObject({ calls: 0, sameRecord: true, baseKeyChanged: true, keyChanged: true, runs: [[100, 120], [300, 310]] });
  expect(result.afterContents.text).toContain('changed100');
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a kept record keeps its annotations, their elements, its revealed ranges and its collapsed state; a removed record takes its annotations with it', async ({ harness }) => {
  const page = await openBridge(harness);
  await readingInTheMiddle(page, { upgrade: true });
  const result = await page.evaluate(async ({ CONTEXT }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    b.reconcile(T.withContext(0));
    const kept = T.reading;
    const other = T.names[2];
    const keptRecord = b.files.get(kept);
    const hunks = keptRecord.metadata.hunks;
    const last = hunks[hunks.length - 1];
    const revealedLine = last.additionStart + last.additionCount + 10;
    b.addContextRanges(kept, [{ startLine: revealedLine, endLine: revealedLine + 1 }]);
    b.addAnnotation(kept, { lineNumber: T.line.n, side: 'RIGHT', type: 'card', data: { text: 'kept card' }, id: 'card-kept' });
    b.addAnnotation(CONTEXT, { lineNumber: 105, side: 'RIGHT', type: 'card', data: { text: 'context card' }, id: 'card-context' });
    b.addContextRanges(CONTEXT, [{ startLine: 200, endLine: 204 }]);
    b.setCollapsed(other, true);
    await BH.displayed(kept);
    await H.settle(200);
    const keptCard = b.getAnnotationElement(kept, 'card-kept');
    const contextCard = b.getAnnotationElement(CONTEXT, 'card-context', { create: true });
    const zone = BH.zones.get(kept);
    const header = BH.headers.get(kept);
    const metadata = keptRecord.metadata;
    const builds = BH.cardBuilds;

    // Another context file arrives: the list is replaced.
    const next = T.withContext(0);
    next.splice(10, 0, BH.contextEntry('ctx/second.js', { contents: BH.numberedLines(50), ranges: [{ startLine: 1, endLine: 20 }] }));
    const added = b.reconcile(next);
    await H.settle(300);
    const afterAdd = {
      sameRecord: b.files.get(kept) === keptRecord,
      sameMetadata: keptRecord.metadata === metadata,
      sameCard: b.getAnnotationElement(kept, 'card-kept') === keptCard,
      cardConnected: keptCard.isConnected,
      sameZone: BH.zones.get(kept) === zone && zone.isConnected,
      sameHeader: BH.headers.get(kept) === header && header.isConnected,
      builds: BH.cardBuilds - builds,
      revealed: b.isLineVisible(kept, revealedLine, 'RIGHT'),
      collapsed: b.files.get(other).collapsed,
      contextRevealed: b.isLineVisible(CONTEXT, 202, 'RIGHT'),
      contextCard: b.getAnnotationElement(CONTEXT, 'card-context') === contextCard,
    };

    // The first context file is dismissed.
    const removed = b.reconcile(next.filter((entry) => entry.id !== CONTEXT));
    await H.settle(300);
    return {
      added: added.listWritten, removed: removed.removed, afterAdd,
      afterRemove: {
        has: b.files.has(CONTEXT),
        element: b.getAnnotationElement(CONTEXT, 'card-context', { create: true }),
        annotations: b.getAnnotations(CONTEXT),
        file: b.findAnnotationFile('card-context'),
        cardConnected: contextCard.isConnected,
        visible: b.isLineVisible(CONTEXT, 105, 'RIGHT'),
        keptCardStill: b.getAnnotationElement(kept, 'card-kept') === keptCard && keptCard.isConnected,
      },
      sound: BH.sound(),
    };
  }, { CONTEXT });
  expect(result.added).toBe(true);
  expect(result.afterAdd).toEqual({
    sameRecord: true, sameMetadata: true, sameCard: true, cardConnected: true, sameZone: true, sameHeader: true,
    builds: 0, revealed: true, collapsed: true, contextRevealed: true, contextCard: true,
  });
  expect(result.removed).toEqual([CONTEXT]);
  expect(result.afterRemove).toEqual({ has: false, element: null, annotations: [], file: null, cardConnected: false, visible: false, keptCardStill: true });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a list replace gives back the focused textarea with its text and caret, the line selection, and the hovered row', async ({ harness }) => {
  const page = await openBridge(harness);
  const { reading, line } = await readingInTheMiddle(page);
  const hoverPoint = await page.evaluate(async () => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    // Lines of the file being read that are on screen now, on the new side.
    const shown = [...H.host(T.reading).shadowRoot.querySelectorAll('[data-content] > [data-line]')]
      .filter((row) => row.getAttribute('data-line-type') !== 'change-deletion' && H.viewportTopOf(row) >= 60 && H.viewportTopOf(row) < 500)
      .map((row) => Number(row.getAttribute('data-line')));
    const [hoverLine, formLine, selectFrom, selectTo] = [shown[1], shown[2], shown[4], shown[5]];
    b.addAnnotation(T.reading, { lineNumber: formLine, side: 'RIGHT', type: 'card', data: { text: 'form', textarea: true }, id: 'card-form' });
    await H.settle(150);
    b.selectLines(T.reading, selectFrom, selectTo, 'RIGHT');
    await H.settle(100);
    const textarea = b.getAnnotationElement(T.reading, 'card-form').querySelector('textarea');
    textarea.focus();
    textarea.value = 'a comment being typed';
    textarea.setSelectionRange(4, 9);
    const row = H.findRow(T.reading, hoverLine, 'additions');
    const box = row.getBoundingClientRect();
    return { x: Math.round(box.left + 300), y: Math.round(box.top + box.height / 2), hoverLine, selectFrom, selectTo };
  });
  await page.mouse.move(hoverPoint.x, hoverPoint.y - 3);
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await page.evaluate(() => window.H.raf(3));

  const result = await page.evaluate(async ({ hoverLine }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    const textarea = b.getAnnotationElement(T.reading, 'card-form').querySelector('textarea');
    const hoveredDom = () => { const row = b.findFileElement(T.reading)?.shadowRoot.querySelector('[data-content] > [data-hovered]'); return row ? Number(row.getAttribute('data-line')) : null; };
    const gutterShown = () => { const slot = b.findFileElement(T.reading)?.querySelector('[slot="gutter-utility-slot"]'); const el = slot?.firstElementChild; return !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const before = { focused: document.activeElement === textarea, hovered: b.getHoveredRow(T.reading), hoveredDom: hoveredDom(), gutter: gutterShown(), selection: b.getLineSelection(T.reading) };
    const instanceBefore = b.files.get(T.reading)._instance;

    b.reconcile(T.withContext(3));
    const sameTask = {
      movedSync: T.moved(),
      focused: document.activeElement === textarea,
      connected: textarea.isConnected,
      value: textarea.value,
      caret: [textarea.selectionStart, textarea.selectionEnd],
      selection: b.getLineSelection(T.reading),
    };
    await H.settle(300);
    return {
      before, sameTask,
      newInstance: b.files.get(T.reading)._instance !== instanceBefore,
      after: { moved: T.moved(), focused: document.activeElement === textarea, hovered: b.getHoveredRow(T.reading), hoveredDom: hoveredDom(), gutter: gutterShown(), selection: b.getLineSelection(T.reading) },
      hoverLine,
      sound: BH.sound(),
    };
  }, hoverPoint);
  const selection = { start: hoverPoint.selectFrom, end: hoverPoint.selectTo, side: 'RIGHT' };
  expect(line.n).toBeGreaterThan(0);
  // With a line selection in place the viewer keeps its gutter utility on the
  // selection's last line, and that is the line its getter answers; the row
  // under the pointer keeps the hover mark.
  const utilityLine = { lineNumber: hoverPoint.selectTo, side: 'RIGHT' };
  expect(result.before).toEqual({ focused: true, hovered: utilityLine, hoveredDom: result.hoverLine, gutter: true, selection });
  expect(result.sameTask).toEqual({ movedSync: 0, focused: true, connected: true, value: 'a comment being typed', caret: [4, 9], selection });
  // The viewer made new instances: what is there afterwards was put back.
  expect(result.newInstance).toBe(true);
  expect(result.after).toEqual({ moved: 0, focused: true, hovered: utilityLine, hoveredDom: result.hoverLine, gutter: true, selection });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(reading).toBeTruthy();
});

test('lines the reader expanded by hand are still shown after a list replace, and a file without any is drawn highlighted in the same task', async ({ harness }) => {
  const page = await openBridge(harness);
  const { reading, names } = await readingInTheMiddle(page, { upgrade: true });
  // Wait until what is on screen is highlighted, so "tokens in the same task" means something.
  await page.evaluate(async () => {
    const { H, BH, T } = window;
    await BH.displayed(T.reading);
    await H.until(() => (H.shape(T.reading)?.tokens ?? 0) > 0, 8000);
    await H.settle(200);
    // The reading position after the upgrade's layout settled.
    const firstRow = [...H.host(T.reading).shadowRoot.querySelectorAll('[data-content] > [data-line]')].find((row) => H.viewportTopOf(row) >= 40);
    T.line = { n: Number(firstRow.getAttribute('data-line')), side: firstRow.getAttribute('data-line-type') === 'change-deletion' ? 'deletions' : 'additions', top: H.viewportTopOf(firstRow) };
    T.moved = () => { const row = H.findRow(T.reading, T.line.n, T.line.side); return row ? H.viewportTopOf(row) - T.line.top : null; };
  });
  // The reader expands the gap after the last hunk of the file below the one being read.
  const expandedFile = names[names.indexOf(reading) + 1];
  const gapIndex = await page.evaluate((id) => window.BH.bridge.files.get(id).metadata.hunks.length, expandedFile);
  const box = await clickExpandControl(page, expandedFile, gapIndex, 'up');
  expect(box && box.visible, JSON.stringify(box)).toBe(true);

  const result = await page.evaluate(async ({ expandedFile }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    const record = b.files.get(expandedFile);
    const hunks = record.metadata.hunks;
    const last = hunks[hunks.length - 1];
    const firstExpanded = last.additionStart + last.additionCount;
    // A file on screen that nobody expanded, drawn highlighted.
    const untouchedId = H.mounted().find((id) => id !== expandedFile && (H.shape(id)?.tokens ?? 0) > 0);
    const untouched = b.files.get(untouchedId);
    const before = {
      visible: [firstExpanded, firstExpanded + 19, firstExpanded + 20].map((n) => b.isLineVisible(expandedFile, n, 'RIGHT')),
      mapSize: record._instance.hunksRenderer.expandedHunks.size,
      key: record.metadata.cacheKey,
      untouchedKey: untouched.metadata.cacheKey,
      revealed: record.contextRanges.length,
    };
    b.reconcile(T.withContext(3));
    const sameTask = {
      untouchedFound: !!untouchedId,
      untouchedTokens: H.shape(untouchedId)?.tokens ?? 0,
      visible: [firstExpanded, firstExpanded + 19, firstExpanded + 20].map((n) => b.isLineVisible(expandedFile, n, 'RIGHT')),
      keyChanged: record.metadata.cacheKey !== before.key,
      untouchedKeySame: untouched.metadata.cacheKey === before.untouchedKey,
      revealed: record.contextRanges,
    };
    b.scrollToLine(expandedFile, firstExpanded + 10, 'RIGHT', { behavior: 'instant' });
    const displayed = await b.whenLineDisplayed(expandedFile, firstExpanded + 10, 'RIGHT', { timeoutMs: 8000 });
    await H.settle(250);
    return {
      before, sameTask, displayed, firstExpanded,
      rowsOnScreen: [firstExpanded, firstExpanded + 19].map((n) => !!H.findRow(expandedFile, n, 'additions')),
      mapSizeAfter: record._instance.hunksRenderer.expandedHunks.size,
      sound: BH.sound(),
    };
  }, { expandedFile });
  expect(result.before.visible).toEqual([true, true, false]);
  expect(result.before.mapSize).toBe(1);
  expect(result.before.revealed).toBe(0);
  // Folded into the file's revealed ranges, under a new key; the file nobody touched keeps its diff and its key.
  expect(result.sameTask.visible).toEqual([true, true, false]);
  expect(result.sameTask.keyChanged).toBe(true);
  expect(result.sameTask.untouchedKeySame).toBe(true);
  expect(result.sameTask.revealed).toEqual([{ startLine: result.firstExpanded, endLine: result.firstExpanded + 19 }]);
  expect(result.sameTask.untouchedFound).toBe(true);
  expect(result.sameTask.untouchedTokens).toBeGreaterThan(0);
  expect(result.displayed).toBe(true);
  expect(result.rowsOnScreen).toEqual([true, true]);
  expect(result.mapSizeAfter).toBe(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('reconcile while another file\'s new diff awaits display ends with the entries\' state and that diff on screen', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async ({ CONTEXT }) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const entries = [BH.diffEntry(roles.small), BH.diffEntry(roles.large), BH.diffEntry(roles.medium)];
    await BH.up({ entries });
    const b = BH.bridge;
    const id = roles.large;
    b.scrollToItem(id);
    await H.settle(200);
    const { oldFile, newFile } = H.contentsOf(id);
    b.upgradeFileContents(id, oldFile, newFile);
    const pending = !b.isDiffDisplayed(id);
    const next = entries.slice();
    next.splice(0, 0, BH.contextEntry(CONTEXT, { contents: BH.numberedLines(400), ranges: [{ startLine: 100, endLine: 120 }] }));
    const outcome = b.reconcile(next);
    const displayed = await BH.displayed(id, 15000);
    await H.settle(300);
    return {
      pending, outcome: outcome.applied && outcome.listWritten,
      order: [...b.files.keys()],
      expected: next.map((e) => e.id),
      displayed: displayed.ok,
      upgraded: b.files.get(id).upgraded && !b.files.get(id).metadata.isPartial,
      expandButtons: H.shape(id).expandButtons,
      sound: BH.sound(),
    };
  }, { CONTEXT });
  expect(result.pending).toBe(true);
  expect(result.outcome).toBe(true);
  expect(result.order).toEqual(result.expected);
  expect(result.displayed).toBe(true);
  expect(result.upgraded).toBe(true);
  expect(result.expandButtons).toBeGreaterThan(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('reconcile before the worker pool is ready ends with the entries\' state', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async ({ CONTEXT }) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const entries = [BH.diffEntry(roles.small), BH.diffEntry(roles.medium), BH.diffEntry(roles.added)];
    BH.create();
    BH.renderAll(entries);
    const b = BH.bridge;
    // Same task as the first list: the pool has not started, nothing is mounted.
    const poolReady = b.workerManager.isInitialized();
    const mountedBefore = H.mounted().length;
    const next = entries.slice();
    next.splice(1, 0, BH.contextEntry(CONTEXT, { contents: BH.numberedLines(400), ranges: [{ startLine: 100, endLine: 120 }] }));
    const outcome = b.reconcile(next);
    await H.settle(300, 15000);
    return {
      poolReady, mountedBefore, outcome,
      order: [...b.files.keys()],
      expected: next.map((e) => e.id),
      mounted: H.mounted(),
      runs: BH.lineRuns(CONTEXT),
      sound: BH.sound(),
    };
  }, { CONTEXT });
  expect(result.poolReady).toBe(false);
  expect(result.mountedBefore).toBe(0);
  expect(result.outcome).toMatchObject({ applied: true, created: [CONTEXT], listWritten: true });
  expect(result.order).toEqual(result.expected);
  expect(result.mounted).toEqual(expect.arrayContaining([CONTEXT]));
  expect(result.runs).toEqual([[100, 120]]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('reconcile refuses entries made for another diff, does nothing before the first list, and takes a function', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async ({ CONTEXT }) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const entries = [BH.diffEntry(roles.small), BH.diffEntry(roles.medium)];
    BH.create();
    const b = BH.bridge;
    const out = { beforeFirstList: b.reconcile(entries) };
    BH.renderAll(entries);
    await H.settle(200);
    const context = BH.contextEntry(CONTEXT, { contents: BH.numberedLines(60), ranges: [{ startLine: 1, endLine: 10 }] });
    // The changed files of the entries are not the changed files of the pane.
    out.otherDiff = b.reconcile([BH.diffEntry(roles.small), context, BH.diffEntry(roles.added)]);
    out.reordered = b.reconcile([BH.diffEntry(roles.medium), BH.diffEntry(roles.small), context]);
    out.fewer = b.reconcile([BH.diffEntry(roles.small), context]);
    out.notAList = b.reconcile(null);
    out.untouched = [...b.files.keys()];
    out.fromFunction = b.reconcile(() => [entries[0], context, entries[1]]);
    out.order = [...b.files.keys()];
    await H.settle(200);
    out.sound = BH.sound();
    return out;
  }, { CONTEXT });
  const refused = (reason) => ({ applied: false, created: [], removed: [], updated: [], listWritten: false, reason });
  expect(result.beforeFirstList).toEqual(refused('not-rendered'));
  expect(result.otherDiff).toEqual(refused('stale-entries'));
  expect(result.reordered).toEqual(refused('stale-entries'));
  expect(result.fewer).toEqual(refused('stale-entries'));
  expect(result.notAList).toEqual(refused('no-list'));
  expect(result.untouched).toHaveLength(2);
  expect(result.fromFunction).toMatchObject({ applied: true, created: [CONTEXT], listWritten: true });
  expect(result.order[1]).toBe(CONTEXT);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a reconcile the reader did not ask for waits for a pointer button to come up and for a held navigation', async ({ harness }) => {
  const page = await openBridge(harness);
  const { reading, line } = await readingInTheMiddle(page);
  const point = await page.evaluate(() => {
    const { H, T } = window;
    const box = H.findRow(T.reading, T.line.n + 1, T.line.side).getBoundingClientRect();
    return { x: Math.round(box.left + 300), y: Math.round(box.top + box.height / 2) };
  });
  // A text selection in progress: the button is down on the pane.
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  const during = await page.evaluate(({ CONTEXT }) => {
    const { BH, T } = window;
    const b = BH.bridge;
    const first = b.reconcile(() => T.withContext(3), { whenIdle: true });
    // A later request replaces the waiting one.
    const second = b.reconcile(() => T.withContext(5), { whenIdle: true });
    return { first, second, has: b.files.has(CONTEXT) };
  }, { CONTEXT });
  await page.mouse.up();
  const afterUp = await page.evaluate(async ({ CONTEXT }) => {
    const { H, BH, T } = window;
    await H.settle(250);
    const b = BH.bridge;
    const out = { index: [...b.files.keys()].indexOf(CONTEXT), moved: T.moved() };
    // A navigation holds list writes: the same wait.
    const release = b.holdListWrites();
    out.held = b.reconcile(T.entries, { whenIdle: true });
    out.stillThere = b.files.has(CONTEXT);
    // Asked for by the reader (no whenIdle): runs at once, hold or not.
    out.direct = b.reconcile(T.withContext(7)).applied;
    out.directIndex = [...b.files.keys()].indexOf(CONTEXT);
    release();
    release();
    out.afterRelease = b.files.has(CONTEXT);
    await H.settle(250);
    out.sound = BH.sound();
    return out;
  }, { CONTEXT });
  const deferred = { applied: false, created: [], removed: [], updated: [], listWritten: false, deferred: true };
  expect(during).toEqual({ first: deferred, second: deferred, has: false });
  expect(afterUp.index).toBe(5);
  expect(afterUp.moved).toBe(0);
  expect(afterUp.held).toEqual(deferred);
  expect(afterUp.stillThere).toBe(true);
  expect(afterUp.direct).toBe(true);
  expect(afterUp.directIndex).toBe(7);
  // The direct call superseded the waiting one: releasing the hold runs nothing stale.
  expect(afterUp.afterRelease).toBe(true);
  expect(afterUp.sound).toEqual({ orphans: 0, clean: true });
  expect(reading && line).toBeTruthy();
});
