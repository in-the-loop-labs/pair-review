// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: the worker pool.
 *
 * Fact F18 (plans/codeview-virtualized-diff.md, "Vendor facts"): the pool is
 * what keeps highlighting off the main thread, and a worker that fails to load
 * falls back to main-thread rendering on the same CodeView instance.
 * Gate G7: a worker that loads and never answers falls back after
 * `workerInitializationTimeout`.
 *
 * Depends on it: PierreBridge._createWorkerManager passes
 * workerInitializationTimeout and nothing else; main's own 15 s timeout,
 * _fallbackToMainThreadRendering and _rebuildFileInstance are not ported.
 */

import { test, expect } from '../harness/contract-test.js';

/** The one message the vendor logs when worker initialization times out. */
const INIT_TIMEOUT_ERROR = /WorkerPoolManager: worker initialization timed out after \d+ms/;

/** Frames between "rows are in the DOM" and "rows are highlighted" for one item. */
async function highlightProfile(page, { pool, workerUrl, poolExtra }) {
  return page.evaluate(async ({ pool, workerUrl, poolExtra }) => {
    const H = window.H;
    const { roles } = H.workload;
    // 20,000 added lines: the whole file is in the patch and is tokenized as one job.
    const T = roles.hugeAdded;
    H.parse({});
    H.buildItems({ only: [T] });
    if (pool) H.createPool({ workerUrl, extra: poolExtra, onWorkerError: true });
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS, { pool });
    const codeView = H.cv;
    H.cv.setItems(H.items);
    const rows = await H.until(() => !!H.host(T) && H.shape(T).rows > 0, 30000);
    let framesWithPlainRows = 0;
    const tokens = await H.until(() => {
      if (H.shape(T).tokens > 0) return true;
      framesWithPlainRows++;
      return false;
    }, 60000);
    await H.settle();
    return {
      rowsOk: rows.ok,
      tokensOk: tokens.ok,
      framesWithPlainRows,
      sameCodeView: H.cv === codeView,
      stats: H.pool ? H.pool.getStats() : null,
      workerErrorEvents: H.eventsOf('workerErrorEvent').length,
      onWorkerErrorCalls: H.counts.onWorkerError || 0,
      clean: H.auditClean(),
      orphans: H.orphanHosts(),
    };
  }, { pool, workerUrl, poolExtra });
}

test('F18: with the pool a 20,000-line file is highlighted off the main thread; without it the main thread does it in one task', async ({ harness }) => {
  // The assertion is structural, not a timing: with the pool, animation frames
  // keep running while the rows are still plain text; on the main thread the
  // highlight is one blocking task, so almost no frame can observe plain rows.
  const withPool = await highlightProfile(await harness.open({ bundle: 'prod' }), { pool: true });
  const mainThread = await highlightProfile(await harness.open({ bundle: 'prod' }), { pool: false });

  expect(withPool.rowsOk && withPool.tokensOk).toBe(true);
  expect(mainThread.rowsOk && mainThread.tokensOk).toBe(true);
  expect(withPool.stats.workersFailed).toBe(false);
  expect(withPool.framesWithPlainRows).toBeGreaterThan(10);
  expect(mainThread.framesWithPlainRows).toBeLessThanOrEqual(3);
  await harness.record('F18-highlight-frames', {
    lines: 20000,
    framesWithPlainRowsWithPool: withPool.framesWithPlainRows,
    framesWithPlainRowsMainThread: mainThread.framesWithPlainRows,
  });
});

test('F18: a worker script that fails to load falls back to main-thread rendering on the same instance', async ({ harness }) => {
  const page = await harness.open();
  // The browser logs the failed script fetch; the vendor itself logs nothing.
  harness.allowErrors(page, /Failed to load resource/);
  const result = await highlightProfile(page, { pool: true, workerUrl: '/worker/missing.js' });

  expect(result.rowsOk).toBe(true);
  expect(result.tokensOk).toBe(true);
  expect(result.sameCodeView).toBe(true);
  expect(result.stats.workersFailed).toBe(true);
  expect(result.stats.totalWorkers).toBe(0);
  expect(result.workerErrorEvents).toBeGreaterThan(0);
  expect(result.onWorkerErrorCalls).toBeGreaterThan(0);
  expect(result.clean).toBe(true);
  expect(result.orphans).toBe(0);
});

test('G7: a worker that never answers falls back after workerInitializationTimeout', async ({ harness }) => {
  // The timeout is shortened to keep the test quick; the app passes 15000.
  const page = await harness.open();
  harness.allowErrors(page, INIT_TIMEOUT_ERROR);
  const result = await highlightProfile(page, {
    pool: true,
    workerUrl: '/worker/silent.js',
    poolExtra: { workerInitializationTimeout: 500 },
  });

  expect(result.rowsOk).toBe(true);
  expect(result.tokensOk).toBe(true);
  expect(result.sameCodeView).toBe(true);
  expect(result.stats.workersFailed).toBe(true);
  // No error event: the script loaded. The vendor's timeout is the only signal.
  expect(result.workerErrorEvents).toBe(0);
  // It is reported with exactly one console.error. The E2E console guard must
  // expect this message in a test that breaks the worker on purpose.
  expect(harness.errors(page).filter((text) => INIT_TIMEOUT_ERROR.test(text)).length).toBe(1);
  expect(result.clean).toBe(true);
  await harness.record('G7-silent-worker', { stats: result.stats, framesWithPlainRows: result.framesWithPlainRows });
});

test('G7: nothing is mounted while the pool is still initializing', async ({ harness }) => {
  // Depends on it: the timeout the app passes is how long a user with a
  // broken worker looks at an empty diff pane. The first render pass waits
  // for the pool whether or not it ever becomes ready.
  const page = await harness.open();
  harness.allowErrors(page, INIT_TIMEOUT_ERROR);
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    H.parse({});
    H.buildItems({ only: [roles.noNewline, roles.small] });
    H.createPool({ workerUrl: '/worker/silent.js', extra: { workerInitializationTimeout: 600 } });
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS, { pool: true });
    H.cv.setItems(H.items);
    H.cv.render(true);
    await H.raf(5);
    const whileWaiting = { mounted: H.mounted().length, state: H.pool.getStats().managerState };
    const mounted = await H.until(() => H.mounted().length === 2, 30000);
    return { whileWaiting, mounted: mounted.ok, failed: H.pool.getStats().workersFailed };
  });
  expect(result.whileWaiting.mounted).toBe(0);
  expect(result.mounted).toBe(true);
  expect(result.failed).toBe(true);
});
