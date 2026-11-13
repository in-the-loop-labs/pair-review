// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Gate G11 (plans/codeview-virtualized-diff.md): a `notice` annotation
 * ("Binary file", "Large diff ... Load diff") and the file-comment zone both
 * live at lineNumber 0 of the same item. Do they stack in array order, and are
 * their heights accounted for?
 *
 * Depends on it: the zone is always first in the array (so zone content never
 * shifts annotation indices) and the notice follows it. If this failed the
 * notice would have to be merged into the zone element.
 */

import { test, expect } from '../harness/contract-test.js';
import { ROWLESS_FIX } from '../harness/constants.js';

for (const diffStyle of ['unified', 'split']) {
  test(`G11: zone and notice at lineNumber 0 stack in array order with exact heights (${diffStyle})`, async ({ harness }) => {
    const page = await harness.open();
    const result = await page.evaluate(async ({ fix, diffStyle }) => {
      const H = window.H;
      const { roles } = H.workload;
      const ids = [roles.binary, roles.noNewline, roles.deleted];
      await H.appLike({ build: { only: ids }, options: { unsafeCSS: fix, diffStyle } });
      const sideOf = (id) => (H.item(id).fileDiff.type === 'deleted' ? 'deletions' : 'additions');
      const before = Object.fromEntries(ids.map((id) => [id, H.itemHeight(id)]));
      for (const id of ids) {
        H.update(id, {
          annotations: [
            { side: sideOf(id), lineNumber: 0, metadata: { key: `zone:${id}`, kind: 'zone' } },
            { side: sideOf(id), lineNumber: 0, metadata: { key: `notice:${id}`, text: 'Binary file', height: 36 } },
          ],
        });
      }
      H.cv.render(true);
      await H.settle();
      const measure = (id) => {
        const zone = H.annEls.get(`zone:${id}`);
        const notice = H.annEls.get(`notice:${id}`);
        const wrappers = [...H.host(id).querySelectorAll('[data-annotation-slot]')];
        return {
          order: wrappers.map((w) => w.firstElementChild === zone ? 'zone' : w.firstElementChild === notice ? 'notice' : '?'),
          sameSlot: wrappers[0].getAttribute('slot') === wrappers[1].getAttribute('slot'),
          zoneHeight: zone.getBoundingClientRect().height,
          noticeHeight: notice.getBoundingClientRect().height,
          zoneAboveNotice: zone.getBoundingClientRect().top <= notice.getBoundingClientRect().top,
        };
      };
      const out = { withEmptyZone: Object.fromEntries(ids.map((id) => [id, { ...measure(id), grew: H.itemHeight(id) - before[id] }])) };
      out.cleanWithEmptyZone = H.auditClean();

      // Fill the zones: the notice moves down by exactly the zone's content.
      const noticeTops = Object.fromEntries(ids.map((id) => [id, H.annEls.get(`notice:${id}`).getBoundingClientRect().top]));
      const heightsNow = Object.fromEntries(ids.map((id) => [id, H.itemHeight(id)]));
      for (const id of ids) {
        const card = document.createElement('div');
        card.style.height = '70px';
        H.annEls.get(`zone:${id}`).appendChild(card);
      }
      await H.until(() => ids.every((id) => H.itemHeight(id) - heightsNow[id] === 70));
      await H.settle();
      // Items stack, so an item's notice also moves by the growth of the items above it.
      out.noticeMovedBy = ids.map((id, index) => Math.round(H.annEls.get(`notice:${id}`).getBoundingClientRect().top - noticeTops[id]) - 70 * index);
      out.grewWithFilledZone = ids.map((id) => H.itemHeight(id) - heightsNow[id]);
      out.cleanWithFilledZone = H.auditClean();
      return out;
    }, { fix: ROWLESS_FIX, diffStyle });

    for (const [id, m] of Object.entries(result.withEmptyZone)) {
      expect(m.order, id).toEqual(['zone', 'notice']);
      expect(m.sameSlot, id).toBe(true);
      expect(m.zoneHeight, id).toBe(0);
      expect(m.noticeHeight, id).toBe(36);
      expect(m.zoneAboveNotice, id).toBe(true);
      // The harness card has 6 px margins above and below.
      expect(m.grew, id).toBe(36 + 12);
    }
    expect(result.cleanWithEmptyZone).toBe(true);
    expect(result.noticeMovedBy).toEqual([70, 70, 70]);
    expect(result.grewWithFilledZone).toEqual([70, 70, 70]);
    expect(result.cleanWithFilledZone).toBe(true);
    await harness.record(`G11-notice-and-zone-${diffStyle}`, result);
  });
}
