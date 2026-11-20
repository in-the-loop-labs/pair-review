// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: height accounting.
 *
 * Facts (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F9   one static itemMetrics.diffHeaderHeight is enough; growth inside the
 *        header slot is never absorbed; growth inside annotations is
 *   F10  a lineNumber-0 annotation is measured; an always-present empty one
 *        costs 0 px, also on row-less items with one CSS rule
 *   F27  the development validator reports when a forced render that does
 *        not draw an item runs after an annotation of that item changed its
 *        height and before the viewer has followed the change; the viewer
 *        follows it when the browser reports the resize, which is before
 *        the next frame is painted
 *
 * "Validator 0" is asserted by the fixture: any console.error fails the test.
 */

import { test, expect, VALIDATOR_PATTERN } from '../harness/contract-test.js';
import { ROWLESS_FIX, ROWLESS_SCRIPTS, MARK_ROWLESS, ROWLESS_FIX_FIRST_DRAFT } from '../harness/constants.js';

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

for (const change of ['grows', 'shrinks']) {
  test(`F27 (vendor constraint): a file-level annotation that ${change}, then a forced render of another item before the next frame: one validator report, and an exact layout before the next frame is painted`, async ({ harness }) => {
    // Depends on it: a publish on file B right after the comment zone of
    // file A changed its height (a form opened or closed, a comment saved)
    // makes the development validator report, although nothing wrong is ever
    // painted. The E2E fixture of a development-bundle run tells this report
    // from a real mismatch by the state one frame later (tests/e2e/fixtures.js).
    const page = await harness.open();
    harness.allowErrors(page, VALIDATOR_PATTERN);
    const result = await page.evaluate(async (change) => {
      const H = window.H;
      const { roles } = H.workload;
      await H.appLike({ build: { only: [roles.small, roles.medium] } });
      const A = roles.small;
      const B = roles.medium;
      H.update(A, { annotations: [{ side: 'additions', lineNumber: 0, metadata: { key: 'zone', kind: 'zone' } }] });
      H.cv.render(true);
      await H.settle();
      const zone = H.annEls.get('zone');
      const form = document.createElement('div');
      form.style.cssText = 'height: 120px; margin: 0;';
      if (change === 'shrinks') {
        zone.appendChild(form);
        await H.settle();
      }
      const out = { cleanBefore: H.auditClean() };
      const heightBefore = H.itemHeight(A);

      // One task: the zone of A changes its height, and B is published and flushed.
      if (change === 'shrinks') form.remove();
      else zone.appendChild(form);
      H.update(B, { annotations: [{ side: 'additions', lineNumber: H.item(B).fileDiff.hunks[0].additionStart, metadata: { key: 'b', kind: 'card' } }] });
      H.cv.render(true);
      out.sameTask = H.heightAudit().map((a) => [a.dH, a.dTop]);
      // Resize observations are delivered in the next frame, before it is
      // painted, in the order the observers were created: this one hears of
      // the change right after the viewer's own.
      out.cleanWhenResizeObserved = await new Promise((resolve) => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve(H.auditClean());
        });
        observer.observe(zone);
      });
      await H.settle();
      out.cleanAtRest = H.auditClean();
      out.heightDelta = H.itemHeight(A) - heightBefore;
      return out;
    }, change);
    const reports = harness.validatorErrors(page);
    const by = change === 'shrinks' ? -120 : 120;

    expect(result.cleanBefore).toBe(true);
    // A's element is `by` px off the viewer's layout, and B is drawn that far from where the viewer has it.
    expect(result.sameTask).toEqual([[by, 0], [0, by]]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('sticky container height does not match computed layout');
    // Followed without an API call, and before a frame could show it.
    expect(result.cleanWhenResizeObserved).toBe(true);
    expect(result.cleanAtRest).toBe(true);
    expect(result.heightDelta).toBe(by);
  });
}

test('F27 (vendor constraint): the pane gets narrower frame after frame; in a frame in which lines wrap again a forced render reports, and the layout is exact before every frame is painted', async ({ harness }) => {
  // Depends on it: a panel beside the diff that opens with a width
  // transition (the review panel, 0.2 s) makes the pane narrower in every
  // frame of it. The lines of every drawn file wrap again, the viewer hears
  // of it from its resize observer in that frame, and a render forced before
  // that (a publish) makes the development validator report a height that is
  // never painted. Over a long file that happens in several frames in a
  // row, so two frames after the first report the viewer is behind by
  // another amount; the E2E fixture of a development-bundle run therefore
  // counts its two frames from when the pane's box last changed
  // (tests/e2e/diff-dom-codeview.js; fixture-isolation.spec.js runs it with
  // the application's panel over a 4,000-line file).
  const page = await harness.open();
  harness.allowErrors(page, VALIDATOR_PATTERN);
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { limit: 12, exclude: [roles.hugeAdded, roles.hugeModified] } });
    await H.settle();
    const out = { cleanBefore: H.auditClean(), frames: [] };
    const from = H.root.getBoundingClientRect().width;
    const drawn = H.mounted();
    const heightOfDrawn = () => drawn.reduce((sum, id) => sum + H.itemHeight(id), 0);
    const heightBefore = heightOfDrawn();
    for (let step = 1; step <= 6; step++) {
      await H.raf(1);
      // One frame: the pane is narrower, and a render is forced before the browser reports the resize.
      H.root.style.width = `${Math.round(from * (1 - step * 0.1))}px`;
      H.cv.render(true);
      const cleanAfterForcedRender = H.auditClean();
      const cleanWhenResizeObserved = await new Promise((resolve) => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve(H.auditClean());
        });
        observer.observe(H.root);
      });
      out.frames.push({ cleanAfterForcedRender, cleanWhenResizeObserved });
    }
    await H.settle();
    out.cleanAtRest = H.auditClean();
    out.grewBy = heightOfDrawn() - heightBefore;
    out.widths = [from, H.root.getBoundingClientRect().width];
    return out;
  });
  const reports = harness.validatorErrors(page);

  expect(result.cleanBefore).toBe(true);
  // Lines did wrap again (the drawn files are taller): in the frame in which
  // they did, the forced render left the viewer's layout behind the DOM ...
  expect(result.grewBy).toBeGreaterThan(0);
  const behind = result.frames.filter((frame) => !frame.cleanAfterForcedRender).length;
  expect(behind).toBeGreaterThanOrEqual(1);
  // ... and that was reported, once per such frame ...
  expect(reports).toHaveLength(behind);
  for (const report of reports) expect(report).toContain('sticky container height does not match computed layout');
  // ... and in every frame the viewer had followed by the time a later observer was called, before the paint.
  expect(result.frames.map((frame) => frame.cleanWhenResizeObserved)).toEqual([true, true, true, true, true, true]);
  expect(result.cleanAtRest).toBe(true);
});

test('F27: the same change followed by a forced render of the SAME item is measured in that render, and nothing is reported', async ({ harness }) => {
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { only: [roles.small, roles.medium] } });
    const A = roles.small;
    const zoneAnnotation = { side: 'additions', lineNumber: 0, metadata: { key: 'zone', kind: 'zone' } };
    H.update(A, { annotations: [zoneAnnotation] });
    H.cv.render(true);
    await H.settle();
    const form = document.createElement('div');
    form.style.cssText = 'height: 120px; margin: 0;';
    H.annEls.get('zone').appendChild(form);
    H.update(A, { annotations: [zoneAnnotation, { side: 'additions', lineNumber: H.item(A).fileDiff.hunks[0].additionStart + 3, metadata: { key: 'a2', kind: 'card' } }] });
    H.cv.render(true);
    const cleanSameTask = H.auditClean();
    await H.settle();
    return { cleanSameTask, cleanAtRest: H.auditClean() };
  });
  // No allowance: the fixture fails this test on any validator report.
  expect(result.cleanSameTask).toBe(true);
  expect(result.cleanAtRest).toBe(true);
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
  const page = await harness.open({ scripts: ROWLESS_SCRIPTS });
  await page.evaluate(MARK_ROWLESS);
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
    const page = await harness.open({ scripts: ROWLESS_SCRIPTS });
    await page.evaluate(MARK_ROWLESS);
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
