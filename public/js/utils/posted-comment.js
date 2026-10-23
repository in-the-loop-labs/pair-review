// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

function getPostedCommentIcon(comment) {
  if (comment.status !== 'submitted' && comment.status !== 'draft') return '';
  return '<span class="posted-comment-icon" title="Posted comment" role="img" aria-label="Posted comment"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm11.28-2.28a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06l1.47 1.47 2.97-2.97a.75.75 0 0 1 1.06 0Z"/></svg></span>';
}

function shouldHidePostedComment(comment) {
  return comment.status === 'submitted' && localStorage.getItem('pair-review-hide-posted-comments') === 'true';
}

if (typeof window !== 'undefined') {
  window.getPostedCommentIcon = getPostedCommentIcon;
  window.shouldHidePostedComment = shouldHidePostedComment;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { getPostedCommentIcon, shouldHidePostedComment };
