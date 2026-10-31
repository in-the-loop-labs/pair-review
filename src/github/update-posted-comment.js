// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { query, queryOne, run, withTransaction, CommentRepository, CommentPostingRepository } = require('../database');
const { buildReviewComments } = require('../utils/diff-annotator');

/** Exact wire identity, never a fuzzy body/line search. Replies cannot match roots. */
function matchesPosting(candidate, posting, login) {
  if (!login || !candidate.user?.login || candidate.user.login.toLowerCase() !== login.toLowerCase() ||
      candidate.in_reply_to_id != null || candidate.path !== posting.file || candidate.body !== posting.body) return false;
  if (posting.is_file_level) return candidate.subject_type === 'file';
  if (candidate.subject_type === 'file') return false;
  const outdated = candidate.line == null;
  const line = outdated ? candidate.original_line : candidate.line;
  const start = outdated ? candidate.original_start_line : candidate.start_line;
  const expectedStart = posting.line_start === posting.line_end ? null : posting.line_start;
  return line === posting.line_end && (start ?? null) === (expectedStart ?? null) &&
    candidate.side === (posting.side || 'RIGHT') &&
    (candidate.start_side ?? null) === (expectedStart == null ? null : (posting.side || 'RIGHT'));
}

function identityError(posting) {
  return Object.assign(new Error("Couldn't find this comment on GitHub. Nothing was posted."), {
    status: 409, code: 'unresolved_identity', review_url: posting.review_url
  });
}

/** Network work precedes the short bookkeeping transaction; there is NO create fallback. */
async function updatePostedComment(db, { commentId, githubClient, owner, repo, pull_number, diffContent = '' }, afterCommit = () => {}) {
  const comments = new CommentRepository(db);
  const comment = await comments.getComment(commentId, 'user');
  if (!comment?.publication) throw Object.assign(new Error('Comment has not been posted'), { status: 400 });
  const posting = await queryOne(db, `SELECT p.*, gr.github_review_id, gr.github_node_id,
    gr.github_url AS review_url, gr.state AS review_state FROM comment_postings p
    LEFT JOIN github_reviews gr ON gr.id = p.github_review_row_id
    WHERE p.comment_id = ? ORDER BY p.id DESC LIMIT 1`, [commentId]);
  const ref = { owner, repo, pull_number, github_comment_id: posting.github_comment_id,
    github_comment_node_id: posting.github_comment_node_id, github_review_id: posting.github_review_id,
    github_node_id: posting.github_node_id };
  // Each adapter can resolve the other ID form through a read-only lookup.
  const hasUsableId = ref.github_comment_node_id || ref.github_comment_id;
  let recovered = null;
  if (!hasUsableId) {
    const user = await githubClient.getAuthenticatedUser();
    const trustedReview = !posting.backfilled && (ref.github_review_id || ref.github_node_id);
    // PR-wide lists omit unpublished comments. Never search them for a draft.
    if (!trustedReview && posting.review_state === 'pending') throw identityError(posting);
    const candidates = trustedReview
      ? await githubClient.listCommentsForReview(ref)
      : await githubClient.listReviewComments({ owner, repo, pull_number });
    const matches = candidates.filter(c => matchesPosting(c, posting, user.login));
    if (matches.length !== 1) throw identityError(posting);
    const match = matches[0];
    recovered = { id: match.id == null ? null : String(match.id), node: match.node_id || null,
      url: match.html_url || null };
    ref.github_comment_id = recovered.id;
    ref.github_comment_node_id = recovered.node;
    if (!recovered.node && !recovered.id) throw identityError(posting);
    // Repair survives even an update rejection, so the next attempt targets the same comment.
    await run(db, `UPDATE comment_postings SET github_comment_id = ?, github_comment_node_id = ?,
      github_comment_url = COALESCE(?, github_comment_url) WHERE comment_id = ?`,
    [recovered.id, recovered.node, recovered.url, commentId]);
  }
  const sent = buildReviewComments([comment], diffContent)[0];
  const result = await githubClient.updateReviewComment(ref, sent.body);
  const ids = { id: result?.github_comment_id || ref.github_comment_id,
    node: result?.github_comment_node_id || ref.github_comment_node_id,
    url: result?.github_comment_url || recovered?.url || posting.github_comment_url };
  await withTransaction(db, async () => {
    await run(db, `UPDATE comment_postings SET github_comment_id = ?, github_comment_node_id = ?,
      github_comment_url = COALESCE(?, github_comment_url) WHERE comment_id = ?`,
    [ids.id, ids.node, ids.url, commentId]);
    await new CommentPostingRepository(db).insertMany([{ ...posting, id: undefined,
      github_comment_id: ids.id, github_comment_node_id: ids.node,
      github_comment_url: ids.url,
      comment_body: comment.body, body: sent.body, kind: 'update',
      posted_at: new Date().toISOString() }]);
  });
  afterCommit(comment.review_id);
  return comments.getComment(commentId, 'user');
}

/** Group old duplicate review identities while retaining every posting and lifecycle. */
async function listSubmissions(db, reviewId) {
  const reviews = await query(db, 'SELECT * FROM github_reviews WHERE review_id = ? ORDER BY id DESC', [reviewId]);
  const postings = await query(db, `SELECT p.*, c.status, c.status AS comment_status FROM comment_postings p
    JOIN comments c ON c.id = p.comment_id WHERE c.review_id = ? ORDER BY p.id`, [reviewId]);
  const groups = [];
  for (const review of reviews) {
    let group = groups.find(g => (review.github_node_id && g.github_node_id === review.github_node_id) ||
      (review.github_review_id && g.github_review_id === review.github_review_id));
    if (!group) { group = { ...review, postings: [] }; groups.push(group); }
    group.postings.push(...postings.filter(p => p.github_review_row_id === review.id));
  }
  for (const group of groups) group.postings.sort((a, b) => a.id - b.id);
  const unknown = postings.filter(p => p.github_review_row_id == null);
  if (unknown.length) groups.push({ id: null, state: 'submitted', event: null, body: '', postings: unknown });
  return groups;
}

module.exports = { matchesPosting, updatePostedComment, listSubmissions };
