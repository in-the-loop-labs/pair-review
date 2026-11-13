// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: changing the item list.
 *
 * Facts (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F1  setItems / removeItem that shift a MOUNTED item's index corrupt the
 *       layout (a vendor bug, asserted as a bug so a fix is noticed)
 *   F2  clear-then-set in one task is safe, and a line scroll target restores
 *       the view exactly (item top plus a pixel offset does not, always)
 */

import { test, expect, VALIDATOR_PATTERN } from '../harness/contract-test.js';

/**
 * Scroll so that item V's header sits 150 px below the viewport top, which
 * leaves V and the items after it mounted with the viewport top in the item
 * above V. Returns V and the ids mounted there.
 */
async function parkAboveV(page) {
  return page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { exclude: [roles.hugeAdded, roles.hugeModified] } });
    const V = H.workload.modifiedPaths[10];
    H.cv.scrollTo({ type: 'item', id: V, offset: 150 });
    await H.settle(300);
    return { V, mounted: H.mounted(), orphans: H.orphanHosts(), clean: H.auditClean() };
  });
}

test('F1 (vendor bug): setItems that inserts next to a mounted item leaves an orphan host and a broken layout', async ({ harness }) => {
  // Depends on it: PierreBridge.renderAll is the ONLY writer of the list and
  // always replaces it (setItems([]) then setItems(next)); the bridge has no
  // insertItem / removeItem / addItem.
  //
  // THIS TEST ASSERTS A VENDOR BUG. If it fails after a @pierre/diffs bump,
  // the bug may be fixed: re-read plan fact F1 before changing the bridge.
  const page = await harness.open();
  harness.allowErrors(page, VALIDATOR_PATTERN);
  const before = await parkAboveV(page);
  expect(before.mounted).toContain(before.V);
  expect(before.orphans).toBe(0);
  expect(before.clean).toBe(true);

  const after = await page.evaluate(async (V) => {
    const H = window.H;
    const next = H.items.slice();
    next.splice(next.findIndex((i) => i.id === V) + 1, 0, H.makeFileItem('inserted'));
    H.cv.setItems(next);
    H.items = next;
    await H.settle(400);
    const afterSettle = H.orphanHosts();
    // It does not heal: not on a forced render, not on a scroll, not after
    // scrolling away and back.
    H.cv.render(true);
    H.root.scrollTop += 1;
    await H.settle(300);
    const afterRenderAndScroll = H.orphanHosts();
    H.cv.scrollTo({ type: 'item', id: H.workload.modifiedPaths[30] });
    await H.settle(300);
    H.cv.scrollTo({ type: 'item', id: V, offset: 150 });
    await H.settle(300);
    return { afterSettle, afterRenderAndScroll, afterAwayAndBack: H.orphanHosts() };
  }, before.V);

  // A <diffs-container> that is in the DOM but not in getRenderedItems().
  expect(after.afterSettle).toBeGreaterThanOrEqual(1);
  expect(after.afterRenderAndScroll).toBeGreaterThanOrEqual(1);
  expect(after.afterAwayAndBack).toBeGreaterThanOrEqual(1);
  // The vendor's own validator sees the extra height.
  expect(harness.validatorErrors(page).length).toBeGreaterThan(0);
});

test('F1 (vendor bug): removeItem of a mounted item leaves mis-accounted height', async ({ harness }) => {
  // Depends on it: same as above. THIS TEST ASSERTS A VENDOR BUG.
  //
  // Timing matters, and that is part of the finding: the corruption appears
  // when removeItem runs inside an animation-frame callback (as here, right
  // after `await H.raf()`), and did not appear in this workload when the same
  // call ran from a separate task. An app cannot promise which of the two a
  // given call site is, so the bridge must not call removeItem at all.
  const page = await harness.open();
  harness.allowErrors(page, VALIDATOR_PATTERN);

  const after = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { exclude: [roles.hugeAdded, roles.hugeModified] } });
    const V = H.workload.modifiedPaths[10];
    H.cv.scrollTo({ type: 'item', id: V, offset: 150 });
    await H.settle(300);
    const cleanBefore = H.auditClean();
    await H.raf(1);
    const index = H.items.findIndex((i) => i.id === V);
    const removed = H.cv.removeItem(H.items[index + 1].id);
    await H.settle(400);
    const cleanAfterSettle = H.auditClean();
    H.cv.render(true);
    H.root.scrollTop += 1;
    await H.settle(300);
    return { cleanBefore, removed, cleanAfterSettle, cleanAfterRenderAndScroll: H.auditClean(), orphans: H.orphanHosts() };
  });

  expect(after.cleanBefore).toBe(true);
  expect(after.removed).toBe(true);
  expect(after.cleanAfterSettle).toBe(false);
  expect(after.cleanAfterRenderAndScroll).toBe(false);
  expect(after.orphans).toBe(0);
  expect(harness.validatorErrors(page).length).toBeGreaterThan(0);
});

test('F1: the same insertion far from the mounted window is harmless', async ({ harness }) => {
  // The bug needs a mounted item whose index moves. This is the control: it
  // shows the set-up above fails because of the index shift and nothing else.
  const page = await harness.open();
  const before = await parkAboveV(page);
  const after = await page.evaluate(async (V) => {
    const H = window.H;
    const anchorTop = H.viewportTopOf(H.host(V));
    const next = H.items.slice();
    next.push(H.makeFileItem('inserted'));
    H.cv.setItems(next);
    H.items = next;
    await H.settle(400);
    return { orphans: H.orphanHosts(), clean: H.auditClean(), moved: H.viewportTopOf(H.host(V)) - anchorTop };
  }, before.V);
  expect(after).toEqual({ orphans: 0, clean: true, moved: 0 });
});

/**
 * Replace the whole list the way a re-render does (fresh parse, new fileDiff
 * objects, clear-then-set in one task) and restore the scroll position with
 * `restore`. Runs in the page. `where` picks the starting position.
 */
async function rerenderAndRestore(page, { mode, where, restore }) {
  return page.evaluate(async ({ mode, where, restore }) => {
    const H = window.H;
    const { roles } = H.workload;
    const HEADER = 40;
    const build = { limit: 30, exclude: [roles.hugeAdded, roles.hugeModified] };
    await H.appLike({ build, pool: true });
    if (where === 'near the top of an item') {
      H.cv.scrollTo({ type: 'item', id: H.items[14].id });
      await H.settle(250);
      H.root.scrollTop += 137;
    } else {
      // Deep inside the 3,000-line item, far from its top.
      const hunks = H.item(roles.large).fileDiff.hunks;
      H.cv.scrollTo({ type: 'line', id: roles.large, lineNumber: hunks[hunks.length - 1].additionStart + 2, side: 'additions', align: 'center' });
      await H.settle(250);
      H.root.scrollTop += 33;
    }
    await H.settle(250);

    // The anchors a re-render can record before it clears the list.
    const itemId = H.firstVisibleItem();
    const itemDelta = H.root.scrollTop - H.cv.getTopForItem(itemId);
    const hostTopBefore = H.viewportTopOf(H.host(itemId));
    const firstRow = [...H.host(itemId).shadowRoot.querySelectorAll('[data-content] > [data-line]')]
      .find((row) => H.viewportTopOf(row) >= HEADER);
    const line = {
      lineNumber: Number(firstRow.getAttribute('data-line')),
      side: firstRow.getAttribute('data-line-type') === 'change-deletion' ? 'deletions' : 'additions',
      top: H.viewportTopOf(firstRow),
    };

    // A fresh parse gives new fileDiff objects, as a real re-render does.
    H.parse({});
    H.buildItems(build);
    const next = H.items.slice();
    if (mode === 'one item removed above') next.splice(3, 1);
    if (mode === 'one item inserted above') next.splice(3, 0, H.makeFileItem('inserted', 60));

    H.clearEvents();
    H.cv.setItems([]);
    H.cv.setItems(next);
    H.items = next;
    H.cv.render(true);
    if (restore === 'line target') {
      H.cv.scrollTo({ type: 'line', id: itemId, lineNumber: line.lineNumber, side: line.side, align: 'start', offset: line.top - HEADER });
      H.cv.render(true);
    } else {
      H.root.scrollTop = H.cv.getTopForItem(itemId) + itemDelta;
    }
    const rowNow = () => H.findRow(itemId, line.lineNumber, line.side);
    const lineMovedSync = rowNow() ? H.viewportTopOf(rowNow()) - line.top : null;
    await H.settle(300);
    return {
      lineMovedSync,
      lineMoved: rowNow() ? H.viewportTopOf(rowNow()) - line.top : null,
      hostMoved: H.host(itemId) ? H.viewportTopOf(H.host(itemId)) - hostTopBefore : null,
      orphans: H.orphanHosts(),
      clean: H.auditClean(),
      unmounted: H.eventsOf('onPostRender').filter((e) => e.phase === 'unmount').length,
    };
  }, { mode, where, restore });
}

for (const where of ['near the top of an item', 'deep inside a long item']) {
  for (const mode of ['same list', 'one item removed above', 'one item inserted above']) {
    test(`F2: clear-then-set plus a line scroll target restores the first visible line exactly (${where}, ${mode})`, async ({ harness }) => {
      // Depends on it: PierreBridge.renderAll on every re-render (whitespace
      // toggle, refresh, scope and base change): record the first visible
      // line { id, lineNumber, side, top } before, then setItems([]),
      // setItems(next), render(true), and
      // scrollTo({ type: 'line', ..., align: 'start', offset: top - headerHeight }).
      // Public API only.
      const page = await harness.open();
      const result = await rerenderAndRestore(page, { mode, where, restore: 'line target' });

      // Exact in the same task, and still exact after everything settled.
      expect(result.lineMovedSync).toBe(0);
      expect(result.lineMoved).toBe(0);
      expect(result.orphans).toBe(0);
      expect(result.clean).toBe(true);
      // Every previously mounted item was released through the lifecycle hook.
      expect(result.unmounted).toBeGreaterThan(0);
    });
  }
}

test('F2 (limit): restoring with item top plus a pixel offset drifts when the anchor item is not fully measured yet', async ({ harness }) => {
  // The plan's first draft restored with
  //   root.scrollTop = getTopForItem(id) + delta
  // right after render(true). Measured heights are dropped by setItems([]),
  // and at that moment the anchor item can be mounted only partially (here it
  // sits at the edge of the window). A wrapped line above the viewport is then
  // still estimated at one row; when it is measured a frame later the vendor
  // keeps the visible line where it is, so the pixel offset no longer means
  // what it meant before: the view ends up one wrapped line away from where
  // it was. The line target above has no such dependency.
  const page = await harness.open();
  const result = await rerenderAndRestore(page, { mode: 'one item inserted above', where: 'near the top of an item', restore: 'item top plus delta' });
  expect(result.lineMoved).not.toBe(0);
  expect(result.hostMoved).not.toBe(0);
  // It is a wrong position, not a broken layout.
  expect(result.orphans).toBe(0);
  expect(result.clean).toBe(true);
});

test('setItems([]) empties the viewer and resets its scroll position', async ({ harness }) => {
  // Depends on it: renderAll must restore the scroll position itself; the
  // vendor does not keep it across a clear.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { limit: 20, exclude: [roles.hugeAdded, roles.hugeModified] } });
    H.root.scrollTop = 3000;
    await H.settle(200);
    const scrolled = H.root.scrollTop;
    H.cv.setItems([]);
    H.cv.render(true);
    return { scrolled, mounted: H.mounted().length, hosts: H.root.querySelectorAll('diffs-container').length, scrollTop: H.root.scrollTop, extent: H.cv.getScrollHeight() };
  });
  expect(result.scrolled).toBeGreaterThan(2000);
  expect(result.mounted).toBe(0);
  expect(result.hosts).toBe(0);
  expect(result.scrollTop).toBe(0);
  expect(result.extent).toBeLessThan(100);
});
