// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Tests for the shared draft-comment counter, the single source of truth
 * behind the toolbar count, Clear All enablement, "N comments will be
 * submitted", and the Request-changes validation in both PRManager and
 * ReviewModal.
 *
 * The behavior that matters: a comment can have a card on BOTH the Diff
 * surface (`.user-comment-row`) and the Rendered Markdown surface
 * (`.rendered-markdown-comment-card`) at the same time, because Rendered
 * mode only CSS-hides the diff body. It must be counted exactly once — and
 * a comment that currently has ONLY a Rendered card must still be counted,
 * since it is stored server-side and will be submitted.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const CommentCount = require('../../public/js/utils/comment-count.js');

function addDiffRow(id, extraClass = '') {
  const el = document.createElement('div');
  el.className = `user-comment-row ${extraClass}`.trim();
  if (id != null) el.dataset.commentId = String(id);
  document.body.appendChild(el);
  return el;
}

function addRenderedCard(id) {
  const el = document.createElement('div');
  el.className = 'rendered-markdown-comment-card';
  el.dataset.commentId = String(id);
  document.body.appendChild(el);
  return el;
}

function addFileCard(id) {
  const el = document.createElement('div');
  el.className = 'file-comment-card user-comment';
  el.dataset.commentId = String(id);
  document.body.appendChild(el);
  return el;
}

describe('CommentCount.countDraftComments', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is zero for an empty document', () => {
    expect(CommentCount.countDraftComments(document)).toEqual({
      total: 0, lineComments: 0, fileComments: 0
    });
  });

  it('counts Diff rows and file-level cards', () => {
    addDiffRow(1);
    addDiffRow(2);
    addFileCard(3);
    expect(CommentCount.countDraftComments(document)).toEqual({
      total: 3, lineComments: 2, fileComments: 1
    });
  });

  it('counts a comment once when it appears on BOTH the Diff and Rendered surfaces', () => {
    addDiffRow(1);
    addRenderedCard(1);
    expect(CommentCount.countDraftComments(document).total).toBe(1);
  });

  it('counts a Rendered-only comment (no renderable Diff target)', () => {
    addRenderedCard(7);
    expect(CommentCount.countDraftComments(document)).toEqual({
      total: 1, lineComments: 1, fileComments: 0
    });
  });

  it('sums the union across surfaces without double counting overlaps', () => {
    addDiffRow(1);
    addDiffRow(2);
    addRenderedCard(2); // overlap
    addRenderedCard(3); // rendered only
    addFileCard(4);
    expect(CommentCount.countDraftComments(document)).toEqual({
      total: 4, lineComments: 3, fileComments: 1
    });
  });

  it('excludes in-progress suggestion edit forms, as before', () => {
    addDiffRow(1);
    addDiffRow(2, 'suggestion-edit-pending');
    expect(CommentCount.countDraftComments(document).total).toBe(1);
  });

  it('excludes a suggestion-edit-pending row even when it also has a Rendered card', () => {
    addDiffRow(5, 'suggestion-edit-pending');
    expect(CommentCount.countDraftComments(document).total).toBe(0);
  });

  it('treats string and numeric ids as the same comment', () => {
    const row = addDiffRow(1);
    row.dataset.commentId = '1';
    addRenderedCard(1);
    expect(CommentCount.countDraftComments(document).total).toBe(1);
  });

  it('counts a row with no data-comment-id individually rather than dropping it', () => {
    addDiffRow(null);
    addDiffRow(null);
    expect(CommentCount.countDraftComments(document).total).toBe(2);
  });

  it('can be scoped to a subtree', () => {
    const scope = document.createElement('div');
    document.body.appendChild(scope);
    const inScope = document.createElement('div');
    inScope.className = 'user-comment-row';
    inScope.dataset.commentId = '1';
    scope.appendChild(inScope);
    addDiffRow(2); // outside the scope

    expect(CommentCount.countDraftComments(scope).total).toBe(1);
    expect(CommentCount.countDraftComments(document).total).toBe(2);
  });

  it('returns zeroes rather than throwing for an unusable root', () => {
    expect(CommentCount.countDraftComments({})).toEqual({
      total: 0, lineComments: 0, fileComments: 0
    });
  });

  it('defaults to the whole document when no root is given', () => {
    addDiffRow(1);
    expect(CommentCount.countDraftComments().total).toBe(1);
  });
});
