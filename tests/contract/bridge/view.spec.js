// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: the file-comment zone, collapse, layout and theme
 * changes, scroll targets, what scrolling leaves drawn, notice items, and a
 * worker that does not start.
 */

import { test, expect, openBridge, VALIDATOR_PATTERN } from './bridge-test.js';

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

for (const change of ['a form opens in', 'a form closes in']) {
  test(`${change} a file's comment zone and another file is published before the next frame: the development validator reports once, and the layout is exact at the next frame`, async ({ harness }) => {
    // Vendor fact F27, through the bridge, with the zone. What a reader
    // could see is the frame, and by then the viewer has followed the zone.
    // A development-bundle E2E run meets this whenever a comment reload, a
    // suggestion display or a summary lands right after a form opened or a
    // comment was saved; its fixture tells it from a real mismatch by the
    // state one frame later.
    const page = await openBridge(harness);
    harness.allowErrors(page, VALIDATOR_PATTERN);
    const result = await page.evaluate(async (opens) => {
      const { H, BH } = window;
      const { roles } = H.workload;
      await BH.up({ entries: [BH.diffEntry(roles.small), BH.diffEntry(roles.medium), BH.diffEntry(roles.large)] });
      const b = BH.bridge;
      await H.settle(150);
      const zone = BH.zones.get(roles.small);
      const form = document.createElement('div');
      form.style.cssText = 'height: 132px; margin: 0;';
      if (!opens) {
        zone.appendChild(form);
        await H.settle(150);
      }
      const before = { sound: BH.sound(), height: H.itemHeight(roles.small) };
      // One task: the zone changes, and another file gets a card.
      if (opens) zone.appendChild(form);
      else form.remove();
      b.addAnnotation(roles.medium, { lineNumber: 1, side: 'RIGHT', type: 'card', data: { text: 'elsewhere' }, id: 'card-elsewhere' });
      const sameTask = BH.sound();
      await H.raf(1);
      const nextFrame = BH.sound();
      await H.settle(150);
      return { before, sameTask, nextFrame, rest: BH.sound(), grewBy: H.itemHeight(roles.small) - before.height };
    }, change === 'a form opens in');
    const reports = harness.validatorErrors(page);

    expect(result.before.sound).toEqual({ orphans: 0, clean: true });
    expect(result.sameTask).toEqual({ orphans: 0, clean: false });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('sticky container height does not match computed layout');
    expect(result.nextFrame).toEqual({ orphans: 0, clean: true });
    expect(result.rest).toEqual({ orphans: 0, clean: true });
    expect(result.grewBy).toBe(change === 'a form opens in' ? 132 : -132);
  });
}

test('a file\'s comment zone changes its height and the same file is published in that task: measured at once, nothing reported', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    await BH.up({ entries: [BH.diffEntry(roles.small), BH.diffEntry(roles.medium)] });
    const b = BH.bridge;
    await H.settle(150);
    const id = roles.small;
    const line = Number(H.host(id).shadowRoot.querySelector('[data-content] > [data-line]').getAttribute('data-line'));
    const before = H.itemHeight(id);
    b.addAnnotation(id, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'same file' }, id: 'card-same' });
    await H.settle(150);
    const form = document.createElement('div');
    form.style.cssText = 'height: 132px; margin: 0;';
    // One task: the zone grows, and the same file loses its card.
    BH.zones.get(id).appendChild(form);
    b.removeAnnotation(id, 'card-same');
    const sameTask = BH.sound();
    await H.settle(150);
    return { sameTask, rest: BH.sound(), grewBy: H.itemHeight(id) - before };
  });
  // No allowance: the fixture fails this test on any validator report.
  expect(result.sameTask).toEqual({ orphans: 0, clean: true });
  expect(result.rest).toEqual({ orphans: 0, clean: true });
  expect(result.grewBy).toBe(132);
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
    // To the right edge, give or take the 1 px seam borders of the two halves and the 1 px of the file's frame.
    expect(info.zone.right, id).toBeLessThanOrEqual(3);
    expect(info.card.right, id).toBeLessThanOrEqual(3);
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
  expect(result.collapsed).toEqual({ classes: ['collapsed', 'd2h-file-wrapper', 'has-diff-lines'], rows: 0, cardConnected: false, zoneConnected: false, height: 40, held: true });
  expect(result.expanded).toEqual({ classes: ['d2h-file-wrapper', 'has-diff-lines'], sameCard: true, value: 'draft', rows: true });
  expect(result.unknown).toBe(false);
  expect(result.builds).toBe(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('what is drawn of a mounted file does not change with the scroll position: no separator and no card is lost scrolling up and back down', async ({ harness }) => {
  // With the viewer's default row window, a window that shrinks to end at a
  // row drops what follows that row, the separator after a file's last hunk
  // or a line's card, and does not draw it again when it grows (vendor fact
  // F26, tests/contract/vendor/row-window.spec.js). The bridge gives every
  // item a window of 5000 rows (itemMetrics.hunkLineCount), so a mounted
  // file that shows fewer is always drawn whole. Walked a row at a time,
  // which with the default window meets every window end.
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const names = H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 8);
    await BH.up({ entries: names.map((n) => BH.diffEntry(n)) });
    const b = BH.bridge;
    const expected = {};
    for (const n of names) {
      const { oldFile, newFile } = H.contentsOf(n);
      b.upgradeFileContents(n, oldFile, newFile);
      // A card on the last line of every hunk: the row a window is most likely to end at.
      const hunks = b.files.get(n).metadata.hunks;
      for (const hunk of hunks) {
        b.addAnnotation(n, { lineNumber: hunk.additionStart + hunk.additionCount - 1, side: 'RIGHT', type: 'card', data: { text: 'card', height: 30 } });
      }
      expected[n] = hunks.length;
    }
    await H.settle(300);

    const drawn = {};
    let unclean = 0;
    const look = () => {
      for (const id of H.mounted()) {
        if (!b.isDiffDisplayed(id)) continue; // a file just mounted still shows its patch for a moment
        const root = H.host(id).shadowRoot;
        const last = [...root.querySelectorAll('[data-content] > *')].pop();
        const cards = [...H.host(id).querySelectorAll('.card')].filter((card) => card.getBoundingClientRect().height > 0).length;
        (drawn[id] = drawn[id] || new Set()).add(`${H.shape(id).rows} rows, ${cards} of ${expected[id]} cards, ends with a ${last && last.hasAttribute('data-separator') ? 'separator' : 'row'}`);
      }
      if (!H.auditClean()) unclean++;
    };
    b.scrollToItem(names[4], { align: 'start', behavior: 'instant' });
    await H.settle(300);
    const from = H.root.scrollTop;
    const row = H.rec(names[4]).instance.metrics.lineHeight;
    let steps = 0;
    for (let y = from; y > 0; y -= row) { H.root.scrollTop = y; await H.raf(2); look(); steps++; }
    for (let y = 0; y <= from; y += row) { H.root.scrollTop = y; await H.raf(2); look(); steps++; }
    await H.settle(300);
    look();
    return {
      steps, unclean,
      seen: Object.keys(drawn).length,
      drawn: Object.fromEntries(Object.entries(drawn).map(([id, set]) => [id, [...set]])),
      hiddenAfterLastHunk: names.filter((n) => {
        const { metadata } = b.files.get(n);
        const last = metadata.hunks[metadata.hunks.length - 1];
        return metadata.additionLines.length - (last.additionStart + last.additionCount - 1) > 5;
      }),
      sound: BH.sound(),
    };
  });

  expect(result.steps).toBeGreaterThan(100);
  expect(result.seen).toBeGreaterThanOrEqual(5);
  // Every time a file was mounted it showed the same rows, every one of its
  // cards, and, where lines are hidden after its last hunk, the separator
  // that stands for them.
  for (const [id, shapes] of Object.entries(result.drawn)) {
    expect(shapes, id).toHaveLength(1);
    expect(shapes[0], id).toMatch(/^[1-9]\d* rows, (\d+) of \1 cards, /);
    if (result.hiddenAfterLastHunk.includes(id)) expect(shapes[0], id).toMatch(/ends with a separator$/);
  }
  expect(result.hiddenAfterLastHunk.filter((id) => id in result.drawn).length).toBeGreaterThanOrEqual(3);
  expect(result.unclean).toBe(0);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

for (const guarded of [true, false]) {
  const title = guarded
    ? 'a file drawn in row windows keeps the card of the row a window ended at: the bridge draws the file again when the viewer drops it'
    : 'without the bridge\'s redraw, the card of the row a window ended at is gone when the window covers that row again (F26, what the redraw is for)';
  test(title, async ({ harness }) => {
    // Hazard H119. A file that shows more rows than the bridge's row window
    // (5000) is still drawn in windows, which move in steps of 5000 rows as
    // the pane scrolls. The viewer updates the rows in place, and the
    // annotation row of the last row it keeps goes with the rows it removes;
    // the rows it adds later start at the next line. The second variant
    // switches the bridge's check off and shows the loss; when it starts to
    // fail, the viewer no longer drops the card and the check can go.
    test.setTimeout(120000);
    const page = await openBridge(harness);
    const result = await page.evaluate(async (withGuard) => {
      const { H, BH } = window;
      const { roles } = H.workload;
      const id = roles.hugeAdded;
      await BH.up({ entries: [BH.diffEntry(id)] });
      const b = BH.bridge;
      if (!withGuard) b._restoreTrimmedCards = () => {};
      const lines = [5000, 9999, 10000, 10001];
      for (const lineNumber of lines) b.addAnnotation(id, { lineNumber, side: 'RIGHT', type: 'card', data: { text: `card ${lineNumber}.`, height: 30 } });
      await H.settle(300);
      const row = H.rec(id).instance.metrics.lineHeight;
      const drawn = (line) => {
        const card = [...H.host(id).querySelectorAll('.card')].find((el) => el.textContent.includes(`card ${line}.`));
        return !!card && card.isConnected && card.getBoundingClientRect().height > 0;
      };
      const rowOnScreen = (line) => {
        const el = H.host(id).shadowRoot.querySelector(`[data-content] > [data-line="${line}"]`);
        if (!el) return false;
        const box = el.getBoundingClientRect();
        const pane = H.root.getBoundingClientRect();
        return box.bottom > pane.top && box.top < pane.bottom;
      };
      // Away by `rows` rows in steps, and back the same way: the window moves and returns.
      const awayAndBack = async (rows) => {
        const from = H.root.scrollTop;
        const step = 100 * Math.sign(rows);
        for (let moved = step; Math.abs(moved) <= Math.abs(rows); moved += step) { H.root.scrollTop = from + moved * row; await H.raf(2); }
        for (let moved = rows - step; Math.abs(moved) >= 0 && Math.sign(moved) !== -Math.sign(rows); moved -= step) { H.root.scrollTop = from + moved * row; await H.raf(2); if (moved === 0) break; }
        H.root.scrollTop = from;
        await H.settle(300);
      };
      const seen = [];
      // On screen with the rows after it: the line is not the end of what is drawn.
      const look = (label, line) => seen.push({ label, line, onScreen: rowOnScreen(line) && rowOnScreen(line + 1), card: drawn(line) });
      for (const line of [10000, 5000]) {
        b.scrollToLine(id, line, 'RIGHT', { align: 'start', behavior: 'instant' });
        await H.settle(400);
        look('reached', line);
        await awayAndBack(2600);
        look('after 2600 rows down and back', line);
        await awayAndBack(-2600);
        look('after 2600 rows up and back', line);
      }
      b.scrollToLine(id, 9999, 'RIGHT', { align: 'start', behavior: 'instant' });
      await H.settle(400);
      look('reached again, with its neighbours', 10000);
      look('the line before it', 9999);
      look('the line after it', 10001);
      return { rows: H.shape(id).rows, seen, annotations: b.getAnnotations(id, 'card').length, sound: BH.sound() };
    }, guarded);

    // Every look was at a row that is on screen, and the bridge holds every card throughout.
    expect(result.seen.every((entry) => entry.onScreen), JSON.stringify(result.seen)).toBe(true);
    expect(result.annotations).toBe(4);
    const lost = result.seen.filter((entry) => !entry.card);
    if (guarded) {
      expect(lost, JSON.stringify(result.seen)).toEqual([]);
    } else {
      // The viewer's defect, through the bridge: a card on a window's last row is missing with its row on screen.
      expect(lost.length, JSON.stringify(result.seen)).toBeGreaterThan(0);
      expect(lost.every((entry) => entry.line === 5000 || entry.line === 10000), JSON.stringify(lost)).toBe(true);
    }
    // The layout is exact either way: a row is measured with or without its card.
    expect(result.sound).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

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
    const bridge = new window.PierreBridge({ root: document.getElementById('root') });
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

/**
 * Runs in the page: one coloured context file of `lines` lines, all of them
 * shown, alone or as one of thirty-one files, and what the pane shows of it.
 */
const LONG_FILE = `
  window.longFile = async ({ lines, shown = lines, position }) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const LONG = 'ctx/long.js';
    const others = position === 'only' ? [] : H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 30).map((n) => BH.diffEntry(n));
    const long = BH.contextEntry(LONG, { contents: BH.numberedLines(lines), ranges: [{ startLine: 1, endLine: shown }] });
    const entries = position === 'first' || position === 'only' ? [long, ...others] : position === 'last' ? [...others, long] : [...others.slice(0, 15), long, ...others.slice(15)];
    await BH.up({ entries, quietMs: 400 });
    BH.bridge.scrollToItem(LONG);
    await H.until(() => !!H.host(LONG));
    await H.until(() => (H.shape(LONG)?.tokens ?? 0) > 0, 30000);
    await H.settle(400);
    const api = { LONG };
    const rowsOf = () => [...(H.host(LONG)?.shadowRoot.querySelectorAll('[data-content] > [data-line]') || [])];
    const pane = () => H.root.getBoundingClientRect();
    /** A drawn line's top edge in the pane's scroll coordinates; null when the line is not drawn. */
    api.topOf = (line) => {
      const row = rowsOf().find((el) => Number(el.getAttribute('data-line')) === line);
      return row ? row.getBoundingClientRect().top - pane().top + H.root.scrollTop : null;
    };
    api.shows = () => {
      const all = rowsOf();
      const inPane = all.filter((row) => { const box = row.getBoundingClientRect(); return box.bottom > pane().top && box.top < pane().bottom; }).map((row) => Number(row.getAttribute('data-line')));
      const gaps = inPane.filter((line, index) => index > 0 && line !== inPane[index - 1] + 1).length;
      return {
        drawn: all.length,
        firstInPane: inPane[0] ?? null,
        lastInPane: inPane[inPane.length - 1] ?? null,
        consecutive: gaps === 0,
        unclean: H.heightAudit().filter((a) => a.dH !== 0 || a.dTop !== 0).length,
      };
    };
    return api;
  };
`;

test('a file of more than 5,000 rows is drawn where the pane is at every position across its block boundaries: the rows after a boundary are there as soon as the pane reaches them', async ({ harness }) => {
  // Vendor fact F30 (tests/contract/vendor/row-window.spec.js): the viewer
  // alone leaves the rows after every 5,000th undrawn until the middle of the
  // pane has passed, and holds the drawn rows against the pane's bottom edge
  // meanwhile. PierreBridge.coverPaneWithRowWindow asks it a second time.
  test.setTimeout(180000);
  const page = await openBridge(harness);
  await page.addScriptTag({ content: LONG_FILE });
  const result = await page.evaluate(async () => {
    const { H } = window;
    const w = await window.longFile({ lines: 12000, position: 'middle' });
    const paneHeight = H.root.clientHeight;
    // The layout of the file's rows, from two rows that are drawn at its top.
    const first = w.topOf(1);
    const rowHeight = w.topOf(2) - first;
    const steps = [];
    const at = async (label, line, fraction) => {
      // `line`'s top edge this far down the pane.
      H.root.scrollTop = Math.round(first + (line - 1) * rowHeight - paneHeight * fraction);
      await H.settle(600);
      const top = w.topOf(line);
      steps.push({ label, line, lineTopInPane: top === null ? null : Math.round(top - H.root.scrollTop), expected: Math.round(paneHeight * fraction), ...w.shows() });
    };
    await at('first boundary entering the pane', 5001, 0.95);
    await at('first boundary three quarters down', 5001, 0.75);
    await at('first boundary in the middle', 5001, 0.5);
    await at('first boundary a quarter down', 5001, 0.25);
    await at('first boundary leaving the pane', 5001, 0.02);
    await at('back to three quarters down', 5001, 0.75);
    await at('second boundary three quarters down', 10001, 0.75);
    await at('second boundary a quarter down', 10001, 0.25);
    await at('the last line at the bottom of the pane', 12000, 0.9);
    await at('second boundary again, upward', 10001, 0.75);
    await at('first boundary again, upward', 5001, 0.75);
    await at('the file\'s first line', 1, 0.1);
    return { paneHeight, rowHeight, steps };
  });
  expect(result.paneHeight).toBe(860);
  expect(result.rowHeight).toBe(20);
  expect(result.steps.map((s) => s.label)).toHaveLength(12);
  for (const step of result.steps) {
    // The line is drawn, and where the layout has it.
    expect(step.lineTopInPane, step.label).not.toBeNull();
    expect(Math.abs(step.lineTopInPane - step.expected), step.label).toBeLessThanOrEqual(1);
    // The pane shows consecutive lines around it: from the top edge (or the file's first line) to the bottom edge (or its last).
    expect(step.consecutive, step.label).toBe(true);
    expect(step.firstInPane, step.label).toBe(Math.max(1, step.line - Math.ceil(step.expected / 20)));
    expect(step.lastInPane, step.label).toBe(Math.min(12000, step.line + Math.ceil((860 - step.expected) / 20) - 1));
    expect(step.unclean, step.label).toBe(0);
    // Never more than two blocks of rows.
    expect(step.drawn, step.label).toBeLessThanOrEqual(10000);
  }
  expect(harness.validatorErrors(page)).toEqual([]);
});

for (const position of ['only', 'last']) {
  test(`the last rows of a file that ends the pane a few rows after a block boundary are drawn (${position === 'only' ? 'the only file' : 'the last of thirty-one files'})`, async ({ harness }) => {
    // Vendor fact F30, second test: the viewer alone never draws them.
    test.setTimeout(120000);
    const page = await openBridge(harness);
    await page.addScriptTag({ content: LONG_FILE });
    const result = await page.evaluate(async (position) => {
      const { H, BH } = window;
      const w = await window.longFile({ lines: 5006, position });
      const out = { atTop: w.shows() };
      H.root.scrollTop = H.root.scrollHeight;
      await H.settle(600);
      out.atEnd = w.shows();
      out.atMax = H.root.scrollTop === H.root.scrollHeight - H.root.clientHeight;
      const lastTop = w.topOf(5006);
      out.lastLineBottomInPane = lastTop === null ? null : Math.round(lastTop + 20 - H.root.scrollTop);
      // And away and back: the same.
      BH.bridge.scrollToItem(w.LONG);
      await H.settle(600);
      out.backAtTop = w.shows();
      H.root.scrollTop = H.root.scrollHeight;
      await H.settle(600);
      out.atEndAgain = w.shows();
      out.sound = BH.sound();
      return out;
    }, position);
    // At its top the file is drawn one block of rows.
    expect(result.atTop).toMatchObject({ drawn: 5000, firstInPane: 1, consecutive: true, unclean: 0 });
    expect(result.atMax).toBe(true);
    expect(result.atEnd).toMatchObject({ drawn: 5006, lastInPane: 5006, consecutive: true, unclean: 0 });
    // Below the last line: the file's bottom padding (9 px) and the pane's (41 px).
    expect(result.lastLineBottomInPane).toBe(860 - 50);
    expect(result.backAtTop).toMatchObject({ drawn: 5000, firstInPane: 1, unclean: 0 });
    expect(result.atEndAgain).toMatchObject({ drawn: 5006, lastInPane: 5006, consecutive: true, unclean: 0 });
    expect(result.sound).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

// ─── The end of the pane after the reader's own scroll (ledger H163) ────────

/** Eight files of 600 lines, a wrapping line in every ten: none of them is drawn whole until the reader gets there. */
const WRAPPING_FILES = `
  window.wrappingFiles = async () => {
    const { H, BH } = window;
    const long = ' // ' + 'these words make the line long enough to wrap in the pane '.repeat(6);
    const entries = Array.from({ length: 8 }, (_, f) => BH.contextEntry('wrap/file' + (f + 1) + '.js', {
      contents: Array.from({ length: 600 }, (_, i) => 'const w' + (f + 1) + '_' + (i + 1) + ' = ' + (i + 1) + ';' + ((i + 1) % 10 === 0 ? long : '')).join('\\n') + '\\n',
      ranges: [{ startLine: 1, endLine: 600 }],
    }));
    await BH.up({ entries, quietMs: 400 });
    const root = H.root;
    return {
      state: () => ({ top: Math.round(root.scrollTop), height: root.scrollHeight, short: Math.round(root.scrollHeight - root.clientHeight - root.scrollTop) }),
      first: entries[0].id,
      last: entries[7].id,
    };
  };
`;

/** A fresh page with the eight files, the pointer over the pane. */
async function openWrappingFiles(harness) {
  const page = await openBridge(harness);
  await page.addScriptTag({ content: WRAPPING_FILES });
  const before = await page.evaluate(async () => { window.w = await window.wrappingFiles(); return window.w.state(); });
  const box = await page.locator('#root').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { page, before, box };
}
const paneState = (page) => page.evaluate(() => window.w.state());
const settled = (page, ms = 900) => page.evaluate((quiet) => window.H.settle(quiet), ms);

test('a position the page writes as "the end" is short of the end once the files there are measured (the viewer\'s estimate; not followed)', async ({ harness }) => {
  // What the viewer does by itself, and what a reader's scroll is not left to (next test).
  const { page, before } = await openWrappingFiles(harness);
  await page.evaluate(() => { window.H.root.scrollTop = window.H.root.scrollHeight; });
  await settled(page);
  const after = await paneState(page);
  expect(after.height).toBeGreaterThan(before.height + 500);
  expect(after.short).toBeGreaterThan(500);
  expect(harness.validatorErrors(page)).toEqual([]);
});

for (const gesture of ['wheel', 'End key']) {
  test(`a scroll of the reader's that reaches the end of the pane stays at the end while the files there are measured (${gesture})`, async ({ harness }) => {
    const { page, before } = await openWrappingFiles(harness);
    if (gesture === 'wheel') {
      await page.mouse.wheel(0, 10000000);
    } else {
      await page.evaluate(() => { window.H.root.tabIndex = -1; window.H.root.focus({ preventScroll: true }); });
      await page.keyboard.press('End');
    }
    await settled(page);
    const after = await paneState(page);
    const lastLine = await page.evaluate(() => {
      const { H } = window;
      const rows = [...H.host(window.w.last).shadowRoot.querySelectorAll('[data-content] > [data-line]')];
      const lastRow = rows[rows.length - 1];
      const pane = H.root.getBoundingClientRect();
      const row = lastRow.getBoundingClientRect();
      return { line: Number(lastRow.getAttribute('data-line')), inPane: row.bottom <= pane.bottom + 1 && row.top >= pane.top };
    });
    expect(after.height).toBeGreaterThan(before.height + 500);
    expect(after.short).toBe(0);
    expect(lastLine).toEqual({ line: 600, inPane: true });
    // It stays there, and the layout is the viewer's.
    await settled(page, 600);
    expect((await paneState(page)).short).toBe(0);
    expect(await page.evaluate(() => window.BH.sound())).toEqual({ orphans: 0, clean: true });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

for (const moment of ['as soon as the End key\'s own scroll is over', 'after the follow has ended']) {
  test(`a Page Up pressed after the End key is not undone (${moment})`, async ({ harness }) => {
    // The follow starts once per scroll toward the end and remembers nothing
    // after it: the place a Page Up leaves the reader at is beyond the end of
    // the pane as it was when End was pressed, and was taken for "the end
    // reached" again for a second and a half.
    const { page, before } = await openWrappingFiles(harness);
    // No scroll of the pane in flight: its last `scrollend` is not older
    // than its last `scroll`, for two frames. Chromium drops a scroll key
    // that arrives while the smooth scroll of the key before it is finishing
    // (on any page; measured, ledger H163), and a position that has not
    // changed between two looks does not say that scroll is over.
    await page.evaluate(() => {
      const seen = window.__rootScrolls = { scroll: 0, end: 0 };
      window.H.root.addEventListener('scroll', () => { seen.scroll = performance.now(); }, { passive: true });
      window.H.root.addEventListener('scrollend', () => { seen.end = performance.now(); });
    });
    const scrollOver = () => page.evaluate(async () => {
      const seen = window.__rootScrolls;
      for (let quiet = 0; quiet < 2;) {
        await window.H.raf(1);
        quiet = seen.end >= seen.scroll ? quiet + 1 : 0;
      }
    });
    await page.evaluate(() => { window.H.root.tabIndex = -1; window.H.root.focus({ preventScroll: true }); });
    await page.keyboard.press('End');
    await page.waitForFunction((height) => { const s = window.w.state(); return s.height > height + 500 && s.short === 0; }, before.height);
    // (What a key pressed while a follow is running does is a unit test's: it ends the follow.)
    await scrollOver();
    if (moment === 'after the follow has ended') {
      await page.waitForFunction(() => window.BH.bridge._endFollow === null);
      await scrollOver();
    }
    expect((await paneState(page)).short).toBe(0);
    await page.keyboard.press('PageUp');
    // The key's scroll begins when the browser gets to it: wait for the
    // move, then for its end and the rest. Judged by the distance from the
    // end: the files above may still be measured, which moves the position
    // and not what the reader sees.
    await page.waitForFunction(() => window.w.state().short > 300);
    await scrollOver();
    await settled(page);
    const after = await paneState(page);
    expect(after.short).toBeGreaterThan(300);
    // And a second one goes on up from there.
    await scrollOver();
    await page.keyboard.press('PageUp');
    await page.waitForFunction((from) => window.w.state().short > from + 300, after.short);
    await scrollOver();
    await settled(page);
    expect((await paneState(page)).short).toBeGreaterThan(after.short + 300);
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

test('nothing is followed while the pane\'s scrollbar is held; let go with the pane at its end, the end is kept while the files there are measured', async ({ harness }) => {
  // The press and the release are dispatched (a press on the scrollbar is a
  // pointerdown whose target is the pane itself, at the pane's right edge);
  // the growth is the viewer's own. tests/e2e/scrollbar-drag.spec.js drags a
  // real thumb.
  const { page, before } = await openWrappingFiles(harness);
  const press = () => page.evaluate(() => {
    const { H } = window;
    const box = H.root.getBoundingClientRect();
    H.root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: box.right - 5, clientY: box.top + 10 }));
    H.root.scrollTop = H.root.scrollHeight;
  });
  const release = () => page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' }));
  });
  // Held at the end while the files there are measured: the position is the thumb's.
  await press();
  await settled(page);
  const held = await paneState(page);
  expect(held.height).toBeGreaterThan(before.height + 500);
  expect(held.short).toBeGreaterThan(500);
  // Dragged up, still held: it stays where the thumb put it.
  await page.evaluate(() => { window.H.root.scrollTop -= 400; });
  await settled(page);
  const up = await paneState(page);
  expect(up.top).toBe(held.top - 400);
  // Let go short of the end: nothing happens.
  await release();
  await settled(page);
  expect((await paneState(page)).top).toBe(up.top);

  // A fresh pane: the thumb taken to the end and let go at once.
  const second = await openWrappingFiles(harness);
  await second.page.evaluate(() => {
    const { H } = window;
    const box = H.root.getBoundingClientRect();
    H.root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: box.right - 5, clientY: box.top + 10 }));
    H.root.scrollTop = H.root.scrollHeight;
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' }));
  });
  await settled(second.page);
  const let_go = await paneState(second.page);
  expect(let_go.height).toBeGreaterThan(second.before.height + 500);
  expect(let_go.short).toBe(0);
  expect(await second.page.evaluate(() => window.BH.sound())).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(second.page)).toEqual([]);
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('a scrollbar taken to the end of its track is put at the end of the pane when it is let go, however much the pane grew under it', async ({ harness }) => {
  // What a drag of the thumb to the bottom comes to on a pane whose last
  // files are measured only when the reader gets there. The press, the
  // thumb's scrolls and the release are dispatched; the growth is the
  // viewer's own. tests/e2e/scrollbar-drag.spec.js drags a real thumb.
  const edge = (page) => page.evaluate(() => { const r = window.H.root.getBoundingClientRect(); return { right: r.right, top: r.top, bottom: r.bottom }; });
  const press = (page, at) => page.evaluate(({ x, y }) => {
    window.H.root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y }));
  }, at);
  const release = (page, at) => page.evaluate(({ x, y }) => {
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y }));
  }, at);
  const lastLineInPane = (page) => page.evaluate(() => {
    const { H } = window;
    const rows = [...H.host(window.w.last).shadowRoot.querySelectorAll('[data-content] > [data-line]')];
    const lastRow = rows[rows.length - 1];
    const pane = H.root.getBoundingClientRect();
    const row = lastRow.getBoundingClientRect();
    return { line: Number(lastRow.getAttribute('data-line')), inPane: row.bottom <= pane.bottom + 1 && row.top >= pane.top };
  });

  // The thumb arrives at the end of its track, and the files there are
  // measured after it: held, the reader sees where the thumb is.
  const first = await openWrappingFiles(harness);
  const box = await edge(first.page);
  await press(first.page, { x: box.right - 5, y: box.top + 10 });
  await first.page.evaluate(() => { window.H.root.scrollTop = window.H.root.scrollHeight; });
  await settled(first.page);
  const held = await paneState(first.page);
  expect(held.height).toBeGreaterThan(first.before.height + 500);
  expect(held.short).toBeGreaterThan(500);
  // Let go, with the pointer still on the thumb (above the pane's bottom edge): the end.
  await release(first.page, { x: box.right - 5, y: box.bottom - 30 });
  await settled(first.page);
  expect((await paneState(first.page)).short).toBe(0);
  expect(await lastLineInPane(first.page)).toEqual({ line: 600, inPane: true });
  expect(await first.page.evaluate(() => window.BH.sound())).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(first.page)).toEqual([]);

  // The pane grew while the thumb was on its way: the thumb fell behind
  // the pointer, and its last scroll left the pane short of its end. The
  // pointer pulled to the pane's bottom edge says where the reader was going.
  for (const letGo of ['at the bottom edge', 'above the bottom edge']) {
    const { page, before } = await openWrappingFiles(harness);
    const at = await edge(page);
    await press(page, { x: at.right - 5, y: at.top + 10 });
    await page.evaluate(() => { const { root } = window.H; root.scrollTop = root.scrollHeight - root.clientHeight - 300; });
    await settled(page);
    const short = (await paneState(page)).short;
    expect(short).toBeGreaterThan(500);
    await release(page, { x: at.right - 5, y: letGo === 'at the bottom edge' ? at.bottom : at.bottom - 40 });
    await settled(page);
    const after = await paneState(page);
    expect(after.height, letGo).toBeGreaterThan(before.height + 500);
    if (letGo === 'at the bottom edge') {
      expect(after.short, letGo).toBe(0);
      expect(await lastLineInPane(page), letGo).toEqual({ line: 600, inPane: true });
    } else {
      // Where the thumb is: nothing was written.
      expect(after.short, letGo).toBe(short);
    }
    expect(harness.validatorErrors(page)).toEqual([]);
  }
});

test('a press on the pane\'s edge that holds no scrollbar, dragged down to the pane\'s bottom edge and let go, moves nothing', async ({ harness }) => {
  // The verifier's finding (phase 9, round 2). The browser of these tests
  // draws no scrollbar: the strip a scrollbar may be in is the pane's own
  // padding, and a press there holds nothing. A real mouse: the page is told
  // of its moves, which is what says so (a held scrollbar's are not told).
  const { page } = await openWrappingFiles(harness);
  await page.evaluate(() => { window.H.root.style.padding = '0 17px'; window.H.root.scrollTop = 3000; });
  await settled(page);
  const box = await page.locator('#root').boundingBox();
  const drags = [
    ['straight down', box.x + box.width - 5],
    ['down and into the code', box.x + box.width - 400],
  ];
  for (const [name, endX] of drags) {
    const from = await paneState(page);
    const x = box.x + box.width - 5;
    const y = box.y + 100;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === window.H.root, { x, y }), name).toBe(true);
    await page.evaluate(() => {
      window.__release = null;
      document.addEventListener('pointerup', () => { window.__release = window.H.root.scrollTop; }, { capture: true, once: true });
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    const endY = box.y + box.height - 0.5;
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(x + ((endX - x) * step) / 8, y + ((endY - y) * step) / 8);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    await page.mouse.up();
    // A follow writes the end of the pane in the release's own task.
    const atRelease = await page.evaluate(() => window.__release);
    await settled(page);
    const after = await paneState(page);
    // The browser may scroll the pane under a text selection; nothing sends it to the end.
    expect(Math.abs(after.top - atRelease), name).toBeLessThanOrEqual(120);
    expect(after.top, name).toBeLessThan(from.top + 2000);
    expect(after.short, name).toBeGreaterThan(5000);
  }
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('a navigation that starts right after the reader scrolled to the end is not pulled back to the end', async ({ harness }) => {
  const { page } = await openWrappingFiles(harness);
  await page.mouse.wheel(0, 10000000);
  const after = await page.evaluate(async () => {
    const { H, BH } = window;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    BH.bridge.scrollToItem(window.w.first, { align: 'start', behavior: 'instant' });
    await H.settle(900);
    return { top: window.w.state().top, firstTop: Math.round(H.host(window.w.first).getBoundingClientRect().top - H.root.getBoundingClientRect().top) };
  });
  expect(after.firstTop).toBeLessThanOrEqual(1);
  expect(after.top).toBeLessThan(100);
  expect(harness.validatorErrors(page)).toEqual([]);
});
