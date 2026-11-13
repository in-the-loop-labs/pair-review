// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: changing options on a live viewer.
 *
 * Depends on it (plans/codeview-virtualized-diff.md, section 3.12): one
 * options object, replaced on change with codeView.setOptions({ ...current,
 * diffStyle }); callbacks bound once; no scrollTop save and restore around a
 * split toggle; theme through the worker pool plus one setOptions.
 */

import { test, expect } from '../harness/contract-test.js';

test('setOptions replaces the options object: diffStyle and themeType changes keep the first visible line, focus and annotation DOM', async ({ harness }) => {
  const page = await harness.open();
  const setup = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { only: H.workload.modifiedPaths.slice(0, 20) } });
    const T = H.workload.modifiedPaths[9];
    const hunks = H.item(T).fileDiff.hunks;
    const line = hunks[1].additionStart + 1;
    H.update(T, { annotations: [{ side: 'additions', lineNumber: line, metadata: { key: 'form', kind: 'form' } }] });
    H.cv.scrollTo({ type: 'line', id: T, lineNumber: line, side: 'additions', align: 'center' });
    await H.settle();
    return { T, line, roles };
  });
  await page.locator('textarea[data-ann-key="form"]').click();
  await page.keyboard.type('draft');

  const result = await page.evaluate(async ({ T, line }) => {
    const H = window.H;
    const textarea = H.annEls.get('form').querySelector('textarea');
    const host = H.host(T);
    const header = H.headerEls.get(T);
    // The first row at or below the sticky header is the vendor's anchor.
    const firstVisible = () => [...H.host(T).shadowRoot.querySelectorAll('[data-content] > [data-line]')]
      .find((row) => H.viewportTopOf(row) >= 40);
    const anchorLine = firstVisible().getAttribute('data-line');
    const anchorType = firstVisible().getAttribute('data-line-type');
    const topOf = () => {
      const row = [...H.host(T).shadowRoot.querySelectorAll('[data-content] > [data-line]')]
        .find((r) => r.getAttribute('data-line') === anchorLine && r.getAttribute('data-line-type') === anchorType);
      return row ? H.viewportTopOf(row) : null;
    };
    const top0 = topOf();
    const state = () => ({
      anchorMoved: topOf() - top0,
      sameHost: H.host(T) === host,
      sameHeader: H.host(T).querySelector('[slot="header-custom"]').firstElementChild === header,
      sameTextarea: H.annEls.get('form').querySelector('textarea') === textarea && textarea.isConnected,
      value: textarea.value,
      focused: document.activeElement === textarea,
      diffType: H.shape(T).diffType,
      colorScheme: getComputedStyle(H.host(T)).colorScheme,
      clean: H.auditClean(),
    });
    const change = async (patch) => {
      H.clearEvents();
      H.setOptions(patch);
      await H.settle();
      return {
        ...state(),
        renderAnnotationCalls: H.eventsOf('renderAnnotation').length,
        headerCallsForItem: H.eventsOf('renderCustomHeader').filter((e) => e.id === T).length,
        phases: [...new Set(H.eventsOf('onPostRender').filter((e) => e.id === T).map((e) => e.phase))],
      };
    };
    return {
      split: await change({ diffStyle: 'split' }),
      dark: await change({ themeType: 'dark' }),
      unified: await change({ diffStyle: 'unified' }),
      light: await change({ themeType: 'light' }),
    };
  }, setup);

  for (const [name, step] of Object.entries(result)) {
    expect(step.anchorMoved, name).toBe(0);
    expect(step.sameHost, name).toBe(true);
    expect(step.sameHeader, name).toBe(true);
    expect(step.sameTextarea, name).toBe(true);
    expect(step.value, name).toBe('draft');
    expect(step.focused, name).toBe(true);
    // Annotations are not re-invoked; the header callback is, on every render.
    expect(step.renderAnnotationCalls, name).toBe(0);
    expect(step.headerCallsForItem, name).toBeGreaterThanOrEqual(1);
    expect(step.phases, name).toEqual(['update']);
    expect(step.clean, name).toBe(true);
  }
  expect(result.split.diffType).toBe('split');
  expect(result.unified.diffType).toBe('single');
  expect(result.dark.colorScheme).toBe('dark');
  expect(result.light.colorScheme).toBe('light');
});

test('layout.gap is real layout: the space between items, with exact accounting', async ({ harness }) => {
  // Depends on it: the 24 px between files comes from layout: { gap: 24 },
  // not from a CSS margin on the host (a margin on a vendor host is not in
  // the vendor's layout).
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({
      build: { only: [roles.binary, roles.modeOnly, roles.noNewline, roles.small] },
      options: { layout: { paddingTop: 0, paddingBottom: 0, gap: 24 } },
    });
    const hosts = H.cv.getRenderedItems().map((r) => r.element.getBoundingClientRect());
    const gaps = hosts.slice(1).map((box, i) => Math.round(box.top - hosts[i].bottom));
    return { firstTop: H.viewportTopOf(H.cv.getRenderedItems()[0].element), gaps, clean: H.auditClean() };
  });
  expect(result.firstTop).toBe(0);
  expect(result.gaps.length).toBeGreaterThanOrEqual(2);
  for (const gap of result.gaps) expect(gap).toBe(24);
  expect(result.clean).toBe(true);
});

test('collapsing an item above the viewport does not move what is in view', async ({ harness }) => {
  // Depends on it: PRManager.setFileCollapsed works for an unmounted file
  // (generated files, "viewed", tours) without a scroll correction.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    await H.appLike({ build: { only: H.workload.modifiedPaths.slice(0, 20) } });
    const above = H.workload.modifiedPaths[4];
    const viewed = H.workload.modifiedPaths[12];
    H.cv.scrollTo({ type: 'item', id: viewed });
    await H.until(() => !!H.host(viewed));
    await H.settle();
    const top0 = H.viewportTopOf(H.host(viewed));
    const wasMounted = H.mounted().includes(above);
    H.update(above, { collapsed: true });
    H.cv.render(true);
    await H.settle();
    const collapsedMove = H.viewportTopOf(H.host(viewed)) - top0;
    H.update(above, { collapsed: false });
    H.cv.render(true);
    await H.settle();
    return { wasMounted, collapsedMove, expandedMove: H.viewportTopOf(H.host(viewed)) - top0, clean: H.auditClean() };
  });
  expect(result).toEqual({ wasMounted: false, collapsedMove: 0, expandedMove: 0, clean: true });
});
