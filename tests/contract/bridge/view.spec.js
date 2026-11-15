// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: the file-comment zone, collapse, layout and theme
 * changes, scroll targets, notice items, and a worker that does not start.
 */

import { test, expect, openBridge } from './bridge-test.js';

test('the file-comment zone costs 0 px when empty, and the extent follows it when it grows and shrinks', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const ids = [roles.small, roles.deleted, roles.binary, roles.medium];
    await BH.up({ entries: ids.map((id) => BH.diffEntry(id)) });
    const b = BH.bridge;
    const out = {};
    for (const id of ids) {
      b.scrollToItem(id);
      await H.settle(150);
      const zone = BH.zones.get(id);
      const empty = { connected: zone.isConnected, height: zone.getBoundingClientRect().height, slot: zone.closest('[data-annotation-slot]').getAttribute('slot'), itemHeight: H.itemHeight(id), extent: H.root.scrollHeight };
      // What FileCommentManager does: a card appears inside the zone element.
      const card = document.createElement('div');
      card.style.cssText = 'height: 80px; margin: 0;';
      zone.appendChild(card);
      await H.settle(200);
      const filled = { itemHeight: H.itemHeight(id), extent: H.root.scrollHeight, sound: BH.sound() };
      card.remove();
      await H.settle(200);
      out[id] = { empty, grewBy: [filled.itemHeight - empty.itemHeight, filled.extent - empty.extent], filledSound: filled.sound, backTo: [H.itemHeight(id) - empty.itemHeight, H.root.scrollHeight - empty.extent] };
    }
    out.sound = BH.sound();
    out.roles = roles;
    return out;
  });
  const { roles } = result;
  for (const id of [roles.small, roles.deleted, roles.binary, roles.medium]) {
    expect(result[id].empty.connected, id).toBe(true);
    expect(result[id].empty.height, id).toBe(0);
    expect(result[id].grewBy, id).toEqual([80, 80]);
    expect(result[id].filledSound, id).toEqual({ orphans: 0, clean: true });
    expect(result[id].backTo, id).toEqual([0, 0]);
  }
  // On the side the vendor lays out for the file.
  expect(result[roles.deleted].empty.slot).toBe('annotation-deletions-0');
  expect(result[roles.small].empty.slot).toBe('annotation-additions-0');
  // A file without rows: the zone is all there is under the header.
  expect(result[roles.binary].empty.itemHeight).toBe(40);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a file\'s status decides the zone\'s side when the patch does not say the file was deleted', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    // A patch as the GitHub API gives it: hunks only, no header.
    const bare = H.workload.patches[roles.deleted].slice(H.workload.patches[roles.deleted].indexOf('@@'));
    await BH.up({ entries: [
      { id: 'api/removed.js', kind: 'diff', patch: bare, status: 'removed' },
      { id: 'api/deleted.js', kind: 'diff', patch: bare, status: 'deleted' },
      { id: 'api/unknown-status.js', kind: 'diff', patch: bare },
      BH.diffEntry(roles.deleted, { status: null }),
    ] });
    const side = (id) => BH.bridge.codeView.getItem(id).annotations[0].side;
    return {
      parsedType: BH.bridge.files.get('api/removed.js').patchMetadata.type,
      sides: ['api/removed.js', 'api/deleted.js', 'api/unknown-status.js', roles.deleted].map(side),
      zoneAttached: BH.zones.get('api/removed.js').isConnected,
      sound: BH.sound(),
    };
  });
  // Without the header the vendor cannot tell: the status does.
  expect(result.parsedType).not.toBe('deleted');
  expect(result.sides).toEqual(['deletions', 'deletions', 'additions', 'deletions']);
  expect(result.zoneAttached).toBe(true);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('in split layout a zone and a lone card span both columns, on changed, added and deleted files', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const ids = [roles.small, roles.added, roles.deleted];
    await BH.up({ entries: ids.map((id) => BH.diffEntry(id)), options: { diffStyle: 'split' } });
    const b = BH.bridge;
    const out = {};
    for (const id of ids) {
      b.scrollToItem(id);
      await H.settle(150);
      const hunk = b.files.get(id).metadata.hunks[0];
      const deleted = id === roles.deleted;
      b.addAnnotation(id, { lineNumber: (deleted ? hunk.deletionStart : hunk.additionStart) + 1, side: deleted ? 'LEFT' : 'RIGHT', type: 'card', data: { text: 'card' }, id: `card-${id}` });
      BH.zones.get(id).style.height = '30px';
      await H.settle(250);
      const host = b.findFileElement(id).getBoundingClientRect();
      const cell = (el) => { const box = el.closest('[data-annotation-slot]').getBoundingClientRect(); return { right: Math.round(host.right - box.right), width: Math.round(box.width) }; };
      out[id] = { hostWidth: Math.round(host.width), zone: cell(BH.zones.get(id)), card: cell(b.getAnnotationElement(id, `card-${id}`)), sound: BH.sound() };
    }
    return { out, ids };
  });
  for (const id of result.ids) {
    const info = result.out[id];
    // More than half the host: across the seam, to the right edge.
    expect(info.zone.width, id).toBeGreaterThan(info.hostWidth * 0.9);
    expect(info.card.width, id).toBeGreaterThan(info.hostWidth * 0.9);
    // To the right edge, give or take the 1 px seam borders of the two halves.
    expect(info.zone.right, id).toBeLessThanOrEqual(2);
    expect(info.card.right, id).toBeLessThanOrEqual(2);
    expect(info.sound, id).toEqual({ orphans: 0, clean: true });
  }
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('setCollapsed, setDiffStyle and setTheme keep the cards; layout and theme changes keep a focused textarea', async ({ harness }) => {
  const page = await openBridge(harness);
  const setup = await page.evaluate(async () => {
    const { H, BH } = window;
    const names = H.workload.modifiedPaths.slice(0, 20);
    await BH.up({ entries: names.map((n) => BH.diffEntry(n)) });
    const b = BH.bridge;
    const id = names[9];
    const line = b.files.get(id).metadata.hunks[0].additionStart + 1;
    b.addAnnotation(id, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'form', textarea: true }, id: 'card-form' });
    b.scrollToLine(id, line, 'RIGHT', { behavior: 'instant', flash: false });
    await H.settle(250);
    return { id, line };
  });
  await page.locator('.card textarea').click();
  await page.keyboard.type('draft');

  const result = await page.evaluate(async ({ id, line }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const card = b.getAnnotationElement(id, 'card-form');
    const textarea = card.querySelector('textarea');
    const header = BH.headers.get(id);
    const rowTop = () => { const row = [...H.host(id).shadowRoot.querySelectorAll('[data-content] > [data-line]')].find((r) => r.getAttribute('data-line') === String(anchor.n) && r.getAttribute('data-line-type') === anchor.type); return row ? H.viewportTopOf(row) : null; };
    const first = [...H.host(id).shadowRoot.querySelectorAll('[data-content] > [data-line]')].find((row) => H.viewportTopOf(row) >= 40);
    const anchor = { n: Number(first.getAttribute('data-line')), type: first.getAttribute('data-line-type') };
    const top0 = rowTop();
    const builds = BH.cardBuilds;
    const state = () => ({
      sameCard: b.getAnnotationElement(id, 'card-form') === card && card.isConnected,
      value: textarea.value,
      focused: document.activeElement === textarea,
      sameHeader: BH.headers.get(id) === header && header.isConnected,
      anchorMoved: rowTop() - top0,
      diffType: H.shape(id).diffType,
      colorScheme: getComputedStyle(H.host(id)).colorScheme,
      sound: BH.sound(),
    });
    const out = { start: state() };
    out.splitReturned = b.setDiffStyle('split');
    await H.settle(250);
    out.split = state();
    b.setTheme('dark');
    await H.settle(250);
    out.dark = state();
    out.invalid = b.setDiffStyle('sideways');
    out.unifiedReturned = b.setDiffStyle('unified');
    b.setTheme('light');
    await H.settle(250);
    out.back = state();
    out.style = [b.diffStyle, b.theme];

    // Collapse: the code and its cards go; expand: the same card comes back.
    out.collapsedReturned = b.setCollapsed(id, true);
    await H.settle(200);
    out.collapsed = { classes: BH.hostInfo(id).classes, rows: BH.rows(id).length, cardConnected: card.isConnected, zoneConnected: BH.zones.get(id).isConnected, height: Math.round(b.findFileElement(id).getBoundingClientRect().height), held: b.hasAnnotation(id, 'card-form') };
    b.setCollapsed(id, false);
    await H.settle(200);
    out.expanded = { classes: BH.hostInfo(id).classes, sameCard: b.getAnnotationElement(id, 'card-form') === card && card.isConnected, value: textarea.value, rows: BH.rows(id).length > 0 };
    out.unknown = b.setCollapsed('nope.js', true);
    out.builds = BH.cardBuilds - builds;
    out.sound = BH.sound();
    return out;
  }, setup);
  expect(result.start).toMatchObject({ sameCard: true, value: 'draft', focused: true, diffType: 'single', colorScheme: 'light' });
  expect(result.splitReturned).toBe(true);
  // The viewer keeps the first visible line where it was.
  expect(result.split).toMatchObject({ sameCard: true, value: 'draft', focused: true, sameHeader: true, anchorMoved: 0, diffType: 'split', sound: { orphans: 0, clean: true } });
  expect(result.dark).toMatchObject({ sameCard: true, value: 'draft', focused: true, sameHeader: true, anchorMoved: 0, colorScheme: 'dark', sound: { orphans: 0, clean: true } });
  expect(result.invalid).toBe(false);
  expect(result.unifiedReturned).toBe(true);
  expect(result.back).toMatchObject({ sameCard: true, value: 'draft', focused: true, diffType: 'single', colorScheme: 'light', sound: { orphans: 0, clean: true } });
  expect(result.style).toEqual(['unified', 'light']);
  expect(result.collapsedReturned).toBe(true);
  expect(result.collapsed).toEqual({ classes: ['collapsed', 'd2h-file-wrapper'], rows: 0, cardConnected: false, zoneConnected: false, height: 40, held: true });
  expect(result.expanded).toEqual({ classes: ['d2h-file-wrapper'], sameCard: true, value: 'draft', rows: true });
  expect(result.unknown).toBe(false);
  expect(result.builds).toBe(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('scrollToItem and scrollToLine land on a file that was never mounted, and on a file the reader collapsed nothing is scrolled to', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const names = H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 30);
    await BH.up({ entries: names.map((n) => BH.diffEntry(n)) });
    const b = BH.bridge;
    const out = {};
    const far = names[24];
    out.everMounted = BH.lifecycle.some((e) => e.id === far);
    out.itemReturned = b.scrollToItem(far);
    await H.settle(300);
    out.headerTop = H.viewportTopOf(b.findFileElement(far));

    const other = names[18];
    const hunks = b.files.get(other).metadata.hunks;
    const line = hunks[hunks.length - 1].additionStart + 1;
    out.lineReturned = b.scrollToLine(other, line, 'RIGHT', { behavior: 'instant', align: 'start' });
    await H.settle(300);
    const row = H.findRow(other, line, 'additions');
    // A line target with align 'start' lands the row right under the sticky header.
    out.rowTop = row ? H.viewportTopOf(row) : null;
    out.flashed = !!row && row.classList.contains('pierre-line-highlight');

    // Deletion side, old numbering.
    const withDeletion = names.find((n) => b.files.get(n).metadata.hunks.some((h) => h.deletionLines > 0));
    const hunk = b.files.get(withDeletion).metadata.hunks.find((h) => h.deletionLines > 0);
    const segment = hunk.hunkContent.find((s) => s.type === 'change' && s.deletions > 0);
    const oldLine = hunk.deletionStart + (segment.deletionLineIndex - hunk.deletionLineIndex);
    out.leftReturned = b.scrollToLine(withDeletion, oldLine, 'LEFT', { behavior: 'instant' });
    await H.settle(300);
    const leftRow = H.findRow(withDeletion, oldLine, 'deletions');
    out.leftRow = { found: !!leftRow, type: leftRow?.getAttribute('data-line-type') ?? null, flashed: !!leftRow && leftRow.classList.contains('pierre-line-highlight') };

    // Lines the data does not show, a collapsed file, an unknown file.
    out.refusals = [
      b.scrollToLine(other, 999999, 'RIGHT'),
      b.scrollToItem('nope.js'),
      b.scrollToLine('nope.js', 1, 'RIGHT'),
      (() => { b.setCollapsed(other, true); return b.scrollToLine(other, line, 'RIGHT'); })(),
    ];
    // Only a flash, no scroll (the boolean form older callers use).
    b.setCollapsed(other, false);
    b.scrollToItem(other);
    await H.settle(300);
    const before = H.root.scrollTop;
    out.flashOnly = b.scrollToLine(other, hunks[0].additionStart, 'RIGHT', false);
    await H.settle(200);
    out.flashOnlyScrolled = H.root.scrollTop - before;
    out.sound = BH.sound();
    return out;
  });
  expect(result.everMounted).toBe(false);
  expect(result.itemReturned).toBe(true);
  expect(result.headerTop).toBe(0);
  expect(result.lineReturned).toBe(true);
  expect(result.rowTop).toBe(40);
  expect(result.flashed).toBe(true);
  expect(result.leftReturned).toBe(true);
  expect(result.leftRow).toEqual({ found: true, type: 'change-deletion', flashed: true });
  expect(result.refusals).toEqual([false, false, false, false]);
  expect(result.flashOnly).toBe(true);
  expect(result.flashOnlyScrolled).toBe(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a deferred file is a header with a notice until it is materialized; a notice can be set and removed', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const big = roles.medium;
    await BH.up({ entries: [
      BH.diffEntry(roles.small),
      BH.diffEntry(big, { deferred: true, notice: { message: 'Large diff (1 KB, 40 lines)', action: 'Load diff' } }),
      BH.diffEntry(roles.binary),
      BH.diffEntry(roles.added),
    ] });
    const b = BH.bridge;
    const notice = () => b.findFileElement(big)?.querySelector('.notice') ?? null;
    const zone = BH.zones.get(big);
    const out = { deferred: {
      rows: BH.rows(big).length,
      notice: notice()?.textContent ?? null,
      // Array order is visual order: the zone, then the notice.
      zoneAboveNotice: zone.getBoundingClientRect().top <= notice().getBoundingClientRect().top,
      visible: b.isLineVisible(big, 5, 'RIGHT'),
      position: b.getDiffPosition(big, b.parsePatch(H.workload.patches[big]).hunks[0].additionStart, 'RIGHT'),
      upgradeRefused: b.upgradeFileContents(big, H.contentsOf(big).oldFile, H.contentsOf(big).newFile),
      sound: BH.sound(),
    } };
    // A card added while the file is deferred is kept for when it has lines.
    const line = b.parsePatch(H.workload.patches[big]).hunks[0].additionStart + 1;
    b.addAnnotation(big, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'on a deferred file' }, id: 'card-deferred' });
    out.materialized = b.materializeDeferred(big);
    out.again = b.materializeDeferred(big);
    await BH.displayed(big);
    await H.settle(200);
    out.loaded = {
      rows: BH.rows(big).length > 0,
      notice: notice(),
      card: BH.cardState(big, 'card-deferred').connected,
      visible: b.isLineVisible(big, line, 'RIGHT'),
      position: b.getDiffPosition(big, line, 'RIGHT') > 0,
      upgrade: b.upgradeFileContents(big, H.contentsOf(big).oldFile, H.contentsOf(big).newFile),
      sound: BH.sound(),
    };
    // A binary file shows nothing under its header, as today; a notice can be put there and taken away.
    b.scrollToItem(roles.binary);
    await H.settle(150);
    const binaryHost = () => b.findFileElement(roles.binary);
    out.binary = { rows: BH.rows(roles.binary).length, notice: binaryHost().querySelector('.notice'), height: H.itemHeight(roles.binary) };
    b.setNotice(roles.binary, { message: 'Binary file' });
    await H.settle(150);
    out.binaryWithNotice = { text: binaryHost().querySelector('.notice')?.textContent ?? null, sound: BH.sound() };
    b.setNotice(roles.binary, null);
    await H.settle(150);
    out.binaryAfter = { notice: binaryHost().querySelector('.notice'), height: H.itemHeight(roles.binary), sound: BH.sound() };
    out.unknown = [b.materializeDeferred('nope.js'), b.materializeDeferred(roles.small)];
    return out;
  });
  expect(result.deferred).toEqual({ rows: 0, notice: 'Large diff (1 KB, 40 lines)Load diff', zoneAboveNotice: true, visible: false, position: null, upgradeRefused: false, sound: { orphans: 0, clean: true } });
  expect(result.materialized).toBe(true);
  expect(result.again).toBe(true);
  expect(result.loaded).toEqual({ rows: true, notice: null, card: true, visible: true, position: true, upgrade: true, sound: { orphans: 0, clean: true } });
  expect(result.binary).toEqual({ rows: 0, notice: null, height: 40 });
  expect(result.binaryWithNotice).toEqual({ text: 'Binary file', sound: { orphans: 0, clean: true } });
  expect(result.binaryAfter).toEqual({ notice: null, height: 40, sound: { orphans: 0, clean: true } });
  expect(result.unknown).toEqual([false, true]);
});

test('a worker script that fails to load: the same viewer renders and highlights on the main thread', async ({ harness }) => {
  const page = await openBridge(harness);
  // The vendor reports the failure itself; nothing else may be logged.
  harness.allowErrors(page, /Worker error|worker/i, /Failed to load resource/);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    BH.create({ workerUrl: '/worker/missing.js' });
    BH.renderAll([BH.diffEntry(roles.small), BH.diffEntry(roles.medium)]);
    const rendered = await H.until(() => (H.shape(roles.small)?.rows ?? 0) > 0, 20000);
    const tokens = await H.until(() => (H.shape(roles.small)?.tokens ?? 0) > 0, 20000);
    const b = BH.bridge;
    b.addAnnotation(roles.small, { lineNumber: b.files.get(roles.small).metadata.hunks[0].additionStart, side: 'RIGHT', type: 'card', data: {}, id: 'card-1' });
    await H.settle(150);
    return { rendered: rendered.ok, tokens: tokens.ok, failed: b.workerManager.getStats().workersFailed, card: BH.cardState(roles.small, 'card-1').connected, sound: BH.sound() };
  });
  expect(result).toEqual({ rendered: true, tokens: true, failed: true, card: true, sound: { orphans: 0, clean: true } });
});

test('without the worker pool, and without the vendor bundle, the bridge says so and does not throw', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    BH.create({ useWorkerPool: false });
    BH.renderAll([BH.diffEntry(roles.small)]);
    await H.settle(200);
    const noPool = { manager: BH.bridge.workerManager, rows: BH.rows(roles.small).length > 0, sound: BH.sound() };
    BH.bridge.destroy();

    const vendor = window.PierreDiffs;
    window.PierreDiffs = undefined;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(String(args[0]));
    const bridge = new window.PierreCodeViewBridge({ root: document.getElementById('root') });
    console.warn = originalWarn;
    const missing = {
      available: bridge.available,
      warned: warnings.some((w) => w.includes('bundle is missing')),
      renderAll: bridge.renderAll([BH.diffEntry(roles.small)]),
      reconcile: bridge.reconcile([]).reason,
      files: bridge.files.size,
      parse: bridge.parsePatch('@@ -1 +1 @@\n-a\n+b\n'),
    };
    bridge.destroy();
    window.PierreDiffs = vendor;
    return { noPool, missing };
  });
  expect(result.noPool).toEqual({ manager: null, rows: true, sound: { orphans: 0, clean: true } });
  expect(result.missing).toEqual({ available: false, warned: true, renderAll: false, reconcile: 'not-rendered', files: 0, parse: null });
});
