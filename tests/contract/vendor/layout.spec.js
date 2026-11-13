// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: height accounting.
 *
 * Facts (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F9   one static itemMetrics.diffHeaderHeight is enough; growth inside the
 *        header slot is never absorbed; growth inside annotations is
 *   F10  a lineNumber-0 annotation is measured; an always-present empty one
 *        costs 0 px, also on row-less items with one CSS rule
 *
 * "Validator 0" is asserted by the fixture: any console.error fails the test.
 */

import { test, expect, VALIDATOR_PATTERN } from '../harness/contract-test.js';
import { ROWLESS_FIX, ROWLESS_FIX_FIRST_DRAFT } from '../harness/constants.js';

for (const diffStyle of ['unified', 'split']) {
  test(`F9: a static diffHeaderHeight keeps every item's layout exact across the whole list (${diffStyle})`, async ({ harness }) => {
    // Depends on it: the bridge passes itemMetrics: { diffHeaderHeight } once,
    // read from the fixed header token. No setItemMetrics loop, no render(false).
    const page = await harness.open();
    const result = await page.evaluate(async (diffStyle) => {
      const H = window.H;
      const { roles } = H.workload;
      await H.appLike({ build: { exclude: [roles.hugeAdded, roles.hugeModified] }, options: { diffStyle } });
      const extentAtLoad = H.root.scrollHeight;
      let unclean = 0;
      let steps = 0;
      const seen = new Set(H.mounted());
      while (H.root.scrollTop < H.root.scrollHeight - H.root.clientHeight - 1 && steps < 400) {
        H.root.scrollTop += 700;
        await H.settle(60);
        if (!H.auditClean()) unclean++;
        for (const id of H.mounted()) seen.add(id);
        steps++;
      }
      return { items: H.items.length, seen: seen.size, steps, unclean, orphans: H.orphanHosts(), extentAtLoad, extentAfterWalk: H.root.scrollHeight };
    }, diffStyle);

    // Every item was mounted at some point of the walk.
    expect(result.seen).toBe(result.items);
    expect(result.unclean).toBe(0);
    expect(result.orphans).toBe(0);
    // Unmounted items are estimated; wrapped lines make the real extent larger.
    expect(result.extentAfterWalk).toBeGreaterThanOrEqual(result.extentAtLoad);
  });
}

test('F9 (vendor constraint): growth inside the custom header is never absorbed', async ({ harness }) => {
  // Depends on it: nothing that can grow goes in the header. The header slot
  // root has a fixed height, and the file-comment zone is a lineNumber-0
  // annotation (the previous attempt put the zone in the sticky header).
  // This test asserts behaviour the bridge must AVOID.
  const page = await harness.open();
  harness.allowErrors(page, VALIDATOR_PATTERN);
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const A = roles.noNewline;
    await H.appLike({ build: { only: [A, roles.small] } });
    const heightBefore = H.itemHeight(A);
    const extentBefore = H.root.scrollHeight;
    const zone = document.createElement('div');
    zone.style.height = '120px';
    H.headerEls.get(A).appendChild(zone);
    await H.raf(3);
    H.cv.render(true);
    await H.settle();
    const header = H.host(A).shadowRoot.querySelector('[data-diffs-header]');
    return {
      headerDomHeight: Math.round(header.getBoundingClientRect().height),
      itemGrew: H.itemHeight(A) - heightBefore,
      extentGrew: H.root.scrollHeight - extentBefore,
      clean: H.auditClean(),
    };
  });
  expect(result.headerDomHeight).toBe(160);
  expect(result.itemGrew).toBe(0);
  expect(result.clean).toBe(false);
  expect(harness.validatorErrors(page).length).toBeGreaterThan(0);
});

test('F9: the extent follows growth inside an annotation with no API call, also at maximum scroll', async ({ harness }) => {
  // Depends on it: no syncScrollExtent, no ResizeObserver on cards or zones.
  // A comment form that grows while the user types must stay reachable.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { limit: 20, exclude: [roles.hugeAdded, roles.hugeModified] } });
    const out = {};

    // (1) mid-list item
    const mid = H.items[8].id;
    H.cv.scrollTo({ type: 'item', id: mid });
    await H.settle();
    const midDiff = H.item(mid).fileDiff;
    H.update(mid, { annotations: [{ side: 'additions', lineNumber: midDiff.hunks[0].additionStart + 1, metadata: { key: 'mid', kind: 'form' } }] });
    H.cv.render(true);
    await H.settle();
    const textarea = H.annEls.get('mid').querySelector('textarea');
    const extent0 = H.root.scrollHeight;
    const top0 = H.root.scrollTop;
    const base = textarea.getBoundingClientRect().height;
    textarea.style.height = `${base + 300}px`;
    out.grow = await H.until(() => H.root.scrollHeight - extent0 === 300);
    out.scrollTopMovedOnGrow = H.root.scrollTop - top0;
    textarea.style.height = `${base}px`;
    out.shrink = await H.until(() => H.root.scrollHeight === extent0);

    // (2) last line of the last item, scrolled to the maximum
    const last = H.items[H.items.length - 1].id;
    const lastDiff = H.item(last).fileDiff;
    const lastHunk = lastDiff.hunks[lastDiff.hunks.length - 1];
    const lastLine = lastHunk.additionStart + lastHunk.additionCount - 1;
    H.update(last, { annotations: [{ side: 'additions', lineNumber: lastLine, metadata: { key: 'end', kind: 'form' } }] });
    H.cv.scrollTo({ type: 'item', id: last });
    await H.settle();
    H.root.scrollTop = H.root.scrollHeight;
    await H.settle();
    const endTextarea = H.annEls.get('end').querySelector('textarea');
    out.endConnected = endTextarea.isConnected;
    const extent1 = H.root.scrollHeight;
    endTextarea.style.height = `${endTextarea.getBoundingClientRect().height + 400}px`;
    out.growAtMax = await H.until(() => H.root.scrollHeight - extent1 === 400);
    H.root.scrollTop = H.root.scrollHeight;
    await H.settle();
    const rootBottom = H.root.getBoundingClientRect().bottom;
    out.textareaBottomAboveViewportBottom = rootBottom - endTextarea.getBoundingClientRect().bottom;
    out.atMax = H.root.scrollTop === H.root.scrollHeight - H.root.clientHeight;
    out.clean = H.auditClean();
    return out;
  });

  expect(result.grow.ok).toBe(true);
  expect(result.scrollTopMovedOnGrow).toBe(0);
  expect(result.shrink.ok).toBe(true);
  expect(result.endConnected).toBe(true);
  expect(result.growAtMax.ok).toBe(true);
  // Nothing is cut off: the grown textarea ends above the viewport bottom.
  expect(result.textareaBottomAboveViewportBottom).toBeGreaterThan(0);
  expect(result.atMax).toBe(true);
  expect(result.clean).toBe(true);
});

test('F9: the sticky header is the vendor shadow header, pinned at the top while scrolled inside an item', async ({ harness }) => {
  // Depends on it: stickyHeaders: true; .d2h-file-header inside the slot is
  // position: static; no sticky offset is added to scroll targets.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.large;
    await H.appLike({ build: { only: [roles.noNewline, T, roles.small] } });
    const hunks = H.item(T).fileDiff.hunks;
    H.cv.scrollTo({ type: 'line', id: T, lineNumber: hunks[hunks.length - 1].additionStart + 1, side: 'additions', align: 'center' });
    await H.settle();
    const host = H.host(T);
    const header = host.shadowRoot.querySelector('[data-diffs-header]');
    const style = getComputedStyle(header);
    return {
      headerAttr: header.getAttribute('data-diffs-header'),
      position: style.position,
      headerViewportTop: H.viewportTopOf(header),
      headerHeight: header.getBoundingClientRect().height,
      hostAboveViewport: H.viewportTopOf(host) < 0,
      appHeaderInSlot: host.querySelector('[slot="header-custom"] [data-ph-id]') === H.headerEls.get(T),
    };
  });
  expect(result).toEqual({
    headerAttr: 'custom',
    position: 'sticky',
    headerViewportTop: 0,
    headerHeight: 40,
    hostAboveViewport: true,
    appHeaderInSlot: true,
  });
});

for (const diffStyle of ['unified', 'split']) {
test(`F10: an always-present empty lineNumber-0 annotation costs 0 px, grows with its content, and returns to 0 (${diffStyle})`, async ({ harness }) => {
  // Depends on it: the file-comment zone is a `file-comments` annotation at
  // lineNumber 0, first in every item's array from renderAll on.
  const page = await harness.open();
  const result = await page.evaluate(async ({ fix, diffStyle }) => {
    const H = window.H;
    const { roles } = H.workload;
    const ids = [roles.binary, roles.renamePure, roles.modeOnly, roles.emptyAdded, roles.noNewline, roles.deleted];
    await H.appLike({ build: { only: ids }, options: { unsafeCSS: fix, diffStyle } });
    const mounted = H.mounted();
    const before = Object.fromEntries(ids.map((id) => [id, H.itemHeight(id)]));
    const sideOf = (id) => (H.item(id).fileDiff.type === 'deleted' ? 'deletions' : 'additions');
    for (const id of ids) {
      H.update(id, { annotations: [{ side: sideOf(id), lineNumber: 0, metadata: { key: `zone:${id}`, kind: 'zone' } }] });
    }
    H.cv.render(true);
    await H.settle();
    const out = { allMounted: ids.every((id) => mounted.includes(id)) };
    out.emptyDelta = Object.fromEntries(ids.map((id) => [id, H.itemHeight(id) - before[id]]));
    out.emptyConnected = Object.fromEntries(ids.map((id) => [id, H.annEls.get(`zone:${id}`).isConnected]));
    out.cleanEmpty = H.auditClean();

    // Fill every zone with an 80 px card, then empty it again.
    const cards = ids.map((id) => {
      const card = document.createElement('div');
      card.style.height = '80px';
      card.textContent = 'file comment';
      H.annEls.get(`zone:${id}`).appendChild(card);
      return card;
    });
    await H.until(() => ids.every((id) => H.itemHeight(id) - before[id] === 80));
    await H.settle();
    out.filledDelta = Object.fromEntries(ids.map((id) => [id, H.itemHeight(id) - before[id]]));
    out.cleanFilled = H.auditClean();
    // Where the zone sits: directly below the header, before the first row.
    const host = H.host(roles.noNewline);
    const wrapper = host.shadowRoot.querySelector('[data-line-annotation]');
    const firstRow = host.shadowRoot.querySelector('[data-content] > [data-line]');
    out.zoneIndexAttr = wrapper.getAttribute('data-line-annotation');
    out.zoneSlot = H.annEls.get(`zone:${roles.noNewline}`).parentElement.getAttribute('slot');
    out.zoneAboveFirstRow = wrapper.getBoundingClientRect().bottom <= firstRow.getBoundingClientRect().top;
    out.deletedZoneSlot = H.annEls.get(`zone:${roles.deleted}`).parentElement.getAttribute('slot');

    for (const card of cards) card.remove();
    await H.until(() => ids.every((id) => H.itemHeight(id) === before[id]));
    await H.settle();
    out.emptiedDelta = Object.fromEntries(ids.map((id) => [id, H.itemHeight(id) - before[id]]));
    out.cleanEmptied = H.auditClean();
    return out;
  }, { fix: ROWLESS_FIX, diffStyle });

  const zeros = (delta) => Object.values(delta).every((d) => d === 0);
  expect(result.allMounted).toBe(true);
  expect(zeros(result.emptyDelta)).toBe(true);
  expect(Object.values(result.emptyConnected).every(Boolean)).toBe(true);
  expect(result.cleanEmpty).toBe(true);
  expect(Object.values(result.filledDelta).every((d) => d === 80)).toBe(true);
  expect(result.cleanFilled).toBe(true);
  expect(result.zoneIndexAttr).toBe('-1,-1');
  expect(result.zoneSlot).toBe('annotation-additions-0');
  expect(result.zoneAboveFirstRow).toBe(true);
  expect(result.deletedZoneSlot).toBe('annotation-deletions-0');
  expect(zeros(result.emptiedDelta)).toBe(true);
  expect(result.cleanEmptied).toBe(true);
});
}

for (const variant of [
  { diffStyle: 'unified', css: '', label: 'unified, no rule' },
  { diffStyle: 'split', css: '', label: 'split, no rule' },
  { diffStyle: 'split', css: ROWLESS_FIX_FIRST_DRAFT, label: 'split, with the first-draft [data-code] rule' },
]) {
test(`F10 (vendor quirk): a filled zone on a row-less item is 8 px taller than computed (${variant.label})`, async ({ harness }) => {
  // Depends on it: the bridge's unsafeCSS always carries ROWLESS_FIX, BOTH
  // rules. This test asserts the quirk the rules exist for, including that a
  // [data-code] rule alone does not cover split style, where the padding is on
  // the <pre>. If a variant fails after a bump, a rule may no longer be needed.
  const page = await harness.open();
  harness.allowErrors(page, VALIDATOR_PATTERN);
  const result = await page.evaluate(async ({ diffStyle, css }) => {
    const H = window.H;
    const { roles } = H.workload;
    const id = roles.binary;
    await H.appLike({ build: { only: [id, roles.noNewline] }, options: { diffStyle, ...(css ? { unsafeCSS: css } : {}) } });
    H.update(id, { annotations: [{ side: 'additions', lineNumber: 0, metadata: { key: 'zone', kind: 'zone' } }] });
    H.cv.render(true);
    const card = document.createElement('div');
    card.style.height = '80px';
    H.annEls.get('zone').appendChild(card);
    await H.raf(3);
    await H.settle();
    return H.heightAudit().find((a) => a.id === id);
  }, variant);
  expect(result.dH).toBe(8);
});
}

/**
 * Give every item an (empty) file-level annotation, walk the whole list in
 * 37 px steps so items are mounted at every possible window edge, and report
 * whether the layout stayed exact.
 */
async function walkWithZones(page, { css, diffStyle }) {
  return page.evaluate(async ({ css, diffStyle }) => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({
      build: { only: [roles.binary, roles.modeOnly, ...H.workload.modifiedPaths.slice(0, 12)] },
      options: { unsafeCSS: css, diffStyle },
    });
    for (const item of H.items) {
      H.update(item.id, { annotations: [{ side: 'additions', lineNumber: 0, metadata: { key: `zone:${item.id}`, kind: 'zone' } }] });
    }
    H.cv.render(true);
    await H.settle();
    let headerOnlyMounts = 0;
    let steps = 0;
    while (H.root.scrollTop < H.root.scrollHeight - H.root.clientHeight - 1 && steps < 600) {
      H.root.scrollTop += 37;
      await H.raf(2);
      for (const rendered of H.cv.getRenderedItems()) {
        const rows = rendered.element.shadowRoot.querySelectorAll('[data-content] > [data-line]').length;
        if (rows === 0 && rendered.item.fileDiff.hunks.length > 0) headerOnlyMounts++;
      }
      steps++;
    }
    await H.settle();
    return { headerOnlyMounts, clean: H.auditClean(), orphans: H.orphanHosts() };
  }, { css, diffStyle });
}

for (const diffStyle of ['unified', 'split']) {
  test(`F10: with ROWLESS_FIX, items mounted with no rows in their window keep an exact layout (${diffStyle})`, async ({ harness }) => {
    // Depends on it: the same unsafeCSS serves row-less items AND ordinary
    // items that happen to be mounted header-only at a window edge.
    const page = await harness.open();
    const result = await walkWithZones(page, { css: ROWLESS_FIX, diffStyle });
    // The walk did meet the case it is about.
    expect(result.headerOnlyMounts).toBeGreaterThan(0);
    expect(result.clean).toBe(true);
    expect(result.orphans).toBe(0);
    // Teardown asserts zero validator errors over the whole walk.
  });
}

test('F10 (why the rule is scoped): the first-draft rule breaks header-only mounts of ordinary items', async ({ harness }) => {
  // The first-draft rule removes the bottom padding from every code area with
  // no rendered line, including an ordinary item whose window holds no rows
  // yet. The vendor counts 8 px there, so its validator reports a mismatch.
  const page = await harness.open();
  harness.allowErrors(page, VALIDATOR_PATTERN);
  const result = await walkWithZones(page, { css: ROWLESS_FIX_FIRST_DRAFT, diffStyle: 'unified' });
  expect(result.headerOnlyMounts).toBeGreaterThan(0);
  expect(harness.validatorErrors(page).length).toBeGreaterThan(0);
});

test('F10: a file-level annotation on the wrong side of an added or deleted file renders nothing', async ({ harness }) => {
  // Depends on it: the zone's side comes from the file status (deletions for
  // a deleted file, additions otherwise), with a patch-header fallback.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { only: [roles.added, roles.deleted] } });
    H.cv.scrollTo({ type: 'item', id: roles.deleted });
    await H.settle();
    const probe = async (id, side, key) => {
      H.update(id, { annotations: [{ side, lineNumber: 0, metadata: { key, height: 50 } }] });
      H.cv.render(true);
      await H.settle();
      const el = H.annEls.get(key);
      return { built: !!el, height: el && el.isConnected ? el.getBoundingClientRect().height : 0 };
    };
    return {
      deletedWrong: await probe(roles.deleted, 'additions', 'del-wrong'),
      deletedRight: await probe(roles.deleted, 'deletions', 'del-right'),
    };
  });
  expect(result.deletedWrong.height).toBe(0);
  expect(result.deletedRight).toEqual({ built: true, height: 50 });

  const added = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    H.cv.scrollTo({ type: 'item', id: roles.added });
    await H.settle();
    const probe = async (side, key) => {
      H.update(roles.added, { annotations: [{ side, lineNumber: 0, metadata: { key, height: 50 } }] });
      H.cv.render(true);
      await H.settle();
      const el = H.annEls.get(key);
      return el && el.isConnected ? el.getBoundingClientRect().height : 0;
    };
    return { wrong: await probe('deletions', 'add-wrong'), right: await probe('additions', 'add-right') };
  });
  expect(added).toEqual({ wrong: 0, right: 50 });
});

test('a collapsed item is exactly its header; its annotations leave the DOM and return on expand', async ({ harness }) => {
  // Depends on it: PRManager.setFileCollapsed -> PierreBridge.setCollapsed
  // publishes item.collapsed. Main hides the file-comment zone of a collapsed
  // file too, so the zone going with the code is parity.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const A = roles.noNewline;
    await H.appLike({ build: { only: [A, roles.small] } });
    H.update(A, {
      annotations: [
        { side: 'additions', lineNumber: 0, metadata: { key: 'zone', height: 30 } },
        { side: 'additions', lineNumber: H.item(A).fileDiff.hunks[0].additionStart + 1, metadata: { key: 'card' } },
      ],
    });
    H.cv.render(true);
    await H.settle();
    const expandedHeight = H.itemHeight(A);
    H.clearEvents();
    H.update(A, { collapsed: true });
    H.cv.render(true);
    const collapsed = {
      height: H.itemHeight(A),
      hasPre: H.shape(A).hasPre,
      zoneConnected: H.annEls.get('zone').isConnected,
      cardConnected: H.annEls.get('card').isConnected,
      phases: H.eventsOf('onPostRender').filter((e) => e.id === A).map((e) => e.phase),
    };
    H.update(A, { collapsed: false });
    H.cv.render(true);
    await H.settle();
    return {
      collapsed,
      expanded: { height: H.itemHeight(A) === expandedHeight, zoneConnected: H.annEls.get('zone').isConnected, cardConnected: H.annEls.get('card').isConnected },
      clean: H.auditClean(),
    };
  });
  expect(result.collapsed).toEqual({ height: 40, hasPre: false, zoneConnected: false, cardConnected: false, phases: ['update'] });
  expect(result.expanded).toEqual({ height: true, zoneConnected: true, cardConnected: true });
  expect(result.clean).toBe(true);
});
