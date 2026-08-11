// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Task #14: single edit/delete must sync the bridge ANNOTATION DATA model, not
 * just the DOM. Under CodeView, line comments re-render from bridge annotation
 * data on remount (virtualization), so a DOM-only edit reverts and a DOM-only
 * delete resurrects when the file scrolls out and back. deleteUserComment /
 * saveEditedUserComment now update pierreBridge annotation data + this.userComments
 * (the data-backed comment count keys on status). File-level comments render
 * from the cached zone DOM, so they take the data-only path (no bridge call).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makeManager({ userComments, pierreBridge } = {}) {
  const m = Object.create(PRManager.prototype);
  m.currentPR = { id: 42 };
  m.userComments = userComments;
  m.pierreBridge = pierreBridge;
  return m;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // The edit error path calls window.alert, which jsdom does not implement.
  window.alert = vi.fn();
});
afterEach(() => {
  document.body.innerHTML = '';
  delete global.fetch;
  vi.restoreAllMocks();
});

describe('PRManager.deleteUserComment — data sync', () => {
  it('removes the line-comment annotation and soft-deletes the data entry', async () => {
    const removeAnnotation = vi.fn();
    const m = makeManager({
      userComments: [{ id: 7, file: 'a.js', is_file_level: 0, status: 'active' }],
      pierreBridge: { removeAnnotation, _disabled: false },
    });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

    await m.deleteUserComment(7);

    expect(removeAnnotation).toHaveBeenCalledTimes(1);
    expect(removeAnnotation).toHaveBeenCalledWith('a.js', 'comment-7');
    expect(m.userComments[0].status).toBe('inactive');
  });

  it('does NOT remove an annotation for a file-level comment (zone-DOM path), still soft-deletes', async () => {
    const removeAnnotation = vi.fn();
    const m = makeManager({
      userComments: [{ id: 8, file: 'a.js', is_file_level: 1, status: 'active' }],
      pierreBridge: { removeAnnotation, _disabled: false },
    });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

    await m.deleteUserComment(8);

    expect(removeAnnotation).not.toHaveBeenCalled();
    expect(m.userComments[0].status).toBe('inactive');
  });

  it('does not soft-delete when the DELETE request fails', async () => {
    const removeAnnotation = vi.fn();
    const m = makeManager({
      userComments: [{ id: 9, file: 'a.js', is_file_level: 0, status: 'active' }],
      pierreBridge: { removeAnnotation, _disabled: false },
    });
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));

    await m.deleteUserComment(9);

    expect(removeAnnotation).not.toHaveBeenCalled();
    expect(m.userComments[0].status).toBe('active');
  });
});

describe('PRManager.saveEditedUserComment — data sync', () => {
  function seedEditDom(commentId, value) {
    document.body.innerHTML = `
      <div data-comment-id="${commentId}">
        <div class="user-comment">
          <div class="user-comment-body">old</div>
          <div class="user-comment-edit-form">
            <textarea id="edit-comment-${commentId}">${value}</textarea>
            <button class="save-edit-btn"></button>
          </div>
        </div>
      </div>`;
  }

  it('updates the line-comment annotation data and the data entry body', async () => {
    seedEditDom(9, 'NEW');
    const updateAnnotationData = vi.fn();
    const m = makeManager({
      userComments: [{ id: 9, file: 'a.js', is_file_level: 0, body: 'old', status: 'active' }],
      pierreBridge: { updateAnnotationData, _disabled: false },
    });
    global.fetch = vi.fn(async () => ({ ok: true }));

    await m.saveEditedUserComment(9);

    expect(updateAnnotationData).toHaveBeenCalledWith('a.js', 'comment-9', { body: 'NEW' });
    expect(m.userComments[0].body).toBe('NEW');
  });

  it('does NOT update annotation data for a file-level comment, but still updates the data body', async () => {
    seedEditDom(10, 'NEW');
    const updateAnnotationData = vi.fn();
    const m = makeManager({
      userComments: [{ id: 10, file: 'a.js', is_file_level: 1, body: 'old', status: 'active' }],
      pierreBridge: { updateAnnotationData, _disabled: false },
    });
    global.fetch = vi.fn(async () => ({ ok: true }));

    await m.saveEditedUserComment(10);

    expect(updateAnnotationData).not.toHaveBeenCalled();
    expect(m.userComments[0].body).toBe('NEW');
  });

  it('does not update anything when the PUT request fails', async () => {
    seedEditDom(11, 'NEW');
    const updateAnnotationData = vi.fn();
    const m = makeManager({
      userComments: [{ id: 11, file: 'a.js', is_file_level: 0, body: 'old', status: 'active' }],
      pierreBridge: { updateAnnotationData, _disabled: false },
    });
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));

    await m.saveEditedUserComment(11);

    expect(updateAnnotationData).not.toHaveBeenCalled();
    expect(m.userComments[0].body).toBe('old');
  });
});

// -----------------------------------------------------------------------
// Round 2: the two delete flows share ONE data+count helper
// -----------------------------------------------------------------------
//
// deleteUserComment (diff row / AI panel) and
// FileCommentManager.deleteFileComment (file-comment card) each used to own
// only HALF of the invariant: the first repainted the count ONLY inside its
// DOM-removal branches (so deleting a virtualized-out comment from the panel —
// no row, no card — never repainted), the second removed the card and repainted
// the zone but never flipped the record's status (so the data-backed count kept
// counting it until a reload). _markCommentDeleted owns data + count for both
// and repaints UNCONDITIONALLY.

const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');

/** Real review-button DOM so the repaint is observed, not spied. */
function seedReviewButton() {
  document.body.innerHTML = `
    <button id="review-button"><span class="review-button-text">0 comments</span></button>
    <button id="clear-comments-btn" disabled></button>`;
  return {
    text: () => document.querySelector('.review-button-text').textContent,
    hasComments: () => document.getElementById('review-button').classList.contains('has-comments'),
    clearDisabled: () => document.getElementById('clear-comments-btn').disabled,
  };
}

describe('PRManager._markCommentDeleted — shared by both delete flows', () => {
  it('repaints the count for a virtualized-out comment with NO row and NO card', async () => {
    // The AI-panel delete of an off-screen comment: neither `[data-comment-id]`
    // nor `.file-comment-card` exists, which is exactly the case the old
    // branch-local repaint missed.
    const btn = seedReviewButton();
    const removeAnnotation = vi.fn();
    const m = makeManager({
      userComments: [
        { id: 21, file: 'a.js', is_file_level: 0, status: 'active' },
        { id: 22, file: 'a.js', is_file_level: 0, status: 'active' },
      ],
      pierreBridge: { removeAnnotation, _disabled: false },
    });
    m.updateCommentCount(); // paint the starting state
    expect(btn.text()).toBe('2 comments');

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    await m.deleteUserComment(21);

    expect(document.querySelector('[data-comment-id="21"]')).toBeNull(); // no DOM was involved
    expect(btn.text()).toBe('1 comment');
    expect(btn.hasComments()).toBe(true);
    expect(m.userComments[0].status).toBe('inactive');
    expect(removeAnnotation).toHaveBeenCalledWith('a.js', 'comment-21');
  });

  it('repaints down to zero (clears has-comments, disables Clear) on the last delete', async () => {
    const btn = seedReviewButton();
    const m = makeManager({
      userComments: [{ id: 23, file: 'a.js', is_file_level: 0, status: 'active' }],
      pierreBridge: { removeAnnotation: vi.fn(), _disabled: false },
    });
    m.updateCommentCount();
    expect(btn.hasComments()).toBe(true);
    expect(btn.clearDisabled()).toBe(false);

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    await m.deleteUserComment(23);

    expect(btn.text()).toBe('0 comments');
    expect(btn.hasComments()).toBe(false);
    expect(btn.clearDisabled()).toBe(true);
  });

  it('FileCommentManager.deleteFileComment flips the status AND repaints via the same helper', async () => {
    // Second flow, same invariant — exercised through the REAL FileCommentManager
    // against the REAL PRManager method (no stubbed _markCommentDeleted).
    const btn = seedReviewButton();
    const removeAnnotation = vi.fn();
    const m = makeManager({
      userComments: [
        { id: 31, file: 'a.js', is_file_level: 1, status: 'active' },
        { id: 32, file: 'a.js', is_file_level: 0, status: 'active' },
      ],
      pierreBridge: { removeAnnotation, _disabled: false },
    });
    m.currentPR = { id: 42, reviewType: 'local' };
    m.updateCommentCount();
    expect(btn.text()).toBe('2 comments');

    const zone = document.createElement('div');
    zone.className = 'file-comments-zone';
    zone.innerHTML = `
      <div class="file-comments-container">
        <div class="file-comment-card" data-comment-id="31"></div>
      </div>`;
    document.body.appendChild(zone);

    const fcm = Object.create(FileCommentManager.prototype);
    fcm.prManager = m;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

    await fcm.deleteFileComment(zone, 31);

    expect(zone.querySelector('[data-comment-id="31"]')).toBeNull(); // card removal stays with the caller
    expect(m.userComments[0].status).toBe('inactive');               // the missing half
    expect(m._countActiveUserComments()).toBe(1);
    expect(btn.text()).toBe('1 comment');                            // repainted from data
    // A file-level comment renders from the cached zone DOM, not a bridge
    // annotation, so no annotation is dropped for it.
    expect(removeAnnotation).not.toHaveBeenCalled();
  });

  it('falls back to a bare updateCommentCount for a prManager without the helper', async () => {
    // Compat arm (file-comment-manager.js:1089-1093): older/partial prManager
    // stubs expose only updateCommentCount. The repaint must still happen —
    // losing it would silently stop the count from updating for those hosts.
    const updateCommentCount = vi.fn();
    const zone = document.createElement('div');
    zone.className = 'file-comments-zone';
    zone.innerHTML = `
      <div class="file-comments-container">
        <div class="file-comment-card" data-comment-id="33"></div>
      </div>`;
    document.body.appendChild(zone);

    const fcm = Object.create(FileCommentManager.prototype);
    fcm.prManager = {
      currentPR: { id: 42, reviewType: 'local' },
      updateCommentCount, // no _markCommentDeleted
    };
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

    await fcm.deleteFileComment(zone, 33);

    expect(updateCommentCount).toHaveBeenCalledTimes(1);
    expect(zone.querySelector('[data-comment-id="33"]')).toBeNull();
  });

  it('prefers the helper over the bare fallback when both are available', async () => {
    seedReviewButton();
    const zone = document.createElement('div');
    zone.className = 'file-comments-zone';
    zone.innerHTML = `
      <div class="file-comments-container">
        <div class="file-comment-card" data-comment-id="34"></div>
      </div>`;
    document.body.appendChild(zone);

    const m = makeManager({
      userComments: [{ id: 34, file: 'a.js', is_file_level: 1, status: 'active' }],
      pierreBridge: { removeAnnotation: vi.fn(), _disabled: false },
    });
    m.currentPR = { id: 42, reviewType: 'local' };
    const markSpy = vi.spyOn(m, '_markCommentDeleted');
    const countSpy = vi.spyOn(m, 'updateCommentCount');

    const fcm = Object.create(FileCommentManager.prototype);
    fcm.prManager = m;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

    await fcm.deleteFileComment(zone, 34);

    expect(markSpy).toHaveBeenCalledWith(34);
    // Only the helper's own internal repaint — the fallback arm did not also fire.
    expect(countSpy).toHaveBeenCalledTimes(1);
  });

  it('matches a numeric id against a string record id and vice versa', () => {
    // Ids arrive as numbers from the DB and as strings from dataset reads.
    const removeAnnotation = vi.fn();
    const m = makeManager({
      userComments: [
        { id: '51', file: 'a.js', is_file_level: 0, status: 'active' },
        { id: 52, file: 'b.js', is_file_level: 0, status: 'active' },
      ],
      pierreBridge: { removeAnnotation, _disabled: false },
    });
    seedReviewButton();

    m._markCommentDeleted(51);    // number → string record
    m._markCommentDeleted('52');  // string → number record

    expect(m.userComments[0].status).toBe('inactive');
    expect(m.userComments[1].status).toBe('inactive');
    expect(removeAnnotation.mock.calls).toEqual([['a.js', 'comment-51'], ['b.js', 'comment-52']]);
  });

  it('drops the bridge annotation for a line comment but not for is_file_level === 1', () => {
    const removeAnnotation = vi.fn();
    const m = makeManager({
      userComments: [
        { id: 61, file: 'a.js', is_file_level: 0, status: 'active' },
        { id: 62, file: 'a.js', is_file_level: 1, status: 'active' },
        // No is_file_level at all → still a line comment (the check is `!== 1`).
        { id: 63, file: 'a.js', status: 'active' },
        // No file → nothing to remove the annotation from.
        { id: 64, is_file_level: 0, status: 'active' },
      ],
      pierreBridge: { removeAnnotation, _disabled: false },
    });
    seedReviewButton();

    for (const id of [61, 62, 63, 64]) m._markCommentDeleted(id);

    expect(removeAnnotation.mock.calls).toEqual([['a.js', 'comment-61'], ['a.js', 'comment-63']]);
    expect(m.userComments.every(c => c.status === 'inactive')).toBe(true);
  });

  it('still repaints (and does not throw) when userComments is not an array', () => {
    const btn = seedReviewButton();
    const m = makeManager({ userComments: undefined, pierreBridge: { removeAnnotation: vi.fn(), _disabled: false } });
    document.querySelector('.review-button-text').textContent = 'stale';

    expect(() => m._markCommentDeleted(1)).not.toThrow();
    expect(btn.text()).toBe('0 comments');

    m.userComments = null;
    document.querySelector('.review-button-text').textContent = 'stale';
    expect(() => m._markCommentDeleted(1)).not.toThrow();
    expect(btn.text()).toBe('0 comments');
  });

  it('touches no comment DOM itself (removal stays with the callers) and returns undefined', () => {
    // The helper owns data + count only; the row and the card must survive it,
    // or the two callers would double-remove / fight over the DOM.
    seedReviewButton();
    const row = document.createElement('div');
    row.dataset.commentId = '71';
    const card = document.createElement('div');
    card.className = 'file-comment-card';
    card.dataset.commentId = '71';
    document.body.append(row, card);

    const m = makeManager({
      userComments: [{ id: 71, file: 'a.js', is_file_level: 0, status: 'active' }],
      pierreBridge: { removeAnnotation: vi.fn(), _disabled: false },
    });

    expect(m._markCommentDeleted(71)).toBeUndefined();

    expect(document.querySelector('[data-comment-id="71"]')).toBe(row);
    expect(document.querySelector('.file-comment-card[data-comment-id="71"]')).toBe(card);
  });

  it('repaints even when the id matches no record (already gone) and does not throw', () => {
    const btn = seedReviewButton();
    const m = makeManager({
      userComments: [{ id: 41, file: 'a.js', is_file_level: 0, status: 'inactive' }],
      pierreBridge: { removeAnnotation: vi.fn(), _disabled: false },
    });
    document.querySelector('.review-button-text').textContent = 'stale';

    expect(() => m._markCommentDeleted(999)).not.toThrow();

    expect(btn.text()).toBe('0 comments');
  });
});

describe('delete → count interplay', () => {
  it('_countActiveUserComments drops by one after a delete (status flip)', async () => {
    const m = makeManager({
      userComments: [
        { id: 11, file: 'a.js', is_file_level: 0, status: 'active' },
        { id: 12, file: 'a.js', is_file_level: 0, status: 'active' },
      ],
      pierreBridge: { removeAnnotation: vi.fn(), _disabled: false },
    });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

    expect(m._countActiveUserComments()).toBe(2);

    await m.deleteUserComment(11);

    expect(m._countActiveUserComments()).toBe(1);
  });
});
