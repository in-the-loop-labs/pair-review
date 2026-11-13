// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: hover, the gutter utility, clicks after a scroll, line
 * selection. Real pointer input.
 *
 * Facts (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F12  after updateItem on the hovered item the hover and the gutter utility
 *        disappear until the pointer moves; a synthetic pointermove restores
 *        them; with pointerEventsOnScroll: true hover goes stale after a scroll
 *   F13  with the default pointerEventsOnScroll: false, item content does not
 *        receive pointer input right after a scroll
 */

import { test, expect } from '../harness/contract-test.js';

/** Hover state of an item, read from the vendor and from the DOM. */
function hoverState(page, id) {
  return page.evaluate((id) => {
    const H = window.H;
    const host = H.host(id);
    const slot = host.querySelector('[slot="gutter-utility-slot"]');
    const box = slot && slot.firstElementChild ? slot.firstElementChild.getBoundingClientRect() : null;
    const hoveredRow = host.shadowRoot.querySelector('[data-content] > [data-hovered]');
    const hovered = H.instance(id).getHoveredLine();
    return {
      vendorHoveredLine: hovered ? hovered.lineNumber : null,
      vendorHoveredSide: hovered ? hovered.side : null,
      domHoveredLine: hoveredRow ? Number(hoveredRow.getAttribute('data-line')) : null,
      utilityVisible: !!(box && box.height > 0),
    };
  }, id);
}

/** Bring up the added file and park the pointer on one of its rows. */
async function hoverARow(page, options) {
  const info = await page.evaluate(async (options) => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { only: [roles.added, roles.large] }, options });
    const row = H.findRow(roles.added, 12, 'additions');
    const box = row.getBoundingClientRect();
    return { id: roles.added, x: Math.round(box.left + 300), y: Math.round(box.top + box.height / 2) };
  }, options);
  await page.mouse.move(info.x, info.y - 4);
  await page.mouse.move(info.x, info.y);
  await page.evaluate(() => window.H.raf(3));
  return info;
}

test('F12: updateItem on the hovered item drops the hover; a synthetic pointermove restores it', async ({ harness }) => {
  // Depends on it: the bridge records the last pointer position over the root
  // and, after onPostRender('update') for the item under the pointer,
  // dispatches a pointermove on shadowRoot.elementFromPoint(x, y)
  // (main's _restoreHoverAfterRender).
  const page = await harness.open();
  const { id, x, y } = await hoverARow(page, { pointerEventsOnScroll: true });

  const before = await hoverState(page, id);
  expect(before).toEqual({ vendorHoveredLine: 12, vendorHoveredSide: 'additions', domHoveredLine: 12, utilityVisible: true });

  await page.evaluate(async (id) => {
    const H = window.H;
    H.update(id, { annotations: [{ side: 'additions', lineNumber: 100, metadata: { key: 'far-below' } }] });
    H.cv.render(true);
    await H.raf(3);
  }, id);
  const afterUpdate = await hoverState(page, id);
  // The rows were replaced: the attribute and the utility are gone and do not
  // come back by themselves, although the vendor still reports the line.
  expect(afterUpdate.domHoveredLine).toBeNull();
  expect(afterUpdate.utilityVisible).toBe(false);

  const dispatchedOn = await page.evaluate(async ({ id, x, y }) => {
    const H = window.H;
    const el = H.host(id).shadowRoot.elementFromPoint(x, y);
    if (!el) return null;
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, composed: true, clientX: x, clientY: y, pointerType: 'mouse' }));
    await H.raf(2);
    return el.tagName;
  }, { id, x, y });
  expect(dispatchedOn).not.toBeNull();
  const afterSynthetic = await hoverState(page, id);
  expect(afterSynthetic).toEqual({ vendorHoveredLine: 12, vendorHoveredSide: 'additions', domHoveredLine: 12, utilityVisible: true });
});

test('F12: with pointerEventsOnScroll: true the hover goes stale after a scroll with a parked pointer', async ({ harness }) => {
  // Depends on it: the bridge hides its gutter element on scroll and shows it
  // again on the next real pointermove (what main does today).
  const page = await harness.open();
  const { id, x, y } = await hoverARow(page, { pointerEventsOnScroll: true });
  await page.evaluate(() => { window.__scrolled = new Promise((ok) => window.H.root.addEventListener('scroll', () => ok(true), { once: true })); });
  await page.mouse.wheel(0, 100);
  await page.evaluate(() => window.__scrolled);
  await page.evaluate(() => window.H.raf(3));
  const stale = await hoverState(page, id);
  const lineUnderPointer = await page.evaluate(({ id, x, y }) => {
    const el = window.H.host(id).shadowRoot.elementFromPoint(x, y);
    const row = el && el.closest('[data-line]');
    return row ? Number(row.getAttribute('data-line')) : null;
  }, { id, x, y });
  // 100 px is five rows: the pointer is over line 17, the hover still says 12.
  expect(lineUnderPointer).toBe(17);
  expect(stale.vendorHoveredLine).toBe(12);
  expect(stale.domHoveredLine).toBe(12);

  await page.mouse.move(x + 1, y);
  await page.evaluate(() => window.H.raf(3));
  expect((await hoverState(page, id)).domHoveredLine).toBe(17);
});

for (const pointerEventsOnScroll of [false, true]) {
  test(`F13: pointerEventsOnScroll: ${pointerEventsOnScroll} ${pointerEventsOnScroll ? 'keeps item content interactive' : 'turns pointer input off on item content'} right after a scroll`, async ({ harness }) => {
    // Depends on it: the bridge passes pointerEventsOnScroll: true. With the
    // default, a click on a card button within about 120 ms of any scroll is
    // lost, including buttons inside annotations.
    const page = await harness.open();
    const info = await page.evaluate(async (pointerEventsOnScroll) => {
      const H = window.H;
      const { roles } = H.workload;
      const id = roles.added;
      await H.appLike({ build: { only: [id, roles.large] }, options: { pointerEventsOnScroll } });
      H.update(id, { annotations: [{ side: 'additions', lineNumber: 10, metadata: { key: 'btn', kind: 'button', text: 'Adopt' } }] });
      H.cv.render(true);
      await H.settle();
      // Sample hit-testing inside the scroll listener, the earliest moment a
      // user's click could arrive after a scroll.
      window.__probe = new Promise((ok) => {
        H.root.addEventListener('scroll', () => {
          requestAnimationFrame(() => {
            const button = H.annEls.get('btn').querySelector('button');
            const box = button.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            const row = H.findRow(id, 14, 'additions');
            const rowBox = row.getBoundingClientRect();
            const rowHit = H.host(id).shadowRoot.elementFromPoint(rowBox.left + 300, rowBox.top + 10);
            ok({
              buttonIsHit: hit === button,
              rowIsHit: !!(rowHit && rowHit.closest('[data-line]') === row),
              x: Math.round(box.left + box.width / 2),
              y: Math.round(box.top + box.height / 2),
            });
          });
        }, { once: true });
      });
      return { id };
    }, pointerEventsOnScroll);

    await page.mouse.move(700, 300);
    await page.mouse.wheel(0, 40);
    const probe = await page.evaluate(() => window.__probe);
    expect(probe.buttonIsHit).toBe(pointerEventsOnScroll);
    expect(probe.rowIsHit).toBe(pointerEventsOnScroll);

    if (pointerEventsOnScroll) {
      // A real click issued right after a real scroll reaches the button.
      await page.evaluate(() => { window.__scrolled = new Promise((ok) => window.H.root.addEventListener('scroll', () => ok(true), { once: true })); });
      await page.mouse.wheel(0, 20);
      await page.evaluate(() => window.__scrolled);
      const box = await page.evaluate(() => {
        const b = window.H.annEls.get('btn').querySelector('button').getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await expect.poll(() => page.evaluate(() => window.H.eventsOf('annButtonClick').length)).toBe(1);
    } else {
      // Pointer input comes back by itself once scrolling has stopped.
      await expect.poll(() => page.evaluate(() => {
        const H = window.H;
        const button = H.annEls.get('btn').querySelector('button');
        const box = button.getBoundingClientRect();
        return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button;
      })).toBe(true);
    }
    expect(info.id).toBeTruthy();
  });
}

test('the gutter utility sits on the hovered row and its button sees the hovered line', async ({ harness }) => {
  // Depends on it: PierreBridge renderGutterUtility returns one cached
  // .pierre-gutter-buttons element per item id and resolves the click target
  // from getHoveredLine().
  const page = await harness.open();
  const { id, x, y } = await hoverARow(page, { pointerEventsOnScroll: true });
  const geometry = await page.evaluate((id) => {
    const H = window.H;
    const host = H.host(id);
    const slot = host.querySelector('[slot="gutter-utility-slot"]');
    const utility = slot.firstElementChild;
    const row = host.shadowRoot.querySelector('[data-content] > [data-hovered]');
    const u = utility.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const button = utility.querySelector('.gut-comment').getBoundingClientRect();
    const point = { x: button.left + button.width / 2, y: button.top + button.height / 2 };
    return {
      sameElementAsCache: utility === H.gutterEls.get(id),
      // The vendor's slot wrapper spans the hovered row's gutter cell.
      slotTopOffset: Math.round(slot.getBoundingClientRect().top - r.top),
      slotHeight: Math.round(slot.getBoundingClientRect().height),
      utilityCentredOnRow: Math.abs((u.top + u.height / 2) - (r.top + r.height / 2)) <= 1,
      hit: document.elementFromPoint(point.x, point.y) === utility.querySelector('.gut-comment'),
      ...point,
    };
  }, id);
  expect(geometry.sameElementAsCache).toBe(true);
  expect(geometry.slotTopOffset).toBe(0);
  expect(geometry.slotHeight).toBe(20);
  expect(geometry.utilityCentredOnRow).toBe(true);
  expect(geometry.hit).toBe(true);
  expect(Math.abs(geometry.y - y)).toBeLessThan(20);

  await page.mouse.click(geometry.x, geometry.y);
  const clicks = await page.evaluate(() => window.H.eventsOf('gutterButtonClick'));
  expect(clicks.length).toBe(1);
  expect(clicks[0].hovered).toEqual({ lineNumber: 12, side: 'additions' });
});

test('line selection is viewer-wide and survives an annotation update of the item', async ({ harness }) => {
  // Depends on it: PierreBridge.getLineSelection / clearLineSelection wrap
  // codeView.getSelectedLines / setSelectedLines / clearSelectedLines
  // (decision D8: selecting in file B clears file A).
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const A = roles.noNewline;
    const B = roles.small;
    await H.appLike({ build: { only: [A, B] } });
    const hunkA = H.item(A).fileDiff.hunks[0];
    const hunkB = H.item(B).fileDiff.hunks[0];
    const selectedRows = (id) => [...H.host(id).shadowRoot.querySelectorAll('[data-content] > [data-line][data-selected-line]')]
      .map((row) => row.getAttribute('data-selected-line'));
    const out = {};
    out.initial = H.cv.getSelectedLines() ?? null;
    H.cv.setSelectedLines({ id: A, range: { start: hunkA.additionStart, end: hunkA.additionStart + 2, side: 'additions' } });
    H.cv.render(true);
    out.afterA = { selection: H.cv.getSelectedLines(), rowsA: selectedRows(A) };
    H.update(A, { annotations: [{ side: 'additions', lineNumber: hunkA.additionStart, metadata: { key: 'during-selection' } }] });
    H.cv.render(true);
    out.afterUpdate = { selection: H.cv.getSelectedLines(), rowsA: selectedRows(A) };
    H.cv.setSelectedLines({ id: B, range: { start: hunkB.additionStart, end: hunkB.additionStart, side: 'additions' } });
    H.cv.render(true);
    out.afterB = { selectionId: H.cv.getSelectedLines().id, rowsA: selectedRows(A), rowsB: selectedRows(B) };
    H.cv.clearSelectedLines();
    H.cv.render(true);
    out.afterClear = { selection: H.cv.getSelectedLines() ?? null, rowsB: selectedRows(B) };
    out.ids = { A, B, startA: hunkA.additionStart };
    return out;
  });
  const { A, B, startA } = result.ids;
  expect(result.initial).toBeNull();
  expect(result.afterA.selection).toEqual({ id: A, range: { start: startA, end: startA + 2, side: 'additions' } });
  expect(result.afterA.rowsA).toEqual(['first', '', 'last']);
  expect(result.afterUpdate.selection).toEqual(result.afterA.selection);
  expect(result.afterUpdate.rowsA).toEqual(['first', '', 'last']);
  expect(result.afterB.selectionId).toBe(B);
  expect(result.afterB.rowsA).toEqual([]);
  expect(result.afterB.rowsB).toEqual(['single']);
  expect(result.afterClear).toEqual({ selection: null, rowsB: [] });
});
