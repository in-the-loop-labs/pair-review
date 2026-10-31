// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Shared rules for user comments that have already been posted to GitHub.
 *
 * Lifecycle (active/inactive) is independent of publication. A pending
 * comment is active with no publication; a posting derives draft/posted
 * from its GitHub review. Dismissing and restoring never erases history.
 * The reviewer may hide published comments ("Hide comments after posting").
 *
 * That setting is browser-wide. The comment panel's "Show posted" filter can
 * override it for one review (setShowPostedOverride); the override never
 * changes the browser-wide setting.
 */

const HIDE_POSTED_STORAGE_KEY = 'pair-review-hide-posted-comments';

const POSTED_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm11.28-2.28a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06l1.47 1.47 2.97-2.97a.75.75 0 0 1 1.06 0Z"/></svg>';

function publicationState(comment) {
  return comment?.publication?.state || 'none';
}

function isPendingComment(comment) {
  return comment?.status === 'active' && !comment.publication;
}

function commentStatus(comment) {
  return comment?.status || 'active';
}

/** True for a comment already attached to a GitHub review, even if dismissed. */
function isPostedComment(comment) {
  return publicationState(comment) !== 'none';
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

// The current review's "Show posted" override: true or false, or null to
// follow the browser-wide setting. Set by the comment panel.
let showPostedOverride = null;

/** @param {boolean|null} value - true/false for this review, null to follow the browser-wide setting */
function setShowPostedOverride(value) {
  showPostedOverride = typeof value === 'boolean' ? value : null;
}

function getShowPostedOverride() {
  return showPostedOverride;
}

/** Whether posted comments are hidden in this review: its override, else the browser-wide setting. */
function isHidePostedInEffect() {
  return showPostedOverride === null ? isHidePostedEnabled() : !showPostedOverride;
}

/**
 * True when the comment should be hidden as posted. Saved drafts stay visible:
 * they can still change before the pending review is submitted.
 * @param {Object} comment
 * @param {boolean} [hidePosted] - Whether posted comments are hidden
 *   (default: this review's setting, see isHidePostedInEffect)
 */
function shouldHidePostedComment(comment, hidePosted = isHidePostedInEffect()) {
  return hidePosted && publicationState(comment) === 'posted';
}

/**
 * How many of the comments are hidden as posted.
 * @param {Array<Object>} comments
 * @param {boolean} [hidePosted] - As for shouldHidePostedComment
 */
function countHiddenPostedComments(comments, hidePosted = isHidePostedInEffect()) {
  return (comments || []).filter(c => shouldHidePostedComment(c, hidePosted)).length;
}

function getPostedCommentIcon(comment, { link = false } = {}) {
  if (!isPostedComment(comment)) return '';
  const draft = publicationState(comment) === 'draft';
  const url = comment.publication.comment_url || comment.publication.review_url;
  const label = draft ? 'In pending draft review' :
    (link && !comment.publication.comment_url && url ? 'Posted review' : 'Posted comment');
  if (link && url && /^https?:\/\//i.test(url)) {
    const href = url.replace(/[&"<>']/g, ch => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[ch]));
    return `<a class="posted-comment-icon" href="${href}" target="_blank" rel="noopener" title="${label}" aria-label="${label}">${POSTED_ICON_SVG}</a>`;
  }
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
  element.dataset.commentPublication = publicationState(comment);
  element.classList.toggle('posted-comment-hidden', shouldHidePostedComment(comment));
}

const PostedComment = {
  HIDE_POSTED_STORAGE_KEY,
  publicationState,
  isPendingComment,
  isPostedComment,
  isHidePostedEnabled,
  setHidePostedEnabled,
  setShowPostedOverride,
  getShowPostedOverride,
  isHidePostedInEffect,
  shouldHidePostedComment,
  countHiddenPostedComments,
  getPostedCommentIcon,
  stampCommentStatus
};

if (typeof window !== 'undefined') {
  window.PostedComment = PostedComment;
  window.getPostedCommentIcon = getPostedCommentIcon;
  window.shouldHidePostedComment = shouldHidePostedComment;
}
if (typeof module !== 'undefined' && module.exports) module.exports = PostedComment;
