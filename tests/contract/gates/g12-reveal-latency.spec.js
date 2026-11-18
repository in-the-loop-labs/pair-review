// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Gate G12 (plans/codeview-virtualized-diff.md): reveal latency.
 *
 * "Reveal" is what happens when a comment, suggestion, chat link or tour stop
 * targets a line that the diff does not show: the app adds a context range and
 * the row appears. This spec measures, on the 3,000-line workload file (about
 * 300,000 characters of old plus new contents) and with the worker pool, the
 * time from the reveal being asked for to the diff that has the line being
 * displayed and painted:
 *
 *   - on a raw CodeView item (updateItem with re-keyed merged metadata):
 *     what the vendor costs by itself;
 *   - through PierreBridge (`addContextRanges`): what the application pays.
 *
 * The bar: the bridge's median is no more than 20% over the raw item's, both
 * measured in this one test, one after the other. It is the one timing the
 * contract suite asserts on.
 *
 * History of the gate. Until the per-file renderer was deleted this spec had
 * a third leg, that renderer's own bridge on the same file, and the bar was
 * "the new bridge no more than 20% over the per-file renderer". Last
 * measured with all three (phase 7 of the migration, one run): per-file
 * renderer median 809 ms, raw CodeView item 827 ms, this bridge 837 ms. The
 * comparison with that renderer now lives in tests/parity/perf.mjs
 * (`revealMs` against a saved reference).
 */

import { test, expect } from '../harness/contract-test.js';
import { openBridge } from '../bridge/bridge-test.js';

const RUNS = 5;

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

test('G12: reveal latency through PierreBridge is within 20% of a raw CodeView item', async ({ harness }) => {
  test.setTimeout(120000);

  // ---- a raw CodeView item: a reveal as an item update with re-keyed metadata ----
  const codeViewPage = await harness.open({ bundle: 'prod', scripts: ['/app/js/modules/pierre-context.js'] });
  const codeView = await codeViewPage.evaluate(async (RUNS) => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({ parse: { cacheKeyPrefix: 'contract:1' }, build: { only: [T] }, pool: true, options: { __devOnlyValidateItemHeights: false } });
    // Not yet mounted reads as "not yet": with the pool nothing is mounted
    // until its workers are up (G7), which under load is after the bring-up's
    // quiet period.
    await H.until(() => (H.shape(T)?.tokens ?? 0) > 0, 30000);
    const instance = H.instance(T);
    const hydrated = window.VendorTestExtras.hydratePartialDiff('clone', H.cv.getItem(T).fileDiff, H.contentsOf(T));
    const upgradeStart = performance.now();
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    const upgraded = await H.until(() => instance.getRenderedDiff() === hydrated, 30000);
    const upgradeMs = +(performance.now() - upgradeStart).toFixed(0);

    const first = hydrated.hunks[0];
    const ranges = [];
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const line = first.additionStart + first.additionCount + 60 + i * 120;
      ranges.push({ startLine: line - 2, endLine: line + 5 });
      const merged = { ...window.PierreContext.mergeContextRanges(hydrated, ranges), cacheKey: `${hydrated.cacheKey}|d${i + 1}` };
      const start = performance.now();
      H.update(T, { fileDiff: merged });
      H.cv.render(true);
      const sync = instance.getRenderedDiff() === merged;
      const shown = await H.until(() => instance.getRenderedDiff() === merged, 30000);
      await H.raf(1);
      samples.push({ ok: shown.ok, sync, ms: +(performance.now() - start).toFixed(0), frames: shown.frames });
    }
    return { upgraded: upgraded.ok, upgradeMs, samples };
  }, RUNS);

  // ---- the same reveal through PierreBridge ----
  const bridgePage = await openBridge(harness, { bundle: 'prod' });
  const newBridge = await bridgePage.evaluate(async (RUNS) => {
    const { H, BH } = window;
    const T = H.workload.roles.large;
    await BH.up({ entries: [BH.diffEntry(T)] });
    const b = BH.bridge;
    const row = (line) => H.host(T)?.shadowRoot?.querySelector(`[data-content] > [data-line="${line}"]`) || null;
    await H.until(() => (H.shape(T)?.tokens ?? 0) > 0, 30000);
    const { oldFile, newFile } = H.contentsOf(T);
    const chars = oldFile.contents.length + newFile.contents.length;
    const upgradeStart = performance.now();
    b.upgradeFileContents(T, oldFile, newFile);
    const upgraded = await H.until(() => b.isDiffDisplayed(T), 30000);
    const upgradeMs = +(performance.now() - upgradeStart).toFixed(0);
    const first = b.files.get(T).baseMetadata.hunks[0];
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const line = first.additionStart + first.additionCount + 60 + i * 120;
      const start = performance.now();
      b.addContextRanges(T, [{ startLine: line - 2, endLine: line + 5 }]);
      const visibleByOracle = b.isLineVisible(T, line, 'RIGHT');
      const sync = b.isDiffDisplayed(T);
      // The pane is at the file's top; the revealed lines are further down
      // than the pane is tall, so "displayed" is the viewer drawing the diff
      // that has them, which is what a row of them waits for.
      const shown = await H.until(() => b.isDiffDisplayed(T), 30000);
      await H.raf(1);
      samples.push({ ok: shown.ok, sync, ms: +(performance.now() - start).toFixed(0), frames: shown.frames, visibleByOracle });
    }
    return { upgraded: upgraded.ok, upgradeMs, samples, usesPool: !!b.workerManager, chars };
  }, RUNS);

  expect(codeView.upgraded).toBe(true);
  for (const sample of codeView.samples) {
    expect(sample.ok).toBe(true);
    expect(sample.sync).toBe(false);
  }

  expect(newBridge.usesPool).toBe(true);
  expect(newBridge.upgraded).toBe(true);
  expect(newBridge.chars).toBeGreaterThan(290000);
  for (const sample of newBridge.samples) {
    expect(sample.ok).toBe(true);
    // The data-level answer is immediate; the display lags by a worker round trip.
    expect(sample.visibleByOracle).toBe(true);
    expect(sample.sync).toBe(false);
  }
  const rawMedian = median(codeView.samples.map((s) => s.ms));
  const newBridgeMedian = median(newBridge.samples.map((s) => s.ms));
  test.info().annotations.push({ type: 'measured', description: `reveal median: raw CodeView item ${rawMedian} ms, PierreBridge ${newBridgeMedian} ms` });
  // The one timing this suite asserts on: both medians are of the same file
  // in the same test, one after the other.
  expect(newBridgeMedian).toBeLessThanOrEqual(rawMedian * 1.2);

  await harness.record('G12-reveal-latency', {
    newBridge: {
      upgradeMs: newBridge.upgradeMs,
      revealMs: newBridge.samples.map((s) => s.ms),
      revealMedianMs: newBridgeMedian,
      revealFrames: newBridge.samples.map((s) => s.frames),
    },
    file: { chars: newBridge.chars, lines: 3000 },
    runs: RUNS,
    codeViewRawItem: {
      upgradeMs: codeView.upgradeMs,
      revealMs: codeView.samples.map((s) => s.ms),
      revealMedianMs: rawMedian,
      revealFrames: codeView.samples.map((s) => s.frames),
    },
  });
});
