// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Gate G12 (plans/codeview-virtualized-diff.md): reveal latency on the CURRENT
 * engine, as a baseline for the cut-over.
 *
 * "Reveal" is what happens when a comment, suggestion, chat link or tour stop
 * targets a line that the diff does not show: the app adds a context range and
 * the row appears. This spec drives main's real PierreBridge (per-file
 * FileDiff, worker pool, pierre-context.js) on the 3,000-line workload file,
 * about 300,000 characters of old plus new contents, and measures the time from
 * `bridge.addContextRanges()` to the revealed row being in the DOM and painted.
 *
 * The same reveal on a raw CodeView item (updateItem with re-keyed merged
 * metadata) is measured next to it, on the same page load pattern, so the two
 * engines can be compared before any bridge code exists.
 *
 * Timings are recorded, never asserted on. The assertions are that each reveal
 * is displayed and that it is asynchronous on both engines.
 */

import { test, expect } from '../harness/contract-test.js';
import { openBridge } from '../bridge/bridge-test.js';

const RUNS = 5;

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

test('G12: reveal latency through main\'s PierreBridge (FileDiff) and through a raw CodeView item', async ({ harness }) => {
  test.setTimeout(120000);

  // ---- current engine: main's bridge, per-file FileDiff ----
  const fileDiffPage = await harness.open({
    bundle: 'prod',
    scripts: ['/app/js/modules/pierre-context.js', '/app/js/modules/pierre-styles.js', '/app/js/modules/pierre-annotations.js', '/app/js/modules/pierre-bridge.js'],
  });
  const current = await fileDiffPage.evaluate(async (RUNS) => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    H.root = document.getElementById('root');
    const container = document.createElement('div');
    container.className = 'pierre-diff-body';
    H.root.appendChild(container);

    const bridge = new window.PierreBridge({ theme: 'light' });
    await H.until(() => bridge._workerReady === true, 30000);
    const usesPool = !!bridge.workerManager && bridge._workerReady && !bridge._workersFailed;
    bridge.renderFile(T, container, H.workload.patches[T]);
    const shadow = () => container.querySelector('diffs-container').shadowRoot;
    const tokens = () => shadow().querySelectorAll('[data-content] > [data-line] span[style*="--diffs-token"]').length;
    const row = (line) => [...shadow().querySelectorAll('[data-content] > [data-line]')].find((el) => el.getAttribute('data-line') === String(line));
    const buttons = () => shadow().querySelectorAll('[data-gutter] > [data-separator] [data-expand-button]').length;
    await H.until(() => tokens() > 0, 30000);

    const { oldFile, newFile } = H.contentsOf(T);
    const upgradeStart = performance.now();
    bridge.upgradeFileContents(T, oldFile, newFile);
    const upgraded = await H.until(() => buttons() > 0, 30000);
    const upgradeMs = +(performance.now() - upgradeStart).toFixed(0);

    const first = bridge.files.get(T).baseMetadata.hunks[0];
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const line = first.additionStart + first.additionCount + 60 + i * 120;
      const start = performance.now();
      bridge.addContextRanges(T, [{ startLine: line - 2, endLine: line + 5 }]);
      const sync = !!row(line);
      const shown = await H.until(() => !!row(line), 30000);
      await H.raf(1); // the frame in which the row is painted
      samples.push({ ok: shown.ok, sync, ms: +(performance.now() - start).toFixed(0), frames: shown.frames, visibleByOracle: bridge.isLineVisible(T, line, 'RIGHT') });
    }
    return { usesPool, upgraded: upgraded.ok, upgradeMs, chars: oldFile.contents.length + newFile.contents.length, samples };
  }, RUNS);

  // ---- CodeView: the same reveal as an item update with re-keyed metadata ----
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
    const hydrated = window.PierreDiffs.hydratePartialDiff('clone', H.cv.getItem(T).fileDiff, H.contentsOf(T));
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

  // ---- the new bridge: the same reveal through PierreCodeViewBridge ----
  // (Phase 7's bar: no worse than the current engine's median in this same
  // run, plus 20%.)
  const bridgePage = await openBridge(harness, { bundle: 'prod' });
  const newBridge = await bridgePage.evaluate(async (RUNS) => {
    const { H, BH } = window;
    const T = H.workload.roles.large;
    await BH.up({ entries: [BH.diffEntry(T)] });
    const b = BH.bridge;
    const row = (line) => H.host(T)?.shadowRoot?.querySelector(`[data-content] > [data-line="${line}"]`) || null;
    await H.until(() => (H.shape(T)?.tokens ?? 0) > 0, 30000);
    const { oldFile, newFile } = H.contentsOf(T);
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
    return { upgraded: upgraded.ok, upgradeMs, samples, usesPool: !!b.workerManager };
  }, RUNS);

  expect(current.usesPool).toBe(true);
  expect(current.upgraded).toBe(true);
  expect(current.chars).toBeGreaterThan(290000);
  for (const sample of current.samples) {
    expect(sample.ok).toBe(true);
    // Data-level answer is immediate on main; the DOM lags by a worker round trip.
    expect(sample.visibleByOracle).toBe(true);
    expect(sample.sync).toBe(false);
  }
  expect(codeView.upgraded).toBe(true);
  for (const sample of codeView.samples) {
    expect(sample.ok).toBe(true);
    expect(sample.sync).toBe(false);
  }

  expect(newBridge.usesPool).toBe(true);
  expect(newBridge.upgraded).toBe(true);
  for (const sample of newBridge.samples) {
    expect(sample.ok).toBe(true);
    expect(sample.visibleByOracle).toBe(true);
    expect(sample.sync).toBe(false);
  }
  const currentMedian = median(current.samples.map((s) => s.ms));
  const newBridgeMedian = median(newBridge.samples.map((s) => s.ms));
  test.info().annotations.push({ type: 'measured', description: `reveal median: current engine ${currentMedian} ms, new bridge ${newBridgeMedian} ms` });
  // The one timing this suite asserts on, because the plan sets it as a bar:
  // both medians are of the same file in the same test, one after the other.
  expect(newBridgeMedian).toBeLessThanOrEqual(currentMedian * 1.2);

  await harness.record('G12-reveal-latency', {
    newBridge: {
      upgradeMs: newBridge.upgradeMs,
      revealMs: newBridge.samples.map((s) => s.ms),
      revealMedianMs: newBridgeMedian,
      revealFrames: newBridge.samples.map((s) => s.frames),
    },
    file: { chars: current.chars, lines: 3000 },
    runs: RUNS,
    currentEngineFileDiff: {
      upgradeMs: current.upgradeMs,
      revealMs: current.samples.map((s) => s.ms),
      revealMedianMs: median(current.samples.map((s) => s.ms)),
      revealFrames: current.samples.map((s) => s.frames),
    },
    codeViewRawItem: {
      upgradeMs: codeView.upgradeMs,
      revealMs: codeView.samples.map((s) => s.ms),
      revealMedianMs: median(codeView.samples.map((s) => s.ms)),
      revealFrames: codeView.samples.map((s) => s.frames),
    },
  });
});
