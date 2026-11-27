// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * A collapsed file still has its diff. Viewed and generated files start
 * collapsed, and the reader collapses others; what is on their lines (an
 * external review thread, a tour stop, a comment) belongs on those lines
 * when the file is opened. The bridge hides every annotation of a collapsed
 * file and shows them again on expand; the question "is this line one the
 * file's diff shows" is answered from data and does not depend on the
 * collapse (PierreBridge.isLineInDiff). `isLineVisible` keeps answering
 * false while the file is collapsed: its callers rely on that.
 *
 * The page manager and its bridge are production code wired by the page's
 * own _createBridge (tests/utils/page-bridge.js); a file is collapsed the
 * way the page collapses it, through PRManager.setFileCollapsed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { makePageWithBridge, restorePageBridges } = require('../utils/page-bridge.js');
const { ExternalCommentManager } = require('../../public/js/modules/external-comment-manager.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

const FILE = 'src/app.js';
const CONTEXT = 'lib/ctx.js';

/** A patch of FILE whose hunks show lines 1 to 20 and 200 to 210, line 10 changed. */
function patch() {
  const body = ['@@ -1,20 +1,20 @@'];
  for (let n = 1; n <= 20; n++) {
    if (n === 10) body.push('-old 10', '+new 10');
    else body.push(` line ${n}`);
  }
  body.push('@@ -200,11 +200,11 @@');
  for (let n = 200; n <= 210; n++) body.push(` line ${n}`);
  return [`diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`, ...body, ''].join('\n');
}

/** 300 numbered lines, as a file's contents. */
const contents = Array.from({ length: 300 }, (_, i) => `ctx ${i + 1}`).join('\n') + '\n';

let page;
beforeEach(() => {
  page = makePageWithBridge(vendor, {
    files: [{ name: FILE, patch: patch() }],
    contextFiles: [{ name: CONTEXT, contents, endLine: 40 }],
    overrides: { currentPR: { id: 3 } },
  });
  window.prManager = page.manager;
  // What reaches the server: a file's contents for a reveal.
  vi.spyOn(page.manager, '_ensurePierreContentUpgrade').mockImplementation(async () => false);
});

afterEach(() => {
  restorePageBridges();
  delete window.prManager;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('PierreBridge.isLineInDiff', () => {
  it('answers for a collapsed file what it answers for the same file expanded; isLineVisible stays false', async () => {
    const { manager, bridge } = page;
    const shown = [[10, 'RIGHT'], [10, 'LEFT'], [205, 'RIGHT']];
    const hidden = [[100, 'RIGHT'], [21, 'LEFT']];
    for (const [line, side] of shown) expect(bridge.isLineInDiff(FILE, line, side)).toBe(true);
    for (const [line, side] of hidden) expect(bridge.isLineInDiff(FILE, line, side)).toBe(false);

    await manager.setFileCollapsed(FILE, true);
    expect(bridge.files.get(FILE).collapsed).toBe(true);
    for (const [line, side] of shown) {
      expect(bridge.isLineInDiff(FILE, line, side)).toBe(true);
      expect(bridge.isLineVisible(FILE, line, side)).toBe(false);
    }
    for (const [line, side] of hidden) expect(bridge.isLineInDiff(FILE, line, side)).toBe(false);
  });

  it('counts the lines a context file shows, collapsed or not, and resolves a path in another form', async () => {
    const { manager, bridge } = page;
    await manager.setFileCollapsed(CONTEXT, true);
    expect(bridge.isLineInDiff(CONTEXT, 1, 'RIGHT')).toBe(true);
    expect(bridge.isLineInDiff(`./${CONTEXT}`, 40, 'RIGHT')).toBe(true);
    expect(bridge.isLineInDiff(CONTEXT, 41, 'RIGHT')).toBe(false);
    expect(bridge.isLineInDiff('src/none.js', 1, 'RIGHT')).toBe(false);
  });
});

describe('external review threads on a collapsed file', () => {
  /** A GitHub thread on a line of FILE. */
  const thread = (id, line, side = 'RIGHT') => ({
    id, source: 'github', external_id: `gh-${id}`, in_reply_to_id: null, parent_id: null,
    external_url: `https://github.com/o/r/pull/1#discussion_r${id}`, author: 'octocat', author_url: null,
    file: FILE, side, line_start: line, line_end: line, diff_position: 5, commit_sha: 'abc', is_outdated: 0,
    original_line_start: line, original_line_end: line, original_commit_sha: 'abc', body: `thread ${id}`,
    external_created_at: new Date(0).toISOString(), synced_at: new Date(0).toISOString(),
  });

  async function renderThreads(threads) {
    const mgr = new ExternalCommentManager({ reviewId: 3, chatPanel: { open: vi.fn() }, sources: ['github'] });
    vi.spyOn(mgr, '_renderPierreFileFallback');
    mgr.threadsBySource.set('github', threads);
    await mgr.render();
    return mgr;
  }

  it('a thread on a line of a viewed (collapsed) file is an annotation on that line, hidden with the file', async () => {
    const { manager, bridge } = page;
    await manager.setFileCollapsed(FILE, true);

    const mgr = await renderThreads([thread(1, 10), thread(2, 205, 'RIGHT')]);

    expect(mgr._renderPierreFileFallback).not.toHaveBeenCalled();
    expect(bridge.getAnnotations(FILE, 'external-comment').map((a) => [a.lineNumber, a.metadata.data.id]))
      .toEqual([[10, 1], [205, 2]]);
    // The viewer is given the file collapsed: the bridge hides its annotations.
    expect(bridge.codeView.getItem(FILE).collapsed).toBe(true);
    // A line the diff shows needs no reveal: no contents are fetched for it.
    expect(manager._ensurePierreContentUpgrade).not.toHaveBeenCalled();

    // Opened by the reader: the threads are on their lines.
    await manager.setFileCollapsed(FILE, false);
    expect(bridge.codeView.getItem(FILE).collapsed).toBe(false);
    expect(bridge.codeView.getItem(FILE).annotations.filter((a) => a.metadata.type === 'external-comment').map((a) => a.lineNumber))
      .toEqual([10, 205]);
  });

  it('a thread whose line the diff does not show still goes to the file zone, collapsed or not', async () => {
    const { manager, bridge } = page;
    await manager.setFileCollapsed(FILE, true);

    const mgr = await renderThreads([thread(3, 100)]);

    // The reveal was asked for (the line is in a gap) and could not be made
    // (no contents in this test), so the thread is a file-level card.
    expect(manager._ensurePierreContentUpgrade).toHaveBeenCalledWith(FILE);
    expect(bridge.getAnnotations(FILE, 'external-comment')).toHaveLength(0);
    expect(mgr._renderPierreFileFallback).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), FILE);
  });
});

describe('PRManager.ensureLinesVisible on a collapsed file', () => {
  it('a range the diff shows asks for nothing; a range in a gap is revealed as for an expanded file', async () => {
    const { manager, bridge } = page;
    await manager.setFileCollapsed(FILE, true);
    const addContextRanges = vi.spyOn(bridge, 'addContextRanges');

    await manager.ensureLinesVisible([{ file: FILE, line_start: 9, line_end: 11, side: 'RIGHT' }]);
    expect(manager._ensurePierreContentUpgrade).not.toHaveBeenCalled();
    expect(addContextRanges).not.toHaveBeenCalled();

    await manager.ensureLinesVisible([{ file: FILE, line_start: 100, line_end: 101, side: 'RIGHT' }]);
    expect(manager._ensurePierreContentUpgrade).toHaveBeenCalledWith(FILE);
    expect(addContextRanges).toHaveBeenCalledWith(FILE, [{ startLine: 100, endLine: 101 }]);
    // The reveal does not open the file.
    expect(manager.isFileCollapsed(FILE)).toBe(true);
  });
});
