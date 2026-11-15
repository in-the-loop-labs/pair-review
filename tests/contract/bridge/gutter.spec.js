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

test('the buttons are hidden by a scroll under a resting pointer and come back when the pointer moves', async ({ harness }) => {
  const page = await openBridge(harness);
  const { lines } = await up(page, { role: 'large' });
  const point = await hover(page, lines[6]);
  const before = await page.evaluate(() => window.T.gutter().shown);
  await page.evaluate(() => { window.__scrolled = new Promise((ok) => window.H.root.addEventListener('scroll', () => ok(true), { once: true })); });
  await page.mouse.wheel(0, 100);
  await page.evaluate(() => window.__scrolled);
  await page.evaluate(() => window.H.raf(3));
  const afterScroll = await page.evaluate(() => window.T.gutter().shown);
  await page.mouse.move(point.x + 1, point.y);
  await page.evaluate(() => window.H.raf(3));
  const afterMove = await page.evaluate(({ x, y }) => {
    const { BH, T } = window;
    const el = BH.bridge.findFileElement(T.id).shadowRoot.elementFromPoint(x, y);
    const row = el && el.closest('[data-line]');
    return { shown: T.gutter().shown, hovered: BH.bridge.getHoveredRow(T.id)?.lineNumber ?? null, underPointer: row ? Number(row.getAttribute('data-line')) : null };
  }, point);
  expect(before).toBe(true);
  expect(afterScroll).toBe(false);
  expect(afterMove.shown).toBe(true);
  // On the line that is under the pointer now, not the one it was on.
  expect(afterMove.hovered).toBe(afterMove.underPointer);
  expect(afterMove.hovered).not.toBe(lines[6]);
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
