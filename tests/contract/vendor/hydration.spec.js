// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: partial (patch-derived) diffs, hydration, context
 * expansion.
 *
 * Facts (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F15  hydratePartialDiff works for change / rename-changed, throws for new,
 *        deleted and zero-hunk change diffs; a pure rename stays header-only
 *   F17  expandHunk on a partial diff throws without loadDiffFiles;
 *        onHunkExpand is not forwarded; the expansion map survives a fileDiff
 *        replacement, keyed by hunk index
 *   F19  a zero-change base plus PierreContext.mergeContextRanges renders
 *        range chunks with expand controls
 * and decision D5: hydration keeps git's hunks, so nothing shifts.
 */

import { test, expect } from '../harness/contract-test.js';

const CONTEXT_MODULE = '/app/js/modules/pierre-context.js';

test('F15: hydratePartialDiff by diff type', async ({ harness }) => {
  // Depends on it: PierreBridge.upgradeFileContents derives metadata per type:
  // hydrate for change / rename-changed, "mark upgraded, no derivation" for
  // new, deleted and zero-hunk items.
  const page = await harness.open();
  const result = await page.evaluate(() => {
    const H = window.H;
    const { roles } = H.workload;
    H.parse({});
    const byName = Object.fromEntries(H.fileDiffs.map((d) => [d.name, d]));
    const attempt = (role, files) => {
      const diff = byName[roles[role]];
      try {
        const hydrated = window.PierreDiffs.hydratePartialDiff('clone', diff, files || H.contentsOf(diff.name));
        return {
          type: hydrated.type,
          isPartial: hydrated.isPartial,
          hunks: hydrated.hunks.length,
          sameObject: hydrated === diff,
          inputStillPartial: diff.isPartial,
        };
      } catch (e) {
        return { threw: String(e.message) };
      }
    };
    return {
      change: attempt('large'),
      renameChanged: attempt('renameChanged'),
      added: attempt('added'),
      deleted: attempt('deleted'),
      binaryNoContents: attempt('binary'),
      modeOnlyNoOld: attempt('modeOnly', { oldFile: null, newFile: H.contentsOf(roles.modeOnly).newFile }),
      renamePureBothFiles: attempt('renamePure'),
      renamePureNullOld: attempt('renamePure', { oldFile: null, newFile: H.contentsOf(roles.renamePure).newFile }),
    };
  });

  expect(result.change).toEqual({ type: 'change', isPartial: false, hunks: 3, sameObject: false, inputStillPartial: true });
  expect(result.renameChanged).toEqual({ type: 'rename-changed', isPartial: false, hunks: 1, sameObject: false, inputStillPartial: true });
  expect(result.added.threw).toMatch(/new diffs cannot be hydrated/);
  expect(result.deleted.threw).toMatch(/deleted diffs cannot be hydrated/);
  expect(result.binaryNoContents.threw).toMatch(/requires oldFile/);
  expect(result.modeOnlyNoOld.threw).toMatch(/requires oldFile/);
  expect(result.renamePureBothFiles.threw).toMatch(/requires oldFile to be null/);
  // Hydrating a pure rename is possible with oldFile: null, and it stays row-less.
  expect(result.renamePureNullOld).toEqual({ type: 'rename-pure', isPartial: false, hunks: 0, sameObject: false, inputStillPartial: true });
});

test('F15: row-less items (binary, mode-only, pure rename, empty added) are header-only', async ({ harness }) => {
  // Depends on it: files without a renderable patch are still items, so the
  // list is complete and ordered; any message main shows for them is a
  // `notice` annotation at lineNumber 0.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const ids = [roles.binary, roles.modeOnly, roles.renamePure, roles.emptyAdded];
    await H.appLike({ build: { only: [...ids, roles.noNewline] } });
    return {
      shapes: ids.map((id) => ({ hasPre: H.shape(id).hasPre, rows: H.shape(id).rows, height: H.itemHeight(id) })),
      clean: H.auditClean(),
    };
  });
  for (const shape of result.shapes) expect(shape).toEqual({ hasPre: false, rows: 0, height: 40 });
  expect(result.clean).toBe(true);
});

test('parseDiffFromFile(empty, empty) yields a zero-hunk diff that renders as a header-only item', async ({ harness }) => {
  // Depends on it: metadata for a file with no patch text at all is built by
  // the vendor, never by hand (plan section 3.3).
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const empty = { name: 'no/patch.txt', contents: '' };
    const diff = window.PierreDiffs.parseDiffFromFile(empty, empty);
    H.parse({});
    H.buildItems({ only: [H.workload.roles.noNewline] });
    H.items.unshift({ id: 'no/patch.txt', type: 'diff', fileDiff: diff, annotations: [], version: 0 });
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS);
    H.cv.setItems(H.items);
    await H.settle();
    return {
      name: diff.name,
      type: diff.type,
      hunks: diff.hunks.length,
      hasLineArrays: Array.isArray(diff.additionLines) && Array.isArray(diff.deletionLines),
      shape: H.shape('no/patch.txt'),
      height: H.itemHeight('no/patch.txt'),
      clean: H.auditClean(),
    };
  });
  expect(result.name).toBe('no/patch.txt');
  expect(result.hunks).toBe(0);
  expect(result.hasLineArrays).toBe(true);
  expect(result.shape.hasPre).toBe(false);
  expect(result.height).toBe(40);
  expect(result.clean).toBe(true);
});

test('D5: hydration keeps the patch hunks, adds expand controls, and shifts no rendered row', async ({ harness }) => {
  // Depends on it: PierreBridge.upgradeFileContents. Main's patchParityRanges
  // exists because a re-diff changes hunks; hydration leaves nothing to fix.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({ build: { only: [T, roles.noNewline] } });
    const base = H.cv.getItem(T).fileDiff;
    const rowSnapshot = () => [...H.host(T).shadowRoot.querySelectorAll('[data-content] > [data-line]')]
      .map((row) => `${row.getAttribute('data-line-type')}:${row.getAttribute('data-line')}:${row.textContent}`);
    const before = { shape: H.shape(T), rows: rowSnapshot() };
    const reference = H.findRow(T, base.hunks[0].additionStart + 1);
    const referenceLine = Number(reference.getAttribute('data-line'));
    const topBefore = H.viewportTopOf(reference);

    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', base, H.contentsOf(T));
    const range = (h) => `${h.deletionStart},${h.deletionCount},${h.additionStart},${h.additionCount}`;
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    await H.settle();
    const rowsAfter = rowSnapshot();
    return {
      hunksIdentical: base.hunks.map(range).join('|') === hydrated.hunks.map(range).join('|'),
      before: before.shape,
      after: H.shape(T),
      // Every patch row is still rendered, in the same order.
      patchRowsKept: before.rows.every((row) => rowsAfter.includes(row)) && rowsAfter.length >= before.rows.length,
      referenceShift: H.viewportTopOf(H.findRow(T, referenceLine)) - topBefore,
      trailingSeparatorAdded: H.shape(T).separators - before.shape.separators,
      clean: H.auditClean(),
    };
  });
  expect(result.hunksIdentical).toBe(true);
  // Partial diff: separators without controls. Hydrated: controls in the gutter column.
  expect(result.before.expandButtons).toBe(0);
  expect(result.after.expandButtons).toBeGreaterThan(0);
  expect(result.patchRowsKept).toBe(true);
  expect(result.referenceShift).toBe(0);
  expect(result.trailingSeparatorAdded).toBeGreaterThanOrEqual(0);
  expect(result.clean).toBe(true);
});

test('F17: expandHunk on a partial diff throws without loadDiffFiles', async ({ harness }) => {
  // Depends on it: the bridge never calls expandHunk on a partial diff, and
  // does not pass loadDiffFiles (it would show expand controls on every
  // partial diff at once, which main does not).
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({ build: { only: [T] } });
    const instance = H.instance(T);
    let message = null;
    try { await instance.expandHunk(1, 'up', 10); } catch (e) { message = String(e.message); }
    return { isPartial: H.cv.getItem(T).fileDiff.isPartial, message, revealLine: instance.revealLine(H.cv.getItem(T).fileDiff.hunks[1].additionStart - 30) };
  });
  expect(result.isPartial).toBe(true);
  expect(result.message).toMatch(/loadDiffFiles is required/);
  expect(result.revealLine).toBe(false);
});

test('F17: a click on an expand control expands the gap, and onHunkExpand passed to CodeView is never called', async ({ harness }) => {
  // Depends on it: the bridge does not pass onHunkExpand; anything that must
  // follow a manual expansion (split stretch re-sync, visibility answers)
  // reads the instance's expansion map from onPostRender instead.
  const page = await harness.open();
  const info = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    H.hooks.onHunkExpand = () => {};
    H.parse({});
    H.buildItems({ only: [T] });
    H.items[0].fileDiff = window.PierreDiffs.hydratePartialDiff('clone', H.items[0].fileDiff, H.contentsOf(T));
    H.create({ ...H.APP_OPTIONS, pointerEventsOnScroll: true }, [...H.APP_CALLBACKS, 'onHunkExpand']);
    H.cv.setItems(H.items);
    await H.settle();
    const firstHunk = H.items[0].fileDiff.hunks[0];
    H.cv.scrollTo({ type: 'line', id: T, lineNumber: firstHunk.additionStart + firstHunk.additionCount - 1, side: 'additions', align: 'center' });
    await H.settle();
    // The clickable control is the one in the gutter column.
    const button = H.host(T).shadowRoot.querySelector('[data-gutter] > [data-separator][data-expand-index="1"] [data-expand-button][data-expand-up]');
    const contentTwin = H.host(T).shadowRoot.querySelector('[data-content] > [data-separator][data-expand-index="1"] [data-expand-button]');
    const box = button.getBoundingClientRect();
    return {
      T,
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      height: H.itemHeight(T),
      contentTwinVisible: !!(contentTwin && contentTwin.getBoundingClientRect().width > 0),
    };
  });
  expect(info.contentTwinVisible).toBe(false);

  await page.mouse.click(info.x, info.y);
  await expect.poll(() => page.evaluate((T) => window.H.instance(T).hunksRenderer.expandedHunks.size, info.T)).toBe(1);
  const after = await page.evaluate(async (T) => {
    const H = window.H;
    await H.settle();
    const renderer = H.instance(T).hunksRenderer;
    return {
      onHunkExpandCalls: H.counts.onHunkExpand || 0,
      expansion: renderer.getExpandedHunk(1),
      mapEntries: [...renderer.expandedHunks.entries()].map(([index, region]) => [index, region.fromStart, region.fromEnd]),
      expandedRows: H.host(T).shadowRoot.querySelectorAll('[data-content] > [data-line-type="context-expanded"]').length,
      height: H.itemHeight(T),
      clean: H.auditClean(),
    };
  }, info.T);
  // expansionLineCount is 20: at least 20 more rows of 20 px (more when a
  // revealed line wraps). The DOM row count is not a measure of it, because
  // only a window of an item's rows is rendered.
  expect(after.height - info.height).toBeGreaterThanOrEqual(400);
  expect(after.onHunkExpandCalls).toBe(0);
  expect(after.expandedRows).toBeGreaterThan(0);
  expect(after.mapEntries.length).toBe(1);
  expect(after.mapEntries[0][0]).toBe(1);
  expect(after.mapEntries[0][1] + after.mapEntries[0][2]).toBe(20);
  expect(after.expansion.fromStart + after.expansion.fromEnd).toBe(20);
  expect(after.clean).toBe(true);
});

test('F17: the expansion map survives a fileDiff replacement, keyed by hunk index', async ({ harness }) => {
  // Depends on it: PierreBridge.addContextRanges folds manual expansions into
  // ranges (_getExpandedContextRanges) and CLEARS
  // instance.hunksRenderer.expandedHunks before publishing metadata whose
  // hunks differ. Otherwise an expansion of gap 1 is re-applied to whatever
  // hunk has index 1 in the new metadata.
  const page = await harness.open({ scripts: [CONTEXT_MODULE] });
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    H.parse({});
    H.buildItems({ only: [T] });
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', H.items[0].fileDiff, H.contentsOf(T));
    H.items[0].fileDiff = hydrated;
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS);
    H.cv.setItems(H.items);
    await H.settle();
    const instance = H.instance(T);
    await instance.expandHunk(1, 'up', 10);
    H.cv.render(true);
    await H.settle();
    const entries = () => [...instance.hunksRenderer.expandedHunks.entries()].map(([index, region]) => [index, region.fromStart, region.fromEnd]);
    const before = entries();
    // New metadata with one more hunk BEFORE hunk 1: indices shift.
    const first = hydrated.hunks[0];
    const start = first.additionStart + first.additionCount + 40;
    const merged = window.PierreContext.mergeContextRanges(hydrated, [{ startLine: start, endLine: start + 5 }]);
    H.update(T, { fileDiff: merged });
    H.cv.render(true);
    await H.settle();
    const after = entries();
    instance.hunksRenderer.expandedHunks.clear();
    return { before, after, hunksBefore: hydrated.hunks.length, hunksAfter: merged.hunks.length, cleared: entries() };
  });
  expect(result.hunksAfter).toBe(result.hunksBefore + 1);
  expect(result.before.length).toBe(1);
  expect(result.before[0][0]).toBe(1);
  // Same index, same counts, although index 1 is now a different gap.
  expect(result.after).toEqual(result.before);
  expect(result.cleared).toEqual([]);
});

test('PierreContext.mergeContextRanges output renders through updateItem, with native expansion still working', async ({ harness }) => {
  // Depends on it: PierreBridge.addContextRanges (programmatic reveal of
  // arbitrary non-contiguous ranges) with main's pierre-context.js unchanged.
  const page = await harness.open({ scripts: [CONTEXT_MODULE] });
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    H.parse({});
    H.buildItems({ only: [T] });
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', H.items[0].fileDiff, H.contentsOf(T));
    H.items[0].fileDiff = hydrated;
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS);
    H.cv.setItems(H.items);
    await H.settle();
    const first = hydrated.hunks[0];
    const a = first.additionStart + first.additionCount + 50;
    const b = a + 300;
    const merged = window.PierreContext.mergeContextRanges(hydrated, [{ startLine: a, endLine: a + 9 }, { startLine: b, endLine: b + 4 }]);
    const keys = (o) => Object.keys(o).sort().join(',');
    H.update(T, { fileDiff: merged });
    H.cv.render(true);
    H.cv.scrollTo({ type: 'line', id: T, lineNumber: a + 2, side: 'additions', align: 'center' });
    await H.settle();
    const out = {
      hunks: [hydrated.hunks.length, merged.hunks.length],
      sameTopLevelKeys: keys(hydrated) === keys(merged),
      insideA: !!H.findRow(T, a + 2),
      justOutsideA: !!H.findRow(T, a + 20),
      rowType: H.findRow(T, a + 2).getAttribute('data-line-type'),
      landing: H.viewportTopOf(H.findRow(T, a + 2)) - (H.root.clientHeight - 20) / 2,
    };
    H.cv.scrollTo({ type: 'line', id: T, lineNumber: b + 2, side: 'additions', align: 'center' });
    await H.settle();
    out.insideB = !!H.findRow(T, b + 2);
    // Native expansion on the merged metadata.
    const rows = H.shape(T).rows;
    await H.instance(T).expandHunk(1, 'down', 10);
    H.cv.render(true);
    await H.settle();
    out.nativeExpansionAdded = H.shape(T).rows - rows;
    out.clean = H.auditClean();
    return out;
  });
  expect(result.hunks[1]).toBe(result.hunks[0] + 2);
  expect(result.sameTopLevelKeys).toBe(true);
  expect(result.insideA).toBe(true);
  expect(result.justOutsideA).toBe(false);
  expect(result.rowType).toBe('context');
  expect(result.landing).toBe(0);
  expect(result.insideB).toBe(true);
  expect(result.nativeExpansionAdded).toBeGreaterThan(0);
  expect(result.clean).toBe(true);
});

test('F19: a zero-change base from parseDiffFromFile(file, file) plus mergeContextRanges renders range chunks', async ({ harness }) => {
  // Depends on it: nothing in the plan as written (context files use the
  // legacy renderer in the footer, decision D2). It is the costed alternative
  // if D2 is not accepted, and it needs no private API.
  const page = await harness.open({ scripts: [CONTEXT_MODULE] });
  const result = await page.evaluate(async () => {
    const H = window.H;
    const plain = H.workload.plain[0];
    const file = { name: plain.name, contents: plain.contents };
    const base = window.PierreDiffs.parseDiffFromFile(file, file);
    const merged = window.PierreContext.mergeContextRanges(base, [{ startLine: 10, endLine: 20 }, { startLine: 60, endLine: 75 }]);
    H.parse({});
    H.buildItems({ only: [H.workload.roles.noNewline] });
    const id = `context:${plain.name}`;
    H.items.push({ id, type: 'diff', fileDiff: merged, annotations: [], version: 0 });
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS);
    H.cv.setItems(H.items);
    H.cv.scrollTo({ type: 'item', id });
    await H.until(() => !!H.host(id));
    await H.settle();
    const rows = [...H.host(id).shadowRoot.querySelectorAll('[data-content] > [data-line]')];
    return {
      base: { type: base.type, hunks: base.hunks.length, isPartial: base.isPartial },
      mergedHunks: merged.hunks.length,
      rowCount: rows.length,
      firstLine: Number(rows[0].getAttribute('data-line')),
      lineTypes: [...new Set(rows.map((row) => row.getAttribute('data-line-type')))],
      shape: H.shape(id),
      clean: H.auditClean(),
    };
  });
  expect(result.base).toEqual({ type: 'change', hunks: 0, isPartial: false });
  expect(result.mergedHunks).toBe(2);
  expect(result.rowCount).toBe(27);
  expect(result.firstLine).toBe(10);
  expect(result.lineTypes).toEqual(['context']);
  expect(result.shape.expandButtons).toBeGreaterThan(0);
  expect(result.clean).toBe(true);
});
