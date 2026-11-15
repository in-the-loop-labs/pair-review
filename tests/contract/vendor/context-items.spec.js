// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: a file without changes, shown as ranges of its lines, as a
 * diff item of the viewer. This is what a context file is (decision D2 of
 * plans/codeview-virtualized-diff.md); the bridge builds exactly this in
 * PierreCodeViewBridge._setContextContents / _derive.
 *
 * Facts:
 *   F20  the zero-change base and what a ranged item is made of
 *   F21  typed 'change' it is drawn twice in split layout; typed 'new' once,
 *        and then only additions-side annotations are laid out
 *   F22  the expansion controls, Shift+click, the hidden "Expand all", the
 *        shape of the expansion map
 *   F23  line starts: the vendor's convention, and what leaving the hunk's
 *        own hidden lines out does to the layout of a file with wrapped lines
 *   F24  a list replace with an item inserted above the reader
 *   F25  how the vendor counts lines
 */

import { test, expect, VALIDATOR_PATTERN } from '../harness/contract-test.js';

const SCRIPTS = ['/app/js/modules/pierre-context.js', '/app/js/modules/pierre-styles.js'];
const CONTEXT = 'src/mod01/shared-helpers.js';

/**
 * Two changed files of the workload with a 400-line context item between
 * them, ranges 100-120 and 300-310. Runs in the page; leaves `window.C`.
 */
async function setUp(page, { diffStyle = 'unified', type = 'new', contextCss = true, lineStarts = 'vendor', pool = false, extraItems = 0, longLines = false } = {}) {
  return page.evaluate(async ({ CONTEXT, diffStyle, type, contextCss, lineStarts, pool, extraItems, longLines }) => {
    const H = window.H;
    const P = window.PierreDiffs;
    const { roles } = H.workload;
    // With `longLines` every seventh line wraps: a row taller than the viewer's estimate.
    const tail = ` ${'a very long trailing comment that has to wrap in a narrow column '.repeat(6)}`;
    const contents = `${Array.from({ length: 400 }, (_, i) => `const value${i + 1} = compute(${i + 1}); // line ${i + 1}${longLines && i % 7 === 3 ? tail : ''}`).join('\n')}\n`;
    const file = { name: CONTEXT, contents, cacheKey: `rev1:ctx:${CONTEXT}:1` };
    const base = P.parseDiffFromFile(file, { ...file });
    let derivation = 0;
    // What the bridge's rekey does: every derived metadata under a new key.
    const rekey = (metadata) => ({ ...metadata, cacheKey: `${file.cacheKey}|d${++derivation}` });
    // Line starts WITHOUT the hunk's own collapsedBefore: what pierre-context.js wrote before its correction.
    const withoutOwnGap = (metadata) => {
      let split = 0;
      let unified = 0;
      return { ...metadata, hunks: metadata.hunks.map((h) => {
        const next = { ...h, splitLineStart: split, unifiedLineStart: unified };
        split += h.collapsedBefore + h.splitLineCount;
        unified += h.collapsedBefore + h.unifiedLineCount;
        return next;
      }) };
    };
    const derive = (ranges) => {
      let metadata = window.PierreContext.mergeContextRanges(base, ranges);
      if (lineStarts === 'without-own-gap') metadata = withoutOwnGap(metadata);
      if (type) metadata = { ...metadata, type };
      return rekey(metadata);
    };
    H.parse({ cacheKeyPrefix: 'rev1:1' });
    const names = [roles.small, roles.medium, ...H.workload.modifiedPaths.filter((n) => n !== roles.small && n !== roles.medium && n !== roles.large && n !== roles.hugeModified).slice(0, extraItems)];
    H.buildItems({ only: names });
    const contextItem = {
      id: CONTEXT, type: 'diff', version: 0,
      fileDiff: derive([{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }]),
      annotations: [{ side: 'additions', lineNumber: 0, metadata: { key: `zone:${CONTEXT}`, kind: 'zone' } }],
    };
    H.items.splice(1, 0, contextItem);
    H.hooks.onPostRender = (node, instance, phase, context) => {
      // The stamp the bridge puts on a context record's host; CONTEXT_CSS keys on it.
      node.classList.toggle('context-file', phase !== 'unmount' && context.item.id === CONTEXT);
    };
    if (pool) H.createPool({});
    H.create({
      ...H.APP_OPTIONS,
      diffStyle,
      pointerEventsOnScroll: true,
      unsafeCSS: contextCss ? window.PierreStyles.unsafeCSS() : `${window.PierreStyles.ANNOTATION_CSS}\n${window.PierreStyles.ROWLESS_FIX}`,
    }, H.APP_CALLBACKS, { pool });
    H.cv.setItems(H.items);
    await H.settle(200, 15000);
    H.cv.scrollTo({ type: 'item', id: CONTEXT });
    await H.settle(200);

    const C = { id: CONTEXT, base, file, derive, rekey, contents };
    window.C = C;
    C.shadow = () => H.host(CONTEXT).shadowRoot;
    C.rows = () => [...C.shadow().querySelectorAll('[data-content] > [data-line]')];
    C.runs = () => {
      const runs = [];
      for (const row of C.rows()) {
        const n = Number(row.getAttribute('data-line'));
        const last = runs[runs.length - 1];
        if (last && n === last[1] + 1) last[1] = n; else if (!last || n !== last[1]) runs.push([n, n]);
      }
      return runs;
    };
    C.separator = (index, where = 'gutter') => C.shadow().querySelector(`[data-${where}] > [data-separator][data-expand-index="${index}"]`);
    C.bring = async (index) => {
      for (let i = 0; i < 80; i++) {
        const s = C.separator(index);
        if (s) { H.root.scrollTop += H.viewportTopOf(s) - 300; await H.settle(200); if (C.separator(index)) return true; }
        else { H.root.scrollTop = Math.max(0, H.cv.getTopForItem(CONTEXT) - 60) + i * 300; await H.settle(120); }
      }
      return false;
    };
    C.control = (index, kind) => {
      const selector = { up: '[data-expand-up]', down: '[data-expand-down]', both: '[data-expand-both]', all: '[data-expand-all-button]', label: '[data-unmodified-lines]' }[kind];
      for (const where of ['gutter', 'content']) {
        const el = C.separator(index, where)?.querySelector(selector);
        if (!el) continue;
        const box = el.getBoundingClientRect();
        if (kind === 'label' && !(box.width > 0)) continue;
        return { x: box.x + Math.min(box.width / 2, 12), y: box.y + box.height / 2, visible: box.width > 0 && box.height > 0, display: getComputedStyle(el).display, text: el.textContent.replace(/\s+/g, ' ').trim() };
      }
      return null;
    };
    C.map = () => [...H.instance(CONTEXT).hunksRenderer.expandedHunks.entries()].map(([i, r]) => [i, r.fromStart, r.fromEnd]).sort((a, b) => a[0] - b[0]);
    /** Scroll through the whole context item, auditing every screen. */
    C.walk = async () => {
      let unclean = 0;
      const top = H.cv.getTopForItem(CONTEXT);
      for (let i = 0; i < 60; i++) {
        H.root.scrollTop = Math.max(0, top - 60) + i * 500;
        await H.settle(100);
        if (!H.auditClean()) unclean++;
        if (H.root.scrollTop + H.root.clientHeight >= H.root.scrollHeight - 1) break;
      }
      return unclean;
    };
    return { names };
  }, { CONTEXT, diffStyle, type, contextCss, lineStarts, pool, extraItems, longLines });
}

/** A real click on a separator control of the context item. */
async function click(page, index, kind, { shift = false } = {}) {
  await page.evaluate((i) => window.C.bring(i), index);
  const box = await page.evaluate(([i, k]) => window.C.control(i, k), [index, kind]);
  if (!box || !box.visible) return box;
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await page.evaluate(() => window.H.settle(250));
  return box;
}

test('F20: parseDiffFromFile(file, file) is a diff without hunks that holds the file; with ranges merged in it is one column of context rows between labelled separators', async ({ harness }) => {
  // Depends on it: PierreCodeViewBridge._setContextContents (the base) and
  // _derive (the ranges). A context item needs no renderer of its own.
  const page = await harness.open({ scripts: SCRIPTS });
  await setUp(page, { type: null });
  const result = await page.evaluate(() => {
    const { H, C } = window;
    const item = H.cv.getItem(C.id);
    const rows = C.rows();
    const zone = H.annEls.get(`zone:${C.id}`);
    const separators = [0, 1, 2].map((i) => C.separator(i, 'content') || C.separator(i));
    return {
      base: { type: C.base.type, hunks: C.base.hunks.length, partial: C.base.isPartial, lines: C.base.additionLines.length, oldLines: C.base.deletionLines.length, key: C.base.cacheKey },
      hunks: item.fileDiff.hunks.map((h) => [h.additionStart, h.additionCount, h.additionLines, h.deletionLines]),
      columns: [...C.shadow().querySelectorAll('pre code')].map((c) => ['data-unified', 'data-additions', 'data-deletions'].find((a) => c.hasAttribute(a))),
      runs: C.runs(),
      rowTypes: [...new Set(rows.map((r) => r.getAttribute('data-line-type')))],
      numberCellsPerRow: C.shadow().querySelectorAll('[data-gutter] > [data-column-number]').length / rows.length,
      labels: [0, 1, 2].map((i) => C.control(i, 'label')?.text ?? null),
      separatorHeights: separators.map((s) => Math.round(s.getBoundingClientRect().height)),
      separatorType: separators[0].getAttribute('data-separator'),
      zoneSlot: zone.closest('[data-annotation-slot]').getAttribute('slot'),
      zoneAboveFirstSeparator: zone.getBoundingClientRect().top <= separators[0].getBoundingClientRect().top,
      clean: H.auditClean(),
    };
  });
  expect(result.base).toEqual({ type: 'change', hunks: 0, partial: false, lines: 400, oldLines: 400, key: expect.stringContaining('rev1:ctx:') });
  expect(result.hunks).toEqual([[100, 21, 0, 0], [300, 11, 0, 0]]);
  expect(result.columns).toEqual(['data-unified']);
  expect(result.runs).toEqual([[100, 120], [300, 310]]);
  expect(result.rowTypes).toEqual(['context']);
  expect(result.numberCellsPerRow).toBe(1);
  expect(result.labels).toEqual(['99 unmodified lines', '179 unmodified lines', '90 unmodified lines']);
  expect(result.separatorHeights).toEqual([32, 32, 32]);
  expect(result.separatorType).toBe('line-info');
  expect(result.zoneSlot).toBe('annotation-additions-0');
  expect(result.zoneAboveFirstSeparator).toBe(true);
  expect(result.clean).toBe(true);
});

test('F20: hover, the gutter utility, selection, a line scroll target, annotations and collapse work on it as on any diff item', async ({ harness }) => {
  // Depends on it: nothing in the bridge's gutter, selection, scroll or
  // annotation API takes a kind.
  const page = await harness.open({ scripts: SCRIPTS });
  await setUp(page);
  const point = await page.evaluate(() => {
    const box = window.H.findRow(window.C.id, 110, 'additions').getBoundingClientRect();
    return { x: Math.round(box.left + 200), y: Math.round(box.top + box.height / 2) };
  });
  await page.mouse.move(point.x, point.y - 3);
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => window.H.raf(3));
  const result = await page.evaluate(async () => {
    const { H, C } = window;
    const out = { hovered: H.instance(C.id).getHoveredLine() };
    H.cv.setSelectedLines({ id: C.id, range: { start: 104, end: 106, side: 'additions' } });
    await H.raf(2);
    out.selection = H.cv.getSelectedLines();
    out.selectedRows = C.rows().filter((r) => r.hasAttribute('data-selected-line')).map((r) => Number(r.getAttribute('data-line')));
    const item = H.cv.getItem(C.id);
    H.cv.updateItem({ ...item, version: item.version + 1, annotations: [...item.annotations, { side: 'additions', lineNumber: 305, metadata: { key: 'card-305', text: 'card' } }] });
    H.cv.render(true);
    out.cardSlot = H.annEls.get('card-305').closest('[data-annotation-slot]')?.getAttribute('slot') ?? null;
    H.cv.scrollTo({ type: 'line', id: C.id, lineNumber: 305, side: 'additions', align: 'start' });
    await H.settle(200);
    out.lineTop = H.viewportTopOf(H.findRow(C.id, 305, 'additions'));
    H.toggleCollapsed(C.id);
    await H.settle(200);
    out.collapsed = { rows: C.rows().length, height: H.itemHeight(C.id) };
    out.clean = H.auditClean();
    return out;
  });
  expect(result.hovered).toEqual({ lineNumber: 110, side: 'additions' });
  expect(result.selection).toMatchObject({ id: CONTEXT, range: { start: 104, end: 106 } });
  expect(result.selectedRows).toEqual([104, 105, 106]);
  expect(result.cardSlot).toBe('annotation-additions-305');
  expect(result.lineTop).toBe(40);
  expect(result.collapsed).toEqual({ rows: 0, height: 40 });
  expect(result.clean).toBe(true);
});

test('F21: typed "change" the item is drawn in both columns of split layout; typed "new" in one, and only additions-side annotations are laid out', async ({ harness }) => {
  // Depends on it: the bridge publishes a context record's metadata as
  // { ...base, type: 'new' } and every annotation of it on the additions
  // side (PierreCodeViewBridge._annotationSide).
  const twoSided = await harness.open({ scripts: SCRIPTS });
  await setUp(twoSided, { diffStyle: 'split', type: null });
  const change = await twoSided.evaluate(() => {
    const { C } = window;
    return {
      diffType: C.shadow().querySelector('pre').getAttribute('data-diff-type'),
      columns: [...C.shadow().querySelectorAll('pre code')].map((c) => ['data-unified', 'data-additions', 'data-deletions'].find((a) => c.hasAttribute(a))).sort(),
      rows: C.rows().length,
    };
  });
  expect(change.diffType).toBe('split');
  expect(change.columns).toEqual(['data-additions', 'data-deletions']);
  // 32 lines, each drawn twice.
  expect(change.rows).toBe(64);

  const oneSided = await harness.open({ scripts: SCRIPTS });
  await setUp(oneSided, { diffStyle: 'split', type: 'new' });
  const single = await oneSided.evaluate(async () => {
    const { H, C } = window;
    const item = H.cv.getItem(C.id);
    H.cv.updateItem({ ...item, version: item.version + 1, annotations: [
      ...item.annotations,
      { side: 'additions', lineNumber: 105, metadata: { key: 'on-additions', text: 'additions', height: 30 } },
      { side: 'deletions', lineNumber: 110, metadata: { key: 'on-deletions', text: 'deletions', height: 30 } },
    ] });
    H.cv.render(true);
    await H.settle(200);
    const state = (key) => { const el = H.annEls.get(key); return el ? { connected: el.isConnected, height: Math.round(el.getBoundingClientRect().height) } : { built: false }; };
    const hostWidth = H.host(C.id).getBoundingClientRect().width;
    return {
      diffType: C.shadow().querySelector('pre').getAttribute('data-diff-type'),
      columns: [...C.shadow().querySelectorAll('pre code')].map((c) => ['data-unified', 'data-additions', 'data-deletions'].find((a) => c.hasAttribute(a))),
      rows: C.rows().length,
      columnIsFullWidth: Math.round(C.shadow().querySelector('pre code').getBoundingClientRect().width) === Math.round(hostWidth),
      additions: state('on-additions'),
      deletions: state('on-deletions'),
      unifiedToo: null,
      clean: H.auditClean(),
    };
  });
  expect(single.diffType).toBe('single');
  expect(single.columns).toEqual(['data-additions']);
  expect(single.rows).toBe(32);
  // With CONTEXT_CSS the lone column is the whole width (ANNOTATION_CSS alone boxes it into the right half).
  expect(single.columnIsFullWidth).toBe(true);
  expect(single.additions).toEqual({ connected: true, height: 30 });
  // Not laid out: no box, whether or not the vendor attached a wrapper for it.
  expect(single.deletions.height ?? 0).toBe(0);
  expect(single.clean).toBe(true);
});

test('F21: without CONTEXT_CSS the one-sided item is boxed into the right half and its separator controls are hidden', async ({ harness }) => {
  // Why CONTEXT_CSS exists (pierre-styles.js). If this starts failing the
  // vendor or ANNOTATION_CSS changed, and the block may be reducible.
  const page = await harness.open({ scripts: SCRIPTS });
  await setUp(page, { diffStyle: 'split', type: 'new', contextCss: false });
  const result = await page.evaluate(() => {
    const { H, C } = window;
    const host = H.host(C.id).getBoundingClientRect();
    const column = C.shadow().querySelector('pre code').getBoundingClientRect();
    return {
      columnStartsAtHalf: Math.abs(column.left - (host.left + host.width / 2)) <= 2,
      controls: ['up', 'down', 'all'].map((kind) => C.control(1, kind)?.visible ?? null),
    };
  });
  expect(result.columnStartsAtHalf).toBe(true);
  expect(result.controls).toEqual([false, false, false]);
});

test('F22: the vendor renders an "Expand all" control for gaps over expansionLineCount and hides it; none for a smaller gap', async ({ harness }) => {
  // Depends on it: CONTEXT_CSS shows the control on context hosts, which is
  // how a context file keeps its one-click "reveal the whole gap".
  const page = await harness.open({ scripts: SCRIPTS });
  await setUp(page, { contextCss: false });
  const result = await page.evaluate(async () => {
    const { H, C } = window;
    const out = { large: [0, 1, 2].map((i) => { const c = C.control(i, 'all'); return c ? { display: c.display, visible: c.visible, text: c.text } : null; }) };
    // A gap of 15 lines between two ranges (121-135): one control, no "Expand all".
    const item = H.cv.getItem(C.id);
    H.cv.updateItem({ ...item, version: item.version + 1, fileDiff: C.derive([{ startLine: 100, endLine: 120 }, { startLine: 136, endLine: 150 }]) });
    H.cv.render(true);
    await H.until(() => H.instance(C.id).getRenderedDiff() === H.cv.getItem(C.id).fileDiff);
    await H.settle(150);
    out.small = { all: C.control(1, 'all'), both: !!C.control(1, 'both'), up: !!C.control(1, 'up'), down: !!C.control(1, 'down'), label: C.control(1, 'label')?.text ?? null };
    return out;
  });
  expect(result.large).toEqual([
    { display: 'none', visible: false, text: 'Expand all' },
    { display: 'none', visible: false, text: 'Expand all' },
    { display: 'none', visible: false, text: 'Expand all' },
  ]);
  expect(result.small.all).toBeNull();
  expect(result.small.label).toBe('15 unmodified lines');
  // One control that reveals the whole small gap.
  expect([result.small.both, result.small.up, result.small.down].filter(Boolean)).toHaveLength(1);
});

for (const diffStyle of ['unified', 'split']) {
  test(`F22: each expansion control reveals what the bridge's fold expects, by real clicks (${diffStyle})`, async ({ harness }) => {
    // Depends on it: PierreContext.rangesFromExpansionMap (the fold), the
    // visibility oracle, and CONTEXT_CSS in split layout.
    const page = await harness.open({ scripts: SCRIPTS });
    await setUp(page, { diffStyle });
    const state = () => page.evaluate(() => ({ runs: window.C.runs(), map: window.C.map(), ranges: window.PierreContext.rangesFromExpansionMap(window.H.cv.getItem(window.C.id).fileDiff, window.H.instance(window.C.id).hunksRenderer.expandedHunks) }));

    // After the last range: the control reveals the 20 lines next to the range.
    expect((await click(page, 2, 'up')).visible).toBe(true);
    let now = await state();
    expect(now.map).toEqual([[2, 20, 0]]);
    expect(now.ranges).toEqual([{ startLine: 311, endLine: 330 }]);

    // Before the first range: the 20 lines next to it are the END of that gap.
    expect((await click(page, 0, 'down')).visible).toBe(true);
    now = await state();
    expect(now.map).toEqual([[0, 0, 20], [2, 20, 0]]);
    expect(now.ranges).toEqual([{ startLine: 80, endLine: 99 }, { startLine: 311, endLine: 330 }]);

    // Between two ranges: one control per side.
    expect((await click(page, 1, 'up')).visible).toBe(true);
    expect((await click(page, 1, 'down')).visible).toBe(true);
    now = await state();
    expect(now.map[1]).toEqual([1, 20, 20]);
    expect(now.ranges).toEqual([{ startLine: 80, endLine: 99 }, { startLine: 121, endLine: 140 }, { startLine: 280, endLine: 299 }, { startLine: 311, endLine: 330 }]);

    // Shift+click: the whole gap, recorded as Infinity.
    expect((await click(page, 0, 'down', { shift: true })).visible).toBe(true);
    now = await state();
    expect(now.map[0].slice(1)).toContain(Infinity);
    expect(now.ranges[0]).toEqual({ startLine: 1, endLine: 99 });

    // "Expand all", shown by CONTEXT_CSS: a plain click, the whole gap.
    const all = await click(page, 1, 'all');
    expect(all.visible).toBe(true);
    expect(all.text).toBe('Expand all');
    now = await state();
    expect(now.map[1].slice(1)).toContain(Infinity);
    expect(now.ranges).toEqual([{ startLine: 1, endLine: 99 }, { startLine: 121, endLine: 299 }, { startLine: 311, endLine: 330 }]);

    const end = await page.evaluate(async () => ({ unclean: await window.C.walk(), orphans: window.H.orphanHosts() }));
    expect(end).toEqual({ unclean: 0, orphans: 0 });
    expect(harness.validatorErrors(page)).toEqual([]);
  });
}

test('F22: a click on the "N unmodified lines" label reveals expansionLineCount lines at both ends of the gap', async ({ harness }) => {
  const page = await harness.open({ scripts: SCRIPTS });
  await setUp(page);
  const box = await click(page, 1, 'label');
  const result = await page.evaluate(() => ({ map: window.C.map(), clean: window.H.auditClean() }));
  expect(box.text).toBe('179 unmodified lines');
  expect(result.map).toEqual([[1, 20, 20]]);
  expect(result.clean).toBe(true);
});

test('F23: the vendor writes a hunk\'s line starts including the lines hidden right above it, and mergeContextRanges writes the same', async ({ harness }) => {
  // Depends on it: PierreContext.mergeContextRanges, step 6. The formula is
  // read here from the vendor's own output, not from its source.
  const page = await harness.open({ scripts: SCRIPTS });
  const result = await page.evaluate(async () => {
    const H = window.H;
    const P = window.PierreDiffs;
    const { roles } = H.workload;
    H.parse({});
    const follows = (metadata) => {
      let split = 0;
      let unified = 0;
      for (const h of metadata.hunks) {
        if (h.splitLineStart !== split + h.collapsedBefore || h.unifiedLineStart !== unified + h.collapsedBefore) return false;
        split += h.collapsedBefore + h.splitLineCount;
        unified += h.collapsedBefore + h.unifiedLineCount;
      }
      return metadata.hunks.length > 0;
    };
    const partial = H.fileDiffs.find((d) => d.name === roles.large);
    const hydrated = P.hydratePartialDiff('clone', partial, H.contentsOf(roles.large));
    const lastHunk = hydrated.hunks[hydrated.hunks.length - 1];
    const afterLast = lastHunk.additionStart + lastHunk.additionCount + 30;
    const merged = window.PierreContext.mergeContextRanges(hydrated, [{ startLine: 3, endLine: 9 }, { startLine: afterLast, endLine: afterLast + 5 }]);
    const file = { name: 'x.js', contents: `${Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n')}\n` };
    const zero = window.PierreContext.mergeContextRanges(P.parseDiffFromFile(file, { ...file }), [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }]);
    return {
      vendor: { parsed: follows(partial), hydrated: follows(hydrated), hunks: hydrated.hunks.length },
      ours: { onHydrated: follows(merged), added: merged.hunks.length - hydrated.hunks.length, onZeroHunkBase: follows(zero) },
      zeroStarts: zero.hunks.map((h) => [h.collapsedBefore, h.unifiedLineStart, h.splitLineStart]),
    };
  });
  expect(result.vendor).toEqual({ parsed: true, hydrated: true, hunks: expect.any(Number) });
  expect(result.vendor.hunks).toBeGreaterThan(1);
  expect(result.ours).toEqual({ onHydrated: true, added: 2, onZeroHunkBase: true });
  expect(result.zeroStarts).toEqual([[99, 99, 99], [179, 299, 299]]);
});

/**
 * The sequence that found F23: expand the gap between two ranges from both of
 * its ends, then the whole gap before the first range with "Expand all", then
 * walk the item.
 */
async function expandTwiceAndWalk(page) {
  await click(page, 1, 'down');
  await click(page, 1, 'up');
  await click(page, 0, 'all');
  return page.evaluate(async () => ({ unclean: await window.C.walk(), map: window.C.map() }));
}

for (const diffStyle of ['unified', 'split']) {
  for (const type of ['new', 'change']) {
    test(`F23: with the vendor's line starts the layout is exact after manual expansions (${diffStyle}, typed "${type}")`, async ({ harness }) => {
      // Depends on it: PierreContext.mergeContextRanges writes these starts,
      // for a context file (typed 'new') and for a revealed range of a
      // changed file (typed 'change').
      const page = await harness.open({ scripts: SCRIPTS });
      await setUp(page, { diffStyle, type: type === 'new' ? 'new' : null, longLines: true });
      const result = await expandTwiceAndWalk(page);
      expect(result.map).toEqual([[0, Infinity, Infinity], [1, 20, 20]]);
      expect(result.unclean).toBe(0);
      expect(harness.validatorErrors(page)).toEqual([]);
    });
  }

  test(`F23 (constraint): with line starts that leave out a hunk's own hidden lines the same expansions leave the layout a row off, for good (${diffStyle})`, async ({ harness }) => {
    // What pierre-context.js wrote before its correction. A non-virtualized
    // FileDiff has no layout to disagree with; CodeView does: it keeps the
    // measured height of a wrapped line by the line's index in the layout,
    // which it takes from these fields. The file has wrapped lines for that
    // reason; with rows of the estimated height only, nothing shows.
    const page = await harness.open({ scripts: SCRIPTS });
    harness.allowErrors(page, VALIDATOR_PATTERN);
    await setUp(page, { diffStyle, type: null, lineStarts: 'without-own-gap', longLines: true });
    const result = await expandTwiceAndWalk(page);
    expect(result.map).toEqual([[0, Infinity, Infinity], [1, 20, 20]]);
    expect(result.unclean).toBeGreaterThan(0);
    expect(harness.validatorErrors(page).length).toBeGreaterThan(0);
  });
}

test('F24: a list replace with an item inserted above the reader keeps the line, the typed text with its caret and focus, and the selection; the expansion map is empty afterwards', async ({ harness }) => {
  // Depends on it: PierreCodeViewBridge._writeList / _captureView /
  // _restoreView, and the fold of manual expansions in reconcile.
  const page = await harness.open({ scripts: SCRIPTS });
  await setUp(page, { pool: true, extraItems: 28 });
  await click(page, 2, 'up');
  const setup = await page.evaluate(async () => {
    const { H, C } = window;
    const item = H.cv.getItem(C.id);
    H.cv.updateItem({ ...item, version: item.version + 1, annotations: [...item.annotations, { side: 'additions', lineNumber: 305, metadata: { key: 'form', kind: 'form' } }] });
    H.cv.render(true);
    H.cv.scrollTo({ type: 'line', id: C.id, lineNumber: 303, side: 'additions', align: 'start', offset: 37 });
    await H.settle(300);
    H.cv.setSelectedLines({ id: C.id, range: { start: 307, end: 309, side: 'additions' } });
    await H.settle(150);
    return { mapBefore: C.map() };
  });
  expect(setup.mapBefore).toEqual([[2, 20, 0]]);
  await page.locator('textarea[data-ann-key="form"]').click();
  await page.keyboard.type('a comment being typed');

  const result = await page.evaluate(async () => {
    const { H, C } = window;
    const textarea = H.annEls.get('form').querySelector('textarea');
    textarea.setSelectionRange(4, 9);
    const first = C.rows().find((row) => H.viewportTopOf(row) >= 40);
    const line = { n: Number(first.getAttribute('data-line')), top: H.viewportTopOf(first) };
    const selection = H.cv.getSelectedLines();
    const tokensBefore = Object.fromEntries(H.mounted().map((id) => [id, H.shape(id).tokens]));
    const untouched = H.mounted().find((id) => id !== C.id && tokensBefore[id] > 0);

    // One item inserted above, and the context item re-keyed (as a fold does).
    const next = H.items.slice();
    next.splice(0, 0, H.makeFileItem('inserted-above', 60));
    const contextIndex = next.findIndex((i) => i.id === C.id);
    next[contextIndex] = { ...H.cv.getItem(C.id), fileDiff: C.derive([{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 330 }]) };
    const t0 = performance.now();
    H.cv.setItems([]);
    H.cv.setItems(next);
    H.items = next;
    H.cv.render(true);
    const focusAfterReplace = document.activeElement === textarea;
    H.cv.scrollTo({ type: 'line', id: C.id, lineNumber: line.n, side: 'additions', align: 'start', offset: line.top - 40 });
    H.cv.render(true);
    H.cv.setSelectedLines(selection);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(4, 9);
    const ms = performance.now() - t0;
    const row = () => H.findRow(C.id, line.n, 'additions');
    const sameTask = {
      moved: row() ? H.viewportTopOf(row()) - line.top : null,
      connected: textarea.isConnected,
      value: textarea.value,
      focused: document.activeElement === textarea,
      caret: [textarea.selectionStart, textarea.selectionEnd],
      untouchedTokens: untouched ? H.shape(untouched).tokens : null,
      rekeyedTokens: H.shape(C.id).tokens,
    };
    await H.settle(400);
    return {
      ms, focusAfterReplace, sameTask, untouched: !!untouched,
      after: { moved: H.viewportTopOf(row()) - line.top, selection: H.cv.getSelectedLines(), map: C.map(), rekeyedTokens: H.shape(C.id).tokens, orphans: H.orphanHosts(), clean: H.auditClean() },
      selection,
    };
  });
  expect(result.untouched).toBe(true);
  // The replace alone drops the focus: the bridge puts it back.
  expect(result.focusAfterReplace).toBe(false);
  expect(result.sameTask).toMatchObject({ moved: 0, connected: true, value: 'a comment being typed', focused: true, caret: [4, 9] });
  // Unchanged metadata and key: highlighted in the same task. Re-keyed: plain until the worker answers.
  expect(result.sameTask.untouchedTokens).toBeGreaterThan(0);
  expect(result.sameTask.rekeyedTokens).toBe(0);
  expect(result.after.rekeyedTokens).toBeGreaterThan(0);
  expect(result.after.moved).toBe(0);
  expect(result.after.selection).toEqual(result.selection);
  // New instances: what was expanded by hand is gone unless it was folded into the ranges.
  expect(result.after.map).toEqual([]);
  expect(result.after.orphans).toBe(0);
  expect(result.after.clean).toBe(true);
  await harness.record('F24-list-replace', { items: 31, pool: true, ms: Math.round(result.ms * 10) / 10 });
});

test('F25: the vendor counts lines as an editor does, and an empty file has none', async ({ harness }) => {
  // Depends on it: a context file that ends in a newline has one line fewer
  // than main's content.split('\n') gives it; no size cap is needed.
  const page = await harness.open({ scripts: SCRIPTS });
  const result = await page.evaluate(() => {
    const P = window.PierreDiffs;
    const count = (contents) => {
      const file = { name: 'a.txt', contents };
      const diff = P.parseDiffFromFile(file, { ...file });
      return { lines: diff.additionLines.length, hunks: diff.hunks.length, partial: diff.isPartial };
    };
    const t0 = performance.now();
    const big = count(`${Array.from({ length: 20000 }, (_, i) => `line ${i + 1} ${'x'.repeat(70)}`).join('\n')}\n`);
    return {
      withFinalNewline: count('one\ntwo\nthree\n'),
      withoutFinalNewline: count('one\ntwo\nthree'),
      empty: count(''),
      onlyNewline: count('\n'),
      big,
      bigMs: performance.now() - t0,
      mainsCount: 'one\ntwo\nthree\n'.split('\n').length,
    };
  });
  expect(result.withFinalNewline).toEqual({ lines: 3, hunks: 0, partial: false });
  expect(result.withoutFinalNewline).toEqual({ lines: 3, hunks: 0, partial: false });
  expect(result.empty).toEqual({ lines: 0, hunks: 0, partial: false });
  expect(result.onlyNewline.lines).toBe(1);
  expect(result.big.lines).toBe(20000);
  expect(result.mainsCount).toBe(4);
  await harness.record('F25-parse-cost', { lines: 20000, ms: Math.round(result.bigMs * 10) / 10 });
});
