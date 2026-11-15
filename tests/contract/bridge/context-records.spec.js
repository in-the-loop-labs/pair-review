// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: context files (files outside the diff, shown as ranges
 * of their lines) as items of the one viewer. Decision D2 of
 * plans/codeview-virtualized-diff.md: a context record is a diff item without
 * changes, and nothing in the annotation, gutter, selection or scroll API
 * takes a kind.
 */

import { test, expect, openBridge, clickExpandControl } from './bridge-test.js';

const CONTEXT = 'src/mod01/shared-helpers.js';
const RANGES = [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }];

/** Two changed files with a 400-line context file between them. */
async function up(page, { options = {}, ranges = RANGES, contents = null, collapsed = false } = {}) {
  return page.evaluate(async ({ CONTEXT, options, ranges, contents, collapsed }) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const entries = [
      BH.diffEntry(roles.small),
      BH.contextEntry(CONTEXT, { contents: contents ?? BH.numberedLines(400), ranges, collapsed }),
      BH.diffEntry(roles.medium),
    ];
    await BH.up({ entries, options });
    BH.bridge.scrollToItem(CONTEXT);
    await H.settle(200);
    return { diffA: roles.small, diffB: roles.medium };
  }, { CONTEXT, options, ranges, contents, collapsed });
}

test('renderAll draws changed files and context files in entry order; a context file shows its ranges and nothing else', async ({ harness }) => {
  const page = await openBridge(harness);
  const { diffA, diffB } = await up(page);
  const result = await page.evaluate(async (CONTEXT) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const record = b.files.get(CONTEXT);
    const host = b.findFileElement(CONTEXT);
    const zone = BH.zones.get(CONTEXT);
    const firstSeparator = BH.separator(CONTEXT, 0, 'content') || BH.separator(CONTEXT, 0);
    return {
      order: [...b.files.keys()],
      kinds: [...b.files.values()].map((r) => r.kind),
      host: BH.hostInfo(CONTEXT),
      headerKind: host.querySelector('.ph').dataset.kind,
      runs: BH.lineRuns(CONTEXT),
      rowTypes: [...new Set(BH.rows(CONTEXT).map((r) => r.type))],
      firstText: BH.rows(CONTEXT)[0].text,
      labels: [0, 1, 2].map((i) => BH.separatorLabel(CONTEXT, i)),
      zone: {
        slot: zone.closest('[data-annotation-slot]')?.getAttribute('slot') ?? null,
        height: zone.getBoundingClientRect().height,
        aboveFirstSeparator: zone.getBoundingClientRect().top <= firstSeparator.getBoundingClientRect().top,
        belowHeader: zone.getBoundingClientRect().top >= host.querySelector('.ph').getBoundingClientRect().bottom,
      },
      metadata: { type: record.metadata.type, partial: record.metadata.isPartial, hunks: record.metadata.hunks.length, lines: record.metadata.additionLines.length },
      upgraded: record.upgraded,
      // A line outside the diff has no position in it.
      diffPositions: [b.getDiffPosition(CONTEXT, 105, 'RIGHT'), b.getDiffPosition(CONTEXT, 105, 'LEFT')],
      otherHostsAreNotContext: H.mounted().filter((id) => id !== CONTEXT).every((id) => !BH.hostInfo(id).classes.includes('context-file')),
      sound: BH.sound(),
    };
  }, CONTEXT);
  expect(result.order).toEqual([diffA, CONTEXT, diffB]);
  expect(result.kinds).toEqual(['diff', 'context', 'diff']);
  expect(result.host).toEqual({ fileName: CONTEXT, classes: ['context-file', 'd2h-file-wrapper', 'has-diff-lines'], header: CONTEXT });
  expect(result.headerKind).toBe('context');
  expect(result.runs).toEqual([[100, 120], [300, 310]]);
  expect(result.rowTypes).toEqual(['context']);
  expect(result.firstText).toContain('line 100');
  expect(result.labels).toEqual(['99 unmodified lines', '179 unmodified lines', '90 unmodified lines']);
  expect(result.zone).toEqual({ slot: 'annotation-additions-0', height: 0, aboveFirstSeparator: true, belowHeader: true });
  expect(result.metadata).toEqual({ type: 'new', partial: false, hunks: 2, lines: 400 });
  expect(result.upgraded).toBe(true);
  expect(result.diffPositions).toEqual([null, null]);
  expect(result.otherHostsAreNotContext).toBe(true);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a context file without a range that resolves, and an empty one, are header-only items', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    await BH.up({ entries: [
      BH.diffEntry(roles.small),
      BH.contextEntry('ctx/empty.txt', { contents: '', ranges: [{ startLine: 1, endLine: 20 }] }),
      BH.contextEntry('ctx/no-range.js', { contents: BH.numberedLines(30), ranges: [] }),
      BH.contextEntry('ctx/past-the-end.js', { contents: BH.numberedLines(30), ranges: [{ startLine: 200, endLine: 220 }] }),
      BH.contextEntry('ctx/ends-with-newline.txt', { contents: 'one\ntwo\nthree\n', ranges: [{ startLine: 1, endLine: 100 }] }),
    ] });
    const b = BH.bridge;
    const out = {};
    for (const id of ['ctx/empty.txt', 'ctx/no-range.js', 'ctx/past-the-end.js', 'ctx/ends-with-newline.txt']) {
      b.scrollToItem(id);
      await H.settle(150);
      out[id] = { rows: BH.rows(id)?.length ?? null, lines: b.files.get(id).metadata.additionLines.length, visible1: b.isLineVisible(id, 1, 'RIGHT') };
    }
    out.sound = BH.sound();
    return out;
  });
  expect(result['ctx/empty.txt']).toEqual({ rows: 0, lines: 0, visible1: false });
  expect(result['ctx/no-range.js']).toEqual({ rows: 0, lines: 30, visible1: false });
  expect(result['ctx/past-the-end.js']).toEqual({ rows: 0, lines: 30, visible1: false });
  // Three lines, as an editor counts them: no empty line after the final newline.
  expect(result['ctx/ends-with-newline.txt']).toEqual({ rows: 3, lines: 3, visible1: true });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('annotations on a context file are drawn under their line whatever side they were stored with; the hovered side is RIGHT', async ({ harness }) => {
  const page = await openBridge(harness);
  await up(page);
  const rowBox = await page.evaluate(async (CONTEXT) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const left = { id: 1, file: CONTEXT, line_start: 105, line_end: 105, side: 'LEFT', body: 'stored on the old side' };
    const right = { id: 2, file: CONTEXT, line_start: 110, line_end: 110, side: 'RIGHT', body: 'stored on the new side' };
    b.batch(() => {
      b.addAnnotation(CONTEXT, { lineNumber: 105, side: 'LEFT', type: 'card', data: left, id: 'card-left' });
      b.addAnnotation(CONTEXT, { lineNumber: 110, side: 'RIGHT', type: 'card', data: right, id: 'card-right' });
    });
    await H.settle(100);
    const box = H.findRow(CONTEXT, 115, 'additions').getBoundingClientRect();
    return { x: Math.round(box.left + 200), y: Math.round(box.top + box.height / 2) };
  }, CONTEXT);
  await page.mouse.move(rowBox.x, rowBox.y - 3);
  await page.mouse.move(rowBox.x, rowBox.y);
  await page.evaluate(() => window.H.raf(3));
  const result = await page.evaluate(async (CONTEXT) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const under = (annotationId, line) => {
      const el = b.getAnnotationElement(CONTEXT, annotationId);
      const row = H.findRow(CONTEXT, line, 'additions');
      const next = H.findRow(CONTEXT, line + 1, 'additions');
      const box = el.getBoundingClientRect();
      return {
        ...BH.cardState(CONTEXT, annotationId),
        betweenItsLineAndTheNext: box.top >= row.getBoundingClientRect().bottom - 1 && box.bottom <= next.getBoundingClientRect().top + 1,
      };
    };
    return {
      left: under('card-left', 105),
      right: under('card-right', 110),
      published: b.getAnnotations(CONTEXT, 'card').map((a) => [a.metadata.id, a.side, a.metadata.data.side]),
      hoveredRow: b.getHoveredRow(CONTEXT),
      hoveredLine: b.getHoveredLine(CONTEXT),
      sound: BH.sound(),
    };
  }, CONTEXT);
  expect(result.left).toMatchObject({ connected: true, slot: 'annotation-additions-105', host: CONTEXT, betweenItsLineAndTheNext: true });
  expect(result.left.height).toBeGreaterThan(0);
  expect(result.right).toMatchObject({ connected: true, slot: 'annotation-additions-110', host: CONTEXT, betweenItsLineAndTheNext: true });
  // Published on the additions side; the stored side is still in the data.
  expect(result.published).toEqual([['card-left', 'additions', 'LEFT'], ['card-right', 'additions', 'RIGHT']]);
  expect(result.hoveredRow).toEqual({ lineNumber: 115, side: 'RIGHT' });
  expect(result.hoveredLine).toMatchObject({ lineNumber: 115, side: 'additions' });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

for (const where of ['mounted', 'never mounted']) {
  test(`addContextRanges, isLineVisible, scrollToLine and whenLineDisplayed on a context file that is ${where}`, async ({ harness }) => {
    const page = await openBridge(harness);
    const result = await page.evaluate(async ({ CONTEXT, RANGES, where }) => {
      const { H, BH } = window;
      const { roles } = H.workload;
      const names = H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 24);
      const entries = names.map((n) => BH.diffEntry(n));
      // First in the list (mounted at once) or far down it (outside the viewer's window).
      const context = BH.contextEntry(CONTEXT, { contents: BH.numberedLines(400), ranges: RANGES });
      if (where === 'mounted') entries.unshift(context); else entries.splice(20, 0, context);
      await BH.up({ entries });
      const b = BH.bridge;
      const out = { everMounted: BH.lifecycle.some((e) => e.id === CONTEXT) };
      out.before = [b.isLineVisible(CONTEXT, 110, 'RIGHT'), b.isLineVisible(CONTEXT, 110, 'LEFT'), b.isLineVisible(CONTEXT, 200, 'RIGHT'), b.isLineVisible(CONTEXT, 401, 'RIGHT')];
      out.refused = b.scrollToLine(CONTEXT, 200, 'RIGHT');
      out.convert = b.convertOldToNew(CONTEXT, 40, 44);
      out.added = b.addContextRanges(CONTEXT, [{ startLine: 195, endLine: 205 }]);
      out.visibleAtOnce = b.isLineVisible(CONTEXT, 200, 'LEFT');
      out.scrolled = b.scrollToLine(CONTEXT, 200, 'LEFT', { behavior: 'instant' });
      out.displayed = await b.whenLineDisplayed(CONTEXT, 200, 'RIGHT', { timeoutMs: 8000 });
      await H.settle(200);
      const row = H.findRow(CONTEXT, 200, 'additions');
      out.rowOnScreen = !!row && H.viewportTopOf(row) >= 0 && H.viewportTopOf(row) < H.root.clientHeight;
      out.flashed = !!row && row.classList.contains('pierre-line-highlight');
      out.ranges = { stored: b.files.get(CONTEXT).storedRanges, revealed: b.files.get(CONTEXT).contextRanges };
      out.sound = BH.sound();
      return out;
    }, { CONTEXT, RANGES, where });
    expect(result.everMounted).toBe(where === 'mounted');
    // Side does not matter on a file without changes; a line past the end is not shown.
    expect(result.before).toEqual([true, true, false, false]);
    expect(result.refused).toBe(false);
    expect(result.convert).toEqual({ startLine: 40, endLine: 44 });
    expect(result.added).toBe(true);
    expect(result.visibleAtOnce).toBe(true);
    expect(result.scrolled).toBe(true);
    expect(result.displayed).toBe(true);
    expect(result.rowOnScreen).toBe(true);
    expect(result.flashed).toBe(true);
    expect(result.ranges).toEqual({ stored: RANGES, revealed: [{ startLine: 195, endLine: 205 }] });
    expect(result.sound).toEqual({ orphans: 0, clean: true });
  });
}

test('the reader expands a context file with real clicks: a step, Shift+click, "Expand all"; a later reveal keeps it; a new diff does not', async ({ harness }) => {
  const page = await openBridge(harness);
  const { diffA, diffB } = await up(page);
  const visible = (lines) => page.evaluate(({ CONTEXT, lines }) => lines.map((n) => window.BH.bridge.isLineVisible(CONTEXT, n, 'RIGHT')), { CONTEXT, lines });

  // Gap 2 is after the last range (311-400): its control reveals the 20 lines next to the range.
  const step = await clickExpandControl(page, CONTEXT, 2, 'up');
  expect(step && step.visible, JSON.stringify(step)).toBe(true);
  expect(await visible([311, 330, 331])).toEqual([true, true, false]);

  // Gap 0 is before the first range (1-99): Shift+click reveals all of it.
  const shift = await clickExpandControl(page, CONTEXT, 0, 'down', { shift: true });
  expect(shift && shift.visible, JSON.stringify(shift)).toBe(true);
  expect(await visible([1, 50, 99])).toEqual([true, true, true]);

  // Gap 1 is between the ranges (121-299): "Expand all" is shown on a context file and takes one plain click.
  const all = await clickExpandControl(page, CONTEXT, 1, 'all');
  expect(all && all.visible, JSON.stringify(all)).toBe(true);
  expect(all.text).toBe('Expand all');
  expect(await visible([121, 200, 299])).toEqual([true, true, true]);

  const result = await page.evaluate(async ({ CONTEXT, diffA, diffB }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const map = b.files.get(CONTEXT)._instance.hunksRenderer.expandedHunks;
    const out = { expansionMap: [...map.entries()].map(([i, r]) => [i, r.fromStart, r.fromEnd]).sort((x, y) => x[0] - y[0]) };
    // A reveal derives the diff again; what was expanded by hand is folded
    // into the file's revealed ranges first, clamped to the gaps.
    b.addContextRanges(CONTEXT, [{ startLine: 390, endLine: 395 }]);
    out.revealed = b.files.get(CONTEXT).contextRanges;
    out.mapAfterFold = map.size;
    const lines = [1, 99, 121, 299, 311, 330, 331, 389, 392, 396];
    out.afterFold = lines.map((n) => b.isLineVisible(CONTEXT, n, 'RIGHT'));
    await BH.displayed(CONTEXT);
    await H.settle(200);
    out.soundAfterFold = BH.sound();
    // A new diff starts again from the stored ranges.
    BH.renderAll([BH.diffEntry(diffA), BH.contextEntry(CONTEXT, { contents: BH.numberedLines(400), ranges: [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }] }), BH.diffEntry(diffB)]);
    await H.settle(200);
    out.afterRenderAll = lines.map((n) => b.isLineVisible(CONTEXT, n, 'RIGHT'));
    out.revealedAfterRenderAll = b.files.get(CONTEXT).contextRanges;
    out.sound = BH.sound();
    return out;
  }, { CONTEXT, diffA, diffB });
  // A whole gap is recorded as Infinity; a step as the number of lines.
  expect(result.expansionMap.map(([index]) => index)).toEqual([0, 1, 2]);
  expect(result.expansionMap[0].slice(1)).toContain(Infinity);
  expect(result.expansionMap[1].slice(1)).toContain(Infinity);
  expect(result.expansionMap[2]).toEqual([2, 20, 0]);
  // 1-99 and 121-299 touch the stored ranges; 311-330 and 390-395 are after the last.
  expect(result.revealed).toEqual([{ startLine: 1, endLine: 99 }, { startLine: 121, endLine: 299 }, { startLine: 311, endLine: 330 }, { startLine: 390, endLine: 395 }]);
  expect(result.mapAfterFold).toBe(0);
  //                               1     99    121   299   311   330   331    389    392   396
  expect(result.afterFold).toEqual([true, true, true, true, true, true, false, false, true, true]);
  expect(result.soundAfterFold).toEqual({ orphans: 0, clean: true });
  expect(result.afterRenderAll).toEqual([false, false, false, false, false, false, false, false, false, false]);
  expect(result.revealedAfterRenderAll).toEqual([]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('in split layout a context file is one column as wide as the pane, with every line once and its cards full width', async ({ harness }) => {
  const page = await openBridge(harness);
  await up(page, { options: { diffStyle: 'split' } });
  const result = await page.evaluate(async (CONTEXT) => {
    const { H, BH } = window;
    const b = BH.bridge;
    b.addAnnotation(CONTEXT, { lineNumber: 105, side: 'RIGHT', type: 'card', data: { text: 'a card on a context line' }, id: 'card-ctx' });
    await H.settle(200);
    const host = b.findFileElement(CONTEXT);
    const pre = host.shadowRoot.querySelector('pre');
    const columns = [...pre.querySelectorAll('code')];
    const hostBox = host.getBoundingClientRect();
    // The cell the viewer gives the card (the card itself has the harness's 12 px margin).
    const card = b.getAnnotationElement(CONTEXT, 'card-ctx').closest('[data-annotation-slot]').getBoundingClientRect();
    const gutter = pre.querySelector('[data-gutter]').getBoundingClientRect();
    const out = {
      diffType: pre.getAttribute('data-diff-type'),
      columns: columns.map((c) => (c.hasAttribute('data-additions') ? 'additions' : c.hasAttribute('data-deletions') ? 'deletions' : 'unified')),
      rows: BH.rows(CONTEXT).length,
      columnFillsHost: Math.round(columns[0].getBoundingClientRect().width) === Math.round(hostBox.width),
      // The card spans the content track: from the gutter's right edge to the host's.
      cardLeftAtGutter: Math.abs(card.left - gutter.right) <= 1,
      cardReachesRightEdge: Math.abs(card.right - hostBox.right) <= 1,
      separatorControls: [0, 1, 2].map((i) => ['up', 'down', 'all'].map((k) => { const box = BH.controlBox(CONTEXT, i, k); return box && !box.missing ? box.visible : null; })),
    };
    // A changed file next to it is still two columns.
    const other = H.mounted().find((id) => id !== CONTEXT && b.findFileElement(id).shadowRoot.querySelector('pre'));
    out.otherDiffType = b.findFileElement(other).shadowRoot.querySelector('pre').getAttribute('data-diff-type');
    out.sound = BH.sound();
    return out;
  }, CONTEXT);
  expect(result.diffType).toBe('single');
  expect(result.columns).toEqual(['additions']);
  expect(result.rows).toBe(32);
  expect(result.columnFillsHost).toBe(true);
  expect(result.cardLeftAtGutter).toBe(true);
  expect(result.cardReachesRightEdge).toBe(true);
  // Before the first range: grow it upward into the gap ('down' = the end of the gap) and "Expand all".
  expect(result.separatorControls[0]).toEqual([null, true, true]);
  // Between two ranges: one control per side and "Expand all".
  expect(result.separatorControls[1]).toEqual([true, true, true]);
  // After the last range.
  expect(result.separatorControls[2]).toEqual([true, null, true]);
  expect(result.otherDiffType).toBe('split');
  expect(result.sound).toEqual({ orphans: 0, clean: true });

  // The controls work in this layout too: a real click on each kind.
  const step = await clickExpandControl(page, CONTEXT, 2, 'up');
  expect(step && step.visible).toBe(true);
  const all = await clickExpandControl(page, CONTEXT, 1, 'all');
  expect(all && all.visible).toBe(true);
  const after = await page.evaluate(async (CONTEXT) => {
    const { H, BH } = window;
    await H.settle(200);
    return { visible: [121, 299, 311, 330, 331].map((n) => BH.bridge.isLineVisible(CONTEXT, n, 'RIGHT')), sound: BH.sound() };
  }, CONTEXT);
  expect(after.visible).toEqual([true, true, true, true, false]);
  expect(after.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

for (const variant of ['more than 12,000 lines', 'a NUL character', 'more than 400 KB']) {
  test(`a context file with ${variant} is drawn uncoloured and works like any other`, async ({ harness }) => {
    const page = await openBridge(harness);
    const result = await page.evaluate(async ({ CONTEXT, variant }) => {
      const { H, BH } = window;
      const { roles } = H.workload;
      let contents;
      if (variant === 'more than 12,000 lines') contents = BH.numberedLines(12001);
      else if (variant === 'a NUL character') contents = BH.numberedLines(400).replace('line 3\n', 'line 3\u0000\n');
      else contents = `${Array.from({ length: 4000 }, (_, i) => `const value${i + 1} = "${'x'.repeat(100)}"; // line ${i + 1}`).join('\n')}\n`;
      await BH.up({ entries: [
        BH.contextEntry('src/coloured.js', { contents: BH.numberedLines(400), ranges: [{ startLine: 100, endLine: 120 }] }),
        BH.contextEntry(CONTEXT, { contents, ranges: [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }] }),
        BH.diffEntry(roles.small),
      ], quietMs: 400 });
      const b = BH.bridge;
      const colouredTokens = (await H.until(() => (H.shape('src/coloured.js')?.tokens ?? 0) > 0, 8000)).ok;
      b.scrollToItem(CONTEXT);
      await H.settle(400);
      b.addAnnotation(CONTEXT, { lineNumber: 105, side: 'RIGHT', type: 'card', data: { text: 'card' }, id: 'card-plain' });
      b.addContextRanges(CONTEXT, [{ startLine: 200, endLine: 204 }]);
      await BH.displayed(CONTEXT);
      await H.settle(400);
      return {
        lang: b.files.get(CONTEXT).metadata.lang ?? null,
        colouredLang: b.files.get('src/coloured.js').metadata.lang ?? null,
        colouredTokens,
        tokens: H.shape(CONTEXT).tokens,
        runs: BH.lineRuns(CONTEXT).slice(0, 3),
        card: BH.cardState(CONTEXT, 'card-plain').connected,
        revealed: b.isLineVisible(CONTEXT, 202, 'RIGHT'),
        sound: BH.sound(),
      };
    }, { CONTEXT, variant });
    expect(result.colouredLang).toBeNull();
    expect(result.colouredTokens).toBe(true);
    expect(result.lang).toBe('text');
    expect(result.tokens).toBe(0);
    expect(result.runs).toEqual([[100, 120], [200, 204], [300, 310]]);
    expect(result.card).toBe(true);
    expect(result.revealed).toBe(true);
    expect(result.sound).toEqual({ orphans: 0, clean: true });
  });
}

test('a collapsed context file shows its header only, and setCollapsed works on it like on a changed file', async ({ harness }) => {
  const page = await openBridge(harness);
  await up(page, { collapsed: true });
  const result = await page.evaluate(async (CONTEXT) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const out = { collapsed: { classes: BH.hostInfo(CONTEXT).classes, rows: BH.rows(CONTEXT).length, visible: b.isLineVisible(CONTEXT, 105, 'RIGHT'), height: Math.round(b.findFileElement(CONTEXT).getBoundingClientRect().height) } };
    b.setCollapsed(CONTEXT, false);
    await H.settle(200);
    out.expanded = { classes: BH.hostInfo(CONTEXT).classes, runs: BH.lineRuns(CONTEXT), visible: b.isLineVisible(CONTEXT, 105, 'RIGHT') };
    out.sound = BH.sound();
    return out;
  }, CONTEXT);
  expect(result.collapsed).toEqual({ classes: ['collapsed', 'context-file', 'd2h-file-wrapper', 'has-diff-lines'], rows: 0, visible: false, height: 40 });
  expect(result.expanded).toEqual({ classes: ['context-file', 'd2h-file-wrapper', 'has-diff-lines'], runs: [[100, 120], [300, 310]], visible: true });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});
