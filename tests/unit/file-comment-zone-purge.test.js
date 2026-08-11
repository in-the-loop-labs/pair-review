// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for PRManager._purgeFileCommentCards() and its two callers.
 *
 * Regression: under the virtualized CodeView each file's comments zone is
 * cached in `_fileCommentZones` and DETACHED from the document while the file
 * is off-screen — it is re-slotted verbatim on scroll-in. Both delete flows
 * swept file-level cards with `document.querySelector(All)`, which cannot see a
 * detached zone, and neither flow has a data-side backstop for file-level
 * comments (`_markCommentDeleted` deliberately keeps their bridge annotation,
 * and the `loadUserComments` reload re-renders zones only when file-level
 * comments remain). So a file-level comment on a virtualized-out file survived
 * Clear All / single delete and reappeared on scroll-in, against a data-backed
 * count that already read 0.
 *
 * PRManager is instantiated bare (Object.create) so the heavy constructor does
 * not run; each test fills only the state the methods read (same harness as
 * tests/unit/clear-all-comments-count.test.js).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makeCard(commentId, cls = 'user-comment') {
  const card = document.createElement('div');
  card.className = `file-comment-card ${cls}`;
  card.dataset.commentId = String(commentId);
  return card;
}

function makeZone(fileName, cards = []) {
  const zone = document.createElement('div');
  zone.className = 'file-comments-zone';
  zone.dataset.fileName = fileName;
  const container = document.createElement('div');
  container.className = 'file-comments-container';
  for (const card of cards) container.appendChild(card);
  zone.appendChild(container);
  return zone;
}

function makeManager({ userComments = [], zones = new Map() } = {}) {
  const m = Object.create(PRManager.prototype);
  m.pierreBridge = { _disabled: false, removeAnnotation: vi.fn() };
  m.userComments = userComments;
  m.currentPR = { id: 42 };
  m._fileCommentZones = zones;
  m.fileCommentManager = { updateCommentCount: vi.fn() };
  m.loadUserComments = vi.fn().mockResolvedValue(undefined);
  m.updateCommentCount = vi.fn();
  return m;
}

let mockFetch;

beforeEach(() => {
  document.body.innerHTML = '';
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ deletedCount: 1 }),
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

describe('PRManager._purgeFileCommentCards', () => {
  it('sweeps mounted AND detached cached zones, refreshing the count of each', () => {
    const mountedCard = makeCard(1);
    const mountedZone = makeZone('mounted.js', [mountedCard]);
    document.body.appendChild(mountedZone);

    const detachedCard = makeCard(2);
    const detachedZone = makeZone('offscreen.js', [detachedCard]);

    const m = makeManager({
      zones: new Map([['mounted.js', mountedZone], ['offscreen.js', detachedZone]]),
    });

    m._purgeFileCommentCards('.file-comment-card.user-comment');

    expect(mountedZone.querySelectorAll('.file-comment-card').length).toBe(0);
    expect(detachedZone.querySelectorAll('.file-comment-card').length).toBe(0);
    expect(m.fileCommentManager.updateCommentCount).toHaveBeenCalledWith(mountedZone);
    expect(m.fileCommentManager.updateCommentCount).toHaveBeenCalledWith(detachedZone);
  });

  it('counts a cached zone once even when it is currently mounted', () => {
    const zone = makeZone('same.js', [makeCard(1)]);
    document.body.appendChild(zone);
    const m = makeManager({ zones: new Map([['same.js', zone]]) });

    m._purgeFileCommentCards('.file-comment-card.user-comment');

    expect(m.fileCommentManager.updateCommentCount).toHaveBeenCalledTimes(1);
  });

  it('leaves non-matching cards alone and does not touch untouched zones', () => {
    const aiCard = makeCard(9, 'ai-suggestion');
    const zone = makeZone('ai-only.js', [aiCard]);
    const m = makeManager({ zones: new Map([['ai-only.js', zone]]) });

    m._purgeFileCommentCards('.file-comment-card.user-comment');

    expect(zone.contains(aiCard)).toBe(true);
    expect(m.fileCommentManager.updateCommentCount).not.toHaveBeenCalled();
  });

  it('is a no-op when no zone cache exists (legacy path)', () => {
    const m = makeManager();
    m._fileCommentZones = null;

    expect(() => m._purgeFileCommentCards('.file-comment-card.user-comment')).not.toThrow();
  });
});

describe('clearAllUserComments — detached zones', () => {
  it('removes a file-level card from a virtualized-out (detached) zone', async () => {
    const detachedZone = makeZone('offscreen.js', [makeCard(7)]);
    const m = makeManager({
      userComments: [{ id: 7, status: 'active', is_file_level: 1, file: 'offscreen.js' }],
      zones: new Map([['offscreen.js', detachedZone]]),
    });

    await m.clearAllUserComments();

    expect(mockFetch).toHaveBeenCalledWith('/api/reviews/42/comments', { method: 'DELETE' });
    // The card is gone from the cached zone, so re-slotting it on scroll-in
    // cannot resurrect a comment the server already dismissed.
    expect(detachedZone.querySelectorAll('.file-comment-card').length).toBe(0);
    expect(m.fileCommentManager.updateCommentCount).toHaveBeenCalledWith(detachedZone);
  });

  it('keeps the card when the DELETE fails', async () => {
    const detachedZone = makeZone('offscreen.js', [makeCard(7)]);
    mockFetch.mockResolvedValue({ ok: false, json: vi.fn() });
    const m = makeManager({
      userComments: [{ id: 7, status: 'active', is_file_level: 1, file: 'offscreen.js' }],
      zones: new Map([['offscreen.js', detachedZone]]),
    });

    await m.clearAllUserComments();

    expect(detachedZone.querySelectorAll('.file-comment-card').length).toBe(1);
    expect(window.toast.showError).toHaveBeenCalledWith('Failed to clear comments');
  });
});

describe('deleteUserComment — detached zones', () => {
  it('removes the targeted file-level card from a detached zone', async () => {
    const keep = makeCard(8);
    const detachedZone = makeZone('offscreen.js', [makeCard(7), keep]);
    const m = makeManager({
      userComments: [
        { id: 7, status: 'active', is_file_level: 1, file: 'offscreen.js' },
        { id: 8, status: 'active', is_file_level: 1, file: 'offscreen.js' },
      ],
      zones: new Map([['offscreen.js', detachedZone]]),
    });

    await m.deleteUserComment(7);

    const remaining = [...detachedZone.querySelectorAll('.file-comment-card')];
    expect(remaining).toEqual([keep]);
    expect(m.fileCommentManager.updateCommentCount).toHaveBeenCalledWith(detachedZone);
    // File-level comments keep their bridge annotation (the zone owns rendering).
    expect(m.pierreBridge.removeAnnotation).not.toHaveBeenCalled();
    expect(window.toast.showSuccess).toHaveBeenCalledWith('Comment dismissed');
  });

  it('still removes a mounted file-level card', async () => {
    const mountedZone = makeZone('mounted.js', [makeCard(7)]);
    document.body.appendChild(mountedZone);
    const m = makeManager({
      userComments: [{ id: 7, status: 'active', is_file_level: 1, file: 'mounted.js' }],
    });

    await m.deleteUserComment(7);

    expect(mountedZone.querySelectorAll('.file-comment-card').length).toBe(0);
    expect(m.fileCommentManager.updateCommentCount).toHaveBeenCalledWith(mountedZone);
  });
});
