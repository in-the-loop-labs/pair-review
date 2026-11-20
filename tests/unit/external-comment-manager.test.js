// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for ExternalCommentManager — the read-only renderer for
 * external review-comment threads in the diff view.
 *
 * Covers:
 *  - empty / single root / multi-reply rendering
 *  - outdated comments with original_line_end fallback
 *  - chat-about-comment + chat-about-thread payload shapes
 *  - clear() touches only `.external-comment-row` rows
 *  - ordering when AI / user comment rows already exist after the target
 *  - defensive skip when both line_end and original_line_end are null
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';

// Production code expects `window.renderMarkdown` and `window.toast`; leave
// them off by default so the module's fallback paths are exercised, then
// individual tests can install spies as needed.
const { ExternalCommentManager } = require('../../public/js/modules/external-comment-manager.js');
const { createBridgeHarness, restoreBridgeHarnesses, hunk } = require('../utils/pierre-bridge-harness.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});
afterEach(() => {
  restoreBridgeHarnesses();
  delete window.prManager;
});

/**
 * A diff pane with one file, drawn by the production bridge on a viewer that
 * never renders (tests/utils/pierre-bridge-harness.js): the file shows the
 * given lines, on both sides. The page manager on the window has that
 * bridge and a line reveal that reveals nothing.
 *
 * The viewer's part is stood in for: after every change of the file's
 * annotations, the cards of its review threads are the children of
 * `.diff-lines` inside the file's wrapper, in the order the bridge gives the
 * viewer. They are the card elements the bridge holds, so a test can click
 * what a reader would click.
 *
 *   <div class="d2h-file-wrapper" data-file-name=file>
 *     <div class="diff-lines"> ...thread cards... </div>
 *   </div>
 */
function buildDiffPane({ file = 'src/app.js', lines = [{ line: 10, side: 'RIGHT' }] } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'd2h-file-wrapper';
  wrapper.dataset.fileName = file;
  const drawn = document.createElement('div');
  drawn.className = 'diff-lines';
  wrapper.appendChild(drawn);
  document.body.appendChild(wrapper);

  // One hunk per run of consecutive lines.
  const numbers = [...new Set(lines.map(({ line }) => line))].sort((x, y) => x - y);
  const hunks = [];
  for (const line of numbers) {
    const last = hunks[hunks.length - 1];
    if (last && last.end === line - 1) last.end = line;
    else hunks.push(hunk(line, line));
  }
  const bridge = createBridgeHarness(vi, vendor, { files: [{ name: file, hunks }] });
  const draw = () => {
    drawn.replaceChildren(...bridge.getAnnotations(file, 'external-comment')
      .map((annotation) => bridge.getAnnotationElement(file, annotation.metadata.id, { create: true })));
  };
  for (const method of ['addAnnotation', 'addAnnotations', 'removeAnnotation', 'removeAnnotationsByType']) {
    const change = bridge[method];
    bridge[method] = Object.assign((...args) => {
      const result = change.apply(bridge, args);
      draw();
      return result;
    }, { mock: change.mock });
  }
  // A page manager a describe block has already put on the window (the zone
  // resolvers of the file-level tests) keeps what it has.
  window.prManager = Object.assign(window.prManager || {}, { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) });
  /** The annotation the bridge holds for a thread: its line and side are where the thread is drawn. */
  const annotationOf = (threadId, source = 'github') => bridge.getAnnotations(file, 'external-comment')
    .find((annotation) => annotation.metadata.id === `external-thread-${source}-${threadId}`) || null;
  return { wrapper, drawn, bridge, annotationOf };
}

function makeComment(overrides = {}) {
  return {
    id: 1,
    source: 'github',
    external_id: 'gh-1',
    in_reply_to_id: null,
    parent_id: null,
    external_url: 'https://github.com/o/r/pull/1#discussion_r1',
    author: 'octocat',
    author_url: 'https://github.com/octocat',
    file: 'src/app.js',
    side: 'RIGHT',
    line_start: 10,
    line_end: 10,
    diff_position: 5,
    commit_sha: 'abc',
    is_outdated: 0,
    original_line_start: 10,
    original_line_end: 10,
    original_commit_sha: 'abc',
    body: 'Looks good to me',
    external_created_at: new Date(Date.now() - 60_000).toISOString(),
    synced_at: new Date().toISOString(),
    replies: [],
    ...overrides,
  };
}

function makeManager({ reviewId = 'rev-1', chatPanel = { open: vi.fn() }, sources = ['github'] } = {}) {
  return new ExternalCommentManager({ reviewId, chatPanel, sources });
}

describe('ExternalCommentManager.render', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders nothing when there are no threads', async () => {
    buildDiffPane();
    const mgr = makeManager();
    mgr.threadsBySource.set('github', []);
    await mgr.render();
    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
  });

  it('renders a single root thread under the target diff line', async () => {
    const { drawn, annotationOf } = buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 7, body: 'Hello' })]);
    await mgr.render();

    const rows = document.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    // An annotation of the target line, on its side
    expect(annotationOf(7)).toMatchObject({ lineNumber: 10, side: 'additions' });
    expect(rows[0].parentNode).toBe(drawn);
    // Contains exactly one comment element (no replies)
    expect(rows[0].querySelectorAll('.external-comment').length).toBe(1);
    expect(rows[0].querySelector('.external-comment').classList.contains('source-github')).toBe(true);
    // Body text rendered as plaintext (no renderMarkdown installed) — fallback uses textContent
    expect(rows[0].querySelector('.external-comment-body').textContent).toBe('Hello');
  });

  it('renders a root with two replies as nested is-reply elements in one card', async () => {
    const { annotationOf } = buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });

    const root = makeComment({
      id: 1,
      body: 'root',
      replies: [
        makeComment({ id: 2, body: 'reply 1', parent_id: 1, in_reply_to_id: 'gh-1' }),
        makeComment({ id: 3, body: 'reply 2', parent_id: 1, in_reply_to_id: 'gh-1' }),
      ],
    });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();

    const rows = document.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    expect(annotationOf(1)).toMatchObject({ lineNumber: 10, side: 'additions' });

    const thread = rows[0].querySelector('.external-comment-thread');
    const comments = thread.querySelectorAll('.external-comment');
    expect(comments.length).toBe(3);
    expect(comments[0].classList.contains('is-reply')).toBe(false);
    expect(comments[1].classList.contains('is-reply')).toBe(true);
    expect(comments[2].classList.contains('is-reply')).toBe(true);
  });

  it('uses original_line_end and shows outdated badge for outdated threads', async () => {
    // Diff currently shows line 20 — the outdated comment was made against line 20 originally.
    const { annotationOf } = buildDiffPane({ lines: [{ line: 20, side: 'RIGHT' }] });

    const root = makeComment({
      id: 9,
      is_outdated: 1,
      line_start: null,
      line_end: null,
      original_line_start: 20,
      original_line_end: 20,
      body: 'stale feedback',
    });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();

    const rows = document.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    expect(annotationOf(9)).toMatchObject({ lineNumber: 20, side: 'additions' });
    const c = rows[0].querySelector('.external-comment');
    expect(c.classList.contains('is-outdated')).toBe(true);
    expect(rows[0].querySelector('.external-comment-outdated-badge')).not.toBeNull();
  });

  it('skips threads with no anchor and warns once', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const root = makeComment({ id: 5, line_end: null, original_line_end: null, is_outdated: 0 });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();

    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('renders author as a link when author_url is present and plain text otherwise', async () => {
    const { bridge } = buildDiffPane({ lines: [
      { line: 10, side: 'RIGHT' },
      { line: 11, side: 'RIGHT' },
    ] });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [
      makeComment({ id: 1, line_start: 10, line_end: 10, author: 'octocat', author_url: 'https://github.com/octocat' }),
      makeComment({ id: 2, line_start: 11, line_end: 11, author: 'ghost', author_url: null }),
    ]);
    await mgr.render();

    expect(pierreCard(bridge, 'src/app.js', 1).querySelector('a.external-comment-author').textContent).toBe('octocat');
    expect(pierreCard(bridge, 'src/app.js', 2).querySelector('span.external-comment-author').textContent).toBe('ghost');
  });
});

describe('ExternalCommentManager chat buttons', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  // After the "consolidate chat buttons" change there is no separate
  // `.external-comment-chat-thread-btn` element. The per-comment chat
  // icon (`.external-comment-chat-btn`) dispatches:
  //   - on the thread root  → threadContext (whole thread + replies)
  //   - on a reply          → commentContext (that single reply)
  // The tests below assert each branch and pin the per-comment fields
  // (id/body/line/side/isOutdated) so coverage from the prior contract
  // is preserved on the threadContext root entry.

  it('chat button on a reply invokes chatPanel.open with commentContext shape', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });
    const root = makeComment({
      id: 1,
      body: 'root body',
      replies: [
        makeComment({
          id: 42,
          body: 'inline body',
          author: 'octocat',
          external_url: 'https://example.com/c/42',
          parent_id: 1,
          in_reply_to_id: 'gh-1',
        }),
      ],
    });
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();

    const replyBtn = document.querySelector('.external-comment.is-reply .external-comment-chat-btn');
    expect(replyBtn).not.toBeNull();
    replyBtn.click();

    expect(chatPanel.open).toHaveBeenCalledTimes(1);
    const arg = chatPanel.open.mock.calls[0][0];
    expect(arg).toEqual({
      commentContext: {
        commentId: 42,
        body: 'inline body',
        file: 'src/app.js',
        side: 'RIGHT',
        line_start: 10,
        line_end: 10,
        source: 'external',
        externalSource: 'github',
        author: 'octocat',
        externalUrl: 'https://example.com/c/42',
        isOutdated: false,
      },
    });
  });

  it('chat button on an outdated reply uses original_line_* and isOutdated=true', async () => {
    buildDiffPane({ lines: [{ line: 20, side: 'RIGHT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });
    const root = makeComment({
      id: 1,
      // Root must be outdated too — the row anchors on the root's anchor
      // and a non-outdated root with null lines would be skipped.
      is_outdated: 1,
      line_start: null,
      line_end: null,
      original_line_start: 20,
      original_line_end: 20,
      replies: [
        makeComment({
          id: 9,
          parent_id: 1,
          in_reply_to_id: 'gh-1',
          is_outdated: 1,
          line_start: null,
          line_end: null,
          original_line_start: 20,
          original_line_end: 20,
        }),
      ],
    });
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();

    const replyBtn = document.querySelector('.external-comment.is-reply .external-comment-chat-btn');
    expect(replyBtn).not.toBeNull();
    replyBtn.click();
    const arg = chatPanel.open.mock.calls[0][0];
    expect(arg.commentContext.isOutdated).toBe(true);
    expect(arg.commentContext.line_start).toBe(20);
    expect(arg.commentContext.line_end).toBe(20);
  });

  it('chat button on the thread root invokes chatPanel.open with threadContext shape', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });

    const root = makeComment({
      id: 1,
      body: 'root body',
      external_created_at: '2026-01-01T00:00:00Z',
      replies: [
        makeComment({ id: 2, body: 'reply body', is_outdated: 0, external_url: 'https://example.com/c/2', external_created_at: '2026-01-02T00:00:00Z', author: 'alice' }),
      ],
    });
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();

    // Root chat button = the first `.external-comment-chat-btn` that is
    // NOT inside `.is-reply`. After consolidation it replaces the prior
    // standalone `.external-comment-chat-thread-btn` element.
    const rootBtn = document.querySelector('.external-comment:not(.is-reply) .external-comment-chat-btn');
    expect(rootBtn).not.toBeNull();
    rootBtn.click();

    expect(chatPanel.open).toHaveBeenCalledTimes(1);
    const arg = chatPanel.open.mock.calls[0][0];
    // Per-comment id/line/side coverage on the root entry — equivalent to
    // the prior commentContext root assertions.
    expect(arg.threadContext.rootId).toBe(1);
    expect(arg.threadContext.line_start).toBe(10);
    expect(arg.threadContext.line_end).toBe(10);
    expect(arg.threadContext.side).toBe('RIGHT');
    expect(arg).toEqual({
      threadContext: {
        rootId: 1,
        source: 'external',
        externalSource: 'github',
        file: 'src/app.js',
        side: 'RIGHT',
        line_start: 10,
        line_end: 10,
        comments: [
          {
            author: 'octocat',
            body: 'root body',
            isOutdated: false,
            externalUrl: 'https://github.com/o/r/pull/1#discussion_r1',
            externalCreatedAt: '2026-01-01T00:00:00Z',
          },
          {
            author: 'alice',
            body: 'reply body',
            isOutdated: false,
            externalUrl: 'https://example.com/c/2',
            externalCreatedAt: '2026-01-02T00:00:00Z',
          },
        ],
      },
    });
  });
});

describe('ExternalCommentManager.clear', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('removes only the review threads, leaving comments and suggestions on the same line intact', async () => {
    const { bridge } = buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    // Annotations owned by other renderers, on the thread's line
    bridge.addAnnotation('src/app.js', { lineNumber: 10, side: 'RIGHT', type: 'suggestion', id: 'suggestion-1', data: { id: 1 } });
    bridge.addAnnotation('src/app.js', { lineNumber: 10, side: 'RIGHT', type: 'comment', id: 'comment-1', data: { id: 1 } });

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();

    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);
    expect(bridge.getAnnotations('src/app.js').map((a) => a.metadata.type).sort()).toEqual(['comment', 'external-comment', 'suggestion']);

    mgr.clear();

    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
    expect(bridge.getAnnotations('src/app.js').map((a) => a.metadata.type).sort()).toEqual(['comment', 'suggestion']);
  });
});

describe('ExternalCommentManager ordering rule', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** The types of what the viewer is given for the file's line 10, in the order it draws them. */
  const typesOnLine = (bridge) => bridge.codeView.getItem('src/app.js').annotations
    .filter((annotation) => annotation.lineNumber === 10)
    .map((annotation) => annotation.metadata.type);

  it('a review thread is drawn BELOW a user comment that is on the same diff line, whichever was added first', async () => {
    const { bridge } = buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();
    // The user's comment arrives after the thread
    bridge.addAnnotation('src/app.js', { lineNumber: 10, side: 'RIGHT', type: 'comment', id: 'comment-1', data: { id: 1 } });

    expect(typesOnLine(bridge)).toEqual(['comment', 'external-comment']);
  });

  it('a review thread is drawn BELOW an AI suggestion AND a user comment on the same diff line', async () => {
    const { bridge } = buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    bridge.addAnnotation('src/app.js', { lineNumber: 10, side: 'RIGHT', type: 'comment', id: 'comment-1', data: { id: 1 } });

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();
    bridge.addAnnotation('src/app.js', { lineNumber: 10, side: 'RIGHT', type: 'suggestion', id: 'suggestion-1', data: { id: 1 } });

    expect(typesOnLine(bridge)).toEqual(['suggestion', 'comment', 'external-comment']);
  });
});

describe('ExternalCommentManager.loadAndRender in-flight guard', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('coalesces concurrent loadAndRender calls into a single fetch', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const threads = [makeComment({ id: 1 })];

    // Block the fetch on a manual promise so we can fire two callers
    // while the first is still in flight.
    let resolveFetch;
    const gate = new Promise((r) => { resolveFetch = r; });
    global.fetch = vi.fn().mockImplementation(() => gate.then(() => ({
      ok: true,
      json: vi.fn().mockResolvedValue({ threads }),
    })));

    const mgr = makeManager({ reviewId: 'r-1' });

    const p1 = mgr.loadAndRender();
    const p2 = mgr.loadAndRender();
    // While the gate is closed, both callers must observe the same promise
    expect(p1).toBe(p2);
    expect(mgr._inflight).toBe(p1);

    resolveFetch();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(r2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mgr._inflight).toBeNull();
    // Render did happen exactly once
    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);
  });

  it('a third call AFTER the first settles makes a new fetch', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const threads = [makeComment({ id: 1 })];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ threads }),
    });

    const mgr = makeManager({ reviewId: 'r-1' });
    await mgr.loadAndRender();
    await mgr.loadAndRender();

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('syncAndRender runs syncFn BEFORE the GET, and a concurrent loadAndRender joins the in-flight promise', async () => {
    // Regression: between sync POST and GET render, a GET-only caller
    // (analysis rebuild, whitespace toggle) hitting loadAndRender used to
    // race the POST with a stale GET. Both methods now share `_inflight`,
    // so the GET-only caller joins the full sync+load promise.
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const threads = [makeComment({ id: 1 })];

    // Order recorder: confirm POST ran before GET.
    const order = [];
    let resolveSync;
    const syncGate = new Promise((r) => { resolveSync = r; });
    const syncFn = vi.fn(async () => {
      order.push('sync:start');
      await syncGate;
      order.push('sync:end');
      return { count: 1, lostAnchors: 0, deleted: 0, syncedAt: 'now' };
    });

    global.fetch = vi.fn().mockImplementation(() => {
      order.push('get');
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ threads }),
      });
    });

    const mgr = makeManager({ reviewId: 'r-1' });

    const p1 = mgr.syncAndRender({ syncFn });
    // While sync is blocked, a GET-only caller arrives.
    const p2 = mgr.loadAndRender();
    // Both must observe the same in-flight promise.
    expect(p2).toBe(p1);
    expect(mgr._inflight).toBe(p1);

    resolveSync();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(r2);
    expect(syncFn).toHaveBeenCalledTimes(1);
    // GET fired exactly once and AFTER sync completed.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['sync:start', 'sync:end', 'get']);
    expect(r1.syncResult).toEqual({ count: 1, lostAnchors: 0, deleted: 0, syncedAt: 'now' });
    expect(r1.syncError).toBeNull();
  });

  it('syncAndRender: sync failure does not block render — syncError surfaced, render still happens', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const threads = [makeComment({ id: 1 })];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ threads }),
    });
    const syncErr = Object.assign(new Error('boom'), { status: 429 });
    const syncFn = vi.fn().mockRejectedValue(syncErr);

    const mgr = makeManager({ reviewId: 'r-1' });
    const result = await mgr.syncAndRender({ syncFn });

    expect(result.syncError).toBe(syncErr);
    expect(result.syncResult).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);
  });
});

describe('ExternalCommentManager outdated comment ensureLinesVisible fallback', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
    vi.restoreAllMocks();
  });

  it('calls prManager.ensureLinesVisible with items-array shape and awaits it before deciding where the thread goes', async () => {
    // Regression: the call previously used positional args and wasn't
    // awaited. Production PRManager.ensureLinesVisible takes an array of
    // `{file, line_start, line_end, side}` items and returns a Promise.
    // If the call isn't awaited the line is not shown yet when the manager
    // asks, and the thread is filed at file level.
    const { bridge, annotationOf, wrapper } = buildDiffPane({ lines: [{ line: 30, side: 'RIGHT' }] });
    expect(bridge.isLineVisible('src/app.js', 20, 'RIGHT')).toBe(false);

    let ensureLinesVisibleResolved = false;
    window.prManager.ensureLinesVisible = vi.fn(async (items) => {
      // Reveal the line on a later microtask so the test would FAIL if the
      // production code forgot to await this Promise.
      await Promise.resolve();
      const item = Array.isArray(items) ? items[0] : null;
      if (!item) return;
      const numbered = `${Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
      bridge.upgradeFileContents('src/app.js',
        { name: 'src/app.js', contents: numbered },
        { name: 'src/app.js', contents: numbered.replace('line 30\n', 'changed 30\n') });
      bridge.addContextRanges('src/app.js', [{ startLine: item.line_start, endLine: item.line_end }]);
      ensureLinesVisibleResolved = true;
    });

    const outdated = makeComment({
      id: 99,
      is_outdated: 1,
      line_start: null,
      line_end: null,
      original_line_start: 20,
      original_line_end: 20,
      body: 'old discussion',
    });

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [outdated]);
    await mgr.render();

    // Production contract: items-array call shape, awaited so the line is
    // shown before the manager asks.
    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledTimes(1);
    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'src/app.js', line_start: 20, line_end: 20, side: 'RIGHT' }
    ]);
    expect(ensureLinesVisibleResolved).toBe(true);

    const rows = document.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    expect(annotationOf(99)).toMatchObject({ lineNumber: 20, side: 'additions' });
    expect(rows[0].classList.contains('external-comment-row--file-fallback')).toBe(false);
    expect(wrapper.contains(rows[0])).toBe(true);
  });

  it('falls back to file-level when ensureLinesVisible cannot materialize the anchor', async () => {
    // The diff does not show the target line; ensureLinesVisible is a no-op.
    const { wrapper } = buildDiffPane({ lines: [{ line: 999, side: 'RIGHT' }] });

    const outdated = makeComment({
      id: 77,
      is_outdated: 1,
      line_start: null,
      line_end: null,
      original_line_start: 20,
      original_line_end: 20,
    });

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [outdated]);
    await mgr.render();

    // Still rendered, at the file fallback location.
    const rows = wrapper.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    expect(rows[0].classList.contains('external-comment-row--file-fallback')).toBe(true);
  });
});

// =======================================================================
// Threads on lines of the diff: annotations of the viewer
//
// A file's lines are drawn by the vendor in a shadow tree, and a file far
// from the viewport is not drawn at all, so a thread on a line mounts as an
// 'external-comment' annotation via PierreBridge. These tests run against
// the real PierreBridge without the vendor
// (tests/utils/pierre-bridge-harness.js): its annotation list,
// visibility oracle and element cache are production code, and nothing is
// ever drawn. The manager must decide from the oracle whether a line is
// shown, and must never need a card to be in the document.
// =======================================================================

/**
 * Build a real PierreBridge (no vendor; tests/utils/pierre-bridge-harness.js)
 * over `files`, plus the `.d2h-file-wrapper` of each file. Each file has one
 * hunk of lines 1-100 unless `hunks` says otherwise; `hunks: []` gives a file
 * whose diff shows no line at all (an anchor line that is not in the diff).
 * Nothing is ever drawn: the manager must not need a card in the document.
 */
function makePierreBridge({ files = ['src/app.js'], hunks } = {}) {
  for (const f of files) {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = f;
    document.body.appendChild(wrapper);
  }
  return createBridgeHarness(vi, vendor, {
    files: files.map(name => (hunks ? { name, hunks } : { name })),
  });
}

/** The card the bridge holds for a thread anchored on a line of `file`. */
function pierreCard(bridge, file, threadId, source = 'github') {
  return bridge.getAnnotationElement(file, `external-thread-${source}-${threadId}`, { create: true });
}

describe('ExternalCommentManager pierre annotation path', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
    vi.restoreAllMocks();
  });

  it('mounts a thread as an external-comment annotation and slots a <div> row', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 7, body: 'pierre body' })]);
    await mgr.render();

    // The thread is an annotation of its file.
    expect(bridge.addAnnotation).toHaveBeenCalledTimes(1);
    const [file, ann] = bridge.addAnnotation.mock.calls[0];
    expect(file).toBe('src/app.js');
    expect(ann.type).toBe('external-comment');
    expect(ann.side).toBe('RIGHT');
    expect(ann.lineNumber).toBe(10);
    expect(ann.data.id).toBe(7);

    // The annotation's element is a <div> carrying the shared
    // class + data attributes. It is the bridge's to draw: the manager did
    // not look for it in the document, where it is not (nothing draws here).
    expect(document.querySelector('.external-comment-row')).toBeNull();
    expect(bridge.removeAnnotation).not.toHaveBeenCalled();
    const row = pierreCard(bridge, 'src/app.js', 7);
    expect(row).not.toBeNull();
    expect(row.tagName).toBe('DIV');
    expect(row.dataset.threadId).toBe('7');
    expect(row.dataset.source).toBe('github');
    expect(row.querySelectorAll('.external-comment').length).toBe(1);
    expect(row.querySelector('.external-comment-body').textContent).toBe('pierre body');
  });

  it('expands collapsed gaps (ensureLinesVisible) BEFORE adding the annotation', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    const order = [];
    const ensureLinesVisible = vi.fn(async () => { order.push('ensure'); });
    vi.spyOn(bridge, 'isLineVisible').mockImplementation(() => { order.push('visible?'); return true; });
    bridge.addAnnotation.mockImplementation(() => { order.push('add'); });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();

    expect(ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'src/app.js', line_start: 10, line_end: 10, side: 'RIGHT' },
    ]);
    // Reveal, then ask the oracle, then annotate.
    expect(order).toEqual(['ensure', 'visible?', 'add']);
    expect(bridge.isLineVisible).toHaveBeenCalledWith('src/app.js', 10, 'RIGHT');
  });

  it('_isPierreFile: a file the viewer has a record of, mounted or not; no other, and none without a viewer', () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = { pierreBridge: bridge };
    const mgr = makeManager();
    expect(mgr._isPierreFile('src/app.js')).toBe(true); // in bridge.files
    expect(mgr._isPierreFile('src/unknown.js')).toBe(false);
    window.prManager = {};
    expect(mgr._isPierreFile('src/app.js')).toBe(false);
    delete window.prManager;
    expect(mgr._isPierreFile('src/app.js')).toBe(false);
  });

  it('registers the external-comment renderer exactly once across renders', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();
    await mgr.render();

    expect(bridge.registerAnnotationRenderer).toHaveBeenCalledTimes(1);
    expect(bridge.registerAnnotationRenderer.mock.calls[0][0]).toBe('external-comment');
  });

  it('clear() drops pierre annotations via removeAnnotationsByType (no direct DOM removal leak)', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();
    expect(bridge.getAnnotations('src/app.js', 'external-comment')).toHaveLength(1);

    mgr.clear();
    expect(bridge.removeAnnotationsByType).toHaveBeenCalledWith('src/app.js', 'external-comment');
    // The annotation is gone from the bridge, which owns the card.
    expect(bridge.getAnnotations('src/app.js', 'external-comment')).toHaveLength(0);
    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
  });

  it('re-render replaces rather than duplicates (clear + re-add yields one row)', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();
    await mgr.render();

    expect(bridge.getAnnotations('src/app.js', 'external-comment')).toHaveLength(1);
  });

  it('falls back to a file-level div when the diff does not show the anchor line', async () => {
    // The file's diff has no hunk holding line 10 (an anchor line absent
    // from the diff). The manager decides that from the bridge's visibility
    // oracle, adds no annotation and appends a file-level fallback card.
    const bridge = makePierreBridge({ files: ['src/app.js'], hunks: [hunk(200, 210)] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 3 })]);
    await mgr.render();

    expect(bridge.addAnnotation).not.toHaveBeenCalled();
    expect(bridge.getAnnotations('src/app.js', 'external-comment')).toHaveLength(0);
    const wrapper = document.querySelector('.d2h-file-wrapper[data-file-name="src/app.js"]');
    const fallback = wrapper.querySelector('.external-comment-row.external-comment-row--file-fallback');
    expect(fallback).not.toBeNull();
    expect(fallback.dataset.threadId).toBe('3');
  });

  it('keeps a thread on its line when the line is shown and no card is in the document (H60)', async () => {
    // While a new diff of the file awaits display the viewer does not draw
    // the annotation that was just added. "No card in the document" then
    // says nothing about the line; the oracle does. The thread must stay an
    // annotation, and nothing may be put in the file's comment zone.
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 11 })]);
    await mgr.render();

    expect(document.querySelector('.external-comment-row')).toBeNull();
    expect(bridge.getAnnotations('src/app.js', 'external-comment')).toHaveLength(1);
    expect(bridge.removeAnnotation).not.toHaveBeenCalled();
    // It is what the viewer was given for the file.
    expect(bridge.codeView.getItem('src/app.js').annotations.map((a) => a.metadata.type)).toContain('external-comment');
  });

  it('falls back to file level for a collapsed file, and when the oracle is missing or throws', async () => {
    const collapsed = makePierreBridge({ files: ['src/app.js'] });
    collapsed.files.get('src/app.js').collapsed = true;
    window.prManager = { pierreBridge: collapsed, ensureLinesVisible: vi.fn(async () => {}) };
    let mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 21 })]);
    await mgr.render();
    expect(collapsed.addAnnotation).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.external-comment-row--file-fallback')).toHaveLength(1);

    document.body.innerHTML = '';
    const throwing = makePierreBridge({ files: ['src/app.js'] });
    vi.spyOn(throwing, 'isLineVisible').mockImplementation(() => { throw new Error('boom'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.prManager = { pierreBridge: throwing, ensureLinesVisible: vi.fn(async () => {}) };
    mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 22 })]);
    await mgr.render();
    expect(throwing.addAnnotation).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.external-comment-row--file-fallback')).toHaveLength(1);

    document.body.innerHTML = '';
    const noOracle = makePierreBridge({ files: ['src/app.js'] });
    noOracle.isLineVisible = undefined;
    window.prManager = { pierreBridge: noOracle, ensureLinesVisible: vi.fn(async () => {}) };
    mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 23 })]);
    await mgr.render();
    expect(noOracle.addAnnotation).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.external-comment-row--file-fallback')).toHaveLength(1);
  });

  it('findThreadCard and threadAnnotationId resolve a thread by its own identity, wherever it was rendered', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js', 'src/other.js'] });
    const zone = document.createElement('div');
    zone.className = 'file-comments-zone';
    zone.innerHTML = '<div class="file-comments-container"></div>';
    window.prManager = {
      pierreBridge: bridge,
      ensureLinesVisible: vi.fn(async () => {}),
      // A zone that is not attached to the document is still the file's zone.
      getFileCommentsZone: (file) => (file === 'src/other.js' ? zone : null),
      forEachFileCommentsZone: (fn) => fn(zone, 'src/other.js'),
    };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [
      makeComment({ id: 31, file: 'src/app.js' }),
      makeComment({
        id: 32, file: 'src/other.js', is_file_level: 1, line_start: null, line_end: null,
        diff_position: null, original_line_start: null, original_line_end: null,
      }),
    ]);
    await mgr.render();

    // On its line: an annotation, found by data, not by a document query.
    expect(mgr.threadAnnotationId(31, 'github')).toBe('external-thread-github-31');
    expect(mgr.findThreadCard(31, 'github')).toBe(pierreCard(bridge, 'src/app.js', 31));
    expect(mgr.findThreadCard(31).dataset.threadId).toBe('31');
    // At file level: no annotation; the card is in the (detached) zone.
    expect(mgr.threadAnnotationId(32, 'github')).toBeNull();
    expect(mgr.findThreadCard(32, 'github')).toBe(zone.querySelector('.external-comment-row'));
    // Unknown thread, missing id.
    expect(mgr.findThreadCard(99, 'github')).toBeNull();
    expect(mgr.findThreadCard(null)).toBeNull();
    expect(mgr.threadAnnotationId(undefined)).toBeNull();

    // clear() reaches the detached zone too.
    mgr.clear();
    expect(zone.querySelector('.external-comment-row')).toBeNull();
    expect(mgr.findThreadCard(31, 'github')).toBeNull();
  });

  it('a thread of a file the viewer does not have is no annotation: it is filed with the file when the page has a place for it', async () => {
    // The bridge only knows another file (the thread names a file that is
    // not in the diff any more).
    const bridge = makePierreBridge({ files: ['other/file.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = 'src/app.js';
    document.body.appendChild(wrapper);

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1, file: 'src/app.js' })]);
    await mgr.render();

    expect(bridge.addAnnotation).not.toHaveBeenCalled();
    const row = document.querySelector('.external-comment-row');
    expect(row.tagName).toBe('DIV');
    expect(row.classList.contains('external-comment-row--file-fallback')).toBe(true);
    expect(wrapper.contains(row)).toBe(true);
  });

  it('a thread of a file the page has nothing for is not drawn, and says so', async () => {
    const bridge = makePierreBridge({ files: ['other/file.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1, file: 'src/gone.js' })]);
    await mgr.render();

    expect(bridge.addAnnotation).not.toHaveBeenCalled();
    expect(document.querySelector('.external-comment-row')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('src/gone.js:10'));
  });
});

// =======================================================================
// File-level threads (GitHub subject_type='file')
//
// File-level comments have no line anchor. They render into the per-file
// `.file-comments-zone` above the diff (light DOM the page owns),
// NOT as a line-1 annotation. Unanchorable line threads (outdated / dropped
// line) fall back into the SAME zone when one exists.
// =======================================================================
describe('ExternalCommentManager file-level threads', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    zones.clear();
    window.prManager = zoneResolvers();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
    vi.restoreAllMocks();
  });

  // Mirror FileCommentManager.createFileCommentsZone: a per-file zone with an
  // inner container, inserted at the top of the file wrapper.
  function addZone(file = 'src/app.js') {
    const wrapper = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
    const zone = document.createElement('div');
    zone.className = 'file-comments-zone';
    zone.dataset.fileName = file;
    const container = document.createElement('div');
    container.className = 'file-comments-container';
    zone.appendChild(container);
    wrapper.insertBefore(zone, wrapper.firstChild);
    zones.set(file, zone);
    return { zone, container };
  }

  // The manager finds a file's comment zone through the page's one resolver
  // (PRManager.getFileCommentsZone), never in the document.
  const zones = new Map();
  function zoneResolvers() {
    return {
      getFileCommentsZone: vi.fn((file) => zones.get(file) || null),
      forEachFileCommentsZone: (fn) => zones.forEach((zone, file) => fn(zone, file)),
    };
  }

  function fileLevelComment(overrides = {}) {
    return makeComment({
      is_file_level: 1,
      line_start: null,
      line_end: null,
      diff_position: null,
      original_line_start: null,
      original_line_end: null,
      ...overrides,
    });
  }

  it('renders a file-level thread into the zone, not under a diff line', async () => {
    const { bridge } = buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const { container } = addZone('src/app.js');

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [fileLevelComment({ id: 8, body: 'whole file comment' })]);
    await mgr.render();

    const rows = document.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    const card = rows[0];
    expect(card.tagName).toBe('DIV');
    expect(container.contains(card)).toBe(true);
    expect(card.classList.contains('external-comment-row--file-level')).toBe(true);
    expect(card.dataset.threadId).toBe('8');
    expect(card.dataset.source).toBe('github');
    expect(card.querySelector('.external-comment-body').textContent).toBe('whole file comment');

    // The diff line must NOT have gained an annotation.
    expect(bridge.getAnnotations('src/app.js', 'external-comment')).toEqual([]);
  });

  it('renders a file-level thread with replies as one zone card', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const { container } = addZone('src/app.js');
    const root = fileLevelComment({
      id: 1,
      body: 'root',
      replies: [fileLevelComment({ id: 2, body: 'reply', parent_id: 1, in_reply_to_id: 'gh-1' })],
    });

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();

    const cards = container.querySelectorAll('.external-comment-row');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelectorAll('.external-comment').length).toBe(2);
  });

  it('routes file-level threads to the zone even when the file is pierre-rendered (no bridge)', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = { ...zoneResolvers(), pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };
    const { container } = addZone('src/app.js');

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [fileLevelComment({ id: 5 })]);
    await mgr.render();

    // File-level never mounts as an annotation — straight to the light-DOM zone.
    expect(bridge.addAnnotation).not.toHaveBeenCalled();
    expect(container.querySelector('.external-comment-row--file-level')).not.toBeNull();
  });

  it('resolves the zone via prManager.getFileCommentsZone, also when the zone is not in the document', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const { zone, container } = addZone('src/app.js');
    zone.remove();

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [fileLevelComment({ id: 8 })]);
    await mgr.render();

    expect(window.prManager.getFileCommentsZone).toHaveBeenCalledWith('src/app.js');
    expect(container.querySelector('.external-comment-row--file-level')).not.toBeNull();
    expect(document.querySelector('.external-comment-row')).toBeNull();
  });

  it('appends to the file wrapper when the page has no zone for the file', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    delete window.prManager;

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [fileLevelComment({ id: 9 })]);
    await mgr.render();

    const wrapper = document.querySelector('.d2h-file-wrapper[data-file-name="src/app.js"]');
    expect(wrapper.querySelector(':scope > .external-comment-row--file-level')).not.toBeNull();
  });

  it('unanchorable line thread falls back into the zone (not a faked line-1 row)', async () => {
    buildDiffPane({ lines: [{ line: 999, side: 'RIGHT' }] });
    const { container } = addZone('src/app.js');
    window.prManager = { ...zoneResolvers(), ensureLinesVisible: vi.fn(async () => {}) };

    const outdated = makeComment({
      id: 77,
      is_outdated: 1,
      line_start: null,
      line_end: null,
      original_line_start: 20,
      original_line_end: 20,
    });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [outdated]);
    await mgr.render();

    const card = container.querySelector('.external-comment-row--file-fallback');
    expect(card).not.toBeNull();
    expect(card.dataset.threadId).toBe('77');
    // It landed in the zone, so the outdated badge is preserved.
    expect(card.querySelector('.external-comment-outdated-badge')).not.toBeNull();
  });

  it('clear() removes file-level zone cards (shared .external-comment-row class)', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    addZone('src/app.js');

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [fileLevelComment({ id: 8 })]);
    await mgr.render();
    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);

    mgr.clear();
    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
  });

  it('last-resort wrapper append when the zone is missing', async () => {
    // No zone in the wrapper — a file-level thread still renders (discoverable),
    // appended to the wrapper rather than dropped.
    const { wrapper } = buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [fileLevelComment({ id: 8 })]);
    await mgr.render();

    const card = wrapper.querySelector('.external-comment-row--file-level');
    expect(card).not.toBeNull();
  });
});

describe('ExternalCommentManager URL safety (isSafeUrl)', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('javascript: author_url renders as plain text and no href', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({
      id: 1,
      author: 'octocat',
      author_url: 'javascript:alert(1)',
    })]);
    await mgr.render();

    const row = document.querySelector('.external-comment-row');
    expect(row).not.toBeNull();
    expect(row.querySelector('a.external-comment-author')).toBeNull();
    const span = row.querySelector('span.external-comment-author');
    expect(span).not.toBeNull();
    expect(span.textContent).toBe('octocat');
    // No element in the rendered card carries a javascript: href.
    const hrefs = Array.from(row.querySelectorAll('[href]')).map(el => el.getAttribute('href'));
    for (const h of hrefs) expect(h).not.toMatch(/^javascript:/i);
  });

  it('javascript: external_url drops the permalink button entirely', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({
      id: 1,
      external_url: 'javascript:alert(1)',
    })]);
    await mgr.render();

    const row = document.querySelector('.external-comment-row');
    expect(row.querySelector('.external-comment-permalink')).toBeNull();
  });

  it('https URLs are still rendered as links', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({
      id: 1,
      author_url: 'https://github.com/octocat',
      external_url: 'https://github.com/example',
    })]);
    await mgr.render();

    const row = document.querySelector('.external-comment-row');
    expect(row.querySelector('a.external-comment-author')).not.toBeNull();
    expect(row.querySelector('.external-comment-permalink')).not.toBeNull();
  });
});

describe('ExternalCommentManager minimizer refresh', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
    vi.restoreAllMocks();
  });

  it('invokes prManager.commentMinimizer.refreshIndicators after rendering', async () => {
    // Regression: external rows were not feeding the minimize-comments
    // indicator pipeline, so toggling minimize mode dropped the external
    // bubble count from per-line badges. Mirror what comment-manager and
    // suggestion-manager do — call refreshIndicators on render completion.
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const refreshSpy = vi.fn();
    window.prManager = {
      commentMinimizer: { refreshIndicators: refreshSpy }
    };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when prManager or commentMinimizer is missing', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    // window.prManager intentionally absent.
    await expect(mgr.render()).resolves.toBeUndefined();
  });
});

describe('ExternalCommentManager passes side to chat context', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('LEFT side flows through to commentContext (reply chat button)', async () => {
    buildDiffPane({ lines: [{ line: 5, side: 'LEFT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });

    mgr.threadsBySource.set('github', [makeComment({
      id: 49,
      side: 'LEFT',
      line_start: 5,
      line_end: 5,
      replies: [
        makeComment({
          id: 50,
          side: 'LEFT',
          line_start: 5,
          line_end: 5,
          parent_id: 49,
          in_reply_to_id: 'gh-1',
        }),
      ],
    })]);
    await mgr.render();

    document.querySelector('.external-comment.is-reply .external-comment-chat-btn').click();
    expect(chatPanel.open).toHaveBeenCalledTimes(1);
    expect(chatPanel.open.mock.calls[0][0].commentContext.side).toBe('LEFT');
  });

  it('LEFT side flows through to threadContext (root chat button)', async () => {
    buildDiffPane({ lines: [{ line: 5, side: 'LEFT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });

    mgr.threadsBySource.set('github', [makeComment({
      id: 51,
      side: 'LEFT',
      line_start: 5,
      line_end: 5,
      replies: [],
    })]);
    await mgr.render();

    document.querySelector('.external-comment:not(.is-reply) .external-comment-chat-btn').click();
    expect(chatPanel.open).toHaveBeenCalledTimes(1);
    expect(chatPanel.open.mock.calls[0][0].threadContext.side).toBe('LEFT');
  });

  it('missing chat panel surfaces a toast instead of silently dropping', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });
    const toastSpy = vi.fn();
    const origToast = window.toast;
    const origChatPanel = window.chatPanel;
    window.toast = { showWarning: toastSpy };
    delete window.chatPanel;

    const mgr = makeManager({ chatPanel: null });
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();

    document.querySelector('.external-comment-chat-btn').click();
    expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/Chat is unavailable/));
    window.toast = origToast;
    if (origChatPanel !== undefined) window.chatPanel = origChatPanel;
  });
});

describe('ExternalCommentManager._resolveAnchor fallback (forward-compat)', async () => {
  // Future GitLab/Linear adapters may not couple is_outdated with the
  // current vs. original anchor in the same way GitHub does. `_resolveAnchor`
  // treats is_outdated as a hint about which anchor to PREFER, not as a
  // strict switch — falling back to the other anchor when the preferred
  // one is missing keeps borderline cells renderable.
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('(a) outdated + only original_line_end set → uses original_line_end', () => {
    const mgr = makeManager();
    const a = mgr._resolveAnchor({
      file: 'a.js',
      side: 'RIGHT',
      is_outdated: 1,
      line_end: null,
      original_line_end: 20,
    });
    expect(a).toEqual({ file: 'a.js', line: 20, side: 'RIGHT' });
  });

  it('(b) non-outdated + only line_end set → uses line_end', () => {
    const mgr = makeManager();
    const a = mgr._resolveAnchor({
      file: 'a.js',
      side: 'RIGHT',
      is_outdated: 0,
      line_end: 10,
      original_line_end: null,
    });
    expect(a).toEqual({ file: 'a.js', line: 10, side: 'RIGHT' });
  });

  it('(c) outdated + only line_end set → falls back to live anchor', () => {
    // Adapter reported is_outdated=1 but only line_end is populated. Strict
    // switching would return null and silently drop the row. The fallback
    // uses line_end so the comment still renders.
    const mgr = makeManager();
    const a = mgr._resolveAnchor({
      file: 'a.js',
      side: 'RIGHT',
      is_outdated: 1,
      line_end: 7,
      original_line_end: null,
    });
    expect(a).toEqual({ file: 'a.js', line: 7, side: 'RIGHT' });
  });

  it('(d) non-outdated + only original_line_end set → falls back to original', () => {
    const mgr = makeManager();
    const a = mgr._resolveAnchor({
      file: 'a.js',
      side: 'RIGHT',
      is_outdated: 0,
      line_end: null,
      original_line_end: 33,
    });
    expect(a).toEqual({ file: 'a.js', line: 33, side: 'RIGHT' });
  });

  it('(e) both null → returns null', () => {
    const mgr = makeManager();
    const a = mgr._resolveAnchor({
      file: 'a.js',
      side: 'RIGHT',
      is_outdated: 1,
      line_end: null,
      original_line_end: null,
    });
    expect(a).toBeNull();
  });

  it('returns null when comment.file is missing', () => {
    const mgr = makeManager();
    expect(mgr._resolveAnchor({ line_end: 5 })).toBeNull();
    expect(mgr._resolveAnchor(null)).toBeNull();
  });

  it('defaults side to RIGHT when comment.side is missing', () => {
    const mgr = makeManager();
    const a = mgr._resolveAnchor({ file: 'a.js', line_end: 5 });
    expect(a.side).toBe('RIGHT');
  });

  it('file-level comment returns a fileLevel anchor (no line/side), even with leftover line:1', () => {
    // GitHub reports line:1 for file-level comments; is_file_level must win so
    // the row routes to the zone instead of anchoring at line 1.
    const mgr = makeManager();
    const a = mgr._resolveAnchor({ file: 'a.js', is_file_level: 1, side: 'RIGHT', line_end: 1, original_line_end: 1 });
    expect(a).toEqual({ file: 'a.js', fileLevel: true });
  });

  it('file-level accepts boolean true as well as 1', () => {
    const mgr = makeManager();
    const a = mgr._resolveAnchor({ file: 'a.js', is_file_level: true });
    expect(a).toEqual({ file: 'a.js', fileLevel: true });
  });
});

describe('ExternalCommentManager.fetch', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('hits the correct URL and stores returned threads', async () => {
    const threads = [makeComment({ id: 99 })];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ threads }),
    });

    const mgr = makeManager({ reviewId: 'r-42' });
    const got = await mgr.fetch('github');

    expect(global.fetch).toHaveBeenCalledWith('/api/reviews/r-42/external-comments?source=github');
    expect(got).toBe(threads);
    expect(mgr.threadsBySource.get('github')).toBe(threads);
  });

  it('surfaces a toast when the API returns non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: vi.fn() });
    window.toast = { showError: vi.fn() };

    const mgr = makeManager();
    await expect(mgr.fetch('github')).rejects.toThrow(/Failed to fetch external comments/);
    expect(window.toast.showError).toHaveBeenCalled();
    delete window.toast;
  });
});

// =======================================================================
// Review-panel handoff (External segment in AIPanel)
//
// The manager flattens threadsBySource into a single array via
// getAllThreads(), and pushes it onto the panel after each
// _fetchAllAndRender via setExternalThreads. The panel surface is
// described in tests/unit/ai-panel-external-segment.test.js — these tests
// only verify the producer side of the contract.
// =======================================================================
describe('ExternalCommentManager.getAllThreads', () => {
  it('returns an empty array when no sources are loaded', () => {
    const mgr = makeManager();
    expect(mgr.getAllThreads()).toEqual([]);
  });

  it('flattens threads from every source into a single array', () => {
    const mgr = makeManager({ sources: ['github', 'gitlab'] });
    const ghThreads = [makeComment({ id: 1 }), makeComment({ id: 2 })];
    const glThreads = [makeComment({ id: 3, source: 'gitlab' })];
    mgr.threadsBySource.set('github', ghThreads);
    mgr.threadsBySource.set('gitlab', glThreads);

    const all = mgr.getAllThreads();
    expect(all).toHaveLength(3);
    expect(all.map(t => t.id).sort()).toEqual([1, 2, 3]);
  });

  it('skips entries that are not arrays defensively', () => {
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    mgr.threadsBySource.set('broken', null);
    mgr.threadsBySource.set('also-broken', 'not an array');

    const all = mgr.getAllThreads();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(1);
  });
});

describe('ExternalCommentManager._notifyPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.aiPanel;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.aiPanel;
    vi.restoreAllMocks();
  });

  it('calls window.aiPanel.setExternalThreads with the flattened thread list', () => {
    const setExternalThreads = vi.fn();
    window.aiPanel = { setExternalThreads };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 }), makeComment({ id: 2 })]);

    mgr._notifyPanel();

    expect(setExternalThreads).toHaveBeenCalledTimes(1);
    const arg = setExternalThreads.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg.map(t => t.id).sort()).toEqual([1, 2]);
  });

  it('is a no-op when window.aiPanel is not present', () => {
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    expect(() => mgr._notifyPanel()).not.toThrow();
  });

  it('is a no-op when window.aiPanel is missing setExternalThreads', () => {
    window.aiPanel = { /* no setExternalThreads */ };
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    expect(() => mgr._notifyPanel()).not.toThrow();
  });

  it('survives setExternalThreads throwing without rejecting render', () => {
    const setExternalThreads = vi.fn(() => { throw new Error('boom'); });
    window.aiPanel = { setExternalThreads };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    expect(() => mgr._notifyPanel()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('ExternalCommentManager._fetchAllAndRender → panel handoff', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.aiPanel;
    delete global.fetch;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.aiPanel;
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('pushes the flattened thread list to the panel after a successful fetch+render', async () => {
    buildDiffPane({ lines: [{ line: 10, side: 'RIGHT' }] });

    const threads = [makeComment({ id: 1 }), makeComment({ id: 2 })];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ threads }),
    });

    const setExternalThreads = vi.fn();
    window.aiPanel = { setExternalThreads };

    const mgr = makeManager();
    await mgr._fetchAllAndRender();

    expect(setExternalThreads).toHaveBeenCalledTimes(1);
    const arg = setExternalThreads.mock.calls[0][0];
    expect(arg.map(t => t.id)).toEqual([1, 2]);
  });

  it('still pushes to the panel when one source fetch fails', async () => {
    // Two sources, first fails, second succeeds. Errors are collected and
    // rendering proceeds, so the panel should still see whatever did load.
    let callIdx = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return Promise.resolve({ ok: false, status: 500, json: vi.fn() });
      }
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ threads: [makeComment({ id: 99, source: 'gitlab' })] }),
      });
    });

    const setExternalThreads = vi.fn();
    window.aiPanel = { setExternalThreads };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mgr = makeManager({ sources: ['github', 'gitlab'] });
    await mgr._fetchAllAndRender();

    expect(setExternalThreads).toHaveBeenCalledTimes(1);
    const arg = setExternalThreads.mock.calls[0][0];
    // Only the successful source contributed threads
    expect(arg).toHaveLength(1);
    expect(arg[0].id).toBe(99);
  });
});
