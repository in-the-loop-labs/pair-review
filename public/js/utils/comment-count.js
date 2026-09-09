// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CommentCount - the single source of truth for "how many draft comments
 * does this review currently hold?".
 *
 * WHY THIS EXISTS
 * The count is read from the DOM (comments live in the diff surface, not in
 * a normalized client-side store) by four independent call sites that must
 * never disagree:
 *   - PRManager.updateCommentCount   -> toolbar "N comments" + Clear All enablement
 *   - PRManager.submitReview         -> "Request changes needs comments or a summary"
 *   - ReviewModal.updateCommentCount -> "N comments will be submitted"
 *   - ReviewModal.submitReview       -> the same validation, in the modal
 * They previously each summed `.user-comment-row` + `.file-comment-card.user-comment`
 * by hand.
 *
 * Since the Rendered Markdown view landed, ONE comment can have a card on
 * two surfaces at once: its Diff row (a legacy `<tr>` or the light-DOM
 * `.user-comment-row` PierreBridge slots into `@pierre/diffs`) and a
 * `.rendered-markdown-comment-card` in the rendered document. Both carry the
 * SAME `data-comment-id`. So the count must:
 *   1. include comments that only have a Rendered card — otherwise a
 *      comment whose Diff target could not be made renderable is silently
 *      missing from the toolbar, hides "N comments will be submitted",
 *      disables Clear All, and blocks Request-changes even though the
 *      comment is stored and WILL be submitted; and
 *   2. count each comment id exactly once — otherwise a comment visible on
 *      both surfaces is counted twice.
 * Hence: union of ids, not a sum of node counts.
 *
 * `.suggestion-edit-pending` rows are excluded exactly as before: they are
 * an in-progress edit form, not a saved comment.
 */

/* eslint-disable no-undef */
(function () {
  const LINE_ROW_SELECTOR = '.user-comment-row:not(.suggestion-edit-pending)';
  const RENDERED_CARD_SELECTOR = '.rendered-markdown-comment-card';
  const FILE_CARD_SELECTOR = '.file-comment-card.user-comment';

  /**
   * @param {Document|HTMLElement} [root] - defaults to `document`
   * @returns {{total:number, lineComments:number, fileComments:number}}
   *   `lineComments` is the de-duplicated union across surfaces.
   */
  function countDraftComments(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') {
      return { total: 0, lineComments: 0, fileComments: 0 };
    }

    const ids = new Set();
    // Nodes with no id at all can't be de-duplicated against anything, so
    // count them individually rather than dropping them (defensive: every
    // production renderer sets data-comment-id).
    let unidentified = 0;

    const collect = (selector) => {
      scope.querySelectorAll(selector).forEach((el) => {
        const id = el.dataset ? el.dataset.commentId : null;
        if (id) ids.add(String(id));
        else unidentified++;
      });
    };
    collect(LINE_ROW_SELECTOR);
    collect(RENDERED_CARD_SELECTOR);

    const lineComments = ids.size + unidentified;
    const fileComments = scope.querySelectorAll(FILE_CARD_SELECTOR).length;
    return { total: lineComments + fileComments, lineComments, fileComments };
  }

  const CommentCount = {
    countDraftComments,
    LINE_ROW_SELECTOR,
    RENDERED_CARD_SELECTOR,
    FILE_CARD_SELECTOR
  };

  if (typeof window !== 'undefined') {
    window.CommentCount = CommentCount;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CommentCount;
  }
})();
