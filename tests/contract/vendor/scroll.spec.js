// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: scroll targets.
 *
 * Fact F11 (plans/codeview-virtualized-diff.md, "Vendor facts"): item and
 * line targets land with 0 px error, including never-mounted items; a
 * `position` target lands short; a line target set while that line's diff
 * swap is pending lands on the gap separator and is not retried.
 *
 * Depends on it: PierreBridge.scrollToItem / scrollToLine add no sticky
 * compensation; position writes use root.scrollTop; PRManager.revealInDiff
 * waits for PierreBridge.whenLineDisplayed before its final scroll.
 */

import { test, expect } from '../harness/contract-test.js';

const HEADER = 40; // harness header height = itemMetrics.diffHeaderHeight
const ROW = 20;

test('F11: item targets land flush at the top with 0 px error', async ({ harness }) => {
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { plain: 'end' }, pool: true, maxMs: 20000 });
    const ids = H.items.map((i) => i.id);
    const collapsed = ids[35];
    H.update(collapsed, { collapsed: true });
    await H.settle();
    const go = async (target) => {
      H.cv.scrollTo(target);
      await H.until(() => !!H.host(target.id));
      await H.settle(200, 10000);
      const host = H.host(target.id);
      return host ? { top: H.viewportTopOf(host), bottomGap: +(H.root.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom).toFixed(2) } : null;
    };
    const out = {};
    out.neverMounted = await go({ type: 'item', id: ids[30] });
    out.hugeAdded = await go({ type: 'item', id: roles.hugeAdded });
    out.hugeModified = await go({ type: 'item', id: roles.hugeModified });
    out.collapsed = await go({ type: 'item', id: collapsed });
    out.rowless = await go({ type: 'item', id: roles.renamePure });
    out.lastPlainFile = await go({ type: 'item', id: ids[ids.length - 1] });
    out.first = await go({ type: 'item', id: ids[0] });
    out.offset50 = await go({ type: 'item', id: ids[12], offset: 50 });
    out.alignEnd = await go({ type: 'item', id: ids[20], align: 'end' });
    out.smooth = await go({ type: 'item', id: ids[45], behavior: 'smooth' });
    out.clean = H.auditClean();
    out.orphans = H.orphanHosts();
    return out;
  });

  for (const key of ['neverMounted', 'hugeAdded', 'hugeModified', 'collapsed', 'rowless', 'smooth']) {
    expect(result[key], key).not.toBeNull();
    expect(result[key].top, key).toBe(0);
  }
  // The last item cannot reach the top (the list ends first), and the first
  // item sits below the list's top padding; both are where the list puts them.
  expect(result.lastPlainFile.top).toBeGreaterThanOrEqual(0);
  expect(result.first.top).toBeGreaterThanOrEqual(0);
  expect(result.offset50.top).toBe(50);
  expect(result.alignEnd.bottomGap).toBe(0);
  expect(result.clean).toBe(true);
  expect(result.orphans).toBe(0);
});

test('F11: line targets land with 0 px error, with no sticky-header compensation by the caller', async ({ harness }) => {
  const page = await harness.open();
  const result = await page.evaluate(async ({ HEADER, ROW }) => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: {}, pool: true, maxMs: 20000 });
    const viewport = H.root.clientHeight;
    const go = async (target, expectedTop) => {
      H.cv.scrollTo(target);
      await H.until(() => !!H.findRow(target.id, target.lineNumber, target.side));
      await H.settle(200, 10000);
      const row = H.findRow(target.id, target.lineNumber, target.side);
      return row ? +(H.viewportTopOf(row) - expectedTop).toFixed(2) : null;
    };
    const huge = H.item(roles.hugeModified).fileDiff;
    const hunk20 = huge.hunks[20];
    const hunk29 = huge.hunks[29];
    // First deleted line of a hunk that has deletions.
    const firstDeletion = (hunk) => {
      let line = hunk.deletionStart;
      for (const part of hunk.hunkContent) {
        if (part.type === 'context') line += part.lines;
        else if (part.deletions > 0) return line;
      }
      return null;
    };
    const withDeletions = huge.hunks.find((h, i) => i > 10 && firstDeletion(h) != null);
    const lastId = H.items[H.items.length - 1].id;
    const lastDiff = H.item(lastId).fileDiff;
    const out = {};
    out.hugeAddedLine15000Start = await go({ type: 'line', id: roles.hugeAdded, lineNumber: 15000, side: 'additions' }, HEADER);
    out.hugeAddedLine19999Center = await go({ type: 'line', id: roles.hugeAdded, lineNumber: 19999, side: 'additions', align: 'center' }, (viewport - ROW) / 2);
    out.hunk20AdditionsStart = await go({ type: 'line', id: roles.hugeModified, lineNumber: hunk20.additionStart + 3, side: 'additions' }, HEADER);
    out.hunk29AdditionsCenter = await go({ type: 'line', id: roles.hugeModified, lineNumber: hunk29.additionStart + 1, side: 'additions', align: 'center' }, (viewport - ROW) / 2);
    out.deletionsSideStart = await go({ type: 'line', id: roles.hugeModified, lineNumber: firstDeletion(withDeletions), side: 'deletions' }, HEADER);
    out.lastItemLine = await go({ type: 'line', id: lastId, lineNumber: lastDiff.hunks[0].additionStart + 1, side: 'additions', align: 'center' }, (viewport - ROW) / 2);
    out.clean = H.auditClean();
    return out;
  }, { HEADER, ROW });

  expect(result.hugeAddedLine15000Start).toBe(0);
  expect(result.hugeAddedLine19999Center).toBe(0);
  expect(result.hunk20AdditionsStart).toBe(0);
  expect(result.hunk29AdditionsCenter).toBe(0);
  expect(result.deletionsSideStart).toBe(0);
  expect(result.lastItemLine).not.toBeNull();
  expect(result.clean).toBe(true);
});

test('F11 (vendor quirk): a position target lands short of the requested position; root.scrollTop is exact', async ({ harness }) => {
  // This test asserts a quirk the bridge works around by never using
  // scrollTo({ type: 'position' }). If it fails after a bump the quirk may be
  // gone; root.scrollTop stays correct either way.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { exclude: [roles.hugeAdded, roles.hugeModified] } });
    H.cv.scrollTo({ type: 'position', position: 5000 });
    await H.settle(200);
    const viaTarget = H.root.scrollTop;
    H.root.scrollTop = 0;
    await H.settle(200);
    H.root.scrollTop = 5000;
    await H.raf(2);
    return { viaTarget, viaScrollTop: H.root.scrollTop, vendorAgrees: H.cv.getScrollTop() };
  });
  expect(result.viaTarget).not.toBe(5000);
  expect(result.viaTarget).toBeLessThan(5000);
  expect(result.viaTarget).toBeGreaterThan(4900);
  expect(result.viaScrollTop).toBe(5000);
  expect(result.vendorAgrees).toBe(5000);
  await harness.record('F11-position-target', result);
});

test('F11: a line target in a collapsed gap lands on the separator; unknown ids and lines only warn', async ({ harness }) => {
  // Depends on it: PierreBridge.scrollToLine returns false only when its own
  // metadata proves the line absent; it never relies on the vendor to refuse.
  const page = await harness.open();
  const result = await page.evaluate(async (HEADER) => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({ build: { only: [roles.noNewline, T, roles.small] } });
    const hunks = H.item(T).fileDiff.hunks;
    const gapLine = hunks[1].additionStart - 60;
    H.cv.scrollTo({ type: 'line', id: T, lineNumber: gapLine, side: 'additions' });
    await H.settle(200);
    const separators = [...H.host(T).shadowRoot.querySelectorAll('[data-content] > [data-separator]')]
      .map((s) => H.viewportTopOf(s));
    const top0 = H.root.scrollTop;
    H.cv.scrollTo({ type: 'line', id: T, lineNumber: 999999, side: 'additions' });
    H.cv.scrollTo({ type: 'item', id: 'no-such-item' });
    await H.settle(200);
    return { rowRendered: !!H.findRow(T, gapLine), separatorUnderHeader: separators.some((top) => Math.abs(top - HEADER) <= 8), movedByBadTargets: H.root.scrollTop - top0 };
  }, HEADER);
  expect(result).toEqual({ rowRendered: false, separatorUnderHeader: true, movedByBadTargets: 0 });
  const warnings = harness.warnings(page).join('\n');
  expect(warnings).toMatch(/unable to resolve line 999999/);
  expect(warnings).toMatch(/unknown item id "no-such-item"/);
});

test('F11: a line target set while that line\'s diff swap is pending is not retried; scrolling after the line is displayed is exact', async ({ harness }) => {
  const page = await harness.open({ scripts: ['/app/js/modules/pierre-context.js'] });
  const result = await page.evaluate(async (ROW) => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({ parse: { cacheKeyPrefix: 'contract:1' }, build: { only: [T, roles.noNewline] }, pool: true });
    // Not yet mounted reads as "not yet": with the pool nothing is mounted
    // until its workers are up (G7), which under load is after the bring-up's
    // quiet period.
    await H.until(() => (H.shape(T)?.tokens ?? 0) > 0, 30000);
    const hydrated = window.VendorTestExtras.hydratePartialDiff('clone', H.cv.getItem(T).fileDiff, H.contentsOf(T));
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    await H.until(() => H.shape(T).expandButtons > 0, 30000);
    await H.settle();

    const first = hydrated.hunks[0];
    const target = first.additionStart + first.additionCount + 400;
    const merged = {
      ...window.PierreContext.mergeContextRanges(hydrated, [{ startLine: target - 2, endLine: target + 5 }]),
      cacheKey: `${hydrated.cacheKey}|d1`,
    };
    const center = (H.root.clientHeight - ROW) / 2;
    // Publish the reveal and ask for the line in the same task.
    H.update(T, { fileDiff: merged });
    H.cv.render(true);
    H.cv.scrollTo({ type: 'line', id: T, lineNumber: target, side: 'additions', align: 'center' });
    H.cv.render(true);
    const displayedSync = !!H.findRow(T, target, 'additions');
    // The signal that the swap has landed (what whenLineDisplayed polls): the
    // instance displays the published metadata and the line is renderable in it.
    const displayed = await H.until(() => H.instance(T).getRenderedDiff() === merged && H.instance(T).isLineRenderable(target), 30000);
    await H.settle(200);
    const row = H.findRow(T, target, 'additions');
    const errorWithoutRetry = row ? +(H.viewportTopOf(row) - center).toFixed(2) : null;

    H.cv.scrollTo({ type: 'line', id: T, lineNumber: target, side: 'additions', align: 'center' });
    await H.settle(200);
    const errorAfterDisplay = +(H.viewportTopOf(H.findRow(T, target, 'additions')) - center).toFixed(2);
    return { displayedSync, displayed: displayed.ok, errorWithoutRetry, errorAfterDisplay, clean: H.auditClean() };
  }, ROW);

  expect(result.displayedSync).toBe(false);
  expect(result.displayed).toBe(true);
  // The early target was resolved against the old diff and never corrected.
  expect(result.errorWithoutRetry).not.toBe(0);
  expect(result.errorAfterDisplay).toBe(0);
  expect(result.clean).toBe(true);
});
