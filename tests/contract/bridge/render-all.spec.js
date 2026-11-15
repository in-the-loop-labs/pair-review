// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: renderAll, the first of the bridge's two list writers,
 * and the stamps a file's host carries.
 */

import { test, expect, openBridge } from './bridge-test.js';

test('renderAll draws one item per entry, in entry order, with the header and the zone of each', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const names = [roles.noNewline, roles.small, roles.medium, roles.added, roles.deleted, roles.binary];
    await BH.up({ entries: names.map((n) => BH.diffEntry(n)) });
    return {
      names,
      files: [...BH.bridge.files.keys()],
      itemIds: names.map((n) => BH.bridge.codeView.getItem(n)?.id),
      mounted: H.mounted(),
      hosts: Object.fromEntries(H.mounted().map((id) => [id, BH.hostInfo(id)])),
      zones: H.mounted().map((id) => BH.zones.get(id)?.isConnected ?? false),
      zoneSides: Object.fromEntries(names.map((n) => [n, BH.bridge.codeView.getItem(n).annotations[0].side])),
      sound: BH.sound(),
    };
  });
  expect(result.files).toEqual(result.names);
  expect(result.itemIds).toEqual(result.names);
  expect(result.mounted.length).toBeGreaterThan(0);
  for (const id of result.mounted) {
    expect(result.hosts[id]).toEqual({ fileName: id, classes: ['d2h-file-wrapper'], header: id });
  }
  expect(result.zones.every(Boolean)).toBe(true);
  // The zone is on the side the vendor lays out for the file.
  expect(result.zoneSides[result.names[4]]).toBe('deletions');
  expect(result.zoneSides[result.names[3]]).toBe('additions');
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

for (const mode of ['the same files', 'a file removed above', 'a file added above', 'the file being read removed']) {
  test(`renderAll again (${mode}) replaces the list with no orphan host and puts the reader back`, async ({ harness }) => {
    const page = await openBridge(harness);
    const result = await page.evaluate(async (mode) => {
      const { H, BH } = window;
      const { roles } = H.workload;
      const names = H.workload.order.filter((n) => n !== roles.hugeAdded && n !== roles.hugeModified).slice(0, 30);
      await BH.up({ entries: names.map((n) => BH.diffEntry(n)), options: { useWorkerPool: true } });
      // Read somewhere in the middle of the list, a little inside a file.
      BH.bridge.scrollToItem(names[14]);
      await H.settle(250);
      H.root.scrollTop += 137;
      await H.settle(250);
      const itemId = H.firstVisibleItem();
      const firstRow = [...H.host(itemId).shadowRoot.querySelectorAll('[data-content] > [data-line]')]
        .find((row) => H.viewportTopOf(row) >= 40);
      const line = { n: Number(firstRow.getAttribute('data-line')), side: firstRow.getAttribute('data-line-type') === 'change-deletion' ? 'deletions' : 'additions', top: H.viewportTopOf(firstRow) };
      const recordBefore = BH.bridge.files.get(itemId);

      let next = names.slice();
      if (mode === 'a file removed above') next.splice(3, 1);
      if (mode === 'a file added above') next.splice(3, 0, roles.hugeModified);
      if (mode === 'the file being read removed') next = next.filter((n) => n !== itemId);
      BH.renderAll(next.map((n) => BH.diffEntry(n)));
      const row = () => H.findRow(itemId, line.n, line.side);
      const movedSync = row() ? H.viewportTopOf(row()) - line.top : null;
      await H.settle(300);
      return {
        mode,
        movedSync,
        moved: row() ? H.viewportTopOf(row()) - line.top : null,
        recordIsNew: BH.bridge.files.get(itemId) !== recordBefore,
        files: [...BH.bridge.files.keys()],
        expected: next,
        scrollTop: H.root.scrollTop,
        sound: BH.sound(),
      };
    }, mode);
    expect(result.files).toEqual(result.expected);
    expect(result.recordIsNew).toBe(true);
    expect(result.sound).toEqual({ orphans: 0, clean: true });
    if (mode === 'the file being read removed') {
      // Nothing to anchor to: the reader stays near where they were.
      expect(result.scrollTop).toBeGreaterThan(0);
    } else {
      // The first visible line is where it was, in the same task and after settling.
      expect(result.movedSync).toBe(0);
      expect(result.moved).toBe(0);
    }
  });
}

test('host stamps follow the item through pooling and are stripped when it unmounts', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const names = H.workload.order.filter((n) => n !== roles.hugeAdded && n !== roles.hugeModified).slice(0, 30);
    BH.hostClasses.set(names[0], ['generated-file']);
    BH.hostClasses.set(names[1], ['summaries-hidden-file']);
    await BH.up({ entries: names.map((n, i) => BH.diffEntry(n, { collapsed: i === 0 })) });
    const first = { ...BH.hostInfo(names[0]) };
    const second = { ...BH.hostInfo(names[1]) };
    const firstHost = BH.bridge.findFileElement(names[0]);

    // Scroll far away: the first files unmount, their hosts go back to the pool.
    BH.bridge.scrollToItem(names[25]);
    await H.settle(300);
    const unmounted = BH.bridge.findFileElement(names[0]) === null;
    const hostAfterUnmount = { fileName: firstHost.getAttribute('data-file-name'), classes: [...firstHost.classList] };
    // Every mounted host carries its own file's stamps and nobody else's.
    const mismatched = H.mounted().filter((id) => {
      const info = BH.hostInfo(id);
      return info.fileName !== id || info.header !== id || info.classes.join(' ') !== 'd2h-file-wrapper';
    });
    const hostsInDom = [...H.root.querySelectorAll('diffs-container')].map((el) => el.getAttribute('data-file-name'));

    // Back: the first file is stamped again, whichever pooled host it got.
    BH.bridge.scrollToItem(names[0]);
    await H.settle(300);
    // The page's state for a file changed while it is mounted.
    BH.hostClasses.set(names[1], []);
    BH.bridge.refreshHostState(names[1]);
    return {
      first, second, unmounted, hostAfterUnmount, mismatched,
      everyHostNamed: hostsInDom.every((name) => typeof name === 'string' && name.length > 0),
      firstAgain: BH.hostInfo(names[0]),
      secondRefreshed: BH.hostInfo(names[1]),
      names: names.slice(0, 2),
      unmountSeen: BH.lifecycle.some((e) => e.id === names[0] && e.phase === 'unmount'),
      sound: BH.sound(),
    };
  });
  expect(result.first).toEqual({ fileName: result.names[0], classes: ['collapsed', 'd2h-file-wrapper', 'generated-file'], header: result.names[0] });
  expect(result.second).toEqual({ fileName: result.names[1], classes: ['d2h-file-wrapper', 'summaries-hidden-file'], header: result.names[1] });
  expect(result.unmounted).toBe(true);
  expect(result.unmountSeen).toBe(true);
  // A host that is not in use carries nothing of the file it showed.
  if (result.hostAfterUnmount.fileName !== null) {
    // The pool handed it to another file already: then it carries that file's stamps only.
    expect(result.hostAfterUnmount.fileName).not.toBe(result.names[0]);
    expect(result.hostAfterUnmount.classes).not.toContain('generated-file');
    expect(result.hostAfterUnmount.classes).not.toContain('collapsed');
  } else {
    expect(result.hostAfterUnmount.classes).toEqual([]);
  }
  expect(result.mismatched).toEqual([]);
  expect(result.everyHostNamed).toBe(true);
  expect(result.firstAgain).toEqual(result.first);
  expect(result.secondRefreshed.classes).toEqual(['d2h-file-wrapper']);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a path in another form names the same file everywhere in the API', async ({ harness }) => {
  const page = await openBridge(harness);
  const result = await page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    await BH.up({ entries: [BH.diffEntry(roles.small), BH.diffEntry(roles.medium)] });
    const b = BH.bridge;
    const variant = `./${roles.small}`;
    b.addAnnotation(variant, { lineNumber: b.files.get(roles.small).metadata.hunks[0].additionStart, side: 'RIGHT', type: 'card', data: { text: 'x' }, id: 'card-v' });
    b.setCollapsed(`/${roles.small}`, true);
    return {
      resolved: [b.resolveFileId(variant), b.resolveFileId(`/${roles.small}`), b.resolveFileId('nope.js'), b.resolveFileId(null)],
      heldByCanonical: b.hasAnnotation(roles.small, 'card-v'),
      keys: [...b.files.keys()],
      collapsed: b.files.get(roles.small).collapsed,
      element: b.findFileElement(variant) === b.findFileElement(roles.small),
      small: roles.small,
    };
  });
  expect(result.resolved).toEqual([result.small, result.small, null, null]);
  expect(result.heldByCanonical).toBe(true);
  expect(result.keys).toHaveLength(2);
  expect(result.collapsed).toBe(true);
  expect(result.element).toBe(true);
});
