// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: line annotations and the item lifecycle hook.
 *
 * Facts (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F3  render(true) after updateItem is a synchronous flush
 *   F16 callback signatures, pooled hosts, rows replaced on every update,
 *       per-instance setOptions / setThemeType throw
 * plus the identity rules the bridge's annotation data flow is built on.
 */

import { test, expect } from '../harness/contract-test.js';

/** Bring up two small adjacent files and return the first hunk's first added line of each. */
async function bringUpTwo(page, options = {}) {
  return page.evaluate(async (opts) => {
    const H = window.H;
    const { roles } = H.workload;
    const A = roles.noNewline;
    const B = roles.small;
    await H.appLike({ build: { only: [A, B] }, ...opts });
    const line = (id) => {
      const hunk = H.item(id).fileDiff.hunks[0];
      return hunk.additionStart + 1;
    };
    return { A, B, lineA: line(A), lineB: line(B) };
  }, options);
}

test('F3: updateItem alone renders on the next frame; render(true) flushes in the same task', async ({ harness }) => {
  // Depends on it: PierreBridge._publish / _flush. An annotation-only publish
  // on a mounted item must leave the card connected when the call returns.
  const page = await harness.open();
  const { A, lineA } = await bringUpTwo(page);
  const result = await page.evaluate(async ({ A, lineA }) => {
    const H = window.H;
    const cards = () => H.host(A).querySelectorAll('[data-annotation-slot] .ann').length;
    const out = {};

    // Without a flush: nothing in the same task, nothing after a microtask.
    H.clearEvents();
    H.update(A, { annotations: [{ side: 'additions', lineNumber: lineA, metadata: { key: 'c1', text: 'one' } }] });
    out.noFlushSync = { cards: cards(), renderAnnotation: H.counts.renderAnnotation || 0, onPostRender: H.counts.onPostRender || 0 };
    await Promise.resolve();
    out.noFlushMicrotask = { cards: cards(), renderAnnotation: H.counts.renderAnnotation || 0 };
    await H.until(() => cards() === 1);
    out.noFlushLater = { cards: cards(), phases: H.eventsOf('onPostRender').map((e) => `${e.id}:${e.phase}`) };

    // With a flush: card, hook, height and extent all in the same task.
    H.clearEvents();
    const heightBefore = H.itemHeight(A);
    const extentBefore = H.root.scrollHeight;
    H.update(A, {
      annotations: [...H.cv.getItem(A).annotations, { side: 'additions', lineNumber: lineA, metadata: { key: 'c2', text: 'two', height: 60 } }],
    });
    H.cv.render(true);
    const el = H.annEls.get('c2');
    out.flushSync = {
      cards: cards(),
      connected: !!(el && el.isConnected),
      box: el ? Math.round(el.getBoundingClientRect().height) : null,
      phases: H.eventsOf('onPostRender').map((e) => `${e.id}:${e.phase}`),
      itemGrew: H.itemHeight(A) - heightBefore,
      extentGrew: H.root.scrollHeight - extentBefore,
    };
    await H.settle();
    out.clean = H.auditClean();
    return out;
  }, { A, lineA });

  expect(result.noFlushSync).toEqual({ cards: 0, renderAnnotation: 0, onPostRender: 0 });
  expect(result.noFlushMicrotask).toEqual({ cards: 0, renderAnnotation: 0 });
  expect(result.noFlushLater).toEqual({ cards: 1, phases: [`${A}:update`] });

  expect(result.flushSync.cards).toBe(2);
  expect(result.flushSync.connected).toBe(true);
  expect(result.flushSync.box).toBe(60);
  // The updated item is rendered first; a neighbour whose rows moved into the
  // window because of the height change may follow in the same pass.
  expect(result.flushSync.phases[0]).toBe(`${A}:update`);
  expect(result.flushSync.itemGrew).toBeGreaterThanOrEqual(60);
  expect(result.flushSync.extentGrew).toBe(result.flushSync.itemGrew);
  expect(result.clean).toBe(true);
});

test('F16: renderAnnotation gets 3 arguments, onPostRender 4 with the context last, renderCustomHeader 2', async ({ harness }) => {
  // Depends on it: every vendor callback the bridge binds. The previous
  // attempt's bridge read the context from the wrong position after a vendor
  // release and rendered zero annotations without logging anything.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const A = roles.noNewline;
    const seen = {};
    const defaults = { ...H.hooks };
    H.hooks.renderAnnotation = (annotation, fileOrDiff, context) => {
      seen.renderAnnotation = {
        hasMetadata: !!annotation.metadata,
        diffName: fileOrDiff && fileOrDiff.name,
        itemId: context && context.item && context.item.id,
      };
      return defaults.renderAnnotation(annotation, fileOrDiff, context);
    };
    H.hooks.renderCustomHeader = (fileOrDiff, context) => {
      seen.renderCustomHeader = { diffName: fileOrDiff && fileOrDiff.name, itemId: context && context.item && context.item.id };
      return defaults.renderCustomHeader(fileOrDiff, context);
    };
    H.hooks.onPostRender = (node, instance, phase, context) => {
      if (context.item.id !== A) return;
      seen.onPostRender = seen.onPostRender || [];
      seen.onPostRender.push({
        phase,
        nodeIsElement: node instanceof HTMLElement && node.tagName.toLowerCase() === 'diffs-container',
        nodeIsContextElement: node === context.element,
        instanceIsContextInstance: instance === context.instance,
        contextKeys: Object.keys(context).sort(),
      });
    };
    H.parse({});
    H.buildItems({ only: [A] });
    H.items[0].annotations = [{ side: 'additions', lineNumber: H.items[0].fileDiff.hunks[0].additionStart + 1, metadata: { key: 'a' } }];
    H.create({ ...H.APP_OPTIONS }, H.APP_CALLBACKS);
    H.cv.setItems(H.items);
    await H.settle();
    const argc = (name) => [...new Set(H.eventsOf(name).map((e) => e.argc))];
    return { A, seen, argc: { renderAnnotation: argc('renderAnnotation'), renderCustomHeader: argc('renderCustomHeader'), onPostRender: argc('onPostRender') } };
  });

  expect(result.argc).toEqual({ renderAnnotation: [3], renderCustomHeader: [2], onPostRender: [4] });
  expect(result.seen.renderAnnotation).toEqual({ hasMetadata: true, diffName: result.A, itemId: result.A });
  expect(result.seen.renderCustomHeader).toEqual({ diffName: result.A, itemId: result.A });
  expect(result.seen.onPostRender[0]).toEqual({
    phase: 'mount',
    nodeIsElement: true,
    nodeIsContextElement: true,
    instanceIsContextInstance: true,
    contextKeys: ['element', 'height', 'index', 'instance', 'item', 'renderedOptionsRevision', 'top', 'type', 'version'],
  });
});

test('F16: hosts are pooled and keep app attributes; unmount fires while the host is still connected', async ({ harness }) => {
  // Depends on it: PierreBridge host stamping (_applyHostClasses on mount and
  // update, _cleanHostClasses on unmount). A stamp left on a recycled host
  // labels the wrong file.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const unmounts = [];
    const stampSeenOnOtherItem = [];
    H.hooks.onPostRender = (node, instance, phase, context) => {
      if (phase === 'mount') {
        const previous = node.getAttribute('data-stamp');
        if (previous && previous !== context.item.id) stampSeenOnOtherItem.push({ previous, now: context.item.id, lightChildren: node.children.length > 0 });
        node.setAttribute('data-stamp', context.item.id);
      }
      if (phase === 'unmount') {
        unmounts.push({ connected: node.isConnected, hasShadowContent: !!node.shadowRoot && node.shadowRoot.childElementCount > 0 });
      }
    };
    await H.appLike({ build: { limit: 30, exclude: [H.workload.roles.hugeAdded, H.workload.roles.hugeModified] } });
    const hostAttributes = [...H.cv.getRenderedItems()[0].element.attributes].map((a) => a.name).filter((n) => n !== 'data-stamp');
    // Walk down far enough for hosts to be released and handed to other items.
    for (let i = 0; i < 12 && stampSeenOnOtherItem.length === 0; i++) {
      H.root.scrollTop += 2500;
      await H.settle(100);
    }
    return { hostAttributes, unmounts: unmounts.slice(0, 3), recycled: stampSeenOnOtherItem.slice(0, 1) };
  });

  // The vendor puts no id, class or file name on a host.
  expect(result.hostAttributes).toEqual([]);
  expect(result.unmounts.length).toBeGreaterThan(0);
  for (const u of result.unmounts) expect(u).toEqual({ connected: true, hasShadowContent: true });
  // A recycled host still carries the previous item's attribute.
  expect(result.recycled.length).toBe(1);
});

test('F16: every update of an item replaces all of its rows; the host and header slot keep identity', async ({ harness }) => {
  // Depends on it: row decorations (split full-width layout, hover restore)
  // are re-applied from onPostRender, never stamped once.
  const page = await harness.open();
  const { A, lineA } = await bringUpTwo(page);
  const result = await page.evaluate(async ({ A, lineA }) => {
    const H = window.H;
    const host = H.host(A);
    const rowsBefore = [...host.shadowRoot.querySelectorAll('[data-content] > [data-line]')];
    const headerBefore = host.querySelector('[slot="header-custom"]').firstElementChild;
    H.update(A, { annotations: [{ side: 'additions', lineNumber: lineA, metadata: { key: 'x' } }] });
    H.cv.render(true);
    const rowsAfter = [...H.host(A).shadowRoot.querySelectorAll('[data-content] > [data-line]')];
    return {
      sameHost: H.host(A) === host,
      sameHeaderElement: H.host(A).querySelector('[slot="header-custom"]').firstElementChild === headerBefore,
      rowCountBefore: rowsBefore.length,
      rowCountAfter: rowsAfter.length,
      rowsKept: rowsAfter.filter((r) => rowsBefore.includes(r)).length,
      oldRowsConnected: rowsBefore.filter((r) => r.isConnected).length,
    };
  }, { A, lineA });

  expect(result.sameHost).toBe(true);
  expect(result.sameHeaderElement).toBe(true);
  expect(result.rowCountBefore).toBeGreaterThan(0);
  expect(result.rowCountAfter).toBe(result.rowCountBefore);
  expect(result.rowsKept).toBe(0);
  expect(result.oldRowsConnected).toBe(0);
});

test('F16: per-instance setOptions and setThemeType throw inside CodeView', async ({ harness }) => {
  // Depends on it: PierreBridge.setDiffStyle / setTheme go through one
  // codeView.setOptions call; main's per-instance loops must not be ported.
  const page = await harness.open();
  const { A } = await bringUpTwo(page);
  const result = await page.evaluate((A) => {
    const instance = window.H.instance(A);
    const attempt = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };
    return {
      setOptions: attempt(() => instance.setOptions({ diffStyle: 'split' })),
      setThemeType: attempt(() => instance.setThemeType('dark')),
    };
  }, A);
  expect(result.setOptions).toMatch(/cannot be used inside CodeView/);
  expect(result.setThemeType).toMatch(/cannot be used inside CodeView/);
});

test('updateItem with an unchanged version returns false and renders nothing', async ({ harness }) => {
  // Depends on it: PierreBridge._publish bumps the record's version on every
  // write and re-reads the item first.
  const page = await harness.open();
  const { A, lineA } = await bringUpTwo(page);
  const result = await page.evaluate(async ({ A, lineA }) => {
    const H = window.H;
    const item = H.cv.getItem(A);
    const annotations = [{ side: 'additions', lineNumber: lineA, metadata: { key: 'same-version' } }];
    const sameVersion = H.cv.updateItem({ ...item, annotations });
    H.cv.render(true);
    const cardsAfterSameVersion = H.host(A).querySelectorAll('.ann').length;
    const bumped = H.cv.updateItem({ ...item, annotations, version: (item.version ?? 0) + 1 });
    H.cv.render(true);
    return { sameVersion, cardsAfterSameVersion, bumped, cardsAfterBump: H.host(A).querySelectorAll('.ann').length };
  }, { A, lineA });
  expect(result).toEqual({ sameVersion: false, cardsAfterSameVersion: 0, bumped: true, cardsAfterBump: 1 });
});

test('annotation identity: which changes re-invoke renderAnnotation for existing entries', async ({ harness }) => {
  // Depends on it: annotation and metadata objects stay identical across
  // publishes and the array is only appended to, so an open comment form is
  // not re-created (plan section 3.8, rule 8).
  const page = await harness.open();
  const { A, lineA } = await bringUpTwo(page);
  const result = await page.evaluate(async ({ A, lineA }) => {
    const H = window.H;
    const calls = async (mutate) => {
      H.clearEvents();
      mutate();
      H.cv.render(true);
      await H.settle(100);
      return H.eventsOf('renderAnnotation').map((e) => e.ann.key).sort();
    };
    const m1 = { key: 'k1' };
    const m2 = { key: 'k2' };
    const a1 = { side: 'additions', lineNumber: lineA, metadata: m1 };
    const a2 = { side: 'additions', lineNumber: lineA + 1, metadata: m2 };
    const out = {};
    out.initial = await calls(() => H.update(A, { annotations: [a1, a2] }));
    const a3 = { side: 'additions', lineNumber: lineA + 2, metadata: { key: 'k3' } };
    out.appended = await calls(() => H.update(A, { annotations: [a1, a2, a3] }));
    out.newArraySameObjects = await calls(() => H.update(A, { annotations: [a1, a2, a3] }));
    out.newAnnotationObjectsSameMetadata = await calls(() => H.update(A, { annotations: [{ ...a1 }, { ...a2 }, { ...a3 }] }));
    out.newMetadataObjects = await calls(() => H.update(A, {
      annotations: [{ ...a1, metadata: { ...m1 } }, { ...a2, metadata: { ...m2 } }, { ...a3, metadata: { ...a3.metadata } }],
    }));
    const a0 = { side: 'additions', lineNumber: lineA, metadata: { key: 'k0' } };
    const current = H.cv.getItem(A).annotations;
    out.insertedBefore = await calls(() => H.update(A, { annotations: [a0, ...current] }));
    return out;
  }, { A, lineA });

  expect(result.initial).toEqual(['k1', 'k2']);
  expect(result.appended).toEqual(['k3']);
  expect(result.newArraySameObjects).toEqual([]);
  expect(result.newAnnotationObjectsSameMetadata).toEqual([]);
  expect(result.newMetadataObjects).toEqual(['k1', 'k2', 'k3']);
  expect(result.insertedBefore).toEqual(['k0', 'k1', 'k2', 'k3']);
});

test('a focused textarea in an annotation keeps node, value and focus when another annotation is appended', async ({ harness }) => {
  // Depends on it: typing in a comment form while suggestions or other
  // comments are published to the same file.
  const page = await harness.open();
  const { A, B, lineA, lineB } = await bringUpTwo(page);
  await page.evaluate(({ A, lineA }) => {
    window.H.update(A, { annotations: [{ side: 'additions', lineNumber: lineA, metadata: { key: 'form', kind: 'form' } }] });
    window.H.cv.render(true);
  }, { A, lineA });
  const textarea = page.locator('textarea[data-ann-key="form"]');
  await textarea.click();
  await page.keyboard.type('draft');

  const afterAppend = await page.evaluate(async ({ A, B, lineA, lineB }) => {
    const H = window.H;
    const node = H.annEls.get('form').querySelector('textarea');
    H.update(A, { annotations: [...H.cv.getItem(A).annotations, { side: 'additions', lineNumber: lineA + 1, metadata: { key: 'later' } }] });
    H.cv.render(true);
    H.update(B, { annotations: [{ side: 'additions', lineNumber: lineB, metadata: { key: 'other-file' } }] });
    H.cv.render(true);
    await H.settle(100);
    const now = H.annEls.get('form').querySelector('textarea');
    return { sameNode: now === node, connected: now.isConnected, value: now.value, focused: document.activeElement === now };
  }, { A, B, lineA, lineB });
  expect(afterAppend).toEqual({ sameNode: true, connected: true, value: 'draft', focused: true });
  await page.keyboard.type(' more');
  await expect(textarea).toHaveValue('draft more');

  // Replacing the item's fileDiff re-invokes renderAnnotation for every entry:
  // the cached node and its value survive, focus does not.
  const afterReplace = await page.evaluate(async (A) => {
    const H = window.H;
    const node = H.annEls.get('form').querySelector('textarea');
    const hydrated = window.VendorTestExtras.hydratePartialDiff('clone', H.cv.getItem(A).fileDiff, H.contentsOf(A));
    H.update(A, { fileDiff: hydrated });
    H.cv.render(true);
    await H.settle(100);
    const now = H.annEls.get('form').querySelector('textarea');
    return { sameNode: now === node, connected: now.isConnected, value: now.value, focused: document.activeElement === now };
  }, A);
  expect(afterReplace).toEqual({ sameNode: true, connected: true, value: 'draft more', focused: false });
});

test('two annotations on the same side and line stack in array order', async ({ harness }) => {
  // Depends on it: the bridge's sort (line, side, typeOrder) decides the
  // visual order of an external thread, a comment and a suggestion on one line.
  const page = await harness.open();
  const { A, lineA } = await bringUpTwo(page);
  const result = await page.evaluate(({ A, lineA }) => {
    const H = window.H;
    H.update(A, {
      annotations: [
        { side: 'additions', lineNumber: lineA, metadata: { key: 'first' } },
        { side: 'additions', lineNumber: lineA, metadata: { key: 'second' } },
      ],
    });
    H.cv.render(true);
    const wrappers = [...H.host(A).querySelectorAll('[data-annotation-slot]')];
    return {
      slots: wrappers.map((w) => w.getAttribute('slot')),
      order: wrappers.map((w) => w.firstElementChild.dataset.annKey),
      firstAboveSecond: H.annEls.get('first').getBoundingClientRect().top < H.annEls.get('second').getBoundingClientRect().top,
    };
  }, { A, lineA });
  expect(result.slots).toEqual([`annotation-additions-${lineA}`, `annotation-additions-${lineA}`]);
  expect(result.order).toEqual(['first', 'second']);
  expect(result.firstAboveSecond).toBe(true);
});

test('an annotation on a line that is not rendered is built and attached with zero height, without an error', async ({ harness }) => {
  // Depends on it: ExternalCommentManager and TourRenderer must decide "is the
  // line visible" from PierreBridge.isLineVisible, never from "the card is in
  // the DOM" (plan section 3.9).
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    const T = roles.medium;
    await H.appLike({ build: { only: [T] } });
    const hunks = H.item(T).fileDiff.hunks;
    // A line number well outside every hunk of this partial diff.
    const last = hunks[hunks.length - 1];
    const hidden = last.additionStart + last.additionCount + 25;
    H.clearEvents();
    H.update(T, { annotations: [{ side: 'additions', lineNumber: hidden, metadata: { key: 'hidden' } }] });
    H.cv.render(true);
    const el = H.annEls.get('hidden');
    return {
      rowRendered: !!H.findRow(T, hidden),
      callbackInvoked: H.eventsOf('renderAnnotation').length,
      connected: !!(el && el.isConnected),
      height: el ? el.getBoundingClientRect().height : null,
      clean: H.auditClean(),
    };
  });
  expect(result).toEqual({ rowRendered: false, callbackInvoked: 1, connected: true, height: 0, clean: true });
});

test('a cached annotation element is re-attached intact after the item scrolls out and back', async ({ harness }) => {
  // Depends on it: the bridge's element cache is the single instance of every
  // card; state kept in card DOM survives virtualization.
  const page = await harness.open();
  const result = await page.evaluate(async () => {
    const H = window.H;
    const { roles } = H.workload;
    await H.appLike({ build: { only: H.workload.modifiedPaths.slice(0, 25) } });
    const id = roles.noNewline;
    const line = H.item(id).fileDiff.hunks[0].additionStart + 1;
    H.update(id, { annotations: [{ side: 'additions', lineNumber: line, metadata: { key: 'kept', kind: 'form' } }] });
    H.cv.render(true);
    const node = H.annEls.get('kept');
    node.querySelector('textarea').value = 'typed before eviction';
    node.dataset.appState = 'collapsed';

    H.cv.scrollTo({ type: 'item', id: H.items[20].id });
    await H.until(() => !H.mounted().includes(id));
    const whileEvicted = { mounted: H.mounted().includes(id), connected: node.isConnected };

    H.clearEvents();
    H.cv.scrollTo({ type: 'item', id });
    await H.until(() => H.mounted().includes(id) && node.isConnected);
    return {
      whileEvicted,
      renderAnnotationOnRemount: H.eventsOf('renderAnnotation').filter((e) => e.id === id).length,
      sameNode: H.annEls.get('kept') === node,
      connected: node.isConnected,
      value: node.querySelector('textarea').value,
      appState: node.dataset.appState,
    };
  });
  expect(result.whileEvicted).toEqual({ mounted: false, connected: false });
  // The vendor re-invokes the callback on every remount.
  expect(result.renderAnnotationOnRemount).toBeGreaterThanOrEqual(1);
  expect(result.sameNode).toBe(true);
  expect(result.connected).toBe(true);
  expect(result.value).toBe('typed before eviction');
  expect(result.appState).toBe('collapsed');
});
