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

  it('chat-about-comment button click invokes chatPanel.open with commentContext shape', async () => {
    buildDiffTable({ lines: [{ line: 10, side: 'RIGHT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });
    const comment = makeComment({
      id: 42,
      body: 'inline body',
      author: 'octocat',
      external_url: 'https://example.com/c/42',
      parent_id: null,
    });
    mgr.threadsBySource.set('github', [comment]);
    await mgr.render();

    const btn = document.querySelector('.external-comment-chat-btn');
    expect(btn).not.toBeNull();
    btn.click();

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

  it('chat-about-comment for outdated uses original_line_* and isOutdated=true', async () => {
    buildDiffTable({ lines: [{ line: 20, side: 'RIGHT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });
    mgr.threadsBySource.set('github', [
      makeComment({
        id: 9,
        is_outdated: 1,
        line_start: null,
        line_end: null,
        original_line_start: 20,
        original_line_end: 20,
      }),
    ]);
    await mgr.render();

    const btn = document.querySelector('.external-comment-chat-btn');
    btn.click();
    const arg = chatPanel.open.mock.calls[0][0];
    expect(arg.commentContext.isOutdated).toBe(true);
    expect(arg.commentContext.line_start).toBe(20);
    expect(arg.commentContext.line_end).toBe(20);
  });

  it('chat-about-thread button click invokes chatPanel.open with threadContext shape', async () => {
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

    const threadBtn = document.querySelector('.external-comment-chat-thread-btn');
    expect(threadBtn).not.toBeNull();
    threadBtn.click();

    expect(chatPanel.open).toHaveBeenCalledTimes(1);
    const arg = chatPanel.open.mock.calls[0][0];
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

  it('LEFT side flows through to commentContext', async () => {
    buildDiffTable({ lines: [{ line: 5, side: 'LEFT' }] });
    const chatPanel = { open: vi.fn() };
    const mgr = makeManager({ chatPanel });

    mgr.threadsBySource.set('github', [makeComment({
      id: 50,
      side: 'LEFT',
      line_start: 5,
      line_end: 5,
    })]);
    await mgr.render();

    document.querySelector('.external-comment-chat-btn').click();
    expect(chatPanel.open).toHaveBeenCalledTimes(1);
    expect(chatPanel.open.mock.calls[0][0].commentContext.side).toBe('LEFT');
  });

  it('LEFT side flows through to threadContext', async () => {
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

    document.querySelector('.external-comment-chat-thread-btn').click();
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
