// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: the gutter buttons. Real pointer input, the app's own
 * CSS for the buttons.
 */

import { test, expect, openBridge } from './bridge-test.js';

/** Bring up two files and return where a row of the first is on screen. */
async function up(page, { options = {}, role = 'small' } = {}) {
  return page.evaluate(async ({ options, role }) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    await BH.up({ entries: [BH.diffEntry(roles[role]), BH.diffEntry(roles.large)], options });
    const id = roles[role];
    const lines = [...H.host(id).shadowRoot.querySelectorAll('[data-content] > [data-line]')]
      .filter((row) => row.getAttribute('data-line-type') !== 'change-deletion')
      .map((row) => Number(row.getAttribute('data-line')));
    window.T = {
      id,
      point: (line, side = 'additions') => { const box = H.findRow(id, line, side).getBoundingClientRect(); return { x: Math.round(box.left + 200), y: Math.round(box.top + box.height / 2) }; },
      gutter: () => {
        const el = BH.bridge.findFileElement(id)?.querySelector('[slot="gutter-utility-slot"] .pierre-gutter-buttons');
        if (!el) return { shown: false };
        const box = el.getBoundingClientRect();
        const comment = el.querySelector('.pierre-comment-btn').getBoundingClientRect();
        const chat = el.querySelector('.pierre-chat-btn')?.getBoundingClientRect();
        return {
          shown: box.height > 0 && getComputedStyle(el).visibility !== 'hidden',
          y: Math.round(box.top + box.height / 2),
          comment: { x: Math.round(comment.left + comment.width / 2), y: Math.round(comment.top + comment.height / 2) },
          chat: chat ? { x: Math.round(chat.left + chat.width / 2), y: Math.round(chat.top + chat.height / 2) } : null,
        };
      },
      hoveredDom: () => { const row = BH.bridge.findFileElement(id)?.shadowRoot.querySelector('[data-content] > [data-hovered]'); return row ? Number(row.getAttribute('data-line')) : null; },
    };
    return { id, lines };
  }, { options, role });
}

async function hover(page, line, side) {
  const point = await page.evaluate(([l, s]) => window.T.point(l, s), [line, side]);
  await page.mouse.move(point.x, point.y - 3);
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => window.H.raf(3));
  return point;
}

test('hovering a line shows the buttons on it; a click on each acts on that line', async ({ harness }) => {
  const page = await openBridge(harness);
  const { id, lines } = await up(page);
  const point = await hover(page, lines[3]);
  const shown = await page.evaluate(() => ({ gutter: window.T.gutter(), row: window.BH.bridge.getHoveredRow(window.T.id) }));
  expect(shown.gutter.shown).toBe(true);
  expect(Math.abs(shown.gutter.y - point.y)).toBeLessThanOrEqual(2);
  expect(shown.row).toEqual({ lineNumber: lines[3], side: 'RIGHT' });

  await page.mouse.click(shown.gutter.comment.x, shown.gutter.comment.y);
  await hover(page, lines[5]);
  const second = await page.evaluate(() => window.T.gutter());
  await page.mouse.click(second.chat.x, second.chat.y);
  const calls = await page.evaluate(() => window.BH.calls.filter((c) => c.name === 'onCommentClick' || c.name === 'onChatClick'));
  expect(calls).toEqual([
    { name: 'onCommentClick', args: [id, lines[3], 'RIGHT', { start: lines[3], end: lines[3], side: 'RIGHT', isRange: false }] },
    { name: 'onChatClick', args: [id, lines[5], 'RIGHT', { start: lines[5], end: lines[5], side: 'RIGHT', isRange: false }] },
  ]);
});

test('without a chat handler there is no chat button', async ({ harness }) => {
  const page = await openBridge(harness);
  const { lines } = await up(page, { options: { onChatClick: null } });
  await hover(page, lines[2]);
  const gutter = await page.evaluate(() => window.T.gutter());
  expect(gutter.shown).toBe(true);
  expect(gutter.chat).toBeNull();
});

test('a drag that starts on the comment button selects a range, and the click on the range acts on all of it', async ({ harness }) => {
  const page = await openBridge(harness);
  const { id, lines } = await up(page);
  await hover(page, lines[2]);
  const start = await page.evaluate(() => window.T.gutter());
  const end = await page.evaluate((line) => window.T.point(line), lines[3]);
  await page.mouse.move(start.comment.x, start.comment.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y - 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 2 });
  await page.mouse.up();
  await page.evaluate(() => window.H.raf(3));
  const afterDrag = await page.evaluate(() => ({ selection: window.BH.bridge.getLineSelection(window.T.id), calls: window.BH.calls.filter((c) => c.name === 'onCommentClick').length, gutter: window.T.gutter() }));
  expect(afterDrag.selection).toEqual({ start: lines[2], end: lines[3], side: 'RIGHT' });
  // The release that ends the drag is not a click on the button.
  expect(afterDrag.calls).toBe(0);

  // The buttons sit on the selection now; a click applies to the range and clears it.
  await page.mouse.click(afterDrag.gutter.comment.x, afterDrag.gutter.comment.y);
  const result = await page.evaluate(() => ({
    calls: window.BH.calls.filter((c) => c.name === 'onCommentClick').map((c) => c.args),
    selection: window.BH.bridge.getLineSelection(window.T.id),
  }));
  expect(result.calls).toEqual([[id, lines[2], 'RIGHT', { start: lines[2], end: lines[3], side: 'RIGHT', isRange: true }]]);
  expect(result.selection).toBeNull();
});

test('characterization: a drag from the comment button stops growing after its second line, as on the per-file renderer', async ({ harness }) => {
  // The limit is the per-file renderer's too (ledger H45: a drag that starts
  // on the button never selected more than two lines there). The drag reads
  // the hovered row from the viewer, and once a selection exists the viewer
  // answers the selection's last line, not the row under the pointer. Kept
  // as it is: the migration changes no behaviour that the old engine did not
  // cause. A drag down the line numbers (the viewer's own) selects any range.
  const page = await openBridge(harness);
  const { lines } = await up(page);
  await hover(page, lines[2]);
  const start = await page.evaluate(() => window.T.gutter());
  await page.mouse.move(start.comment.x, start.comment.y);
  await page.mouse.down();
  const seen = [];
  for (const line of [lines[3], lines[4], lines[5]]) {
    const point = await page.evaluate((l) => window.T.point(l), line);
    await page.mouse.move(point.x, point.y - 2, { steps: 4 });
    await page.mouse.move(point.x, point.y, { steps: 2 });
    await page.evaluate(() => window.H.raf(2));
    seen.push(await page.evaluate(() => window.BH.bridge.getLineSelection(window.T.id)));
  }
  await page.mouse.up();
  const two = { start: lines[2], end: lines[3], side: 'RIGHT' };
  expect(seen).toEqual([two, two, two]);
});

test('selectLines, getLineSelection and clearLineSelection: one selection for the whole pane, in the app\'s sides', async ({ harness }) => {
  const page = await openBridge(harness);
  const { id, lines } = await up(page);
  const result = await page.evaluate(({ id, lines }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const other = H.workload.roles.large;
    const otherLine = b.files.get(other).metadata.hunks[0].additionStart;
    const out = { none: b.getLineSelection(id) };
    b.selectLines(id, lines[4], lines[2], 'RIGHT');
    out.selected = b.getLineSelection(id);
    out.notInOther = b.getLineSelection(other);
    // Clearing another file's selection leaves this one alone.
    b.clearLineSelection(other);
    out.stillSelected = b.getLineSelection(id);
    // Selecting in another file replaces it: the pane has one selection.
    b.selectLines(other, otherLine, otherLine + 1, 'LEFT');
    out.afterOther = [b.getLineSelection(id), b.getLineSelection(other)];
    b.clearLineSelection(other);
    out.cleared = b.getLineSelection(other);
    b.selectLines('nope.js', 1, 2, 'RIGHT');
    out.unknown = [b.getLineSelection('nope.js'), b.codeView.getSelectedLines()];
    return out;
  }, { id, lines });
  expect(result.none).toBeNull();
  expect(result.selected).toEqual({ start: lines[2], end: lines[4], side: 'RIGHT' });
  expect(result.notInOther).toBeNull();
  expect(result.stillSelected).toEqual(result.selected);
  expect(result.afterOther[0]).toBeNull();
  expect(result.afterOther[1]).toMatchObject({ side: 'LEFT' });
  expect(result.cleared).toBeNull();
  expect(result.unknown).toEqual([null, null]);
});

test('in split layout the hovered side is the column under the pointer', async ({ harness }) => {
  const page = await openBridge(harness);
  await up(page, { options: { diffStyle: 'split' }, role: 'medium' });
  const target = await page.evaluate(() => {
    const { H, BH, T } = window;
    const shadow = BH.bridge.findFileElement(T.id).shadowRoot;
    const box = (row) => { const b = row.getBoundingClientRect(); return { x: Math.round(b.left + 60), y: Math.round(b.top + b.height / 2), line: Number(row.getAttribute('data-line')) }; };
    const left = shadow.querySelector('[data-deletions] [data-content] > [data-line][data-line-type="change-deletion"]');
    const right = shadow.querySelector('[data-additions] [data-content] > [data-line][data-line-type="change-addition"]');
    return { left: box(left), right: box(right) };
  });
  await page.mouse.move(target.left.x, target.left.y - 3);
  await page.mouse.move(target.left.x, target.left.y);
  await page.evaluate(() => window.H.raf(3));
  const left = await page.evaluate(() => ({ row: window.BH.bridge.getHoveredRow(window.T.id), gutter: window.T.gutter() }));
  await page.mouse.click(left.gutter.comment.x, left.gutter.comment.y);
  await page.mouse.move(target.right.x, target.right.y - 3);
  await page.mouse.move(target.right.x, target.right.y);
  await page.evaluate(() => window.H.raf(3));
  const right = await page.evaluate(() => ({ row: window.BH.bridge.getHoveredRow(window.T.id), calls: window.BH.calls.filter((c) => c.name === 'onCommentClick').map((c) => c.args.slice(1, 3)) }));
  expect(left.row).toEqual({ lineNumber: target.left.line, side: 'LEFT' });
  expect(right.row).toEqual({ lineNumber: target.right.line, side: 'RIGHT' });
  expect(right.calls).toEqual([[target.left.line, 'LEFT']]);
});

test('the buttons are hidden while the pane scrolls under a resting pointer, and are back on the row under it when the pane rests', async ({ harness }) => {
  const page = await openBridge(harness);
  const { lines } = await up(page, { role: 'large' });
  const point = await hover(page, lines[6]);
  const before = await page.evaluate(() => window.T.gutter().shown);
  // Read in the scroll event itself, after the bridge's own listener: what a
  // reader sees while the rows move under the pointer.
  await page.evaluate(() => {
    window.__scrolled = new Promise((ok) => window.H.root.addEventListener('scroll', () => ok(window.T.gutter().shown), { once: true }));
  });
  await page.mouse.wheel(0, 100);
  const duringScroll = await page.evaluate(() => window.__scrolled);
  const atRest = await page.evaluate(async ({ x, y }) => {
    const { H, BH, T } = window;
    // The bridge decides when the pane is at rest (_watchScrollRest).
    await H.until(() => !BH.bridge._gutterHiddenByScroll);
    const el = BH.bridge.findFileElement(T.id).shadowRoot.elementFromPoint(x, y);
    const row = el && el.closest('[data-line]');
    const gutter = T.gutter();
    return {
      shown: gutter.shown,
      hovered: BH.bridge.getHoveredRow(T.id)?.lineNumber ?? null,
      underPointer: row ? Number(row.getAttribute('data-line')) : null,
      // The buttons are level with the pointer, not where the old row went.
      level: Math.abs(gutter.y - y) <= 12,
    };
  }, point);
  expect(before).toBe(true);
  expect(duringScroll).toBe(false);
  // No pointer move was needed: the bridge told the viewer where the pointer rests.
  expect(atRest.shown).toBe(true);
  expect(atRest.level).toBe(true);
  expect(atRest.hovered).toBe(atRest.underPointer);
  expect(atRest.hovered).not.toBe(lines[6]);
});

test('with a long file mounted, the hover is not re-derived between the steps of a scroll, and once when the pane has come to rest (H169)', async ({ harness }) => {
  // Marking the row under the pointer makes the browser lay the file's rows
  // out again; in a long file that is milliseconds, paid between the steps
  // of one scroll gesture for a row nobody stops at. Steps three frames
  // apart: the pane is "still" for two frames between them, which is a rest
  // only where no long file is mounted (the tests around this one).
  const page = await openBridge(harness);
  const { lines } = await up(page, { role: 'hugeAdded' });
  await hover(page, lines[6]);
  const result = await page.evaluate(async () => {
    const { H, BH, T } = window;
    const shadow = BH.bridge.findFileElement(T.id).shadowRoot;
    let told = 0;
    // What the bridge dispatches into the file's rows; a real pointer move is trusted.
    shadow.addEventListener('pointermove', (event) => { if (!event.isTrusted) told++; }, { capture: true });
    const hoveredBefore = BH.bridge.getHoveredRow(T.id)?.lineNumber ?? null;
    // Every step must move the pane: a step at the end of the pane is a rest.
    const room = H.root.scrollHeight - H.root.clientHeight - H.root.scrollTop;
    const stride = Math.min(40, Math.floor(room / 13));
    const during = [];
    let moved = 0;
    for (let step = 0; step < 12; step++) {
      const from = H.root.scrollTop;
      H.root.scrollTop += stride;
      if (H.root.scrollTop !== from) moved++;
      await H.raf(3);
      during.push(told);
    }
    const hiddenWhileMoving = !T.gutter().shown;
    await H.until(() => !BH.bridge._gutterHiddenByScroll);
    return {
      longFileMounted: BH.bridge._hasLongFileMounted(),
      stride, moved, during, hiddenWhileMoving, toldAtRest: told, shown: T.gutter().shown, hoveredBefore, hovered: BH.bridge.getHoveredRow(T.id)?.lineNumber ?? null,
    };
  });
  expect(result.longFileMounted).toBe(true);
  expect(result.stride).toBeGreaterThanOrEqual(18);
  expect(result.moved).toBe(12);
  expect(result.during).toEqual(Array(12).fill(0));
  expect(result.hiddenWhileMoving).toBe(true);
  expect(result.toldAtRest).toBe(1);
  expect(result.shown).toBe(true);
  expect(result.hovered).not.toBe(result.hoveredBefore);
});

test('with no long file mounted, the pane is at rest after two frames', async ({ harness }) => {
  const page = await openBridge(harness);
  const { lines } = await up(page, { role: 'large' });
  await hover(page, lines[6]);
  const result = await page.evaluate(async () => {
    const { H, BH, T } = window;
    let told = 0;
    BH.bridge.findFileElement(T.id).shadowRoot.addEventListener('pointermove', (event) => { if (!event.isTrusted) told++; }, { capture: true });
    H.root.scrollTop += 40;
    // The scroll event in the next frame, two frames without a move, and the frame the check runs in.
    await H.until(() => BH.bridge._gutterHiddenByScroll);
    await H.raf(4);
    return { longFileMounted: BH.bridge._hasLongFileMounted(), told, hidden: BH.bridge._gutterHiddenByScroll, shown: T.gutter().shown };
  });
  expect(result).toEqual({ longFileMounted: false, told: 1, hidden: false, shown: true });
});

test('after a scroll that leaves the resting pointer on no row, the file drops its hovered row and shows no button', async ({ harness }) => {
  const page = await openBridge(harness);
  const { id, lines } = await up(page);
  const point = await hover(page, lines[3]);
  const result = await page.evaluate(async ({ id, y }) => {
    const { H, BH, T } = window;
    const before = { hovered: T.hoveredDom(), shown: T.gutter().shown };
    // Bring the next file's header under the pointer without a pointer
    // event: the first file ends just above the pointer and stays mounted.
    const hostBottom = H.host(id).getBoundingClientRect().bottom;
    H.root.scrollTop += Math.round(hostBottom - y) + 30;
    // The scroll event is dispatched in the next frame; then the bridge
    // waits for the pane to rest (_watchScrollRest).
    await H.until(() => BH.bridge._gutterHiddenByScroll);
    await H.until(() => !BH.bridge._gutterHiddenByScroll);
    const first = H.host(id);
    const box = first ? first.getBoundingClientRect() : null;
    return {
      before,
      mounted: !!first,
      above: !!box && box.bottom < y,
      hovered: T.hoveredDom(),
      shown: T.gutter().shown,
      row: BH.bridge.getHoveredRow(id) ?? null,
    };
  }, { id, y: point.y });
  expect(result.before).toEqual({ hovered: lines[3], shown: true });
  // The file is still drawn, and the pointer is below its last row.
  expect(result.mounted).toBe(true);
  expect(result.above).toBe(true);
  expect(result.hovered).toBeNull();
  expect(result.shown).toBe(false);
  expect(result.row).toBeNull();
});

test('the hover and the buttons come back by themselves after the hovered file is drawn again', async ({ harness }) => {
  const page = await openBridge(harness);
  const { id, lines } = await up(page);
  await hover(page, lines[3]);
  const result = await page.evaluate(async ({ id, lines }) => {
    const { H, BH, T } = window;
    const b = BH.bridge;
    const before = { hovered: T.hoveredDom(), gutter: T.gutter().shown };
    // An annotation publish re-creates every row of the file.
    b.addAnnotation(id, { lineNumber: lines[8], side: 'RIGHT', type: 'card', data: { text: 'below' }, id: 'card-below' });
    const sameTask = { hovered: T.hoveredDom(), gutter: T.gutter().shown };
    await H.raf(4);
    const after = { hovered: T.hoveredDom(), gutter: T.gutter().shown, row: b.getHoveredRow(id) };
    // The pointer is over the file: the gates a background upgrade asks.
    const gates = { pointer: b.isPointerOverFile(id), otherPointer: b.isPointerOverFile(H.workload.roles.large), focus: b.hasFocusInside(id), unknown: [b.isPointerOverFile('nope.js'), b.hasFocusInside('nope.js')] };
    return { before, sameTask, after, gates };
  }, { id, lines });
  expect(result.before).toEqual({ hovered: lines[3], gutter: true });
  // The vendor drops both when the rows are replaced ...
  expect(result.sameTask.hovered).toBeNull();
  // ... and the bridge tells it where the pointer is.
  expect(result.after).toEqual({ hovered: lines[3], gutter: true, row: { lineNumber: lines[3], side: 'RIGHT' } });
  expect(result.gates).toEqual({ pointer: true, otherPointer: false, focus: false, unknown: [false, false] });
});

/**
 * Two files, the first with a card on a line, and a button of the test's own
 * in each place the page puts things into a file: its header (one plain, one
 * whose icon is written again on every draw of the header), its comment zone
 * and the card. Every click that reaches the document is recorded in
 * `window.__clicks`: `<name>` by the button it was on, `any:<what>` for
 * whatever it was sent to, and in `window.__clickSenders` who sent it
 * ('browser' or 'bridge').
 * @returns {Promise<{id: string, at: Object, sentinel: {x: number, y: number}, sound: Object}>}
 */
async function clickTargets(page) {
  return page.evaluate(async () => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const id = roles.small;
    await BH.up({ entries: [BH.diffEntry(id), BH.diffEntry(roles.medium)] });
    const b = BH.bridge;
    const line = b.files.get(id).metadata.hunks[0].additionStart;
    b.addAnnotation(id, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'a card', height: 40 }, id: 'card-with-button' });
    await H.settle(200);
    window.__clicks = [];
    const host = H.host(id);
    const button = (name, parent, inner) => {
      const el = document.createElement('button');
      el.id = `probe-${name}`;
      el.style.cssText = 'width: 44px; height: 20px; display: block;';
      // An icon inside the button: what a press usually lands on.
      el.innerHTML = inner ? '<svg width="16" height="16" viewBox="0 0 16 16" style="display:block;margin:0 auto"><rect width="16" height="16"/></svg>' : name;
      el.addEventListener('click', () => window.__clicks.push(name));
      parent.appendChild(el);
      return el;
    };
    // The file's header as the page hands it to the viewer: one element per file.
    const header = BH.headers.get(id);
    const buttons = {
      // Out of the flow: nothing in a header may change its height (F9).
      header: Object.assign(button('header', header, true), { style: 'position: absolute; left: 240px; width: 44px; height: 20px;' }),
      // A control whose icon the page writes again on every draw of the
      // header, as the application does with the collapse chevron
      // (DiffRenderer.updateFileHeaderState): the icon that was pressed is
      // gone for good at the release, the button it was in is not.
      restamped: Object.assign(button('restamped', header, true), { style: 'position: absolute; left: 320px; width: 44px; height: 20px;' }),
      zone: button('zone', BH.zones.get(id), false),
      card: button('card', host.querySelector('.card'), false),
    };
    const icon = buttons.restamped.innerHTML;
    window.__restamps = 0;
    BH.onHeaderDraw = (drawn) => {
      if (drawn !== id) return;
      buttons.restamped.innerHTML = icon;
      window.__restamps++;
    };
    // Every click that reaches the document at all, whoever it was sent to.
    // A spot that is nobody's control, outside the pane: a click on it is the
    // sentinel of clicksOf.
    const sentinel = document.createElement('div');
    sentinel.id = 'probe-sentinel';
    sentinel.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 24px; height: 24px; z-index: 2147483647;';
    document.body.appendChild(sentinel);
    window.__clickSenders = [];
    document.addEventListener('click', (event) => {
      const target = event.composedPath()[0];
      if (target === sentinel) {
        window.__clicks.push('sentinel');
        return;
      }
      window.__clicks.push(`any:${target.id || target.tagName.toLowerCase()}`);
      window.__clickSenders.push(event.isTrusted ? 'browser' : 'bridge');
    }, true);
    await H.settle(200);
    const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const row = host.shadowRoot.querySelector('[data-content] > [data-line]');
    return { id, at: { header: centre(buttons.header), restamped: centre(buttons.restamped), zone: centre(buttons.zone), card: centre(buttons.card), row: centre(row) }, sentinel: centre(sentinel), sound: BH.sound() };
  });
}

/**
 * The clicks of the mouse gestures made since `window.__clicks` was last
 * emptied. Nothing is waited out: a click is made on the sentinel (a spot
 * that is nobody's control, outside the pane). The browser delivers what
 * gestures produce in their order, so when the sentinel's click is there,
 * every click the earlier gestures were going to get from the browser is
 * there; and a timer set after that runs after every timer their releases
 * set (the bridge decides in one).
 */
async function clicksBehindSentinel(page, sentinel) {
  await page.mouse.click(sentinel.x, sentinel.y);
  await expect.poll(() => page.evaluate(() => window.__clicks.includes('sentinel'))).toBe(true);
  return page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve(window.__clicks.filter((entry) => entry !== 'sentinel')), 0)));
}

test('a click whose press and release straddle a draw of the file still reaches the control, once: header, comment zone and card', async ({ harness }) => {
  // Every draw of a file takes its header, its comment zone and its cards
  // out of the document and puts them back, and a browser sends no click at
  // all when the pressed element left the document between the press and the
  // release. A file is drawn whenever something is published on it: its
  // contents arriving, a comment reload, a suggestion landing. The bridge
  // clicks the element itself in that case (_handlePointerUp).
  const page = await openBridge(harness);
  const setup = await clickTargets(page);
  expect(setup.sound).toEqual({ orphans: 0, clean: true });

  const press = async (target, drawBetween) => {
    await page.evaluate(() => { window.__clicks = []; });
    await page.mouse.move(setup.at[target].x, setup.at[target].y);
    await page.mouse.down();
    if (drawBetween) await page.evaluate((id) => { window.BH.bridge._publish(id); }, setup.id);
    await page.mouse.up();
    return clicksBehindSentinel(page, setup.sentinel);
  };

  for (const target of ['header', 'restamped', 'zone', 'card']) {
    // Nothing drawn in between: the browser's own click, and the bridge adds none.
    expect((await press(target, false)).filter((entry) => entry === target), `${target}, no draw`).toEqual([target]);
    // The file drawn in between: one click all the same.
    expect((await press(target, true)).filter((entry) => entry === target), `${target}, drawn in between`).toEqual([target]);
  }
  // The header was asked for again by those draws, so the icon was written again each time.
  expect(await page.evaluate(() => window.__restamps)).toBeGreaterThanOrEqual(4);

  // A press on one control released on another. The browser sends the click
  // to what both are in (the header), to neither control; with a draw in
  // between the bridge sends the same click.
  const drag = async (from, to, drawBetween) => {
    await page.evaluate(() => { window.__clicks = []; });
    await page.mouse.move(setup.at[from].x, setup.at[from].y);
    await page.mouse.down();
    await page.mouse.move(setup.at[to].x, setup.at[to].y, { steps: 3 });
    if (drawBetween) await page.evaluate((id) => { window.BH.bridge._publish(id); }, setup.id);
    await page.mouse.up();
    return clicksBehindSentinel(page, setup.sentinel);
  };
  const plain = await drag('header', 'restamped', false);
  expect(plain).toEqual(['any:div']);
  expect(await drag('header', 'restamped', true)).toEqual(plain);
  // A press on a line of code is the viewer's (pointer events): the bridge clicks nothing there.
  expect(await press('row', true)).toEqual([]);
  expect(await page.evaluate(() => window.BH.sound())).toEqual({ orphans: 0, clean: true });
});

/**
 * One press and release at `at` with a pen or a finger, as the browser
 * receives them from the device; `whileDown` runs between the two.
 */
async function penOrTouch(page, pointer, at, whileDown = async () => {}) {
  const session = await page.context().newCDPSession(page);
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  try {
    if (pointer === 'touch') {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await whileDown();
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      const event = { x, y, pointerType: 'pen', button: 'left', clickCount: 1 };
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'pen' });
      await session.send('Input.dispatchMouseEvent', { ...event, type: 'mousePressed', buttons: 1 });
      await whileDown();
      await session.send('Input.dispatchMouseEvent', { ...event, type: 'mouseReleased', buttons: 0 });
    }
  } finally {
    await session.detach();
  }
}

/**
 * The clicks of one press and release on a target of clickTargets, and who
 * sent each. "No second click" is not waited for: a second gesture of the
 * same kind is made on the sentinel. The browser delivers what gestures
 * produce in their order, so when the sentinel's click is there, the
 * browser's own click of the first gesture is there if it sent one; and a
 * timer set after that runs after every timer the first release set.
 */
async function clicksOf(page, pointer, setup, target, drawBetween) {
  await page.evaluate(() => { window.__clicks = []; window.__clickSenders = []; });
  await penOrTouch(page, pointer, setup.at[target], async () => {
    if (drawBetween) await page.evaluate((id) => { window.BH.bridge._publish(id); }, setup.id);
  });
  await penOrTouch(page, pointer, setup.sentinel);
  await expect.poll(() => page.evaluate(() => window.__clicks.includes('sentinel'))).toBe(true);
  return page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve({
    clicks: window.__clicks.filter((entry) => entry !== 'sentinel'),
    senders: window.__clickSenders.slice(),
  }), 0)));
}

test.describe('a press that is not a mouse button', () => {
  test.use({ hasTouch: true });

  // PierreBridge._isMousePress. A browser has two ways of making a
  // click. For a mouse it remembers what was pressed and sends no click if
  // that left the document before the release: the bridge sends it. For a
  // touch it recognizes the tap after the release and clicks whatever is
  // under the point then: nothing is lost, and a click from the bridge would
  // be a second one, which undoes the first on a toggle.

  test('a tap whose touch start and touch end straddle a draw of the file: the browser sends the click itself, and the bridge adds none', async ({ harness }) => {
    const page = await openBridge(harness);
    const setup = await clickTargets(page);
    expect(setup.sound).toEqual({ orphans: 0, clean: true });
    // Not the first tap of the page: a browser delivers the click of the
    // first tap after a load in the task of the release, and of every later
    // one some milliseconds after it (after the bridge has decided).
    await penOrTouch(page, 'touch', setup.sentinel);
    await expect.poll(() => page.evaluate(() => window.__clicks.includes('sentinel'))).toBe(true);

    for (const target of ['header', 'restamped', 'zone', 'card']) {
      for (const drawBetween of [false, true]) {
        const seen = await clicksOf(page, 'touch', setup, target, drawBetween);
        expect(seen.clicks.filter((entry) => entry === target), `${target}, ${drawBetween ? 'drawn in between' : 'no draw'}`).toEqual([target]);
        expect(seen.senders, `${target}, ${drawBetween ? 'drawn in between' : 'no draw'}`).toEqual(['browser']);
      }
    }
    // The same control three times in a row, a draw in each.
    for (let tap = 0; tap < 3; tap++) {
      expect((await clicksOf(page, 'touch', setup, 'restamped', true)).senders, `tap ${tap + 1}`).toEqual(['browser']);
    }
    expect(await page.evaluate(() => window.BH.sound())).toEqual({ orphans: 0, clean: true });
  });

  test('a tap with the bridge\'s click repair off: the browser\'s click arrives all the same (why the bridge adds none for a touch)', async ({ harness }) => {
    // The browser's rule for a touch, with the viewer's re-slotting. When this
    // starts to fail, a tap loses its click to a draw as a mouse press does,
    // and _isMousePress must stop telling the two apart.
    const page = await openBridge(harness);
    const setup = await clickTargets(page);
    await page.evaluate(() => {
      const b = window.BH.bridge;
      b.root.removeEventListener('pointerdown', b._onRootPointerDown);
    });
    await penOrTouch(page, 'touch', setup.sentinel);
    await expect.poll(() => page.evaluate(() => window.__clicks.includes('sentinel'))).toBe(true);
    for (const target of ['header', 'restamped', 'zone', 'card']) {
      const seen = await clicksOf(page, 'touch', setup, target, true);
      expect(seen.clicks.filter((entry) => entry === target), target).toEqual([target]);
      expect(seen.senders, target).toEqual(['browser']);
    }
  });

  test('a pen the browser handles as a mouse loses its click to a draw as a mouse does: the bridge sends it, once', async ({ harness }) => {
    const page = await openBridge(harness);
    const setup = await clickTargets(page);
    expect(setup.sound).toEqual({ orphans: 0, clean: true });
    for (const target of ['header', 'restamped', 'zone', 'card']) {
      const plain = await clicksOf(page, 'pen', setup, target, false);
      expect(plain.clicks.filter((entry) => entry === target), `${target}, no draw`).toEqual([target]);
      expect(plain.senders, `${target}, no draw`).toEqual(['browser']);
      const drawn = await clicksOf(page, 'pen', setup, target, true);
      expect(drawn.clicks.filter((entry) => entry === target), `${target}, drawn in between`).toEqual([target]);
      // One click, from whoever: the browser's when this draw left the
      // pressed element in the document (the zone and the card here: a
      // publish that changes nothing of theirs), the bridge's when the draw
      // took it out.
      expect(drawn.senders, `${target}, drawn in between`).toHaveLength(1);
      // A header is taken out and put back by every draw.
      if (target === 'header' || target === 'restamped') expect(drawn.senders, `${target}, drawn in between`).toEqual(['bridge']);
    }
    expect(await page.evaluate(() => window.BH.sound())).toEqual({ orphans: 0, clean: true });
  });

  test('a mouse press whose `pointerdown` had its default prevented has no `mousedown`, and loses its click to a draw all the same: the bridge sends it', async ({ harness }) => {
    // The case _isMousePress decides by the pointer's type, because neither
    // `mousedown` nor `touchstart` came with the press.
    const page = await openBridge(harness);
    const setup = await clickTargets(page);
    await page.evaluate(() => {
      window.__mouseDowns = 0;
      document.addEventListener('pointerdown', (event) => event.preventDefault(), true);
      document.addEventListener('mousedown', () => { window.__mouseDowns++; }, true);
    });
    const press = async (target, drawBetween) => {
      await page.evaluate(() => { window.__clicks = []; window.__clickSenders = []; });
      await page.mouse.move(setup.at[target].x, setup.at[target].y);
      await page.mouse.down();
      if (drawBetween) await page.evaluate((id) => { window.BH.bridge._publish(id); }, setup.id);
      await page.mouse.up();
      await page.mouse.click(setup.sentinel.x, setup.sentinel.y);
      await expect.poll(() => page.evaluate(() => window.__clicks.includes('sentinel'))).toBe(true);
      return page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve(window.__clickSenders.slice()), 0)));
    };
    expect(await press('header', false)).toEqual(['browser']);
    expect(await press('header', true)).toEqual(['bridge']);
    expect(await press('restamped', true)).toEqual(['bridge']);
    expect(await page.evaluate(() => window.__mouseDowns)).toBe(0);
  });
});

test('without the bridge, a draw of the file between press and release leaves the control without its click (what the bridge repairs)', async ({ harness }) => {
  // The browser's rule, with the viewer's re-slotting: when this starts to
  // fail, a draw no longer takes a file's header out of the document, and
  // _handlePointerUp's repair can go.
  const page = await openBridge(harness);
  const setup = await page.evaluate(async () => {
    const { H, BH } = window;
    const id = H.workload.roles.small;
    await BH.up({ entries: [BH.diffEntry(id)] });
    await H.settle(200);
    const b = BH.bridge;
    // The repair off: the release is not looked at.
    b._handleRootPointerDown = () => {};
    b.root.removeEventListener('pointerdown', b._onRootPointerDown);
    window.__clicks = [];
    const header = BH.headers.get(id);
    const el = document.createElement('button');
    // Out of the flow: nothing in a header may change its height (F9).
    el.style.cssText = 'position: absolute; left: 240px; width: 44px; height: 20px;';
    el.textContent = 'header';
    el.addEventListener('click', () => window.__clicks.push('header'));
    header.appendChild(el);
    // A spot that is nobody's control, outside the pane (clicksBehindSentinel).
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 24px; height: 24px; z-index: 2147483647;';
    document.body.appendChild(sentinel);
    document.addEventListener('click', (event) => window.__clicks.push(event.composedPath()[0] === sentinel ? 'sentinel' : 'any'), true);
    await H.settle(200);
    const centre = (target) => { const r = target.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    return { id, ...centre(el), sentinel: centre(sentinel) };
  });
  await page.mouse.move(setup.x, setup.y);
  await page.mouse.down();
  await page.evaluate((id) => { window.BH.bridge._publish(id); }, setup.id);
  await page.mouse.up();
  expect(await clicksBehindSentinel(page, setup.sentinel)).toEqual([]);
});
