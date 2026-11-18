// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Gate G10 (plans/codeview-virtualized-diff.md): what happens when something
 * else is published to an item while a worker-pool diff swap is pending on it
 * (fact F5): a collapse, a theme change, a second replacement.
 *
 * Depends on it: whether PierreBridge must serialise fileDiff replacements per
 * item. The assertions are about the END state (the last publish wins, layout
 * exact, no error); the order of intermediate states is recorded.
 */

import { test, expect } from '../harness/contract-test.js';

const CONTEXT_MODULE = '/app/js/modules/pierre-context.js';

/** Bring up the 3,000-line file with pool and keys; hand back a hydrated diff ready to publish. */
async function prepare(page) {
  return page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({ parse: { cacheKeyPrefix: 'contract:1' }, build: { only: [T, roles.noNewline] }, pool: true });
    // Not yet mounted reads as "not yet": with the pool nothing is mounted
    // until its workers are up (G7), which under load is after the bring-up's
    // quiet period.
    await H.until(() => (H.shape(T)?.tokens ?? 0) > 0, 30000);
    await H.settle();
    const base = H.cv.getItem(T).fileDiff;
    window.__hydrated = window.VendorTestExtras.hydratePartialDiff('clone', base, H.contentsOf(T));
    const first = base.hunks[0];
    return { T, gapLine: first.additionStart + first.additionCount + 30, expandedHeight: H.itemHeight(T) };
  });
}

test('G10: collapsing an item while its diff swap is pending', async ({ harness }) => {
  const page = await harness.open();
  const info = await prepare(page);
  const result = await page.evaluate(async ({ T }) => {
    const H = window.H;
    const instance = H.instance(T);
    const hydrated = window.__hydrated;
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    const pending = instance.getRenderedDiff() !== hydrated;
    H.update(T, { collapsed: true });
    H.cv.render(true);
    const collapsedSync = { height: H.itemHeight(T), hasPre: H.shape(T).hasPre };
    // Let the worker answer for the diff nobody is looking at.
    await H.settle(400, 15000);
    const whileCollapsed = { height: H.itemHeight(T), hasPre: H.shape(T).hasPre, clean: H.auditClean() };
    H.update(T, { collapsed: false });
    H.cv.render(true);
    const shown = await H.until(() => H.shape(T).hasPre && H.shape(T).expandButtons > 0 && instance.getRenderedDiff() === hydrated, 30000);
    await H.settle();
    return { pending, collapsedSync, whileCollapsed, shown, expanded: { shape: H.shape(T), clean: H.auditClean() } };
  }, info);

  expect(result.pending).toBe(true);
  expect(result.collapsedSync).toEqual({ height: 40, hasPre: false });
  expect(result.whileCollapsed).toEqual({ height: 40, hasPre: false, clean: true });
  expect(result.shown.ok).toBe(true);
  expect(result.expanded.shape.expandButtons).toBeGreaterThan(0);
  expect(result.expanded.clean).toBe(true);
  await harness.record('G10-collapse-during-pending-swap', {
    collapsedInSameTask: result.collapsedSync,
    framesFromExpandToHydratedDisplayed: result.shown.frames,
    msFromExpandToHydratedDisplayed: result.shown.ms,
  });
});

test('G10: a theme change while a diff swap is pending', async ({ harness }) => {
  const page = await harness.open();
  const info = await prepare(page);
  const result = await page.evaluate(async ({ T }) => {
    const H = window.H;
    const instance = H.instance(T);
    const hydrated = window.__hydrated;
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    const pending = instance.getRenderedDiff() !== hydrated;
    // The app's order: render options to the pool, then one setOptions.
    H.pool.setRenderOptions({ theme: { dark: 'github-dark', light: 'github-light' }, lineDiffType: 'word' });
    H.setOptions({ themeType: 'dark' });
    const landed = await H.until(() => instance.getRenderedDiff() === hydrated && H.shape(T).expandButtons > 0 && H.shape(T).tokens > 0, 30000);
    await H.settle();
    return {
      pending,
      landed,
      colorScheme: getComputedStyle(H.host(T)).colorScheme,
      shape: H.shape(T),
      clean: H.auditClean(),
    };
  }, info);

  expect(result.pending).toBe(true);
  expect(result.landed.ok).toBe(true);
  expect(result.colorScheme).toBe('dark');
  expect(result.shape.expandButtons).toBeGreaterThan(0);
  expect(result.shape.tokens).toBeGreaterThan(0);
  expect(result.clean).toBe(true);
  await harness.record('G10-theme-during-pending-swap', { framesToDisplayed: result.landed.frames, msToDisplayed: result.landed.ms });
});

test('G10: a second replacement issued before the first is displayed', async ({ harness }) => {
  const page = await harness.open({ scripts: [CONTEXT_MODULE] });
  const info = await prepare(page);
  const result = await page.evaluate(async ({ T, gapLine }) => {
    const H = window.H;
    const instance = H.instance(T);
    const hydrated = window.__hydrated;
    const revealed = {
      ...window.PierreContext.mergeContextRanges(hydrated, [{ startLine: gapLine, endLine: gapLine + 9 }]),
      cacheKey: `${hydrated.cacheKey}|d1`,
    };
    H.update(T, { fileDiff: hydrated });
    H.cv.render(true);
    H.update(T, { fileDiff: revealed });
    H.cv.render(true);
    // Sample what is displayed on every frame until the last publish is shown.
    const states = [];
    const label = () => {
      const rendered = instance.getRenderedDiff();
      const which = rendered === revealed ? 'revealed' : rendered === hydrated ? 'hydrated' : 'base';
      return `${which}:${H.shape(T).expandButtons > 0 ? 'controls' : 'no-controls'}:${H.findRow(T, gapLine + 2) ? 'row' : 'no-row'}`;
    };
    const landed = await H.until(() => {
      const state = label();
      if (states[states.length - 1] !== state) states.push(state);
      return instance.getRenderedDiff() === revealed;
    }, 30000);
    await H.settle();
    const finalState = label();
    if (states[states.length - 1] !== finalState) states.push(finalState);
    return { landed, states, finalRow: !!H.findRow(T, gapLine + 2), itemIsRevealed: H.cv.getItem(T).fileDiff === revealed, clean: H.auditClean() };
  }, info);

  expect(result.landed.ok).toBe(true);
  expect(result.itemIsRevealed).toBe(true);
  expect(result.finalRow).toBe(true);
  expect(result.states[result.states.length - 1]).toBe('revealed:controls:row');
  // The revealed row never appears and then disappears again.
  const firstWithRow = result.states.findIndex((state) => state.endsWith(':row'));
  expect(result.states.slice(firstWithRow).every((state) => state.endsWith(':row'))).toBe(true);
  expect(result.clean).toBe(true);
  await harness.record('G10-second-replacement-before-first-lands', { statesInOrder: result.states, framesToFinal: result.landed.frames, msToFinal: result.landed.ms });
});
