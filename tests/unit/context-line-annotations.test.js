// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
/**
 * Annotations on the lines of a context file, on the virtualized viewer's
 * bridge (plans/codeview-virtualized-diff.md, phase 6; plan 3.15.6).
 *
 * A context file is an item of the viewer like a changed file, so
 * `pierreBridge.files.has(path)` is true for it and every consumer takes the
 * annotation path it has for changed files. What differs is decided in the
 * bridge, and these tests pin it from the consumers' side, with the
 * production PRManager methods and the production bridge:
 *
 *   - a context file is one-sided: every annotation is published on the
 *     additions side, and keeps the side it was stored with in its data;
 *   - a line of a context file has no position in the diff;
 *   - a comment reload is one change of the diff, not one per file.
 *
 * The viewer is the recording stub of tests/utils/codeview-bridge-harness.js:
 * what it draws is tested in a browser (tests/contract/bridge, N5).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { loadCodeViewBridge, numberedLines, changedFileFixture } = require('../utils/codeview-bridge-harness.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

const CONTEXT = 'ctx/c.js';
const A = changedFileFixture('src/a.js');

let env;
let bridge;
let manager;
let HunkSummaryRenderer;
let SuggestionManager;

beforeEach(() => {
  env = loadCodeViewBridge(vendor);
  // After the window exists: the page's modules read it when they load.
  const { makePageManager } = require('../utils/page-manager.js');
  ({ HunkSummaryRenderer } = require('../../public/js/modules/hunk-summary-renderer.js'));
  ({ SuggestionManager } = require('../../public/js/modules/suggestion-manager.js'));
  bridge = new env.PierreCodeViewBridge({
    root: env.window.document.getElementById('root'),
    theme: 'light',
    useWorkerPool: false,
    itemMetrics: { diffHeaderHeight: 53, lineHeight: 17 },
  });
  bridge.renderAll([
    { id: A.name, kind: 'diff', patch: A.patch, status: 'modified' },
    {
      id: CONTEXT,
      kind: 'context',
      contents: `${numberedLines(400).join('\n')}\n`,
      contentsSeq: 1,
      ranges: [{ startLine: 100, endLine: 120 }],
    },
  ]);
  manager = makePageManager({
    pierreBridge: bridge,
    _diffEngine: 'codeview',
    changedFilesByPath: new Map([[A.name, { file: A.name, patch: A.patch }]]),
    contextFiles: [{ id: 5, file: CONTEXT, line_start: 100, line_end: 120 }],
  });
  bridge.codeView.calls.length = 0;
});

afterEach(() => {
  bridge?.destroy();
  bridge = null;
  env.restore();
});

const published = (file) => bridge.codeView.getItem(file).annotations;
const flushes = () => bridge.codeView.count('render');

describe('a comment form on a context line', () => {
  it('is an annotation of the context item, on the additions side, with side RIGHT and no diff position in its data', () => {
    // What the gutter's comment button does (the onCommentClick handler of
    // the PRManager constructor): the position is asked of the bridge.
    const position = bridge.getDiffPosition(CONTEXT, 105, 'RIGHT');
    expect(position).toBeNull();
    manager.showCommentForm(null, 105, CONTEXT, position, null, 'RIGHT');

    const form = bridge.getAnnotations(CONTEXT, 'comment-form');
    expect(form).toHaveLength(1);
    expect(form[0]).toMatchObject({ lineNumber: 105, side: 'additions' });
    expect(form[0].metadata.data).toMatchObject({
      lineStart: 105, lineEnd: 105, fileName: CONTEXT, diffPosition: null, side: 'RIGHT',
    });
    // It is what the viewer was given for the item, after the file's zone.
    expect(published(CONTEXT).map((a) => a.metadata.type)).toEqual(['file-comments', 'comment-form']);
  });

  it('a range is anchored on its last line and keeps its first line in the data', () => {
    manager.showCommentForm(null, 104, CONTEXT, null, 108, 'RIGHT');
    const [form] = bridge.getAnnotations(CONTEXT, 'comment-form');
    expect(form).toMatchObject({ lineNumber: 108, side: 'additions' });
    expect(form.metadata.data).toMatchObject({ lineStart: 104, lineEnd: 108, side: 'RIGHT', diffPosition: null });
  });

  it('on a changed file the same call keeps the side it was given and carries the diff position', () => {
    const position = bridge.getDiffPosition(A.name, 120, 'LEFT');
    expect(position).toBeGreaterThan(0);
    manager.showCommentForm(null, 120, A.name, position, null, 'LEFT');
    const [form] = bridge.getAnnotations(A.name, 'comment-form');
    expect(form).toMatchObject({ lineNumber: 120, side: 'deletions' });
    expect(form.metadata.data).toMatchObject({ side: 'LEFT', diffPosition: position });
  });
});

describe('a comment reload with a comment on a context line', () => {
  const comments = [
    { id: 1, file: A.name, line_start: 120, line_end: 120, side: 'RIGHT', status: 'active', body: 'on the changed file' },
    // Made when the file was in the diff, on the old side; the file has left the diff since.
    { id: 2, file: CONTEXT, line_start: 110, line_end: 110, side: 'LEFT', status: 'active', body: 'stored LEFT' },
    { id: 3, file: CONTEXT, line_start: 115, line_end: 116, side: 'RIGHT', status: 'active', body: 'stored RIGHT' },
  ];

  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ comments }) }));
    manager.ensureLinesVisible = vi.fn(async () => {});
    manager.applyPostedCommentVisibility = vi.fn();
    manager.updateCommentCount = vi.fn();
  });
  afterEach(() => {
    delete global.fetch;
  });

  it('draws every comment under its line in its file: a context file takes both sides on its one side, the stored side stays in the data', async () => {
    expect(await manager._loadUserComments()).toBe(true);

    const onContext = bridge.getAnnotations(CONTEXT, 'comment');
    expect(onContext.map((a) => [a.metadata.id, a.lineNumber, a.side])).toEqual([
      ['comment-2', 110, 'additions'],
      ['comment-3', 115, 'additions'],
    ]);
    expect(onContext.map((a) => a.metadata.data.side)).toEqual(['LEFT', 'RIGHT']);
    // The data object is the cache's own: an edit patches what the card shows.
    expect(onContext[0].metadata.data).toBe(manager.userComments[1]);
    expect(bridge.getAnnotations(A.name, 'comment').map((a) => [a.metadata.id, a.side])).toEqual([['comment-1', 'additions']]);
    // The lines were asked for with their stored sides (the oracle ignores the side of a context file).
    expect(manager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: A.name, line_start: 120, line_end: 120, side: 'RIGHT' },
      { file: CONTEXT, line_start: 110, line_end: 110, side: 'LEFT' },
      { file: CONTEXT, line_start: 115, line_end: 116, side: 'RIGHT' },
    ]);
  });

  it('is one change of the diff: the old cards go and the new ones come with a single draw', async () => {
    await manager._loadUserComments();
    bridge.codeView.calls.length = 0;

    // The same comments again: two files lose and regain their cards.
    await manager._loadUserComments();
    expect(flushes()).toBe(1);
    // Nothing was published with a file's comments missing in between.
    const updates = bridge.codeView.calls.filter((call) => call.name === 'updateItem').map((call) => call.args[0]);
    const lastOf = (file) => [...updates].reverse().find((item) => item.id === file);
    expect(lastOf(CONTEXT).annotations.filter((a) => a.metadata.type === 'comment')).toHaveLength(2);
    expect(lastOf(A.name).annotations.filter((a) => a.metadata.type === 'comment')).toHaveLength(1);
  });

  it('a comment whose file the pane no longer holds is skipped, and the others are drawn', async () => {
    comments.push({ id: 4, file: 'gone/file.js', line_start: 3, line_end: 3, side: 'RIGHT', status: 'active', body: 'no such file' });
    try {
      manager.findFileElement = () => null;
      expect(await manager._loadUserComments()).toBe(true);
      expect(bridge.getAnnotations(CONTEXT, 'comment')).toHaveLength(2);
      expect(bridge.files.has('gone/file.js')).toBe(false);
    } finally {
      comments.pop();
    }
  });
});

describe('clearing what is drawn on every file of the pane', () => {
  it('the suggestions of both kinds of file go in one draw, and comments stay', () => {
    bridge.addAnnotations(A.name, [{ lineNumber: 120, side: 'RIGHT', type: 'suggestion', id: 'suggestion-1', data: { id: 1 } }]);
    bridge.addAnnotations(CONTEXT, [
      { lineNumber: 110, side: 'RIGHT', type: 'suggestion', id: 'suggestion-2', data: { id: 2 } },
      { lineNumber: 112, side: 'RIGHT', type: 'comment', id: 'comment-9', data: { id: 9 } },
    ]);
    bridge.codeView.calls.length = 0;

    const suggestions = Object.create(SuggestionManager.prototype);
    suggestions.prManager = manager;
    suggestions._removeRenderedSuggestions();

    expect(bridge.getAnnotations(A.name, 'suggestion')).toEqual([]);
    expect(bridge.getAnnotations(CONTEXT, 'suggestion')).toEqual([]);
    expect(bridge.getAnnotations(CONTEXT, 'comment')).toHaveLength(1);
    expect(flushes()).toBe(1);
  });

  it('the hunk summaries of a render are taken off in one draw', () => {
    const renderer = new HunkSummaryRenderer(manager);
    renderer.renderPierre(A.name, { lineNumber: 117, side: 'RIGHT' }, { content_hash: 'h1', summary_text: 'First hunk.' });
    renderer.renderPierre(A.name, { lineNumber: 247, side: 'RIGHT' }, { content_hash: 'h2', summary_text: 'Second hunk.' });
    expect(bridge.getAnnotations(A.name, 'hunk-summary')).toHaveLength(2);
    bridge.codeView.calls.length = 0;

    renderer.reset();
    expect(bridge.getAnnotations(A.name, 'hunk-summary')).toEqual([]);
    expect(flushes()).toBe(1);

    // Nothing mounted: nothing asked of the bridge.
    bridge.codeView.calls.length = 0;
    renderer.reset();
    expect(bridge.codeView.calls).toEqual([]);
  });
});

describe('revealing a line of a context file', () => {
  it('ensureLinesVisible adds a range to the context item and asks for no contents', async () => {
    manager._ensurePierreContentUpgrade = vi.fn(manager._ensurePierreContentUpgrade.bind(manager));
    manager._getOrStartPierreContentUpgrade = vi.fn();
    manager._materializeDeferredDiff = vi.fn(async () => true);
    manager.ensureFileBodyRendered = vi.fn(async () => null);
    expect(bridge.isLineVisible(CONTEXT, 200, 'RIGHT')).toBe(false);

    await manager.ensureLinesVisible([{ file: CONTEXT, line_start: 200, line_end: 202, side: 'LEFT' }]);

    // The stored side is not a side of the file: line 200 is line 200.
    expect(bridge.isLineVisible(CONTEXT, 200, 'RIGHT')).toBe(true);
    expect(bridge.isLineVisible(CONTEXT, 202, 'LEFT')).toBe(true);
    // A context file holds its whole contents: no upgrade is started for it.
    expect(manager._getOrStartPierreContentUpgrade).not.toHaveBeenCalled();
    // The file's stored range is still shown.
    expect(bridge.isLineVisible(CONTEXT, 100, 'RIGHT')).toBe(true);
  });
});
