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
  return hidePosted && commentStatus(comment) !== 'inactive' && publicationState(comment) === 'posted';
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&"<>']/g, ch => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[ch]));
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function isLocalMode() {
  return typeof window !== 'undefined' && window.PAIR_REVIEW_LOCAL_MODE === true;
}

/** Display name of the code host ("GitHub" unless configured otherwise). */
function hostName() {
  try {
    const name = typeof window !== 'undefined' && window.RepoLinks?.hostName?.();
    if (name) return name;
  } catch { /* fall back */ }
  return 'GitHub';
}

/**
 * True when a posted comment's body changed after it was last sent to the
 * host (the server compares the latest posting's snapshot with the body).
 */
function isEditedSincePosted(comment) {
  return isPostedComment(comment) && comment.publication.changed === true;
}

/**
 * True when the reviewer can push the edit to the existing host comment:
 * PR mode, an active comment, edited since posted. Updating never creates a
 * second copy of the comment.
 */
function canUpdateOnHost(comment) {
  return !isLocalMode() && commentStatus(comment) === 'active' && isEditedSincePosted(comment);
}

/** Comments the submit dialog offers to update on the host. */
function getUpdatableComments(comments) {
  return (comments || []).filter(canUpdateOnHost);
}

// The last failed update per comment id, kept across re-renders until the
// comment is updated or edited again.
const updateErrors = new Map();

function getUpdateError(commentId) {
  return updateErrors.get(String(commentId)) || null;
}

function setUpdateError(commentId, error) {
  if (error) updateErrors.set(String(commentId), error);
  else updateErrors.delete(String(commentId));
}

function getUpdateErrorHtml(error) {
  if (!error) return '';
  const url = safeUrl(error.review_url);
  const link = url ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener">View review on ${escapeHtml(hostName())}</a>` : '';
  return `${escapeHtml(error.message || 'Update failed')}${link}`;
}

/**
 * The muted "Edited since posted" note with its "Update on GitHub" action,
 * rendered below the comment body. Empty unless canUpdateOnHost.
 * @param {Object} comment
 * @returns {string} HTML
 */
function getEditedSincePostedHtml(comment) {
  if (!canUpdateOnHost(comment)) return '';
  const id = escapeHtml(comment.id);
  const error = getUpdateError(comment.id);
  return `<div class="posted-comment-edited" data-edited-comment-id="${id}">
    <span class="posted-comment-edited-label">Edited since posted</span>
    <button type="button" class="btn-update-on-host" data-update-comment-id="${id}">Update on ${escapeHtml(hostName())}</button>
    <span class="posted-comment-update-error" role="alert"${error ? '' : ' hidden'}>${getUpdateErrorHtml(error)}</span>
  </div>`;
}

/**
 * Re-render the edited-since-posted note inside a rendered comment (row,
 * card or annotation) to match the comment, without re-rendering the diff.
 * @param {HTMLElement} element - Element carrying data-comment-id
 * @param {Object} comment
 */
function syncEditedSincePosted(element, comment) {
  if (!element) return;
  element.querySelectorAll('.posted-comment-edited').forEach(note => note.remove());
  const html = getEditedSincePostedHtml(comment);
  const body = element.querySelector('.user-comment-body');
  if (html && body) body.insertAdjacentHTML('afterend', html);
}

/** Every rendered element for a comment id, across the three diff renderers. */
function findRenderedComments(commentId) {
  if (typeof document === 'undefined') return [];
  const id = String(commentId).replace(/["\\]/g, '\\$&');
  return [...document.querySelectorAll(`.user-comment-row[data-comment-id="${id}"], .file-comment-card[data-comment-id="${id}"]`)];
}

/** Show or clear busy state on every "Update on GitHub" button for a comment. */
function setUpdateBusy(commentId, busy) {
  findRenderedComments(commentId).forEach(element => {
    element.querySelectorAll('.btn-update-on-host').forEach(button => {
      button.disabled = busy;
      button.setAttribute('aria-busy', String(busy));
      button.textContent = busy ? 'Updating…' : `Update on ${hostName()}`;
    });
  });
}

/**
 * Ask the server to update an already-posted comment on the host. Never
 * creates a comment: on failure the comment stays edited-since-posted.
 * @param {number|string} reviewId
 * @param {number|string} commentId
 * @param {Function} [fetchImpl]
 * @returns {Promise<{ok: true, comment: Object}|{ok: false, error: {message: string, code: string|null, review_url: string|null}}>}
 */
async function requestHostUpdate(reviewId, commentId, fetchImpl = (...args) => fetch(...args)) {
  try {
    const response = await fetchImpl(`/api/reviews/${reviewId}/comments/${commentId}/update-on-github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON error */ }
    if (response.ok && data?.comment) return { ok: true, comment: data.comment };
    return { ok: false, error: {
      message: data?.error || `Could not update the comment on ${hostName()}.`,
      code: data?.code || null,
      review_url: data?.review_url || null
    } };
  } catch (error) {
    return { ok: false, error: { message: `Could not reach pair-review: ${error.message}`, code: 'network', review_url: null } };
  }
}

/**
 * The chip for one submission in the review history: what the review did
 * on the host.
 * @param {Object} submission - A github_reviews row from /submissions
 * @returns {{label: string, tone: string}}
 */
function submissionEventChip(submission) {
  const state = submission?.state;
  if (state === 'pending') return { label: 'Pending draft', tone: 'draft' };
  if (state === 'dismissed') return { label: 'Dismissed', tone: 'dismissed' };
  if (state === 'local') return { label: 'Not submitted', tone: 'draft' };
  switch (submission?.event) {
    case 'APPROVE': return { label: 'Approved', tone: 'approve' };
    case 'REQUEST_CHANGES': return { label: 'Changes requested', tone: 'request-changes' };
    case 'COMMENT': return { label: 'Commented', tone: 'comment' };
    default: return { label: 'Submitted', tone: 'comment' };
  }
}

/** When a submission happened: its submit time, else when it was recorded. */
function submissionTimestamp(submission) {
  return submission?.submitted_at || submission?.created_at || null;
}

/** True for a posting that edited an existing host comment in place. */
function isEditPosting(posting) {
  return posting?.kind === 'update';
}

/** "Line 3", "Lines 3-5" or "File comment" for a posting. */
function postingLocation(posting) {
  if (!posting) return '';
  if (posting.is_file_level || posting.line_start == null) return 'File comment';
  const end = posting.line_end ?? posting.line_start;
  return end !== posting.line_start ? `Lines ${posting.line_start}-${end}` : `Line ${posting.line_start}`;
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
  stampCommentStatus,
  hostName,
  isEditedSincePosted,
  canUpdateOnHost,
  getUpdatableComments,
  getUpdateError,
  setUpdateError,
  getEditedSincePostedHtml,
  syncEditedSincePosted,
  findRenderedComments,
  setUpdateBusy,
  requestHostUpdate,
  escapeHtml,
  safeUrl,
  submissionEventChip,
  submissionTimestamp,
  isEditPosting,
  postingLocation
};

if (typeof window !== 'undefined') {
  window.PostedComment = PostedComment;
  window.getPostedCommentIcon = getPostedCommentIcon;
  window.shouldHidePostedComment = shouldHidePostedComment;
}
if (typeof module !== 'undefined' && module.exports) module.exports = PostedComment;
