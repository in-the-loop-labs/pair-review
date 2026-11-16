// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: the internals the bridge reads.
 *
 * None of these is documented API. They are the same exposure main's bridge
 * has today (plans/codeview-virtualized-diff.md, Hazards, "Vendor internals
 * the bridge reads"); pinning them here turns a silent break on a vendor bump
 * into a failing test with the dependent function's name next to it.
 */

import { test, expect } from '../harness/contract-test.js';

test('instance.getLineIndex maps a line to [unified, split] row indices, and answers for hidden lines too', async ({ harness }) => {
  // Depends on it: PierreBridge._queryLineElement and scrollToLine / _flashLine
  // (the pair equals the row's data-line-index).
  //
  // It is NOT a "this line is displayed" test: it extrapolates an index for a
  // line inside a collapsed gap. The plan's first draft of whenLineDisplayed
  // used `getLineIndex(...) != null`; the signals that do answer that question
  // are pinned in the next test.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.medium;
    await H.appLike({ build: { only: [T] } });
    const instance = H.instance(T);
    const hunks = H.item(T).fileDiff.hunks;
    const line = hunks[0].additionStart + 1;
    const indices = instance.getLineIndex(line, 'additions');
    const row = H.findRow(T, line, 'additions');
    const last = hunks[hunks.length - 1];
    const hiddenLine = last.additionStart + last.additionCount + 500;
    return {
      isPair: Array.isArray(indices) && indices.length === 2,
      rowIndexAttr: row.getAttribute('data-line-index'),
      joined: indices.join(','),
      hiddenLineRendered: !!H.findRow(T, hiddenLine),
      hiddenLineIndexIsPair: Array.isArray(instance.getLineIndex(hiddenLine, 'additions')),
    };
  });
  expect(result.isPair).toBe(true);
  expect(result.joined).toBe(result.rowIndexAttr);
  expect(result.hiddenLineRendered).toBe(false);
  expect(result.hiddenLineIndexIsPair).toBe(true);
});

test('instance.getRenderedDiff is the DISPLAYED diff; isLineRenderable follows it, but only on a hydrated diff', async ({ harness }) => {
  // Depends on it: PierreBridge.whenLineDisplayed. While a worker-pool swap is
  // pending, the item and instance.fileDiff already hold the new metadata but
  // the instance still displays the old one. The bridge can tell with
  // `instance.getRenderedDiff() === <the metadata it last published>`; once
  // that holds, its own metadata oracle (isLineVisible) describes the screen.
  // isLineRenderable is not usable alone: on a partial diff it says true for
  // a line hidden in a gap.
  const page = await harness.open({ scripts: ['/app/js/modules/pierre-context.js'] });
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({ parse: { cacheKeyPrefix: 'contract:1' }, build: { only: [T, roles.noNewline] }, pool: true });
    // Not yet mounted reads as "not yet": with the pool nothing is mounted
    // until its workers are up (G7), which under load is after the bring-up's
    // quiet period.
    await H.until(() => (H.shape(T)?.tokens ?? 0) > 0, 30000);
    const instance = H.instance(T);
    const base = H.cv.getItem(T).fileDiff;
    const first = base.hunks[0];
    const visibleLine = first.additionStart + 1;
    const gapLine = first.additionStart + first.additionCount + 30;
    const out = {};
    out.partial = {
      renderedIsBase: instance.getRenderedDiff() === base,
      visibleLine: instance.isLineRenderable(visibleLine),
      // On a PARTIAL diff the vendor cannot know and answers true for a hidden line.
      gapLine: instance.isLineRenderable(gapLine),
      gapLineRowInDom: !!H.findRow(T, gapLine),
    };
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', base, H.contentsOf(T));
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    await H.until(() => instance.getRenderedDiff() === hydrated, 30000);
    out.hydrated = { gapLine: instance.isLineRenderable(gapLine), visibleLine: instance.isLineRenderable(visibleLine) };

    const revealed = {
      ...window.PierreContext.mergeContextRanges(hydrated, [{ startLine: gapLine, endLine: gapLine + 9 }]),
      cacheKey: `${hydrated.cacheKey}|d1`,
    };
    H.update(T, { fileDiff: revealed });
    H.cv.render(true);
    out.pending = {
      itemHasNew: H.cv.getItem(T).fileDiff === revealed,
      inputIsNew: instance.fileDiff === revealed,
      renderedIsNew: instance.getRenderedDiff() === revealed,
      gapLine: instance.isLineRenderable(gapLine),
    };
    const landed = await H.until(() => instance.getRenderedDiff() === revealed, 30000);
    out.landed = {
      ok: landed.ok,
      framesWaited: landed.frames > 0,
      gapLine: instance.isLineRenderable(gapLine),
      rowInDom: !!H.findRow(T, gapLine),
      beyondTheRange: instance.isLineRenderable(gapLine + 40),
    };
    return out;
  });
  expect(result.partial).toEqual({ renderedIsBase: true, visibleLine: true, gapLine: true, gapLineRowInDom: false });
  expect(result.hydrated).toEqual({ gapLine: false, visibleLine: true });
  expect(result.pending).toEqual({ itemHasNew: true, inputIsNew: true, renderedIsNew: false, gapLine: false });
  expect(result.landed).toEqual({ ok: true, framesWaited: true, gapLine: true, rowInDom: true, beyondTheRange: false });
});

for (const diffStyle of ['unified', 'split']) {
  test(`shadow DOM row model (${diffStyle})`, async ({ harness }) => {
    // Depends on it: PierreBridge._getHoveredRow / _codeColumnsForSide /
    // _applySplitAnnotationLayout, ANNOTATION_CSS selectors, and
    // tests/e2e/diff-dom.js (the only E2E file that knows vendor DOM).
    const page = await harness.open();
    const result = await page.evaluate(async (diffStyle) => {
      const H = window.H;
      const { roles } = H.workload;
      const T = roles.noNewline;
      await H.appLike({ build: { only: [T, roles.added] }, options: { diffStyle } });
      const hunk = H.item(T).fileDiff.hunks[0];
      H.update(T, { annotations: [{ side: 'additions', lineNumber: hunk.additionStart + 3, metadata: { key: 'card' } }] });
      H.cv.render(true);
      await H.settle();
      const root = H.host(T).shadowRoot;
      const pre = root.querySelector('pre');
      const rows = [...root.querySelectorAll('[data-content] > [data-line]')];
      const gutterCells = [...root.querySelectorAll('[data-gutter] > [data-column-number]')];
      const wrappers = [...root.querySelectorAll('[data-line-annotation]')];
      const withSlot = wrappers.filter((w) => w.querySelector('slot'));
      const addedPre = H.host(roles.added).shadowRoot.querySelector('pre');
      return {
        preAttrs: { diff: pre.hasAttribute('data-diff'), diffType: pre.getAttribute('data-diff-type'), overflow: pre.getAttribute('data-overflow') },
        codeColumns: [...pre.querySelectorAll('code[data-code]')].map((code) => (
          code.hasAttribute('data-unified') ? 'unified' : code.hasAttribute('data-deletions') ? 'deletions' : code.hasAttribute('data-additions') ? 'additions' : '?'
        )),
        lineTypes: [...new Set(rows.map((row) => row.getAttribute('data-line-type')))].sort(),
        everyRowHasCompositeIndex: rows.every((row) => /^\d+,\d+$/.test(row.getAttribute('data-line-index'))),
        contextRowsHaveAltLine: rows.filter((row) => row.getAttribute('data-line-type') === 'context').every((row) => row.hasAttribute('data-alt-line')),
        gutterCellsMatchRows: gutterCells.length === rows.length && gutterCells.every((cell) => cell.hasAttribute('data-line-type') && /^\d+,\d+$/.test(cell.getAttribute('data-line-index'))),
        gutterCellsHaveNoDataLine: gutterCells.every((cell) => !cell.hasAttribute('data-line')),
        annotationWrappers: wrappers.length,
        slotName: withSlot.length === 1 ? withSlot[0].querySelector('slot').getAttribute('name') : null,
        annotationIndexAttr: withSlot.length === 1 ? /^\d+,\d+$/.test(withSlot[0].getAttribute('data-line-annotation')) : false,
        lightDomSlot: H.annEls.get('card').parentElement.getAttribute('slot'),
        lightDomWrapperIsHostChild: H.annEls.get('card').parentElement.parentElement === H.host(T),
        lightDomWrapperAttr: H.annEls.get('card').parentElement.hasAttribute('data-annotation-slot'),
        // An all-added file has one column in either style.
        addedFile: {
          diffType: addedPre.getAttribute('data-diff-type'),
          columns: addedPre.querySelectorAll('code[data-code]').length,
          column: addedPre.querySelector('code[data-additions]') ? 'additions' : addedPre.querySelector('code[data-unified]') ? 'unified' : '?',
        },
        expectedSlot: `annotation-additions-${hunk.additionStart + 3}`,
      };
    }, diffStyle);

    expect(result.preAttrs).toEqual({ diff: true, diffType: diffStyle === 'split' ? 'split' : 'single', overflow: 'wrap' });
    expect(result.codeColumns).toEqual(diffStyle === 'split' ? ['deletions', 'additions'] : ['unified']);
    expect(result.lineTypes).toEqual(['change-addition', 'change-deletion', 'context']);
    expect(result.everyRowHasCompositeIndex).toBe(true);
    expect(result.contextRowsHaveAltLine).toBe(true);
    expect(result.gutterCellsMatchRows).toBe(true);
    expect(result.gutterCellsHaveNoDataLine).toBe(true);
    // Split: the opposite column gets an empty spacer wrapper without a slot.
    expect(result.annotationWrappers).toBe(diffStyle === 'split' ? 2 : 1);
    expect(result.slotName).toBe(result.expectedSlot);
    expect(result.annotationIndexAttr).toBe(true);
    expect(result.lightDomSlot).toBe(result.expectedSlot);
    expect(result.lightDomWrapperIsHostChild).toBe(true);
    expect(result.lightDomWrapperAttr).toBe(true);
    // In split style its lone column is the additions column, not a unified one.
    expect(result.addedFile).toEqual({ diffType: 'single', columns: 1, column: diffStyle === 'split' ? 'additions' : 'unified' });
  });
}

test('FileDiffMetadata carries the fields pierre-context.js and the visibility oracle read', async ({ harness }) => {
  // Depends on it: PierreContext.mergeContextRanges, PierreBridge.isLineVisible
  // / convertOldToNew / computeDiffPositions, hunk-summary anchoring.
  const page = await harness.open();
  const result = await page.evaluate(() => {
    const H = window.H;
    const { roles } = H.workload;
    H.parse({ cacheKeyPrefix: 'contract:1' });
    const partial = H.fileDiffs.find((d) => d.name === roles.large);
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', partial, H.contentsOf(roles.large));
    const has = (object, keys) => keys.filter((key) => !(key in object));
    const topLevel = ['name', 'type', 'hunks', 'isPartial', 'additionLines', 'deletionLines', 'unifiedLineCount', 'splitLineCount', 'cacheKey'];
    const hunkKeys = ['additionStart', 'additionCount', 'additionLines', 'additionLineIndex', 'deletionStart', 'deletionCount', 'deletionLines', 'deletionLineIndex', 'collapsedBefore', 'unifiedLineStart', 'unifiedLineCount', 'splitLineStart', 'splitLineCount', 'hunkContent'];
    const contentShapes = new Set();
    for (const hunk of hydrated.hunks) {
      for (const part of hunk.hunkContent) contentShapes.add(`${part.type}:${Object.keys(part).sort().join(',')}`);
    }
    const second = hydrated.hunks[1];
    const first = hydrated.hunks[0];
    return {
      missingTopLevelPartial: has(partial, topLevel),
      missingTopLevelHydrated: has(hydrated, topLevel),
      missingHunkKeys: has(second, hunkKeys),
      contentShapes: [...contentShapes].sort(),
      // collapsedBefore is the number of hidden lines between this hunk and the previous one.
      collapsedBeforeIsGap: second.collapsedBefore === second.additionStart - (first.additionStart + first.additionCount),
      hydratedHasWholeFile: hydrated.additionLines.length === H.workload.files[roles.large].new.split('\n').length - 1,
      partialHasOnlyPatchLines: partial.additionLines.length < hydrated.additionLines.length,
    };
  });
  expect(result.missingTopLevelPartial).toEqual([]);
  expect(result.missingTopLevelHydrated).toEqual([]);
  expect(result.missingHunkKeys).toEqual([]);
  expect(result.contentShapes.some((shape) => shape.startsWith('context:') && shape.includes('lines'))).toBe(true);
  expect(result.contentShapes.some((shape) => shape.startsWith('change:') && shape.includes('additions') && shape.includes('deletions'))).toBe(true);
  expect(result.collapsedBeforeIsGap).toBe(true);
  expect(result.hydratedHasWholeFile).toBe(true);
  expect(result.partialHasOnlyPatchLines).toBe(true);
});

for (const gap of [2, 5, 6]) {
  test(`a ${gap}-line gap between hunks of a hydrated diff is ${gap <= 5 ? 'painted in full with no expansion entry' : 'collapsed behind a separator'}`, async ({ harness }) => {
    // Depends on it: PierreBridge.isLineVisible counts a gap of
    // collapsedContextThreshold (5) lines or fewer as visible, exactly as the
    // vendor paints it (the #582 algorithm).
    const page = await harness.open();
    const result = await page.evaluate(async (gap) => {
      const H = window.H;
      const W = window.ContractWorkload;
      const name = 'gap/file.js';
      const oldLines = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1};`);
      // Two one-line replacements; the unchanged run between their contexts is `gap` lines.
      const firstAt = 10;
      const secondAt = firstAt + 1 + 2 * W.CONTEXT + gap;
      const edits = [
        { at: firstAt, del: 1, ins: ['const first = true;'] },
        { at: secondAt, del: 1, ins: ['const second = true;'] },
      ];
      const newLines = W.applyEdits(oldLines, edits);
      const hunks = W.hunksFromEdits(oldLines, edits);
      const patch = `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n--- a/${name}\n+++ b/${name}\n${hunks.text}\n`;
      const partial = window.PierreDiffs.parsePatchFiles(patch)[0].files[0];
      const hydrated = window.PierreDiffs.hydratePartialDiff('clone', partial, {
        oldFile: { name, contents: `${oldLines.join('\n')}\n` },
        newFile: { name, contents: `${newLines.join('\n')}\n` },
      });
      H.items = [{ id: name, type: 'diff', fileDiff: hydrated, annotations: [], version: 0 }];
      H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS);
      H.cv.setItems(H.items);
      await H.settle();
      // 1-based numbers of the hidden lines between the two hunks.
      const firstHidden = firstAt + 1 + W.CONTEXT + 1;
      const hidden = Array.from({ length: gap }, (_, i) => firstHidden + i);
      return {
        hunkCount: hunks.hunkCount,
        collapsedBefore: hydrated.hunks[1].collapsedBefore,
        hiddenRendered: hidden.filter((line) => !!H.findRow(name, line)).length,
        expansionEntries: H.instance(name).hunksRenderer.expandedHunks.size,
        separatorsBetween: H.host(name).shadowRoot.querySelectorAll('[data-content] > [data-separator][data-expand-index="1"]').length,
        clean: H.auditClean(),
      };
    }, gap);

    expect(result.hunkCount).toBe(2);
    expect(result.collapsedBefore).toBe(gap);
    expect(result.expansionEntries).toBe(0);
    if (gap <= 5) {
      expect(result.hiddenRendered).toBe(gap);
      expect(result.separatorsBetween).toBe(0);
    } else {
      expect(result.hiddenRendered).toBe(0);
      expect(result.separatorsBetween).toBe(1);
    }
    expect(result.clean).toBe(true);
  });
}

test('instance.resetLayoutCache({ includeEstimatedHeights: true }) makes the item lay itself out from its diff again after the expansion map was emptied by hand', async ({ harness }) => {
  // Depends on it: PierreCodeViewBridge._clearExpansions. The bridge empties
  // `instance.hunksRenderer.expandedHunks` before it publishes metadata with
  // other hunks (the map is keyed by hunk index), and the item's cached
  // heights were computed with the expanded lines in them. This is the
  // second vendor internal the bridge calls (ledger H120).
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const W = window.ContractWorkload;
    const name = 'reset/file.js';
    const oldLines = Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    const edits = [
      { at: 10, del: 1, ins: ['const first = true;'] },
      { at: 80, del: 1, ins: ['const second = true;'] },
    ];
    const newLines = W.applyEdits(oldLines, edits);
    const hunks = W.hunksFromEdits(oldLines, edits);
    const patch = `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n--- a/${name}\n+++ b/${name}\n${hunks.text}\n`;
    const partial = window.PierreDiffs.parsePatchFiles(patch)[0].files[0];
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', partial, {
      oldFile: { name, contents: `${oldLines.join('\n')}\n` },
      newFile: { name, contents: `${newLines.join('\n')}\n` },
    });
    const item = { id: name, type: 'diff', fileDiff: hydrated, annotations: [], version: 0 };
    H.items = [item];
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS);
    H.cv.setItems(H.items);
    await H.settle();
    const instance = H.instance(name);
    const height = () => H.host(name).getBoundingClientRect().height;
    const rows = () => H.host(name).shadowRoot.querySelectorAll('[data-content] > [data-line]').length;
    const start = { height: height(), rows: rows(), clean: H.auditClean() };

    // The reader expands the gap between the two hunks.
    instance.expandHunk(1, 'both', Infinity);
    H.cv.render(true);
    await H.settle();
    const expanded = { height: height(), rows: rows(), entries: instance.hunksRenderer.expandedHunks.size, clean: H.auditClean() };

    // What the bridge does: empty the map, reset the cached layout, publish.
    const publish = (version) => { H.cv.updateItem({ ...H.cv.getItem(name), version }); H.cv.render(true); };
    instance.hunksRenderer.expandedHunks.clear();
    const hasMethod = typeof instance.resetLayoutCache === 'function';
    instance.resetLayoutCache({ includeEstimatedHeights: true });
    publish(1);
    await H.settle();
    return {
      hasMethod,
      start,
      expanded,
      after: { height: height(), rows: rows(), clean: H.auditClean() },
    };
  });
  expect(result.hasMethod).toBe(true);
  expect(result.start.clean).toBe(true);
  expect(result.expanded.entries).toBe(1);
  expect(result.expanded.rows).toBeGreaterThan(result.start.rows);
  expect(result.expanded.clean).toBe(true);
  // Back to the diff's own layout: the same rows, the same height, exact.
  expect(result.after.rows).toBe(result.start.rows);
  expect(result.after.height).toBe(result.start.height);
  expect(result.after.clean).toBe(true);
  expect(harness.validatorErrors(page)).toEqual([]);
});
