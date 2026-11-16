// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: what a changed file shows. Full contents by diff type,
 * revealed ranges, the visibility oracle, a diff awaiting display, and the
 * cache key every derived diff gets.
 */

import { test, expect, openBridge, clickExpandControl } from './bridge-test.js';

for (const role of ['medium', 'renameChanged']) {
  test(`upgradeFileContents on a ${role === 'medium' ? 'changed' : 'renamed and changed'} file keeps every patch line, shows the vendor's diff of the two contents, and brings the expand controls`, async ({ harness }) => {
    const page = await openBridge(harness);
    const result = await page.evaluate(async (role) => {
      const { H, BH } = window;
      const id = H.workload.roles[role];
      await BH.up({ entries: [BH.diffEntry(id), BH.diffEntry(H.workload.roles.small)] });
      const b = BH.bridge;
      const before = { rows: BH.rows(id), shape: H.shape(id), key: b.files.get(id).metadata.cacheKey, partial: b.files.get(id).metadata.isPartial };
      const firstRowTop = H.viewportTopOf(H.host(id).shadowRoot.querySelector('[data-content] > [data-line]'));
      const { oldFile, newFile } = H.contentsOf(id);
      const returned = b.upgradeFileContents(id, oldFile, newFile);
      const again = b.upgradeFileContents(id, oldFile, newFile);
      const displayed = await BH.displayed(id);
      await H.settle(150);
      const after = { rows: BH.rows(id), shape: H.shape(id), key: b.files.get(id).metadata.cacheKey, partial: b.files.get(id).metadata.isPartial };
      // Every line of the new file that the patch showed is still drawn.
      // (A deleted line can be drawn another way: the diff of the two
      // contents may pair the lines of a change differently from git.)
      const newSide = (row) => !String(row.type).includes('deletion');
      const has = (row) => after.rows.some((r) => newSide(r) && r.line === row.line && r.text === row.text);
      return {
        returned, again, displayed: displayed.ok,
        missingPatchRows: before.rows.filter((row) => newSide(row) && !has(row)).length,
        patchRows: before.rows.filter(newSide).length,
        expandBefore: before.shape.expandButtons,
        expandAfter: after.shape.expandButtons,
        rowShift: H.viewportTopOf(H.host(id).shadowRoot.querySelector('[data-content] > [data-line]')) - firstRowTop,
        keyChanged: before.key !== after.key,
        partial: [before.partial, after.partial],
        baseSet: !!b.files.get(id).baseMetadata,
        // What the per-file renderer drew: the vendor's diff of the two
        // contents with the lines of the patch merged in.
        hunksAsReference: (() => {
          const spans = (metadata) => metadata.hunks.map((h) => `${h.additionStart}+${h.additionCount}/${h.deletionStart}+${h.deletionCount}`).join(' ');
          const reference = window.PierreDiffs.parseDiffFromFile(oldFile, newFile);
          const parity = b.files.get(id).patchMetadata.hunks.filter((h) => h.additionCount > 0)
            .map((h) => ({ startLine: h.additionStart, endLine: h.additionStart + h.additionCount - 1 }));
          return spans(b.files.get(id).metadata) === spans(window.PierreContext.mergeContextRanges(reference, parity));
        })(),
        sound: BH.sound(),
      };
    }, role);
    expect(result.returned).toBe(true);
    expect(result.again).toBe(true);
    expect(result.displayed).toBe(true);
    expect(result.patchRows).toBeGreaterThan(0);
    expect(result.missingPatchRows).toBe(0);
    expect(result.expandBefore).toBe(0);
    expect(result.expandAfter).toBeGreaterThan(0);
    expect(result.rowShift).toBe(0);
    expect(result.keyChanged).toBe(true);
    expect(result.partial).toEqual([true, false]);
    expect(result.baseSet).toBe(true);
    expect(result.hunksAsReference).toBe(true);
    expect(result.sound).toEqual({ orphans: 0, clean: true });
  });
}

test('the line at the top of the pane stays there when the contents of its file, and of the file above it, arrive', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const above = H.workload.roles.medium;
    const id = H.workload.roles.large;
    await BH.up({ entries: [BH.diffEntry(above), BH.diffEntry(id), BH.diffEntry(H.workload.roles.small)] });
    const b = BH.bridge;
    // Read from the first line of the file's second hunk: the rows the
    // upgrade adds (context the patch did not have) are above it.
    const hunk = b.files.get(id).patchMetadata.hunks[1];
    const line = hunk.additionStart;
    b.scrollToLine(id, line, 'RIGHT', { align: 'start', behavior: 'instant', flash: false });
    const rowOf = () => H.host(id)?.shadowRoot?.querySelector(`[data-content] > [data-line="${line}"]`);
    await H.until(() => !!rowOf());
    await H.settle(150);
    const before = { top: H.viewportTopOf(rowOf()), rows: BH.rows(id).length, scrollTop: H.root.scrollTop };
    for (const name of [above, id]) {
      const { oldFile, newFile } = H.contentsOf(name);
      b.upgradeFileContents(name, oldFile, newFile);
    }
    await BH.displayed(id);
    await H.settle(200);
    return {
      before,
      after: { top: H.viewportTopOf(rowOf()), rows: BH.rows(id).length, scrollTop: H.root.scrollTop },
      aboveUpgraded: b.files.get(above).upgraded,
      sound: BH.sound(),
    };
  });
  expect(result.aboveUpgraded).toBe(true);
  expect(Math.abs(result.after.top - result.before.top)).toBeLessThanOrEqual(1);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
  // Reported, not asserted: how many rows the upgrade added and how far the pane was scrolled to keep the line in place.
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(result) });
});

test('upgradeFileContents on added, deleted and hunk-less files does not throw and changes nothing on screen', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const ids = [roles.added, roles.deleted, roles.emptyAdded, roles.renamePure, roles.binary, roles.modeOnly];
    await BH.up({ entries: ids.map((id) => BH.diffEntry(id)) });
    const b = BH.bridge;
    const out = {};
    for (const id of ids) {
      b.scrollToItem(id);
      await H.settle(150);
      const rowsBefore = BH.rows(id)?.length ?? null;
      const { oldFile, newFile } = H.contentsOf(id);
      let threw = null;
      let returned = null;
      try { returned = b.upgradeFileContents(id, oldFile, newFile); } catch (err) { threw = err.message; }
      await H.settle(200);
      out[id] = {
        type: b.files.get(id).patchMetadata.type,
        strategy: window.PierreCodeViewBridge.upgradeStrategy(b.files.get(id).patchMetadata),
        returned, threw,
        rowsBefore, rowsAfter: BH.rows(id)?.length ?? null,
        expandButtons: H.shape(id)?.expandButtons ?? null,
        upgraded: b.files.get(id).upgraded,
      };
    }
    // Missing or unknown input.
    out.unknown = b.upgradeFileContents('nope.js', null, null);
    out.nullContents = (() => { BH.bridge.files.get(roles.binary).upgraded = false; return b.upgradeFileContents(roles.binary, null, null); })();
    out.sound = BH.sound();
    out.roles = roles;
    return out;
  });
  const { roles } = result;
  for (const id of [roles.added, roles.deleted, roles.emptyAdded, roles.renamePure, roles.binary, roles.modeOnly]) {
    expect(result[id].threw, id).toBeNull();
    expect(result[id].returned, id).toBe(true);
    expect(result[id].upgraded, id).toBe(true);
    expect(result[id].rowsAfter, id).toBe(result[id].rowsBefore);
    expect(result[id].expandButtons, id).toBe(0);
  }
  expect(result[roles.added].strategy).toBe('none');
  expect(result[roles.deleted].strategy).toBe('none');
  expect(result[roles.renamePure].strategy).toBe('reparse');
  expect(result[roles.modeOnly].strategy).toBe('reparse');
  expect(result.unknown).toBe(false);
  expect(result.nullContents).toBe(true);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a line of a renamed file without changes can be revealed once its contents are loaded', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const id = H.workload.roles.renamePure;
    await BH.up({ entries: [BH.diffEntry(id), BH.diffEntry(H.workload.roles.small)] });
    const b = BH.bridge;
    const beforeContents = { added: b.addContextRanges(id, [{ startLine: 3, endLine: 6 }]), visible: b.isLineVisible(id, 4, 'RIGHT'), rows: BH.rows(id).length };
    const { oldFile, newFile } = H.contentsOf(id);
    b.upgradeFileContents(id, oldFile, newFile);
    const visibleAtOnce = b.isLineVisible(id, 4, 'RIGHT');
    await BH.displayed(id);
    await H.settle(150);
    return { beforeContents, visibleAtOnce, runs: BH.lineRuns(id), sound: BH.sound() };
  });
  // Asked before the contents were there: kept, and applied when they arrive.
  expect(result.beforeContents).toEqual({ added: false, visible: false, rows: 0 });
  expect(result.visibleAtOnce).toBe(true);
  expect(result.runs.some(([start, end]) => start <= 3 && end >= 6)).toBe(true);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('addContextRanges, isLineVisible and convertOldToNew on a mounted file', async ({ harness }) => {
  const page = await openBridge(harness);
  const setup = await page.evaluate(async () => {
    const { H, BH } = window;
    const id = H.workload.roles.large;
    await BH.up({ entries: [BH.diffEntry(id), BH.diffEntry(H.workload.roles.small)] });
    const b = BH.bridge;
    const hunks = b.files.get(id).patchMetadata.hunks;
    // A gap of more than 60 lines between two hunks of the patch.
    let gap = null;
    for (let i = 1; i < hunks.length && !gap; i++) {
      const start = hunks[i - 1].additionStart + hunks[i - 1].additionCount;
      const end = hunks[i].additionStart - 1;
      if (end - start >= 60) gap = { index: i, start, end };
    }
    const inHunk = hunks[0].additionStart + 1;
    const out = { id, gap, inHunk };
    out.beforeContents = {
      inHunk: b.isLineVisible(id, inHunk, 'RIGHT'),
      hidden: b.isLineVisible(id, gap.start + 30, 'RIGHT'),
      convert: b.convertOldToNew(id, 10, 12),
      // Before the contents are loaded a range is kept, not applied.
      added: b.addContextRanges(id, [{ startLine: gap.start + 28, endLine: gap.start + 32 }]),
      stillHidden: b.isLineVisible(id, gap.start + 30, 'RIGHT'),
    };
    const { oldFile, newFile } = H.contentsOf(id);
    b.upgradeFileContents(id, oldFile, newFile);
    out.afterContents = {
      // The kept range is applied with the upgrade, and the data says so at once.
      queuedVisible: b.isLineVisible(id, gap.start + 30, 'RIGHT'),
      nextHidden: b.isLineVisible(id, gap.start + 40, 'RIGHT'),
      displayedYet: b.isDiffDisplayed(id),
    };
    await BH.displayed(id);
    await H.settle(150);
    return out;
  });
  expect(setup.gap).not.toBeNull();
  expect(setup.beforeContents).toEqual({ inHunk: true, hidden: false, convert: null, added: false, stillHidden: false });
  expect(setup.afterContents.queuedVisible).toBe(true);
  expect(setup.afterContents.nextHidden).toBe(false);

  // The reader expands the gap after the revealed range by one step, with a
  // real click on the control that grows the range above it ("up": the lines
  // at the start of the gap).
  const gapAfterRange = await page.evaluate(({ id, gap }) => {
    const hunks = window.BH.bridge.files.get(id).metadata.hunks;
    return hunks.findIndex((h) => h.additionStart > gap.start + 32);
  }, setup);
  const box = await clickExpandControl(page, setup.id, gapAfterRange, 'up');
  expect(box && box.visible, JSON.stringify(box)).toBe(true);

  const result = await page.evaluate(async ({ id, gap }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const manual = gap.start + 33; // the first line the click revealed
    const out = { manualVisible: b.isLineVisible(id, manual, 'RIGHT'), keyBefore: b.files.get(id).metadata.cacheKey };
    // A later reveal elsewhere in the file derives the diff again: what the
    // reader expanded by hand must survive it.
    const farLine = gap.end - 3;
    const map = b.files.get(id)._instance.hunksRenderer.expandedHunks;
    const manualRow = () => !!H.host(id).shadowRoot.querySelector(`[data-content] > [data-line="${manual}"]`);
    out.manualRowBefore = manualRow();
    out.added = b.addContextRanges(id, [{ startLine: farLine, endLine: farLine }]);
    out.afterLaterRange = {
      manualVisible: b.isLineVisible(id, manual, 'RIGHT'),
      farVisible: b.isLineVisible(id, farLine, 'RIGHT'),
      between: b.isLineVisible(id, Math.floor((manual + 25 + farLine) / 2), 'RIGHT'),
      keyChanged: b.files.get(id).metadata.cacheKey !== out.keyBefore,
      // The file goes on drawing the diff the reader expanded, with the
      // viewer's record of it, until the new diff is ready.
      expansionMapKept: map.size === 1,
    };
    // Every frame until the new diff is on screen: the line the reader
    // expanded has its row.
    out.framesWithoutManualRow = [];
    out.frames = 0;
    while (!b.isDiffDisplayed(id) && out.frames < 600) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      out.frames += 1;
      if (!manualRow()) out.framesWithoutManualRow.push(out.frames);
    }
    out.afterDisplay = { displayed: b.isDiffDisplayed(id), manualRow: manualRow(), expansionMapEmpty: map.size === 0, manualVisible: b.isLineVisible(id, manual, 'RIGHT') };
    // Old-file numbers convert through the file's own hunks.
    const hunk = b.files.get(id).baseMetadata.hunks[0];
    const offset = hunk.additionLines - hunk.deletionLines;
    const afterFirstHunkOld = hunk.deletionStart + hunk.deletionCount + 2;
    out.convert = { got: b.convertOldToNew(id, afterFirstHunkOld, afterFirstHunkOld + 1), want: { startLine: afterFirstHunkOld + offset, endLine: afterFirstHunkOld + 1 + offset } };
    out.leftSideInHunk = b.isLineVisible(id, hunk.deletionStart, 'LEFT');
    // A gap of five lines or fewer is on screen without anyone revealing it.
    const hunks = b.files.get(id).metadata.hunks;
    const farIndex = hunks.findIndex((h) => h.additionStart === farLine);
    out.smallGap = { size: gap.end - farLine, visible: b.isLineVisible(id, gap.end, 'RIGHT'), nextHunkStart: hunks[farIndex + 1].additionStart };
    // A collapsed file shows no line at all.
    b.setCollapsed(id, true);
    out.collapsed = b.isLineVisible(id, hunk.additionStart, 'RIGHT');
    b.setCollapsed(id, false);
    out.expandedAgain = b.isLineVisible(id, hunk.additionStart, 'RIGHT');
    out.unknown = [b.isLineVisible('nope.js', 1, 'RIGHT'), b.addContextRanges('nope.js', [{ startLine: 1, endLine: 2 }]), b.convertOldToNew('nope.js', 1, 2)];
    await BH.displayed(id);
    await H.settle(200);
    out.sound = BH.sound();
    return out;
  }, setup);
  expect(result.manualVisible).toBe(true);
  expect(result.added).toBe(true);
  expect(result.manualRowBefore).toBe(true);
  expect(result.afterLaterRange).toEqual({ manualVisible: true, farVisible: true, between: false, keyChanged: true, expansionMapKept: true });
  expect(result.frames).toBeGreaterThan(0);
  expect(result.framesWithoutManualRow).toEqual([]);
  expect(result.afterDisplay).toEqual({ displayed: true, manualRow: true, expansionMapEmpty: true, manualVisible: true });
  expect(result.convert.got).toEqual(result.convert.want);
  expect(result.leftSideInHunk).toBe(true);
  expect(result.smallGap.size).toBeLessThanOrEqual(5);
  expect(result.smallGap.visible).toBe(true);
  expect(result.collapsed).toBe(false);
  expect(result.expandedAgain).toBe(true);
  expect(result.unknown).toEqual([false, false, null]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});


test('a reveal in a file drawn as plain text, after the reader expanded a gap: the new diff is drawn in the next pass, without the viewer\'s record of the expansion', async ({ harness }) => {
  const page = await openBridge(harness);
  const setup = await page.evaluate(async () => {
    const { H, BH } = window;
    const id = H.workload.roles.large;
    await BH.up({ entries: [BH.diffEntry(id, { forcePlainText: true }), BH.diffEntry(H.workload.roles.small)] });
    const b = BH.bridge;
    const { oldFile, newFile } = H.contentsOf(id);
    b.upgradeFileContents(id, oldFile, newFile);
    await BH.displayed(id);
    await H.settle(200);
    // A gap of more than 60 lines between two hunks of what the file shows.
    const hunks = b.files.get(id).metadata.hunks;
    let gap = null;
    for (let i = 1; i < hunks.length && !gap; i++) {
      const start = hunks[i - 1].additionStart + hunks[i - 1].additionCount;
      const end = hunks[i].additionStart - 1;
      if (end - start >= 60) gap = { index: i, start, end };
    }
    return { id, gap, lang: b.files.get(id).metadata.lang ?? null };
  });
  expect(setup.lang).toBe('text');
  expect(setup.gap).not.toBeNull();
  const box = await clickExpandControl(page, setup.id, setup.gap.index, 'up');
  expect(box && box.visible, JSON.stringify(box)).toBe(true);

  const result = await page.evaluate(async ({ id, gap }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const manual = gap.start; // the first line the click revealed
    const renderer = b.files.get(id)._instance.hunksRenderer;
    const map = renderer.expandedHunks;
    const callback = renderer.onRenderUpdate;
    const manualRow = () => !!H.host(id).shadowRoot.querySelector(`[data-content] > [data-line="${manual}"]`);
    const out = { before: { manualVisible: b.isLineVisible(id, manual, 'RIGHT'), manualRow: manualRow(), map: map.size } };
    const farLine = gap.end - 10;
    out.added = b.addContextRanges(id, [{ startLine: farLine, endLine: farLine }]);
    // No highlight result to wait for: the viewer's record went before the publish, and nothing was taken over.
    out.atOnce = { map: map.size, callbackUntouched: renderer.onRenderUpdate === callback, manualVisible: b.isLineVisible(id, manual, 'RIGHT'), farVisible: b.isLineVisible(id, farLine, 'RIGHT') };
    out.framesWithoutManualRow = [];
    for (let frame = 1; frame <= 30; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!manualRow()) out.framesWithoutManualRow.push(frame);
    }
    await BH.displayed(id);
    await H.settle(300);
    out.after = { displayed: b.isDiffDisplayed(id), manualRow: manualRow(), farRow: !!H.host(id).shadowRoot.querySelector(`[data-content] > [data-line="${farLine}"]`), map: map.size };
    out.sound = BH.sound();
    return out;
  }, setup);
  expect(result.before).toEqual({ manualVisible: true, manualRow: true, map: 1 });
  expect(result.added).toBe(true);
  expect(result.atOnce).toEqual({ map: 0, callbackUntouched: true, manualVisible: true, farVisible: true });
  expect(result.framesWithoutManualRow).toEqual([]);
  expect(result.after).toEqual({ displayed: true, manualRow: true, farRow: true, map: 0 });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('a reveal on a file that was never mounted is true in the data at once and on screen when the reader gets there', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const names = H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 30);
    await BH.up({ entries: names.map((n) => BH.diffEntry(n)) });
    const b = BH.bridge;
    const far = names[26];
    const hunks = b.files.get(far).patchMetadata.hunks;
    const last = hunks[hunks.length - 1];
    const target = last.additionStart + last.additionCount + 12; // hidden after the last hunk
    const out = { everMounted: BH.lifecycle.some((e) => e.id === far) };
    const { oldFile, newFile } = H.contentsOf(far);
    b.upgradeFileContents(far, oldFile, newFile);
    out.hiddenBefore = b.isLineVisible(far, target, 'RIGHT');
    out.scrollRefused = b.scrollToLine(far, target, 'RIGHT');
    out.added = b.addContextRanges(far, [{ startLine: target - 1, endLine: target + 1 }]);
    out.visibleAtOnce = b.isLineVisible(far, target, 'RIGHT');
    out.displayedBeforeMount = b.isDiffDisplayed(far);
    out.scrolled = b.scrollToLine(far, target, 'RIGHT', { behavior: 'instant' });
    out.displayed = await b.whenLineDisplayed(far, target, 'RIGHT', { timeoutMs: 8000 });
    await H.settle(200);
    const row = H.findRow(far, target, 'additions');
    out.rowOnScreen = !!row && H.viewportTopOf(row) >= 0 && H.viewportTopOf(row) < H.root.clientHeight;
    out.sound = BH.sound();
    return out;
  });
  expect(result).toEqual({
    everMounted: false,
    hiddenBefore: false,
    // A line the file does not show cannot be scrolled to: the caller falls back to the file.
    scrollRefused: false,
    added: true,
    visibleAtOnce: true,
    displayedBeforeMount: false,
    scrolled: true,
    displayed: true,
    rowOnScreen: true,
    sound: { orphans: 0, clean: true },
  });
});

test('while a new diff awaits display a card is not attached, can still be looked up, and arrives with the diff', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const id = H.workload.roles.large;
    await BH.up({ entries: [BH.diffEntry(id), BH.diffEntry(H.workload.roles.small)] });
    const b = BH.bridge;
    const { oldFile, newFile } = H.contentsOf(id);
    b.upgradeFileContents(id, oldFile, newFile);
    await BH.displayed(id);
    await H.settle(150);

    // A reveal: new metadata for a 300,000-character file, highlighted off the main thread.
    const hunks = b.files.get(id).metadata.hunks;
    const target = hunks[0].additionStart + hunks[0].additionCount + 30;
    b.addContextRanges(id, [{ startLine: target - 2, endLine: target + 2 }]);
    const pending = !b.isDiffDisplayed(id);
    b.addAnnotation(id, { lineNumber: target, side: 'RIGHT', type: 'card', data: { text: 'on a revealed line' }, id: 'card-revealed' });
    const sameTask = {
      visibleInData: b.isLineVisible(id, target, 'RIGHT'),
      lookup: b.getAnnotationElement(id, 'card-revealed'),
      built: !!b.getAnnotationElement(id, 'card-revealed', { create: true }),
      connected: b.getAnnotationElement(id, 'card-revealed').isConnected,
      rowInDom: !!H.findRow(id, target, 'additions'),
    };
    // A scroll to the line and a wait for the card, as navigation does.
    b.scrollToLine(id, target, 'RIGHT', { behavior: 'instant' });
    const lineDisplayed = await b.whenLineDisplayed(id, target, 'RIGHT', { timeoutMs: 10000 });
    const element = await b.whenAnnotationRendered(id, 'card-revealed', { timeoutMs: 10000 });
    await H.settle(200);
    const card = BH.cardState(id, 'card-revealed');
    return {
      pending, sameTask, lineDisplayed,
      elementIsCard: element === b.getAnnotationElement(id, 'card-revealed'),
      card: { connected: card.connected, slot: card.slot, hasBox: card.height > 0 },
      target,
      sound: BH.sound(),
    };
  });
  expect(result.pending).toBe(true);
  expect(result.sameTask).toEqual({ visibleInData: true, lookup: null, built: true, connected: false, rowInDom: false });
  expect(result.lineDisplayed).toBe(true);
  expect(result.elementIsCard).toBe(true);
  expect(result.card).toEqual({ connected: true, slot: `annotation-additions-${result.target}`, hasBox: true });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('whenLineDisplayed answers false at once for a line the file does not show, and stops when cancelled', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const id = H.workload.roles.large;
    await BH.up({ entries: [BH.diffEntry(id)] });
    const b = BH.bridge;
    const timed = async (promise) => { const t0 = performance.now(); const value = await promise; return { value, fast: performance.now() - t0 < 500 }; };
    const hidden = await timed(b.whenLineDisplayed(id, 999999, 'RIGHT'));
    const unknown = await timed(b.whenLineDisplayed('nope.js', 1, 'RIGHT'));
    const shown = await timed(b.whenLineDisplayed(id, b.files.get(id).metadata.hunks[0].additionStart, 'RIGHT'));
    const { oldFile, newFile } = H.contentsOf(id);
    b.upgradeFileContents(id, oldFile, newFile);
    let asked = 0;
    const cancelled = await timed(b.whenLineDisplayed(id, b.files.get(id).metadata.hunks[0].additionStart, 'RIGHT', { isCancelled: () => ++asked >= 1 }));
    return { hidden, unknown, shown, cancelled, asked };
  });
  expect(result.hidden).toEqual({ value: false, fast: true });
  expect(result.unknown).toEqual({ value: false, fast: true });
  expect(result.shown).toEqual({ value: true, fast: true });
  expect(result.cancelled).toEqual({ value: false, fast: true });
  expect(result.asked).toBe(1);
});
