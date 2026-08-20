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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Production code expects `window.renderMarkdown` and `window.toast`; leave
// them off by default so the module's fallback paths are exercised, then
// individual tests can install spies as needed.
const { ExternalCommentManager } = require('../../public/js/modules/external-comment-manager.js');

/**
 * Build a minimal diff-like table with a single file wrapper containing
 * a tbody and rows for the given (lineNumber, side) pairs.
 *
 *   <div class="d2h-file-wrapper" data-file-name=file>
 *     <table>
 *       <tbody>
 *         <tr data-line-number="..." data-side="..." />
 *         ...
 *       </tbody>
 *     </table>
 *   </div>
 */
function buildDiffTable({ file = 'src/app.js', lines = [{ line: 10, side: 'RIGHT' }] } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'd2h-file-wrapper';
  wrapper.dataset.fileName = file;

  const table = document.createElement('table');
  const tbody = document.createElement('tbody');

  const rowsByKey = new Map();
  for (const { line, side } of lines) {
    const tr = document.createElement('tr');
    tr.dataset.lineNumber = String(line);
    tr.dataset.side = side;
    if (side === 'RIGHT') tr.dataset.newLineNumber = String(line);
    if (side === 'LEFT') tr.dataset.oldLineNumber = String(line);
    // Four diff cells to mimic colspan layout (line nums, gutter, code, etc.)
    for (let i = 0; i < 4; i++) tr.appendChild(document.createElement('td'));
    tbody.appendChild(tr);
    rowsByKey.set(`${file}:${line}:${side}`, tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  document.body.appendChild(wrapper);
  return { wrapper, tbody, rowsByKey };
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

/**
 * Mirror FileCommentManager.createFileCommentsZone: a per-file zone with an
 * inner container, inserted at the top of the file wrapper. Both the
 * file-level and the anchor-trust suites render into it.
 */
function addZone(file = 'src/app.js') {
  const wrapper = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
  const zone = document.createElement('div');
  zone.className = 'file-comments-zone';
  zone.dataset.fileName = file;
  const container = document.createElement('div');
  container.className = 'file-comments-container';
  zone.appendChild(container);
  wrapper.insertBefore(zone, wrapper.firstChild);
  return { zone, container };
}

/** A GENUINE file-level comment (GitHub subject_type='file') — no line anchor. */
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

/**
 * @param {Object} [options]
 * @param {boolean} [options.trustPreciseAnchors] - omit for the production
 *   default (true). See the ANCHOR TRUST section of the module header.
 * @param {number|null} [options.anchorPRNumber] - named in the provenance note.
 * @param {string|null} [options.anchorCommitSha] - the commit the rendered diff
 *   IS. Omit (or null) to leave the per-comment gate disarmed, as in PR mode.
 * @param {boolean} [options.trustLeftAnchors] - omit for the production
 *   default (true), i.e. PR mode, where the rendered diff's left side IS the
 *   PR's base commit.
 */
function makeManager({
  reviewId = 'rev-1',
  chatPanel = { open: vi.fn() },
  sources = ['github'],
  trustPreciseAnchors,
  anchorPRNumber,
  anchorCommitSha,
  trustLeftAnchors,
} = {}) {
  return new ExternalCommentManager({
    reviewId,
    chatPanel,
    sources,
    trustPreciseAnchors,
    anchorPRNumber,
    anchorCommitSha,
    trustLeftAnchors,
  });
}

/** A comment on a line the PR REMOVED — numbered against the PR's BASE. */
function leftComment(overrides = {}) {
  return makeComment({ side: 'LEFT', ...overrides });
}

/**
 * The head-side provenance sentence, verbatim. Pinned as a constant so a
 * reworded base-side note can never quietly rewrite the head-side one.
 */
const HEAD_NOTE = 'From PR #42 — these comments were written against a different commit '
  + 'than the code shown here, so this thread appears at file level rather than on its '
  + 'original line.';

/** Externally-settleable promise, for pinning concurrency orderings. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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
    buildDiffTable();
    const mgr = makeManager();
    mgr.threadsBySource.set('github', []);
    await mgr.render();
    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
  });

  it('renders a single root thread after the target diff line', async () => {
    const { rowsByKey } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 7, body: 'Hello' })]);
    await mgr.render();

    const rows = document.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    // Inserted immediately after the target diff row
    expect(target.nextSibling).toBe(rows[0]);
    // Contains exactly one comment element (no replies)
    expect(rows[0].querySelectorAll('.external-comment').length).toBe(1);
    expect(rows[0].querySelector('.external-comment').classList.contains('source-github')).toBe(true);
    // Body text rendered as plaintext (no renderMarkdown installed) — fallback uses textContent
    expect(rows[0].querySelector('.external-comment-body').textContent).toBe('Hello');
  });

  it('renders a root with two replies as nested is-reply elements in one row', async () => {
    const { rowsByKey } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');

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
    expect(target.nextSibling).toBe(rows[0]);

    const thread = rows[0].querySelector('.external-comment-thread');
    const comments = thread.querySelectorAll('.external-comment');
    expect(comments.length).toBe(3);
    expect(comments[0].classList.contains('is-reply')).toBe(false);
    expect(comments[1].classList.contains('is-reply')).toBe(true);
    expect(comments[2].classList.contains('is-reply')).toBe(true);
  });

  it('uses original_line_end and shows outdated badge for outdated threads', async () => {
    // Diff currently shows line 20 — the outdated comment was made against line 20 originally.
    const { rowsByKey } = buildDiffTable({ lines: [{ line: 20, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:20:RIGHT');

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
    expect(target.nextSibling).toBe(rows[0]);
    const c = rows[0].querySelector('.external-comment');
    expect(c.classList.contains('is-outdated')).toBe(true);
    expect(rows[0].querySelector('.external-comment-outdated-badge')).not.toBeNull();
  });

  it('skips threads with no anchor and warns once', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const root = makeComment({ id: 5, line_end: null, original_line_end: null, is_outdated: 0 });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();

    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('renders author as a link when author_url is present and plain text otherwise', async () => {
    const { rowsByKey } = buildDiffTable({ lines: [
      { line: 10, side: 'RIGHT' },
      { line: 11, side: 'RIGHT' },
    ] });
    const mgr = makeManager();
    mgr.threadsBySource.set('github', [
      makeComment({ id: 1, line_start: 10, line_end: 10, author: 'octocat', author_url: 'https://github.com/octocat' }),
      makeComment({ id: 2, line_start: 11, line_end: 11, author: 'ghost', author_url: null }),
    ]);
    await mgr.render();

    expect(rowsByKey.get('src/app.js:10:RIGHT').nextSibling.querySelector('a.external-comment-author').textContent).toBe('octocat');
    expect(rowsByKey.get('src/app.js:11:RIGHT').nextSibling.querySelector('span.external-comment-author').textContent).toBe('ghost');
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 20, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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

  it('removes only external-comment-row rows, leaving user-comment-row and ai-suggestion-row intact', async () => {
    const { rowsByKey, tbody } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');

    // Manually place sibling rows owned by other renderers
    const aiRow = document.createElement('tr');
    aiRow.className = 'ai-suggestion-row';
    const userRow = document.createElement('tr');
    userRow.className = 'user-comment-row';
    tbody.insertBefore(aiRow, target.nextSibling);
    tbody.insertBefore(userRow, aiRow.nextSibling);

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();

    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);

    mgr.clear();

    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
    expect(document.querySelectorAll('.ai-suggestion-row').length).toBe(1);
    expect(document.querySelectorAll('.user-comment-row').length).toBe(1);
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

  it('inserts external-comment-row BELOW pre-existing user-comment-row at the same diff line', async () => {
    const { rowsByKey, tbody } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');

    // Existing user-comment-row sits immediately after the diff line
    const userRow = document.createElement('tr');
    userRow.className = 'user-comment-row';
    tbody.insertBefore(userRow, target.nextSibling);

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();

    const externalRow = document.querySelector('.external-comment-row');
    expect(externalRow).not.toBeNull();
    // Order: target -> userRow -> externalRow
    expect(target.nextSibling).toBe(userRow);
    expect(userRow.nextSibling).toBe(externalRow);
  });

  it('inserts external-comment-row BELOW pre-existing ai-suggestion-row AND user-comment-row at the same diff line', async () => {
    const { rowsByKey, tbody } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');

    const aiRow = document.createElement('tr');
    aiRow.className = 'ai-suggestion-row';
    tbody.insertBefore(aiRow, target.nextSibling);
    const userRow = document.createElement('tr');
    userRow.className = 'user-comment-row';
    tbody.insertBefore(userRow, aiRow.nextSibling);

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();

    const externalRow = document.querySelector('.external-comment-row');
    expect(target.nextSibling).toBe(aiRow);
    expect(aiRow.nextSibling).toBe(userRow);
    expect(userRow.nextSibling).toBe(externalRow);
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    // Ownership released once, by the promise that held it.
    expect(mgr._inflight).toBeNull();
    expect(mgr._inflightIsSync).toBe(false);
  });

  it('syncAndRender: sync failure does not block render — syncError surfaced, render still happens', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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

  // ---------------------------------------------------------------------
  // Asymmetric in-flight rules.
  //
  // A GET-only load may JOIN a sync (the sync's GET is strictly better).
  // The reverse must not: a sync that joined a GET-only load would return
  // that load's result — no POST, no syncResult, no syncError — so the
  // mirror is never synced and the caller fires no toast. It CHAINS
  // instead. `_inflightIsSync` is what tells the two apart.
  // ---------------------------------------------------------------------

  const SYNC_BODY = { count: 1, lostAnchors: 0, deleted: 0, syncedAt: 'now' };

  it('syncAndRender during a GET-only load CHAINS: the POST still fires exactly once', async () => {
    // Regression: it used to return the in-flight GET-only promise, silently
    // skipping the sync — the refresh button appeared to work and did not.
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const threads = [makeComment({ id: 1 })];
    const order = [];
    const getGate = deferred();

    global.fetch = vi.fn(() => {
      order.push('get');
      return getGate.promise.then(() => ({
        ok: true,
        json: vi.fn().mockResolvedValue({ threads }),
      }));
    });
    const syncFn = vi.fn(async () => { order.push('sync'); return SYNC_BODY; });

    const mgr = makeManager({ reviewId: 'r-1' });
    const loadP = mgr.loadAndRender();
    const syncP = mgr.syncAndRender({ syncFn });

    // Distinct promises, and the sync now owns `_inflight` so any later
    // GET-only caller joins the full sync+load rather than the stale load.
    expect(syncP).not.toBe(loadP);
    expect(mgr._inflight).toBe(syncP);
    expect(mgr._inflightIsSync).toBe(true);

    getGate.resolve();
    const [, syncResult] = await Promise.all([loadP, syncP]);

    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(syncResult.syncResult).toEqual(SYNC_BODY);
    expect(syncResult.syncError).toBeNull();
    // The sync waited for the pending load before POSTing, then did its own GET.
    expect(order).toEqual(['get', 'sync', 'get']);
    expect(mgr._inflight).toBeNull();
    expect(mgr._inflightIsSync).toBe(false);
  });

  it('syncAndRender during another syncAndRender JOINS: one POST total', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const threads = [makeComment({ id: 1 })];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ threads }),
    });
    const syncGate = deferred();
    const syncFn = vi.fn(async () => { await syncGate.promise; return SYNC_BODY; });

    const mgr = makeManager({ reviewId: 'r-1' });
    const p1 = mgr.syncAndRender({ syncFn });
    const p2 = mgr.syncAndRender({ syncFn });

    expect(p2).toBe(p1);

    syncGate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(r2);
    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mgr._inflight).toBeNull();
    expect(mgr._inflightIsSync).toBe(false);
  });

  it('a REJECTING in-flight load does not stop the chained sync', async () => {
    // The pending load's failure belongs to its own caller. Swallowing it
    // here is what keeps a refresh from being cancelled by an unrelated
    // rebuild that happened to be in flight.
    const loadGate = deferred();
    const mgr = makeManager({ reviewId: 'r-1' });
    const fetchAndRender = vi.spyOn(mgr, '_fetchAllAndRender')
      .mockImplementationOnce(() => loadGate.promise)
      .mockImplementation(async () => ({ errors: [] }));
    const syncFn = vi.fn(async () => SYNC_BODY);

    const loadP = mgr.loadAndRender();
    const loadSettled = loadP.catch((err) => err);
    const syncP = mgr.syncAndRender({ syncFn });

    loadGate.reject(new Error('load boom'));

    expect(await loadSettled).toMatchObject({ message: 'load boom' });
    const syncResult = await syncP;

    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(syncResult.syncResult).toEqual(SYNC_BODY);
    expect(fetchAndRender).toHaveBeenCalledTimes(2);
    expect(mgr._inflight).toBeNull();
    expect(mgr._inflightIsSync).toBe(false);
  });

  it('the losing load does not clear `_inflight` out from under the sync that chained onto it', async () => {
    // Ownership hazard: both `.finally()` handlers clear `_inflight`, so
    // each must first check the promise is still its own. Otherwise the
    // load's completion would blank the sync's slot and a third caller
    // would start a duplicate round-trip.
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const threads = [makeComment({ id: 1 })];
    const getGate = deferred();
    global.fetch = vi.fn(() => getGate.promise.then(() => ({
      ok: true,
      json: vi.fn().mockResolvedValue({ threads }),
    })));
    const syncGate = deferred();
    const syncFn = vi.fn(async () => { await syncGate.promise; return SYNC_BODY; });

    const mgr = makeManager({ reviewId: 'r-1' });
    const loadP = mgr.loadAndRender();
    const syncP = mgr.syncAndRender({ syncFn });

    // Let the first load settle while the sync is still working.
    getGate.resolve();
    await loadP;
    expect(mgr._inflight).toBe(syncP);

    // A GET-only caller arriving now must join the sync, not start a race.
    const joiner = mgr.loadAndRender();
    expect(joiner).toBe(syncP);

    syncGate.resolve();
    await Promise.all([syncP, joiner]);

    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(mgr._inflight).toBeNull();
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

  it('calls prManager.ensureLinesVisible with items-array shape, awaits it, then re-looks-up', async () => {
    // Regression: the call previously used positional args and wasn't
    // awaited. Production PRManager.ensureLinesVisible takes an array of
    // `{file, line_start, line_end, side}` items and returns a Promise.
    // If the call isn't awaited the row isn't in the DOM at re-lookup time.
    const { wrapper, tbody, rowsByKey } = buildDiffTable({ lines: [{ line: 30, side: 'RIGHT' }] });
    const target30 = rowsByKey.get('src/app.js:30:RIGHT');

    let expandedRow = null;
    let ensureLinesVisibleResolved = false;
    window.prManager = {
      ensureLinesVisible: vi.fn(async (items) => {
        // Defer DOM mutation to the next microtask so the test would FAIL
        // if the production code forgot to await this Promise — the
        // re-lookup would run before this hook materializes the row.
        await Promise.resolve();
        const item = Array.isArray(items) ? items[0] : null;
        if (!item) return;
        const tr = document.createElement('tr');
        tr.dataset.lineNumber = String(item.line_start);
        tr.dataset.side = (item.side || 'RIGHT').toString();
        tr.dataset.newLineNumber = String(item.line_start);
        for (let i = 0; i < 4; i++) tr.appendChild(document.createElement('td'));
        tbody.insertBefore(tr, target30);
        expandedRow = tr;
        ensureLinesVisibleResolved = true;
      }),
    };

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

    // Production contract: items-array call shape, awaited so the new row
    // is in the DOM before re-lookup.
    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledTimes(1);
    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'src/app.js', line_start: 20, line_end: 20, side: 'RIGHT' }
    ]);
    expect(ensureLinesVisibleResolved).toBe(true);

    const rows = document.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    expect(expandedRow.nextSibling).toBe(rows[0]);
    expect(wrapper.contains(rows[0])).toBe(true);
  });

  it('falls back to file-level when ensureLinesVisible cannot materialize the anchor', async () => {
    // Diff has no anchor row for the target line; ensureLinesVisible is a no-op.
    const { wrapper } = buildDiffTable({ lines: [{ line: 999, side: 'RIGHT' }] });
    window.prManager = {
      ensureLinesVisible: vi.fn(async () => {}),
    };

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
// Pierre (@pierre/diffs) rendering path
//
// On the pierre-diffs branch, normal diff files render into a shadow-DOM
// container with NO light-DOM <tr> rows, so external threads mount as
// 'external-comment' annotations via PierreBridge instead of injected
// table rows. These tests stub a minimal bridge (the real bridge needs the
// @pierre/diffs vendor bundle + a live worker pool) that mirrors the two
// behaviors the manager depends on: it invokes the registered renderer and
// slots the returned <div> into the file's light-DOM container, and it
// tracks annotations so removeAnnotationsByType un-slots them.
// =======================================================================

/**
 * Build a fake PierreBridge over `files`, plus the `.d2h-file-wrapper` +
 * light-DOM container each file's annotations slot into. `slots: false`
 * makes addAnnotation a no-op reslot (simulating an anchor line that never
 * rendered) so the manager's file-level fallback path can be exercised.
 */
function makePierreBridge({ files = ['src/app.js'], slots = true } = {}) {
  const renderers = new Map();
  const annotationsByFile = new Map();
  const fileMap = new Map();

  const reslot = (file) => {
    if (!slots) return;
    const { container } = fileMap.get(file);
    container.querySelectorAll('.external-comment-row').forEach((r) => r.remove());
    for (const ann of annotationsByFile.get(file)) {
      const fn = renderers.get(ann.type);
      if (!fn) continue;
      const el = fn(ann.data, ann.id, file);
      if (el) container.appendChild(el);
    }
  };

  for (const f of files) {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = f;
    const container = document.createElement('div');
    container.className = 'pierre-diff-body';
    wrapper.appendChild(container);
    document.body.appendChild(wrapper);
    annotationsByFile.set(f, []);
    fileMap.set(f, { container });
  }

  return {
    files: fileMap,
    registerAnnotationRenderer: vi.fn((type, fn) => renderers.set(type, fn)),
    addAnnotation: vi.fn((file, ann) => {
      annotationsByFile.get(file).push(ann);
      reslot(file);
    }),
    removeAnnotation: vi.fn((file, id) => {
      annotationsByFile.set(file, annotationsByFile.get(file).filter((a) => a.id !== id));
      reslot(file);
    }),
    removeAnnotationsByType: vi.fn((file, type) => {
      annotationsByFile.set(file, annotationsByFile.get(file).filter((a) => a.type !== type));
      reslot(file);
    }),
    getAnnotations: vi.fn((file, type) =>
      annotationsByFile.get(file).filter((a) => !type || a.type === type)),
  };
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

    // Legacy <tr> path was NOT taken — the anchor is a pierre file.
    expect(bridge.addAnnotation).toHaveBeenCalledTimes(1);
    const [file, ann] = bridge.addAnnotation.mock.calls[0];
    expect(file).toBe('src/app.js');
    expect(ann.type).toBe('external-comment');
    expect(ann.side).toBe('RIGHT');
    expect(ann.lineNumber).toBe(10);
    expect(ann.data.id).toBe(7);

    // The slotted element is a <div> (not a <tr>) carrying the shared class
    // + data attributes, inside the file's light-DOM container.
    const row = document.querySelector('.external-comment-row');
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
    bridge.addAnnotation.mockImplementation(() => { order.push('add'); });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();

    expect(ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'src/app.js', line_start: 10, line_end: 10, side: 'RIGHT' },
    ]);
    expect(order).toEqual(['ensure', 'add']);
  });

  it('routes a lazily-registered (not yet rendered) pierre file to the pierre path', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    // Simulate lazy rendering: the body has not rendered yet, so the file is
    // absent from bridge.files — only the PR manager's lazy registry knows
    // it will render via pierre.
    const entry = bridge.files.get('src/app.js');
    bridge.files.delete('src/app.js');
    // ensureLinesVisible materializes the body (re-inserting the bridge
    // entry), mirroring PRManager.ensureLinesVisible → ensureFileBodyRendered.
    const ensureLinesVisible = vi.fn(async () => {
      bridge.files.set('src/app.js', entry);
    });
    window.prManager = {
      pierreBridge: bridge,
      ensureLinesVisible,
      _lazyFileBodies: new Map([['src/app.js', { pierre: true, rendered: false }]]),
    };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 42, body: 'lazy body' })]);
    await mgr.render();

    // Routed to the pierre path (materialize first, then annotate) — not the
    // legacy <tr> lookup, and no rollback into the file-level fallback.
    expect(ensureLinesVisible).toHaveBeenCalledTimes(1);
    expect(bridge.addAnnotation).toHaveBeenCalledTimes(1);
    expect(bridge.addAnnotation.mock.calls[0][0]).toBe('src/app.js');
    expect(bridge.removeAnnotation).not.toHaveBeenCalled();
    const row = document.querySelector('.external-comment-row');
    expect(row).not.toBeNull();
    expect(row.dataset.threadId).toBe('42');
  });

  it('_isPierreFile: rendered and lazy pierre files are pierre; others are not', () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = {
      pierreBridge: bridge,
      _lazyFileBodies: new Map([
        ['src/lazy.js', { pierre: true, rendered: false }],
        ['src/legacy.js', { pierre: false }],
      ]),
    };
    const mgr = makeManager();
    expect(mgr._isPierreFile('src/app.js')).toBe(true); // in bridge.files
    expect(mgr._isPierreFile('src/lazy.js')).toBe(true); // lazy registry, pierre:true
    expect(mgr._isPierreFile('src/legacy.js')).toBe(false);
    expect(mgr._isPierreFile('src/unknown.js')).toBe(false);
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
    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);

    mgr.clear();
    expect(bridge.removeAnnotationsByType).toHaveBeenCalledWith('src/app.js', 'external-comment');
    // Un-slotted by the bridge's rerender — nothing left in the DOM.
    expect(document.querySelectorAll('.external-comment-row').length).toBe(0);
  });

  it('re-render replaces rather than duplicates (clear + re-add yields one row)', async () => {
    const bridge = makePierreBridge({ files: ['src/app.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1 })]);
    await mgr.render();
    await mgr.render();

    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);
  });

  it('falls back to a file-level div when the annotation never slots', async () => {
    // slots:false → addAnnotation stores the annotation but never renders a
    // row, simulating an anchor line absent from the diff. The manager should
    // roll the annotation back and append a file-level fallback card.
    const bridge = makePierreBridge({ files: ['src/app.js'], slots: false });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 3 })]);
    await mgr.render();

    expect(bridge.removeAnnotation).toHaveBeenCalledTimes(1);
    const wrapper = document.querySelector('.d2h-file-wrapper[data-file-name="src/app.js"]');
    const fallback = wrapper.querySelector('.external-comment-row.external-comment-row--file-fallback');
    expect(fallback).not.toBeNull();
    expect(fallback.dataset.threadId).toBe('3');
  });

  it('routes to the legacy <tr> path for files NOT rendered by pierre', async () => {
    // Bridge exists but only knows about a different file; the thread's file
    // is legacy-rendered, so it must take the <tr> injection path.
    const bridge = makePierreBridge({ files: ['other/file.js'] });
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };
    const { rowsByKey } = buildDiffTable({ file: 'src/app.js', lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [makeComment({ id: 1, file: 'src/app.js' })]);
    await mgr.render();

    expect(bridge.addAnnotation).not.toHaveBeenCalled();
    const row = document.querySelector('.external-comment-row');
    expect(row.tagName).toBe('TR');
    expect(target.nextSibling).toBe(row);
  });
});

// =======================================================================
// File-level threads (GitHub subject_type='file')
//
// File-level comments have no line anchor. They render into the per-file
// `.file-comments-zone` above the diff (shared light DOM for both engines),
// NOT as a line-1 annotation. Unanchorable line threads (outdated / dropped
// line) fall back into the SAME zone when one exists.
// =======================================================================
describe('ExternalCommentManager file-level threads', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
    vi.restoreAllMocks();
  });

  it('renders a file-level thread into the zone, not as a diff-line row', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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

    // The diff line must NOT have gained a sibling comment row.
    const diffRow = document.querySelector('tr[data-line-number="10"]');
    expect(diffRow.nextSibling).toBeNull();
  });

  it('renders a file-level thread with replies as one zone card', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    window.prManager = { pierreBridge: bridge, ensureLinesVisible: vi.fn(async () => {}) };
    const { container } = addZone('src/app.js');

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [fileLevelComment({ id: 5 })]);
    await mgr.render();

    // File-level never mounts as an annotation — straight to the light-DOM zone.
    expect(bridge.addAnnotation).not.toHaveBeenCalled();
    expect(container.querySelector('.external-comment-row--file-level')).not.toBeNull();
  });

  it('resolves the zone via prManager.fileCommentManager.findZoneForFile when present', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const { zone, container } = addZone('src/app.js');
    const findZoneForFile = vi.fn(() => zone);
    window.prManager = { fileCommentManager: { findZoneForFile } };

    const mgr = makeManager();
    mgr.threadsBySource.set('github', [fileLevelComment({ id: 8 })]);
    await mgr.render();

    expect(findZoneForFile).toHaveBeenCalledWith('src/app.js');
    expect(container.querySelector('.external-comment-row--file-level')).not.toBeNull();
  });

  it('unanchorable line thread falls back into the zone (not a faked line-1 row)', async () => {
    buildDiffTable({ lines: [{ line: 999, side: 'RIGHT' }] });
    const { container } = addZone('src/app.js');
    window.prManager = { ensureLinesVisible: vi.fn(async () => {}) };

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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    const { wrapper } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });

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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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
    buildDiffTable({ lines: [{ line: 5, side: 'LEFT' }] });
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
    buildDiffTable({ lines: [{ line: 5, side: 'LEFT' }] });
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
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

// =======================================================================
// ANCHOR TRUST (local mode)
//
// A comment's (file, line, side) was resolved against the PR head commit.
// In PR mode the rendered diff IS that commit. In local mode it is the
// working tree against a base, so the same line number can point at
// different content — and `_findDiffLineRow` matches on the number alone,
// which would anchor confidently to the wrong line. When the caller reports
// `trustPreciseAnchors: false`, every LINE thread degrades into the file
// zone carrying a provenance note; genuine file-level threads are untouched
// because they never had a line anchor to lose.
//
// See plans/bridge-local-and-pr-modes.md decision 8.
// =======================================================================
describe('ExternalCommentManager anchor trust', async () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
    vi.restoreAllMocks();
  });

  it('trusted (default): a line thread anchors to its diff row with no provenance note', async () => {
    const { rowsByKey } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');
    const { container } = addZone('src/app.js');

    const mgr = makeManager({ anchorPRNumber: 42 });
    expect(mgr.trustPreciseAnchors).toBe(true);
    const comment = makeComment({ id: 11, body: 'precise' });
    expect(mgr._resolveAnchor(comment)).toEqual({ file: 'src/app.js', line: 10, side: 'RIGHT' });

    mgr.threadsBySource.set('github', [comment]);
    await mgr.render();

    const rows = document.querySelectorAll('.external-comment-row');
    expect(rows.length).toBe(1);
    expect(rows[0].tagName).toBe('TR');
    expect(target.nextSibling).toBe(rows[0]);
    // Nothing degraded, nothing in the file zone, no provenance note.
    expect(container.querySelector('.external-comment-row')).toBeNull();
    expect(document.querySelector('.external-comment-provenance')).toBeNull();
  });

  it('untrusted: the same line thread degrades into the file zone with a provenance note', async () => {
    const { rowsByKey } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');
    const { container } = addZone('src/app.js');

    const mgr = makeManager({ trustPreciseAnchors: false, anchorPRNumber: 42 });
    const comment = makeComment({ id: 11, body: 'approximate' });
    expect(mgr._resolveAnchor(comment)).toEqual({
      file: 'src/app.js',
      fileLevel: true,
      degraded: true,
    });

    mgr.threadsBySource.set('github', [comment]);
    await mgr.render();

    const card = container.querySelector('.external-comment-row');
    expect(card).not.toBeNull();
    // Degraded, NOT a genuine file-level comment — the classes differ so CSS
    // and the reviewer can tell the two apart.
    expect(card.classList.contains('external-comment-row--anchor-degraded')).toBe(true);
    expect(card.classList.contains('external-comment-row--file-level')).toBe(false);
    expect(card.dataset.threadId).toBe('11');
    // The line it *claimed* must not have gained a row.
    expect(target.nextSibling).toBeNull();

    const note = card.querySelector('.external-comment-provenance');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('PR #42');
    expect(note.textContent).toContain('file level');
  });

  it('untrusted: a GENUINE file-level thread keeps --file-level and gets NO note', async () => {
    // It never had a line anchor, so nothing about its placement is
    // approximate — claiming otherwise would be noise on every such thread.
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const { container } = addZone('src/app.js');

    const mgr = makeManager({ trustPreciseAnchors: false, anchorPRNumber: 42 });
    const comment = fileLevelComment({ id: 13, body: 'whole file' });
    expect(mgr._resolveAnchor(comment)).toEqual({ file: 'src/app.js', fileLevel: true });

    mgr.threadsBySource.set('github', [comment]);
    await mgr.render();

    const card = container.querySelector('.external-comment-row');
    expect(card.classList.contains('external-comment-row--file-level')).toBe(true);
    expect(card.classList.contains('external-comment-row--anchor-degraded')).toBe(false);
    expect(card.querySelector('.external-comment-provenance')).toBeNull();
  });

  it('untrusted with an unknown PR number: the note says "the associated PR"', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const { container } = addZone('src/app.js');

    const mgr = makeManager({ trustPreciseAnchors: false, anchorPRNumber: null });
    mgr.threadsBySource.set('github', [makeComment({ id: 14 })]);
    await mgr.render();

    const note = container.querySelector('.external-comment-provenance');
    expect(note.textContent).toContain('the associated PR');
    expect(note.textContent).not.toContain('PR #');
  });

  // Partial-update setter over four independent fields. The rule is the same
  // for all of them — present means apply, absent means leave alone — so it is
  // pinned once here rather than re-permuted inside each gate's suite.
  describe('setAnchorContext', () => {
    it('applies each field that is present', () => {
      const mgr = makeManager();
      mgr.setAnchorContext({
        trustPreciseAnchors: false,
        trustLeftAnchors: false,
        prNumber: 5,
        commitSha: 'sha-local',
      });
      expect(mgr.trustPreciseAnchors).toBe(false);
      expect(mgr.trustLeftAnchors).toBe(false);
      expect(mgr.anchorPRNumber).toBe(5);
      expect(mgr.anchorCommitSha).toBe('sha-local');
    });

    it('leaves every OMITTED field untouched', () => {
      // The caller may learn the PR number before it can compare head SHAs,
      // and arms the per-comment gate later still.
      const mgr = makeManager({
        trustPreciseAnchors: false,
        trustLeftAnchors: false,
        anchorPRNumber: 1,
        anchorCommitSha: 'sha-local',
      });

      mgr.setAnchorContext({ prNumber: 9 });

      expect(mgr.anchorPRNumber).toBe(9);
      expect(mgr.trustPreciseAnchors).toBe(false);
      expect(mgr.trustLeftAnchors).toBe(false);
      expect(mgr.anchorCommitSha).toBe('sha-local');

      // ...and the reverse direction: trusting flags stay true.
      const trusting = makeManager({ anchorPRNumber: 3 });
      trusting.setAnchorContext({ prNumber: 9 });
      expect(trusting.trustPreciseAnchors).toBe(true);
      expect(trusting.trustLeftAnchors).toBe(true);
    });

    it('an explicit null clears the PR number and disarms the commit gate', () => {
      const mgr = makeManager({ anchorPRNumber: 3, anchorCommitSha: 'sha-local' });
      mgr.setAnchorContext({ prNumber: null, commitSha: null });
      expect(mgr.anchorPRNumber).toBeNull();
      expect(mgr.anchorCommitSha).toBeNull();
    });
  });

  it('re-render after a context flip re-decides placement (nothing latches per thread)', async () => {
    // The capability and the head_sha comparison can both land AFTER the
    // first paint (association backfill, cold metadata cache), so a second
    // render with a different context must move the thread — in both
    // directions.
    const { rowsByKey } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const target = rowsByKey.get('src/app.js:10:RIGHT');
    const { container } = addZone('src/app.js');

    const mgr = makeManager({ anchorPRNumber: 42 });
    mgr.threadsBySource.set('github', [makeComment({ id: 15 })]);

    await mgr.render();
    expect(target.nextSibling).not.toBeNull();
    expect(container.querySelector('.external-comment-row')).toBeNull();

    // Trust withdrawn: render() clears first, so the row moves to the zone.
    mgr.setAnchorContext({ trustPreciseAnchors: false });
    await mgr.render();
    expect(target.nextSibling).toBeNull();
    expect(container.querySelector('.external-comment-row--anchor-degraded')).not.toBeNull();
    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);

    // Trust restored (e.g. the user committed and local HEAD now matches).
    mgr.setAnchorContext({ trustPreciseAnchors: true });
    await mgr.render();
    expect(target.nextSibling).not.toBeNull();
    expect(container.querySelector('.external-comment-row')).toBeNull();
    expect(document.querySelector('.external-comment-provenance')).toBeNull();
    expect(document.querySelectorAll('.external-comment-row').length).toBe(1);
  });

  // ---------------------------------------------------------------------
  // GATE 2 — per-comment commit sha.
  //
  // Gate 1 compares two page-load snapshots (local HEAD cached on currentPR;
  // the PR's head_sha from the TTL-less pr_metadata cache), so a PR that
  // advances mid-session still looks like a match. Each synced row carries
  // the commit it was anchored to, fetched fresh, so the manager can catch
  // that per thread. Armed only when the caller supplies `commitSha`.
  // ---------------------------------------------------------------------
  describe('gate 2: per-comment commit sha', () => {
    it('disarmed (no anchorCommitSha): a mismatched commit_sha STILL anchors precisely', () => {
      // PR-mode parity guarantee. The diff IS the PR head there, so the
      // per-comment check must never fire and change existing behaviour.
      const mgr = makeManager();
      expect(mgr.anchorCommitSha).toBeNull();

      const anchor = mgr._resolveAnchor(makeComment({
        commit_sha: 'somewhere-else',
        original_commit_sha: 'somewhere-else',
      }));

      expect(anchor).toEqual({ file: 'src/app.js', line: 10, side: 'RIGHT' });
    });

    it('armed + mismatched commit_sha degrades WHILE trustPreciseAnchors is still true', async () => {
      // The entire point of the second gate: gate 1 says "same commit"
      // because both its operands are stale, and only the row's own sha
      // knows better.
      const { rowsByKey } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
      const target = rowsByKey.get('src/app.js:10:RIGHT');
      const { container } = addZone('src/app.js');

      const mgr = makeManager({ anchorCommitSha: 'sha-local', anchorPRNumber: 8 });
      expect(mgr.trustPreciseAnchors).toBe(true);

      const comment = makeComment({
        id: 21,
        commit_sha: 'sha-pr-moved-on',
        original_commit_sha: 'sha-pr-moved-on',
      });
      expect(mgr._resolveAnchor(comment)).toEqual({
        file: 'src/app.js',
        fileLevel: true,
        degraded: true,
      });

      mgr.threadsBySource.set('github', [comment]);
      await mgr.render();

      const card = container.querySelector('.external-comment-row');
      expect(card.classList.contains('external-comment-row--anchor-degraded')).toBe(true);
      expect(target.nextSibling).toBeNull();
      // The note is re-derived from the same predicate, so it appears for a
      // gate-2 degrade exactly as it does for gate 1.
      expect(card.querySelector('.external-comment-provenance').textContent).toContain('PR #8');
      // Session-level trust was never touched.
      expect(mgr.trustPreciseAnchors).toBe(true);
    });

    it('armed + a row carrying no commit shas: gate 1 answer stands (trusted)', () => {
      // Upstream recorded no commit for the row — there is nothing to
      // contradict gate 1, so degrading would be guessing.
      const mgr = makeManager({ anchorCommitSha: 'sha-local' });

      const anchor = mgr._resolveAnchor(makeComment({
        commit_sha: null,
        original_commit_sha: null,
      }));

      expect(anchor).toEqual({ file: 'src/app.js', line: 10, side: 'RIGHT' });
    });

    it('outdated row compares original_commit_sha, not commit_sha', () => {
      // `_resolveAnchor` prefers the ORIGINAL line for an outdated row, so
      // the commit checked must be the one that owns that line.
      const mgr = makeManager({ anchorCommitSha: 'sha-local' });

      // Original matches (live does not) → the line we picked is trustworthy.
      expect(mgr._resolveAnchor(makeComment({
        is_outdated: 1,
        line_end: null,
        original_line_end: 20,
        commit_sha: 'sha-other',
        original_commit_sha: 'sha-local',
      }))).toEqual({ file: 'src/app.js', line: 20, side: 'RIGHT' });

      // Inverted: the live sha matches but the ORIGINAL one doesn't, and the
      // original is the anchor being used → degrade.
      expect(mgr._resolveAnchor(makeComment({
        is_outdated: 1,
        line_end: null,
        original_line_end: 20,
        commit_sha: 'sha-local',
        original_commit_sha: 'sha-other',
      }))).toEqual({ file: 'src/app.js', fileLevel: true, degraded: true });
    });

    it('non-outdated row falls back to original_commit_sha when commit_sha is missing', () => {
      const mgr = makeManager({ anchorCommitSha: 'sha-local' });

      expect(mgr._resolveAnchor(makeComment({
        is_outdated: 0,
        commit_sha: null,
        original_commit_sha: 'sha-local',
      }))).toEqual({ file: 'src/app.js', line: 10, side: 'RIGHT' });

      expect(mgr._resolveAnchor(makeComment({
        is_outdated: 0,
        commit_sha: null,
        original_commit_sha: 'sha-other',
      }))).toEqual({ file: 'src/app.js', fileLevel: true, degraded: true });
    });

    it('gate 1 false beats a matching per-comment sha', () => {
      // The gates are independent and both fail-safe: either can degrade.
      const mgr = makeManager({ trustPreciseAnchors: false, anchorCommitSha: 'sha-local' });

      expect(mgr._resolveAnchor(makeComment({ commit_sha: 'sha-local' }))).toEqual({
        file: 'src/app.js',
        fileLevel: true,
        degraded: true,
      });
    });

  });

  describe('gate 3: LEFT-side anchors and the PR base', () => {
    // A diff has a base AND a head. RIGHT numbers come from the head; LEFT
    // numbers (comments on removed lines) come from the BASE. Gates 1 and 2
    // only ever compare heads, so LEFT needs its own gate.

    it('defaults to true, so a manager that never got the field behaves exactly as before', () => {
      // PR-mode parity: the caller passes `trustLeftAnchors: true` there, and
      // an older/partial caller passes nothing at all. Both must anchor LEFT
      // threads precisely, as they always have.
      const bare = new ExternalCommentManager({ reviewId: 'rev-1' });
      expect(bare.trustLeftAnchors).toBe(true);

      const mgr = makeManager({ anchorPRNumber: 42 });
      expect(mgr.trustLeftAnchors).toBe(true);
      expect(mgr._anchorDegradeReason(leftComment(), false)).toBeNull();
      expect(mgr._anchorTrusted(leftComment(), false)).toBe(true);
      expect(mgr._resolveAnchor(leftComment())).toEqual({
        file: 'src/app.js', line: 10, side: 'LEFT',
      });
    });

    it("LEFT degrades with reason 'base' when trustLeftAnchors is false EVEN THOUGH the heads match", () => {
      // The exact hole this gate closes: both head-side gates are satisfied
      // (session trust on, per-comment sha equal to the rendered commit) and
      // the anchor is still meaningless, because our left side is a
      // different base.
      const mgr = makeManager({
        trustPreciseAnchors: true,
        anchorCommitSha: 'sha-local',
        trustLeftAnchors: false,
      });
      const left = leftComment({ commit_sha: 'sha-local', original_commit_sha: 'sha-local' });

      expect(mgr.trustPreciseAnchors).toBe(true);
      expect(mgr._anchorDegradeReason(left, false)).toBe('base');
      expect(mgr._anchorTrusted(left, false)).toBe(false);
      expect(mgr._resolveAnchor(left)).toEqual({
        file: 'src/app.js', fileLevel: true, degraded: true,
      });
    });

    it('a comment with no explicit side counts as RIGHT and ignores the base gate', () => {
      const mgr = makeManager({ trustLeftAnchors: false });
      const sideless = makeComment({ side: null });
      expect(mgr._anchorDegradeReason(sideless, false)).toBeNull();
      expect(mgr._resolveAnchor(sideless)).toEqual({
        file: 'src/app.js', line: 10, side: 'RIGHT',
      });
    });

    it("head-side gates answer first: a head mismatch on a LEFT comment reports 'head'", () => {
      // Ordering matters for the note wording — when the heads genuinely
      // disagree, that is the honest explanation even for a LEFT comment.
      const gate1 = makeManager({ trustPreciseAnchors: false, trustLeftAnchors: false });
      expect(gate1._anchorDegradeReason(leftComment(), false)).toBe('head');

      const gate2 = makeManager({ anchorCommitSha: 'sha-local', trustLeftAnchors: false });
      expect(gate2._anchorDegradeReason(
        leftComment({ commit_sha: 'sha-elsewhere', original_commit_sha: 'sha-elsewhere' }),
        false
      )).toBe('head');
    });

    it('trustLeftAnchors false + heads matching: LEFT degrades, RIGHT anchors — in one render', async () => {
      const { rowsByKey } = buildDiffTable({
        lines: [{ line: 10, side: 'RIGHT' }, { line: 10, side: 'LEFT' }],
      });
      const rightRow = rowsByKey.get('src/app.js:10:RIGHT');
      const leftRow = rowsByKey.get('src/app.js:10:LEFT');
      const { container } = addZone('src/app.js');

      const mgr = makeManager({ trustLeftAnchors: false, anchorPRNumber: 42 });
      mgr.threadsBySource.set('github', [
        makeComment({ id: 30, body: 'on the head side' }),
        leftComment({ id: 31, body: 'on a removed line' }),
      ]);
      await mgr.render();

      // RIGHT thread: precise row anchor, no note.
      expect(rightRow.nextSibling).not.toBeNull();
      expect(rightRow.nextSibling.dataset.threadId).toBe('30');
      expect(rightRow.nextSibling.querySelector('.external-comment-provenance')).toBeNull();

      // LEFT thread: nothing on the line it claimed, a degraded zone card.
      expect(leftRow.nextSibling).toBeNull();
      const card = container.querySelector('.external-comment-row');
      expect(card.dataset.threadId).toBe('31');
      expect(card.classList.contains('external-comment-row--anchor-degraded')).toBe(true);
      expect(card.querySelector('.external-comment-provenance')).not.toBeNull();
    });

    describe('provenance note wording', () => {
      it('the base-side note names the BASE and does not assert a head mismatch', async () => {
        buildDiffTable({ lines: [{ line: 10, side: 'LEFT' }] });
        const { container } = addZone('src/app.js');

        const mgr = makeManager({ trustLeftAnchors: false, anchorPRNumber: 42 });
        mgr.threadsBySource.set('github', [leftComment({ id: 33 })]);
        await mgr.render();

        const text = container.querySelector('.external-comment-provenance').textContent;
        expect(text).toContain('PR #42');
        expect(text).toContain('base commit');
        expect(text).toContain('removed');
        expect(text).toContain('file level');
        // The heads DO agree here — saying otherwise would be a false claim.
        expect(text).not.toContain('written against a different commit');
        expect(text).not.toBe(HEAD_NOTE);
      });

      it('the head-side note keeps its existing wording verbatim', async () => {
        buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
        const { container } = addZone('src/app.js');

        const mgr = makeManager({ trustPreciseAnchors: false, anchorPRNumber: 42 });
        mgr.threadsBySource.set('github', [makeComment({ id: 34 })]);
        await mgr.render();

        expect(container.querySelector('.external-comment-provenance').textContent).toBe(HEAD_NOTE);
      });
    });
  });

  it('untrusted threads still land somewhere when the file has no comments zone', async () => {
    // Last-resort wrapper append — degraded placement must never mean a
    // dropped thread.
    const { wrapper } = buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });

    const mgr = makeManager({ trustPreciseAnchors: false, anchorPRNumber: 42 });
    mgr.threadsBySource.set('github', [makeComment({ id: 16 })]);
    await mgr.render();

    const card = wrapper.querySelector('.external-comment-row--anchor-degraded');
    expect(card).not.toBeNull();
    expect(card.querySelector('.external-comment-provenance')).not.toBeNull();
  });
});

describe('ExternalCommentManager chat context anchor trust', async () => {
  // The card can degrade a thread to file level and STILL hand the agent
  // PR-head coordinates through the chat button, because ChatPanel treats
  // `line_start`/`line_end` as authoritative against the LOCAL diff: it
  // quotes the local patch at those numbers (DiffContext.extractHunkForLines)
  // and asserts `file:line` in the prompt header. So the chat hooks must ride
  // the same gate the placement did.
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.prManager;
    vi.restoreAllMocks();
  });

  /** Render a thread (root + one reply) and return the two chat buttons. */
  async function renderThreadWithReply(mgr, root) {
    mgr.threadsBySource.set('github', [root]);
    await mgr.render();
    return {
      replyBtn: document.querySelector('.external-comment.is-reply .external-comment-chat-btn'),
      rootBtn: document.querySelector('.external-comment:not(.is-reply) .external-comment-chat-btn'),
    };
  }

  function rootWithReply(overrides = {}, replyOverrides = {}) {
    return makeComment({
      id: 1,
      body: 'root body',
      replies: [makeComment({ id: 42, body: 'reply body', parent_id: 1, ...replyOverrides })],
      ...overrides,
    });
  }

  it('trusted: the comment payload is unchanged — lines pass through, no extra fields', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel, anchorPRNumber: 42 });

    const { replyBtn } = await renderThreadWithReply(mgr, rootWithReply());
    replyBtn.click();

    const ctx = chatPanel.open.mock.calls[0][0].commentContext;
    expect(ctx.line_start).toBe(10);
    expect(ctx.line_end).toBe(10);
    expect(ctx).not.toHaveProperty('isFileLevel');
    expect(ctx).not.toHaveProperty('anchorNote');
  });

  it('untrusted (head gate): the comment payload nulls the lines and goes file-scoped', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    addZone('src/app.js');
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel, trustPreciseAnchors: false, anchorPRNumber: 42 });

    const { replyBtn } = await renderThreadWithReply(mgr, rootWithReply());
    replyBtn.click();

    const ctx = chatPanel.open.mock.calls[0][0].commentContext;
    expect(ctx.line_start).toBeNull();
    expect(ctx.line_end).toBeNull();
    // ChatPanel honours `isFileLevel` on the comment path (it skips
    // extractHunkForLines and labels the scope), so say so explicitly.
    expect(ctx.isFileLevel).toBe(true);
    expect(ctx.anchorNote).toBe(HEAD_NOTE);
    // Everything else still flows.
    expect(ctx.file).toBe('src/app.js');
    expect(ctx.commentId).toBe(42);
    expect(ctx.body).toBe('reply body');
  });

  it('untrusted (base gate, LEFT): the comment payload nulls the lines and explains the base', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'LEFT' }] });
    addZone('src/app.js');
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel, trustLeftAnchors: false, anchorPRNumber: 42 });

    const { replyBtn } = await renderThreadWithReply(
      mgr,
      rootWithReply({ side: 'LEFT' }, { side: 'LEFT' })
    );
    replyBtn.click();

    const ctx = chatPanel.open.mock.calls[0][0].commentContext;
    expect(ctx.side).toBe('LEFT');
    expect(ctx.line_start).toBeNull();
    expect(ctx.line_end).toBeNull();
    expect(ctx.isFileLevel).toBe(true);
    expect(ctx.anchorNote).toContain('base commit');
    expect(ctx.anchorNote).not.toContain('written against a different commit');
  });

  it('a GENUINE file-level comment is file-scoped with no provenance note', async () => {
    // It never had a line anchor, so nothing is approximate — but ChatPanel
    // should still be told the scope rather than left to infer it from a
    // null line number.
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    addZone('src/app.js');
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel, anchorPRNumber: 42 });

    const root = fileLevelComment({
      id: 1,
      replies: [fileLevelComment({ id: 43, body: 'file reply', parent_id: 1 })],
    });
    const { replyBtn } = await renderThreadWithReply(mgr, root);
    replyBtn.click();

    const ctx = chatPanel.open.mock.calls[0][0].commentContext;
    expect(ctx.line_start).toBeNull();
    expect(ctx.line_end).toBeNull();
    expect(ctx.isFileLevel).toBe(true);
    expect(ctx).not.toHaveProperty('anchorNote');
  });

  it('trusted: the thread payload is unchanged — lines pass through, no note', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel, anchorPRNumber: 42 });

    const { rootBtn } = await renderThreadWithReply(mgr, rootWithReply());
    rootBtn.click();

    const ctx = chatPanel.open.mock.calls[0][0].threadContext;
    expect(ctx.line_start).toBe(10);
    expect(ctx.line_end).toBe(10);
    expect(ctx).not.toHaveProperty('anchorNote');
  });

  it('untrusted (head gate): the thread payload nulls the lines', async () => {
    // `_sendThreadContextMessage` has NO isFileLevel guard — it keys its hunk
    // extraction and its `file:line` header purely on `line_start` — so on
    // this path the lines must actually be null.
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    addZone('src/app.js');
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel, trustPreciseAnchors: false, anchorPRNumber: 42 });

    const { rootBtn } = await renderThreadWithReply(mgr, rootWithReply());
    rootBtn.click();

    const ctx = chatPanel.open.mock.calls[0][0].threadContext;
    expect(ctx.line_start).toBeNull();
    expect(ctx.line_end).toBeNull();
    expect(ctx.anchorNote).toBe(HEAD_NOTE);
    // The discussion itself is untouched — only the coordinates are.
    expect(ctx.rootId).toBe(1);
    expect(ctx.file).toBe('src/app.js');
    expect(ctx.comments.map((c) => c.body)).toEqual(['root body', 'reply body']);
  });

  it('an outdated trusted thread still sends its original_line_* coordinates', async () => {
    // Regression guard: the trust gate must not swallow the outdated
    // fallback that the un-degraded path depends on.
    buildDiffTable({ lines: [{ line: 20, side: 'RIGHT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });

    const outdated = {
      is_outdated: 1,
      line_start: null,
      line_end: null,
      original_line_start: 20,
      original_line_end: 20,
    };
    const { rootBtn, replyBtn } = await renderThreadWithReply(
      mgr,
      rootWithReply(outdated, { ...outdated, id: 42 })
    );

    rootBtn.click();
    const threadCtx = chatPanel.open.mock.calls[0][0].threadContext;
    expect(threadCtx.line_start).toBe(20);
    expect(threadCtx.line_end).toBe(20);

    replyBtn.click();
    const commentCtx = chatPanel.open.mock.calls[1][0].commentContext;
    expect(commentCtx.line_start).toBe(20);
    expect(commentCtx.line_end).toBe(20);
    expect(commentCtx.isOutdated).toBe(true);
  });
});

describe('ExternalCommentManager.openThreadChat (public entry point)', () => {
  // Used by AIPanel's Review-panel quick action. Must be the SAME gated path
  // as the inline card button — a delegate, not a parallel implementation.
  it('untrusted: nulls the lines and carries the provenance note', () => {
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel, trustPreciseAnchors: false, anchorPRNumber: 42 });

    mgr.openThreadChat(makeComment({ replies: [] }));

    const ctx = chatPanel.open.mock.calls[0][0].threadContext;
    expect(ctx.line_start).toBeNull();
    expect(ctx.line_end).toBeNull();
    expect(ctx.anchorNote).toBe(HEAD_NOTE);
  });

  it('trusted: passes the lines through unchanged', () => {
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel, anchorPRNumber: 42 });

    mgr.openThreadChat(makeComment({ replies: [] }));

    const ctx = chatPanel.open.mock.calls[0][0].threadContext;
    expect(ctx.line_start).toBe(10);
    expect(ctx.line_end).toBe(10);
    expect(ctx).not.toHaveProperty('anchorNote');
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
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });

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
