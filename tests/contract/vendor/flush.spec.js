// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: where codeView.render(true) may be called from.
 *
 * Fact F4 (plans/codeview-virtualized-diff.md, "Vendor facts"): a synchronous
 * flush from inside renderAnnotation or renderCustomHeader corrupts the
 * layout and does not heal; from onPostRender, or deferred to a microtask, it
 * is clean.
 *
 * Depends on it: PierreBridge._flush. A depth counter around the vendor's
 * render callbacks turns a flush requested inside one into a microtask.
 */

import { test, expect, VALIDATOR_PATTERN } from '../harness/contract-test.js';

const PREPARED_LAYOUT_ERROR = /rendered a different diff than its prepared layout/;

/**
 * Publish one annotation on item A and flush, with `where` deciding which
 * callback issues extra flushes (at most twice, so a correct vendor cannot
 * loop).
 */
async function flushFrom(page, where) {
  return page.evaluate(async (where) => {
    const H = window.H;
    const { roles } = H.workload;
    const A = roles.noNewline;
    const B = roles.small;
    await H.appLike({ build: { only: [A, B] } });
    const lineA = H.item(A).fileDiff.hunks[0].additionStart + 1;
    const lineB = H.item(B).fileDiff.hunks[0].additionStart + 1;
    let n = 0;
    let thrown = null;
    const tryFlush = () => { try { H.cv.render(true); } catch (e) { thrown = String(e.message); } };
    const defaults = { ...H.hooks };
    if (where === 'renderAnnotation') {
      H.hooks.renderAnnotation = (...args) => { if (n++ < 2) tryFlush(); return defaults.renderAnnotation(...args); };
    } else if (where === 'renderCustomHeader') {
      H.hooks.renderCustomHeader = (...args) => { if (n++ < 2) tryFlush(); return defaults.renderCustomHeader(...args); };
    } else if (where === 'microtask from renderAnnotation') {
      H.hooks.renderAnnotation = (...args) => { if (n++ < 2) queueMicrotask(tryFlush); return defaults.renderAnnotation(...args); };
    } else if (where === 'onPostRender, publishing to another item') {
      H.hooks.onPostRender = (node, instance, phase, ctx) => {
        if (ctx.item.id === A && phase === 'update' && n++ < 1) {
          H.update(B, { annotations: [{ side: 'additions', lineNumber: lineB, metadata: { key: 'other' } }] });
          tryFlush();
        }
      };
    } else if (where === 'onPostRender, publishing to the same item') {
      H.hooks.onPostRender = (node, instance, phase, ctx) => {
        if (ctx.item.id === A && phase === 'update' && n++ < 2) {
          H.update(A, { annotations: [...H.cv.getItem(A).annotations, { side: 'additions', lineNumber: lineA, metadata: { key: `self${n}` } }] });
          tryFlush();
        }
      };
    }
    H.update(A, { annotations: [{ side: 'additions', lineNumber: lineA, metadata: { key: 'first' } }] });
    tryFlush();
    await H.settle(250);
    return {
      thrown,
      extraFlushes: n,
      cardsA: H.host(A).querySelectorAll('.ann').length,
      expectedA: H.cv.getItem(A).annotations.length,
      cardsB: H.host(B).querySelectorAll('.ann').length,
      expectedB: H.cv.getItem(B).annotations.length,
      clean: H.auditClean(),
    };
  }, where);
}

for (const where of ['renderAnnotation', 'renderCustomHeader']) {
  test(`F4 (vendor constraint): render(true) from inside ${where} corrupts the layout`, async ({ harness }) => {
    // This test asserts behaviour the bridge must AVOID. If it fails after a
    // @pierre/diffs bump the vendor may have made re-entrant flushes safe; the
    // bridge's microtask deferral stays correct either way.
    const page = await harness.open();
    harness.allowErrors(page, PREPARED_LAYOUT_ERROR, VALIDATOR_PATTERN);
    const result = await flushFrom(page, where);

    expect(result.thrown).toBeNull();
    expect(result.extraFlushes).toBeGreaterThan(0);
    // The vendor reports it, and the height mismatch is still there after settling.
    expect(harness.errors(page).filter((text) => PREPARED_LAYOUT_ERROR.test(text)).length).toBeGreaterThan(0);
    expect(result.clean).toBe(false);
  });
}

for (const where of [
  'microtask from renderAnnotation',
  'onPostRender, publishing to another item',
  'onPostRender, publishing to the same item',
]) {
  test(`F4: render(true) from ${where} is clean`, async ({ harness }) => {
    const page = await harness.open();
    const result = await flushFrom(page, where);

    expect(result.thrown).toBeNull();
    expect(result.extraFlushes).toBeGreaterThan(0);
    expect(result.cardsA).toBe(result.expectedA);
    expect(result.cardsB).toBe(result.expectedB);
    expect(result.clean).toBe(true);
    // Teardown asserts zero console errors, which includes the validator.
  });
}

test('a flush before the worker pool is ready mounts nothing; the publish is rendered once it is', async ({ harness }) => {
  // Depends on it: no consumer may read "card not in the DOM" as "line not
  // renderable" (plan hazard H23). The publish is not lost.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const A = roles.noNewline;
    H.parse({});
    H.buildItems({ only: [A, roles.small] });
    H.createPool({});
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS, { pool: true });
    H.cv.setItems(H.items);
    const line = H.item(A).fileDiff.hunks[0].additionStart + 1;
    H.update(A, { annotations: [{ side: 'additions', lineNumber: line, metadata: { key: 'early' } }] });
    H.cv.render(true);
    const sync = { mounted: H.mounted().length, built: H.annEls.has('early') };
    await H.until(() => H.annEls.has('early') && H.annEls.get('early').isConnected);
    await H.settle();
    return { sync, later: { mounted: H.mounted().length, connected: H.annEls.get('early').isConnected, cards: H.host(A).querySelectorAll('.ann').length } };
  });
  expect(result.sync).toEqual({ mounted: 0, built: false });
  expect(result.later).toEqual({ mounted: 2, connected: true, cards: 1 });
});

test('fifty publishes followed by one flush render each item once', async ({ harness }) => {
  // Depends on it: PierreBridge.batch(fn) flushes once when fn returns.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const A = roles.noNewline;
    const B = roles.small;
    await H.appLike({ build: { only: [A, B] } });
    const lineOf = (id) => H.item(id).fileDiff.hunks[0].additionStart + 1;
    H.clearEvents();
    for (let i = 0; i < 50; i++) {
      const id = i % 2 ? A : B;
      H.update(id, { annotations: [...H.cv.getItem(id).annotations, { side: 'additions', lineNumber: lineOf(id), metadata: { key: `b${i}` } }] });
    }
    const before = { postRender: H.eventsOf('onPostRender').length, cards: document.querySelectorAll('.ann').length };
    H.cv.render(true);
    const updates = H.eventsOf('onPostRender').filter((e) => e.phase === 'update');
    return {
      before,
      updatesPerItem: [updates.filter((e) => e.id === A).length, updates.filter((e) => e.id === B).length],
      cards: document.querySelectorAll('.ann').length,
      clean: H.auditClean(),
    };
  });
  expect(result.before).toEqual({ postRender: 0, cards: 0 });
  expect(result.updatesPerItem).toEqual([1, 1]);
  expect(result.cards).toBe(50);
  expect(result.clean).toBe(true);
});
