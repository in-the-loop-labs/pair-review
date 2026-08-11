// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for PRManager._countActiveUserComments() + updateCommentCount().
 *
 * Under the single CodeView, a just-saved comment's card slots asynchronously
 * (next render pass) and virtualized-out files have NO card in the DOM at all,
 * so the old DOM-query count raced/undercounted → SplitButton "Clear All"
 * stayed disabled after a save. The count now reads from loaded comment DATA in
 * CodeView mode (exact, virtualization-independent), while the legacy per-file
 * table path (synchronous) keeps its reliable DOM count.
 *
 * PRManager is instantiated bare (Object.create) so the heavy constructor does
 * not run; each test fills only the state the method reads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makeManager({ pierreBridge = { _disabled: false }, userComments } = {}) {
  const m = Object.create(PRManager.prototype);
  m.pierreBridge = pierreBridge;
  m.userComments = userComments;
  return m;
}

// Build DOM comment rows: `line` .user-comment-row, `pending` rows carrying
// .suggestion-edit-pending (excluded), `file` .file-comment-card.user-comment.
function setDom({ line = 0, pending = 0, file = 0 } = {}) {
  const parts = [];
  for (let i = 0; i < line; i++) parts.push('<div class="user-comment-row"></div>');
  for (let i = 0; i < pending; i++) parts.push('<div class="user-comment-row suggestion-edit-pending"></div>');
  for (let i = 0; i < file; i++) parts.push('<div class="file-comment-card user-comment"></div>');
  document.body.innerHTML = parts.join('');
}

const active = (n) => Array.from({ length: n }, () => ({ status: 'active' }));

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('PRManager._countActiveUserComments — CodeView (data) path', () => {
  it('counts active comments from data, ignoring an empty/unslotted DOM', () => {
    // The regression: 3 active + 1 dismissed in data, ZERO cards in the DOM
    // (virtualized out / not yet slotted) → still returns 3.
    const m = makeManager({
      userComments: [
        { status: 'active' }, { status: 'active' }, { status: 'active' },
        { status: 'inactive' },
      ],
    });
    setDom({ line: 0 });
    expect(m._countActiveUserComments()).toBe(3);
  });

  it('uses the data count even when the DOM disagrees', () => {
    const m = makeManager({ userComments: active(2) });
    setDom({ line: 5 }); // stale/extra DOM rows must not win
    expect(m._countActiveUserComments()).toBe(2);
  });

  it('excludes dismissed (inactive) and null entries', () => {
    const m = makeManager({
      userComments: [{ status: 'active' }, null, { status: 'inactive' }, { status: undefined }],
    });
    // active + status:undefined counted; null + inactive excluded → 2.
    expect(m._countActiveUserComments()).toBe(2);
  });

  it('returns 0 for an empty data array (no throw)', () => {
    const m = makeManager({ userComments: [] });
    setDom({ line: 3 });
    expect(m._countActiveUserComments()).toBe(0);
  });

  it('falls back to the DOM count when userComments is not yet an array', () => {
    // Before comment data loads (undefined) → legacy DOM count, never throws.
    const m = makeManager({ userComments: undefined });
    setDom({ line: 2, file: 1 });
    expect(m._countActiveUserComments()).toBe(3);
  });
});

describe('PRManager._countActiveUserComments — legacy (DOM) path', () => {
  it('uses the DOM count when the bridge is absent, ignoring loaded data', () => {
    const m = makeManager({ pierreBridge: null, userComments: active(5) });
    setDom({ line: 2 });
    expect(m._countActiveUserComments()).toBe(2);
  });

  it('uses the DOM count when the bridge is disabled', () => {
    const m = makeManager({ pierreBridge: { _disabled: true }, userComments: active(5) });
    setDom({ line: 1, file: 1 });
    expect(m._countActiveUserComments()).toBe(2);
  });

  it('counts line + file cards and excludes suggestion-edit-pending rows', () => {
    const m = makeManager({ pierreBridge: null, userComments: undefined });
    setDom({ line: 2, pending: 3, file: 1 });
    // 2 line rows + 1 file card; the 3 pending rows are excluded → 3.
    expect(m._countActiveUserComments()).toBe(3);
  });
});

describe('PRManager.updateCommentCount', () => {
  function managerWithButton(opts) {
    const m = makeManager(opts);
    m.splitButton = { updateCommentCount: vi.fn() };
    document.body.innerHTML +=
      '<button id="clear-comments-btn">Clear</button>' +
      '<button id="review-button"><span class="review-button-text"></span></button>';
    return m;
  }

  it('pushes the data count to the SplitButton and enables Clear All when > 0', () => {
    const m = managerWithButton({ userComments: active(3) });
    m.updateCommentCount();

    expect(m.splitButton.updateCommentCount).toHaveBeenCalledWith(3);
    expect(document.getElementById('clear-comments-btn').disabled).toBe(false);
    expect(document.querySelector('.review-button-text').textContent).toBe('3 comments');
  });

  it('disables Clear All at zero active comments', () => {
    const m = managerWithButton({ userComments: [{ status: 'inactive' }] });
    m.updateCommentCount();

    expect(m.splitButton.updateCommentCount).toHaveBeenCalledWith(0);
    expect(document.getElementById('clear-comments-btn').disabled).toBe(true);
    expect(document.querySelector('.review-button-text').textContent).toBe('0 comments');
  });

  it('is a safe no-op path when there is no SplitButton', () => {
    const m = makeManager({ userComments: active(1) });
    m.splitButton = null;
    document.body.innerHTML = '<button id="clear-comments-btn">Clear</button>';
    expect(() => m.updateCommentCount()).not.toThrow();
    expect(document.getElementById('clear-comments-btn').disabled).toBe(false);
  });
});
