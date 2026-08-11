// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Task #16 regressions for small PRManager helpers that back the CodeView path:
 *   - _pierreFileAnnotationSide: deletion-side detection (GitHub 'removed'
 *     status has no `deleted file mode` git header, so status must win).
 *   - _pierreItemIdForPath: diff item id vs context:<path> vs none.
 *   - _registerOptimisticUserComment / _notifyAdoption: the count-backing
 *     userComments upsert that keeps SplitButton / Clear-All / REQUEST_CHANGES
 *     in sync without a WebSocket reload.
 *
 * PRManager is instantiated bare (Object.create) so the heavy constructor does
 * not run; each test fills only the state the method reads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makeManager(props = {}) {
  return Object.assign(Object.create(PRManager.prototype), props);
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('PRManager._pierreFileAnnotationSide', () => {
  it('returns LEFT for a removed file even when the patch has NO git header', () => {
    // GitHub PR mode: status 'removed', patch starts at the first @@.
    const m = makeManager();
    expect(m._pierreFileAnnotationSide({ status: 'removed', patch: '@@ -1 +0 @@\n-x' })).toBe('LEFT');
  });

  it('returns LEFT via the deleted-file-mode header when there is no status (Local mode)', () => {
    const m = makeManager();
    expect(m._pierreFileAnnotationSide({ patch: 'deleted file mode 100644\n@@ -1 +0 @@\n-x' })).toBe('LEFT');
  });

  it('returns RIGHT for added and modified files', () => {
    const m = makeManager();
    expect(m._pierreFileAnnotationSide({ status: 'added', patch: '@@ -0,0 +1 @@\n+x' })).toBe('RIGHT');
    expect(m._pierreFileAnnotationSide({ status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' })).toBe('RIGHT');
  });

  it('defaults to RIGHT with no status and no delete header', () => {
    const m = makeManager();
    expect(m._pierreFileAnnotationSide({ patch: '@@ -1 +1 @@\n-a\n+b' })).toBe('RIGHT');
    expect(m._pierreFileAnnotationSide({})).toBe('RIGHT');
    expect(m._pierreFileAnnotationSide(null)).toBe('RIGHT');
  });
});

describe('PRManager._pierreItemIdForPath', () => {
  it('returns the plain path when a diff item exists', () => {
    const m = makeManager({ pierreBridge: { files: new Map([['src/app.js', {}]]) } });
    expect(m._pierreItemIdForPath('src/app.js')).toBe('src/app.js');
  });

  it('returns context:<path> when only the context item exists', () => {
    const m = makeManager({ pierreBridge: { files: new Map([['context:src/app.js', {}]]) } });
    expect(m._pierreItemIdForPath('src/app.js')).toBe('context:src/app.js');
  });

  it('prefers the diff item over the context item for the same path', () => {
    const m = makeManager({
      pierreBridge: { files: new Map([['src/app.js', {}], ['context:src/app.js', {}]]) },
    });
    expect(m._pierreItemIdForPath('src/app.js')).toBe('src/app.js');
  });

  it('returns null when neither item exists or there is no bridge', () => {
    expect(makeManager({ pierreBridge: { files: new Map() } })._pierreItemIdForPath('x')).toBeNull();
    expect(makeManager({ pierreBridge: null })._pierreItemIdForPath('x')).toBeNull();
  });
});

describe('PRManager._registerOptimisticUserComment', () => {
  function mgr(userComments) {
    return makeManager({ pierreBridge: { _disabled: false }, userComments });
  }

  it('adds a new comment (status active) and raises the active count by one', () => {
    const m = mgr([]);
    expect(m._countActiveUserComments()).toBe(0);
    m._registerOptimisticUserComment({ id: 1, file: 'a.js', body: 'x' });
    expect(m._countActiveUserComments()).toBe(1);
    expect(m.userComments.find(c => c.id === 1).status).toBe('active');
  });

  it('upserts by id idempotently and merges fields (same id twice stays +1)', () => {
    const m = mgr([]);
    m._registerOptimisticUserComment({ id: 1, body: 'first' });
    m._registerOptimisticUserComment({ id: 1, body: 'second' });
    expect(m.userComments.filter(c => c.id === 1)).toHaveLength(1);
    expect(m.userComments.find(c => c.id === 1).body).toBe('second');
    expect(m._countActiveUserComments()).toBe(1);
  });

  it('reactivates an existing inactive entry', () => {
    const m = mgr([{ id: 2, status: 'inactive' }]);
    expect(m._countActiveUserComments()).toBe(0);
    m._registerOptimisticUserComment({ id: 2 });
    expect(m.userComments.find(c => c.id === 2).status).toBe('active');
    expect(m._countActiveUserComments()).toBe(1);
  });

  it('initializes userComments when it is not yet an array', () => {
    const m = mgr(undefined);
    m._registerOptimisticUserComment({ id: 5 });
    expect(Array.isArray(m.userComments)).toBe(true);
    expect(m.userComments.find(c => c.id === 5)).toBeTruthy();
  });

  it('is a safe no-op (count only) for a comment without an id', () => {
    const m = mgr([{ id: 1, status: 'active' }]);
    expect(() => m._registerOptimisticUserComment({})).not.toThrow();
    expect(m.userComments).toHaveLength(1);
    expect(m._countActiveUserComments()).toBe(1);
  });

  it('_notifyAdoption routes the adopted comment through the optimistic register', () => {
    const m = makeManager({ pierreBridge: { _disabled: false }, userComments: [] });
    m._notifyAdoption('sug-1', { id: 3, file: 'a.js' });
    expect(m.userComments.some(c => c.id === 3)).toBe(true);
    expect(m._countActiveUserComments()).toBe(1);
  });
});

// The header comment button is rebuilt outline-only on every (re)mount, but the
// cached comments zone survives virtualization with its cards — so the header
// build must refresh the icon from the zone's count (updateCommentCount) AFTER
// wiring headerButton, or a file with comments shows the empty outline once it
// scrolls out and back.
describe('PRManager._buildDiffFileHeaderParts refreshes the comment-count icon', () => {
  afterEach(() => { delete window.DiffRenderer; });

  it('sets headerButton then calls fileCommentManager.updateCommentCount with the zone', () => {
    const zone = document.createElement('div');
    const updateCommentCount = vi.fn();
    const m = makeManager({
      _summariesEnabled: false, // skip the summary-toggle branch
      generatedFiles: new Map(),
      viewedFiles: new Set(),
      collapsedFiles: new Set(),
      fileCommentManager: {
        createFileCommentsZone: vi.fn(() => zone),
        updateCommentCount,
        showCommentForm: vi.fn(),
      },
    });
    m._usesPierreCodeView = () => false; // legacy path → createFileCommentsZone
    window.DiffRenderer = { createFileHeader: () => document.createElement('div') };

    const { commentsZone } = m._buildDiffFileHeaderParts(
      { file: 'a.js', insertions: 1, deletions: 0 },
      { isGenerated: false, isViewed: false, isCollapsed: false, wrapper: null }
    );

    expect(commentsZone).toBe(zone);
    expect(zone.headerButton).toBeTruthy();               // wired before the refresh
    expect(updateCommentCount).toHaveBeenCalledWith(zone); // icon refreshed from the zone
  });
});

// A single path collapses into ONE `context:<path>` CodeView item, but
// _renderContextFileCodeView runs once PER context RECORD — so it must upsert
// the file-comments annotation (add only when not already anchored) or every
// record appends a duplicate zone onto the same context item.
describe('PRManager._renderContextFileCodeView de-dupes the file-comments annotation', () => {
  function fakeBridge() {
    const anns = new Map(); // itemId -> [{ lineNumber, metadata:{type,id,data} }]
    return {
      files: new Map(),
      addContextFile: vi.fn(),
      registerAnnotationRenderer: vi.fn(),
      getAnnotations: (id, type) => {
        const list = anns.get(id) || [];
        return type ? list.filter(a => a.metadata?.type === type) : list;
      },
      addAnnotation: (id, ann) => {
        if (!anns.has(id)) anns.set(id, []);
        anns.get(id).push({ lineNumber: ann.lineNumber, metadata: { type: ann.type, id: ann.id, data: ann.data } });
      },
    };
  }

  it('anchors exactly one file-comments:<path> annotation across repeated record passes', async () => {
    const bridge = fakeBridge();
    const m = makeManager({
      pierreBridge: bridge,
      viewedFiles: new Set(),
      collapsedFiles: new Set(),
      fetchFileContent: vi.fn(async () => ({ lines: ['a', 'b', 'c'] })),
    });
    m._ensurePierreFileCommentsRenderer = vi.fn(); // isolate the dedup guard

    // Two distinct records for the same path, plus a repeat of the first.
    await m._renderContextFileCodeView({ id: 1, file: 'src/app.js' });
    await m._renderContextFileCodeView({ id: 2, file: 'src/app.js' });
    await m._renderContextFileCodeView({ id: 1, file: 'src/app.js' });

    const fileComments = bridge.getAnnotations('context:src/app.js', 'file-comments');
    expect(fileComments).toHaveLength(1);
    expect(fileComments[0].metadata.id).toBe('file-comments:src/app.js');
    // The context contents are still (re)published each pass.
    expect(bridge.addContextFile).toHaveBeenCalledWith('src/app.js', 'a\nb\nc', expect.any(Object));
  });
});

// Same icon-refresh fix as the diff header, on the CONTEXT file header builder.
describe('PRManager._buildContextFileHeader refreshes the comment-count icon', () => {
  afterEach(() => { delete window.DiffRenderer; });

  it('sets headerButton then calls fileCommentManager.updateCommentCount with the zone', () => {
    const zone = document.createElement('div');
    const updateCommentCount = vi.fn();
    const m = makeManager({
      collapsedFiles: new Set(),
      viewedFiles: new Set(),
      generatedFiles: new Map(),
      pierreBridge: { files: new Map() },
      fileCommentManager: { updateCommentCount, showCommentForm: vi.fn() },
    });
    m._getOrCreateFileCommentsZone = vi.fn(() => zone);
    window.DiffRenderer = { CHEVRON_DOWN_ICON: '', updateFileHeaderState: vi.fn() };

    m._buildContextFileHeader('src/ctx.js');

    expect(zone.headerButton).toBeTruthy();
    expect(updateCommentCount).toHaveBeenCalledWith(zone);
  });
});

// scrollToContextFile: on the CodeView path context files are virtualized
// items with no legacy DOM, so navigation must go through the bridge by the
// resolved item id (diff path OR context:<path>), not the legacy DOM query.
// Whole-item jumps go through _scrollToPierreItemWithStickyOffset — context
// items live in the SAME CodeView under the same sticky headers as diff files,
// so they get the same header compensation. What matters here is that the
// offset is passed at all (its measured value belongs to
// tests/unit/pierre-nav-sticky-offset.test.js). The landing-gap correction is
// stubbed out: nothing is mounted, so the real helper would only poll rAF
// until its timeout.
describe('PRManager.scrollToContextFile CodeView branch', () => {
  function bridgeWith(files) {
    return { files: new Map(files), scrollToFile: vi.fn(), scrollToLine: vi.fn() };
  }

  function managerFor(bridge) {
    const m = makeManager({ pierreBridge: bridge });
    m._usesPierreCodeView = () => true;
    m._awaitPierreNavGap = vi.fn(async () => null);
    return m;
  }

  it('scrolls the diff item by plain path when one exists', async () => {
    const bridge = bridgeWith([['a.js', {}]]);
    await managerFor(bridge).scrollToContextFile('a.js');
    expect(bridge.scrollToFile).toHaveBeenCalledWith('a.js', expect.objectContaining({
      align: 'start',
      behavior: 'smooth',
      stickyOffset: expect.any(Number),
    }));
    expect(bridge.scrollToLine).not.toHaveBeenCalled();
  });

  it('uses scrollToLine when a lineStart is given', async () => {
    const bridge = bridgeWith([['a.js', {}]]);
    await managerFor(bridge).scrollToContextFile('a.js', 5);
    expect(bridge.scrollToLine).toHaveBeenCalledWith('a.js', 5, 'RIGHT');
    // The vendor compensates line scrolls itself — no item scroll, no offset.
    expect(bridge.scrollToFile).not.toHaveBeenCalled();
  });

  it('resolves the context:<path> id for a context-only file', async () => {
    const bridge = bridgeWith([['context:a.js', {}]]);
    await managerFor(bridge).scrollToContextFile('a.js');
    expect(bridge.scrollToFile).toHaveBeenCalledWith('context:a.js', expect.objectContaining({
      align: 'start',
      behavior: 'smooth',
      stickyOffset: expect.any(Number),
    }));
  });

  it('is a no-op when neither item exists', async () => {
    const bridge = bridgeWith([]);
    const m = makeManager({ pierreBridge: bridge });
    m._usesPierreCodeView = () => true;
    await m.scrollToContextFile('a.js');
    expect(bridge.scrollToFile).not.toHaveBeenCalled();
    expect(bridge.scrollToLine).not.toHaveBeenCalled();
  });
});
