// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * The text of a suggestion block: PierreBridge.getCodeFromLines and its one
 * caller, CommentManager.insertSuggestionBlock (the form's suggestion
 * button). Applied on GitHub, a suggestion replaces EVERY line of the
 * comment's range with the block, so the block must hold every line of the
 * range as the file has it: one line break between two lines, none at the
 * end (the vendor's parsed lines end in their line break, measured in
 * `vendor-line-endings-probe.txt` of the review evidence), and the lines
 * the file shows outside its hunks (a gap small enough for the viewer to
 * paint in full, lines the reader expanded) read from the file's contents.
 * When a line of the range has no text (it is not shown, or its contents
 * are not loaded) there is no block: the bridge answers null and the
 * button refuses, visibly, instead of inserting a block that would delete
 * the missing lines.
 *
 * The bridge is the production one over the recording stand-in of the
 * viewer (tests/utils/pierre-bridge-harness.js), with the vendor's own
 * parsers; the lines are as the vendor produces them.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { loadCodeViewBridge, changedFileFixture } = require('../utils/pierre-bridge-harness.js');
const { CommentManager } = require('../../public/js/modules/comment-manager.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

let env;
let bridge;
const A = changedFileFixture('src/a.js');

beforeEach(() => {
  // A window of its own per test (closed after it, with any frame the
  // bridge queued); `window` and `document` are that window's meanwhile.
  env = loadCodeViewBridge(vendor);
  bridge = new env.PierreBridge({
    root: document.getElementById('root'),
    theme: 'light',
    useWorkerPool: false,
    itemMetrics: { diffHeaderHeight: 45, lineHeight: 17 },
  });
});

afterEach(() => {
  bridge?.destroy();
  bridge = null;
  env.restore();
  vi.restoreAllMocks();
});

const render = (...entries) => bridge.renderAll(entries, { keyPrefix: 'unit' });
const diffEntry = (fixture) => ({ id: fixture.name, kind: 'diff', patch: fixture.patch, status: 'modified' });
/** Lines `from..to` of a fixture's new (or old) file, as the block must hold them. */
const text = (file, from, to) => file.contents.split('\n').slice(from - 1, to).join('\n');

/** The viewer mounts a file: its instance, with the record of what the reader expanded by hand. */
function mount(id, expandedHunks = new Map()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const instance = { hunksRenderer: { expandedHunks }, getRenderedDiff: () => bridge.files.get(id).metadata };
  bridge.codeView.options.onPostRender(host, instance, 'mount', { item: { id }, element: host, instance });
  return instance;
}

describe('getCodeFromLines on a changed file', () => {
  it('a range across a gap the viewer paints in full holds the gap\'s lines, from the contents', () => {
    render(diffEntry(A));
    expect(bridge.upgradeFileContents(A.name, A.oldFile, A.newFile)).toBe(true);
    // Shown: the patch's first hunk and a reveal up to 241, then the second
    // hunk; the few lines between them (fewer than the viewer's threshold)
    // are painted in full.
    bridge.addContextRanges(A.name, [{ startLine: 124, endLine: 241 }]);
    const hunks = bridge.files.get(A.name).metadata.hunks;
    expect(hunks.some((h) => h.additionStart <= 244 && 244 < h.additionStart + h.additionCount)).toBe(false);
    expect(bridge.isLineVisible(A.name, 244, 'RIGHT')).toBe(true);

    expect(bridge.getCodeFromLines(A.name, 240, 248, 'RIGHT')).toBe(text(A.newFile, 240, 248));
    expect(bridge.getCodeFromLines(A.name, 243, 245, 'RIGHT')).toBe('line 243\nline 244\nline 245');
  });

  it('a range across lines the reader expanded by hand holds them, on either side', () => {
    render(diffEntry(A));
    bridge.upgradeFileContents(A.name, A.oldFile, A.newFile);
    // The gap before the second hunk (index 1), 3 lines revealed from its top.
    const [first] = bridge.files.get(A.name).metadata.hunks;
    const end = first.additionStart + first.additionCount - 1;
    const oldEnd = first.deletionStart + first.deletionCount - 1;
    mount(A.name, new Map([[1, { fromStart: 3, fromEnd: 0 }]]));
    expect(bridge.isLineVisible(A.name, end + 3, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible(A.name, end + 4, 'RIGHT')).toBe(false);
    expect(bridge.isLineVisible(A.name, oldEnd + 3, 'LEFT')).toBe(true);

    expect(bridge.getCodeFromLines(A.name, 119, end + 3, 'RIGHT')).toBe(text(A.newFile, 119, end + 3));
    expect(bridge.getCodeFromLines(A.name, 119, oldEnd + 3, 'LEFT')).toBe(text(A.oldFile, 119, oldEnd + 3));
    // One line further is not shown: no block.
    expect(bridge.getCodeFromLines(A.name, 119, end + 4, 'RIGHT')).toBeNull();
  });

  it('a range across a gap of a file whose contents are not loaded has no block', () => {
    // Patch only: the viewer draws a separator between the hunks, not their lines.
    render(diffEntry(A));
    expect(bridge.getCodeFromLines(A.name, 121, 248, 'RIGHT')).toBeNull();
    expect(bridge.getCodeFromLines(A.name, 121, 123, 'RIGHT')).toBe('line 121\nline 122\nline 123');
  });

  it('CRLF lines are answered without their line ending', () => {
    const crlf = { name: 'src/w.js', patch: A.patch.replaceAll('src/a.js', 'src/w.js').replace(/\n/g, '\r\n') };
    render(diffEntry(crlf));
    expect(bridge.files.get('src/w.js').metadata.additionLines[0]).toBe('line 117\r\n');
    expect(bridge.getCodeFromLines('src/w.js', 119, 121, 'RIGHT')).toBe('line 119\nchanged 120\nline 121');
  });

  it('a range given backwards, or of no line, has no block', () => {
    render(diffEntry(A));
    expect(bridge.getCodeFromLines(A.name, 121, 119, 'RIGHT')).toBeNull();
    expect(bridge.getCodeFromLines(A.name, Number.NaN, 119, 'RIGHT')).toBeNull();
  });
});

describe('the suggestion button', () => {
  /** A comment form's textarea for a range of a file, as PierreAnnotations.renderForm builds it. */
  function textarea(file, line, lineEnd, side = 'RIGHT') {
    const element = document.createElement('textarea');
    element.className = 'comment-textarea';
    Object.assign(element.dataset, { file, line: String(line), lineEnd: String(lineEnd), side });
    document.body.appendChild(element);
    return element;
  }

  function commentManager() {
    return new CommentManager({ pierreBridge: bridge });
  }

  it('inserts the block of every line of the range', () => {
    render(diffEntry(A));
    const input = textarea(A.name, 119, 121);
    const button = document.createElement('button');
    commentManager().insertSuggestionBlock(input, button);
    expect(input.value).toBe('```suggestion\nline 119\nchanged 120\nline 121\n```');
    expect(button.disabled).toBe(true);
  });

  it('refuses, with a warning the reader sees, when a line of the range has no text; what was typed is kept', () => {
    render(diffEntry(A));
    window.toast = { showWarning: vi.fn() };
    const input = textarea(A.name, 122, 124);
    input.value = 'typed';
    const button = document.createElement('button');

    commentManager().insertSuggestionBlock(input, button);

    expect(input.value).toBe('typed');
    expect(button.disabled).toBe(false);
    expect(window.toast.showWarning).toHaveBeenCalledTimes(1);
    expect(window.toast.showWarning.mock.calls[0][0]).toBe(
      'Cannot insert a suggestion for lines 122-124: the diff does not show the text of every line of the range. Expand the hidden lines first.'
    );
  });
});
