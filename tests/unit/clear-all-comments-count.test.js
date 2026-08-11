// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for PRManager.clearAllUserComments() — the data-backed guard.
 *
 * Regression: under the virtualized CodeView, comment DOM exists only for
 * MOUNTED files (and annotation slots attach async), so the old
 * `document.querySelectorAll` guard counted 0 while comments existed, toasted
 * "No comments to clear", and returned — Clear All was a no-op whenever the
 * commented files were virtualized out. The guard (and the confirm-dialog
 * message) now uses `_countActiveUserComments()`, which reads loaded comment
 * DATA in CodeView mode and falls back to the DOM count on the legacy path.
 * Opportunistic DOM removal happens only AFTER the DELETE succeeds.
 *
 * PRManager is instantiated bare (Object.create) so the heavy constructor does
 * not run; each test fills only the state the method reads (same harness as
 * tests/unit/pr-manager-comment-count.test.js).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makeManager({ pierreBridge = { _disabled: false }, userComments } = {}) {
  const m = Object.create(PRManager.prototype);
  m.pierreBridge = pierreBridge;
  m.userComments = userComments;
  m.currentPR = { id: 42 };
  m.loadUserComments = vi.fn().mockResolvedValue(undefined);
  m.fileCommentManager = null;
  return m;
}

// Build DOM comment rows mirroring what the guard's legacy path queries.
function setDom({ line = 0, file = 0 } = {}) {
  const parts = [];
  for (let i = 0; i < line; i++) parts.push('<div class="user-comment-row"></div>');
  for (let i = 0; i < file; i++) parts.push('<div class="file-comment-card user-comment"></div>');
  document.body.innerHTML = parts.join('');
}

const active = (n) => Array.from({ length: n }, () => ({ status: 'active' }));

let mockFetch;

beforeEach(() => {
  document.body.innerHTML = '';
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ deletedCount: 2 }),
  });
  vi.stubGlobal('fetch', mockFetch);
  window.toast = { showInfo: vi.fn(), showSuccess: vi.fn(), showError: vi.fn() };
  window.confirmDialog = { show: vi.fn().mockResolvedValue('confirm') };
  window.aiPanel = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.toast;
  delete window.confirmDialog;
  delete window.aiPanel;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('clearAllUserComments — CodeView (data-backed) guard', () => {
  it('clears comments that exist only in data (ZERO comment DOM) instead of toasting "No comments to clear"', async () => {
    // THE regression: 2 active + 1 dismissed in data, nothing mounted in the
    // DOM (virtualized out) — the old DOM-query guard bailed here.
    const m = makeManager({
      userComments: [...active(2), { status: 'inactive' }],
    });
    setDom({ line: 0 });

    await m.clearAllUserComments();

    expect(window.toast.showInfo).not.toHaveBeenCalled();
    expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
    // The dialog message uses the data-backed count too.
    expect(window.confirmDialog.show.mock.calls[0][0].message).toContain('2 comments');
    expect(mockFetch).toHaveBeenCalledWith('/api/reviews/42/comments', { method: 'DELETE' });
    // The reload is the source of truth for post-delete state.
    expect(m.loadUserComments).toHaveBeenCalledWith(false);
    expect(window.toast.showSuccess).toHaveBeenCalledWith('Cleared 2 comments');
  });

  it('toasts "No comments to clear" (no dialog, no fetch) when all comments are inactive', async () => {
    const m = makeManager({
      userComments: [{ status: 'inactive' }, { status: 'inactive' }],
    });

    await m.clearAllUserComments();

    expect(window.toast.showInfo).toHaveBeenCalledWith('No comments to clear');
    expect(window.confirmDialog.show).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('toasts "No comments to clear" for an empty comment list', async () => {
    const m = makeManager({ userComments: [] });

    await m.clearAllUserComments();

    expect(window.toast.showInfo).toHaveBeenCalledWith('No comments to clear');
    expect(window.confirmDialog.show).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when the confirm dialog is cancelled', async () => {
    const m = makeManager({ userComments: active(2) });
    window.confirmDialog.show.mockResolvedValue('cancel');

    await m.clearAllUserComments();

    expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(m.loadUserComments).not.toHaveBeenCalled();
    expect(window.toast.showSuccess).not.toHaveBeenCalled();
  });

  it('removes mounted comment DOM only AFTER the DELETE succeeds', async () => {
    const m = makeManager({ userComments: active(3) });
    // One of the three comments happens to be mounted.
    setDom({ line: 1 });
    let domRowsAtDeleteTime = -1;
    mockFetch.mockImplementation(async () => {
      domRowsAtDeleteTime = document.querySelectorAll('.user-comment-row').length;
      return { ok: true, json: vi.fn().mockResolvedValue({ deletedCount: 3 }) };
    });

    await m.clearAllUserComments();

    // Row still present when the DELETE was issued (removal is post-success)…
    expect(domRowsAtDeleteTime).toBe(1);
    // …and opportunistically removed afterwards.
    expect(document.querySelectorAll('.user-comment-row').length).toBe(0);
    expect(window.toast.showSuccess).toHaveBeenCalledWith('Cleared 3 comments');
  });

  it('keeps mounted comment DOM and shows an error toast when the DELETE fails', async () => {
    const m = makeManager({ userComments: active(2) });
    setDom({ line: 2 });
    mockFetch.mockResolvedValue({ ok: false, json: vi.fn() });

    await m.clearAllUserComments();

    expect(window.toast.showError).toHaveBeenCalledWith('Failed to clear comments');
    // Nothing was removed and no reload happened — the delete did not succeed.
    expect(document.querySelectorAll('.user-comment-row').length).toBe(2);
    expect(m.loadUserComments).not.toHaveBeenCalled();
    expect(window.toast.showSuccess).not.toHaveBeenCalled();
  });
});

describe('clearAllUserComments — legacy (DOM-count) guard', () => {
  it('still works off the DOM count when the CodeView bridge is absent', async () => {
    const m = makeManager({ pierreBridge: null, userComments: undefined });
    setDom({ line: 1, file: 1 });

    await m.clearAllUserComments();

    expect(window.toast.showInfo).not.toHaveBeenCalled();
    expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
    expect(window.confirmDialog.show.mock.calls[0][0].message).toContain('2 comments');
    expect(mockFetch).toHaveBeenCalledWith('/api/reviews/42/comments', { method: 'DELETE' });
  });

  it('toasts "No comments to clear" when the legacy DOM has no comment elements', async () => {
    const m = makeManager({ pierreBridge: { _disabled: true }, userComments: undefined });
    setDom({ line: 0 });

    await m.clearAllUserComments();

    expect(window.toast.showInfo).toHaveBeenCalledWith('No comments to clear');
    expect(window.confirmDialog.show).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
