// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: the renderCodeViewFooter region.
 *
 * Fact F14 (plans/codeview-virtualized-diff.md, "Vendor facts"). The footer is
 * rendered once, after the last item, inside the scroller; the vendor does no
 * scroll anchoring inside it.
 *
 * Depends on it: decision D2. Context files render in a persistent
 * div.context-files-region returned from renderCodeViewFooter, with main's
 * legacy renderer unchanged; PRManager._mutateContextRegion anchors the app's
 * own mutations of the region.
 */

import { test, expect } from '../harness/contract-test.js';

/** Build a region of three blocks with sticky headers and bring up 12 items above it. */
async function bringUpWithFooter(page, options = {}) {
  await page.evaluate(async (options) => {
    const H = window.H;
    const { roles } = H.workload;
    const region = document.createElement('div');
    region.className = 'context-files-region';
    const block = (name, bodyHeight) => {
      const wrapper = document.createElement('div');
      wrapper.dataset.fileName = name;
      wrapper.style.cssText = 'margin: 8px 0; border: 1px solid #888;';
      const header = document.createElement('div');
      header.className = 'ctx-header';
      header.textContent = name;
      header.style.cssText = 'position: sticky; top: 0; height: 40px; background: #ddd; z-index: 1;';
      const body = document.createElement('div');
      body.className = 'ctx-body';
      // The button sits 120 px into the body so it is never under the sticky header.
      body.style.cssText = `height: ${bodyHeight}px; padding-top: 120px; box-sizing: border-box;`;
      const button = document.createElement('button');
      button.className = 'ctx-button';
      button.textContent = 'button';
      button.addEventListener('click', () => H.log('footerButtonClick', { name }));
      body.appendChild(button);
      wrapper.append(header, body);
      return wrapper;
    };
    window.__region = region;
    window.__block = block;
    window.__blocks = { a: block('ctx/a.js', 500), b: block('ctx/b.js', 1500), c: block('ctx/c.js', 300) };
    region.append(window.__blocks.a, window.__blocks.b, window.__blocks.c);
    H.hooks.renderCodeViewFooter = () => region;
    H.parse({});
    H.buildItems({ limit: 12, exclude: [roles.hugeAdded, roles.hugeModified] });
    H.create({ ...H.APP_OPTIONS, ...options }, [...H.APP_CALLBACKS, 'renderCodeViewFooter']);
    H.cv.setItems(H.items);
    await H.settle(200);
  }, options);
}

test('F14: the footer is rendered once, after the last item, inside the scroller, and counts toward the extent', async ({ harness }) => {
  const page = await harness.open();
  await bringUpWithFooter(page);
  const result = await page.evaluate(async () => {
    const H = window.H;
    const region = window.__region;
    const footerHost = H.root.querySelector('[data-diffs-code-view-footer]');
    const kinds = [...H.root.children].map((child) => (child.hasAttribute('data-diffs-code-view-footer') ? 'footer' : 'container'));
    const out = {
      calls: H.counts.renderCodeViewFooter,
      regionInFooterHost: !!(footerHost && footerHost.contains(region)),
      rootChildren: kinds,
      // The vendor's own extent excludes the footer; the scroll root's includes it.
      footerInRootExtent: H.root.scrollHeight - H.cv.getScrollHeight() >= region.getBoundingClientRect().height,
    };
    // Growth inside the footer while it is far below the viewport.
    const extent0 = H.root.scrollHeight;
    window.__blocks.b.querySelector('.ctx-body').style.height = '1900px';
    out.grewSynchronously = H.root.scrollHeight - extent0;
    // scrollIntoView of a child lands exactly.
    window.__blocks.b.scrollIntoView({ block: 'start' });
    await H.settle(250);
    out.scrollIntoViewTop = H.viewportTopOf(window.__blocks.b);
    out.itemsMountedWhileInFooter = H.mounted().length;
    // position: sticky inside the footer works.
    H.root.scrollTop += 300;
    await H.settle(200);
    out.sticky = { headerTop: H.viewportTopOf(window.__blocks.b.querySelector('.ctx-header')), blockTop: H.viewportTopOf(window.__blocks.b) };
    // The last block is fully reachable at maximum scroll.
    H.root.scrollTop = H.root.scrollHeight;
    await H.settle(200);
    out.lastBlockBottomGap = +(H.root.getBoundingClientRect().bottom - window.__blocks.c.getBoundingClientRect().bottom).toFixed(1);
    // An item scroll target issued from inside the footer lands at 0.
    const id = H.items[5].id;
    H.cv.scrollTo({ type: 'item', id });
    await H.until(() => !!H.host(id));
    await H.settle(250);
    out.itemTargetFromFooter = H.viewportTopOf(H.host(id));
    // Adding a block to the footer while viewing an item does not move the item.
    const top0 = H.viewportTopOf(H.host(id));
    region.prepend(window.__block('ctx/0.js', 400));
    await H.raf(3);
    await H.settle(150);
    out.itemMovedWhenFooterGrew = H.viewportTopOf(H.host(id)) - top0;
    out.calls2 = H.counts.renderCodeViewFooter;
    out.clean = H.auditClean();
    return out;
  });

  expect(result.calls).toBe(1);
  expect(result.regionInFooterHost).toBe(true);
  expect(result.rootChildren).toEqual(['container', 'footer']);
  expect(result.footerInRootExtent).toBe(true);
  expect(result.grewSynchronously).toBe(400);
  expect(result.scrollIntoViewTop).toBe(0);
  expect(result.itemsMountedWhileInFooter).toBe(0);
  expect(result.sticky).toEqual({ headerTop: 0, blockTop: -300 });
  expect(result.lastBlockBottomGap).toBeGreaterThanOrEqual(0);
  expect(result.lastBlockBottomGap).toBeLessThanOrEqual(8);
  expect(result.itemTargetFromFooter).toBe(0);
  expect(result.itemMovedWhenFooterGrew).toBe(0);
  expect(result.calls2).toBe(1);
  expect(result.clean).toBe(true);
});

test('F14: the footer survives setItems([]) and a re-set, on the same host, with no orphans', async ({ harness }) => {
  // Depends on it: renderDiff empties the region itself (replaceChildren)
  // before loadContextFiles; the vendor never does.
  const page = await harness.open();
  await bringUpWithFooter(page);
  const result = await page.evaluate(async () => {
    const H = window.H;
    const region = window.__region;
    const footerHost = H.root.querySelector('[data-diffs-code-view-footer]');
    H.cv.setItems([]);
    await H.settle(200);
    const empty = {
      hostPresent: H.root.querySelector('[data-diffs-code-view-footer]') === footerHost,
      regionConnected: region.isConnected,
      blocks: region.children.length,
      // With no items the footer is all there is to scroll.
      extentIsFooter: H.root.scrollHeight >= region.getBoundingClientRect().height,
    };
    H.cv.setItems(H.items);
    await H.settle(250);
    return {
      empty,
      after: {
        sameHost: H.root.querySelector('[data-diffs-code-view-footer]') === footerHost,
        regionConnected: region.isConnected,
        blocks: region.children.length,
        orphans: H.orphanHosts(),
        calls: H.counts.renderCodeViewFooter,
        mounted: H.mounted().length > 0,
      },
    };
  });
  expect(result.empty).toEqual({ hostPresent: true, regionConnected: true, blocks: 3, extentIsFooter: true });
  expect(result.after).toEqual({ sameHost: true, regionConnected: true, blocks: 3, orphans: 0, calls: 1, mounted: true });
});

test('F14 (vendor constraint): growth above the viewport inside the footer moves the visible content by the growth', async ({ harness }) => {
  // Depends on it: PRManager._mutateContextRegion records the first visible
  // context wrapper's viewport top, runs the mutation, then adds the
  // difference to root.scrollTop. On main the browser's scroll anchoring did
  // this; the CodeView root sets overflow-anchor: none.
  const page = await harness.open();
  await bringUpWithFooter(page);
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { a, b, c } = window.__blocks;
    b.scrollIntoView({ block: 'start' });
    await H.settle(250);
    H.root.scrollTop += 300;
    await H.settle(200);
    const out = { overflowAnchor: getComputedStyle(H.root).overflowAnchor };
    const before = H.viewportTopOf(b);
    const scrollTop0 = H.root.scrollTop;
    a.querySelector('.ctx-body').style.height = '700px'; // +200 above the viewport
    await H.raf(3);
    await H.settle(150);
    out.movedBy = H.viewportTopOf(b) - before;
    out.scrollTopChanged = H.root.scrollTop - scrollTop0;
    // The app-side fix: add the difference to scrollTop.
    H.root.scrollTop += out.movedBy;
    await H.raf(2);
    out.afterAppAnchor = H.viewportTopOf(b) - before;
    // Removing a block ABOVE: same story in the other direction.
    const beforeRemove = H.viewportTopOf(c);
    a.remove();
    await H.raf(3);
    await H.settle(150);
    out.movedByRemoval = H.viewportTopOf(c) - beforeRemove;
    return out;
  });
  expect(result.overflowAnchor).toBe('none');
  expect(result.movedBy).toBe(200);
  expect(result.scrollTopChanged).toBe(0);
  expect(result.afterAppAnchor).toBe(0);
  expect(result.movedByRemoval).not.toBe(0);
});

for (const pointerEventsOnScroll of [false, true]) {
  test(`F14: a click inside the footer right after a scroll works (pointerEventsOnScroll: ${pointerEventsOnScroll})`, async ({ harness }) => {
    // Depends on it: context-file controls (gap expansion, dismiss, comment
    // buttons) stay clickable while the user scrolls. The footer is outside
    // the container the vendor disables during a scroll.
    const page = await harness.open();
    await bringUpWithFooter(page, { pointerEventsOnScroll });
    await page.evaluate(async () => {
      const H = window.H;
      window.__blocks.b.scrollIntoView({ block: 'start' });
      await H.settle(250);
      window.__probe = new Promise((ok) => {
        H.root.addEventListener('scroll', () => {
          requestAnimationFrame(() => {
            const button = window.__blocks.b.querySelector('.ctx-button');
            const box = button.getBoundingClientRect();
            ok({ hit: document.elementFromPoint(box.left + 5, box.top + 5) === button, x: box.left + 5, y: box.top + 5 });
          });
        }, { once: true });
      });
    });
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, 30);
    const probe = await page.evaluate(() => window.__probe);
    expect(probe.hit).toBe(true);
    await page.mouse.click(probe.x, probe.y);
    await expect.poll(() => page.evaluate(() => window.H.eventsOf('footerButtonClick').length)).toBe(1);
  });
}
