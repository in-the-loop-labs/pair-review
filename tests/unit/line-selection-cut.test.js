// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * A line selection never holds a line the diff does not show. Whatever the
 * gesture, the range is cut back to the run of shown lines that contains
 * the line where it started: nothing beyond the nearest hidden lines in the
 * direction of the drag. "Shown" is data (the hunks the bridge published
 * and the lines drawn outside them, PierreBridge._expandedRanges), the
 * question isLineInDiff and getCodeFromLines answer, so every consumer of
 * the selection sees the same range: the viewer's highlight (corrected with
 * setSelectedLines), the page's selection callbacks, and getLineSelection,
 * which the gutter's buttons read for the range of a comment or a chat.
 *
 * The bridge is the production one over the recording stand-in of the
 * viewer (tests/utils/pierre-bridge-harness.js), with the vendor's own
 * parsers. The stand-in never calls a callback, so the gestures are sent as
 * the viewer sends them (`selectionGesture` of the harness: the callbacks
 * and ranges of @pierre/diffs 1.6.4's InteractionManager, each after the
 * viewer's own wrapper made the range its selection). That the real viewer
 * draws the corrected range is a question for the browser (the hand-off of
 * this change lists it).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const {
  loadCodeViewBridge, changedFileFixture, numberedLines, selectionGesture, viewerSelectionCallback,
} = require('../utils/pierre-bridge-harness.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

let env;
let bridge;
let page;
// Patch only: new lines 117-123 and 247-253, old 117-123 and 247-252; the
// lines between are hidden behind a separator.
const A = changedFileFixture('src/a.js');

beforeEach(() => {
  env = loadCodeViewBridge(vendor);
  page = { onLineSelect: vi.fn(), onLineSelectionEnd: vi.fn() };
  bridge = new env.PierreBridge({
    root: document.getElementById('root'),
    theme: 'light',
    useWorkerPool: false,
    itemMetrics: { diffHeaderHeight: 45, lineHeight: 17 },
    ...page,
  });
});

afterEach(() => {
  bridge?.destroy();
  bridge = null;
  env.restore();
  vi.restoreAllMocks();
});

const viewer = () => env.RecordingViewer.instances[env.RecordingViewer.instances.length - 1];
const diffEntry = (fixture) => ({ id: fixture.name, kind: 'diff', patch: fixture.patch, status: 'modified' });
const contextEntry = (id, ranges) => ({ id, kind: 'context', contents: `${numberedLines(60).join('\n')}\n`, contentsSeq: 1, ranges });
const render = (...entries) => bridge.renderAll(entries, { keyPrefix: 'unit' });
/** The selections the bridge sent the viewer. */
const sent = () => viewer().calls.filter((call) => call.name === 'setSelectedLines').map((call) => call.args[0]);

/** A gesture on the line numbers of one item, as the viewer reports it (see the harness). */
const gesture = (id, points, options) => selectionGesture(viewer(), id, points, options);
const viewerCallback = (key, id, range) => viewerSelectionCallback(viewer(), key, id, range);

/** The viewer mounts a file: its instance, with the record of what the reader expanded by hand. */
function mount(id, expandedHunks = new Map()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const instance = { hunksRenderer: { expandedHunks }, getRenderedDiff: () => bridge.files.get(id).metadata };
  bridge.codeView.options.onPostRender(host, instance, 'mount', { item: { id }, element: host, instance });
  return instance;
}

describe('a drag on the line numbers is cut back at the hidden lines', () => {
  it('while the pointer is held past the separator, the viewer holds the cut range row by row (what its highlight draws)', () => {
    render(diffEntry(A));
    const to = (end) => ({ start: 121, end, side: 'additions' });
    viewerCallback('onLineSelectionStart', A.name, to(121));
    for (const end of [122, 123, 247, 248, 250, 248]) {
      viewerCallback('onLineSelectionChange', A.name, to(end));
      expect(viewer().selection, `row ${end}`).toEqual({ id: A.name, range: to(Math.min(end, 123)) });
    }
    // Back above the separator: the range follows the pointer again.
    viewerCallback('onLineSelectionChange', A.name, to(122));
    expect(viewer().selection.range).toEqual(to(122));
    // Nothing of the page runs before the release.
    expect(page.onLineSelect).not.toHaveBeenCalled();
    expect(page.onLineSelectionEnd).not.toHaveBeenCalled();
  });

  it('down across the separator: the selection ends at the last line above it, for every consumer', () => {
    render(diffEntry(A));
    const held = gesture(A.name, [121, 122, 123, 247, 248, 250]);

    const cut = { start: 121, end: 123, side: 'additions' };
    expect(held).toEqual(cut);
    expect(viewer().selection).toEqual({ id: A.name, range: cut });
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 123, side: 'RIGHT' });
    // The highlight was corrected at each row past the separator, never left wider.
    expect(sent().length).toBeGreaterThan(0);
    for (const selection of sent()) expect(selection).toEqual({ id: A.name, range: cut });
    expect(page.onLineSelectionEnd).toHaveBeenCalledWith(A.name, cut);
    expect(page.onLineSelect).toHaveBeenCalledWith(A.name, cut);
  });

  it('up across the separator: the selection ends at the first line below it', () => {
    render(diffEntry(A));
    gesture(A.name, [250, 249, 248, 247, 123, 122, 121]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 247, end: 250, side: 'RIGHT' });
    expect(page.onLineSelectionEnd).toHaveBeenCalledWith(A.name, { start: 250, end: 247, side: 'additions' });
  });

  it('from the line above the separator to the line below it: the one line it started on', () => {
    render(diffEntry(A));
    gesture(A.name, [123, 247]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 123, end: 123, side: 'RIGHT' });
    gesture(A.name, [247, 123]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 247, end: 247, side: 'RIGHT' });
  });

  it('inside one hunk nothing is cut and the bridge corrects nothing', () => {
    render(diffEntry(A));
    gesture(A.name, [118, 119, 120, 121]);
    expect(sent()).toEqual([]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 118, end: 121, side: 'RIGHT' });
    expect(page.onLineSelectionEnd).toHaveBeenCalledWith(A.name, { start: 118, end: 121, side: 'additions' });
  });

  it('into lines the reader expanded by hand: allowed up to the last expanded line, cut after it', () => {
    render(diffEntry(A));
    bridge.upgradeFileContents(A.name, A.oldFile, A.newFile);
    // With the contents: hunks 116-124 and 246-254. Three lines revealed below the first.
    mount(A.name, new Map([[1, { fromStart: 3, fromEnd: 0 }]]));
    expect(bridge.isLineInDiff(A.name, 127, 'RIGHT')).toBe(true);
    expect(bridge.isLineInDiff(A.name, 128, 'RIGHT')).toBe(false);

    gesture(A.name, [121, 124, 125, 126, 127]);
    expect(sent()).toEqual([]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 127, side: 'RIGHT' });
    gesture(A.name, [121, 127, 246, 250]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 127, side: 'RIGHT' });
  });

  it('a gap the viewer paints in full is no boundary', () => {
    render(diffEntry(A));
    bridge.upgradeFileContents(A.name, A.oldFile, A.newFile);
    // A reveal up to 241: the four lines 242-245 before the second hunk are painted in full.
    bridge.addContextRanges(A.name, [{ startLine: 125, endLine: 241 }]);
    expect(bridge.isLineInDiff(A.name, 243, 'RIGHT')).toBe(true);
    gesture(A.name, [121, 241, 243, 246, 250]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 250, side: 'RIGHT' });
  });

  it('on the deletions side (the left column of a split layout) the old numbers decide', () => {
    render(diffEntry(A));
    gesture(A.name, [[121, 'deletions'], [123, 'deletions'], [247, 'deletions'], [250, 'deletions']]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 123, side: 'LEFT' });
  });

  it('a drag that starts in one column and ends in the other is cut in the column it ends in', () => {
    render(diffEntry(A));
    // Across the separator: cut at the first hunk's last line of the additions column.
    gesture(A.name, [[121, 'deletions'], [122, 'additions'], [247, 'additions'], [250, 'additions']]);
    expect(viewer().selection.range).toEqual({ start: 121, end: 123, side: 'deletions', endSide: 'additions' });
    // Inside one hunk: nothing to cut.
    viewer().calls.length = 0;
    gesture(A.name, [[249, 'deletions'], [250, 'additions']]);
    expect(sent()).toEqual([]);
    expect(viewer().selection.range).toEqual({ start: 249, end: 250, side: 'deletions', endSide: 'additions' });
  });

  it('across columns whose numbers differ, the end is cut at its own column\'s boundary of the same run', () => {
    // Three lines added in the first hunk: old 10-14 and 50-54 are new 10-17 and 53-57.
    const patch = [
      'diff --git a/src/o.js b/src/o.js', '--- a/src/o.js', '+++ b/src/o.js',
      '@@ -10,5 +10,8 @@', ' line 10', ' line 11', '+added a', '+added b', '+added c', ' line 12', ' line 13', ' line 14',
      '@@ -50,5 +53,5 @@', ' line 50', ' line 51', '-line 52', '+changed 52', ' line 53', ' line 54',
      '',
    ].join('\n');
    render({ id: 'src/o.js', kind: 'diff', patch, status: 'modified' });
    // Down, from the old column to the new: the first run ends at new 17.
    gesture('src/o.js', [[12, 'deletions'], [16, 'additions'], [17, 'additions'], [55, 'additions']]);
    expect(viewer().selection.range).toEqual({ start: 12, end: 17, side: 'deletions', endSide: 'additions' });
    // Up, from the new column to the old: the second run begins at old 50,
    // an unchanged line, named in the start's numbers (new 53): left as old
    // 50 under the start's side it would name new 50, a hidden line.
    gesture('src/o.js', [[55, 'additions'], [50, 'deletions'], [12, 'deletions']]);
    expect(viewer().selection.range).toEqual({ start: 55, end: 53, side: 'additions' });
    expect(bridge.getLineSelection('src/o.js')).toEqual({ start: 53, end: 55, side: 'RIGHT' });
  });

  describe('a cut end is a row the viewer can place the gutter\'s buttons on, in the start\'s numbers', () => {
    // Old 10-14 and 50-54 are new 10-16 and 52-56: old 12 is replaced by
    // three lines (new 12-14), old 52 by one (new 54).
    const D = 'src/d.js';
    const dPatch = [
      `diff --git a/${D} b/${D}`, `--- a/${D}`, `+++ b/${D}`,
      '@@ -10,5 +10,7 @@', ' line 10', ' line 11', '-line 12', '+new a', '+new b', '+new c', ' line 13', ' line 14',
      '@@ -50,5 +52,5 @@', ' line 50', ' line 51', '-line 52', '+changed 52', ' line 53', ' line 54',
      '',
    ].join('\n');
    const renderD = () => render({ id: D, kind: 'diff', patch: dPatch, status: 'modified' });
    const range = () => viewer().selection.range;

    it('unified: a drag down to a deleted row past the separator ends on the last row above it, an additions row', () => {
      renderD();
      // From an added or unchanged row: the range is on the additions side alone.
      gesture(D, [[13, 'additions'], [16, 'additions'], [52, 'deletions']]);
      expect(range()).toEqual({ start: 13, end: 16, side: 'additions' });
      expect(bridge.getLineSelection(D)).toEqual({ start: 13, end: 16, side: 'RIGHT' });
      // From a deleted row: the end is the additions row of old 14 (new 16),
      // as the viewer reports a release on it.
      gesture(D, [[12, 'deletions'], [52, 'deletions']]);
      expect(range()).toEqual({ start: 12, end: 16, side: 'deletions', endSide: 'additions' });
      // A shift-click on the deleted row past the separator.
      gesture(D, [[52, 'deletions']], { extendFrom: { start: 13, end: 14, side: 'additions' } });
      expect(range()).toEqual({ start: 13, end: 16, side: 'additions' });
    });

    it('unified: a drag up past the separator ends on its first row below, named on the start\'s side', () => {
      renderD();
      gesture(D, [[55, 'additions'], [53, 'additions'], [12, 'deletions']]);
      expect(range()).toEqual({ start: 55, end: 52, side: 'additions' });
      expect(bridge.getLineSelection(D)).toEqual({ start: 52, end: 55, side: 'RIGHT' });
      // From the deleted row 52: the top row old 50 (new 52) keeps the old
      // number, whichever row the pointer is let go on (the bottom row,
      // where the buttons go, is the deleted row).
      gesture(D, [[52, 'deletions'], [52, 'additions'], [12, 'additions']]);
      expect(range()).toEqual({ start: 52, end: 50, side: 'deletions' });
      expect(bridge.getLineSelection(D)).toEqual({ start: 50, end: 52, side: 'LEFT' });
      gesture(D, [[52, 'deletions'], [12, 'deletions']]);
      expect(range()).toEqual({ start: 52, end: 50, side: 'deletions' });
    });

    it('split: the end is the boundary row of the column the drag started in', () => {
      bridge.setDiffStyle('split');
      renderD();
      gesture(D, [[12, 'deletions'], [52, 'deletions']]);
      expect(range()).toEqual({ start: 12, end: 14, side: 'deletions' });
      gesture(D, [[13, 'additions'], [52, 'deletions']]);
      expect(range()).toEqual({ start: 13, end: 16, side: 'additions' });
      expect(bridge.getLineSelection(D)).toEqual({ start: 13, end: 16, side: 'RIGHT' });
      gesture(D, [[12, 'deletions'], [55, 'additions']]);
      expect(range()).toEqual({ start: 12, end: 14, side: 'deletions' });
      expect(bridge.getLineSelection(D)).toEqual({ start: 12, end: 14, side: 'LEFT' });
    });

    it('_unchangedTwin: the other side\'s number of an unchanged line, null for a changed one', () => {
      renderD();
      const metadata = bridge.files.get(D).metadata;
      const twin = (line, side) => env.PierreBridge._unchangedTwin(metadata, line, side);
      // Before, inside, between and after the hunks.
      expect([5, 10, 11, 13, 14, 30, 50, 51, 53, 54, 90].map((line) => twin(line, 'deletions')))
        .toEqual([5, 10, 11, 15, 16, 32, 52, 53, 55, 56, 92]);
      expect([5, 15, 16, 32, 52, 55, 92].map((line) => twin(line, 'additions'))).toEqual([5, 13, 14, 30, 50, 53, 90]);
      expect(twin(12, 'deletions')).toBeNull();
      expect(twin(52, 'deletions')).toBeNull();
      expect([12, 13, 14, 54].map((line) => twin(line, 'additions'))).toEqual([null, null, null, null]);
    });
  });

  it('across columns in a diff whose runs do not pair up (hunks without context lines): the one line the drag started on', () => {
    // Neither GitHub's patches (3 lines of context) nor the local diff (25)
    // look like this; the answer is the safe one. The first hunk has no
    // old line, so the old column has one run and the new column two.
    const patch = [
      'diff --git a/src/z.js b/src/z.js', '--- a/src/z.js', '+++ b/src/z.js',
      '@@ -10,0 +11,2 @@', '+added a', '+added b',
      '@@ -50 +52 @@', '-line 50', '+changed 50',
      '',
    ].join('\n');
    render({ id: 'src/z.js', kind: 'diff', patch, status: 'modified' });
    gesture('src/z.js', [[11, 'additions'], [12, 'additions'], [50, 'deletions']]);
    expect(viewer().selection.range).toEqual({ start: 11, end: 11, side: 'additions' });
  });

  it('a shift-click that extends a selection across the separator is cut at the press', () => {
    render(diffEntry(A));
    // The press alone, before the release (InteractionManager's shift
    // branch: the range from the selection's start to the clicked row).
    viewer().selection = { id: A.name, range: { start: 121, end: 122, side: 'additions' } };
    viewerCallback('onLineSelectionStart', A.name, { start: 121, end: 250, side: 'additions' });
    expect(viewer().selection.range).toEqual({ start: 121, end: 123, side: 'additions' });

    gesture(A.name, [250], { extendFrom: { start: 121, end: 122, side: 'additions' } });
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 123, side: 'RIGHT' });
    expect(page.onLineSelectionEnd).toHaveBeenCalledWith(A.name, { start: 121, end: 123, side: 'additions' });
  });

  it('a click that ends a single-line selection ends with no selection, and nothing is cut', () => {
    render(diffEntry(A));
    gesture(A.name, [121]);
    viewer().calls.length = 0;
    // The viewer's "pendingSingleLineUnselect": the release reports null.
    viewerCallback('onLineSelectionEnd', A.name, null);
    viewerCallback('onLineSelected', A.name, null);
    expect(sent()).toEqual([]);
    expect(bridge.getLineSelection(A.name)).toBeNull();
    expect(page.onLineSelect).toHaveBeenLastCalledWith(A.name, null);
  });
});

describe('a context file', () => {
  it('with a hidden gap between its ranges: a drag is cut at the gap', () => {
    render(contextEntry('ctx/c.js', [{ startLine: 1, endLine: 10 }, { startLine: 40, endLine: 50 }]));
    gesture('ctx/c.js', [5, 10, 40, 45]);
    expect(bridge.getLineSelection('ctx/c.js')).toEqual({ start: 5, end: 10, side: 'RIGHT' });
  });

  it('shown whole: nothing to cut', () => {
    render(contextEntry('ctx/c.js', [{ startLine: 1, endLine: 60 }]));
    gesture('ctx/c.js', [5, 30, 59]);
    expect(sent()).toEqual([]);
    expect(bridge.getLineSelection('ctx/c.js')).toEqual({ start: 5, end: 59, side: 'RIGHT' });
  });
});

describe('while a mounted file still draws the diff before the one it was given (F28)', () => {
  // The viewer goes on drawing a file's present diff until the new one has
  // been highlighted: after a content upgrade, after a reveal that loads the
  // contents first. The new diff shows more; the cut is made against what is
  // drawn as well, so that no row on the far side of a separator that is
  // still on screen is selected, and no cut end is a row that is not drawn.

  it('a content upgrade awaiting its highlight: cut at the patch\'s run, and at the new diff\'s once that is drawn', () => {
    render(diffEntry(A));
    const patch = bridge.files.get(A.name).metadata;
    const instance = mount(A.name);
    instance.getRenderedDiff = () => patch;
    bridge.upgradeFileContents(A.name, A.oldFile, A.newFile);
    // The new diff shows 124 (hunks 116-124 and 246-254); the screen does not yet.
    expect(bridge.isLineInDiff(A.name, 124, 'RIGHT')).toBe(true);

    gesture(A.name, [121, 122, 123, 247, 250]);
    expect(viewer().selection).toEqual({ id: A.name, range: { start: 121, end: 123, side: 'additions' } });
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 123, side: 'RIGHT' });
    expect(page.onLineSelect).toHaveBeenLastCalledWith(A.name, { start: 121, end: 123, side: 'additions' });

    // Drawn: the next drag reaches the new diff's last line above the separator.
    instance.getRenderedDiff = () => bridge.files.get(A.name).metadata;
    gesture(A.name, [121, 124, 250]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 124, side: 'RIGHT' });
  });

  it('getLineSelection answers what is drawn of a selection the viewer holds past it', () => {
    render(diffEntry(A));
    const patch = bridge.files.get(A.name).metadata;
    const instance = mount(A.name);
    instance.getRenderedDiff = () => patch;
    bridge.upgradeFileContents(A.name, A.oldFile, A.newFile);
    viewer().selection = { id: A.name, range: { start: 121, end: 124, side: 'additions' } };
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 123, side: 'RIGHT' });
  });

  it('a reveal awaiting its highlight after the reader expanded lines by hand: cut at the expanded lines still drawn', () => {
    render(diffEntry(A));
    bridge.upgradeFileContents(A.name, A.oldFile, A.newFile);
    // Three lines revealed by hand below the first hunk (125-127), on the diff that is drawn.
    const instance = mount(A.name, new Map([[1, { fromStart: 3, fromEnd: 0 }]]));
    const drawn = bridge.files.get(A.name).metadata;
    instance.getRenderedDiff = () => drawn;
    // A reveal of the whole gap: the new diff shows 116-254 as one run. The
    // hand expansion is kept for the diff on screen (_retireExpansions).
    bridge.addContextRanges(A.name, [{ startLine: 125, endLine: 241 }]);
    expect(bridge.files.get(A.name).metadata).not.toBe(drawn);
    expect(bridge.isLineInDiff(A.name, 200, 'RIGHT')).toBe(true);

    gesture(A.name, [121, 126, 127, 247, 250]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 127, side: 'RIGHT' });
  });

  it('a file that is not mounted is cut against its item only', () => {
    render(diffEntry(A));
    bridge.upgradeFileContents(A.name, A.oldFile, A.newFile);
    viewer().selection = { id: A.name, range: { start: 121, end: 250, side: 'additions' } };
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 124, side: 'RIGHT' });
  });
});

describe('a selection the bridge sends or keeps', () => {
  it('selectLines (the drag from the gutter\'s buttons) is cut from the line the drag started on', () => {
    render(diffEntry(A));
    bridge.selectLines(A.name, 123, 247, 'RIGHT');
    expect(viewer().last('setSelectedLines').args[0]).toEqual({ id: A.name, range: { start: 123, end: 123, side: 'additions' } });
    bridge.selectLines(A.name, 247, 123, 'RIGHT');
    expect(viewer().last('setSelectedLines').args[0]).toEqual({ id: A.name, range: { start: 247, end: 247, side: 'additions' } });
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 247, end: 247, side: 'RIGHT' });
  });

  it('selectLines from a line the diff does not show selects nothing', () => {
    render(diffEntry(A));
    bridge.selectLines(A.name, 121, 122, 'RIGHT');
    viewer().calls.length = 0;
    bridge.selectLines(A.name, 200, 250, 'RIGHT');
    expect(sent()).toEqual([]);
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 121, end: 122, side: 'RIGHT' });
  });

  it('a list write that puts back a selection over lines the new diff hides puts back the shown part', () => {
    // One hunk of lines 100-130; then the file is drawn again with a diff
    // that hides 111-119 (a whitespace toggle gives the file another patch).
    const patch = (hunks) => [
      'diff --git a/src/w.js b/src/w.js', '--- a/src/w.js', '+++ b/src/w.js',
      ...hunks.flatMap(([from, to]) => [`@@ -${from},${to - from + 1} +${from},${to - from + 1} @@`,
        ...Array.from({ length: to - from + 1 }, (_, i) => ` line ${from + i}`)]),
      '',
    ].join('\n');
    const entry = (hunks) => ({ id: 'src/w.js', kind: 'diff', patch: patch(hunks), status: 'modified' });
    render(entry([[100, 130]]));
    gesture('src/w.js', [105, 115, 125]);
    expect(bridge.getLineSelection('src/w.js')).toEqual({ start: 105, end: 125, side: 'RIGHT' });
    viewer().calls.length = 0;

    render(entry([[100, 110], [120, 130]]));
    expect(sent()).toEqual([{ id: 'src/w.js', range: { start: 105, end: 110, side: 'additions' } }]);
    expect(bridge.getLineSelection('src/w.js')).toEqual({ start: 105, end: 110, side: 'RIGHT' });
  });

  it('a publish that hides lines under the selection cuts the selection the viewer keeps', () => {
    render(contextEntry('ctx/c.js', [{ startLine: 1, endLine: 50 }]));
    gesture('ctx/c.js', [5, 30, 45]);
    expect(bridge.getLineSelection('ctx/c.js')).toEqual({ start: 5, end: 45, side: 'RIGHT' });
    viewer().calls.length = 0;

    // The file's stored ranges change (the same list: a publish, not a list write).
    const outcome = bridge.reconcile([contextEntry('ctx/c.js', [{ startLine: 1, endLine: 10 }, { startLine: 40, endLine: 50 }])]);
    expect(outcome.listWritten).toBe(false);
    expect(viewer().count('updateItem')).toBe(1);
    expect(viewer().selection).toEqual({ id: 'ctx/c.js', range: { start: 5, end: 10, side: 'additions' } });
    expect(bridge.getLineSelection('ctx/c.js')).toEqual({ start: 5, end: 10, side: 'RIGHT' });
  });

  it('getLineSelection answers the shown part of a selection the viewer holds over hidden lines', () => {
    // As the viewer holds one between its own wrapper and the bridge's
    // correction, or after a re-render it applied without telling anyone
    // (CodeView syncSelection).
    render(diffEntry(A));
    viewer().selection = { id: A.name, range: { start: 250, end: 121, side: 'additions' } };
    expect(bridge.getLineSelection(A.name)).toEqual({ start: 247, end: 250, side: 'RIGHT' });
    viewer().selection = { id: A.name, range: { start: 200, end: 250, side: 'additions' } };
    expect(bridge.getLineSelection(A.name)).toBeNull();
  });
});
