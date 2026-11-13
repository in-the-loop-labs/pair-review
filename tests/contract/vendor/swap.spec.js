// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: replacing an item's fileDiff (content upgrade, context
 * reveal) under the worker pool.
 *
 * Facts (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F5  with the pool, a replaced fileDiff is displayed later, not in the task
 *       that published it; without the pool it is synchronous
 *   F6  while that swap is pending, an annotation-only publish is held back
 *   F7  derived metadata published under the SAME cacheKey is never displayed
 *   F8  without a cacheKey every remount shows plain text first
 */

import { test, expect } from '../harness/contract-test.js';

const CONTEXT_MODULE = '/app/js/modules/pierre-context.js';

/**
 * Bring up the 3,000-line file (about 300,000 characters of old plus new
 * contents) first in the list, and wait for its first highlight to land so a
 * later change of what is displayed can only come from the swap under test.
 */
async function bringUpLarge(page, { pool, keys = true }) {
  return page.evaluate(async ({ pool, keys }) => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({
      parse: keys ? { cacheKeyPrefix: 'contract:1' } : {},
      build: { only: [T, roles.noNewline] },
      pool,
    });
    await H.until(() => H.shape(T).tokens > 0, 30000);
    await H.settle();
    const base = H.cv.getItem(T).fileDiff;
    const firstHunk = base.hunks[0];
    return {
      T,
      chars: H.workload.files[T].old.length + H.workload.files[T].new.length,
      baseKey: base.cacheKey || null,
      // A line that is rendered before and after hydration.
      visibleLine: firstHunk.additionStart + 1,
      // A line 30 below the first hunk: inside a collapsed gap.
      gapLine: firstHunk.additionStart + firstHunk.additionCount + 30,
      before: H.shape(T),
    };
  }, { pool, keys });
}

test('F5: with the worker pool, a replaced fileDiff is not displayed in the publishing task', async ({ harness }) => {
  // Depends on it: reveal and upgrade are asynchronous in the DOM.
  // PierreBridge.isLineVisible answers from the bridge's own metadata, and
  // revealInDiff waits with PierreBridge.whenLineDisplayed before scrolling.
  const page = await harness.open();
  const info = await bringUpLarge(page, { pool: true });
  expect(info.chars).toBeGreaterThan(290000);
  expect(info.before.expandButtons).toBe(0);

  const result = await page.evaluate(async (T) => {
    const H = window.H;
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', H.cv.getItem(T).fileDiff, H.contentsOf(T));
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    const sync = {
      shape: H.shape(T),
      // The data is already the new diff; only the display lags.
      itemHasNewDiff: H.cv.getItem(T).fileDiff === hydrated,
      instanceHasNewDiff: H.instance(T).fileDiff === hydrated,
    };
    const displayed = await H.until(() => H.shape(T).expandButtons > 0, 30000);
    await H.settle();
    return { sync, displayed, after: H.shape(T), clean: H.auditClean() };
  }, info.T);

  expect(result.sync.itemHasNewDiff).toBe(true);
  expect(result.sync.instanceHasNewDiff).toBe(true);
  expect(result.sync.shape.expandButtons).toBe(0);
  expect(result.sync.shape.rows).toBe(info.before.rows);
  expect(result.displayed.ok).toBe(true);
  // At least one frame passed before the new diff was shown.
  expect(result.displayed.frames).toBeGreaterThan(0);
  expect(result.after.expandButtons).toBeGreaterThan(0);
  expect(result.clean).toBe(true);
  await harness.record('F5-swap-latency-pool', { chars: info.chars, ms: result.displayed.ms, frames: result.displayed.frames });
});

test('F5: without the worker pool, a replaced fileDiff is displayed synchronously by render(true)', async ({ harness }) => {
  const page = await harness.open();
  const info = await bringUpLarge(page, { pool: false });
  const result = await page.evaluate(async (T) => {
    const H = window.H;
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', H.cv.getItem(T).fileDiff, H.contentsOf(T));
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    return { sync: H.shape(T), clean: H.auditClean() };
  }, info.T);
  expect(result.sync.expandButtons).toBeGreaterThan(0);
  expect(result.clean).toBe(true);
});

test('F6: an annotation-only publish during a pending swap is held back and appears with the swap', async ({ harness }) => {
  // Depends on it: card lookups go through PierreBridge.getAnnotationElement
  // (which can build eagerly), never through "is the card in the DOM";
  // PierreBridge.whenAnnotationRendered is time-based for the same reason.
  const page = await harness.open();
  const info = await bringUpLarge(page, { pool: true });
  const result = await page.evaluate(async ({ T, visibleLine }) => {
    const H = window.H;
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', H.cv.getItem(T).fileDiff, H.contentsOf(T));
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    // The line is rendered right now (old diff) and will be rendered after the swap.
    const lineRenderedNow = !!H.findRow(T, visibleLine);
    H.update(T, { annotations: [{ side: 'additions', lineNumber: visibleLine, metadata: { key: 'held' } }] });
    H.cv.render(true);
    const el = () => H.annEls.get('held');
    const sync = { built: !!el(), connected: !!(el() && el().isConnected), expandButtons: H.shape(T).expandButtons };
    const shown = await H.until(() => el() && el().isConnected && el().getBoundingClientRect().height > 0, 30000);
    const whenShown = { expandButtons: H.shape(T).expandButtons };
    await H.settle();
    return { lineRenderedNow, sync, shown, whenShown, clean: H.auditClean() };
  }, info);

  expect(result.lineRenderedNow).toBe(true);
  expect(result.sync).toEqual({ built: false, connected: false, expandButtons: 0 });
  expect(result.shown.ok).toBe(true);
  expect(result.shown.frames).toBeGreaterThan(0);
  // The card arrived together with the new diff, not before it.
  expect(result.whenShown.expandButtons).toBeGreaterThan(0);
  expect(result.clean).toBe(true);
  await harness.record('F6-held-annotation-latency', { ms: result.shown.ms, frames: result.shown.frames });
});

test('F7: derived metadata published with the same cacheKey is never displayed; a new key is', async ({ harness }) => {
  // Depends on it: PierreBridge._rekey. Every derived metadata (context
  // ranges, hydration) is published under `<baseKey>|d<n>`.
  // PierreContext.mergeContextRanges copies the key of its input, which is
  // exactly the trap.
  const page = await harness.open({ scripts: [CONTEXT_MODULE] });
  const info = await bringUpLarge(page, { pool: true });
  expect(info.baseKey).toMatch(/^ck1:/);

  const result = await page.evaluate(async ({ T, visibleLine, gapLine }) => {
    const H = window.H;
    const out = {};
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', H.cv.getItem(T).fileDiff, H.contentsOf(T));
    out.hydratedKey = hydrated.cacheKey;
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    await H.until(() => H.shape(T).expandButtons > 0, 30000);
    await H.settle();
    out.gapLineHiddenAtStart = !H.findRow(T, gapLine);

    // Reveal ten lines of the gap, keeping the key the merge copied.
    const range = [{ startLine: gapLine, endLine: gapLine + 9 }];
    const sameKey = window.PierreContext.mergeContextRanges(hydrated, range);
    out.mergeCopiedTheKey = sameKey.cacheKey === hydrated.cacheKey;
    out.mergeAddedAHunk = sameKey.hunks.length === hydrated.hunks.length + 1;
    H.update(T, { fileDiff: sameKey });
    H.cv.render(true);
    // Sentinel on the same item: an annotation published AFTER the metadata.
    // When its card is displayed the item has been rendered again with the
    // same-key metadata as its input.
    H.update(T, { annotations: [{ side: 'additions', lineNumber: visibleLine, metadata: { key: 'sentinel' } }] });
    H.cv.render(true);
    const sentinel = () => H.annEls.get('sentinel');
    out.sentinel = await H.until(() => sentinel() && sentinel().isConnected && sentinel().getBoundingClientRect().height > 0, 30000);
    await H.raf(2);
    out.sameKeyDisplayed = !!H.findRow(T, gapLine + 2);

    // The same metadata under a new key is displayed.
    const newKey = { ...sameKey, cacheKey: `${hydrated.cacheKey}|d1` };
    H.update(T, { fileDiff: newKey });
    H.cv.render(true);
    out.newKey = await H.until(() => !!H.findRow(T, gapLine + 2), 30000);
    await H.settle();
    out.rowType = H.findRow(T, gapLine + 2).getAttribute('data-line-type');
    out.clean = H.auditClean();
    return out;
  }, info);

  expect(result.hydratedKey).toBe(`${info.baseKey}:hydrated`);
  expect(result.gapLineHiddenAtStart).toBe(true);
  expect(result.mergeCopiedTheKey).toBe(true);
  expect(result.mergeAddedAHunk).toBe(true);
  expect(result.sentinel.ok).toBe(true);
  expect(result.sameKeyDisplayed).toBe(false);
  expect(result.newKey.ok).toBe(true);
  expect(result.rowType).toBe('context');
  expect(result.clean).toBe(true);
});

for (const keys of [false, true]) {
  test(`F8: a remount ${keys ? 'with cacheKeyPrefix shows highlighted rows at once' : 'without a cacheKey shows plain text first'}`, async ({ harness }) => {
    // Depends on it: PierreBridge parses with
    // parsePatchFiles(patch, { cacheKeyPrefix: '<reviewId>:<renderGen>:<fileIndex>' }).
    const page = await harness.open();
    const result = await page.evaluate(async (keys) => {
      const H = window.H;
      const tokenCount = (node) => node.shadowRoot.querySelectorAll('[data-content] > [data-line] span[style*="--diffs-token"]').length;
      const T = H.workload.modifiedPaths[3];
      const remounts = [];
      let watching = false;
      H.hooks.onPostRender = (node, instance, phase, ctx) => {
        if (watching && ctx.item.id === T && phase === 'mount') {
          remounts.push({ rows: node.shadowRoot.querySelectorAll('[data-content] > [data-line]').length, tokens: tokenCount(node) });
        }
      };
      await H.appLike({
        parse: keys ? { cacheKeyPrefix: 'contract:1' } : {},
        build: { only: H.workload.modifiedPaths.slice(0, 30) },
        pool: true,
      });
      H.cv.scrollTo({ type: 'item', id: T });
      await H.until(() => H.host(T) && tokenCount(H.host(T)) > 0, 30000);
      await H.settle();

      H.cv.scrollTo({ type: 'item', id: H.workload.modifiedPaths[25] });
      await H.until(() => !H.mounted().includes(T));
      await H.settle();

      watching = true;
      H.cv.scrollTo({ type: 'item', id: T });
      await H.until(() => H.host(T) && tokenCount(H.host(T)) > 0, 30000);
      return { remounts, tokensEventually: tokenCount(H.host(T)) > 0 };
    }, keys);

    expect(result.remounts.length).toBeGreaterThanOrEqual(1);
    expect(result.remounts[0].rows).toBeGreaterThan(0);
    if (keys) expect(result.remounts[0].tokens).toBeGreaterThan(0);
    else expect(result.remounts[0].tokens).toBe(0);
    expect(result.tokensEventually).toBe(true);
  });
}
