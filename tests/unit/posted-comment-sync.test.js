// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * PostedComment.syncCommentElement brings a rendered comment in line with
 * its data: status stamps, hidden-as-posted, the edited-since-posted note,
 * an update in flight. The diff runs it every time it draws a comment card,
 * so it must be idempotent and must leave a card that is already right
 * untouched. "Busy" is data, so a card drawn while an update runs shows it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const PostedComment = require('../../public/js/utils/posted-comment.js');

function card(id = 7) {
  const element = document.createElement('div');
  element.className = 'user-comment-row';
  element.dataset.commentId = String(id);
  element.innerHTML = '<div class="user-comment"><div class="user-comment-body">text</div></div>';
  return element;
}

const pending = (id = 7) => ({ id, status: 'active' });
const posted = (id = 7, changed = false) => ({ id, status: 'active', publication: { state: 'posted', changed } });

beforeEach(() => {
  document.body.innerHTML = '';
  window.PostedComment = PostedComment;
  PostedComment.setShowPostedOverride(null);
  PostedComment.setUpdateError(7, null);
  PostedComment.setUpdateBusy(7, false);
});

afterEach(() => {
  delete window.prManager;
  delete window.PAIR_REVIEW_LOCAL_MODE;
  PostedComment.setShowPostedOverride(null);
  PostedComment.setUpdateError(7, null);
  PostedComment.setUpdateBusy(7, false);
  vi.restoreAllMocks();
});

describe('PostedComment.syncCommentElement', () => {
  it('stamps status and publication, and hides a posted comment the reviewer chose to hide', () => {
    const element = card();
    PostedComment.syncCommentElement(element, pending());
    expect(element.dataset.commentStatus).toBe('active');
    expect(element.dataset.commentPublication).toBe('none');
    expect(element.classList.contains('posted-comment-hidden')).toBe(false);

    // Posted while the card was not on screen, with "show posted" off.
    PostedComment.setShowPostedOverride(false);
    PostedComment.syncCommentElement(element, posted());
    expect(element.dataset.commentPublication).toBe('posted');
    expect(element.classList.contains('posted-comment-hidden')).toBe(true);

    // The filter flipped back while the card was not on screen.
    PostedComment.setShowPostedOverride(true);
    PostedComment.syncCommentElement(element, posted());
    expect(element.classList.contains('posted-comment-hidden')).toBe(false);
  });

  it('adds the edited-since-posted note when the data calls for one and removes it when it no longer does', () => {
    const element = card();
    PostedComment.syncCommentElement(element, posted(7, true));
    const note = element.querySelector('.posted-comment-edited');
    expect(note).not.toBeNull();
    expect(note.previousElementSibling).toBe(element.querySelector('.user-comment-body'));

    PostedComment.syncCommentElement(element, posted(7, false));
    expect(element.querySelector('.posted-comment-edited')).toBeNull();
  });

  it('is idempotent: a card that already matches its data keeps its note element', () => {
    const element = card();
    const comment = posted(7, true);
    PostedComment.syncCommentElement(element, comment);
    const note = element.querySelector('.posted-comment-edited');
    const button = note.querySelector('.btn-update-on-host');

    PostedComment.syncCommentElement(element, comment);
    PostedComment.syncCommentElement(element, comment);

    expect(element.querySelectorAll('.posted-comment-edited')).toHaveLength(1);
    expect(element.querySelector('.posted-comment-edited')).toBe(note);
    expect(element.querySelector('.btn-update-on-host')).toBe(button);
    // A button that was never busy is left exactly as built.
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('re-renders the note when the update error changed', () => {
    const element = card();
    const comment = posted(7, true);
    PostedComment.syncCommentElement(element, comment);
    expect(element.querySelector('.posted-comment-update-error').hidden).toBe(true);

    PostedComment.setUpdateError(7, { message: 'This comment was deleted on GitHub.' });
    PostedComment.syncCommentElement(element, comment);

    const error = element.querySelector('.posted-comment-update-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('This comment was deleted on GitHub.');
    expect(element.querySelectorAll('.posted-comment-edited')).toHaveLength(1);
  });

  it('adopts a note that was rendered with the card and has no signature yet', () => {
    const element = card();
    const comment = posted(7, true);
    element.querySelector('.user-comment-body')
      .insertAdjacentHTML('afterend', PostedComment.getEditedSincePostedHtml(comment));

    PostedComment.syncCommentElement(element, comment);
    const note = element.querySelector('.posted-comment-edited');
    PostedComment.syncCommentElement(element, comment);

    expect(element.querySelectorAll('.posted-comment-edited')).toHaveLength(1);
    expect(element.querySelector('.posted-comment-edited')).toBe(note);
  });

  it('shows an update in flight on a card drawn while it runs, and clears it when it ends', () => {
    PostedComment.setUpdateBusy(7, true);
    expect(PostedComment.isUpdateBusy('7')).toBe(true);
    // Built now, while busy: no card existed when setUpdateBusy ran.
    const element = card();
    PostedComment.syncCommentElement(element, posted(7, true));
    const button = element.querySelector('.btn-update-on-host');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Updating…');

    // The update ended while this card was not attached to the document.
    PostedComment.setUpdateBusy(7, false);
    PostedComment.syncCommentElement(element, posted(7, true));
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.textContent).toBe('Update on GitHub');
  });

  it('does nothing without an element or a comment', () => {
    expect(() => PostedComment.syncCommentElement(null, pending())).not.toThrow();
    const element = card();
    expect(() => PostedComment.syncCommentElement(element, null)).not.toThrow();
    expect(element.dataset.commentStatus).toBeUndefined();
  });
});

describe('PostedComment.findRenderedComments', () => {
  it('includes the card the page holds for the comment even when it is not attached, once', () => {
    const inDocument = card(7);
    document.body.appendChild(inDocument);
    const detached = card(7);
    const zone = document.createElement('div');
    zone.innerHTML = '<div class="file-comment-card" data-comment-id="7"></div>';
    window.prManager = {
      findCommentCard: vi.fn(() => detached),
      forEachFileCommentsZone: (fn) => fn(zone),
    };

    const found = PostedComment.findRenderedComments(7);

    expect(window.prManager.findCommentCard).toHaveBeenCalledWith(7);
    expect(found).toHaveLength(3);
    expect(found).toEqual(expect.arrayContaining([inDocument, detached, zone.firstElementChild]));

    // The page's card is the one in the document: no duplicate.
    window.prManager.findCommentCard = () => inDocument;
    expect(PostedComment.findRenderedComments(7)).toHaveLength(2);
  });

  it('works without a page manager and for an id nothing was rendered for', () => {
    document.body.appendChild(card(7));
    expect(PostedComment.findRenderedComments(7)).toHaveLength(1);
    expect(PostedComment.findRenderedComments(8)).toEqual([]);
    window.prManager = { findCommentCard: () => null };
    expect(PostedComment.findRenderedComments(8)).toEqual([]);
  });

  it('setUpdateBusy reaches a card that is not attached through it', () => {
    const detached = card(7);
    PostedComment.syncCommentElement(detached, posted(7, true));
    window.prManager = { findCommentCard: () => detached };

    PostedComment.setUpdateBusy(7, true);
    expect(detached.querySelector('.btn-update-on-host').disabled).toBe(true);
    PostedComment.setUpdateBusy(7, false);
    expect(detached.querySelector('.btn-update-on-host').disabled).toBe(false);
  });
});
