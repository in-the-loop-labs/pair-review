// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: the row window inside an item.
 *
 * With the viewer's default metrics (`itemMetrics.hunkLineCount: 1`) an item
 * draws only the rows near the viewport and moves that window a row at a time
 * as the pane scrolls. A window that moves is updated in place: rows that left
 * it are trimmed, rows that entered it are appended.
 *
 * Fact (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F26  (vendor defect) When the window shrinks at its end, the trim removes
 *        everything after the last row it keeps, including what belongs to
 *        that row: the separator after a file's last row, and the annotation
 *        row of a line. Neither is drawn again when the window grows, because
 *        growth appends rows only. It comes back when its row is appended
 *        again (the window end went above the row and returned) or when the
 *        item is drawn from scratch. With an `itemMetrics.hunkLineCount`
 *        larger than the number of rows an item shows, the item's window is
 *        every row at every scroll position, nothing is trimmed, and the
 *        defect cannot occur in that item.
 *
 *   F30  (vendor defect) With a `hunkLineCount` larger than the number of
 *        rows the pane shows, an item's rows are drawn in blocks of that
 *        many: the block the middle of the pane's window is in, and the one
 *        before it. While the middle is in one block and the lower part of
 *        the pane is in the next, the rows of the next block are not drawn:
 *        the drawn rows are held against the pane's bottom edge instead of
 *        being where the layout puts them, until the middle crosses the
 *        boundary. The last rows of an item that ends a few rows after a
 *        boundary, at the end of the pane, are never drawn.
 *   F31  (vendor defect) The viewer measures every drawn row with
 *        getBoundingClientRect, whose numbers are 32-bit floats. A row more
 *        than 2^18 px from the viewport measures a 64th of a pixel off when
 *        the line height is not a multiple of 1/32 px, and the item's
 *        computed height then differs from its DOM. Within 2^18 px the
 *        measurement is exact.
 *
 * Depends on it: PierreBridge passes `hunkLineCount: 5000` (F26: no smaller;
 * F31: no larger, two blocks of 5,000 rows of 17.4 px stay within 2^18 px of
 * the pane) and asks the viewer for an item's rows a second time where its
 * first answer leaves rows of the pane out
 * (PierreBridge.coverPaneWithRowWindow, F30). If a vendor bump makes the
 * "vendor defect" tests fail, the defect was fixed and what depends on it can
 * be reconsidered.
 *
 * `instance.renderRange` (which rows the vendor drew) is read here to find
 * the scroll position at which the window ends at a given row. It is the
 * vendor's own record; production code does not read it.
 */

import { test, expect } from '../harness/contract-test.js';

const VALIDATOR = /CodeView: (reconciled item height does not match DOM height|sticky container height does not match computed layout)/;
// The pane's padding and gap the application uses. Any values do; these put
// the target file where the workload's geometry meets the defect.
const LAYOUT = { paddingTop: 16, paddingBottom: 16, gap: 24 };

/**
 * Runs in the page. Brings up the first 30 ordinary modified files, replaces
 * the target's patch-only diff with its hydrated one when asked, and returns
 * the helpers the tests step with.
 */
const SETUP = `
  window.rowWindow = async ({ itemMetrics, layout, hydrate, annotate }) => {
    const { H } = window;
    const { roles } = H.workload;
    const names = H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 30);
    await H.appLike({ build: { only: names }, options: { layout, itemMetrics } });
    // The target: a file below the first screen that, once its contents are
    // known, has hidden lines after its last hunk.
    const hydratedOf = (name) => window.VendorTestExtras.hydratePartialDiff('clone', H.cv.getItem(name).fileDiff, H.contentsOf(name));
    const hiddenAfter = (diff) => {
      const last = diff.hunks[diff.hunks.length - 1];
      return diff.additionLines.length - (last.additionStart + last.additionCount - 1);
    };
    const T = names.slice(2).find((name) => {
      const diff = hydratedOf(name);
      const rows = diff.hunks.reduce((sum, hunk) => sum + hunk.unifiedLineCount, 0);
      return hiddenAfter(diff) > 5 && rows >= 36 && rows <= 56;
    });
    const hydrated = hydratedOf(T);
    const patch = { };
    if (hydrate) patch.fileDiff = hydrated;
    if (annotate) {
      const diff = H.cv.getItem(T).fileDiff;
      const lines = [];
      for (const hunk of diff.hunks) for (let l = hunk.additionStart; l < hunk.additionStart + hunk.additionCount; l++) lines.push(l);
      patch.annotations = lines.map((l) => ({ side: 'additions', lineNumber: l, metadata: { key: 'card:' + l, text: 'card ' + l, height: 30 } }));
    }
    H.update(T, patch);
    H.cv.render(true);
    await H.settle();

    const api = { T, hunks: hydrated.hunks.length, hiddenAfter: hiddenAfter(hydrated) };
    api.step = async (top) => { H.root.scrollTop = top; await H.raf(3); };
    api.windowEnd = () => { const r = H.rec(T).instance.renderRange; return r.startingLine + r.totalLines; };
    api.audit = () => (H.heightAudit().find((a) => a.id === T) || { dH: null, dTop: null });
    /** What is drawn of the target, read from its shadow DOM. */
    api.drawn = () => {
      const host = H.host(T);
      if (!host) return null;
      const kids = [...host.shadowRoot.querySelector('[data-content]').children];
      let index = kids.length - 1;
      while (index >= 0 && !kids[index].hasAttribute('data-line')) index--;
      const lastRow = kids[index];
      const after = kids.slice(index + 1);
      const rootRect = H.root.getBoundingClientRect();
      return {
        rows: kids.filter((el) => el.hasAttribute('data-line')).length,
        separators: kids.filter((el) => el.hasAttribute('data-separator')).length,
        lastRowLine: Number(lastRow.getAttribute('data-line')),
        lastRowType: lastRow.getAttribute('data-line-type'),
        separatorAfterLastRow: after.some((el) => el.hasAttribute('data-separator')),
        cardRowAfterLastRow: after.some((el) => el.hasAttribute('data-line-annotation')),
        // Positive: the last row ends this far above the bottom edge of the pane, so it is on screen.
        lastRowAboveViewportBottom: Math.round(rootRect.bottom - lastRow.getBoundingClientRect().bottom),
        lastRowBelowViewportTop: Math.round(lastRow.getBoundingClientRect().top - rootRect.top),
      };
    };
    api.cardHeight = (line) => Math.round(H.annEls.get('card:' + line).getBoundingClientRect().height);
    /** Step the pane by one code row at a time until pred() holds. Returns the steps taken, or -1. */
    api.walk = async (direction, pred, maxSteps = 120) => {
      const row = H.rec(T).instance.metrics.lineHeight;
      for (let steps = 0; steps <= maxSteps; steps++) {
        if (pred()) return steps;
        await api.step(H.root.scrollTop + direction * row);
      }
      return -1;
    };
    return api;
  };
`;

async function openRowWindow(harness) {
  const page = await harness.open();
  await page.addScriptTag({ content: SETUP });
  return page;
}

test('F26 (vendor defect): a row window that shrinks to end at a file\'s last row drops the separator after it, and growing the window does not draw it again', async ({ harness }) => {
  // Depends on it: nothing may rely on the default row window. A changed file
  // whose contents are loaded keeps git's hunks and has the rest of the file
  // behind a last separator with its expand control. A reader who scrolls up
  // a little and back down would find that control gone and everything below
  // the file 40 px off, until the file is drawn from scratch.
  const page = await openRowWindow(harness);
  harness.allowErrors(page, VALIDATOR);
  const result = await page.evaluate(async (layout) => {
    const { H } = window;
    const w = await window.rowWindow({ itemMetrics: { diffHeaderHeight: 40 }, layout, hydrate: true });
    const out = { hunks: w.hunks, hiddenAfter: w.hiddenAfter };

    // The whole file is drawn while its top is at the top of the pane.
    H.cv.scrollTo({ type: 'item', id: w.T, align: 'start' });
    await H.settle();
    out.whole = { ...w.drawn(), windowEnd: w.windowEnd(), audit: w.audit() };
    const N = out.whole.rows;

    // Scroll up, a row at a time, until the window ends exactly at the last row.
    out.stepsUp = await w.walk(-1, () => w.windowEnd() === N);
    out.dropped = { ...w.drawn(), windowEnd: w.windowEnd(), audit: w.audit() };

    // Scroll back down until the end of the file is well inside the pane.
    out.stepsDown = await w.walk(+1, () => w.drawn().lastRowAboveViewportBottom >= 100);
    await H.settle(300);
    out.backDown = { ...w.drawn(), windowEnd: w.windowEnd(), audit: w.audit() };
    out.fileBelow = H.heightAudit().filter((a) => a.id !== w.T && a.dTop !== 0).map((a) => a.dTop);

    // It returns when the last row itself leaves the window and enters it again.
    out.stepsUpPast = await w.walk(-1, () => w.windowEnd() < N);
    out.past = { ...w.drawn(), windowEnd: w.windowEnd(), audit: w.audit() };
    out.stepsDownAgain = await w.walk(+1, () => w.windowEnd() > N);
    await H.settle(300);
    out.healed = { ...w.drawn(), windowEnd: w.windowEnd(), audit: w.audit(), clean: H.auditClean() };
    return out;
  }, LAYOUT);

  // The fixture this test stands on.
  expect(result.hiddenAfter).toBeGreaterThan(5);
  expect(result.whole.separatorAfterLastRow).toBe(true);
  expect(result.whole.windowEnd).toBeGreaterThan(result.whole.rows);
  expect(result.whole.audit).toMatchObject({ dH: 0, dTop: 0 });
  const rows = result.whole.rows;
  const separators = result.whole.separators;

  // The window now ends at the last row: every row is still drawn, the
  // separator after the last one is not, and the layout still counts it.
  expect(result.stepsUp).toBeGreaterThan(0);
  expect(result.dropped).toMatchObject({ rows, windowEnd: rows, separators: separators - 1, separatorAfterLastRow: false });
  expect(result.dropped.audit.dH).toBeLessThan(0);

  // The window has grown past the last row again and the pane rests with the
  // end of the file on screen: still no separator, the item is still short of
  // its layout, and the file below it is drawn that much too high.
  expect(result.stepsDown).toBeGreaterThan(0);
  expect(result.backDown.windowEnd).toBeGreaterThan(rows);
  expect(result.backDown).toMatchObject({ rows, separators: separators - 1, separatorAfterLastRow: false });
  expect(result.backDown.lastRowAboveViewportBottom).toBeGreaterThanOrEqual(100);
  expect(result.backDown.audit.dH).toBe(result.dropped.audit.dH);
  expect(result.fileBelow).toEqual([result.dropped.audit.dH]);

  // Once the last row has been trimmed and appended again, all is as it was.
  expect(result.stepsUpPast).toBeGreaterThan(0);
  expect(result.past.rows).toBeLessThan(rows);
  expect(result.past.audit.dH).toBe(0);
  expect(result.healed).toMatchObject({ rows, separators, separatorAfterLastRow: true, clean: true });

  // The viewer's own validator saw it: the item, and the pane's total.
  const reports = harness.validatorErrors(page);
  expect(reports.some((text) => text.includes('reconciled item height does not match DOM height'))).toBe(true);
  expect(reports.some((text) => text.includes('sticky container height does not match computed layout'))).toBe(true);
});

test('F26 (vendor defect): the card of the row a shrinking window ends at is dropped the same way, and the validator does not see it', async ({ harness }) => {
  // Depends on it: a comment card must never depend on the default row
  // window. The row's height is measured again without its card, so the
  // layout agrees with the DOM and the validator is silent: only the card is
  // missing.
  const page = await openRowWindow(harness);
  const result = await page.evaluate(async (layout) => {
    const { H } = window;
    // Patch-only, as a file is before its contents load: no separator after the last row.
    const w = await window.rowWindow({ itemMetrics: { diffHeaderHeight: 40 }, layout, hydrate: false, annotate: true });
    const out = {};
    H.cv.scrollTo({ type: 'item', id: w.T, align: 'start' });
    await H.settle();
    out.whole = { ...w.drawn(), windowEnd: w.windowEnd() };
    const N = out.whole.rows;
    out.wholeCard = w.cardHeight(out.whole.lastRowLine);

    // Scroll up until the window ends inside the file, at a row that has a card.
    out.stepsUp = await w.walk(-1, () => w.windowEnd() < N && w.drawn().lastRowType !== 'change-deletion');
    out.dropped = { ...w.drawn(), windowEnd: w.windowEnd(), audit: w.audit() };
    const line = out.dropped.lastRowLine;
    out.droppedCard = w.cardHeight(line);

    // Scroll back down until that row is on screen.
    out.stepsDown = await w.walk(+1, () => {
      const row = H.findRow(w.T, line, 'additions');
      return !!row && H.root.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom >= 100;
    });
    await H.settle(300);
    const row = H.findRow(w.T, line, 'additions');
    out.backDown = {
      windowEnd: w.windowEnd(),
      rowOnScreen: !!row && row.getBoundingClientRect().top >= H.root.getBoundingClientRect().top,
      cardRowFollows: !!row && !!row.nextElementSibling && row.nextElementSibling.hasAttribute('data-line-annotation'),
      card: w.cardHeight(line),
      clean: H.auditClean(),
    };
    return out;
  }, LAYOUT);

  expect(result.whole.cardRowAfterLastRow).toBe(true);
  expect(result.wholeCard).toBe(30);

  expect(result.stepsUp).toBeGreaterThan(0);
  expect(result.dropped.cardRowAfterLastRow).toBe(false);
  expect(result.droppedCard).toBe(0);
  expect(result.dropped.audit).toMatchObject({ dH: 0, dTop: 0 });

  expect(result.stepsDown).toBeGreaterThan(0);
  expect(result.backDown.windowEnd).toBeGreaterThan(result.dropped.windowEnd);
  expect(result.backDown).toMatchObject({ rowOnScreen: true, cardRowFollows: false, card: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('F26: with an itemMetrics.hunkLineCount above its row count an item draws every row it shows, and the same scrolling drops nothing', async ({ harness }) => {
  // Depends on it: PierreBridge's item metrics (5000). The window is
  // then the same at every scroll position, so there is no trim.
  const page = await openRowWindow(harness);
  const result = await page.evaluate(async (layout) => {
    const { H } = window;
    const w = await window.rowWindow({ itemMetrics: { diffHeaderHeight: 40, hunkLineCount: 5000 }, layout, hydrate: true, annotate: true });
    const out = { windowEnds: new Set(), unclean: 0, shapes: new Set() };
    H.cv.scrollTo({ type: 'item', id: w.T, align: 'start' });
    await H.settle();
    out.whole = { ...w.drawn(), audit: w.audit() };
    const cards = () => [...H.annEls.keys()].filter((key) => key.startsWith('card:')).map((key) => Math.round(H.annEls.get(key).getBoundingClientRect().height));
    out.cards = cards();
    const look = () => {
      const drawn = w.drawn();
      if (!drawn) return false;
      out.windowEnds.add(String(w.windowEnd()));
      out.shapes.add(`${drawn.rows}/${drawn.separators}/${drawn.separatorAfterLastRow}/${cards().join(',')}`);
      if (!H.auditClean()) out.unclean++;
      return false;
    };
    // The same walk as the defect's: up until the file is about to leave the pane at the bottom, and back down.
    const top = H.root.scrollTop;
    const row = H.rec(w.T).instance.metrics.lineHeight;
    for (let y = top; y >= top - 30 * row; y -= row) { await w.step(y); look(); }
    for (let y = top - 30 * row; y <= top + 20 * row; y += row) { await w.step(y); look(); }
    await H.settle(300);
    look();
    return { ...out, windowEnds: [...out.windowEnds], shapes: [...out.shapes] };
  }, LAYOUT);

  expect(result.whole.separatorAfterLastRow).toBe(true);
  expect(result.whole.audit).toMatchObject({ dH: 0, dTop: 0 });
  expect(result.cards.length).toBeGreaterThan(10);
  expect(result.cards.every((height) => height === 30)).toBe(true);
  // One window, one drawing, at every step.
  expect(result.windowEnds).toEqual(['5000']);
  expect(result.shapes).toHaveLength(1);
  expect(result.unclean).toBe(0);
});

/**
 * Runs in the page. One added file of `rows` lines of plain text as the only
 * item, drawn by the viewer alone (no bridge), and what is drawn of it.
 */
const LONG_ITEM = `
  window.longItem = async ({ rows, itemMetrics, lineHeight }) => {
    const { H } = window;
    if (lineHeight) {
      // As public/css/pr.css sets them on the diff pane.
      document.getElementById('root').style.setProperty('--diffs-font-size', '12px');
      document.getElementById('root').style.setProperty('--diffs-line-height', lineHeight);
    }
    const lines = Array.from({ length: rows }, (_, i) => '+line ' + (i + 1));
    const patch = 'diff --git a/long.txt b/long.txt\\nnew file mode 100644\\n--- /dev/null\\n+++ b/long.txt\\n@@ -0,0 +1,' + rows + ' @@\\n' + lines.join('\\n') + '\\n';
    H.loadWorkload();
    H.items = [{ id: 'long.txt', type: 'diff', fileDiff: window.PierreDiffs.parsePatchFiles(patch).flatMap((p) => p.files)[0], annotations: [], version: 0 }];
    H.create({ ...H.APP_OPTIONS, itemMetrics: { diffHeaderHeight: 40, ...itemMetrics } }, H.APP_CALLBACKS);
    H.cv.setItems(H.items);
    await H.settle(300, 20000);
    const api = {};
    const rowsOf = () => [...H.host('long.txt').shadowRoot.querySelectorAll('[data-content] > [data-line]')];
    /** A drawn line's bottom edge, in the pane's scroll coordinates. */
    api.bottomOf = (line) => {
      const row = rowsOf().find((el) => Number(el.getAttribute('data-line')) === line);
      return row ? row.getBoundingClientRect().bottom - H.root.getBoundingClientRect().top + H.root.scrollTop : null;
    };
    api.drawn = () => {
      const all = rowsOf();
      const audit = H.heightAudit()[0];
      return { rows: all.length, first: Number(all[0].getAttribute('data-line')), last: Number(all[all.length - 1].getAttribute('data-line')), dH: audit.dH, dTop: audit.dTop };
    };
    api.at = async (scrollTop) => { H.root.scrollTop = scrollTop; await H.settle(400); return api.drawn(); };
    return api;
  };
`;

async function openLongItem(harness) {
  const page = await harness.open();
  await page.addScriptTag({ content: LONG_ITEM });
  return page;
}

test('F30 (vendor defect): with a row window larger than the pane, the rows after a block boundary are not drawn while the middle of the pane is before it, and the drawn rows are held against the pane\'s bottom edge', async ({ harness }) => {
  // Depends on it: PierreBridge.coverPaneWithRowWindow asks the viewer a
  // second time. Without that, a reader who scrolls a file of more than
  // 5,000 rows sees its rows stop moving for a few hundred pixels before
  // every 5,000th row and then jump, and a navigation to a line just after
  // such a row lands on rows that are not drawn.
  const page = await openLongItem(harness);
  harness.allowErrors(page, VALIDATOR);
  const result = await page.evaluate(async () => {
    const { H } = window;
    const w = await window.longItem({ rows: 5300, itemMetrics: { hunkLineCount: 5000 } });
    const out = { paneHeight: H.root.clientHeight, top: w.drawn() };
    // Where the 5,000th row ends: the boundary between the first block of rows and the second.
    const boundary = w.bottomOf(5000);
    out.boundary = boundary;
    // The boundary three quarters down the pane: a quarter of the pane shows rows of the second block.
    out.before = await w.at(Math.round(boundary - out.paneHeight * 0.75));
    out.boundaryInPaneBefore = Math.round(w.bottomOf(5000) - H.root.scrollTop);
    // The boundary a quarter down the pane: the middle of the pane is in the second block.
    out.after = await w.at(Math.round(boundary - out.paneHeight * 0.25));
    out.boundaryInPaneAfter = Math.round(w.bottomOf(5000) - H.root.scrollTop);
    // And back.
    out.again = await w.at(Math.round(boundary - out.paneHeight * 0.75));
    return out;
  });

  expect(result.paneHeight).toBe(860);
  expect(result.top).toMatchObject({ rows: 5000, first: 1, last: 5000, dH: 0, dTop: 0 });
  // A quarter of the pane is past the boundary and none of the rows there is
  // drawn; the 5,000th row is not three quarters down the pane, where the
  // layout has it, but far below that, near the pane's bottom edge.
  expect(result.before).toMatchObject({ rows: 5000, last: 5000, dH: 0 });
  expect(result.before.dTop).toBeGreaterThan(150);
  expect(result.boundaryInPaneBefore).toBeGreaterThan(645 + 150);
  // The middle of the pane has crossed: both blocks are drawn, where the layout has them.
  expect(result.after).toMatchObject({ rows: 5300, first: 1, last: 5300, dH: 0, dTop: 0 });
  expect(result.boundaryInPaneAfter).toBe(215);
  expect(result.again).toMatchObject({ rows: 5000, last: 5000 });
  expect(result.again.dTop).toBeGreaterThan(150);
});

test('F30 (vendor defect): the last rows of an item that ends a few rows after a block boundary, at the end of the pane, are never drawn', async ({ harness }) => {
  // Depends on it: the same. On the per-file renderer every row of a file is
  // drawn; here a comment on line 5,003 of a file of 5,006 rows that ends the
  // pane would have no row to be shown under.
  const page = await openLongItem(harness);
  harness.allowErrors(page, VALIDATOR);
  const result = await page.evaluate(async () => {
    const { H } = window;
    const w = await window.longItem({ rows: 5006, itemMetrics: { hunkLineCount: 5000 } });
    const out = { top: w.drawn() };
    out.atEnd = await w.at(H.root.scrollHeight);
    out.atEndScrollTop = H.root.scrollTop;
    out.maxScrollTop = H.root.scrollHeight - H.root.clientHeight;
    H.cv.scrollTo({ type: 'line', id: 'long.txt', lineNumber: 5006, side: 'additions', align: 'center', behavior: 'instant' });
    await H.settle(400);
    out.atLine = w.drawn();
    return out;
  });
  expect(result.top).toMatchObject({ rows: 5000, last: 5000 });
  expect(result.atEndScrollTop).toBe(result.maxScrollTop);
  expect(result.atEnd).toMatchObject({ rows: 5000, first: 1, last: 5000 });
  expect(result.atLine).toMatchObject({ rows: 5000, first: 1, last: 5000 });
});

test('F31 (vendor defect): rows more than 2^18 px from the viewport are measured a 64th of a pixel off when a line is 17.4 px (12 px at 1.45), so an item of 16,000 rows drawn whole is not the height the viewer computes; drawn 5,000 rows at a time it is', async ({ harness }) => {
  // Depends on it: the bridge's row window is 5,000 rows and not "every row"
  // (PierreBridge, ROWS_PER_ITEM_WINDOW). The application's lines are 12 px
  // at a line height of 1.45 (--diffs-font-size and --diffs-line-height in
  // pr.css), 17.390625 px in the layout; 16,000 of them are 278,250 px.
  test.setTimeout(120000);
  const measure = async (hunkLineCount) => {
    const page = await openLongItem(harness);
    harness.allowErrors(page, VALIDATOR);
    const result = await page.evaluate(async (count) => {
      const { H } = window;
      const w = await window.longItem({ rows: 16000, itemMetrics: { hunkLineCount: count, lineHeight: 17.390625 }, lineHeight: '1.45' });
      const column = H.host('long.txt').shadowRoot.querySelector('[data-content]');
      const heights = {};
      let sum = 0;
      for (const row of column.querySelectorAll(':scope > [data-line]')) {
        const height = row.getBoundingClientRect().height;
        heights[height] = (heights[height] || 0) + 1;
        sum += height;
      }
      return { drawn: w.drawn(), heights, measuredShort: +(column.querySelectorAll(':scope > [data-line]').length * 17.390625 - sum).toFixed(3) };
    }, hunkLineCount);
    const reports = harness.validatorErrors(page);
    await page.close();
    return { ...result, reports: reports.length };
  };

  const whole = await measure(1e9);
  expect(whole.drawn).toMatchObject({ rows: 16000, first: 1, last: 16000 });
  // Every row is 17.390625 px in the DOM (17.4 px in 64ths). The ones past
  // 262,144 px are reported as 17.375 or 17.40625.
  expect(Object.keys(whole.heights).map(Number).sort()).toEqual([17.375, 17.390625, 17.40625]);
  expect(whole.heights[17.390625]).toBeGreaterThan(15000);
  expect(whole.measuredShort).not.toBe(0);
  // The item's DOM is that much taller (or shorter) than the height the viewer computed from the measurements.
  expect(Math.abs(whole.drawn.dH)).toBeGreaterThan(1);
  expect(whole.reports).toBeGreaterThan(0);

  const windowed = await measure(5000);
  expect(windowed.drawn).toMatchObject({ rows: 5000, first: 1, last: 5000, dH: 0, dTop: 0 });
  expect(Object.keys(windowed.heights).map(Number)).toEqual([17.390625]);
  expect(windowed.reports).toBe(0);
});
