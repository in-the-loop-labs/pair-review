// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { GitHubReviewRepository, CommentPostingRepository, run } = require('../database');
const logger = require('../utils/logger');

/** Record the exact attached subset, inside the caller's short transaction. */
async function recordReviewSubmission(db, {
  reviewId, event, body, githubReview, existingDraft = null,
  sourceRows, sentComments, postedComments, postedAt = new Date().toISOString()
}) {
  const review = await new GitHubReviewRepository(db).upsertForSubmission(reviewId, {
    github_node_id: githubReview.id == null ? null : String(githubReview.id),
    github_review_id: githubReview.databaseId == null
      ? (existingDraft?.databaseId == null ? null : String(existingDraft.databaseId))
      : String(githubReview.databaseId),
    state: event === 'DRAFT' ? 'pending' : 'submitted',
    event: event === 'DRAFT' ? null : event,
    body: body || '', submitted_at: event === 'DRAFT' ? null : postedAt,
    github_url: githubReview.html_url || existingDraft?.url || null
  });
  // A successful submission with unknown per-comment accounting keeps the
  // historical all-sent contract, preventing silent reposts on the next submit.
  // Failure callers only invoke this helper with an explicit known subset.
  const posted = postedComments == null
    ? sentComments.map((_, index) => ({ index })) : postedComments;
  const postings = posted.map(p => {
    const sent = sentComments[p.index];
    const source = sourceRows[p.index];
    if (!sent || !source) throw new Error(`Invalid posted comment index: ${p.index}`);
    return {
      comment_id: source.id, github_review_row_id: review.id,
      comment_body: source.body, body: sent.body, file: sent.path,
      line_start: sent.start_line ?? sent.line, line_end: sent.line,
      side: sent.side, is_file_level: sent.isFileLevel,
      github_comment_id: p.github_comment_id,
      github_comment_node_id: p.github_comment_node_id,
      github_comment_url: p.github_comment_url, posted_at: postedAt
    };
  });
  await new CommentPostingRepository(db).insertMany(postings);
  // Headless suggestions have a terminal disposition, not user lifecycle.
  for (const p of postings) {
    await run(db, "UPDATE comments SET status = 'submitted', updated_at = ? WHERE id = ? AND source = 'ai'",
      [postedAt, p.comment_id]);
  }
  return review.id;
}

/** The API call has already failed; persist only its known, retained subset. */
async function recordRetainedSubmission(db, error, args, afterCommit = () => {}) {
  if (!error.reviewRetained) return;
  if (Array.isArray(error.postedComments) && error.postedComments.length) {
    let began = false;
    try {
      await run(db, 'BEGIN TRANSACTION');
      began = true;
      await recordReviewSubmission(db, {
        ...args, event: 'DRAFT', githubReview: error.pendingReview,
        postedComments: error.postedComments
      });
      await run(db, 'COMMIT');
      began = false;
    } catch (dbError) {
      if (began) {
        try { await run(db, 'ROLLBACK'); }
        catch (rollbackError) { logger.error('Failed to roll back retained-posting bookkeeping:', rollbackError); }
      }
      logger.error('Failed to record retained GitHub comment postings:', dbError);
      error.message += ' Recording the retained comments locally failed; check the pending review on GitHub before resubmitting.';
      throw error;
    }
    afterCommit();
    error.message += ` ${error.postedComments.length} of ${args.sentComments.length} comments were added to your pending review on GitHub and are marked as such.`;
  } else if (error.postedComments === null) {
    error.message += ' The added subset is unknown; check the pending review on GitHub before resubmitting.';
  }
}

module.exports = { recordReviewSubmission, recordRetainedSubmission };
