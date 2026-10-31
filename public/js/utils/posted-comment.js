// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Shared rules for user comments that have already been posted to GitHub.
 *
 * A user comment is pending ('active') until a review submit posts it. A
 * submitted review leaves it 'submitted'; Save as Draft leaves it 'draft',
 * held in the pending review on GitHub. Pending comments are what the next
 * submit sends; posted ones are history, and the reviewer can hide the
 * submitted ones ("Hide comments after posting").
 */

const HIDE_POSTED_STORAGE_KEY = 'pair-review-hide-posted-comments';

const POSTED_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm11.28-2.28a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06l1.47 1.47 2.97-2.97a.75.75 0 0 1 1.06 0Z"/></svg>';

function commentStatus(comment) {
  return comment?.status || 'active';
}

/** True for a comment the next review submit will post. */
function isPendingComment(comment) {
  return commentStatus(comment) === 'active';
}

/** True for a comment already sent to GitHub (submitted, or in the pending draft review). */
function isPostedComment(comment) {
  const status = commentStatus(comment);
  return status === 'submitted' || status === 'draft';
}

/** Posted comments are history: they can't be edited or dismissed locally. */
function canMutateComment(comment) {
  return !isPostedComment(comment);
}

function isHidePostedEnabled() {
  try {
    return localStorage.getItem(HIDE_POSTED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function setHidePostedEnabled(enabled) {
  localStorage.setItem(HIDE_POSTED_STORAGE_KEY, String(enabled));
}

/**
 * True when the comment should be hidden as posted. Saved drafts stay visible:
 * they can still change before the pending review is submitted.
 * @param {Object} comment
 * @param {boolean} [hidePosted] - The reviewer's setting (default: read it)
 */
function shouldHidePostedComment(comment, hidePosted = isHidePostedEnabled()) {
  return hidePosted && commentStatus(comment) === 'submitted';
}

function getPostedCommentIcon(comment) {
  if (!isPostedComment(comment)) return '';
  const label = 'Posted comment';
  return `<span class="posted-comment-icon" title="${label}" role="img" aria-label="${label}">${POSTED_ICON_SVG}</span>`;
}

/**
 * Stamp a rendered comment row or card with its status, and hide it if it is
 * a posted comment the reviewer chose to hide.
 * @param {HTMLElement} element
 * @param {Object} comment
 */
function stampCommentStatus(element, comment) {
  element.dataset.commentStatus = commentStatus(comment);
  element.classList.toggle('posted-comment-hidden', shouldHidePostedComment(comment));
}

const PostedComment = {
  HIDE_POSTED_STORAGE_KEY,
  isPendingComment,
  isPostedComment,
  canMutateComment,
  isHidePostedEnabled,
  setHidePostedEnabled,
  shouldHidePostedComment,
  getPostedCommentIcon,
  stampCommentStatus
};

if (typeof window !== 'undefined') {
  window.PostedComment = PostedComment;
  window.getPostedCommentIcon = getPostedCommentIcon;
  window.shouldHidePostedComment = shouldHidePostedComment;
}
if (typeof module !== 'undefined' && module.exports) module.exports = PostedComment;
