// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * ReviewModal's comment count and Request-changes validation must include
 * comments that currently exist only on the Rendered Markdown surface.
 *
 * Rendered mode CSS-hides the diff body, and a comment created there whose
 * Diff target could not be made renderable has only a
 * `.rendered-markdown-comment-card`. It is stored server-side and WILL be
 * submitted, so counting only `.user-comment-row` would hide "N comments
 * will be submitted" and falsely block a Request-changes submission. It
 * must also not be DOUBLE counted when both surfaces show it.
 *
 * Drives the real production methods (`countDraftComments`,
 * `updateCommentCount`, `submitReview`) with a real jsdom modal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { ReviewModal } = require('../../public/js/components/ReviewModal.js');
const CommentCount = require('../../public/js/utils/comment-count.js');

function addDiffRow(id) {
  const el = document.createElement('div');
  el.className = 'user-comment-row';
  el.dataset.commentId = String(id);
  document.body.appendChild(el);
}

function addRenderedCard(id) {
  const el = document.createElement('div');
  el.className = 'rendered-markdown-comment-card';
  el.dataset.commentId = String(id);
  document.body.appendChild(el);
}

/**
 * A ReviewModal wired to a real jsdom modal element, bypassing the heavy
 * constructor (same Object.create pattern the other component tests use).
 */
function makeModal() {
  const inst = Object.create(ReviewModal.prototype);
  const modal = document.createElement('div');
  modal.innerHTML = `
    <div class="review-comment-count" style="display:none"></div>
    <textarea id="review-body-modal"></textarea>
    <input type="radio" name="review-event" value="REQUEST_CHANGES" checked>
  `;
  document.body.appendChild(modal);
  inst.modal = modal;
  inst.isSubmitting = false;
  inst.hideError = vi.fn();
  inst.showError = vi.fn();
  inst.updateLargeReviewWarning = vi.fn();
  inst.setSubmittingState = vi.fn();
  inst.getAssistedByFooter = () => '';
  return inst;
}

describe('ReviewModal draft-comment counting with Rendered Markdown cards', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.CommentCount = CommentCount;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.CommentCount;
    delete window.prManager;
    document.body.innerHTML = '';
  });

  it('countDraftComments counts a Rendered-only comment', () => {
    addRenderedCard(1);
    expect(makeModal().countDraftComments()).toBe(1);
  });

  it('countDraftComments counts a comment on both surfaces exactly once', () => {
    addDiffRow(1);
    addRenderedCard(1);
    expect(makeModal().countDraftComments()).toBe(1);
  });

  it('updateCommentCount shows the count for a Rendered-only comment', () => {
    addRenderedCard(1);
    const modal = makeModal();
    modal.updateCommentCount();
    const el = modal.modal.querySelector('.review-comment-count');
    expect(el.style.display).toBe('flex');
    expect(el.textContent).toContain('1');
    expect(el.textContent).toContain('comment will be submitted');
  });

  it('updateCommentCount does not double count a comment shown on both surfaces', () => {
    addDiffRow(1);
    addRenderedCard(1);
    addDiffRow(2);
    const modal = makeModal();
    modal.updateCommentCount();
    const el = modal.modal.querySelector('.review-comment-count');
    expect(el.textContent).toContain('2');
    expect(el.textContent).toContain('comments will be submitted');
  });

  it('hides the count when there are no comments at all', () => {
    const modal = makeModal();
    modal.updateCommentCount();
    expect(modal.modal.querySelector('.review-comment-count').style.display).toBe('none');
  });

  it('does not block Request changes when the only comment is a Rendered-only card', async () => {
    addRenderedCard(1);
    const modal = makeModal();
    // Fail fast AFTER validation so the test never touches the network:
    // reaching setSubmittingState proves validation passed.
    modal.setSubmittingState = vi.fn(() => { throw new Error('reached-submit'); });

    await expect(modal.submitReview()).rejects.toThrow('reached-submit');
    expect(modal.showError).not.toHaveBeenCalled();
  });

  it('still blocks Request changes with an empty body and no comments anywhere', async () => {
    const modal = makeModal();
    await modal.submitReview();
    expect(modal.showError).toHaveBeenCalledWith(
      'Please add comments or a review summary when requesting changes.'
    );
    expect(modal.setSubmittingState).not.toHaveBeenCalled();
  });

  it('falls back to the pre-existing direct DOM sum when the shared counter util is not loaded', () => {
    // Defense in depth only: both pr.html and local.html load
    // /js/utils/comment-count.js, so this branch is not reachable in the
    // app. It reproduces exactly the historical `.user-comment-row` +
    // `.file-comment-card.user-comment` sum — no crash, no exception.
    delete window.CommentCount;
    addDiffRow(1);
    addDiffRow(2);
    addRenderedCard(3);
    expect(makeModal().countDraftComments()).toBe(2);
  });
});
